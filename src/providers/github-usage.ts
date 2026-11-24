import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '../utils/logger.js';
import { stripCredentials } from './env.js';
import type { UsageAnswer } from './usage.js';

const log = createLogger('github-usage');

/** The provider name a usage_request uses to ask about GitHub rather than a CLI. */
export const GITHUB_USAGE_PROVIDER = 'github';

/** How long to wait on `gh` before giving up. Studio asks every few minutes; nobody waits on this. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Where `gh` keeps its sign-in, in `gh`'s own order: GH_CONFIG_DIR, then XDG_CONFIG_HOME/gh, then
 * %AppData%/GitHub CLI on Windows, then ~/.config/gh. The wrong file would name an older login.
 */
const GH_HOSTS = (): string => {
  const env = process.env;
  const dir =
    env['GH_CONFIG_DIR'] ||
    (env['XDG_CONFIG_HOME'] ? join(env['XDG_CONFIG_HOME'], 'gh') : '') ||
    (process.platform === 'win32' && env['AppData'] ? join(env['AppData'], 'GitHub CLI') : '') ||
    join(homedir(), '.config', 'gh');
  return join(dir, 'hosts.yml');
};

/**
 * What is left of the GitHub API allowance of the account this machine's AI sessions use.
 *
 * GitHub allows 5,000 calls an hour per ACCOUNT, shared by every session, machine and token of
 * that person, and only reports the total left. It keeps two such budgets, REST (`core`) and
 * GraphQL (`graphql`); both are reported. Asking costs nothing: `gh api rate_limit` is not
 * counted against the allowance, and the login is read from `gh`'s own sign-in file rather than
 * asked (`gh auth status` would cost a call). The token never leaves the machine; only figures do.
 *
 * `no_credential` when `gh` is missing, nobody is signed in, or GitHub refuses the token (HTTP
 * 401); `failed` for anything else, including a proxy that asks for its own sign-in (HTTP 407).
 */
export async function readGitHubUsage(run: RunGh = runGh): Promise<UsageAnswer> {
  let raw: string;
  try {
    raw = await run(['api', 'rate_limit']);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT' || /gh auth login|not logged in|HTTP 401\b/i.test(e.stderr ?? '')) {
      return { ok: false, reason: 'no_credential' };
    }
    log.debug('Could not read the GitHub rate limit', { error: e.message });
    return { ok: false, reason: 'failed' };
  }

  let resources: Record<string, Bucket | undefined> | undefined;
  try {
    resources = (JSON.parse(raw) as { resources?: Record<string, Bucket | undefined> }).resources;
  } catch {
    return { ok: false, reason: 'failed' };
  }

  // The login names the account only when gh used its own sign-in for these figures: with a
  // token in the environment, or another host, the figures belong to an account the hosts
  // file does not name. Then no name rather than a wrong one.
  const account = usesOwnSignIn() ? await activeGitHubLogin() : null;

  // GitHub keeps two hourly budgets per account and running out of either locks the person out
  // of part of their work: the REST API (`core`, Composer and most tools) and GraphQL
  // (`graphql`, spent by `gh pr` and friends). Each becomes its own entry; one that is missing
  // or unreadable is left out, and an answer with neither is `failed`.
  const limits = BUCKETS.flatMap(({ resource, label, kind }) => {
    const bucket = resources?.[resource];
    const limit = bucket?.limit;
    const remaining = bucket?.remaining;
    const reset = bucket?.reset;
    if (typeof limit !== 'number' || typeof remaining !== 'number' || limit <= 0) {
      return [];
    }

    return [
      {
        label,
        kind,
        percent: Math.min(100, Math.max(0, Math.round(((limit - remaining) / limit) * 100))),
        remaining,
        limit,
        ...(typeof reset === 'number' ? { resets_at: new Date(reset * 1000).toISOString() } : {}),
        ...(account ? { account } : {}),
      },
    ];
  });

  return limits.length > 0 ? { ok: true, limits } : { ok: false, reason: 'failed' };
}

type Bucket = { limit?: unknown; remaining?: unknown; reset?: unknown };

/** The budgets reported, in this order: `resources.<resource>` of `gh api rate_limit`. */
const BUCKETS = [
  { resource: 'core', label: 'GitHub API', kind: 'github_core' },
  { resource: 'graphql', label: 'GitHub GraphQL API', kind: 'github_graphql' },
] as const;

/** The active github.com login from `gh`'s hosts file, or null. Never calls GitHub. */
export async function activeGitHubLogin(path: string = GH_HOSTS()): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch {
    return null;
  }

  // hosts.yml: a `github.com:` block whose direct `user:` key (4 spaces in) is the active account.
  // Nested `users:` entries sit deeper and are never matched.
  const block = /^github\.com:\s*\n((?:[ \t]+.*\n?)*)/m.exec(text)?.[1] ?? '';
  const user = /^ {4}user:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/m.exec(block)?.[1];

  return user ?? null;
}

/** Whether gh answers from its own github.com sign-in, the one the hosts file names. */
function usesOwnSignIn(): boolean {
  const host = process.env['GH_HOST'];
  return !process.env['GH_TOKEN'] && !process.env['GITHUB_TOKEN'] && (!host || host === 'github.com');
}

export type RunGh = (args: string[]) => Promise<string>;

function runGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, {
        timeout: REQUEST_TIMEOUT_MS,
        // The bridge's own credentials never reach a spawned process.
        env: stripCredentials({ ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' }),
      }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stderr: String(stderr ?? '') }));
        return;
      }
      resolve(String(stdout));
    });
  });
}
