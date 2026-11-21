/**
 * Shared utilities for provider adapters.
 *
 * Centralizes environment variable construction, prompt building, and
 * stderr buffering that would otherwise be duplicated across all three
 * adapter implementations.
 */

import { mkdtempSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliIsolation } from '../protocol/types.js';

/** Maximum stderr buffer size (10 KB). */
const MAX_STDERR_BYTES = 10 * 1024;

/** Cached path of the dedicated CLI working directory (created once). */
let cachedWorkingDir: string | null = null;

/**
 * Resolve the dedicated, empty working directory a provider CLI is spawned in
 * when the server has NOT named one.
 *
 * Still the default and still the whole of the behaviour for a chat-only turn.
 * When a server names a working directory and the operator allowed it, the
 * bridge spawns in that directory instead and the notes below about
 * suppressing project context files stop applying — deliberately, because
 * reading the repository's own CLAUDE.md / AGENTS.md is the point of working
 * in a checkout. See src/workspace/resolve.ts.
 *
 * Claude, Codex and Gemini all auto-load project context files
 * (CLAUDE.md / AGENTS.md / GEMINI.md) from their working directory and its
 * parent directories. If a CLI inherited the bridge process's own cwd it
 * would silently absorb whatever happened to be there. Pinning every spawn
 * to a dedicated empty directory closes that leak.
 *
 * The directory lives under `~/.cache/ai-bridge/` rather than `os.tmpdir()`
 * because Gemini's "trusted folders" gate refuses to load project-scope
 * MCP servers from untrusted paths — and `/tmp/...` is never trusted, even
 * with `--skip-trust` (verified empirically: gemini-cli 0.42.0 reads the
 * project `.gemini/settings.json` but skips MCP initialisation when the
 * folder isn't trusted). Most operators already have `~` trusted via the
 * Gemini interactive setup, and trust inherits to subpaths, so a workdir
 * under HOME inherits trust without modifying `~/.gemini/trustedFolders.json`.
 *
 * NOTE: user-level files (e.g. `~/.claude/CLAUDE.md`) load regardless of
 * cwd — those are outside the working-directory mechanism and not affected
 * here. Closing that residual leakage requires HOME redirection — see
 * `tasks/open/cli-isolation-layer-b.md` in the stack.
 *
 * @returns Absolute path to the empty working directory (created if absent).
 */
export function getBridgeWorkingDir(): string {
  if (cachedWorkingDir) {
    return cachedWorkingDir;
  }
  // Ensure the parent cache dir exists, then mkdtempSync inside it so the
  // workdir name is unique per process. A fixed name would risk a previous
  // run's leftover files breaking the "empty cwd" guarantee.
  const cacheRoot = join(homedir(), '.cache', 'ai-bridge');
  mkdirSync(cacheRoot, { recursive: true });
  const dir = mkdtempSync(join(cacheRoot, 'workdir-'));
  cachedWorkingDir = dir;
  return dir;
}

/**
 * Build the environment variables for spawning a CLI subprocess.
 *
 * The legacy `toolScriptDir` parameter (prepended to PATH for the Bash-wrapper
 * tool plumbing) was removed when tool exposure moved to the bridge-side MCP
 * server. Callers now pass extra env entries directly when they need them
 * (e.g. AI_BRIDGE_MCP_TOKEN for codex's bearer-token-env-var integration).
 *
 * @param requestId  Optional request ID to pass as AI_BRIDGE_REQUEST_ID env
 *                   var for concurrent-request correlation.
 * @param extra      Additional env vars to merge in (overrides process.env).
 * @returns A copy of process.env with the requested modifications applied.
 */
export function buildSpawnEnv(
  requestId?: string,
  extra?: Record<string, string | null>,
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (requestId) {
    env['AI_BRIDGE_REQUEST_ID'] = requestId;
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      // `null` is how a caller says "this key must not be set", which is not
      // the same as never mentioning it: the bridge applies defaults, so a
      // project turning one back off has to be able to REMOVE an inherited
      // value rather than only overwrite it. Assigning undefined would leave
      // the key present-but-undefined, which spawn() forwards as an empty
      // string — and an empty string is a set value to every CLI that reads
      // it. Delete is the only spelling that actually unsets.
      if (value === null) delete env[key];
      else env[key] = value;
    }
  }
  // Remove credential variables from the child process environment so they do
  // not leak into /proc/<pid>/environ or the CLI's own logging.
  //
  // ENGRAM_TOKEN belongs on this list as much as the bridge's own token — it
  // is the vault credential, and it defaults to the bridge token when unset.
  // It was survivable while `isolated` was the only posture a server could
  // ask for, because that CLI has no shell. `workspace` gives every provider
  // one, so a single `printenv ENGRAM_TOKEN` would hand the vault credential
  // back to the server in the assistant's own transcript. src/local/executor.ts
  // makes the same argument for local tools and solves it with an allowlist.
  stripCredentials(env);
  return env;
}

/**
 * Remove every credential variable from an environment about to be handed to a
 * child process. Mutates and returns the object it is given.
 *
 * Exported so that anything spawning a binary off PATH — a version probe, a
 * capability probe — strips the same list. Two probes that each remembered a
 * different subset is how ENGRAM_TOKEN ends up in `/proc/<pid>/environ` of a
 * process nobody thought of as handling credentials.
 */
export function stripCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  delete env['AI_BRIDGE_TOKEN'];
  delete env['AI_BRIDGE_SERVER'];
  delete env['ENGRAM_TOKEN'];
  delete env['ENGRAM_URL'];
  delete env['ENGRAM_IDENTITY'];
  return env;
}

/**
 * Resolve the system prompt to pass to the CLI for this turn: the server's, or
 * none at all.
 *
 * The bridge does not write a system prompt of its own, in any isolation mode.
 * When the server sends nothing, the CLI keeps its own default, and the
 * bridge's lifecycle addendum (`bridge_prompt`) still rides beside it.
 *
 * It used to substitute a one-sentence stand-in in `isolated` and `workspace`
 * ("You are an AI assistant. Use only the tools provided to you to fulfil the
 * user's request, and reply in plain prose."), written for a player-facing
 * game chat so the CLI's coding-agent persona could not leak into it. As a
 * default for every consumer it did harm: it silently replaced the CLI's own
 * guidance with a sentence that told a model with a shell to use "only the
 * tools provided" and told one writing into a markdown-rendering chat to use
 * plain prose. A product that wants a voice sends `system_prompt`; the one that
 * needed the stand-in already does.
 *
 * `isolation` stays a parameter so the call sites say which posture they are
 * in, and so a posture-specific rule has one place to go if one is ever needed.
 */
export function resolveSystemPrompt(
  serverPrompt: string | null,
  _isolation: CliIsolation,
): string | null {
  return serverPrompt ? serverPrompt : null;
}

/**
 * Build a combined prompt by prepending the system prompt to the user message.
 *
 * Used by providers (Gemini, Codex) whose CLIs lack a dedicated
 * --system-prompt flag, so system instructions must be concatenated
 * into the user-facing prompt string.
 *
 * @param systemPrompt  The system-level instructions.
 * @param userMessage   The user's actual request message.
 * @returns A single string with the system prompt followed by the user message.
 */
export function buildCombinedPrompt(systemPrompt: string, userMessage: string): string {
  return `${systemPrompt}\n\nUser request:\n${userMessage}`;
}

/**
 * Join the server's system prompt and the bridge's addendum into one string,
 * for CLIs that have no flag to carry them separately.
 *
 * Claude keeps them apart (`--system-prompt` plus `--append-system-prompt`);
 * Codex and Gemini have only the one prompt, so the two owners' text has to be
 * concatenated the way buildCombinedPrompt() already concatenates instructions
 * for those adapters.
 *
 * Returns null only when there is nothing to say at all, so a caller can still
 * tell "no prompt" from "an empty one".
 */
export function joinSystemPrompt(
  systemPrompt: string | null,
  addendum: string | null,
): string | null {
  if (systemPrompt === null) return addendum;
  if (addendum === null) return systemPrompt;
  return `${systemPrompt}\n\n${addendum}`;
}

/**
 * Environment keys a server may set or unset on the spawned CLI, and the
 * defaults the bridge applies when it says nothing.
 *
 * Known keys and their defaults are ONE list on purpose, so the allow-list and
 * the defaults cannot drift apart. A key may be settable without being
 * defaulted, which is how an opinion stays available without being imposed.
 *
 * Restricting the keys is a security boundary rather than tidiness. An open map
 * would let a server point the CLI at another endpoint, or rewrite its search
 * path, inside a process that holds the operator's credentials. The bridge
 * already reasons this way in stripCredentials() and in the local-tool
 * allow-list.
 */
export const BRIDGE_ENV_KEYS: Record<string, { default?: string }> = {
  /**
   * Background tasks are off because they cannot work under one process per
   * turn with its input closed, not because anyone prefers them off. A shell
   * that outlives such a turn is never collected: its output reaches nobody
   * and the next turn opens with a notice that the work was orphaned. And the
   * variable reaches further than the shell: it also runs every HELPER in the
   * foreground (captured on 2.1.280 — `run_in_background` is ignored and the
   * main assistant waits, while still saying it started one "in the
   * background").
   *
   * Recomputed, as this comment asked, now that the bridge has a mode where
   * the process stays: a turn with `accepts_input` keeps stdin open until the
   * main assistant AND everything it started have finished, so a background
   * task is collected, the assistant is told when one fails or is stopped (with
   * its output file) and can re-run it, and the person can talk to it
   * meanwhile. Those turns get this key UNSET (see resolveBridgeEnv()'s
   * `acceptsInput`); every other turn keeps `'1'`, which is still right for
   * them. A server's explicit `bridge_env` value wins in both modes.
   */
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: { default: '1' },

  /**
   * Off by default, because one machine user serves many projects: notes
   * written from one client's chat can surface in another's, and on a shared
   * or multi-tenant box that is a leak between clients rather than a lost
   * convenience. An operator who wants memory back has `bridge_env` to say so.
   *
   * Unlike background tasks above, this is a PRIVACY default rather than an
   * architectural one — the feature is not broken by the spawn model, it is
   * simply not something a bridge should leave on across tenants by default.
   *
   * What is verified on Claude Code 2.1.267: the variable is read
   * (`process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY`), and the CLI distinguishes
   * `disabled_by_env_var` from `disabled_by_setting` (`autoMemoryEnabled`), so
   * setting it does take effect. What is still NOT established is the write
   * path — the memory directory is configurable
   * (CLAUDE_CODE_REMOTE_MEMORY_DIR, CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: both
   * Claude Code's own, found in its CLI binary, 2.1.325) and
   * none existed to inspect on the machine this was built on. That gap bounds
   * what can be claimed about WHERE notes would otherwise land; it does not
   * change the decision to keep them off.
   */
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: { default: '1' },

  /**
   * Settable, deliberately NOT defaulted. The bridge has no architectural
   * reason for it — it changes cost and behaviour for every project that never
   * asked, and shipping one person's choice bridge-wide is how defaults become
   * invisible policy nobody remembers deciding.
   */
  CLAUDE_CODE_FORK_SUBAGENT: {},
};

/** What resolveBridgeEnv() decided, including what it refused. */
export interface ResolvedBridgeEnv {
  /** Merge straight into buildSpawnEnv()'s `extra`. `null` means unset. */
  values: Record<string, string | null>;
  /** Allow-listed keys the server actually overrode, for the ack echo. */
  overridden: string[];
  /** Keys the server sent that are not allow-listed. Dropped, and reported. */
  rejected: string[];
}

/**
 * Resolve the environment a CLI is spawned with for one turn: bridge defaults,
 * with a server's allow-listed overrides applied over them.
 *
 * An override of `null` or the empty string means "unset", which is why the
 * protocol requires it to be written explicitly: "not mentioned" and
 * "deliberately off" must never look alike.
 *
 * Note what this does NOT do: refuse the turn over an unknown key. A key the
 * bridge does not know is dropped and named in the acknowledgement, because a
 * server on a newer protocol than the bridge is an ordinary version skew, and
 * failing the turn would make every bridge upgrade a flag day.
 */
export function resolveBridgeEnv(
  overrides?: Record<string, string | null> | null,
  mode: { acceptsInput?: boolean } = {},
): ResolvedBridgeEnv {
  const values: Record<string, string | null> = {};
  for (const [key, spec] of Object.entries(BRIDGE_ENV_KEYS)) {
    if (spec.default !== undefined) values[key] = spec.default;
  }
  // A turn that keeps its input open collects its background work, so the
  // reason for switching it off does not apply (see the key's comment). Null,
  // not absent: an inherited value in the bridge's own environment has to be
  // removed too, or the turn would run with it anyway.
  if (mode.acceptsInput === true) {
    values['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'] = null;
  }

  const overridden: string[] = [];
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!(key in BRIDGE_ENV_KEYS)) {
      rejected.push(key);
      continue;
    }
    values[key] = value === null || value === '' ? null : value;
    overridden.push(key);
  }

  return { values, overridden, rejected };
}

/** Does the resolved environment leave background shell work available? */
function backgroundTasksEnabled(values: Record<string, string | null>): boolean {
  const raw = values['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'];
  if (raw === null || raw === undefined || raw === '') return true;
  return raw === '0' || raw.toLowerCase() === 'false';
}

/**
 * Longest server-supplied addendum the bridge will carry, announced in hello as
 * `bridge_prompt_max_bytes`. Bridges before that field took 8 KB.
 */
export const MAX_BRIDGE_PROMPT_BYTES = 16 * 1024;

/** Stream-event error code for a `bridge_prompt` the bridge will not act on. */
export const BRIDGE_PROMPT_INVALID = 'bridge_prompt_invalid';

/** How a server steers the bridge's own prompt addendum. */
export type BridgePromptMode = 'default' | 'off' | 'append' | 'replace';

/** The `bridge_prompt` field of an ai_request. */
export interface BridgePromptSpec {
  mode?: BridgePromptMode;
  text?: string | null;
}

/**
 * The bridge's own addendum to the system prompt.
 *
 * It exists because the bridge is the only component that knows a turn is a
 * process. The server owns the voice and the product rules; this owns the
 * lifecycle, and nothing else.
 *
 * Product-neutral and HOST-neutral on purpose: the bridge runs on machines that
 * may have neither Docker nor systemd, so concrete commands belong in the
 * machine's own instruction file where they are actually true.
 *
 * GENERATED from the resolved environment rather than shipped as a fixed
 * string. If a project turns background work back on, an addendum still saying
 * it is disabled would be lying to the model about a capability it can observe
 * directly — and being contradicted by your own instructions is worse than
 * having none.
 */
export function buildBridgeAddendum(
  values: Record<string, string | null>,
  mode: { acceptsInput?: boolean } = {},
): string {
  if (mode.acceptsInput === true) return buildInputTurnAddendum(values);

  const lines: string[] = [
    "## How this session runs",
    "",
    "You are a non-interactive agent. Each message you receive is answered by a",
    "separate CLI process that exits the moment your turn ends. Nothing you started",
    "survives between turns except the conversation itself.",
    "",
  ];

  if (backgroundTasksEnabled(values)) {
    lines.push(
      "- **Background shell commands are available here, but they still die with",
      "  this turn.** Nothing on the far side collects a process that outlives the",
      "  turn that started it, so use one only for work you will also finish reading",
      "  before you answer.",
      "- **Do not detach work from the turn with `&`, `nohup`, `disown` or",
      "  `setsid`.** The process is re-parented to init, nothing reaps it, and",
      "  nobody is told it exists.",
    );
  } else {
    lines.push(
      "- **Background shell commands are disabled.** The Bash tool has no",
      "  `run_in_background` parameter here, deliberately. A shell that outlives the",
      "  turn that started it is never collected: its output reaches nobody, and the",
      "  next turn learns only that it was orphaned.",
      "- **Do not work around that with `&`, `nohup`, `disown` or `setsid`.** They",
      "  still work at the shell level, and they are worse than what they replace:",
      "  the process is re-parented to init, nothing reaps it, and nobody is told it",
      "  exists.",
    );
  }

  lines.push(
    "- **Anything that must outlive the turn has to run as a service managed",
    "  outside this session**, started so that it does not depend on your process.",
    "  How to do that is specific to this machine: follow its own instructions, and",
    "  ask rather than improvise one.",
    "- **Every command is bounded by its timeout** (2 minutes by default, 10 at",
    "  most). A command that sits waiting for input burns that whole budget and then",
    "  fails, so use the non-interactive form of every tool: `-y`, `--force`,",
    "  `--no-input`.",
    "- **Subagents are the exception, and they are safe.** The process stays alive",
    "  until a subagent you spawned has finished, so delegating long work to one is",
    "  fine and is often the right move. Never end your turn claiming a result a",
    "  subagent has not reported yet.",
    "",
    "## Parallel tool calls",
    "",
  );

  if (backgroundTasksEnabled(values)) {
    lines.push(
      "Issuing independent calls together is your main throughput lever. Before",
      "sending a single tool call, ask whether the next two or three depend on its",
      "result. If they do not, send them in the same block. Three 60-second commands",
      "sent together cost 60 seconds; sent one at a time they cost three minutes of",
      "someone's day.",
    );
  } else {
    lines.push(
      "With backgrounding gone, issuing independent calls together is the whole of",
      "your throughput, and it matters more here than general advice suggests.",
      "Before sending a single tool call, ask whether the next two or three depend",
      "on its result. If they do not, send them in the same block. Three 60-second",
      "commands sent together cost 60 seconds; sent one at a time they cost three",
      "minutes of someone's day.",
    );
  }

  return lines.join('\n');
}

/**
 * The addendum for a turn that runs with its input open.
 *
 * A different lifecycle, so different words rather than a patched copy: the
 * process does not exit when the assistant answers, messages arrive in it, and
 * background work is collected. What does NOT change is the ban on detaching
 * work from the turn — a detached process is outside everything this mode
 * tracks, so it is still never collected.
 */
function buildInputTurnAddendum(values: Record<string, string | null>): string {
  const lines: string[] = [
    "## How this session runs",
    "",
    "You are a non-interactive agent. This turn runs in one CLI process that stays",
    "open until you, and everything you started, are done. The person can send you",
    "further messages while it runs; they reach you in this same process, after the",
    "step you are in. When the turn ends the process exits, and nothing you started",
    "survives into the next turn except the conversation itself.",
    "",
  ];

  if (backgroundTasksEnabled(values)) {
    lines.push(
      "- **Background tasks are available in this turn.** A background shell command",
      "  or subagent keeps the turn open until it finishes, and you are told when it",
      "  does. While it runs you are free to answer the person.",
      "- **A background task that fails or is stopped is reported to you**, with the",
      "  file its output was written to. Read that file, and re-run the task if the",
      "  work still needs doing. Never claim a result a task has not reported yet.",
      "- **A background command must end.** The turn is stopped after a long",
      "  stretch in which nothing makes progress. Your own messages and tool calls",
      "  count as progress, and so do a background command that keeps writing",
      "  output and a subagent that keeps working; a command that has gone quiet",
      "  does not. So never start one that is meant to run indefinitely, such as a",
      "  server or a file watcher.",
    );
  } else {
    lines.push(
      "- **Background shell commands are disabled here.** Run commands in the",
      "  foreground; subagents run in the foreground too, and the turn waits for them.",
    );
  }

  lines.push(
    "- **Do not detach work from the turn with `&`, `nohup`, `disown` or",
    "  `setsid`.** Use the tool's own background option instead. A detached",
    "  process is re-parented to init, nothing reaps it, and nobody is told it",
    "  exists.",
    "- **Anything that must outlive the turn has to run as a service managed",
    "  outside this session**, started so that it does not depend on your process.",
    "  How to do that is specific to this machine: follow its own instructions, and",
    "  ask rather than improvise one.",
    "- **Every command is bounded by its timeout** (2 minutes by default, 10 at",
    "  most). A command that sits waiting for input burns that whole budget and then",
    "  fails, so use the non-interactive form of every tool: `-y`, `--force`,",
    "  `--no-input`.",
    "",
    "## Parallel tool calls",
    "",
    "Issuing independent calls together is your main throughput lever. Before",
    "sending a single tool call, ask whether the next two or three depend on its",
    "result. If they do not, send them in the same block. Three 60-second commands",
    "sent together cost 60 seconds; sent one at a time they cost three minutes of",
    "someone's day.",
  );

  return lines.join('\n');
}

/**
 * The bridge's section for a SUBAGENT (helper) of this turn.
 *
 * A Claude Code subagent gets its own system prompt and never sees the main
 * one, so without this the facts above (non-interactive, bounded commands, no
 * detaching, parallel calls) and the server's `bridge_prompt` text reached
 * the main assistant only. Measured in Engram: helpers gave a description on
 * 32% of their shell commands against 99.9% in the main chat, the line asking
 * for it being in the main prompt alone. Decision 0015.
 *
 * Worded for a helper rather than copied: it reports to the assistant that
 * started it, not to the person, and receives no messages while it runs. The
 * same in both turn modes, since a helper's own life is the same in both;
 * only whether background commands exist follows the environment.
 */
export function buildHelperAddendum(values: Record<string, string | null>): string {
  const lines: string[] = [
    "## How this session runs",
    "",
    "You are a non-interactive subagent, started by the assistant of this turn,",
    "inside its CLI process. What you return goes to that assistant, not to the",
    "person. When the turn ends the process exits, and nothing you started",
    "survives it.",
    "",
  ];

  if (backgroundTasksEnabled(values)) {
    lines.push(
      "- **Finish what you start in the background before you return.** Wait for",
      "  every background command or subagent you started to end, or stop it, and",
      "  read its result yourself. Never return a result one has not reported yet.",
    );
  } else {
    lines.push(
      "- **Background shell commands are disabled here.** Run commands in the",
      "  foreground.",
    );
  }

  lines.push(
    "- **Do not detach work from the turn with `&`, `nohup`, `disown` or",
    "  `setsid`.** A detached process is re-parented to init, nothing reaps it, and",
    "  nobody is told it exists.",
    "- **Anything that must outlive the turn has to run as a service managed",
    "  outside this session.** How to do that is specific to this machine: follow",
    "  its own instructions, and report back rather than improvise one.",
    "- **Every command is bounded by its timeout** (when you set none, the tool's",
    "  own: 2 minutes, 10 at most). A command that sits waiting for input burns",
    "  that whole budget and then fails, so use the non-interactive form of every",
    "  tool: `-y`, `--force`, `--no-input`.",
    "",
    "## Parallel tool calls",
    "",
    "Issuing independent calls together is your main throughput lever. Before",
    "sending a single tool call, ask whether the next two or three depend on its",
    "result. If they do not, send them in the same block.",
  );

  return lines.join('\n');
}

/**
 * Check a server's `bridge_prompt` before anything acts on it.
 *
 * Rejected at the protocol boundary rather than guessed at: a server sending a
 * contradictory instruction is a bug in the server, and a chat whose
 * instructions are not what either side believes is worse than a refused turn.
 *
 * @returns An error message, or null when the spec is well-formed.
 */
export function validateBridgePrompt(spec?: BridgePromptSpec | null): string | null {
  if (spec === undefined || spec === null) return null;

  const mode = spec.mode ?? 'default';
  if (!['default', 'off', 'append', 'replace'].includes(mode)) {
    return `bridge_prompt.mode must be one of default, off, append, replace (got ${JSON.stringify(mode)}).`;
  }

  const text = spec.text ?? null;
  const hasText = text !== null && text !== '';

  // Text where none is used would be silently discarded, and a mode that says
  // it is adding something must add something — `append` with nothing is a
  // no-op that reads as applied, and `replace` with nothing silently means
  // `off`. All four are the server believing something that is not happening.
  if ((mode === 'default' || mode === 'off') && hasText) {
    return `bridge_prompt.text is not allowed with mode "${mode}" — it would be discarded.`;
  }
  if ((mode === 'append' || mode === 'replace') && !hasText) {
    return `bridge_prompt.text is required with mode "${mode}".`;
  }

  // The bridge already feeds Claude its prompt over stdin because a large
  // positional argument dies with spawn E2BIG. A cap with a clear refusal beats
  // an E2BIG at spawn time, which surfaces as a turn that failed for no
  // visible reason.
  if (hasText && Buffer.byteLength(text, 'utf8') > MAX_BRIDGE_PROMPT_BYTES) {
    return `bridge_prompt.text exceeds ${MAX_BRIDGE_PROMPT_BYTES} bytes.`;
  }

  return null;
}

/** What resolveBridgeAddendum() decided, for the spawn and for the ack echo. */
export interface ResolvedBridgePrompt {
  /** Text to append to the system prompt, or null to append nothing. */
  text: string | null;
  /**
   * Text to append to every subagent's prompt, or null: the helper section
   * (buildHelperAddendum) under the same mode, the server's text included.
   */
  helperText: string | null;
  /** The mode actually applied. */
  mode: BridgePromptMode;
  /** Whether the server supplied text of its own. */
  serverText: boolean;
}

/**
 * Resolve the addendum for this turn from the server's request and the
 * environment the turn will actually run with.
 *
 * `off` and `replace` are the project's right, but both drop a true statement
 * about the runtime from the assistant's instructions — so both say so in the
 * log, because a project taking them on owns explaining the lifecycle itself.
 */
export function resolveBridgeAddendum(
  spec: BridgePromptSpec | null | undefined,
  values: Record<string, string | null>,
  turn: { acceptsInput?: boolean } = {},
): ResolvedBridgePrompt {
  const mode = spec?.mode ?? 'default';
  const serverTextRaw = spec?.text ?? null;
  const serverText = serverTextRaw !== null && serverTextRaw !== '';
  const addendum = buildBridgeAddendum(values, turn);

  const helper = buildHelperAddendum(values);

  // `append` text is an addition about how the session runs, and a helper runs
  // commands in it too, so it rides after the helper section. `replace` text
  // was written for the main assistant in place of the bridge's words; a
  // server taking those over words its helpers' version in `subagent_prompt`.
  switch (mode) {
    case 'off':
      return { text: null, helperText: null, mode, serverText };
    case 'replace':
      return { text: serverTextRaw, helperText: null, mode, serverText };
    case 'append':
      return { text: `${addendum}\n\n${serverTextRaw}`, helperText: `${helper}\n\n${serverTextRaw}`, mode, serverText };
    default:
      return { text: addendum, helperText: helper, mode: 'default', serverText };
  }
}

/**
 * Append a chunk to a stderr buffer, capping at MAX_STDERR_BYTES (10 KB).
 *
 * Keeps the FIRST 10 KB rather than the last, because the beginning of CLI
 * stderr almost always contains the root-cause error while the tail tends to
 * be less useful stack traces.
 *
 * @param buffer  Current buffer contents.
 * @param chunk   New data to append.
 * @returns The updated (possibly truncated) buffer.
 */
export function appendStderr(buffer: string, chunk: string): string {
  // Once we have 10 KB, stop accumulating — root-cause is already there.
  if (buffer.length >= MAX_STDERR_BYTES) {
    return buffer;
  }
  buffer += chunk;
  if (buffer.length > MAX_STDERR_BYTES) {
    buffer = buffer.slice(0, MAX_STDERR_BYTES);
  }
  return buffer;
}

/**
 * Produce a user-friendly error message from raw CLI stderr output.
 *
 * Detects common known patterns (auth failures, rate limits) and returns a
 * clear actionable message.  Strips ANSI escape codes and limits to the first
 * meaningful line for unrecognized errors.
 *
 * @param provider  Provider name (e.g. "claude") used in fallback messages.
 * @param stderr    Raw stderr output from the CLI.
 * @param exitCode  Process exit code (for context).
 * @returns A user-facing error string.
 */
export function formatStderrMessage(provider: string, stderr: string, exitCode: number | null): string {
  // Strip ANSI escape sequences
  // eslint-disable-next-line no-control-regex
  const clean = stderr.replace(/\x1b\[[0-9;]*[mGKHFJSTsuABCDhl]/g, '').trim();

  if (!clean) {
    return `${provider} CLI exited with code ${exitCode ?? 'unknown'}`;
  }

  const lower = clean.toLowerCase();

  // Auth-related patterns
  if (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('unauthorized') ||
    lower.includes('unauthenticated') ||
    lower.includes('auth') ||
    lower.includes('login') ||
    lower.includes('authenticate') ||
    lower.includes('not logged in') ||
    lower.includes('sign in') ||
    lower.includes('credentials')
  ) {
    // Codex uses `codex login`; Claude and Gemini use `<provider> auth login`.
    const authCmd = provider === 'codex' ? `${provider} login` : `${provider} auth login`;
    return `Authentication required — run \`${authCmd}\` to re-authenticate.`;
  }

  // Rate limit patterns
  if (
    lower.includes('rate limit') ||
    lower.includes('ratelimit') ||
    lower.includes('too many requests') ||
    lower.includes('429')
  ) {
    return `Rate limit reached — please wait a moment and try again.`;
  }

  // Return the first non-empty line, capped to 500 characters
  const firstLine = clean.split('\n').find((l) => l.trim()) ?? clean;
  return firstLine.substring(0, 500);
}
