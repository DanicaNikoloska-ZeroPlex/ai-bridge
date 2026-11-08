/**
 * Gemini CLI Adapter
 *
 * Wraps the Google Gemini CLI to produce normalized stream events.
 *
 * CLI invocation:
 *   New session:    gemini --prompt "user message" --output-format stream-json
 *   Resume session: gemini --prompt "user message" --resume <session-id> --output-format stream-json
 *
 * Output format (NDJSON):
 *   {"type":"init","session_id":"...","model":"...","timestamp":"..."}
 *   {"type":"message","role":"user","content":"...","timestamp":"..."}
 *   {"type":"message","role":"assistant","content":"...","delta":true,"timestamp":"..."}
 *   {"type":"tool_use","tool_name":"...","tool_id":"...","parameters":{...},"timestamp":"..."}
 *   {"type":"tool_result","tool_id":"...","status":"success|error","output":"...","timestamp":"..."}
 *   {"type":"error","severity":"warning|error","message":"...","timestamp":"..."}
 *   {"type":"result","status":"success|error","stats":{...},"timestamp":"..."}
 *
 * KNOWN LIMITATION — no `thinking` blocks for Gemini.
 *
 * This adapter emits no `thinking` block events (the Codex and Claude adapters
 * do). This is an upstream Gemini CLI limitation, not something the bridge can
 * fix: the `--output-format stream-json` event schema is a fixed enum —
 * `init | message | tool_use | tool_result | error | result` — with no thought
 * type. Internally the CLI has `GeminiEventType.Thought` and surfaces thoughts
 * over its ACP interface (`agent_thought_chunk`), but the non-interactive
 * stream-json code path only forwards `Content` events and drops `Thought`
 * ones before the formatter. `ui.inlineThinkingMode` only affects the
 * interactive TUI — it has no effect on stream-json output (verified against
 * gemini-cli 0.42.0).
 *
 * Capturing Gemini thinking would require either the upstream CLI adding a
 * thought event to stream-json, or this adapter being rewritten onto the ACP
 * interface — a much larger change. See:
 *   - docs: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md
 *   - upstream issue (broad): https://github.com/google-gemini/gemini-cli/issues/8473
 *   - thinking summaries, closed not planned: https://github.com/google-gemini/gemini-cli/issues/15052
 */

import { createInterface } from 'node:readline';
import type { ModelInfo } from '../protocol/types.js';
import { ProviderAdapter, createFinalizer, type ExecutionContext, type AdapterStreamEvent } from './base.js';
import {
  buildSpawnEnv,
  buildCombinedPrompt,
  appendStderr,
  formatStderrMessage,
  getBridgeWorkingDir,
  resolveSystemPrompt,
  joinSystemPrompt,
} from './env.js';
import { startTurnTimeouts, clearRequestTimeout, type TurnTimeouts } from './timeout.js';
import {
  BRIDGE_MCP_SERVER_NAME,
  acquireGeminiSettings,
  type GeminiSettingsHandle,
} from '../mcp/cli-config.js';
import { RequestRefusal } from '../errors.js';
import { resumeAwareErrorCode } from './session-error.js';
import { boundArguments, safeStringify, toolResultEventData, withoutBinaryParts } from './result-text.js';
import { createLogger, isDebugEnabled } from '../utils/logger.js';
import { stopTurn, stoppedByUs } from './stop.js';
import { logIgnoredSubagentPrompt } from './subagent-prompt.js';

/**
 * Known Gemini CLI model aliases and models.
 *
 * Gemini CLI supports aliases (auto, pro, flash, flash-lite) that resolve to
 * concrete model versions. Like Claude, there is no `--list-models` command,
 * but the aliases are the official user-facing interface.
 */
const GEMINI_MODELS: ModelInfo[] = [
  { id: 'auto', name: 'Auto', description: 'Automatically selects the best model', is_default: true },
  { id: 'pro', name: 'Pro', description: 'Complex reasoning tasks (Gemini 2.5 Pro)', is_default: false },
  { id: 'flash', name: 'Flash', description: 'Fast and balanced (Gemini 2.5 Flash)', is_default: false },
  { id: 'flash-lite', name: 'Flash Lite', description: 'Fastest for simple tasks (Gemini 2.5 Flash Lite)', is_default: false },
];

const log = createLogger('GeminiAdapter');

/** A reported count, or null — `as number` asserts rather than checks. */
function geminiNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export class GeminiAdapter extends ProviderAdapter {
  readonly providerName = 'gemini';

  async execute(context: ExecutionContext, onEvent: (event: AdapterStreamEvent) => void): Promise<string | null> {
    // Every emission resets the silence clock; the wrapper goes here so no
    // call site can be missed.
    let timeouts: TurnTimeouts | null = null;
    const emit = onEvent;
    onEvent = (event: AdapterStreamEvent): void => {
      timeouts?.notice();
      emit(event);
    };
    const { request, signal, cliSessionId } = context;
    const requestId = request.request_id;
    const userMessage = request.message;

    log.info('Executing Gemini request', { requestId });
    logIgnoredSubagentPrompt(request.subagent_prompt, 'gemini', log);

    // Build the prompt — prepend system prompt if provided (Gemini CLI has no
    // dedicated --system-instruction flag, so we concatenate). With no server
    // prompt, Gemini keeps its own built-in default.
    // No tool manifest is appended — Gemini discovers server-declared tools
    // through the MCP server registered in .gemini/settings.json (see below).
    // The bridge's lifecycle addendum has no flag of its own here either, so it
    // joins the server's prompt before the two are concatenated onto the
    // message. Fresh sessions only, like the system prompt itself.
    let prompt = userMessage;
    if (!cliSessionId) {
      const systemPrompt = joinSystemPrompt(
        resolveSystemPrompt(request.system_prompt, context.cliIsolation),
        context.bridgeAddendum,
      );
      if (systemPrompt !== null) {
        prompt = buildCombinedPrompt(systemPrompt, userMessage);
      }
    }

    // Wire up MCP by writing .gemini/settings.json in the CLI's working
    // directory — Gemini reads it as project-scope settings. The bridge's
    // working directory is dedicated and process-local (see
    // getBridgeWorkingDir()), so this file is invisible to the operator's
    // real ~/.gemini config.
    //
    // The server entry sets `trust: true` so MCP tool calls auto-approve in
    // non-interactive --prompt mode (otherwise they would stall waiting for
    // a user confirmation the headless mode can never deliver).
    //
    // In `isolated` mode we deliberately do NOT pass `--yolo`. Gemini's
    // built-in shell / edit / web tools therefore stall on approval if the
    // model tries to use them — which is the safe outcome. `native` mode
    // adds --yolo as the legacy operator opt-in.
    //
    // Note: Gemini's user-level `~/.gemini/GEMINI.md` and skills/extensions
    // still load in `isolated` mode (cwd is pinned but $HOME is not).
    // Closing that residual leakage requires HOME/GEMINI_HOME redirection
    // with auth symlinking — tracked in tasks/open/cli-isolation-layer-b.md.
    //
    // Once the working directory can be a developer's checkout, that file is
    // no longer ours: see acquireGeminiSettings(), which refuses rather than
    // overwrites an existing one and removes the one it writes when the turn
    // ends. Gemini is the only provider with this problem — Claude and Codex
    // take their MCP configuration per invocation.
    const managedWorkingDir = context.workingDir !== getBridgeWorkingDir();
    let settingsHandle: GeminiSettingsHandle | null = null;
    if (context.mcp) {
      try {
        settingsHandle = acquireGeminiSettings(context.workingDir, context.mcp, managedWorkingDir);
      } catch (err) {
        // A refusal, not a provider failure. Raised as RequestRefusal so the
        // bridge reports it as itself and ends the turn — a bare throw on a
        // resumed turn would be read as `session_lost` and silently re-issued,
        // which would retry the same refusal forever.
        throw new RequestRefusal(
          'gemini_working_dir_unavailable',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Build CLI arguments
    const args: string[] = [
      '--prompt', prompt,               // Non-interactive mode with prompt
      '--output-format', 'stream-json', // NDJSON streaming output
      '--skip-trust',                   // Required for headless/non-interactive mode
    ];

    // Limit the visible MCP server set to ours, regardless of what the
    // operator's user/project settings might contain elsewhere.
    //
    // Outside the `context.mcp` block deliberately. `mcp` is null exactly when
    // the bridge's own MCP server failed to start — and the turn still runs.
    // Inside the block, a `workspace` turn would then launch with `--yolo` and
    // NO server restriction, so gemini would load the operator's
    // `~/.gemini/settings.json` servers and the checkout's own
    // `.gemini/settings.json`, auto-approving every tool they expose. Same
    // shape as the Claude flags; same reason.
    if (context.cliIsolation !== 'native') {
      args.push('--allowed-mcp-server-names', BRIDGE_MCP_SERVER_NAME);
    }

    if (context.cliIsolation !== 'isolated') {
      // `--yolo` auto-approves everything, including built-in shell and edit.
      //
      // In `native` this is the legacy operator opt-in. In `workspace` it is
      // the only lever Gemini offers: there is no middle setting, no
      // equivalent of Codex's `workspace-write`, and without it every built-in
      // tool stalls on an approval prompt that headless mode can never show.
      // So `workspace` on Gemini is materially broader than `workspace` on
      // Codex, and the README says so rather than implying the three CLIs are
      // equivalent.
      args.push('--yolo');
    }

    // Resume an existing session if we have a session ID
    if (cliSessionId) {
      args.push('--resume', cliSessionId);
      log.debug('Resuming session', { cliSessionId });
    }

    // Add model if specified in request options
    if (request.options?.model) {
      args.push('--model', request.options.model);
    }

    // Gemini CLI does not support max_tokens directly — log a warning only; do
    // not emit a stream error (the server has no actionable response and it
    // would confuse users who see an error before a successful reply).
    if (request.options?.max_tokens) {
      log.warn('max_tokens option specified but Gemini CLI does not support it directly — ignoring', {
        max_tokens: request.options.max_tokens,
      });
    }

    // Only build the truncated arg array when debug logging is active
    if (isDebugEnabled()) {
      log.debug('Spawning gemini', { args: args.map((a) => a.length > 50 ? a.substring(0, 50) + '...' : a) });
    }

    // try/finally rather than releasing at each exit: the settings file must
    // come back out of the developer's checkout whatever happened — a clean
    // finish, a provider error, a timeout, or a cancel — and a release that
    // has to be remembered at four separate call sites is a release that will
    // be forgotten at one of them.
    try {
      return await new Promise<string | null>((resolve) => {
      let sessionId: string | null = null;
      let blockIndex = 0;
      let settled = false;
      let reportedModel: string | null = null;
      let inTextBlock = false;

      const env = buildSpawnEnv(context.requestId, context.bridgeEnv);

      const child = this.spawnCli('gemini', args, env, undefined, context.workingDir);

      // Enforce the server-configured request_timeout (ai-bridge#2).
      timeouts = startTurnTimeouts({
        silenceSeconds: context.silenceTimeoutSeconds,
        requestSeconds: context.requestTimeoutSeconds,
        onFire: (reason, limitSeconds) => {
          log.warn('Turn timed out — killing gemini process', {
            requestId,
            reason,
            limitSeconds,
          });
          stopTurn(child, { requestId, provider: 'gemini' });
        },
      });
      const timeoutTimer = { cancel: () => timeouts?.cancel() };

      // Set up abort handling
      const onAbort = () => {
        clearRequestTimeout(timeoutTimer);
        log.info('Request aborted — killing gemini process', { requestId });
        stopTurn(child, { requestId, provider: 'gemini' });
      };
      signal.addEventListener('abort', onAbort, { once: true });

      // Track stderr in a variable so the finalizer closure can access it.
      let stderrBuffer = '';

      const finalizer = createFinalizer({
        getTimeout: () => {
          const reason = timeouts?.reason();
          const limitSeconds = timeouts?.limit();

          return reason && limitSeconds !== null && limitSeconds !== undefined
            ? { reason, limitSeconds }
            : null;
        },
        providerName: 'gemini',
        terminalEvent: 'result',
        getSettled: () => settled,
        setSettled: () => { settled = true; },
        getSessionId: () => sessionId,
        getStderr: () => stderrBuffer,
        onEvent,
        resolve,
        signal,
        onAbort,
        // Gemini-specific: close any open text block before finalizing
        onBeforeFinalize: () => {
          if (inTextBlock) {
            onEvent({
              event: 'block_stop',
              data: { block_index: blockIndex },
            });
            blockIndex++;
            inTextBlock = false;
          }
        },
      });

      // Parse NDJSON from stdout line by line
      const rl = createInterface({ input: child.stdout });

      rl.on('line', (line) => {
        if (!line.trim()) return;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          log.debug('Skipping non-JSON line', { line: line.substring(0, 100) });
          return;
        }

        const type = parsed['type'] as string;

        // ── init ─────────────────────────────────────────────
        if (type === 'init') {
          sessionId = (parsed['session_id'] as string) ?? null;
          reportedModel = typeof parsed['model'] === 'string' ? parsed['model'] : null;
          log.debug('Session init', { sessionId, model: reportedModel });
          return;
        }

        // ── message ──────────────────────────────────────────
        if (type === 'message') {
          const role = parsed['role'] as string;

          // Skip the user message echo
          if (role === 'user') return;

          if (role === 'assistant') {
            const content = parsed['content'] as string;
            const isDelta = parsed['delta'] as boolean | undefined;

            if (!content) return;

            if (isDelta) {
              // Streaming delta — Gemini sends multiple delta messages
              // Open a text block if not already open
              if (!inTextBlock) {
                onEvent({
                  event: 'block_start',
                  data: {
                    block_index: blockIndex,
                    block_type: 'text',
                  },
                });
                inTextBlock = true;
              }

              onEvent({
                event: 'block_delta',
                data: {
                  block_index: blockIndex,
                  content,
                },
              });
            } else {
              // Non-delta full message (rare in stream-json mode, but handle it)
              // Close any open block first
              if (inTextBlock) {
                onEvent({
                  event: 'block_stop',
                  data: { block_index: blockIndex },
                });
                blockIndex++;
                inTextBlock = false;
              }

              onEvent({
                event: 'block_start',
                data: { block_index: blockIndex, block_type: 'text' },
              });
              onEvent({
                event: 'block_delta',
                data: { block_index: blockIndex, content },
              });
              onEvent({
                event: 'block_stop',
                data: { block_index: blockIndex },
              });
              blockIndex++;
            }
          }
          return;
        }

        // ── tool_use ─────────────────────────────────────────
        if (type === 'tool_use') {
          // Close any open text block before tool use
          if (inTextBlock) {
            onEvent({
              event: 'block_stop',
              data: { block_index: blockIndex },
            });
            blockIndex++;
            inTextBlock = false;
          }

          // Emit as a tool_call block
          onEvent({
            event: 'block_start',
            data: {
              block_index: blockIndex,
              block_type: 'tool_call',
              tool_name: parsed['tool_name'] as string,
              tool_call_id: parsed['tool_id'] as string,
            },
          });

          onEvent({
            event: 'block_delta',
            data: {
              block_index: blockIndex,
              // Guarded: an encode that throws inside the readline
              // listener would take down the daemon, not just this turn.
              content: boundArguments(parsed['parameters'] ?? {}),
            },
          });

          onEvent({
            event: 'block_stop',
            data: { block_index: blockIndex },
          });
          blockIndex++;
          return;
        }

        // ── tool_result ──────────────────────────────────────
        if (type === 'tool_result') {
          const toolId = parsed['tool_id'] as string;
          // Validated, not asserted. `as string` is a promise to the compiler,
          // not a check: an array or object here reached `replaceLoneSurrogates`
          // and threw `text.charCodeAt is not a function` INSIDE the readline
          // listener, where nothing catches it — no `uncaughtException` handler
          // exists — taking the daemon down with every in-flight request on it.
          // Both sibling adapters already guard this.
          const raw = parsed['output'];
          // An image a tool returned is described, never forwarded: this echo
          // goes to the server (withoutBinaryParts).
          const output = typeof raw === 'string' ? raw : safeStringify(withoutBinaryParts(raw ?? ''), '');
          const status = parsed['status'] as string;

          // `is_error` is structural, alongside the `Error: ` prefix rather
          // than instead of it — the prefix stays for consumers that already
          // read it. Passed only when Gemini reported a status: absent means
          // "not reported", never "succeeded".
          for (const data of toolResultEventData(
            toolId,
            status === 'error'
              ? `Error: ${(parsed['error'] as Record<string, unknown>)?.['message'] ?? output}`
              : output,
            typeof status === 'string' ? status === 'error' : undefined,
          )) {
            onEvent({ event: 'tool_result', data });
          }
          return;
        }

        // ── error (non-fatal or fatal) ──────────────────────
        if (type === 'error') {
          const severity = parsed['severity'] as string;
          const message = parsed['message'] as string;
          log.warn('Gemini error event', { severity, message: message?.substring(0, 200) });

          // severity='error' and severity='warning' are both forwarded to the
          // server as stream events.
          if (severity === 'error') {
            // Not ours to report if we are the ones who stopped this turn: the
            // finalizer says why, with the limit when a bound fired.
            if (stoppedByUs(signal, timeouts)) return;

            const errText = message ?? 'Unknown Gemini error';
            onEvent({
              event: 'error',
              data: {
                code: resumeAwareErrorCode(cliSessionId, errText),
                message: errText,
              },
            });
            // Fatal errors terminate the response — emit done and mark settled.
            onEvent({ event: 'done', data: {} });
            settled = true;
          }
          // severity 'warning' is non-fatal and informational — Gemini keeps
          // streaming. It must NOT be emitted as a stream 'error' event: the
          // server treats every error as terminal and would abort the request
          // (dropping subsequent content and tool calls). Log it locally only.
          return;
        }

        // ── result (final) ───────────────────────────────────
        if (type === 'result') {
          // Guard against duplicate done events — a fatal 'error' event may
          // already have settled this request before result arrives.
          if (settled) return;

          // Close any open text block
          if (inTextBlock) {
            onEvent({
              event: 'block_stop',
              data: { block_index: blockIndex },
            });
            blockIndex++;
            inTextBlock = false;
          }

          const status = parsed['status'] as string;

          if (status === 'error') {
            const error = parsed['error'] as Record<string, unknown> | undefined;
            const errorMessage = (error?.['message'] as string) ?? 'Gemini request failed';
            log.warn('Gemini result error', { type: error?.['type'], message: errorMessage.substring(0, 200) });

            onEvent({
              event: 'error',
              data: {
                code: resumeAwareErrorCode(cliSessionId, errorMessage),
                message: errorMessage,
              },
            });
          }

          // Extract usage stats
          const stats = parsed['stats'] as Record<string, unknown> | undefined;

          onEvent({
            event: 'done',
            data: {
              usage: {
                input_tokens: geminiNumber(stats?.['input_tokens']),
                output_tokens: geminiNumber(stats?.['output_tokens']),
              },
              // Read off the init frame, logged, and then thrown away. Absent
              // tells the server "not reported", and the CLI DID report it.
              ...(reportedModel !== null ? { model: reportedModel } : {}),
            },
          });
          settled = true;
          return;
        }

        log.debug('Unhandled Gemini event type', { type });
      });

      rl.on('close', finalizer.onRlClose);

      // Capture stderr for error logging (capped at 10KB)
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuffer = appendStderr(stderrBuffer, chunk.toString());
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        log.error('Failed to spawn gemini', { error: err.message });
        // Provide user-friendly message for ENOENT
        const errorMessage = err.code === 'ENOENT'
          ? 'gemini CLI not found. Install it or ensure it is on your PATH.'
          : `Failed to spawn gemini: ${err.message}`;
        signal.removeEventListener('abort', onAbort);
        clearRequestTimeout(timeoutTimer);

        if (!settled) {
          settled = true;
          onEvent({
            event: 'error',
            data: {
              code: 'provider_spawn_error',
              message: errorMessage,
            },
          });
          onEvent({ event: 'done', data: {} });
          resolve(null);
        }
      });

      child.on('close', (code) => {
        log.debug('Gemini process closed', { code, sessionId });
        clearRequestTimeout(timeoutTimer);
        finalizer.onChildClose(code);
      });
      });
    } finally {
      settingsHandle?.release();
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    // Gemini CLI has no dynamic model listing — return known aliases
    return GEMINI_MODELS;
  }
}
