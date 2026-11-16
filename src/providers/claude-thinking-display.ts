/**
 * `ai_request.options.thinking_display` — whether Claude's thinking comes back
 * readable, passed to the CLI as `--thinking-display <display>`.
 *
 * Why it exists: on the current Claude models (Opus 4.7 and later, Sonnet 5 and
 * later) the API's thinking display defaults to `omitted`. The model still
 * thinks, and is billed the same, but every `thinking` block reaches the CLI's
 * stream-json with an empty `thinking` text and only a signature, so the
 * bridge has nothing to forward and drops the block. `summarized` asks the API
 * for a readable summary of that thinking instead (the raw chain of thought is
 * never returned by any model). Verified on Claude Code 2.1.310 and 2.1.311 with
 * `--model opus` (claude-opus-5-5) in `-p --output-format stream-json`: without
 * the flag a thinking block arrives with `thinking: ""`; with
 * `--thinking-display summarized` it carries the summary. The `showThinkingSummaries`
 * setting does not reach `-p` runs (also verified), so the flag is the way in.
 *
 * Only the values below are passed, and only to a Claude Code version known to
 * have the flag (an older CLI would refuse the unknown option and fail the
 * turn). Anything else is dropped with a debug line and the turn runs exactly
 * as it would without the option. Advertised as `hello.thinking_displays`.
 * Codex and Gemini ignore it.
 */

import { createLogger } from '../utils/logger.js';
import { getDetectedClaudeVersion, isVersionAtLeast } from './subagent-prompt.js';

const log = createLogger('ClaudeAdapter');

/** The values passed as `--thinking-display`; sent as `hello.thinking_displays`. */
export const CLAUDE_THINKING_DISPLAYS = ['summarized', 'omitted'] as const;

export type ClaudeThinkingDisplay = (typeof CLAUDE_THINKING_DISPLAYS)[number];

export const THINKING_DISPLAY_FLAG = '--thinking-display';

/** First Claude Code version this bridge has seen with `--thinking-display` (older ones may have it; unverified). */
export const THINKING_DISPLAY_MIN_VERSION = '2.1.310';

/**
 * The arguments for `options.thinking_display`: `['--thinking-display', value]`,
 * or `[]` for none. Absent, null and empty mean "not asked"; a value outside
 * CLAUDE_THINKING_DISPLAYS, or a CLI too old for the flag, is ignored (logged
 * at debug), never an error.
 */
export function claudeThinkingDisplayArgs(
  value: unknown,
  version: string | null = getDetectedClaudeVersion(),
): string[] {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string' || !(CLAUDE_THINKING_DISPLAYS as readonly string[]).includes(value)) {
    log.debug('Ignoring unsupported options.thinking_display', {
      thinking_display: typeof value === 'string' ? value.slice(0, 64) : typeof value,
    });
    return [];
  }
  if (!isVersionAtLeast(version, THINKING_DISPLAY_MIN_VERSION)) {
    log.debug(
      `Ignoring options.thinking_display: claude ${version ?? '(unknown version)'} predates ${THINKING_DISPLAY_FLAG} (${THINKING_DISPLAY_MIN_VERSION}+)`,
    );
    return [];
  }
  return [THINKING_DISPLAY_FLAG, value];
}
