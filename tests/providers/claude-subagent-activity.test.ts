/**
 * Helper (sub-agent) activity: what the Claude adapter forwards about the
 * helpers the main assistant starts.
 *
 * The CLI reports all of it — which step spawned each frame, each helper's
 * start, progress, heartbeat and closing summary, and the turn's helper totals
 * — and the bridge used to drop every bit of it, reading `parent_tool_use_id`
 * once, only to discard a streamed frame. A consumer then saw every helper call
 * as the main assistant's, lumped into one row, with no sign of life.
 *
 * Three fixtures are whole turns captured from Claude Code 2.1.280 with the
 * bridge's own flags (`-p --output-format stream-json --verbose
 * --include-partial-messages`), byte for byte:
 *
 *  - claude-subagent-heartbeat-turn: a FOREGROUND helper blocked 65 s in one
 *    Bash call, so the CLI emits two `tool_progress` heartbeats (30 s, 60 s).
 *  - claude-background-subagent-turn: a BACKGROUND helper (run with
 *    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS unset). The main assistant finishes
 *    its reply at ~7 s; the helper works on for ~45 s; the CLI then answers the
 *    helper's notification itself and only THEN writes both `result` frames —
 *    ours (unstamped) and the notification's (`origin: task-notification`).
 *  - claude-background-disabled-turn: the same request with the bridge's
 *    default CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1. The helper runs in the
 *    foreground (`is_backgrounded: false`) and the main assistant waits.
 */

import { describe, it, expect, vi } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { ClaudeAdapter } from '../../src/providers/claude.js';
import { MAX_TASK_TEXT_BYTES } from '../../src/providers/result-text.js';
import type { AdapterStreamEvent } from '../../src/providers/base.js';
import type { AiRequestMessage, TaskData } from '../../src/protocol/types.js';

vi.mock('../../src/providers/claude-capabilities.js', () => ({
  supportsPartialMessages: () => Promise.resolve(true),
  resetPartialMessageSupportCache: () => {},
  noteCliRejectedPartialFlag: () => false,
}));

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

const HEARTBEAT_TURN = 'claude-subagent-heartbeat-turn.ndjson';
const BACKGROUND_TURN = 'claude-background-subagent-turn.ndjson';
const BACKGROUND_DISABLED_TURN = 'claude-background-disabled-turn.ndjson';

/** Replay NDJSON — a fixture file, or lines given inline — through the adapter. */
async function replay(
  source: ({ fixture: string } | { lines: unknown[] })
    & { silenceTimeoutSeconds?: number; holdOpenMs?: number; dripMs?: number },
): Promise<AdapterStreamEvent[]> {
  let path: string;
  let scratch: string | null = null;
  if ('fixture' in source) {
    path = join(FIXTURES, source.fixture);
  } else {
    scratch = mkdtempSync(join(tmpdir(), 'replay-'));
    path = join(scratch, 'stream.ndjson');
    writeFileSync(path, source.lines.map((l) => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n');
  }

  class Replay extends ClaudeAdapter {
    protected override spawnCli(): ChildProcessByStdio<Writable | null, Readable, Readable> {
      return spawn(
        process.execPath,
        [
          '-e',
          // `drip` writes one line at a time with a gap, so a test can hold a
          // turn open for longer than its silence bound while it keeps talking.
          'const fs = require("fs");'
          + 'const lines = fs.readFileSync(process.argv[1], "utf8").split("\\n").filter(Boolean);'
          + 'const hold = Number(process.argv[2] || 0);'
          + 'const drip = Number(process.argv[3] || 0);'
          + 'if (drip > 0) {'
          + '  let i = 0;'
          + '  const tick = () => {'
          + '    if (i < lines.length) { process.stdout.write(lines[i++] + "\\n"); setTimeout(tick, drip); }'
          + '    else if (hold > 0) { setTimeout(() => {}, hold); }'
          + '  };'
          + '  tick();'
          + '} else {'
          + '  process.stdout.write(lines.join("\\n") + "\\n");'
          + '  if (hold > 0) setTimeout(() => {}, hold);'
          + '}',
          path,
          String(source.holdOpenMs ?? 0),
          String(source.dripMs ?? 0),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      ) as ChildProcessByStdio<Writable | null, Readable, Readable>;
    }
  }

  const request: AiRequestMessage = {
    type: 'ai_request',
    request_id: 'req_tasks',
    conversation_id: 'c',
    provider: 'claude',
    message: 'go',
    system_prompt: null,
    options: {},
    cli_session_id: null,
  };

  const events: AdapterStreamEvent[] = [];
  try {
    await new Replay().execute({
      request,
      requestId: request.request_id,
      tools: [],
      mcp: null,
      cliIsolation: 'native',
      workingDir: process.cwd(),
      signal: new AbortController().signal,
      requestTimeoutSeconds: 30,
      silenceTimeoutSeconds: source.silenceTimeoutSeconds ?? 0,
      cliSessionId: null,
      attachmentDir: null,
      bridgeEnv: {},
      bridgeAddendum: null,
    }, (e) => events.push(e));
  } finally {
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  }
  return events;
}

const of = (events: AdapterStreamEvent[], name: string) => events.filter((e) => e.event === name);
const tasks = (events: AdapterStreamEvent[]) => of(events, 'task').map((e) => e.data as TaskData);
const data = (e: AdapterStreamEvent) => e.data as unknown as Record<string, unknown>;

/** The raw CLI frames of a fixture, for asserting against what the CLI actually said. */
function frames(fixture: string): Array<Record<string, unknown>> {
  return readFileSync(join(FIXTURES, fixture), 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** The id of the main assistant's `Agent` call in a replayed turn. */
function agentCallId(events: AdapterStreamEvent[]): string {
  const start = of(events, 'block_start').find((e) => data(e)['tool_name'] === 'Agent');
  return data(start!)['tool_call_id'] as string;
}

// ── Which step each block belongs to ─────────────────────────────────────

describe('a helper\'s blocks and results name the call that spawned it', () => {
  it('marks the helper\'s calls and results, and leaves the main assistant\'s unmarked', async () => {
    const events = await replay({ fixture: 'claude-partial-subagent-turn.ndjson' });
    const agent = agentCallId(events);

    const starts = of(events, 'block_start').map(data);
    const byTool = Object.fromEntries(
      starts.filter((d) => d['tool_name'] !== undefined).map((d) => [d['tool_name'], d]),
    );
    expect(byTool['Bash']!['parent_tool_use_id']).toBe(agent);
    expect(byTool['Read']!['parent_tool_use_id']).toBe(agent);

    // ABSENT, not null: a consumer that predates the field must see the exact
    // payload it always did for the main assistant.
    expect('parent_tool_use_id' in byTool['Agent']!).toBe(false);
    const mainText = starts.filter((d) => d['block_type'] === 'text');
    expect(mainText.length).toBeGreaterThan(0);
    for (const d of mainText) expect('parent_tool_use_id' in d).toBe(false);

    const results = of(events, 'tool_result').map(data);
    const helperResults = results.filter((d) => d['tool_call_id'] !== agent);
    expect(helperResults).toHaveLength(2);
    for (const d of helperResults) expect(d['parent_tool_use_id']).toBe(agent);
    // The Agent call's own result is the main assistant's.
    const agentResult = results.find((d) => d['tool_call_id'] === agent)!;
    expect('parent_tool_use_id' in agentResult).toBe(false);
  });

  it('marks a helper\'s own prose too, so it is never read as the main assistant\'s', async () => {
    const events = await replay({ fixture: BACKGROUND_TURN });
    const agent = agentCallId(events);

    const helperText = of(events, 'block_start').map(data)
      .filter((d) => d['block_type'] === 'text' && d['parent_tool_use_id'] === agent);
    expect(helperText).toHaveLength(1);

    const mainText = of(events, 'block_start').map(data)
      .filter((d) => d['block_type'] === 'text' && !('parent_tool_use_id' in d));
    // "Helper started in the background." and the reply to the notification.
    expect(mainText).toHaveLength(2);
  });

  it('keeps numbering blocks 0,1,2… across both paths with helpers in play', async () => {
    // The streaming-path guard stays: a helper's frames still arrive whole, and
    // the one counter still hands out every index exactly once.
    for (const fixture of [HEARTBEAT_TURN, BACKGROUND_TURN, BACKGROUND_DISABLED_TURN]) {
      const events = await replay({ fixture });
      const indices = of(events, 'block_start').map((e) => data(e)['block_index']);
      expect(indices.length, fixture).toBeGreaterThan(1);
      expect(indices, fixture).toEqual(indices.map((_, i) => i));
    }
  });

  it('puts the parent on every chunk of a chunked result', async () => {
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        {
          type: 'user',
          parent_tool_use_id: 'toolu_agent',
          message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'x'.repeat(700 * 1024) }] },
        },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    const chunks = of(events, 'tool_result').map(data);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk['parent_tool_use_id']).toBe('toolu_agent');
  });

  it('treats an empty or non-string parent as the main assistant', async () => {
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'a' }] } },
        { type: 'assistant', parent_tool_use_id: '', message: { id: 'm2', content: [{ type: 'text', text: 'b' }] } },
        { type: 'assistant', parent_tool_use_id: 42, message: { id: 'm3', content: [{ type: 'text', text: 'c' }] } },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    for (const start of of(events, 'block_start')) expect('parent_tool_use_id' in data(start)).toBe(false);
  });
});

// ── The helper's life ───────────────────────────────────────────────────

describe('the task event', () => {
  it('follows a foreground helper from start to finish, with its heartbeats', async () => {
    const events = await replay({ fixture: HEARTBEAT_TURN });
    const agent = agentCallId(events);
    const life = tasks(events);

    expect(life.map((t) => t.phase)).toEqual(['started', 'progress', 'heartbeat', 'heartbeat', 'updated', 'finished']);
    // One helper, one key — including on `updated` and `heartbeat`, where the
    // CLI does not name the call the same way, and the bridge fills it in.
    expect(new Set(life.map((t) => t.tool_use_id))).toEqual(new Set([agent]));
    expect(new Set(life.map((t) => t.task_id)).size).toBe(1);
    // The CLI names the kind only at `started`; the bridge repeats it, so a
    // consumer can tell a helper from a shell command from any one event.
    expect(life.map((t) => t.task_type)).toEqual(Array(life.length).fill('local_agent'));

    const [started, progress, beat1, beat2, updated, finished] = life;
    expect(started).toMatchObject({
      task_type: 'local_agent',
      subagent_type: 'general-purpose',
      description: 'Run sleep command',
      spawn_depth: 1,
      is_backgrounded: false,
    });
    expect(progress).toMatchObject({ last_tool_name: 'Bash', usage: { total_tokens: 24963, tool_uses: 1 } });
    expect(beat1!.elapsed_seconds).toBe(30);
    expect(beat2!.elapsed_seconds).toBe(60);
    expect(updated!.status).toBe('completed');
    expect(finished).toMatchObject({ status: 'completed', usage: { total_tokens: 25722, tool_uses: 1 } });
    expect(finished!.summary).toContain('slept-ok');
  });

  it('never sends the helper\'s instructions, nor a path on this machine', async () => {
    const raw = frames(HEARTBEAT_TURN).find((f) => f['subtype'] === 'task_started')!;
    const prompt = raw['prompt'] as string;
    expect(prompt.length).toBeGreaterThan(20);

    const events = await replay({ fixture: HEARTBEAT_TURN });
    for (const task of tasks(events)) {
      expect(task).not.toHaveProperty('prompt');
      expect(task).not.toHaveProperty('output_file');
    }
    expect(JSON.stringify(of(events, 'task'))).not.toContain(prompt);
  });

  it('follows a BACKGROUND helper past the end of the main assistant\'s reply', async () => {
    const events = await replay({ fixture: BACKGROUND_TURN });
    const agent = agentCallId(events);
    const at = (pred: (e: AdapterStreamEvent) => boolean) => events.findIndex(pred);

    const helper = tasks(events).filter((t) => t.tool_use_id === agent);
    expect(helper.map((t) => t.phase)).toEqual(['started', 'progress', 'updated', 'finished']);
    expect(helper[0]).toMatchObject({ is_backgrounded: true, task_type: 'local_agent' });
    expect(helper[3]).toMatchObject({ status: 'completed', usage: { tool_uses: 1 } });

    // The spawning call returned at once ("Async agent launched"), and the main
    // assistant finished its reply — both long before the helper did. Neither
    // is the helper finishing; only `finished` is.
    const agentResult = at((e) => e.event === 'tool_result' && data(e)['tool_call_id'] === agent);
    // The main assistant's first text block is its whole reply to us.
    const replyIndex = data(of(events, 'block_start').find((e) => data(e)['block_type'] === 'text'
      && !('parent_tool_use_id' in data(e)))!)['block_index'];
    const mainReplyStop = at((e) => e.event === 'block_stop' && data(e)['block_index'] === replyIndex);
    const finished = at((e) => e.event === 'task' && (e.data as TaskData).phase === 'finished'
      && (e.data as TaskData).tool_use_id === agent);
    expect(agentResult).toBeGreaterThan(-1);
    expect(mainReplyStop).toBeGreaterThan(agentResult);
    expect(finished).toBeGreaterThan(mainReplyStop);
    // And the turn does not end before the helper does.
    expect(at((e) => e.event === 'done')).toBeGreaterThan(finished);
  });

  it('reports a helper\'s background shell command as a task of its own kind', async () => {
    // The helper's long command becomes a `local_bash` task. `task_type` is
    // what lets a consumer show it under the helper rather than as a second
    // helper.
    const events = await replay({ fixture: BACKGROUND_TURN });
    const shell = tasks(events).filter((t) => t.phase === 'started' && t.task_type === 'local_bash');
    expect(shell).toHaveLength(1);
    expect(tasks(events).filter((t) => t.task_id === shell[0]!.task_id).map((t) => [t.phase, t.task_type]))
      .toEqual([['started', 'local_bash'], ['finished', 'local_bash']]);
  });

  it('shows the bridge\'s default keeping a helper in the foreground', async () => {
    // Recorded, not asserted as desirable: with CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
    // the same request produced a helper the main assistant waited for.
    const events = await replay({ fixture: BACKGROUND_DISABLED_TURN });
    const started = tasks(events).find((t) => t.phase === 'started')!;
    expect(started.is_backgrounded).toBe(false);
    expect(tasks(events).filter((t) => t.phase === 'heartbeat')).toHaveLength(1);
  });

  it('says nothing about a task it never saw start', async () => {
    // The CLI's own queued work: on --resume it first reports that a
    // background command an EARLIER turn left running was stopped. Not a
    // helper of this turn.
    const events = await replay({ fixture: 'claude-queued-notification-turn.ndjson' });
    expect(of(events, 'task')).toHaveLength(0);
  });

  it('follows a task that started without naming its call to the end', async () => {
    // The set of started tasks used to be the task_id → spawning-call map, so
    // a `task_started` without a `tool_use_id` was forwarded and then every
    // later phase was dropped as "never saw start": a consumer drew a helper
    // that ran forever.
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        { type: 'system', subtype: 'task_started', task_id: 't1', task_type: 'local_agent', description: 'Look around' },
        { type: 'system', subtype: 'task_progress', task_id: 't1', last_tool_name: 'Read' },
        { type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'completed' } },
        { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'done' },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    expect(tasks(events).map((t) => t.phase)).toEqual(['started', 'progress', 'updated', 'finished']);
    expect(tasks(events).every((t) => t.task_id === 't1' && t.tool_use_id === undefined)).toBe(true);
    expect(tasks(events).at(-1)).toMatchObject({ status: 'completed', summary: 'done' });
  });

  it('learns the call from a later phase when the start did not name it', async () => {
    // Once a phase names the call, the task is keyed by it — so a heartbeat
    // for that call, and an `updated` that omits it, are attributed too.
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        { type: 'system', subtype: 'task_started', task_id: 't1', task_type: 'local_agent' },
        { type: 'system', subtype: 'task_progress', task_id: 't1', tool_use_id: 'toolu_agent' },
        { type: 'tool_progress', tool_name: 'Agent', parent_tool_use_id: 'toolu_agent', elapsed_time_seconds: 30, heartbeat: true },
        { type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'completed' } },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    expect(tasks(events).map((t) => [t.phase, t.tool_use_id])).toEqual([
      ['started', undefined],
      ['progress', 'toolu_agent'],
      ['heartbeat', 'toolu_agent'],
      ['updated', 'toolu_agent'],
    ]);
  });

  it('ignores a heartbeat that is not a helper\'s, and progress that is not a heartbeat', async () => {
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        { type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_agent', task_type: 'local_agent' },
        { type: 'tool_progress', tool_name: 'Bash', parent_tool_use_id: 'toolu_other', elapsed_time_seconds: 30, heartbeat: true },
        { type: 'tool_progress', tool_name: 'Agent', parent_tool_use_id: 'toolu_agent', elapsed_time_seconds: 30 },
        { type: 'tool_progress', tool_name: 'Agent', parent_tool_use_id: 'toolu_agent', elapsed_time_seconds: 60, heartbeat: true },
        { type: 'system', subtype: 'task_updated', task_id: 't1', patch: { end_time: 1 } },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    expect(tasks(events)).toEqual([
      { phase: 'started', task_id: 't1', tool_use_id: 'toolu_agent', task_type: 'local_agent' },
      { phase: 'heartbeat', task_id: 't1', tool_use_id: 'toolu_agent', task_type: 'local_agent', elapsed_seconds: 60 },
    ]);
  });

  it('is dropped once the turn has ended', async () => {
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        { type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_agent' },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
        { type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_agent', status: 'completed' },
      ],
    });

    expect(tasks(events).map((t) => t.phase)).toEqual(['started']);
    expect(events.at(-1)!.event).toBe('done');
  });

  it('waits for an open streamed block, like every whole-message event', async () => {
    // A task event emitted inside an open block would land between its deltas;
    // it goes through the same deferral queue as a helper's blocks.
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } },
        { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } },
        { type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_agent' },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    expect(events.map((e) => e.event)).toEqual(['block_start', 'block_delta', 'block_stop', 'task', 'done']);
  });
});

// ── Shapes the fixtures do not cover ───────────────────────────────────
//
// Built from the captured frame shapes above, not captured whole: a helper's
// helper, two helpers at once, and a shell the MAIN assistant backgrounds.

describe('the task event, beyond one helper', () => {
  it('keeps a helper\'s own helper apart from it (depth 2)', async () => {
    // The inner helper is spawned by the OUTER helper's Agent call, so its
    // `tool_use_id` is that call — itself marked as the outer helper's block.
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [
          { type: 'tool_use', id: 'toolu_outer', name: 'Agent', input: {} }] } },
        { type: 'system', subtype: 'task_started', task_id: 'outer', tool_use_id: 'toolu_outer',
          task_type: 'local_agent', spawn_depth: 1, is_backgrounded: false },
        { type: 'assistant', parent_tool_use_id: 'toolu_outer', message: { id: 'm2', content: [
          { type: 'tool_use', id: 'toolu_inner', name: 'Agent', input: {} }] } },
        { type: 'system', subtype: 'task_started', task_id: 'inner', tool_use_id: 'toolu_inner',
          task_type: 'local_agent', spawn_depth: 2, is_backgrounded: false },
        { type: 'tool_progress', tool_name: 'Agent', parent_tool_use_id: 'toolu_outer', elapsed_time_seconds: 30, heartbeat: true },
        { type: 'tool_progress', tool_name: 'Agent', parent_tool_use_id: 'toolu_inner', elapsed_time_seconds: 30, heartbeat: true },
        { type: 'system', subtype: 'task_notification', task_id: 'inner', tool_use_id: 'toolu_inner', status: 'completed' },
        { type: 'system', subtype: 'task_notification', task_id: 'outer', tool_use_id: 'toolu_outer', status: 'completed' },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    const innerCall = of(events, 'block_start').map(data).find((d) => d['tool_call_id'] === 'toolu_inner')!;
    expect(innerCall['parent_tool_use_id']).toBe('toolu_outer');

    const life = tasks(events).map((t) => [t.task_id, t.phase, t.tool_use_id]);
    expect(life).toEqual([
      ['outer', 'started', 'toolu_outer'],
      ['inner', 'started', 'toolu_inner'],
      ['outer', 'heartbeat', 'toolu_outer'],
      ['inner', 'heartbeat', 'toolu_inner'],
      ['inner', 'finished', 'toolu_inner'],
      ['outer', 'finished', 'toolu_outer'],
    ]);
    expect(tasks(events).filter((t) => t.phase === 'started').map((t) => t.spawn_depth)).toEqual([1, 2]);
  });

  it('attributes each heartbeat to its own helper when two run at once', async () => {
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        { type: 'system', subtype: 'task_started', task_id: 'a', tool_use_id: 'toolu_a', task_type: 'local_agent', is_backgrounded: false },
        { type: 'system', subtype: 'task_started', task_id: 'b', tool_use_id: 'toolu_b', task_type: 'local_agent', is_backgrounded: false },
        { type: 'tool_progress', tool_name: 'Agent', parent_tool_use_id: 'toolu_b', elapsed_time_seconds: 30, heartbeat: true },
        { type: 'tool_progress', tool_name: 'Agent', parent_tool_use_id: 'toolu_a', elapsed_time_seconds: 30, heartbeat: true },
        { type: 'system', subtype: 'task_progress', task_id: 'a', tool_use_id: 'toolu_a', last_tool_name: 'Read' },
        { type: 'system', subtype: 'task_updated', task_id: 'b', patch: { status: 'completed' } },
        { type: 'system', subtype: 'task_notification', task_id: 'b', tool_use_id: 'toolu_b', status: 'completed' },
        { type: 'tool_progress', tool_name: 'Agent', parent_tool_use_id: 'toolu_a', elapsed_time_seconds: 60, heartbeat: true },
        { type: 'system', subtype: 'task_notification', task_id: 'a', tool_use_id: 'toolu_a', status: 'failed' },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    const byTask = (id: string) => tasks(events).filter((t) => t.task_id === id);
    expect(byTask('a').map((t) => [t.phase, t.tool_use_id, t.elapsed_seconds ?? t.status ?? null])).toEqual([
      ['started', 'toolu_a', null],
      ['heartbeat', 'toolu_a', 30],
      ['progress', 'toolu_a', null],
      ['heartbeat', 'toolu_a', 60],
      ['finished', 'toolu_a', 'failed'],
    ]);
    expect(byTask('b').map((t) => [t.phase, t.tool_use_id, t.elapsed_seconds ?? t.status ?? null])).toEqual([
      ['started', 'toolu_b', null],
      ['heartbeat', 'toolu_b', 30],
      ['updated', 'toolu_b', 'completed'],
      ['finished', 'toolu_b', 'completed'],
    ]);
  });

  it('reports a shell the MAIN assistant backgrounds, keyed by its unmarked call, and ends with the turn', async () => {
    // `run_in_background` on the main assistant's own Bash call: a `local_bash`
    // task whose call carries no parent. The CLI writes its `result` while the
    // shell still runs, so no `finished` reaches the server — `done` is what
    // ends the task (PROTOCOL.md: the request's terminal frame ends them all).
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [
          { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'sleep 600', run_in_background: true } }] } },
        { type: 'system', subtype: 'task_started', task_id: 'sh1', tool_use_id: 'toolu_bash',
          task_type: 'local_bash', description: 'sleep 600', is_backgrounded: true },
        { type: 'user', parent_tool_use_id: null, message: { content: [
          { type: 'tool_result', tool_use_id: 'toolu_bash', content: 'Command running in background with ID: sh1' }] } },
        { type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'text', text: 'Started it.' }] } },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
        { type: 'system', subtype: 'task_notification', task_id: 'sh1', tool_use_id: 'toolu_bash', status: 'killed' },
      ],
    });

    const bashCall = of(events, 'block_start').map(data).find((d) => d['tool_call_id'] === 'toolu_bash')!;
    expect('parent_tool_use_id' in bashCall).toBe(false);
    expect(tasks(events)).toEqual([expect.objectContaining({
      phase: 'started', task_id: 'sh1', tool_use_id: 'toolu_bash', task_type: 'local_bash', is_backgrounded: true,
    })]);
    expect(events.at(-1)!.event).toBe('done');
  });
});

// ── Size ───────────────────────────────────────────────────────────────

describe('a task frame stays small', () => {
  const HUGE_PROMPT = 'do this. '.repeat(200_000);
  // An emoji straddling every plausible cut, so a cut that splits a surrogate
  // pair would show up as a lone surrogate.
  const HUGE_SUMMARY = '😀'.repeat(20_000);

  it('whatever the helper was asked or answered', async () => {
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        {
          type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_agent',
          description: 'd'.repeat(50_000), prompt: HUGE_PROMPT,
        },
        {
          type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_agent',
          status: 'completed', summary: HUGE_SUMMARY,
        },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });

    const frames = of(events, 'task');
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      // The whole event, envelope aside, is a few kilobytes over the text cap
      // at most — nowhere near the 900 KB frame guard that would drop it.
      expect(Buffer.byteLength(JSON.stringify(frame.data), 'utf8')).toBeLessThan(MAX_TASK_TEXT_BYTES + 1024);
    }

    const summary = (frames[1]!.data as TaskData).summary!;
    expect(Buffer.byteLength(JSON.stringify(summary), 'utf8')).toBeLessThanOrEqual(MAX_TASK_TEXT_BYTES);
    expect(summary).toMatch(/…\[truncated by the bridge: showing \d+ of \d+ characters\]$/);
    expect(summary.startsWith('😀😀😀')).toBe(true);
    // Cut on a character boundary: no half of a pair survives.
    expect(summary).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  it('leaves a summary that fits exactly as the CLI wrote it', async () => {
    const events = await replay({ fixture: HEARTBEAT_TURN });
    const raw = frames(HEARTBEAT_TURN).find((f) => f['subtype'] === 'task_notification')!;
    const finished = tasks(events).find((t) => t.phase === 'finished')!;
    expect(finished.summary).toBe(raw['summary']);
  });
});

// ── The turn's totals ──────────────────────────────────────────────────

describe('done.subagent_stats', () => {
  it('carries what the turn spent on helpers, as the CLI reported it', async () => {
    const events = await replay({ fixture: HEARTBEAT_TURN });
    const raw = frames(HEARTBEAT_TURN).find((f) => f['type'] === 'result')!;

    const done = data(of(events, 'done')[0]!);
    expect(done['subagent_stats']).toEqual(raw['subagent_stats']);
    expect(done['subagent_stats']).toMatchObject({ spawned: 1, completed: 1, failed: 0 });
  });

  it('comes from OUR result on a background turn, not the notification\'s', async () => {
    const events = await replay({ fixture: BACKGROUND_TURN });
    expect(of(events, 'done')).toHaveLength(1);
    expect(data(of(events, 'done')[0]!)['subagent_stats'])
      .toMatchObject({ spawned: 1, started_in_background: 1, completed: 1 });
  });

  it('is absent when the CLI did not report it', async () => {
    const events = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's' },
        { type: 'result', subtype: 'success', session_id: 's', usage: {} },
      ],
    });
    expect(data(of(events, 'done')[0]!)).not.toHaveProperty('subagent_stats');
  });
});

// ── The silence clock ───────────────────────────────────────────────────

describe('a helper\'s heartbeat counts as activity', () => {
  /** A helper that says nothing but its heartbeat for longer than the silence bound. */
  const quietHelper = (beat: Record<string, unknown>) => [
    { type: 'system', subtype: 'init', session_id: 's' },
    { type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_agent', task_type: 'local_agent' },
    ...Array.from({ length: 10 }, () => beat),
    { type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_agent', status: 'completed' },
    { type: 'result', subtype: 'success', session_id: 's', usage: {} },
  ];

  it('so a helper busy in one long step does not get the turn stopped as silent', async () => {
    // ~1.3 s of nothing but heartbeats against a 0.3 s bound.
    const events = await replay({
      lines: quietHelper({
        type: 'tool_progress', tool_name: 'Agent', parent_tool_use_id: 'toolu_agent',
        elapsed_time_seconds: 30, heartbeat: true,
      }),
      silenceTimeoutSeconds: 0.3,
      dripMs: 100,
    });

    expect(of(events, 'error')).toHaveLength(0);
    expect(tasks(events).filter((t) => t.phase === 'heartbeat')).toHaveLength(10);
    expect(tasks(events).at(-1)!.phase).toBe('finished');
  });

  it('and the same stretch without them IS stopped — the heartbeat is what saved it', async () => {
    // The control. Identical timing, but frames the bridge does not forward:
    // without this the test above would pass against a silence clock that was
    // simply not armed.
    const events = await replay({
      lines: quietHelper({ type: 'system', subtype: 'status', status: 'requesting', session_id: 's' }),
      silenceTimeoutSeconds: 0.3,
      dripMs: 100,
    });

    expect(data(of(events, 'error')[0]!)['code']).toBe('silence_timeout_exceeded');
  });
});

describe('a helper\'s streamed chunks count as activity', () => {
  /** A helper that streams for longer than the silence bound, then its whole message. */
  const streamingHelper = (chunk: Record<string, unknown>) => [
    { type: 'system', subtype: 'init', session_id: 's' },
    { type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_agent', task_type: 'local_agent' },
    ...Array.from({ length: 10 }, () => chunk),
    {
      type: 'assistant', parent_tool_use_id: 'toolu_agent',
      message: { id: 'msg_helper', content: [{ type: 'text', text: 'helper answer' }] },
    },
    { type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_agent', status: 'completed' },
    { type: 'result', subtype: 'success', session_id: 's', usage: {} },
  ];

  it('so a helper streaming a long answer does not get the turn stopped as silent', async () => {
    // ~1.3 s of nothing but the helper's streamed deltas against a 0.3 s bound.
    const events = await replay({
      lines: streamingHelper({
        type: 'stream_event', parent_tool_use_id: 'toolu_agent', session_id: 's',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      }),
      silenceTimeoutSeconds: 0.3,
      dripMs: 100,
    });

    expect(of(events, 'error')).toHaveLength(0);
    // Still not forwarded: the helper's text arrives once, from its whole message.
    const deltas = of(events, 'block_delta').map((e) => data(e)['content']);
    expect(deltas).toEqual(['helper answer']);
    expect(of(events, 'done')).toHaveLength(1);
  });

  it('and the same stretch without them IS stopped — the chunks are what saved it', async () => {
    const events = await replay({
      lines: streamingHelper({ type: 'system', subtype: 'status', status: 'requesting', session_id: 's' }),
      silenceTimeoutSeconds: 0.3,
      dripMs: 100,
    });

    expect(data(of(events, 'error')[0]!)['code']).toBe('silence_timeout_exceeded');
  });
});
