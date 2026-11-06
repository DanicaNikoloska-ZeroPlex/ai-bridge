/**
 * Reliable delivery of a turn's stream frames (PROTOCOL.md, "Short drops").
 *
 * Against a server that announces it (`welcome.config.reconnect_grace_seconds`),
 * every `stream` frame of a turn carries `seq`, from 1 per request id, and is
 * kept here until the server's cumulative `stream_ack` covers it. A frame
 * written while the connection is down simply waits; after a reconnect the
 * bridge lists its turns in `hello.running_turns` and, once welcomed, writes
 * every kept frame again in order. The server stores a frame only when its seq
 * is exactly one more than the last it stored, so writing one twice is safe.
 *
 * Pure bookkeeping: no socket, no timers. The bridge decides when to write.
 */

/** One numbered frame, already encoded exactly as it goes on the wire. */
export interface OutboxFrame {
  seq: number;
  payload: string;
  /** `done` or `error`: the server ends the turn (for this run) on it. */
  terminal: boolean;
}

interface TurnOutbox {
  /** The seq the next frame of this turn gets. */
  nextSeq: number;
  /** The highest seq the server confirmed. */
  acked: number;
  /** Written but not yet confirmed, in seq order. */
  frames: OutboxFrame[];
  /**
   * The server confirmed a `done` or `error` of this turn: it has ended the
   * turn, so later frames are still numbered and written but not kept.
   */
  serverEnded: boolean;
  /**
   * A `session_lost` re-issue started numbering from 1 again before the
   * server's ack for the old run's error frame arrived. That ack (this seq)
   * belongs to the old run and must not trim the new one's frames.
   */
  staleAck: number | null;
}

/** What `hello.running_turns` lists for one turn. */
export interface RunningTurn {
  request_id: string;
  last_acked_seq: number;
}

export class StreamOutbox {
  private readonly turns = new Map<string, TurnOutbox>();

  /**
   * A turn started: listed in `running_turns` from now on, even before its
   * first frame, so a drop before it says anything does not lose it.
   */
  open(requestId: string): void {
    this.turnFor(requestId);
  }

  /** The seq the next frame of a turn will get, without taking it. */
  peek(requestId: string): number {
    return this.turns.get(requestId)?.nextSeq ?? 1;
  }

  /** Give the next frame of a turn its seq (1 for the first). */
  allocate(requestId: string): number {
    const turn = this.turnFor(requestId);

    return turn.nextSeq++;
  }

  /**
   * Keep a numbered frame until it is confirmed. Returns false when the
   * server has already ended the turn: the frame is not kept, because nothing
   * would ever confirm it.
   */
  keep(requestId: string, frame: OutboxFrame): boolean {
    const turn = this.turnFor(requestId);
    if (turn.serverEnded || frame.seq <= turn.acked) return false;
    turn.frames.push(frame);

    return true;
  }

  /**
   * A `stream_ack`: everything up to `seq` arrived. Returns whether the turn
   * is now ended on the server (a confirmed `done` / `error`), in which case
   * nothing of it is kept any more.
   */
  ack(requestId: string, seq: number): { ended: boolean; known: boolean } {
    const turn = this.turns.get(requestId);
    if (turn === undefined) return { ended: false, known: false };

    if (turn.staleAck !== null) {
      const stale = turn.staleAck;
      turn.staleAck = null;
      // The re-issued run's own acks only come after the server has seen its
      // frames, which is after it confirmed the old run's final frame.
      if (seq === stale) return { ended: turn.serverEnded, known: true };
    }

    if (seq > turn.acked) turn.acked = seq;
    let ended = turn.serverEnded;
    while (turn.frames.length > 0 && turn.frames[0]!.seq <= turn.acked) {
      if (turn.frames.shift()!.terminal) ended = true;
    }
    if (ended) {
      turn.serverEnded = true;
      turn.frames = [];
    }

    return { ended, known: true };
  }

  /**
   * The server re-issued this request id (`session_lost`): the new run numbers
   * its frames from 1 again (PROTOCOL.md allows 1 or the error frame's seq + 1;
   * this bridge restarts). The old run's frames are dropped: the server got
   * its error frame, or it would not have re-issued.
   */
  restart(requestId: string): void {
    const old = this.turns.get(requestId);
    const lastFrame = old?.frames[old.frames.length - 1];
    this.turns.set(requestId, {
      nextSeq: 1,
      acked: 0,
      frames: [],
      serverEnded: false,
      staleAck: lastFrame !== undefined && lastFrame.terminal ? lastFrame.seq : null,
    });
  }

  /** The kept (unconfirmed) frames of a turn, in order. */
  pending(requestId: string): readonly OutboxFrame[] {
    return this.turns.get(requestId)?.frames ?? [];
  }

  /** Whether a turn has numbered frames (kept, or still to come). */
  has(requestId: string): boolean {
    return this.turns.has(requestId);
  }

  /** Whether the server has ended this turn (see `serverEnded`). */
  serverEnded(requestId: string): boolean {
    return this.turns.get(requestId)?.serverEnded ?? false;
  }

  /** The highest seq the server confirmed for a turn, 0 when none. */
  lastAcked(requestId: string): number {
    return this.turns.get(requestId)?.acked ?? 0;
  }

  /** The turns the server should keep, for `hello.running_turns`. */
  runningTurns(): RunningTurn[] {
    const out: RunningTurn[] = [];
    for (const [requestId, turn] of this.turns) {
      if (!turn.serverEnded) out.push({ request_id: requestId, last_acked_seq: turn.acked });
    }

    return out;
  }

  /** Every request id with state here. */
  requestIds(): string[] {
    return [...this.turns.keys()];
  }

  /** Whether any frame is still waiting for its confirmation. */
  hasUnconfirmed(): boolean {
    for (const turn of this.turns.values()) if (turn.frames.length > 0) return true;

    return false;
  }

  forget(requestId: string): void {
    this.turns.delete(requestId);
  }

  clear(): void {
    this.turns.clear();
  }

  get size(): number {
    return this.turns.size;
  }

  private turnFor(requestId: string): TurnOutbox {
    let turn = this.turns.get(requestId);
    if (turn === undefined) {
      turn = { nextSeq: 1, acked: 0, frames: [], serverEnded: false, staleAck: null };
      this.turns.set(requestId, turn);
    }

    return turn;
  }
}
