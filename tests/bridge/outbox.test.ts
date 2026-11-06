/**
 * The bookkeeping behind reliable delivery (src/protocol/outbox.ts): numbers,
 * what is kept until a `stream_ack`, and the `session_lost` restart.
 */

import { describe, it, expect } from 'vitest';
import { StreamOutbox } from '../../src/protocol/outbox.js';

function push(box: StreamOutbox, id: string, event: string): number {
  const seq = box.allocate(id);
  box.keep(id, { seq, payload: JSON.stringify({ request_id: id, event, seq }), terminal: event === 'done' || event === 'error' });

  return seq;
}

describe('StreamOutbox', () => {
  it('numbers each turn from 1, separately', () => {
    const box = new StreamOutbox();
    expect(box.peek('a')).toBe(1);
    expect([push(box, 'a', 'block_start'), push(box, 'a', 'block_delta'), push(box, 'b', 'block_start'), push(box, 'a', 'done')])
      .toEqual([1, 2, 1, 3]);
  });

  it('keeps frames until an ack covers them, cumulatively', () => {
    const box = new StreamOutbox();
    for (const e of ['block_start', 'block_delta', 'block_delta', 'block_stop']) push(box, 'a', e);

    box.ack('a', 2);
    expect(box.pending('a').map((f) => f.seq)).toEqual([3, 4]);
    expect(box.lastAcked('a')).toBe(2);
    // An older ack (a re-sent duplicate's) changes nothing.
    box.ack('a', 1);
    expect(box.pending('a').map((f) => f.seq)).toEqual([3, 4]);
    expect(box.runningTurns()).toEqual([{ request_id: 'a', last_acked_seq: 2 }]);
    expect(box.hasUnconfirmed()).toBe(true);
  });

  it('lets go of a turn once its final frame is confirmed', () => {
    const box = new StreamOutbox();
    push(box, 'a', 'block_start');
    push(box, 'a', 'done');

    expect(box.ack('a', 1)).toEqual({ ended: false, known: true });
    expect(box.ack('a', 2)).toEqual({ ended: true, known: true });
    expect(box.pending('a')).toEqual([]);
    expect(box.runningTurns()).toEqual([]);
    expect(box.hasUnconfirmed()).toBe(false);
  });

  it('treats a confirmed error as the end, so a done after it is not kept forever', () => {
    // A refusal is error then done; the server ends the turn on the error and
    // confirms the done again with the error's seq.
    const box = new StreamOutbox();
    push(box, 'a', 'error');
    push(box, 'a', 'done');

    expect(box.ack('a', 1).ended).toBe(true);
    expect(box.pending('a')).toEqual([]);
    expect(box.keep('a', { seq: box.allocate('a'), payload: '{}', terminal: false })).toBe('ended');
  });

  it('ignores an ack for a turn it does not know', () => {
    expect(new StreamOutbox().ack('nope', 3)).toEqual({ ended: false, known: false });
  });

  it('restarts at 1 on a session_lost re-issue, and the old run\'s late ack does not trim the new run', () => {
    const box = new StreamOutbox();
    push(box, 'a', 'block_start');
    push(box, 'a', 'error'); // session_lost, seq 2, not yet confirmed

    // The re-issue arrives before the server's ack for the error frame.
    box.restart('a');
    expect(push(box, 'a', 'block_start')).toBe(1);
    expect(push(box, 'a', 'block_delta')).toBe(2);

    // The ack for the old error frame (seq 2): belongs to the old run.
    expect(box.ack('a', 2).ended).toBe(false);
    expect(box.pending('a').map((f) => f.seq)).toEqual([1, 2]);
    // The new run's own acks work as usual.
    box.ack('a', 1);
    expect(box.pending('a').map((f) => f.seq)).toEqual([2]);
  });

  it('refuses a frame past a per-turn bound, and frees room as acks come in', () => {
    const box = new StreamOutbox({ turnBytes: 1_000_000, turnFrames: 2, totalBytes: 1_000_000, totalFrames: 100 });
    const frame = (seq: number) => ({ seq, payload: 'x'.repeat(10), terminal: false });
    expect(box.keep('a', frame(box.allocate('a')))).toBe('kept');
    expect(box.keep('a', frame(box.allocate('a')))).toBe('kept');
    expect(box.keep('a', frame(box.allocate('a')))).toBe('full');
    // Another turn has its own allowance.
    expect(box.keep('b', frame(box.allocate('b')))).toBe('kept');
    box.ack('a', 1);
    expect(box.keep('a', frame(4))).toBe('kept');
  });

  it('refuses a frame past the byte bound across all turns, and frees it on forget', () => {
    const box = new StreamOutbox({ turnBytes: 100, turnFrames: 100, totalBytes: 150, totalFrames: 100 });
    const frame = (seq: number, bytes: number) => ({ seq, payload: 'x'.repeat(bytes), terminal: false });
    expect(box.keep('a', frame(box.allocate('a'), 101))).toBe('full'); // over the turn's bytes
    expect(box.keep('a', frame(box.allocate('a'), 80))).toBe('kept');
    expect(box.keep('b', frame(box.allocate('b'), 80))).toBe('full'); // over the total
    box.forget('a');
    expect(box.keep('b', frame(box.allocate('b'), 80))).toBe('kept');
  });

  it('never refuses a turn\'s final frame for a bound', () => {
    const box = new StreamOutbox({ turnBytes: 1_000_000, turnFrames: 1, totalBytes: 1_000_000, totalFrames: 1 });
    expect(box.keep('a', { seq: box.allocate('a'), payload: 'x', terminal: false })).toBe('kept');
    expect(box.keep('a', { seq: box.allocate('a'), payload: 'x', terminal: false })).toBe('full');
    expect(box.keep('a', { seq: box.allocate('a'), payload: 'x', terminal: true })).toBe('kept');
    expect(box.holdsFinal('a')).toBe(true);
  });

  it('says whether a turn\'s final frame is still unconfirmed', () => {
    const box = new StreamOutbox();
    push(box, 'a', 'block_delta');
    expect(box.holdsFinal('a')).toBe(false);
    push(box, 'a', 'done');
    expect(box.holdsFinal('a')).toBe(true);
    box.ack('a', 2);
    expect(box.holdsFinal('a')).toBe(false);
  });
});
