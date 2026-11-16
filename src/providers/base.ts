/**
 * Abstract base class for AI CLI provider adapters.
 *
 * Each adapter wraps a specific CLI tool (Codex, Claude, Gemini) and
 * normalizes its output into the Bridge protocol's stream event format.
 */

import { ChildProcess, ChildProcessByStdio, spawn } from 'node:child_process';
import { Interface as ReadlineInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type {
  ModelInfo,
  AiRequestMessage,
  CliIsolation,
  ToolDefinition,
  StreamEventType,
  StreamEventData,
} from '../protocol/types.js';
import type { McpConnection } from '../mcp/cli-config.js';
import type { TurnInputPort } from './turn-input.js';
import { formatStderrMessage, getBridgeWorkingDir } from './env.js';

/** A stream event emitted by the adapter. */
export interface AdapterStreamEvent {
  event: StreamEventType;
  data: StreamEventData;
}

/** Context passed to a provider when executing a request. */
export interface ExecutionContext {
  /** The full AI request from the server. */
  request: AiRequestMessage;
  /** The request ID for correlation with tool calls, stream events, and concurrent-request correlation (set by bridge). */
  requestId: string;
  /** Tool definitions that should be made available to the CLI. */
  tools: ToolDefinition[];
  /**
   * Connection details for the bridge's local MCP server, when one is
   * running. `null` when no tools are registered — adapters skip MCP wiring
   * in that case and pass no MCP config to the CLI.
   */
  mcp: McpConnection | null;
  /**
   * Server-supplied CLI isolation posture. `isolated` (default) keeps the
   * spawned CLI cut off from local influence — no built-in shell/edit, no
   * user-level CLAUDE.md / skills / hooks.
   * `native` re-enables the legacy posture as an operator opt-in.
   */
  cliIsolation: CliIsolation;
  /**
   * The directory the CLI is spawned in, and the one adapters that write
   * config into cwd (Gemini) must use.
   *
   * Resolved once per request by the bridge: the empty scratch directory when
   * the server named nothing, or the checkout it named when the operator
   * allowed it. Adapters pass it straight to spawnCli() and never call
   * getBridgeWorkingDir() themselves — a second source for this value is how
   * the CLI ends up running somewhere other than where the settings file was
   * written.
   */
  workingDir: string;
  /** Abort signal for cancellation. */
  signal: AbortSignal;
  /** Maximum seconds the request may run before being aborted (server-configured). */
  requestTimeoutSeconds: number;
  /** Seconds of silence after which the CLI is presumed wedged. 0 disables. */
  silenceTimeoutSeconds: number;
  /** CLI session ID if resuming, or null for new session. */
  cliSessionId: string | null;
  /**
   * The directory this turn's attachments were written to, or null.
   *
   * The PATH, not a boolean, because adapters that restrict the tool surface
   * need to grant read access to exactly this directory and nowhere else.
   * Telling a model "the user attached a file, read it at this path" while its
   * file-reading tool is denied produces a turn that fails for a reason
   * nothing reports — and granting it the file-reading tool outright grants
   * the whole filesystem, which is a great deal worse.
   */
  attachmentDir: string | null;
  /**
   * Environment entries this turn's CLI is spawned with, over the bridge's
   * inherited environment. `null` values unset a key — see buildSpawnEnv().
   *
   * Resolved once per request by the bridge (defaults, then the server's
   * allow-listed overrides), so every adapter spawns with the same answer and
   * the acknowledgement the server already received stays true.
   */
  bridgeEnv: Record<string, string | null>;
  /**
   * The bridge's own addendum to the system prompt, or null when the server
   * took the lifecycle on itself with `off`.
   *
   * Carried separately from `request.system_prompt` because the two have
   * different owners and different lifetimes: the server owns the voice, the
   * bridge owns the fact that a turn is a process. Adapters with a dedicated
   * append flag pass it there; the rest concatenate it.
   */
  bridgeAddendum: string | null;
  /**
   * The same section worded for a subagent (helper) of this turn, or null /
   * absent for none. Only Claude can take it: it is appended to every
   * subagent's prompt, after the server's `subagent_prompt`, because a
   * subagent never sees the main system prompt. See buildHelperAddendum().
   */
  bridgeHelperAddendum?: string | null;
  /**
   * Whether this turn may use Claude Code's built-in WebSearch tool: an
   * `isolated` turn whose request asked with `options.web_search: true`, on a
   * bridge started with `--allow-web-search`. Resolved once by the bridge (resolveWebSearch);
   * absent means no. Only the Claude adapter reads it, and only in `isolated`,
   * where it adds exactly `WebSearch` to the allowed tools (decision 0016).
   */
  webSearch?: boolean;
  /**
   * Present when this turn runs with its input open (`options.accepts_input`,
   * confirmed by the ack's `input_open`). The adapter keeps the CLI's stdin
   * open, opens the port once the CLI has started its session, and ends it
   * when it closes stdin. Absent or null: the turn runs exactly as it always did.
   */
  turnInput?: TurnInputPort | null;
}

/** How spawnCli() treats the child's stdin. */
export interface SpawnOptions {
  /**
   * Write `stdinInput` and leave stdin OPEN, returning the writable. Only for
   * a CLI told to read a stream of messages there (Claude's
   * `--input-format stream-json`): every CLI in its default mode hangs on a
   * live stdin pipe.
   */
  keepStdinOpen?: boolean;
}

/**
 * Shared subprocess finalization helper.
 *
 * Manages the race between the readline 'close' event and the child process
 * 'close' event — the 'done' event must not be sent until both have fired.
 *
 * Returns an object containing:
 *   - `onRlClose`    — call from rl.on('close')
 *   - `onChildClose` — call from child.on('close', code)
 *
 * @param providerName   Provider name used in error messages.
 * @param terminalEvent  Name of the expected terminal output event
 *                       (e.g. 'result', 'turn.completed') for logging.
 * @param getSettled     Returns the current settled flag (read-only).
 * @param setSettled     Sets the settled flag to true.
 * @param getSessionId   Returns the current session ID (may be null).
 * @param getStderr      Returns the current stderr buffer.
 * @param onEvent        Adapter's onEvent callback.
 * @param resolve        Promise resolve function.
 * @param signal         AbortSignal (for listener cleanup).
 * @param onAbort        Abort listener to remove on finalization.
 * @param onBeforeFinalize  Optional callback for provider-specific pre-finalize
 *                          work (e.g. closing an open text block in Gemini).
 */
export function createFinalizer(opts: {
  providerName: string;
  terminalEvent: string;
  getSettled: () => boolean;
  setSettled: () => void;
  getSessionId: () => string | null;
  getStderr: () => string;
  onEvent: (event: AdapterStreamEvent) => void;
  resolve: (sessionId: string | null) => void;
  signal: AbortSignal;
  onAbort: () => void;
  onBeforeFinalize?: () => void;
  /** Why the CLI was killed on purpose, if it was. */
  getTimeout?: () => { reason: string; limitSeconds: number } | null;
  /**
   * Last chance to end the turn properly when the CLI exited cleanly without
   * one of our terminal events.
   *
   * Returns true if it emitted `done` itself, in which case nothing else is
   * reported. An adapter that holds a terminal frame back — because it could
   * not yet tell whether that frame ended OUR prompt or some queued work of
   * the CLI's own — uses this to settle from the frame it kept rather than
   * telling the server the turn produced nothing.
   */
  recoverTerminal?: () => boolean;
  /**
   * For a turn that no terminal frame ends — the process exiting is the end —
   * settle it from what the CLI reported, BEFORE the exit code is judged.
   *
   * Returns true if it emitted the terminal events itself. Consulted after a
   * timeout and a cancel (those are ours, and say so) and ahead of the
   * non-zero-exit branch, because such a CLI exits non-zero exactly when it
   * has something to say: Claude Code exits 1 after writing an error `result`
   * (checked on 2.1.283). Judged by the exit code first, that result — a lost
   * session the server would silently recover from, a max-turns or overload
   * with the usage it spent — was reported as a bare `provider_error` and an
   * empty `done`.
   */
  settleFromExit?: (exitCode: number | null) => boolean;
  /**
   * The `done` data for a turn ended by a bound, a cancel or a crash, which
   * otherwise carries `{}`. For an adapter that has already been told what the
   * turn spent — an input-open turn has results in hand long before its
   * process ends — so a stopped turn still reports its usage.
   */
  doneDataOnStop?: () => Record<string, unknown>;
}): { onRlClose: () => void; onChildClose: (code: number | null) => void } {
  let rlClosed = false;
  let childExitCode: number | null = null;
  let childExited = false;

  const stopData = (): Record<string, unknown> => opts.doneDataOnStop?.() ?? {};

  const tryFinalize = () => {
    if (!rlClosed || !childExited) return;
    // Read BEFORE the listener goes, and kept: `aborted` stays true on the
    // signal, but reading it here keeps the decision next to the rest.
    const aborted = opts.signal.aborted;
    opts.signal.removeEventListener('abort', opts.onAbort);

    if (opts.getSettled()) {
      opts.resolve(opts.getSessionId());
      return;
    }
    opts.setSettled();

    // Provider-specific pre-finalize work (e.g. close an open text block)
    opts.onBeforeFinalize?.();

    const timedOut = opts.getTimeout?.() ?? null;
    if (timedOut !== null) {
      // We killed it, so say that rather than describing the signal. "claude
      // CLI exited with code 143" is true and unhelpful: 143 is SIGTERM, which
      // names the mechanism and not the decision, and a consumer cannot render
      // "stopped after 15 minutes" from a signal number.
      opts.onEvent({
        event: 'error',
        data: {
          code: timedOut.reason,
          message: timedOut.reason === 'silence_timeout_exceeded'
            ? `The ${opts.providerName} CLI produced nothing for ${timedOut.limitSeconds}s and was stopped.`
            : `The ${opts.providerName} CLI ran past the ${timedOut.limitSeconds}s limit and was stopped.`,
          limit_seconds: timedOut.limitSeconds,
        },
      });
      opts.onEvent({ event: 'done', data: stopData() });
    } else if (aborted) {
      // AHEAD OF `recoverTerminal` ON PURPOSE, and not only for tidiness. A
      // cancel that lands when the only result so far belonged to the CLI's own
      // queued work would otherwise fall through to the recovery below and
      // report a `done` built from THAT — zero turns, zero cost — which is the
      // "empty reply" this release exists to remove, arriving by a different
      // road. Reordering these two silently brings it back.
      //
      // Somebody stopped this turn on purpose, so it is not a fault and must
      // not read as one. The CLI is asked to stop with SIGINT and commonly
      // exits non-zero when that lands mid-tool — measured against a real
      // Claude: a turn cancelled three seconds in ended with
      // "claude CLI exited with code 143" alongside the answer it had written.
      // A person who pressed stop then sees an error they caused and cannot
      // act on. What the turn produced has already been sent; this ends it.
      opts.onEvent({ event: 'done', data: stopData() });
    } else if (opts.settleFromExit?.(childExitCode) === true) {
      // Settled from the CLI's own report; see settleFromExit.
    } else if (childExitCode !== 0 && childExitCode !== null) {
      opts.onEvent({
        event: 'error',
        data: {
          code: 'provider_error',
          message: formatStderrMessage(opts.providerName, opts.getStderr(), childExitCode),
        },
      });
      opts.onEvent({ event: 'done', data: stopData() });
    } else if (opts.recoverTerminal?.() !== true) {
      // Clean exit but no terminal event — emit a non-fatal error.
      opts.onEvent({
        event: 'error',
        data: {
          code: 'provider_empty_response',
          message: 'The AI returned no response. Please try again.',
        },
      });
      opts.onEvent({ event: 'done', data: {} });
    }

    opts.resolve(opts.getSessionId());
  };

  return {
    onRlClose: () => {
      rlClosed = true;
      tryFinalize();
    },
    onChildClose: (code: number | null) => {
      childExitCode = code;
      childExited = true;
      tryFinalize();
    },
  };
}

// Re-export child_process types needed by adapters that use createFinalizer
export type { ChildProcess, ReadlineInterface };

export abstract class ProviderAdapter {
  /** Provider name / identifier (e.g. "codex", "claude", "gemini"). */
  abstract readonly providerName: string;

  /**
   * Whether this adapter can hold ONE turn to the server's tools only when the
   * server narrows it with `ai_request.cli_isolation: "isolated"`: no shell, no
   * file tools, no web, nothing but the bridge MCP namespace. Only an adapter
   * whose `isolated` launch is measured to deny every built-in tool says yes
   * (Claude: --allowedTools mcp__bridge__* with --permission-mode manual). The
   * bridge refuses such a turn on any other provider rather than running it
   * with whatever its `isolated` happens to leave open: Codex's read-only
   * sandbox still has a shell, and Gemini has no lever at all.
   */
  readonly enforcesServerToolsOnly: boolean = false;

  /**
   * Execute an AI request by invoking the local CLI.
   *
   * The adapter should call `onEvent` for each streaming chunk produced
   * by the CLI, normalizing the output into stream event format.
   *
   * Must send a final `done` event when the CLI exits.
   * Returns the CLI session ID for future resumption (or null).
   *
   * @param context  Execution context with request, tools, and tool resolution callback.
   * @param onEvent  Callback for each normalized stream event.
   * @returns The CLI session ID (for session resume) or null.
   */
  abstract execute(
    context: ExecutionContext,
    onEvent: (event: AdapterStreamEvent) => void,
  ): Promise<string | null>;

  /**
   * List available models for this provider.
   *
   * Returns model info from local CLI config/cache where possible,
   * or known model aliases as a fallback.
   */
  abstract listModels(): Promise<ModelInfo[]>;

  /**
   * Spawn a provider CLI subprocess with the bridge's standard launch options.
   *
   * Centralizes the two settings every adapter must get right:
   *   - `cwd` defaults to a dedicated empty directory so the CLI cannot
   *     auto-load CLAUDE.md / AGENTS.md / GEMINI.md from the bridge's own
   *     working tree (see getBridgeWorkingDir()). Adapters pass
   *     `context.workingDir`, which IS that directory unless the server named
   *     one and the operator allowed it — see src/workspace/resolve.ts. The
   *     default stays here so a future adapter that forgets to pass it gets
   *     the safe directory rather than the bridge's own cwd.
   *   - `stdio` keeps stdin closed by default — every CLI hangs if stdin is a
   *     live pipe — unless `stdinInput` is given, in which case stdin is piped,
   *     the input written, and the pipe immediately closed (or, with
   *     `keepStdinOpen`, left open for the adapter to write more and close).
   *     stdout/stderr stay piped for streaming.
   *   - The CLI is spawned `detached` (outside Windows), so it leads its own
   *     process group and stopTurn() can signal the group — everything the CLI
   *     started in it goes with the turn.
   *
   * The caller still builds its own `env` (provider-specific quirks like
   * Claude's CLAUDECODE deletion or Codex's conditional PATH belong with the
   * adapter), but routing every spawn through here means no adapter can
   * forget the cwd sandbox.
   *
   * @param command  CLI binary name (e.g. "claude").
   * @param args     CLI arguments.
   * @param env      Fully-built environment for the child process.
   * @param stdinInput  Prompt to write to stdin, when the CLI reads it there.
   * @param cwd      Directory to spawn in. Defaults to the empty scratch dir.
   * @param options  See SpawnOptions.
   * @returns The spawned ChildProcess.
   */
  protected spawnCli(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    stdinInput?: string,
    cwd?: string,
    options: SpawnOptions = {},
  ): ChildProcessByStdio<Writable | null, Readable, Readable> {
    // stdin defaults to 'ignore' (null) — a live stdin pipe hangs most CLIs.
    // When stdinInput is given we pipe it, write it, and immediately end() so
    // the child receives its prompt via stdin without ever blocking. This is
    // how Claude is fed: a large prompt as a positional argv entry exceeds the
    // OS per-argument size limit and the spawn dies with `spawn E2BIG`.
    // stdout/stderr stay piped for streaming.
    //
    // Detached, so the CLI leads its own process group and stopping the turn
    // can signal the group rather than the CLI alone (see stopTurn()). Not on
    // Windows, where `detached` means a new console window instead and there
    // is no group to signal. The child is not unref'd: the bridge still waits
    // on it and reads its pipes exactly as before.
    const child = spawn(command, args, {
      env,
      cwd: cwd ?? getBridgeWorkingDir(),
      stdio: [stdinInput !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    }) as ChildProcessByStdio<Writable | null, Readable, Readable>;

    if (stdinInput !== undefined && child.stdin) {
      // Guard against EPIPE: if the child exits or closes stdin before it has
      // consumed the whole prompt (fast non-zero exit, crash, or a CLI that
      // stops reading), the async write emits an 'error' on the stdin stream.
      // With no listener that becomes an uncaughtException and kills the whole
      // bridge — the very crash class this stdin path exists to avoid. Swallow
      // it here; the child's own exit/close is handled by the caller.
      child.stdin.on('error', () => {});
      if (options.keepStdinOpen === true) {
        // The adapter writes further messages and decides when to close.
        child.stdin.write(stdinInput);
      } else {
        // write + close in one call — also respects backpressure better than
        // a bare write() followed by end().
        child.stdin.end(stdinInput);
      }
    }

    return child;
  }
}
