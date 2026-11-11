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
 *
 * Bounded (see OutboxLimits): the server picks the grace period, up to an
 * hour, and a chatty turn kept that long would otherwise grow without limit.
 * A frame that would go over a bound is not kept, and the bridge stops that
 * turn and reports it as lost rather than let the process run out of memory.
 * A turn's final frame (`done` / `error`) is always kept: it is one frame
 * (at most 900 KB), and refusing it would turn a finished answer into a lost one.
 */

/** How much the outbox keeps before it refuses a frame. */
export interface OutboxLimits {
  /** Unconfirmed bytes one turn may hold. */
  turnBytes: number;
  /** Unconfirmed frames one turn may hold. */
  turnFrames: number;
  /** Unconfirmed bytes all turns together may hold. */
  totalBytes: number;
  /** Unconfirmed frames all turns together may hold. */
  totalFrames: number;
}

/**
 * Far above what a turn normally holds unconfirmed (the server acks as it
 * stores; one frame is at most 900 KB), small enough that a bridge on a
 * laptop keeps working when they are reached.
 */
export const DEFAULT_OUTBOX_LIMITS: OutboxLimits = {
  turnBytes: 32 * 1024 * 1024,
  turnFrames: 20_000,
  totalBytes: 128 * 1024 * 1024,
  totalFrames: 80_000,
};

/** What keep() did with a frame. */
export type KeepResult =
  /** Kept until a `stream_ack` covers it. */
  | 'kept'
  /** Not kept: the server has ended the turn (or already has this seq). */
  | 'ended'
  /** Not kept: it would go over a bound (never for a final frame). The turn must be stopped. */
  | 'full';

/** One numbered frame, already encoded exactly as it goes on the wire. */
export interface OutboxFrame {
  seq: number;
  payload: string;
  /** `done` or `error`: the server ends the turn (for this run) on it. */
  terminal: boolean;
}

const bytesOf = (frame: OutboxFrame): number => Buffer.byteLength(frame.payload, 'utf8');

interface TurnOutbox {
  /** The seq the next frame of this turn gets. */
  nextSeq: number;
  /** The highest seq the server confirmed. */
  acked: number;
  /** Written but not yet confirmed, in seq order. */
  frames: OutboxFrame[];
  /** The UTF-8 size of `frames`. */
  bytes: number;
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
  private totalBytes = 0;
  private totalFrames = 0;

  constructor(private readonly limits: OutboxLimits = DEFAULT_OUTBOX_LIMITS) {}

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
   * Keep a numbered frame until it is confirmed. Not kept when the server
   * has already ended the turn, because nothing would ever confirm it
   * (`ended`), or when it would take the turn or the whole outbox over a
   * bound (`full`). A final frame is never refused for a bound.
   */
  keep(requestId: string, frame: OutboxFrame): KeepResult {
    const turn = this.turnFor(requestId);
    if (turn.serverEnded || frame.seq <= turn.acked) return 'ended';
    const bytes = bytesOf(frame);
    if (!frame.terminal && (turn.frames.length + 1 > this.limits.turnFrames
      || turn.bytes + bytes > this.limits.turnBytes
      || this.totalFrames + 1 > this.limits.totalFrames
      || this.totalBytes + bytes > this.limits.totalBytes)) {
      return 'full';
    }
    turn.frames.push(frame);
    turn.bytes += bytes;
    this.totalFrames++;
    this.totalBytes += bytes;

    return 'kept';
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
      const frame = turn.frames.shift()!;
      this.release(turn, [frame]);
      if (frame.terminal) ended = true;
    }
    if (ended) {
      turn.serverEnded = true;
      this.release(turn, turn.frames);
      turn.frames = [];
    }

    return { ended, known: true };
  }

  /**
   * The server re-issued this request id (`session_lost`) without saying where
   * to go on (an older server, no `first_seq`): the new run numbers its frames
   * from 1 again (PROTOCOL.md allows 1 or the error frame's seq + 1). The old
   * run's frames are dropped: the server got its error frame, or it would not
   * have re-issued. See continueAt() for a server that sends `first_seq`.
   */
  restart(requestId: string): void {
    const old = this.turns.get(requestId);
    const lastFrame = old?.frames[old.frames.length - 1];
    if (old !== undefined) this.release(old, old.frames);
    this.turns.set(requestId, {
      nextSeq: 1,
      acked: 0,
      frames: [],
      bytes: 0,
      serverEnded: false,
      staleAck: lastFrame !== undefined && lastFrame.terminal ? lastFrame.seq : null,
    });
  }

  /**
   * The server re-issued this request id (`session_lost`) and said where the
   * new run's numbering goes on (`ai_request.first_seq`): everything before
   * it counts as confirmed (the server has the old run's error frame, or it
   * would not have re-issued), so the old run's frames are dropped and a late
   * ack of them changes nothing. Works whether or not the turn is still here
   * (its error frame's ack may have let go of it already).
   */
  continueAt(requestId: string, firstSeq: number): void {
    const old = this.turns.get(requestId);
    if (old !== undefined) this.release(old, old.frames);
    this.turns.set(requestId, {
      nextSeq: firstSeq,
      acked: firstSeq - 1,
      frames: [],
      bytes: 0,
      serverEnded: false,
      staleAck: null,
    });
  }

  /** The kept (unconfirmed) frames of a turn, in order. */
  pending(requestId: string): readonly OutboxFrame[] {
    return this.turns.get(requestId)?.frames ?? [];
  }

  /** Whether a turn's final frame (`done` / `error`) is among its unconfirmed ones. */
  holdsFinal(requestId: string): boolean {
    return this.pending(requestId).some((frame) => frame.terminal);
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
    const turn = this.turns.get(requestId);
    if (turn !== undefined) this.release(turn, turn.frames);
    this.turns.delete(requestId);
  }

  clear(): void {
    this.turns.clear();
    this.totalBytes = 0;
    this.totalFrames = 0;
  }

  get size(): number {
    return this.turns.size;
  }

  /** Take frames that leave a turn off the byte and frame counts. */
  private release(turn: TurnOutbox, frames: readonly OutboxFrame[]): void {
    for (const frame of frames) {
      const bytes = bytesOf(frame);
      turn.bytes -= bytes;
      this.totalBytes -= bytes;
      this.totalFrames--;
    }
  }

  private turnFor(requestId: string): TurnOutbox {
    let turn = this.turns.get(requestId);
    if (turn === undefined) {
      turn = { nextSeq: 1, acked: 0, frames: [], bytes: 0, serverEnded: false, staleAck: null };
      this.turns.set(requestId, turn);
    }

    return turn;
  }
}
