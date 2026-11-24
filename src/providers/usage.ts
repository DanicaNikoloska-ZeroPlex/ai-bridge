import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '../utils/logger.js';
import { currentClaudeToken } from './claude-token.js';

const log = createLogger('usage');

/** How long to wait on the vendor before giving up. A panel is waiting on this. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * One allowance window, already named.
 *
 * The label is composed here rather than by whoever asked, because this is the layer that
 * knows which CLI answered and what its vocabulary means. A consumer renders the list as
 * given, so a window kind nobody has seen yet still arrives with something readable on it.
 */
export interface UsageLimit {
  /** Human-readable, e.g. "Current session", "This week", "Fable this week". */
  label: string;
  /** Whole percent of the allowance consumed, 0-100. */
  percent: number;
  /** ISO 8601 instant at which this allowance refills, when the CLI says. */
  resets_at?: string;
  /** The CLI's own identifier for the window, passed through untranslated. */
  kind?: string;
  /** Coarse grouping the CLI puts the window in (e.g. session, weekly). */
  group?: string;
  /** Calls left in this window, for allowances counted in calls (GitHub). */
  remaining?: number;
  /** Size of the window, for allowances counted in calls (GitHub). */
  limit?: number;
  /** The account the allowance belongs to, when it is not the CLI's own (GitHub login). */
  account?: string;
}

export type UsageAnswer =
  | { ok: true; limits: UsageLimit[] }
  /**
   * `unsupported` — this CLI has no notion of a subscription allowance.
   * `no_credential` — it has one, but nobody is signed in (or the sign-in expired).
   * `failed` — it tried and could not.
   */
  | { ok: false; reason: 'unsupported' | 'no_credential' | 'failed' };

/** Where the Claude CLI keeps the credential it signs in with. */
const CLAUDE_CREDENTIALS = () => join(homedir(), '.claude', '.credentials.json');

/**
 * Read what is left of the subscription the Claude CLI on THIS machine is signed in as.
 *
 * The credential never leaves here. This reads it, calls the vendor, and returns only the
 * resulting figures, which is the whole reason the bridge does the asking rather than the
 * server that wanted to know.
 *
 * The token is re-read on every call, deliberately: the CLI refreshes it in place, so a
 * cached copy goes stale and starts failing for no visible reason.
 */
export async function readClaudeUsage(): Promise<UsageAnswer> {
  let accessToken: string;

  // A long-lived token in use (from the environment or the active one in the
  // token file) is the account Claude runs bill to, so its allowance is the one
  // asked about; the CLI's own sign-in may be a different account entirely.
  // When the vendor refuses to answer for that token, the answer is
  // no_credential, never the other account's figures.
  const longLived = currentClaudeToken();
  if (longLived) return askUsage(longLived);

  try {
    const raw = await readFile(CLAUDE_CREDENTIALS(), 'utf-8');
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } };
    const token = parsed.claudeAiOauth?.accessToken;

    if (typeof token !== 'string' || token === '') {
      log.debug('Claude credentials present but carry no access token');
      return { ok: false, reason: 'no_credential' };
    }

    accessToken = token;
  } catch (err) {
    // Not signed in, or signed in some other way. Not an error worth shouting about: it is
    // a normal state for a machine whose operator has not run `claude auth login`.
    log.debug('Could not read Claude credentials', { error: (err as Error).message });
    return { ok: false, reason: 'no_credential' };
  }

  return askUsage(accessToken);
}

/** The vendor's figures for one access token. */
async function askUsage(accessToken: string): Promise<UsageAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        authorization: `Bearer ${accessToken}`,
        // An OAuth subscription token is only accepted on this beta header; without it the
        // request is refused as if the credential were wrong.
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'no_credential' };
    }

    if (!res.ok) {
      log.debug('Usage endpoint refused', { status: res.status });
      return { ok: false, reason: 'failed' };
    }

    const body = (await res.json()) as { limits?: unknown };

    if (!Array.isArray(body.limits)) {
      log.debug('Usage response carried no limits array');
      return { ok: false, reason: 'failed' };
    }

    return { ok: true, limits: body.limits.map(toLimit).filter((l): l is UsageLimit => l !== null) };
  } catch (err) {
    log.debug('Could not read usage', { error: (err as Error).message });
    return { ok: false, reason: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

/** One vendor entry, narrowed to what a reader needs and named. Null when unusable. */
function toLimit(entry: unknown): UsageLimit | null {
  if (typeof entry !== 'object' || entry === null) return null;

  const row = entry as Record<string, unknown>;
  const percent = row['percent'];

  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;

  const kind = typeof row['kind'] === 'string' ? row['kind'] : undefined;
  const group = typeof row['group'] === 'string' ? row['group'] : undefined;
  const resetsAt = typeof row['resets_at'] === 'string' ? row['resets_at'] : undefined;

  return {
    label: labelFor(kind, scopedModel(row)),
    percent: Math.round(Math.max(0, Math.min(100, percent))),
    ...(resetsAt ? { resets_at: resetsAt } : {}),
    ...(kind ? { kind } : {}),
    ...(group ? { group } : {}),
  };
}

/** The model a window is scoped to, when it is scoped to one. */
function scopedModel(row: Record<string, unknown>): string | undefined {
  const scope = row['scope'];
  if (typeof scope !== 'object' || scope === null) return undefined;

  const model = (scope as Record<string, unknown>)['model'];
  if (typeof model !== 'object' || model === null) return undefined;

  const name = (model as Record<string, unknown>)['display_name'];
  return typeof name === 'string' && name !== '' ? name : undefined;
}

/**
 * Put words on a window.
 *
 * Deliberately falls through to a readable default rather than dropping a kind it has not
 * met: which allowances exist, and which model gets one of its own, is the vendor's to
 * change, and a window that renders as nothing is worse than one named a little plainly.
 * Nothing downstream needs updating when a new kind appears.
 */
function labelFor(kind: string | undefined, model: string | undefined): string {
  if (model) {
    return `${model} this week`;
  }

  switch (kind) {
    case 'session':
      return 'Current session';
    case 'weekly_all':
      return 'This week';
    default:
      return humanise(kind);
  }
}

/** `some_new_window` -> `Some new window`. */
function humanise(kind: string | undefined): string {
  if (!kind) return 'Usage';

  const words = kind.replace(/[_-]+/g, ' ').trim();

  return words === '' ? 'Usage' : words.charAt(0).toUpperCase() + words.slice(1);
}
