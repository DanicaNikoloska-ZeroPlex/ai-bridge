/**
 * Tool Resolver
 *
 * Handles the WebSocket round-trip for tool calls:
 *   1. The provider adapter invokes a tool
 *   2. The resolver sends a tool_call message to the server
 *   3. The resolver waits for a matching tool_resolve or tool_error
 *   4. The result (or error) is returned to the provider adapter
 *
 * Pending tool calls are tracked by tool_call_id and resolved via
 * the `resolve()` / `reject()` methods called by the Bridge when
 * it receives the server's response.
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('ToolResolver');

/** A pending tool call awaiting resolution from the server. */
interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Callback to send a tool_call message over the WebSocket. */
export type SendToolCallFn = (
  requestId: string,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
) => void;

export class ToolResolver {
  private pending = new Map<string, PendingToolCall>();
  private timeoutMs: number;

  constructor(timeoutMs: number = 300_000) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Update the timeout duration (e.g. from the server's request_timeout config).
   */
  setTimeoutMs(ms: number): void {
    this.timeoutMs = ms;
    log.debug('Tool resolver timeout updated', { timeoutMs: ms });
  }

  /** The configured wait, in ms. */
  timeoutMsValue(): number {
    return this.timeoutMs;
  }

  /**
   * Initiate a tool call and wait for the server's response.
   *
   * @param sendFn     Function to send the tool_call over WebSocket.
   * @param requestId  The parent AI request ID.
   * @param toolCallId Unique ID for this tool invocation.
   * @param toolName   Name of the tool being called.
   * @param args       Tool arguments.
   * @param timeoutMs  How long THIS call may wait, when the caller knows better
   *                   than the configured default — e.g. because the turn it
   *                   belongs to ends sooner. Defaults to the configured value.
   * @returns The tool result from the server.
   * @throws If the server returns a tool_error or the call times out.
   */
  call(
    sendFn: SendToolCallFn,
    requestId: string,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number = this.timeoutMs,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolCallId);
        const seconds = Math.round(timeoutMs / 1000);
        const minutes = Math.round(seconds / 60);
        // A wait bounded by the end of its turn can be well under a second, and
        // "timed out after 0s" reads as a bug rather than a decision.
        const humanDuration = timeoutMs < 1000
          ? `${timeoutMs}ms`
          : seconds >= 60 ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : `${seconds}s`;
        reject(new Error(`Tool call ${toolName} (${toolCallId}) timed out after ${humanDuration}`));
      }, timeoutMs);

      this.pending.set(toolCallId, {
        toolCallId,
        toolName,
        resolve,
        reject,
        timer,
      });

      log.debug('Sending tool call to server', { requestId, toolCallId, toolName });
      sendFn(requestId, toolCallId, toolName, args);
    });
  }

  /**
   * Resolve a pending tool call with a successful result.
   * Called by the Bridge when a `tool_resolve` message arrives.
   */
  resolve(toolCallId: string, result: unknown): boolean {
    const pending = this.pending.get(toolCallId);
    if (!pending) {
      log.warn('Received tool_resolve for unknown tool_call_id', { toolCallId });
      return false;
    }

    clearTimeout(pending.timer);
    this.pending.delete(toolCallId);
    log.debug('Tool call resolved', { toolCallId, toolName: pending.toolName });
    pending.resolve(result);
    return true;
  }

  /**
   * Reject a pending tool call with an error.
   * Called by the Bridge when a `tool_error` message arrives.
   */
  reject(toolCallId: string, error: string): boolean {
    const pending = this.pending.get(toolCallId);
    if (!pending) {
      log.warn('Received tool_error for unknown tool_call_id', { toolCallId });
      return false;
    }

    clearTimeout(pending.timer);
    this.pending.delete(toolCallId);
    log.debug('Tool call rejected', { toolCallId, toolName: pending.toolName, error });
    pending.reject(new Error(`Tool error (${pending.toolName}): ${error}`));
    return true;
  }

  /**
   * Cancel all pending tool calls (e.g., on disconnect), with `reason` as the
   * error each one fails with when given.
   */
  cancelAll(reason?: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason ?? 'Result unknown: this tool call was cancelled before its answer arrived. '
        + 'The tool may or may not have run: check its effect before repeating it.'));
    }
    const count = this.pending.size;
    this.pending.clear();
    if (count > 0) {
      log.info('Cancelled all pending tool calls', { count });
    }
  }

  /**
   * Returns the number of tool calls currently awaiting resolution.
   */
  pendingCount(): number {
    return this.pending.size;
  }
}
