/**
 * `aib secret run`: start a command with one secret handed to it, and keep the
 * secret's values out of what the command prints (decision 0020).
 *
 * The command gets SECRET_FILE (the secret's path) and SECRET_NAME; with
 * `--env VAR` the content (trimmed) in VAR; with `--dotenv` every KEY=VALUE
 * line of the secret as a variable. "{SECRET_FILE}" in any argument becomes
 * the path. Unless `--no-mask`, its stdout and stderr pass through a filter
 * that prints ***SECRET*** for every value of 8 characters or more.
 */

import { spawn } from 'node:child_process';
import { stripCredentials } from '../providers/env.js';

export const MASK = '***SECRET***';
/** Shorter values are not masked: they would mask ordinary words. */
export const MIN_MASK_LENGTH = 8;
/** Keys in a JSON secret whose string values are masked. */
const JSON_SECRET_KEY = /key|secret|token|pass|pwd|credential|auth/i;
/** An environment variable's name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * KEY=VALUE lines: `export ` stripped, matching quotes around the value
 * stripped, blank lines and `#` comments skipped. Lines without `=` or with an
 * unusable key are skipped.
 */
export function parseDotenv(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trimStart();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!ENV_NAME.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1);
    }
    out.push([key, value]);
  }
  return out;
}

/** String values in a JSON document under keys that name a secret, at any depth. */
function jsonSecretValues(node: unknown, underSecretKey: boolean, out: string[]): void {
  if (typeof node === 'string') {
    if (underSecretKey) out.push(node);
  } else if (Array.isArray(node)) {
    for (const item of node) jsonSecretValues(item, underSecretKey, out);
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) jsonSecretValues(value, underSecretKey || JSON_SECRET_KEY.test(key), out);
  }
}

/**
 * Every value the output filter hides for this secret: the whole content and
 * its trimmed form, each dotenv value, and, for a JSON object, the string
 * values under secret-looking keys. Only those of MIN_MASK_LENGTH or more,
 * longest first so a longer value is masked whole before a part of it.
 */
export function maskValues(content: string, options: { dotenv?: boolean } = {}): string[] {
  const values = [content, content.trim()];
  if (options.dotenv) for (const [, value] of parseDotenv(content)) values.push(value);
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      jsonSecretValues(JSON.parse(trimmed), false, values);
    } catch { /* not JSON */ }
  }
  return [...new Set(values.filter((v) => v.length >= MIN_MASK_LENGTH))].sort((a, b) => b.length - a.length);
}

/**
 * A streaming filter that replaces each value with MASK, also when a value is
 * split across chunks: the end of what it has seen is held back only while it
 * could still be the start of a value. Works on bytes (as latin1 text, one
 * character per byte), so a multi-byte character split across chunks is
 * never mangled.
 */
export class MaskingFilter {
  private readonly needles: string[];
  private held = '';

  constructor(values: string[]) {
    this.needles = values.map((v) => Buffer.from(v, 'utf8').toString('latin1')).filter((v) => v.length > 0);
  }

  push(chunk: Buffer): Buffer {
    const text = this.held + chunk.toString('latin1');
    const masked = this.mask(text);
    const keep = this.heldBackLength(masked);
    this.held = masked.slice(masked.length - keep);
    return Buffer.from(masked.slice(0, masked.length - keep), 'latin1');
  }

  end(): Buffer {
    const rest = this.held;
    this.held = '';
    return Buffer.from(rest, 'latin1');
  }

  private mask(text: string): string {
    let out = text;
    for (const needle of this.needles) out = out.split(needle).join(MASK);
    return out;
  }

  /** The longest end of `text` that is a proper start of some value. */
  private heldBackLength(text: string): number {
    let best = 0;
    for (const needle of this.needles) {
      const max = Math.min(needle.length - 1, text.length);
      for (let n = max; n > best; n--) {
        if (text.endsWith(needle.slice(0, n))) { best = n; break; }
      }
    }
    return best;
  }
}

export interface RunOptions {
  name: string;
  path: string;
  /** The secret's content; read only when something needs it. */
  content: Buffer;
  envVar?: string | undefined;
  dotenv?: boolean;
  mask?: boolean;
  command: string[];
  /** The environment to start from; default process.env. */
  env?: NodeJS.ProcessEnv;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/** Check `--env VAR` before anything runs. */
export function checkEnvName(name: string): string {
  if (!ENV_NAME.test(name)) throw new Error(`--env needs a variable name (letters, digits, _), not "${name}"`);
  return name;
}

/**
 * Run the command; resolves with the exit code to pass on: the command's own,
 * 128 + signal number when it was killed, 127 when it was not found, 126 when
 * it could not be run.
 */
export function runWithSecret(options: RunOptions): Promise<number> {
  const text = options.content.toString('utf8');
  const env: NodeJS.ProcessEnv = stripCredentials({ ...(options.env ?? process.env) });
  env['SECRET_FILE'] = options.path;
  env['SECRET_NAME'] = options.name;
  if (options.dotenv) for (const [key, value] of parseDotenv(text)) env[key] = value;
  if (options.envVar) env[checkEnvName(options.envVar)] = text.trim();
  const [file, ...rest] = options.command.map((arg) => arg.split('{SECRET_FILE}').join(options.path));
  if (!file) return Promise.reject(new Error('Name the command to run after --'));
  const mask = options.mask !== false;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  return new Promise<number>((resolve) => {
    const child = spawn(file, rest, { env, stdio: mask ? ['inherit', 'pipe', 'pipe'] : 'inherit' });
    const forward = (signal: NodeJS.Signals): void => { child.kill(signal); };
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const s of signals) process.on(s, forward);
    const done = (code: number): void => {
      for (const s of signals) process.off(s, forward);
      resolve(code);
    };

    let pending = 0;
    let exitCode: number | null = null;
    const maybeDone = (): void => { if (pending === 0 && exitCode !== null) done(exitCode); };
    if (mask) {
      const values = maskValues(text, { dotenv: !!options.dotenv });
      for (const [from, to] of [[child.stdout!, stdout], [child.stderr!, stderr]] as const) {
        const filter = new MaskingFilter(values);
        pending++;
        from.on('data', (chunk: Buffer) => { to.write(filter.push(chunk)); });
        from.on('end', () => {
          const rest = filter.end();
          if (rest.length) to.write(rest);
          pending--;
          maybeDone();
        });
      }
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      for (const s of signals) process.off(s, forward);
      if (err.code === 'ENOENT') {
        stderr.write(`aib secret run: ${file}: command not found\n`);
        resolve(127);
      } else {
        stderr.write(`aib secret run: ${file}: cannot run it (${err.code ?? 'error'})\n`);
        resolve(126);
      }
    });
    child.on('exit', (code, signal) => {
      exitCode = code ?? (signal ? 128 + signalNumber(signal) : 1);
      maybeDone();
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  const table: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGPIPE: 13 };
  return table[signal] ?? 0;
}
