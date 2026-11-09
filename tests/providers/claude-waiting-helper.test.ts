/**
 * A helper that stops while its own background work still runs is WAITING,
 * not done: the CLI wakes it when that work ends (a new `task_started` for the
 * same task_id) and it works on. The stream does not say so — the helper
 * reports `completed` like any finished one — so the turn keeps its input open
 * while the helper's own work runs and then for a resume window.
 *
 * Frame shapes from Claude Code 2.1.287 (captured 2026-11-06): a helper's
 * tool call shows up on its whole `assistant` frame (`parent_tool_use_id` =
 * the helper's spawning call), and the task the CLI starts for it carries that
 * call as `tool_use_id`. A helper's shell command also says
 * `owned_by_subagent: true`; a helper it spawns (spawn_depth 2) does not.
 */

import { describe, it, expect, vi } from 'vitest';
import { runInputTurn, of, type Step } from './support/input-turn.js';
import type { AdapterStreamEvent } from '../../src/providers/base.js';

vi.mock('../../src/providers/claude-capabilities.js', () => ({
  supportsPartialMessages: () => Promise.resolve(true),
  resetPartialMessageSupportCache: () => {},
  noteCliRejectedPartialFlag: () => false,
}));

const line = (value: unknown): Step => ({ line: JSON.stringify(value) });
const init = line({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5' });
const echo = (content: string): Step => line({
  type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: 's1', isReplay: true,
});
const text = (value: string): Step => line({
  type: 'assistant', parent_tool_use_id: null,
  message: { id: `msg_${value}`, role: 'assistant', content: [{ type: 'text', text: value }], stop_reason: 'end_turn' },
});
const result = (extra: Record<string, unknown> = {}): Step => line({
  type: 'result', subtype: 'success', is_error: false, session_id: 's1', num_turns: 1,
  usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 },
  ...extra,
});
/** The main assistant's answer to a finished background task: a turn of its own, stamped. */
const notificationTurn = (say: string): Step[] => [init, text(say), result({ origin: { kind: 'task-notification' } })];

/** A background helper of the main assistant. */
const helperStarted = (id: string): Step => line({
  type: 'system', subtype: 'task_started', task_id: id, tool_use_id: `toolu_${id}`, description: id,
  subagent_type: 'general-purpose', is_backgrounded: true, spawn_depth: 1, task_type: 'local_agent',
});
/** The helper `by` calls a tool: what tells whose a task is. */
const helperCalls = (by: string, call: string, name: string): Step => line({
  type: 'assistant', parent_tool_use_id: `toolu_${by}`,
  message: { id: `msg_${by}_${call}`, role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${call}`, name, input: {} }] },
});
/** A shell command a helper runs in the background. */
const helperCommand = (id: string): Step => line({
  type: 'system', subtype: 'task_started', task_id: id, tool_use_id: `toolu_${id}`, owned_by_subagent: true,
  description: id, is_backgrounded: true, task_type: 'local_bash',
});
/** A helper a helper spawned: no `owned_by_subagent`, spawn_depth 2. */
const nestedHelper = (id: string): Step => line({
  type: 'system', subtype: 'task_started', task_id: id, tool_use_id: `toolu_${id}`, description: id,
  subagent_type: 'general-purpose', is_backgrounded: false, spawn_depth: 2, task_type: 'local_agent',
});
/** How the CLI ends a task: `task_updated`, then `task_notification`. */
const ended = (id: string, status = 'completed'): Step[] => [
  line({ type: 'system', subtype: 'task_updated', task_id: id, patch: { status, end_time: 1 } }),
  line({ type: 'system', subtype: 'task_notification', task_id: id, tool_use_id: `toolu_${id}`, status, summary: id }),
];
const helperSays = (by: string, value: string): Step => line({
  type: 'assistant', parent_tool_use_id: `toolu_${by}`,
  message: { id: `msg_${by}_${value}`, role: 'assistant', content: [{ type: 'text', text: value }] },
});

/** The script lines written before the step at `index` (so: an `eofAt` value). */
const linesBefore = (steps: Step[], index: number): number =>
  steps.slice(0, index).filter((s) => 'line' in s).length;

/** When, after the turn began, the task with this id ended (its first ending frame) and the input closed. */
function timing(events: AdapterStreamEvent[], taskId: string, t0: number, stamps: number[]) {
  const endIndex = events.findIndex((e) => e.event === 'task'
    && (e.data as { task_id?: string }).task_id === taskId
    && ((e.data as { phase?: string }).phase === 'finished' || (e.data as { phase?: string }).phase === 'updated'));
  const closeIndex = events.findIndex((e) => e.event === 'input_closed');

  return { ended: stamps[endIndex] - t0, closed: stamps[closeIndex] - t0 };
}

async function run(steps: Step[], helperResumeWindowMs: number) {
  const stamps: number[] = [];
  const t0 = Date.now();
  const turn = await runInputTurn({
    message: 'go', steps, helperResumeWindowMs, onEvent: () => { stamps.push(Date.now()); },
  });

  return { ...turn, t0, stamps };
}

describe('a helper waiting on its own work', () => {
  it('holds the turn open past its own shell command until the CLI resumes it', async () => {
    const steps: Step[] = [
      echo('go'), init,
      helperStarted('a1'), text('Launched.'), result(),
      helperCalls('a1', 'b1', 'Bash'), helperCommand('b1'),
      ...ended('a1'),
      ...notificationTurn('The helper is waiting on its check.'),
      { sleep: 100 },
      ...ended('b1'),
      // Nothing runs and the main assistant is idle: the old rule closed here.
      { sleep: 400 },
      helperStarted('a1'), helperSays('a1', 'Check passed, committing.'),
      ...ended('a1'),
      ...notificationTurn('The helper is done.'),
      { waitEof: true },
    ];
    const turn = await run(steps, 3000);

    expect(turn.record.eofAt).toBe(linesBefore(steps, steps.length - 1));
    expect(of(turn.events, 'input_closed').map((e) => e.data)).toEqual([{ reason: 'idle' }]);
    expect(of(turn.events, 'error')).toEqual([]);
  });

  it('holds the turn open while a helper it spawned runs, and for the resume after', async () => {
    const steps: Step[] = [
      echo('go'), init,
      helperStarted('a1'), text('Launched.'), result(),
      helperCalls('a1', 'n1', 'Agent'), nestedHelper('n1'),
      ...ended('a1'),
      ...notificationTurn('The helper is waiting on its own helper.'),
      { sleep: 150 },
      ...ended('n1'),
      { sleep: 400 },
      helperStarted('a1'), helperSays('a1', 'Got the result.'),
      ...ended('a1'),
      ...notificationTurn('Done.'),
      { waitEof: true },
    ];
    const turn = await run(steps, 3000);

    expect(turn.record.eofAt).toBe(linesBefore(steps, steps.length - 1));
    expect(of(turn.events, 'error')).toEqual([]);
  });

  it('closes once the window passes without a resume', async () => {
    const steps: Step[] = [
      echo('go'), init,
      helperStarted('a1'), text('Launched.'), result(),
      helperCalls('a1', 'b1', 'Bash'), helperCommand('b1'),
      ...ended('a1'),
      ...notificationTurn('Waiting.'),
      ...ended('b1'),
      { waitEof: true },
    ];
    const turn = await run(steps, 600);
    const { ended: endedAt, closed } = timing(turn.events, 'b1', turn.t0, turn.stamps);

    expect(turn.record.eofAt).toBe(linesBefore(steps, steps.length - 1));
    expect(closed - endedAt).toBeGreaterThanOrEqual(550);
    expect(of(turn.events, 'input_closed').map((e) => e.data)).toEqual([{ reason: 'idle' }]);
  });

  it.each(['failed', 'killed'])('is not waited for when it %s', async (status) => {
    const steps: Step[] = [
      echo('go'), init,
      helperStarted('a1'), text('Launched.'), result(),
      helperCalls('a1', 'b1', 'Bash'), helperCommand('b1'),
      ...ended('a1', status),
      ...notificationTurn('The helper failed.'),
      ...ended('b1'),
      { waitEof: true },
    ];
    const turn = await run(steps, 5000);
    const { ended: endedAt, closed } = timing(turn.events, 'b1', turn.t0, turn.stamps);

    expect(turn.record.eofAt).toBe(linesBefore(steps, steps.length - 1));
    expect(closed - endedAt).toBeLessThan(1000);
  });

  it('is not waited for when it stopped with nothing of its own running', async () => {
    const steps: Step[] = [
      echo('go'), init,
      helperStarted('a1'), helperStarted('a2'), text('Launched two.'), result(),
      // a2's command, attributed to a2: it is not a1's work.
      helperCalls('a2', 'c2', 'Bash'), helperCommand('c2'),
      ...ended('a1'),
      ...notificationTurn('One helper is done.'),
      ...ended('c2'),
      ...ended('a2'),
      ...notificationTurn('Both are done.'),
      { waitEof: true },
    ];
    const turn = await run(steps, 5000);
    const { ended: endedAt, closed } = timing(turn.events, 'a2', turn.t0, turn.stamps);

    expect(turn.record.eofAt).toBe(linesBefore(steps, steps.length - 1));
    expect(closed - endedAt).toBeLessThan(1000);
  });

  it('is forwarded as waiting, then running on its resume, then completed when it really ends', async () => {
    const steps: Step[] = [
      echo('go'), init,
      helperStarted('a1'), text('Launched.'), result(),
      helperCalls('a1', 'b1', 'Bash'), helperCommand('b1'),
      ...ended('a1'),
      ...notificationTurn('The helper is waiting on its check.'),
      ...ended('b1'),
      { sleep: 200 },
      helperStarted('a1'), helperSays('a1', 'Check passed.'),
      ...ended('a1'),
      ...notificationTurn('The helper is done.'),
      { waitEof: true },
    ];
    const turn = await run(steps, 3000);
    const a1 = of(turn.events, 'task')
      .map((e) => e.data as { task_id: string; phase: string; status?: string })
      .filter((d) => d.task_id === 'a1')
      .map((d) => [d.phase, d.status]);

    expect(a1).toEqual([
      ['started', undefined],
      ['updated', 'waiting'], ['updated', 'waiting'],
      ['updated', 'running'],
      ['updated', 'completed'], ['finished', 'completed'],
    ]);
    const a1Events = of(turn.events, 'task').filter((e) => (e.data as { task_id?: string }).task_id === 'a1');
    for (const e of a1Events) expect(e.data).not.toHaveProperty('ended_waiting');
  });

  it('is forwarded as completed when the window passes without a resume', async () => {
    const steps: Step[] = [
      echo('go'), init,
      helperStarted('a1'), text('Launched.'), result(),
      helperCalls('a1', 'b1', 'Bash'), helperCommand('b1'),
      ...ended('a1'),
      ...notificationTurn('Waiting.'),
      ...ended('b1'),
      { waitEof: true },
    ];
    const turn = await run(steps, 300);
    const a1 = turn.events.filter((e) => e.event === 'task' && (e.data as { task_id?: string }).task_id === 'a1');
    const last = a1[a1.length - 1]!;

    expect(last.data).toMatchObject({ phase: 'updated', task_id: 'a1', tool_use_id: 'toolu_a1', task_type: 'local_agent', status: 'completed', ended_waiting: true });
    expect(turn.events.indexOf(last)).toBeLessThan(turn.events.findIndex((e) => e.event === 'input_closed'));
  });

  it('carries the last report it sent while waiting on that end', async () => {
    const steps: Step[] = [
      echo('go'), init,
      helperStarted('a1'), text('Launched.'), result(),
      helperCalls('a1', 'b1', 'Bash'), helperCommand('b1'),
      ...ended('a1'),
      ...notificationTurn('Waiting.'),
      ...ended('b1'),
      { waitEof: true },
    ];
    const turn = await run(steps, 300);
    const a1 = of(turn.events, 'task')
      .map((e) => e.data as { task_id: string; phase: string; status?: string; summary?: string })
      .filter((d) => d.task_id === 'a1')
      .map((d) => [d.phase, d.status, d.summary]);

    expect(a1).toEqual([
      ['started', undefined, undefined],
      ['updated', 'waiting', undefined], ['updated', 'waiting', 'a1'],
      ['updated', 'completed', 'a1'],
    ]);
  });

  it('carries no report on that end when it sent none', async () => {
    const steps: Step[] = [
      echo('go'), init,
      helperStarted('a1'), text('Launched.'), result(),
      helperCalls('a1', 'b1', 'Bash'), helperCommand('b1'),
      line({ type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'completed', end_time: 1 } }),
      line({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'toolu_a1', status: 'completed' }),
      ...notificationTurn('Waiting.'),
      ...ended('b1'),
      { waitEof: true },
    ];
    const turn = await run(steps, 300);
    const a1 = turn.events.filter((e) => e.event === 'task' && (e.data as { task_id?: string }).task_id === 'a1');
    const last = a1[a1.length - 1]!;

    expect(last.data).toMatchObject({ phase: 'updated', status: 'completed' });
    expect(last.data).not.toHaveProperty('summary');
  });
});
