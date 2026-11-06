/**
 * Drive the Claude adapter through a turn that keeps its input open, against a
 * stand-in CLI that behaves like the real one on stdin.
 *
 * The stand-in replays a script of stdout lines, and — the part a plain replay
 * cannot do — reads what the adapter writes to its stdin: an echo line
 * (`isReplay`) is held back until the message it echoes has actually arrived,
 * exactly as the real CLI echoes a message only once it has read it. At the end
 * it waits for stdin to close, and it records where in the script that
 * happened, so a test can say "stdin was not closed before this line".
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { ClaudeAdapter } from '../../../src/providers/claude.js';
import type { AdapterStreamEvent, SpawnOptions } from '../../../src/providers/base.js';
import type { AiRequestMessage } from '../../../src/protocol/types.js';
import { TurnInputPort } from '../../../src/providers/turn-input.js';

export const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

/** One step of the stand-in's script. */
export type Step =
  | { line: string }
  | { waitInput: number }
  | { sleep: number }
  | { waitEof: true }
  /**
   * Stop here and exit with this code, as the real CLI does after an error
   * `result` (exit 1, checked on 2.1.283) — without waiting for stdin to close.
   */
  | { exit: number };

const STAND_IN = `
const fs = require('fs');
const [stepsPath, recordPath] = process.argv.slice(1);
const steps = JSON.parse(fs.readFileSync(stepsPath, 'utf8'));
let buf = '';
const frames = [];
let eof = false;
let written = 0;
let eofAt = null;
const waiters = [];
const poke = () => { for (const w of waiters.splice(0)) w(); };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) { frames.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
  poke();
});
process.stdin.on('end', () => { eof = true; if (eofAt === null) eofAt = written; poke(); });
const until = (cond, ms) => new Promise((r) => {
  const t = setTimeout(r, ms);
  const check = () => (cond() ? (clearTimeout(t), r()) : waiters.push(check));
  check();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const save = () => fs.writeFileSync(recordPath, JSON.stringify({ frames, eofAt, written }));
process.on('SIGINT', () => { save(); process.exit(130); });
(async () => {
  for (const s of steps) {
    if (s.line !== undefined) {
      await new Promise((r) => process.stdout.write(s.line + '\\n', r));
      written++;
    } else if (s.waitInput !== undefined) {
      await until(() => frames.length >= s.waitInput || eof, 8000);
    } else if (s.sleep !== undefined) {
      await sleep(s.sleep);
    } else if (s.waitEof) {
      await until(() => eof, 8000);
    } else if (s.exit !== undefined) {
      save();
      process.exit(s.exit);
    }
  }
  save();
  process.exit(0);
})();
`;

/** What the stand-in saw. */
export interface StandInRecord {
  /** Every line the adapter wrote to stdin. */
  frames: string[];
  /** How many script lines had been written when stdin closed; null if it never did. */
  eofAt: number | null;
  written: number;
}

/**
 * Turn a captured fixture into a script: every line verbatim, each echo held
 * until its message has been written, a pause after every frame at which a
 * wrong close decision could be taken (so a premature close shows up as an
 * early `eofAt`), and a wait for stdin to close at the end.
 */
export function stepsFromFixture(name: string): { steps: Step[]; lines: string[]; opening: string; injected: string[] } {
  const lines = readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter((l) => l.trim() !== '');
  const steps: Step[] = [];
  let echoes = 0;
  let opening = '';
  const injected: string[] = [];
  for (const line of lines) {
    const frame = JSON.parse(line) as Record<string, unknown>;
    const isEcho = frame['type'] === 'user' && frame['isReplay'] === true;
    if (isEcho) {
      echoes++;
      const content = (frame['message'] as { content: string }).content;
      if (echoes === 1) opening = content;
      else injected.push(content);
      steps.push({ waitInput: echoes });
    }
    steps.push({ line });
    const subtype = frame['subtype'];
    if (frame['type'] === 'result'
      || (frame['type'] === 'system' && (subtype === 'task_notification' || subtype === 'task_updated'))
      || (frame['type'] === 'stream_event'
        && (frame['event'] as Record<string, unknown>)['type'] === 'message_delta')) {
      steps.push({ sleep: 40 });
    }
  }
  steps.push({ waitEof: true });

  return { steps, lines, opening, injected };
}

export interface InputTurn {
  events: AdapterStreamEvent[];
  record: StandInRecord;
  args: string[];
  spawnOptions: SpawnOptions | undefined;
  stdinInput: string | undefined;
  port: TurnInputPort;
}

/**
 * Run one input-open turn against a script.
 *
 * @param onEvent called for every event the adapter emits, with the port, so a
 *                test can offer messages at a moment of its choosing
 */
export async function runInputTurn(opts: {
  steps: Step[];
  message: string;
  onEvent?: (event: AdapterStreamEvent, port: TurnInputPort) => void;
  signal?: AbortSignal;
  withPort?: boolean;
  /** The session the turn resumes; null (the default) for a fresh one. */
  cliSessionId?: string | null;
  /** The silence bound; 0 (the default) for none. */
  silenceTimeoutSeconds?: number;
  /** The wall-clock bound; 60 (the default). */
  requestTimeoutSeconds?: number;
  /** How long a waiting helper may take to be resumed; the adapter's own (30 s) by default. */
  helperResumeWindowMs?: number;
}): Promise<InputTurn> {
  const scratch = mkdtempSync(join(tmpdir(), 'input-turn-'));
  const stepsPath = join(scratch, 'steps.json');
  const recordPath = join(scratch, 'record.json');
  writeFileSync(stepsPath, JSON.stringify(opts.steps));

  const seen: { args: string[]; options?: SpawnOptions; stdinInput?: string } = { args: [] };

  class StandIn extends ClaudeAdapter {
    protected override helperResumeWindowMs(): number {
      return opts.helperResumeWindowMs ?? super.helperResumeWindowMs();
    }

    protected override spawnCli(
      _command: string,
      args: string[],
      _env: NodeJS.ProcessEnv,
      stdinInput?: string,
      _cwd?: string,
      options?: SpawnOptions,
    ): ChildProcessByStdio<Writable | null, Readable, Readable> {
      seen.args = args;
      seen.options = options;
      seen.stdinInput = stdinInput;
      const child = spawn(process.execPath, ['-e', STAND_IN, stepsPath, recordPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
      child.stdin?.on('error', () => {});
      if (stdinInput !== undefined) {
        if (options?.keepStdinOpen === true) child.stdin?.write(stdinInput);
        else child.stdin?.end(stdinInput);
      } else {
        child.stdin?.end();
      }

      return child;
    }
  }

  const port = new TurnInputPort();
  const request: AiRequestMessage = {
    type: 'ai_request',
    request_id: 'req_input',
    conversation_id: 'c',
    provider: 'claude',
    message: opts.message,
    system_prompt: null,
    options: { accepts_input: opts.withPort !== false },
    cli_session_id: opts.cliSessionId ?? null,
  };

  const events: AdapterStreamEvent[] = [];
  try {
    await new StandIn().execute({
      request,
      requestId: request.request_id,
      tools: [],
      mcp: null,
      cliIsolation: 'native',
      workingDir: process.cwd(),
      signal: opts.signal ?? new AbortController().signal,
      requestTimeoutSeconds: opts.requestTimeoutSeconds ?? 60,
      silenceTimeoutSeconds: opts.silenceTimeoutSeconds ?? 0,
      cliSessionId: opts.cliSessionId ?? null,
      attachmentDir: null,
      bridgeEnv: {},
      bridgeAddendum: null,
      turnInput: opts.withPort === false ? null : port,
    }, (e) => {
      events.push(e);
      opts.onEvent?.(e, port);
    });

    let record: StandInRecord = { frames: [], eofAt: null, written: 0 };
    try {
      record = JSON.parse(readFileSync(recordPath, 'utf8')) as StandInRecord;
    } catch {
      // The stand-in was killed before it could write one.
    }

    return { events, record, args: seen.args, spawnOptions: seen.options, stdinInput: seen.stdinInput, port };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export const of = (events: AdapterStreamEvent[], name: string): AdapterStreamEvent[] =>
  events.filter((e) => e.event === name);

export const mainStates = (events: AdapterStreamEvent[]): string[] =>
  of(events, 'main_state').map((e) => (e.data as { state: string }).state);

/** Index (0-based) of the first fixture line matching, for comparing with `eofAt`. */
export function lineIndex(lines: string[], match: (frame: Record<string, unknown>) => boolean, last = false): number {
  const indices = lines
    .map((l, i) => (match(JSON.parse(l) as Record<string, unknown>) ? i : -1))
    .filter((i) => i >= 0);

  return last ? indices[indices.length - 1] : indices[0];
}
