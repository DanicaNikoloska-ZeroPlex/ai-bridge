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

/** Where `gh` keeps its sign-in, honouring GH_CONFIG_DIR like `gh` itself does. */
const GH_HOSTS = () => join(process.env['GH_CONFIG_DIR'] || join(homedir(), '.config', 'gh'), 'hosts.yml');

/**
 * What is left of the GitHub API allowance of the account this machine's AI sessions use.
 *
 * GitHub allows 5,000 calls an hour per ACCOUNT, shared by every session, machine and token of
 * that person, and only reports the total left. Asking costs nothing: `gh api rate_limit` is not
 * counted against the allowance, and the login is read from `gh`'s own sign-in file rather than
 * asked (`gh auth status` would cost a call). The token never leaves the machine; only figures do.
 *
 * `no_credential` when `gh` is missing or nobody is signed in; `failed` for anything else.
 */
export async function readGitHubUsage(run: RunGh = runGh): Promise<UsageAnswer> {
  let raw: string;
  try {
    raw = await run(['api', 'rate_limit']);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT' || /auth login|not logged in|authentication|401|bad credentials/i.test(e.stderr ?? '')) {
      return { ok: false, reason: 'no_credential' };
    }
    log.debug('Could not read the GitHub rate limit', { error: e.message });
    return { ok: false, reason: 'failed' };
  }

  let core: { limit?: unknown; remaining?: unknown; reset?: unknown } | undefined;
  try {
    core = (JSON.parse(raw) as { resources?: { core?: typeof core } }).resources?.core;
  } catch {
    return { ok: false, reason: 'failed' };
  }

  const limit = core?.limit;
  const remaining = core?.remaining;
  const reset = core?.reset;
  if (typeof limit !== 'number' || typeof remaining !== 'number' || limit <= 0) {
    return { ok: false, reason: 'failed' };
  }

  // The login names the account only when gh used its own sign-in for these figures: with a
  // token in the environment, or another host, the figures belong to an account the hosts
  // file does not name. Then no name rather than a wrong one.
  const account = usesOwnSignIn() ? await activeGitHubLogin() : null;

  return {
    ok: true,
    limits: [
      {
        label: 'GitHub API',
        kind: 'github_core',
        percent: Math.min(100, Math.max(0, Math.round(((limit - remaining) / limit) * 100))),
        remaining,
        limit,
        ...(typeof reset === 'number' ? { resets_at: new Date(reset * 1000).toISOString() } : {}),
        ...(account ? { account } : {}),
      },
    ],
  };
}

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
