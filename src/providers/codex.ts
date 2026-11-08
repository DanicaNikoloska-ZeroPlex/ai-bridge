/**
 * Codex CLI Adapter
 *
 * Wraps the OpenAI Codex CLI to produce normalized stream events.
 *
 * CLI invocation:
 *   New session:    codex exec --json --skip-git-repo-check -m <model> "<user message>"
 *   Resume session: codex exec resume <SESSION_ID> --json --skip-git-repo-check "<user message>"
 *
 * Output format (NDJSON):
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"..."}}
 *   {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":...,"output_tokens":...}}
 *   {"type":"error","message":"..."}
 *   {"type":"turn.failed","error":{"message":"..."}}
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelInfo } from '../protocol/types.js';
import { ProviderAdapter, createFinalizer, type ExecutionContext, type AdapterStreamEvent } from './base.js';
import { buildSpawnEnv, buildCombinedPrompt, appendStderr, formatStderrMessage, resolveSystemPrompt, joinSystemPrompt } from './env.js';
import { startTurnTimeouts, clearRequestTimeout, type TurnTimeouts } from './timeout.js';
import { buildCodexMcpArgs, CODEX_BEARER_ENV_VAR } from '../mcp/cli-config.js';
import { resumeAwareErrorCode } from './session-error.js';
import { boundArgumentText, boundArguments, safeStringify, toolResultEventData, withoutBinaryParts } from './result-text.js';
import { createLogger, isDebugEnabled } from '../utils/logger.js';
import { stopTurn, stoppedByUs } from './stop.js';
import { logIgnoredSubagentPrompt } from './subagent-prompt.js';

const log = createLogger('CodexAdapter');

/**
 * Default model to use when no model is specified in the request options.
 *
 * gpt-5.2-codex (the Codex CLI default) is NOT available on ChatGPT Team
 * plans. gpt-5.3-codex is the best coding-optimized model that works
 * with both API key and ChatGPT auth modes.
 */
const DEFAULT_MODEL = 'gpt-5.3-codex';

/**
 * Whether the installed codex accepts `--cd`, probed once per process.
 *
 * Setting the child's cwd is already enough to make codex work in the right
 * directory, so this is belt-and-braces: codex resolves some of its own
 * notions of "the workspace" from the flag rather than from cwd, and passing
 * both means the two agree. Older builds do not have the flag and reject it
 * outright, which would turn a working turn into a spawn failure — hence the
 * probe rather than just passing it.
 */
let codexSupportsCdPromise: Promise<boolean> | null = null;

export function probeCodexSupportsCd(): Promise<boolean> {
  if (codexSupportsCdPromise) {
    return codexSupportsCdPromise;
  }
  codexSupportsCdPromise = new Promise<boolean>((resolve) => {
    let output = '';
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const child = spawn('codex', ['exec', '--help'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // A help probe that hangs must not hold up the turn that triggered it.
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(false);
      }, 5_000);
      child.stdout.on('data', (c: Buffer) => { output += c.toString(); });
      child.stderr.on('data', (c: Buffer) => { output += c.toString(); });
      child.on('error', () => { clearTimeout(timer); finish(false); });
      child.on('close', () => {
        clearTimeout(timer);
        finish(/(^|\s)--cd\b/.test(output));
      });
    } catch {
      finish(false);
    }
  });
  return codexSupportsCdPromise;
}

/** Test seam — forget the cached probe result. */
export function resetCodexCdProbe(): void {
  codexSupportsCdPromise = null;
}

/**
 * A reported count, or null.
 *
 * `x as number` is a promise to the compiler, not a check: a provider sending
 * `"100"` would have had the string forwarded as if it were a count, and a
 * consumer adding it up gets string concatenation. Claude's adapter has always
 * validated; the siblings asserted.
 */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export class CodexAdapter extends ProviderAdapter {
  readonly providerName = 'codex';

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

    log.info('Executing Codex request', { requestId });
    logIgnoredSubagentPrompt(request.subagent_prompt, 'codex', log);

    // Build CLI arguments
    let args: string[];

    // Use the model from request options, or fall back to the default
    const model = request.options?.model ?? DEFAULT_MODEL;

    if (cliSessionId) {
      // Resume an existing session.
      // --skip-git-repo-check is required here just as on a new session:
      // without it codex refuses to run outside a trusted/git directory
      // ("Not inside a trusted directory and --skip-git-repo-check was not
      // specified."). `codex exec resume` accepts the flag.
      args = [
        'exec', 'resume', cliSessionId,
        '--json',
        '--skip-git-repo-check',
      ];
      // Pass model flag on resume if specified in request options
      if (request.options?.model) {
        args.push('-m', request.options.model);
      }
      log.debug('Resuming session', { cliSessionId });
    } else {
      // New session.
      // NOTE: do NOT pass --ephemeral here. --ephemeral runs codex "without
      // persisting session files to disk", so no rollout is written and a
      // later `codex exec resume <id>` fails with "no rollout found for
      // thread id". The bridge persists cli_session_id and resumes it on the
      // next turn, so the session MUST be persisted.
      args = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '-m', model,
      ];
    }

    // Surface the model's reasoning. Codex's `exec --json` stream only emits
    // `item.completed` items of type `reasoning` when `model_reasoning_summary`
    // is `detailed` (or `concise`). The CLI default is `auto`, which does NOT
    // surface reasoning summaries in exec/json mode — verified even at
    // `model_reasoning_effort=high` with hundreds of reasoning tokens, zero
    // reasoning items were emitted. Without this override the bridge captures
    // no `thinking` blocks for Codex. `-c` is accepted by both `codex exec`
    // and `codex exec resume`, so this applies to new and resumed sessions.
    args.push('-c', 'model_reasoning_summary=detailed');

    // Wire up the bridge's MCP server. Server-declared tools are reached
    // through that channel only — Codex's own built-in `shell` tool is left
    // at its default sandbox (read-only, no network) unless the operator
    // opted into `native` mode. With sandbox_mode=read-only and no
    // approval_policy override the model cannot run arbitrary shell against
    // the bridge operator's machine even with a creatively-worded prompt.
    //
    // Note: Codex's user-level `~/.codex/AGENTS.md`, skills, and plugins
    // still load in `isolated` mode (cwd is pinned but $HOME is not). Closing
    // that residual leakage requires CODEX_HOME redirection with auth file
    // symlinking — tracked in tasks/open/cli-isolation-layer-b.md.
    if (context.mcp) {
      args.push(...buildCodexMcpArgs(context.mcp));
    }

    // Sandbox posture. Kept out of the `context.mcp` block above because it
    // has nothing to do with whether the server registered any tools — a
    // `workspace` turn with no tools still has to be able to edit and build.
    if (context.cliIsolation === 'native') {
      // Legacy escape hatch for developers running the bridge against their
      // own machine. Matches the pre-MCP behaviour: the model can run
      // shell, edit files, and execute the wrapper scripts that used to
      // back the tool plumbing. Not safe when end users can send chat
      // messages.
      args.push(
        '-c', 'sandbox_mode=danger-full-access',
        '-c', 'approval_policy=never',
      );
    } else if (context.cliIsolation === 'isolated') {
      // Stated explicitly rather than left to codex's default, for the same
      // reason Claude is given an explicit permission mode above: the default
      // is read from the OPERATOR's `~/.codex/config.toml`, so an operator who
      // set `sandbox_mode = danger-full-access` there for their own work would
      // silently hand every `isolated` turn full access to their machine. The
      // posture has to be something the bridge asserts, not something it hopes
      // the local configuration happens to agree with.
      //
      // NOTE: reasoned, not measured — codex is not installed on the machine
      // this was developed on, so unlike the Claude equivalent it has not been
      // verified against the real CLI. `read-only` is the value codex's own
      // documentation names for this, and it is the default the adapter has
      // always assumed.
      args.push('-c', 'sandbox_mode=read-only');
    } else if (context.cliIsolation === 'workspace') {
      // `workspace-write`, explicitly NOT `danger-full-access`: codex may
      // write inside the directory it was pointed at, and reaching outside it
      // is an escalation. `approval_policy=never` is required alongside —
      // `codex exec` is headless, so anything that asks for approval waits
      // for an answer that can never arrive, and the turn hangs until the
      // request timeout kills it rather than reporting anything useful.
      //
      // This bounds codex more tightly than the equivalent Claude posture
      // does. It is still not a sandbox in any sense the README would be
      // willing to claim: the model has a shell.
      args.push(
        '-c', 'sandbox_mode=workspace-write',
        '-c', 'approval_policy=never',
      );
    }

    // Point codex at the working directory explicitly when its build supports
    // it. `--skip-git-repo-check` above is now usually unnecessary — it exists
    // because the pinned scratch cwd was not a repository, and inside a real
    // checkout it is a no-op. It is left in place because it stays correct for
    // the scratch-directory case, which is still the default.
    if (await probeCodexSupportsCd()) {
      args.push('--cd', context.workingDir);
    }

    // Build the prompt positional argument. The prompt is appended LAST, after
    // every option flag, so Codex's argument parser never mistakes it for a
    // flag value. No tool manifest is appended — Codex discovers
    // server-declared tools through the MCP server.
    //
    // Codex has no dedicated --system-prompt flag, so the resolved system
    // prompt is concatenated. With no server prompt only the addendum is
    // prepended, and Codex keeps its own built-in default.
    // The bridge's lifecycle addendum joins the server's prompt here rather
    // than riding its own flag: Codex has only the one prompt. Like the system
    // prompt itself it goes only on a fresh session — a resumed Codex session
    // already holds both.
    const systemPrompt = !cliSessionId
      ? joinSystemPrompt(
          resolveSystemPrompt(request.system_prompt, context.cliIsolation),
          context.bridgeAddendum,
        )
      : null;
    if (systemPrompt !== null) {
      args.push('--', buildCombinedPrompt(systemPrompt, userMessage));
    } else {
      args.push(userMessage);
    }

    // Codex CLI does not support max_tokens directly — log a warning only; do
    // not emit a stream error (the server has no actionable response and it
    // would confuse users who see an error before a successful reply).
    if (request.options?.max_tokens) {
      log.warn('max_tokens option specified but Codex CLI does not support it directly — ignoring', {
        max_tokens: request.options.max_tokens,
      });
    }

    // Only build the truncated arg array when debug logging is active
    if (isDebugEnabled()) {
      log.debug('Spawning codex', { args: args.map((a) => a.length > 50 ? a.substring(0, 50) + '...' : a) });
    }

    return new Promise<string | null>((resolve) => {
      let sessionId: string | null = null;
      let blockIndex = 0;
      let settled = false;

      if (context.mcp) {
        log.info('Bridge MCP server registered for Codex request', {
          toolCount: context.tools.length,
        });
      }
      // Codex reads the MCP bearer token from this env var (configured by
      // buildCodexMcpArgs as bearer_token_env_var). The env var name must
      // match between the codex config and the spawn env.
      const env = buildSpawnEnv(
        context.requestId,
        context.mcp
          ? { ...context.bridgeEnv, [CODEX_BEARER_ENV_VAR]: context.mcp.bearerToken }
          : { ...context.bridgeEnv },
      );

      const child = this.spawnCli('codex', args, env, undefined, context.workingDir);

      // Enforce the server-configured request_timeout (ai-bridge#2).
      timeouts = startTurnTimeouts({
        silenceSeconds: context.silenceTimeoutSeconds,
        requestSeconds: context.requestTimeoutSeconds,
        onFire: (reason, limitSeconds) => {
          log.warn('Turn timed out — killing codex process', {
            requestId,
            reason,
            limitSeconds,
          });
          stopTurn(child, { requestId, provider: 'codex' });
        },
      });
      const timeoutTimer = { cancel: () => timeouts?.cancel() };

      // Set up abort handling
      const onAbort = () => {
        clearRequestTimeout(timeoutTimer);
        log.info('Request aborted — killing codex process', { requestId });
        stopTurn(child, { requestId, provider: 'codex' });
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
        providerName: 'codex',
        terminalEvent: 'turn.completed',
        getSettled: () => settled,
        setSettled: () => { settled = true; },
        getSessionId: () => sessionId,
        getStderr: () => stderrBuffer,
        onEvent,
        resolve,
        signal,
        onAbort,
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

        // ── thread.started ─────────────────────────────────
        if (type === 'thread.started') {
          sessionId = (parsed['thread_id'] as string) ?? null;
          log.debug('Thread started', { sessionId });
          return;
        }

        // ── turn.started ───────────────────────────────────
        if (type === 'turn.started') {
          log.debug('Turn started');
          return;
        }

        // ── item.completed ─────────────────────────────────
        if (type === 'item.completed') {
          const item = parsed['item'] as Record<string, unknown> | undefined;
          if (!item) return;

          const itemType = item['type'] as string;

          if (itemType === 'agent_message') {
            // Text response from the model
            const text = item['text'] as string;
            if (!text) return;

            onEvent({
              event: 'block_start',
              data: { block_index: blockIndex, block_type: 'text' },
            });

            onEvent({
              event: 'block_delta',
              data: { block_index: blockIndex, content: text },
            });

            onEvent({
              event: 'block_stop',
              data: { block_index: blockIndex },
            });

            blockIndex++;
          } else if (itemType === 'reasoning') {
            // Thinking / reasoning from the model
            const text = (item['text'] as string) ?? '';
            if (!text) return;

            onEvent({
              event: 'block_start',
              data: { block_index: blockIndex, block_type: 'thinking' },
            });

            onEvent({
              event: 'block_delta',
              data: { block_index: blockIndex, content: text },
            });

            onEvent({
              event: 'block_stop',
              data: { block_index: blockIndex },
            });

            blockIndex++;
          } else if (itemType === 'error') {
            // Not ours to report if we are the ones who stopped this turn: the
            // finalizer says why, with the limit when a bound fired.
            if (stoppedByUs(signal, timeouts)) return;

            // Error item
            const message = (item['message'] as string) ?? 'Unknown Codex error';
            log.warn('Codex error item', { message: message.substring(0, 200) });

            onEvent({
              event: 'error',
              data: { code: resumeAwareErrorCode(cliSessionId, message), message },
            });
            // Emit done after error so the server always gets a terminal event.
            onEvent({ event: 'done', data: {} });
            settled = true;
          } else if (itemType === 'mcp_tool_call') {
            // Codex invoked one of the bridge's MCP tools. Surface it as a
            // `tool_call` block followed by a `tool_result` event so the chat
            // UI shows the tool name, arguments, and result — mirroring how
            // Claude and Gemini tool calls are rendered.
            //
            // Item shape (from codex >= 0.131 with MCP integration):
            //   { id, type: 'mcp_tool_call', server, tool, arguments?, result?, status, error? }
            // Field naming differs slightly across codex versions; we read
            // defensively (server|server_name, tool|tool_name, etc.).
            const server = (item['server'] as string) ?? (item['server_name'] as string) ?? '';
            const toolName = (item['tool'] as string) ?? (item['tool_name'] as string) ?? '';
            const args = item['arguments'] as unknown;
            const result = item['result'] as unknown;
            const status = item['status'] as string | undefined;
            const errorField = item['error'];
            const toolCallId = (item['id'] as string) ?? `mcp_${Date.now()}`;

            // Argument payload — codex sometimes ships this pre-stringified,
            // sometimes as an object. Normalise to a JSON string so the chat
            // UI doesn't have to special-case the shape.
            // The bound is OUTSIDE the ternary. Inside it, the pre-stringified
            // branch — which the comment above says Codex sometimes takes —
            // went out unbounded, and a 1.8MB argument payload then tore down
            // the connection. Guarded too, for the readline listener.
            // The object branch bounds by STRUCTURE, like the other adapters:
            // keys survive and the result stays valid JSON. The pre-stringified
            // branch has only text to work with, so it takes the text bound —
            // and it takes it OUTSIDE the ternary, because sitting inside it is
            // how that branch went out unbounded through two review rounds.
            const argsContent = typeof args === 'string'
              // boundArgumentText, not boundResult: 64KB in raw bytes, the
              // ceiling the consumer measures. The sibling path in
              // claude-partial.ts was fixed for exactly this and this one was
              // missed — the third time on this branch that one of a pair got
              // the fix and the other did not.
              ? boundArgumentText(args)
              : boundArguments(args ?? {});

            onEvent({
              event: 'block_start',
              data: {
                block_index: blockIndex,
                block_type: 'tool_call',
                tool_name: toolName,
                tool_call_id: toolCallId,
              },
            });
            onEvent({
              event: 'block_delta',
              data: { block_index: blockIndex, content: argsContent },
            });
            onEvent({
              event: 'block_stop',
              data: { block_index: blockIndex },
            });
            blockIndex++;

            // Error → human-readable string. Codex's `error` field can be a
            // plain string OR an object with nested fields; templating an
            // object directly produced "Error: [object Object]" in the chat
            // UI before this normalisation.
            const errorMsg = typeof errorField === 'string'
              ? errorField
              : errorField != null
                ? safeStringify(errorField, '"unserialisable error"')
                : undefined;

            // Result. Codex emits a single combined item for begin+end of an
            // MCP call (unlike local_shell_call which is split), so the
            // tool_result follows immediately after the tool_call block.
            // Codex's own vocabulary for an MCP call is `in_progress` /
            // `completed` / `failed` (openai/codex, sdk/typescript/src/items.ts);
            // older builds said `error`. Reading ONLY `error` meant a `failed`
            // call with no `error` field was reported as a success — the exact
            // inversion a consumer cannot recover from, since nothing else in
            // the frame contradicts it.
            const failed = status === 'failed' || status === 'error' || errorMsg !== undefined;
            const succeeded = status === 'completed' && errorMsg === undefined;

            const resultText = failed
              ? `Error: ${errorMsg ?? 'tool call failed'}`
              // An image the tool returned (tool_resolve.content) is described,
              // not forwarded: the echo goes to the server (withoutBinaryParts).
              : (typeof result === 'string' ? result : safeStringify(withoutBinaryParts(result ?? null), 'null'));

            // `is_error` is structural, alongside the `Error: ` prefix above
            // rather than instead of it: the prefix stays for consumers that
            // already read it, but a tool legitimately printing "Error: no
            // matches" is indistinguishable from a failure by text alone.
            //
            // Passed ONLY when Codex reported a VERDICT — absent means "not
            // reported" and never "succeeded".
            for (const data of toolResultEventData(
              toolCallId,
              resultText,
              failed || succeeded ? failed : undefined,
            )) {
              onEvent({ event: 'tool_result', data });
            }

            log.info('Codex MCP tool call surfaced', {
              server,
              toolName,
              status,
              hasError: errorMsg !== undefined,
            });
          }
          // function_call / function_call_output / local_shell_call items are
          // Codex's own internal tool execution and not relayed — in
          // `isolated` mode local_shell_call is also blocked by the default
          // read-only sandbox, so it should not produce useful output anyway.
          return;
        }

        // ── turn.completed ─────────────────────────────────
        if (type === 'turn.completed') {
          // Guard against duplicate done events — an error item may already
          // have settled the stream before turn.completed arrives.
          if (settled) return;

          const usage = parsed['usage'] as Record<string, unknown> | undefined;

          onEvent({
            event: 'done',
            data: {
              usage: {
                input_tokens: numberOrNull(usage?.['input_tokens']),
                output_tokens: numberOrNull(usage?.['output_tokens']),
                // Codex says `cached_input_tokens`, and it was being dropped.
                // PROTOCOL.md is emphatic that the cache counts are not a
                // detail: a consumer shown only input and output understates a
                // resumed turn by orders of magnitude and cannot reconcile its
                // own numbers against the provider's bill.
                cache_read_input_tokens: numberOrNull(usage?.['cached_input_tokens']),
              },
            },
          });
          settled = true;
          return;
        }

        // ── turn.failed ────────────────────────────────────
        if (type === 'turn.failed') {
          // See the error item above.
          if (stoppedByUs(signal, timeouts)) return;

          const error = parsed['error'] as Record<string, unknown> | undefined;
          const message = (error?.['message'] as string) ?? 'Codex turn failed';
          log.warn('Codex turn failed', { message: message.substring(0, 200) });

          onEvent({
            event: 'error',
            data: { code: resumeAwareErrorCode(cliSessionId, message), message },
          });

          onEvent({ event: 'done', data: {} });
          settled = true;
          return;
        }

        // ── error (top-level) ──────────────────────────────
        if (type === 'error') {
          // See the error item above.
          if (stoppedByUs(signal, timeouts)) return;

          const message = (parsed['message'] as string) ?? 'Unknown Codex error';
          log.warn('Codex error event', { message: message.substring(0, 200) });

          // Emit error + done so the server is always informed, even if
          // Codex exits with code 0 after this and no turn.failed follows.
          onEvent({
            event: 'error',
            data: { code: resumeAwareErrorCode(cliSessionId, message), message },
          });
          onEvent({ event: 'done', data: {} });
          settled = true;
          return;
        }

        // Ignore other event types (response_item with session_meta, turn_context, etc.)
        log.debug('Unhandled Codex event type', { type });
      });

      rl.on('close', finalizer.onRlClose);

      // Capture stderr for error logging (capped at 10KB)
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuffer = appendStderr(stderrBuffer, chunk.toString());
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        log.error('Failed to spawn codex', { error: err.message });
        // Provide user-friendly message for ENOENT
        const errorMessage = err.code === 'ENOENT'
          ? 'codex CLI not found. Install it or ensure it is on your PATH.'
          : `Failed to spawn codex: ${err.message}`;
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
        log.debug('Codex process closed', { code, sessionId });
        clearRequestTimeout(timeoutTimer);
        finalizer.onChildClose(code);
      });
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const cachePath = join(homedir(), '.codex', 'models_cache.json');
      const raw = await readFile(cachePath, 'utf-8');
      const cache = JSON.parse(raw) as {
        models?: Array<{
          slug: string;
          display_name: string;
          description?: string;
          visibility?: string;
        }>;
      };

      if (!cache.models || !Array.isArray(cache.models)) {
        log.warn('Codex models cache is empty or invalid');
        return [];
      }

      return cache.models
        .filter((m) => m.visibility !== 'hide') // Exclude hidden models like codex-auto-review
        .map((m) => ({
          id: m.slug,
          name: m.display_name,
          description: m.description,
          is_default: m.slug === DEFAULT_MODEL,
        }));
    } catch (err) {
      log.warn('Failed to read Codex models cache. Run codex once to populate models cache. Showing default model only.', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Fallback: return just the default model
      return [
        { id: DEFAULT_MODEL, name: DEFAULT_MODEL, is_default: true },
      ];
    }
  }
}
