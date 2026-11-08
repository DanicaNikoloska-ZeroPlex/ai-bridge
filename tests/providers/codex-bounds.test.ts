/**
 * Codex ships a tool call's arguments either pre-stringified or as an object.
 *
 * The bound used to sit inside that ternary, on the object branch only — so the
 * pre-stringified branch, which the adapter's own comment says Codex sometimes
 * takes, went out unbounded and survived two review rounds. An oversized frame
 * is not dropped by the server; it is answered with a CLOSE_TOO_BIG that tears
 * the connection down, taking every in-flight request with it.
 */

import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { CodexAdapter } from '../../src/providers/codex.js';
import type { AdapterStreamEvent } from '../../src/providers/base.js';

const SERVER_FRAME_CAP = 1024 * 1024;

/** Replay codex NDJSON through the real adapter. */
async function replay(
  lines: unknown[],
  opts: {
    silenceSeconds?: number; holdOpenMs?: number; dripMs?: number;
    /** What the CLI writes on its way out, once it is asked to stop. */
    lateLines?: unknown[];
  } = {},
): Promise<AdapterStreamEvent[]> {
  const dir = mkdtempSync(join(tmpdir(), 'codex-'));
  const path = join(dir, 'stream.ndjson');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const latePath = join(dir, 'late.ndjson');
  writeFileSync(latePath, (opts.lateLines ?? []).map((l) => JSON.stringify(l)).join('\n') + '\n');

  class Replay extends CodexAdapter {
    protected override spawnCli(): ChildProcessByStdio<Writable | null, Readable, Readable> {
      return spawn(
        process.execPath,
        ['-e', 'const fs = require("fs");'
          + 'const lines = fs.readFileSync(process.argv[1], "utf8").split("\\n").filter(Boolean);'
          + 'const hold = Number(process.argv[2] || 0), drip = Number(process.argv[3] || 0);'
          // SIGINT is how the bridge asks a CLI to stop, and a CLI asked to
          // stop often writes one last frame before it goes. That frame is the
          // whole point of these tests, so the fake has to produce it.
          + 'const late = fs.readFileSync(process.argv[4], "utf8").trim();'
          + 'process.on("SIGINT", () => { if (late) process.stdout.write(late + "\\n");'
          + '  setTimeout(() => process.exit(130), 50); });'
          + 'let i = 0; const tick = () => {'
          + '  if (i < lines.length) { process.stdout.write(lines[i++] + "\\n"); if (drip > 0) setTimeout(tick, drip); else tick(); }'
          + '  else if (hold > 0) setTimeout(() => {}, hold);'
          + '}; tick();', path, String(opts.holdOpenMs ?? 0), String(opts.dripMs ?? 0), latePath],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      ) as ChildProcessByStdio<Writable | null, Readable, Readable>;
    }
  }

  const events: AdapterStreamEvent[] = [];
  try {
    await new Replay().execute({
      request: {
        type: 'ai_request', request_id: 'req_codex', conversation_id: 'c', provider: 'codex',
        message: 'go', system_prompt: null, options: {}, cli_session_id: null,
      },
      requestId: 'req_codex',
      tools: [],
      mcp: null,
      cliIsolation: 'native',
      workingDir: process.cwd(),
      signal: new AbortController().signal,
      requestTimeoutSeconds: 30,
      silenceTimeoutSeconds: opts.silenceSeconds ?? 0,
      cliSessionId: null,
      attachmentDir: null,
      bridgeEnv: {},
      bridgeAddendum: null,
    }, (e) => events.push(e));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  return events;
}

/** What the whole stream frame costs once encoded, as bridge.ts sends it. */
function frameBytes(event: AdapterStreamEvent): number {
  return Buffer.byteLength(JSON.stringify({
    type: 'stream', request_id: 'req_codex', event: event.event, data: event.data,
  }), 'utf8');
}

const toolCall = (args: unknown) => ({
  type: 'item.completed',
  item: {
    id: 'mcp_1', type: 'mcp_tool_call', server: 'bridge', tool: 'write_file',
    arguments: args, result: 'ok', status: 'completed',
  },
});

describe('codex tool call arguments', () => {
  it('bounds pre-stringified arguments at the ARGUMENT ceiling', async () => {
    // 64KB in raw bytes, the number the consumer measures — not the 256KB
    // result ceiling. The sibling path was fixed for exactly this; this one
    // was missed.
    const events = await replay([
      { type: 'thread.started', thread_id: 't1' },
      toolCall(JSON.stringify({ file_path: '/tmp/a', content: 'x'.repeat(150_000) })),
      { type: 'turn.completed', usage: {} },
    ]);

    const delta = events.find((e) => e.event === 'block_delta');
    const content = (delta!.data as { content: string }).content;
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(65536);
  });

  it('scrubs a lone surrogate escape out of pre-stringified arguments', async () => {
    // One makes the consumer's json_decode reject the WHOLE object, losing
    // every argument including the one that says what the call did.
    const events = await replay([
      { type: 'thread.started', thread_id: 't1' },
      toolCall('{"a":"\ud83d","path":"/etc/x"}'),
      { type: 'turn.completed', usage: {} },
    ]);

    const content = (events.find((e) => e.event === 'block_delta')!.data as { content: string }).content;
    expect(content).not.toContain('\ud83d');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('scrubs a lone surrogate written as an ESCAPE, not just as a character', async () => {
    // The test above passes a raw lone surrogate, which `replaceLoneSurrogates`
    // handles at the character level. Pre-stringified arguments carry the OTHER
    // shape — the six literal characters \ud83d inside already-encoded JSON —
    // which only `replaceLoneSurrogateEscapes` sees. Without a case for it the
    // suite was green on half the function.
    const events = await replay([
      { type: 'thread.started', thread_id: 't1' },
      toolCall('{"a":"\\ud83d","path":"/etc/x"}'),
      { type: 'turn.completed', usage: {} },
    ]);

    const content = (events.find((e) => e.event === 'block_delta')!.data as { content: string }).content;

    expect(content).not.toContain('\\ud83d');
    expect(() => JSON.parse(content)).not.toThrow();
    // The sibling argument survives: a scrub that took the object with it would
    // pass both assertions above by emitting nothing at all.
    expect(JSON.parse(content)['path']).toBe('/etc/x');
  });

  it('leaves an ESCAPED BACKSLASH followed by a surrogate escape alone', async () => {
    // `\\ud83d` is a literal backslash then the text ud83d — not an escape at
    // all. Rewriting it corrupts a Windows path or a regex that merely mentions
    // one, which is a bug the parity-aware scrubber exists to avoid.
    const events = await replay([
      { type: 'thread.started', thread_id: 't1' },
      toolCall('{"re":"\\\\ud83d"}'),
      { type: 'turn.completed', usage: {} },
    ]);

    const content = (events.find((e) => e.event === 'block_delta')!.data as { content: string }).content;

    expect(JSON.parse(content)['re']).toBe('\\ud83d');
  });

  it('bounds them when they arrive PRE-STRINGIFIED', async () => {
    const events = await replay([
      { type: 'thread.started', thread_id: 't1' },
      toolCall(JSON.stringify({ file_path: '/tmp/a', content: 'x'.repeat(1_500_000) })),
      { type: 'turn.completed', usage: {} },
    ]);

    const delta = events.find((e) => e.event === 'block_delta');
    expect(delta).toBeDefined();
    expect(frameBytes(delta!)).toBeLessThan(SERVER_FRAME_CAP);
  });

  it('bounds them by STRUCTURE when they arrive as an object', async () => {
    const events = await replay([
      { type: 'thread.started', thread_id: 't1' },
      toolCall({ file_path: '/tmp/a', content: 'x'.repeat(1_500_000) }),
      { type: 'turn.completed', usage: {} },
    ]);

    const delta = events.find((e) => e.event === 'block_delta');
    expect(frameBytes(delta!)).toBeLessThan(SERVER_FRAME_CAP);

    // Bounding the encoded TEXT here would make it stop parsing, and the
    // consumer would then lose every argument — including file_path, which is
    // the field that says what the call actually did.
    const content = (delta!.data as { content: string }).content;
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed['file_path']).toBe('/tmp/a');
    expect(parsed['content']).toHaveProperty('__truncated__');
  });

  it('bounds an oversized result too', async () => {
    const events = await replay([
      { type: 'thread.started', thread_id: 't1' },
      {
        type: 'item.completed',
        item: {
          id: 'mcp_2', type: 'mcp_tool_call', server: 'bridge', tool: 'read_file',
          arguments: {}, result: 'y'.repeat(1_500_000), status: 'completed',
        },
      },
      { type: 'turn.completed', usage: {} },
    ]);

    const result = events.find((e) => e.event === 'tool_result');
    expect(result).toBeDefined();
    expect(frameBytes(result!)).toBeLessThan(SERVER_FRAME_CAP);
  });

  it('leaves ordinary arguments alone', async () => {
    const events = await replay([
      { type: 'thread.started', thread_id: 't1' },
      toolCall({ file_path: '/tmp/a' }),
      { type: 'turn.completed', usage: {} },
    ]);

    const delta = events.find((e) => e.event === 'block_delta');
    expect((delta!.data as { content: string }).content).toBe(JSON.stringify({ file_path: '/tmp/a' }));
  });
});

/**
 * Codex reports an MCP call's outcome as `in_progress` / `completed` /
 * `failed` (openai/codex, sdk/typescript/src/items.ts). The adapter read only
 * `error`, so a `failed` call carrying no `error` field was forwarded as
 * `is_error: false` — a success asserted about a failure, and nothing else in
 * the frame contradicts it.
 */
describe("codex's own words for how a tool call ended", () => {
  /** One completed MCP call item, with these fields folded in. */
  const mcpCall = (extra: Record<string, unknown>) => ({
    type: 'item.completed',
    item: {
      id: 'c1', type: 'mcp_tool_call', server: 'bridge', tool: 'write_file',
      arguments: { path: '/tmp/a' }, ...extra,
    },
  });

  /** Replay one MCP call with these extra item fields and return its tool_result data. */
  async function resultFor(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    const events = await replay([
      { type: 'thread.started', thread_id: 't1' },
      mcpCall(extra),
      { type: 'turn.completed', usage: {} },
    ]);

    return (events.find((e) => e.event === 'tool_result')!.data ?? {}) as Record<string, unknown>;
  }

  it('reports a `failed` call as an error even with no error field', async () => {
    const data = await resultFor({ status: 'failed', result: 'partial output' });

    expect(data['is_error']).toBe(true);
    expect(String(data['result'])).toContain('Error:');
  });

  it('reports a `completed` call as not an error', async () => {
    const data = await resultFor({ status: 'completed', result: 'wrote 12 bytes' });

    expect(data['is_error']).toBe(false);
    expect(data['result']).toBe('wrote 12 bytes');
  });

  it('still reads the older `error` status', async () => {
    const data = await resultFor({ status: 'error', error: 'disk full' });

    expect(data['is_error']).toBe(true);
    expect(String(data['result'])).toContain('disk full');
  });

  it('claims NOTHING for a status that is not a verdict', async () => {
    // `in_progress` is a status without being an outcome. Absent means "not
    // reported"; answering `false` here would invent a success.
    const data = await resultFor({ status: 'in_progress' });

    expect(data).not.toHaveProperty('is_error');
  });

  it('claims nothing when the status is missing entirely', async () => {
    const data = await resultFor({ result: 'ok' });

    expect(data).not.toHaveProperty('is_error');
  });
});

describe('a codex turn stopped by the bridge', () => {
  it('says which bound stopped it, rather than reporting the signal', async () => {
    // Codex had no timeout test at all, so dropping its getTimeout hook left the
    // suite green and it went back to "codex CLI exited with code 143".
    const events = await replay(
      [{ type: 'thread.started', thread_id: 't1' }],
      { silenceSeconds: 0.2, holdOpenMs: 5000 },
    );

    const error = events.find((e) => e.event === 'error')!.data as Record<string, unknown>;

    expect(error['code']).toBe('silence_timeout_exceeded');
    expect(error['limit_seconds']).toBe(0.2);
  });

  it('does not report the error codex writes on its way out', async () => {
    // The exposure this branch created: all three adapters now stop a CLI with
    // SIGINT rather than SIGTERM, and SIGINT is the signal that makes a CLI
    // wind down gracefully -- which means writing a final error frame. Reported
    // as-is, that tells a server the turn FAILED when the bridge stopped it,
    // and the bound's own reason and limit never arrive.
    const events = await replay(
      [{ type: 'thread.started', thread_id: 't1' }],
      {
        silenceSeconds: 0.2,
        holdOpenMs: 5000,
        lateLines: [{ type: 'error', message: 'interrupted by user' }],
      },
    );

    const errors = events.filter((e) => e.event === 'error').map((e) => e.data as Record<string, unknown>);

    expect(errors).toHaveLength(1);
    expect(errors[0]!['code']).toBe('silence_timeout_exceeded');
    expect(errors[0]!['limit_seconds']).toBe(0.2);
    expect(events.filter((e) => e.event === 'done')).toHaveLength(1);
  });

  it('does NOT stop a codex turn that keeps producing output', async () => {
    // The timeout test above proves the clock fires; only this proves OUTPUT
    // resets it. Removing Codex's reset left every test green, and a busy Codex
    // turn would then be killed while working — the bug this change fixes.
    const events = await replay(
      [
        { type: 'thread.started', thread_id: 't1' },
        ...Array.from({ length: 10 }, (_, i) => ({
          type: 'item.completed',
          item: { id: `m${i}`, type: 'agent_message', text: `chunk ${i}` },
        })),
        { type: 'turn.completed', usage: {} },
      ],
      // 0.8 s, not 0.3: the child node process must print its first line
      // inside the bound, and a loaded CI machine can take longer than 300 ms to
      // spawn one. Gaps between lines stay at 100 ms, far inside either.
      { silenceSeconds: 0.8, dripMs: 100 },
    );

    expect(events.filter((e) => e.event === 'error')).toHaveLength(0);
    expect(events.filter((e) => e.event === 'done')).toHaveLength(1);
  });
});

/**
 * A server tool that answered with an image (tool_resolve.content) reaches
 * Codex as an MCP image block, and Codex reports the call's result as the whole
 * CallToolResult. Forwarded as JSON, the picture went to the server inside the
 * echo; it is described instead, and the text beside it is kept.
 */
describe('codex tool results with an image', () => {
  it('describe the image and keep the text', async () => {
    const image = Buffer.alloc(300 * 1024, 1).toString('base64');
    const events = await replay([
      { type: 'thread.started', thread_id: 't1' },
      {
        type: 'item.completed',
        item: {
          id: 'mcp_3', type: 'mcp_tool_call', server: 'bridge', tool: 'render',
          arguments: {}, status: 'completed',
          result: { content: [{ type: 'text', text: 'Floor 1' }, { type: 'image', mimeType: 'image/webp', data: image }] },
        },
      },
      { type: 'turn.completed', usage: {} },
    ]);

    const results = events.filter((e) => e.event === 'tool_result');
    const text = results.map((e) => (e.data as { result: string }).result).join('');
    expect(text).not.toContain(image.slice(0, 100));
    expect(JSON.parse(text)).toEqual({
      content: [{ type: 'text', text: 'Floor 1' }, { type: 'text', text: '[image: image/webp, 300 KB]' }],
    });
  });
});
