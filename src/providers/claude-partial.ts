/**
 * Claude partial-message stream mapping.
 *
 * With `--include-partial-messages`, the Claude CLI emits a `stream_event`
 * frame per raw Anthropic SSE event, so text arrives in chunks as the model
 * writes it instead of one lump per content block. This maps those frames onto
 * the bridge's existing block model — one `block_start`, many `block_delta`, one
 * `block_stop` — which is what PROTOCOL.md already describes and what every
 * consumer already handles. No protocol change; the deltas just get smaller.
 *
 * Shapes below were captured from Claude Code 2.1.261 rather than assumed, and
 * three of them are traps:
 *
 *  1. The `assistant` frame STILL ARRIVES for a message that was streamed — in
 *     the middle of it, between the last delta and `content_block_stop`.
 *     Handling both paths naively emits every block twice. See `wasStreamed()`.
 *
 *     Note that ONE message can produce SEVERAL such frames — the CLI sends one
 *     per content block, all carrying the same message id — so suppression is a
 *     set membership test, not a one-shot.
 *
 *  2. `content_block_start.index` RESTARTS AT 0 for each message in the turn.
 *     A turn that calls a tool has at least two messages, so the raw index is
 *     not usable as a bridge block index — two different blocks would collide
 *     on index 0 and a consumer keyed on it would splice them together. The
 *     mapper translates each CLI index to a monotonic bridge index.
 *
 *  3. Thinking blocks carry `signature_delta` alongside `thinking_delta`. The
 *     signature is an opaque crypto attestation, not prose, and forwarding it
 *     as content injects a wall of base64 into the user's view of the model's
 *     reasoning.
 */

import type { AdapterStreamEvent } from './base.js';
import { createLogger } from '../utils/logger.js';
import { boundArgumentText, boundArguments } from './result-text.js';

const log = createLogger('ClaudePartial');

/** Bridge block types that a partial stream can produce. */
type MappedBlockType = 'text' | 'thinking' | 'tool_call';

/** Read a string field, or undefined when it is absent or the wrong type. */
function str(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read a nested object field, or undefined. */
function obj(source: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = source?.[key];
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * Translates Claude's `stream_event` frames into bridge block events.
 *
 * Also owns the turn's block-index counter, because the whole-message path runs
 * alongside it in the same turn: sub-agent messages (the Task tool) are
 * delivered ONLY as whole `assistant` frames — the CLI emits no `stream_event`
 * for a sidechain — so both paths allocate from one counter to keep indices
 * unique across the turn.
 */
export class ClaudePartialStreamMapper {
  private nextBlockIndex = 0;

  /** CLI content-block index → bridge block index, for the message in flight. */
  private readonly bridgeIndex = new Map<number, number>();

  /** CLI content-block index → what kind of block it is. */
  private readonly blockType = new Map<number, MappedBlockType>();

  /**
   * Text and thinking blocks that have been announced but not yet opened.
   *
   * Their `block_start` is withheld until the first delta with actual content
   * arrives, because the whole-message path skips a block whose text is empty
   * (`if (!text) continue`) and the two paths have to agree. Interleaved
   * thinking really does come through empty — the tool-turn fixture contains a
   * thinking block that is nothing but a signature — so opening eagerly would
   * put a hollow reasoning block in front of the user on a real turn, and shift
   * every index after it.
   */
  private readonly pending = new Map<number, MappedBlockType>();

  /** Accumulated `input_json_delta` fragments, keyed by CLI index. */
  private readonly toolJson = new Map<number, string>();

  /** Message ids delivered as a partial stream, so the `assistant` twin is dropped. */
  private readonly streamedMessageIds = new Set<string>();

  /** Allocate the next bridge block index (used by the whole-message path too). */
  nextIndex(): number {
    return this.nextBlockIndex++;
  }

  /**
   * Was this message already delivered as a partial stream?
   *
   * Keyed on the Anthropic message id, which `message_start` and the
   * `assistant` frame carry identically — verified against 2.1.261. A coarser
   * rule ("partial mode is on, so drop every assistant frame") would silently
   * discard sub-agent output, which has an id that never appears in any
   * `message_start` precisely because sidechains are not streamed.
   */
  wasStreamed(messageId: string | undefined): boolean {
    return messageId !== undefined && this.streamedMessageIds.has(messageId);
  }

  /** Is a block currently open — announced with block_start, not yet stopped? */
  hasOpenBlock(): boolean {
    return this.bridgeIndex.size > 0;
  }

  /**
   * Close every block still open, for a turn that ended without closing them.
   *
   * A cancelled turn, a request timeout, or a CLI crash abandons whatever was
   * mid-stream. Before partial streaming the Claude adapter could not produce
   * an unclosed block — start, delta and stop were emitted together per
   * assistant frame — so this is a failure mode the change introduces, and one
   * the Gemini adapter already guards against the same way.
   *
   * A truncated TOOL block matters most: its arguments are buffered until
   * block_stop, so without this flush a consumer sees an announced tool call
   * with no arguments at all — indistinguishable from a tool deliberately
   * called with none.
   */
  closeOpenBlocks(emit: (event: AdapterStreamEvent) => void): void {
    // In bridge-index order, so a consumer sees them close in the order it saw
    // them open.
    const open = [...this.bridgeIndex.entries()].sort((a, b) => a[1] - b[1]);
    for (const [cliIndex] of open) this.closeBlock(cliIndex, emit);

    // Blocks still pending never emitted a block_start, so there is nothing to
    // close for them — but they must not survive into anything that follows.
    this.pending.clear();
  }

  /** Emit the closing events for one open block, and forget it. */
  private closeBlock(cliIndex: number, emit: (event: AdapterStreamEvent) => void): void {
    this.pending.delete(cliIndex);

    const index = this.bridgeIndex.get(cliIndex);
    if (index === undefined) return;

    if (this.blockType.get(cliIndex) === 'tool_call') {
      emit({
        event: 'block_delta',
        data: { block_index: index, content: normaliseToolArguments(this.toolJson.get(cliIndex)) },
      });
    }
    emit({ event: 'block_stop', data: { block_index: index } });

    this.bridgeIndex.delete(cliIndex);
    this.blockType.delete(cliIndex);
    this.toolJson.delete(cliIndex);
  }

  /** Handle one `stream_event` frame, emitting whatever bridge events it maps to. */
  handle(frame: Record<string, unknown>, emit: (event: AdapterStreamEvent) => void): void {
    const event = obj(frame, 'event');
    if (!event) return;

    // Sub-agent frames are not streamed by the CLI today (verified against
    // 2.1.261: sidechain messages arrive only as whole `assistant` frames), and
    // if a future version starts streaming them this mapper must not try to
    // interleave two streams. Both restart `index` at 0, so a sub-agent's
    // `message_start` landing mid-message would wipe the main agent's live
    // mapping and route its remaining deltas into the wrong block.
    //
    // Skipping them loses nothing: the `assistant` twin still arrives, its id
    // was never recorded as streamed, and the whole-message path emits it —
    // with the frame's `parent_tool_use_id` on every block, so the helper's
    // work still reaches a consumer attributed to the call that spawned it.
    // Keep this guard; that attribution does not make it removable.
    //
    // Skipped here, NOT ignored: the adapter resets the silence clock for every
    // such frame before handing it in, so a helper streaming a long answer is
    // never mistaken for a silent turn while its whole message is still to come.
    if (frame['parent_tool_use_id'] != null) {
      log.debug('Ignoring a streamed sub-agent frame — delivered whole instead');
      return;
    }

    switch (str(event, 'type')) {
      case 'message_start':
        return this.onMessageStart(event, emit);
      case 'content_block_start':
        return this.onBlockStart(event, emit);
      case 'content_block_delta':
        return this.onBlockDelta(event, emit);
      case 'content_block_stop':
        return this.onBlockStop(event, emit);
      default:
        // message_delta / message_stop / ping carry nothing the block model
        // needs; `result` still drives the turn's terminal event.
        return;
    }
  }

  private onMessageStart(event: Record<string, unknown>, emit: (e: AdapterStreamEvent) => void): void {
    const id = str(obj(event, 'message'), 'id');
    if (id !== undefined) this.streamedMessageIds.add(id);

    // CLOSE the previous message's blocks rather than merely forgetting them.
    //
    // A message that ended without `content_block_stop` — a mid-stream error
    // the CLI retried past, a compaction boundary — would otherwise leave an
    // announced block orphaned with its state already discarded, so nothing
    // downstream could close it and closeOpenBlocks() would have nothing left
    // to repair. That is the same defect as an abandoned turn, reached through
    // a message boundary instead of the end of the turn, and it takes a
    // buffered tool call's arguments with it.
    //
    // It also keeps hasOpenBlock() honest: reporting "nothing open" while a
    // block really is open would let the adapter flush deferred whole-message
    // events straight into it, producing exactly the overlap the deferral
    // queue exists to prevent.
    //
    // Per-message state only: the CLI reuses indices from 0 for each message,
    // so anything keyed on a CLI index must not outlive the message.
    // closeOpenBlocks() clears all of it.
    this.closeOpenBlocks(emit);
  }

  private onBlockStart(event: Record<string, unknown>, emit: (e: AdapterStreamEvent) => void): void {
    const cliIndex = event['index'];
    if (typeof cliIndex !== 'number') return;

    // A second content_block_start for an index already in use would otherwise
    // strand the first block: open() OVERWRITES the mapping, so the earlier
    // block's entry is lost, it is never stopped, and closeOpenBlocks() can no
    // longer find it. Close it properly first. Malformed output only — 2.1.261
    // does not do this — but it defeats the very safety nets around it.
    if (this.bridgeIndex.has(cliIndex) || this.pending.has(cliIndex)) {
      log.debug('content_block_start reused an open index — closing the previous block', { cliIndex });
      this.closeBlock(cliIndex, emit);
    }

    const block = obj(event, 'content_block');
    const rawType = str(block, 'type');

    let type: MappedBlockType;
    if (rawType === 'text') {
      type = 'text';
    } else if (rawType === 'thinking') {
      type = 'thinking';
    } else if (rawType === 'tool_use') {
      type = 'tool_call';
    } else {
      // redacted_thinking and any future block type: no index is allocated, so
      // its deltas and its stop find no mapping and are dropped too. Matches
      // what the whole-message path does with a type it does not know.
      log.debug('Ignoring unmapped content block type', { blockType: rawType });
      return;
    }

    if (type === 'tool_call') {
      const toolName = str(block, 'name');
      const toolId = str(block, 'id');
      if (toolName === undefined || toolId === undefined) {
        // Same guard as the whole-message path: a tool block with no identity
        // is not something a consumer can pair a result to.
        return;
      }
      // Opened eagerly: a tool block always produces its arguments delta at
      // stop, so there is no empty case to wait for.
      const index = this.nextIndex();
      this.bridgeIndex.set(cliIndex, index);
      this.blockType.set(cliIndex, type);
      this.toolJson.set(cliIndex, '');
      emit({
        event: 'block_start',
        data: { block_index: index, block_type: 'tool_call', tool_name: toolName, tool_call_id: toolId },
      });
      return;
    }

    this.pending.set(cliIndex, type);
  }

  /**
   * Open a withheld text/thinking block, allocating its index now.
   *
   * Allocating here rather than at `content_block_start` is what keeps indices
   * matching the whole-message path: a block that turns out to be empty
   * consumes no index, so the block after it is numbered the same either way.
   */
  private open(cliIndex: number, emit: (e: AdapterStreamEvent) => void): number | undefined {
    const type = this.pending.get(cliIndex);
    if (type === undefined) return this.bridgeIndex.get(cliIndex);

    this.pending.delete(cliIndex);
    const index = this.nextIndex();
    this.bridgeIndex.set(cliIndex, index);
    this.blockType.set(cliIndex, type);
    emit({ event: 'block_start', data: { block_index: index, block_type: type } });
    return index;
  }

  private onBlockDelta(event: Record<string, unknown>, emit: (e: AdapterStreamEvent) => void): void {
    const cliIndex = event['index'];
    if (typeof cliIndex !== 'number') return;

    const delta = obj(event, 'delta');
    const deltaType = str(delta, 'type');

    if (deltaType === 'input_json_delta') {
      if (!this.toolJson.has(cliIndex)) return;
      // BUFFERED, not forwarded. Tool arguments are the one place the handover
      // flagged that a downstream consumer could break, and streaming them
      // buys nothing a person can see — arguments are rendered as a unit, not
      // read as they are typed. Emitting one delta at block_stop keeps the
      // tool_call wire shape byte-identical to the whole-message path.
      const fragment = str(delta, 'partial_json');
      if (fragment !== undefined) this.toolJson.set(cliIndex, (this.toolJson.get(cliIndex) ?? '') + fragment);
      return;
    }

    // `signature_delta` deliberately falls through to nothing: it is the
    // thinking block's crypto attestation, not part of the reasoning text.
    const content = deltaType === 'text_delta'
      ? str(delta, 'text')
      : deltaType === 'thinking_delta'
        ? str(delta, 'thinking')
        : undefined;

    if (content === undefined || content === '') return;

    // Only now is the block known to be non-empty, so this is where it opens.
    const index = this.open(cliIndex, emit);
    if (index === undefined) return;

    emit({ event: 'block_delta', data: { block_index: index, content } });
  }

  private onBlockStop(event: Record<string, unknown>, emit: (e: AdapterStreamEvent) => void): void {
    const cliIndex = event['index'];
    if (typeof cliIndex !== 'number') return;

    // A block that was announced and never produced content is dropped whole,
    // exactly as the whole-message path drops one whose text is empty —
    // closeBlock() forgets a pending entry without emitting anything for it.
    this.closeBlock(cliIndex, emit);
  }
}

/**
 * Turn accumulated `input_json_delta` fragments into the exact string the
 * whole-message path would have sent — `JSON.stringify(input ?? {})`.
 *
 * Re-encoding rather than forwarding the concatenation is what makes the two
 * paths interchangeable. A tool called with no arguments streams either zero
 * fragments or a single empty one, so the raw buffer is `""` — not valid JSON,
 * and `JSON.parse` on the far side throws on a turn that looked fine here.
 * Whitespace from the model's own encoding is normalised away for the same
 * reason: so a recorded turn does not differ by which path produced it.
 */
export function normaliseToolArguments(buffered: string | undefined): string {
  const raw = (buffered ?? '').trim();
  if (raw === '') return '{}';

  try {
    // Bounded by STRUCTURE: a Write call's arguments are a whole file, and an
    // oversized frame tears down the connection rather than being dropped.
    // Truncating the encoded text instead would make it stop parsing, and a
    // consumer would then lose every argument including the small ones that
    // matter most.
    return boundArguments(JSON.parse(raw));
  } catch {
    // Truncated or malformed JSON — the CLI died mid-block, or the shape
    // changed. Forward it verbatim rather than inventing `{}`: a consumer that
    // fails to parse this can say so, where a silently empty argument object
    // would look like a tool deliberately called with no arguments.
    log.warn('Tool arguments did not parse as JSON — forwarding verbatim', { length: raw.length });

    // The ARGUMENT ceiling, not the result one. Bounding this at 256KB while
    // the consumer caps arguments at 64KB is the same mismatch the frame paths
    // were fixed for: rendered in full live, truncated on reload, and the two
    // reporting sizes that differ by 4x.
    return boundArgumentText(raw);
  }
}
