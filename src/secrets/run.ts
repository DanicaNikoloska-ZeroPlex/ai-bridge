/**
 * `aib secret run`: start a command with one secret handed to it, and keep the
 * secret's values out of what the command prints (decision 0020).
 *
 * The command gets SECRET_FILE (the secret's path) and SECRET_NAME; with
 * `--env VAR` the content (trimmed) in VAR; with `--dotenv` every KEY=VALUE
 * line of the secret as a variable. "{SECRET_FILE}" in any argument becomes
 * the path. Unless `--no-mask`, its stdout and stderr pass through a filter
 * that prints ***SECRET*** for every value it knows: the whole secret and the
 * values under secret-looking keys from 4 characters, anything else in it from
 * 8 (see maskPlan()).
 */

import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import type { Readable } from 'node:stream';
import { stripCredentials } from '../providers/env.js';

export const MASK = '***SECRET***';
/**
 * A part of a secret that is not known to be secret (a line of a multi-line
 * secret, the value of `REGION=`) is masked only from this length: shorter
 * ones are ordinary words and numbers.
 */
export const MIN_MASK_LENGTH = 8;
/**
 * The whole secret, and a value under a secret-looking key (`DB_PASSWORD=`,
 * `"token":`), is masked from this length: a 4-digit PIN or a 6-character
 * password is still one. Shorter ones are not (masking every "ab" would wreck
 * the output and hide nothing worth hiding); `run` says on stderr how many
 * values that left unmasked. The price is false positives: a password "true"
 * masks every "true" the command prints.
 */
export const MIN_SECRET_MASK_LENGTH = 4;
/** Keys (in a JSON secret, or a KEY=VALUE line) whose values are known to be secret. */
const JSON_SECRET_KEY = /key|secret|token|pass|pwd|credential|auth/i;
/** An environment variable's name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Variables `--dotenv` never sets: each makes a program load or run code of
 * the secret's choosing (or points it at other files, as SECRET_FILE would),
 * and a server with --machine-secrets may write a secret. A secret that sets
 * one is refused, never silently thinned out. A list, so not complete: a
 * program may have variables of its own that load code.
 */
const LOADER_VARIABLE = new RegExp('^(' + [
  'LD_\\w*', 'DYLD_\\w*', 'GCONV_PATH', 'PATH', 'HOME', 'SHELL', 'ZDOTDIR', 'XDG_\\w*', 'TMPDIR', 'IFS',
  'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'PS4', 'PROMPT_COMMAND',
  'NODE_OPTIONS', 'NODE_PATH', 'NPM_CONFIG_\\w*', 'PYTHON\\w*', 'PERL5\\w*', 'PERLLIB', 'RUBYOPT', 'RUBYLIB', 'GEM_\\w*', 'BUNDLE_\\w*',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH', 'PHPRC', 'PHP_INI_SCAN_DIR', 'LUA_\\w*', 'TCLLIBPATH', 'R_PROFILE\\w*', 'R_ENVIRON\\w*',
  'GIT_\\w*', 'SSH_\\w*', 'PAGER', 'MANPAGER', 'GIT_PAGER', 'LESSOPEN', 'LESSCLOSE', 'EDITOR', 'VISUAL', 'BROWSER',
  'SECRET_FILE', 'SECRET_NAME',
].join('|') + ')$', 'i');

/** The KEY=VALUE pairs `--dotenv` sets, or why it refuses the secret. */
export function dotenvVariables(text: string): Array<[string, string]> {
  const pairs = parseDotenv(text);
  const refused = pairs.map(([key]) => key).filter((key) => LOADER_VARIABLE.test(key));
  if (refused.length) {
    throw new Error(`--dotenv will not set ${[...new Set(refused)].join(', ')}: these make a program load code. Remove them from the secret, or use SECRET_FILE.`);
  }
  return pairs;
}

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

export interface MaskPlan {
  /** What the filter replaces, longest first. */
  values: string[];
  /** How many known-secret values were too short to mask (under MIN_SECRET_MASK_LENGTH). */
  unmasked: number;
}

/**
 * Every value the output filter hides for this secret, longest first so a
 * longer value is masked whole before a part of it; each also in its
 * JSON-escaped form (what `jq -c` prints).
 * - Known to be secret, masked from MIN_SECRET_MASK_LENGTH: the whole content
 *   (and its trimmed form), each KEY=VALUE value whose key looks secret, and
 *   in JSON the string values under secret-looking keys.
 * - Anything else, masked from MIN_MASK_LENGTH: each line of a multi-line
 *   secret, each other KEY=VALUE value.
 * Only these literal forms are matched: an encoded value (base64, URL
 * encoding) gets through.
 */
export function maskPlan(content: string): MaskPlan {
  const trimmed = content.trim();
  // The content as it is and trimmed, both judged by the trimmed length.
  const whole = trimmed.length >= MIN_SECRET_MASK_LENGTH ? [content, trimmed] : [];
  const secret: string[] = [];
  const other: string[] = [];
  if (trimmed.includes('\n')) for (const line of trimmed.split(/\r?\n/)) other.push(line.trim());
  for (const [key, value] of parseDotenv(content)) (JSON_SECRET_KEY.test(key) ? secret : other).push(value);
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      jsonSecretValues(JSON.parse(trimmed), false, secret);
    } catch { /* not JSON */ }
  }
  // Each judged by its own length, before its JSON-escaped form is added.
  const withEscaped = (list: string[]): string[] => [...list, ...list.map((v) => JSON.stringify(v).slice(1, -1))];
  const values = new Set([
    ...withEscaped(whole),
    ...withEscaped(secret.filter((v) => v.length >= MIN_SECRET_MASK_LENGTH)),
    ...withEscaped(other.filter((v) => v.length >= MIN_MASK_LENGTH)),
  ]);
  // Counted once per distinct value; an empty value is no secret.
  const unmasked = new Set([trimmed, ...secret].filter((v) => v.length > 0 && v.length < MIN_SECRET_MASK_LENGTH)).size;
  return { values: [...values].filter((v) => v.length > 0).sort((a, b) => b.length - a.length), unmasked };
}

/** maskPlan()'s values. */
export function maskValues(content: string): string[] {
  return maskPlan(content).values;
}

/**
 * Stands in for a replaced value while the others are matched: above latin1,
 * so no value (latin1 text, one character per byte) can match across it or
 * inside it, and a value that is part of MASK is never matched in a mask.
 */
const PLACEHOLDER = '\u0100';

/**
 * A streaming filter that replaces each value with MASK, longest first, with
 * the same result however the output is split into chunks: the end of what it
 * has seen is held back while it could still be the start of a value, and
 * further back to the start of any value that crosses that point. Works on
 * bytes (as latin1 text, one character per byte), so a multi-byte character
 * split across chunks is never mangled.
 */
export class MaskingFilter {
  private readonly needles: string[];
  /** Per needle, the KMP failure function, for the hold-back in linear time. */
  private readonly failures: Int32Array[];
  private held = '';

  constructor(values: string[]) {
    this.needles = values.map((v) => Buffer.from(v, 'utf8').toString('latin1')).filter((v) => v.length > 0);
    this.failures = this.needles.map(failureFunction);
  }

  push(chunk: Buffer): Buffer {
    const text = this.held + chunk.toString('latin1');
    const cut = this.safeCut(text, text.length - this.heldBackLength(text));
    this.held = text.slice(cut);
    return Buffer.from(this.mask(text.slice(0, cut)), 'latin1');
  }

  end(): Buffer {
    const rest = this.held;
    this.held = '';
    return Buffer.from(this.mask(rest), 'latin1');
  }

  /** Longest first, each replaced value out of reach of the others. */
  private mask(text: string): string {
    let out = text;
    for (const needle of this.needles) out = out.split(needle).join(PLACEHOLDER);
    return out.split(PLACEHOLDER).join(MASK);
  }

  /**
   * `cut` moved back to the start of any value that crosses it, until none
   * does: then what comes before it masks the same alone as with what
   * follows. A value that could still be completed starts at or after the
   * first cut (heldBackLength()), so only complete ones are looked for.
   */
  private safeCut(text: string, cut: number): number {
    for (let moved = true; moved && cut > 0;) {
      moved = false;
      for (const needle of this.needles) {
        let at = text.indexOf(needle, Math.max(0, cut - needle.length + 1));
        while (at !== -1 && at < cut) {
          if (at + needle.length > cut) {
            cut = at;
            moved = true;
            break;
          }
          at = text.indexOf(needle, at + 1);
        }
      }
    }
    return cut;
  }

  /**
   * The longest end of `text` that is a proper start of some value: the KMP
   * automaton run over the last needle.length - 1 characters, O(length) per
   * needle. A program that stops printing in the middle of such a start (a
   * prompt ending in a value's first letter) shows it with its next output.
   */
  private heldBackLength(text: string): number {
    let best = 0;
    this.needles.forEach((needle, i) => {
      const fail = this.failures[i]!;
      const from = Math.max(0, text.length - (needle.length - 1));
      let k = 0;
      for (let j = from; j < text.length; j++) {
        while (k > 0 && (k === needle.length || text[j] !== needle[k])) k = fail[k - 1]!;
        if (text[j] === needle[k]) k++;
      }
      if (k === needle.length) k = fail[k - 1]!;
      if (k > best) best = k;
    });
    return best;
  }
}

/** fail[i]: the length of the longest proper prefix of needle[0..i] that is also its suffix. */
function failureFunction(needle: string): Int32Array {
  const fail = new Int32Array(needle.length);
  let k = 0;
  for (let i = 1; i < needle.length; i++) {
    while (k > 0 && needle[i] !== needle[k]) k = fail[k - 1]!;
    if (needle[i] === needle[k]) k++;
    fail[i] = k;
  }
  return fail;
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
  if (options.dotenv) {
    try {
      for (const [key, value] of dotenvVariables(text)) env[key] = value;
    } catch (err) {
      return Promise.reject(err);
    }
  }
  if (options.envVar) env[checkEnvName(options.envVar)] = text.trim();
  const [file, ...rest] = options.command.map((arg) => arg.split('{SECRET_FILE}').join(options.path));
  if (!file) return Promise.reject(new Error('Name the command to run after --'));
  const mask = options.mask !== false;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  return new Promise<number>((resolve) => {
    const child = spawn(file, rest, { env, stdio: mask ? ['inherit', 'pipe', 'pipe'] : 'inherit' });
    // On a terminal, Ctrl-C and a hangup already reach the whole process
    // group, the command included: sending them again could read as "force
    // quit". The listener still keeps this process alive to pass the exit
    // code on. SIGTERM, sent to this process alone, is passed on.
    const terminal = !!(process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY);
    const forward = (signal: NodeJS.Signals): void => {
      if (terminal && signal !== 'SIGTERM') return;
      child.kill(signal);
    };
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
      const { values, unmasked } = maskPlan(text);
      if (unmasked > 0) {
        stderr.write(`aib secret run: ${unmasked} value${unmasked === 1 ? '' : 's'} of ${options.name} ${unmasked === 1 ? 'is' : 'are'} under ${MIN_SECRET_MASK_LENGTH} characters and ${unmasked === 1 ? 'is' : 'are'} not masked\n`);
      }
      for (const [from, to] of [[child.stdout!, stdout], [child.stderr!, stderr]] as Array<[Readable, NodeJS.WritableStream]>) {
        const filter = new MaskingFilter(values);
        pending++;
        // A reader that went away (`| head`) ends the command as a closed
        // pipe would: SIGPIPE, exit 141. Never an unhandled error.
        to.on('error', () => {
          if (exitCode === null) child.kill('SIGPIPE');
          from.destroy();
        });
        from.on('data', (chunk: Buffer) => {
          if (!to.write(filter.push(chunk))) {
            from.pause();
            to.once('drain', () => from.resume());
          }
        });
        from.on('close', () => {
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
  return osConstants.signals[signal] ?? 0;
}
