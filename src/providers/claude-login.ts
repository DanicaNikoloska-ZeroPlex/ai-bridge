/**
 * Named profiles of the Claude CLI's own sign-in, for one machine with two
 * Claude accounts.
 *
 * The CLI keeps its sign-in in `~/.claude/.credentials.json` (an OAuth access
 * token, a refresh token and their expiry). It reads that file whenever it
 * starts, and the bridge's usage report reads it on every ask, so putting
 * another account's file in place switches both from the next run on, with
 * no bridge restart. Profiles are stored beside it:
 *
 *   ~/.claude/credentials-profiles/          0700
 *   ~/.claude/credentials-profiles/<name>.json   0600, a copy of the file
 *   ~/.claude/credentials-profiles/active        the name last saved or used
 *
 * Refresh tokens rotate: the CLI rewrites the file whenever it refreshes, and
 * the copy in a profile goes stale (its old refresh token may stop working).
 * So switching first copies the current file back into the profile it belongs
 * to, then puts the chosen one in place. Which profile the current file belongs
 * to: the one holding the same tokens (or account id, when the file carries
 * one), else the one recorded as active. A sign-in that is neither is never
 * overwritten silently: switching refuses until it is saved or discarded.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { writePrivateFile } from './claude-token.js';

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ACTIVE_FILE = 'active';

export interface ClaudeLoginPaths {
  credentials: string;
  profiles: string;
}

export function claudeLoginPaths(home: string = homedir()): ClaudeLoginPaths {
  const dir = join(home, '.claude');
  return { credentials: join(dir, '.credentials.json'), profiles: join(dir, 'credentials-profiles') };
}

/** What identifies the account a credentials file signs in as. Never shown. */
interface Identity { account: string | null; access: string | null; refresh: string | null }

function identityOf(text: string): Identity | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const oauth = (parsed as Record<string, unknown>)['claudeAiOauth'];
  if (typeof oauth !== 'object' || oauth === null) return null;
  const o = oauth as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  return { account: str(o['accountUuid']) ?? str(o['emailAddress']), access: str(o['accessToken']), refresh: str(o['refreshToken']) };
}

function sameAccount(a: Identity, b: Identity): boolean {
  if (a.account && b.account) return a.account === b.account;
  return (!!a.refresh && a.refresh === b.refresh) || (!!a.access && a.access === b.access);
}

function checkName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!NAME.test(name)) throw new Error(`"${raw}" is not a profile name: use letters, digits, - and _ (at most 40)`);
  return name;
}

function readIfThere(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function profileNames(paths: ClaudeLoginPaths): string[] {
  if (!existsSync(paths.profiles)) return [];
  return readdirSync(paths.profiles)
    .filter((f) => f.endsWith('.json') && NAME.test(f.slice(0, -5)))
    .map((f) => f.slice(0, -5))
    .sort();
}

function profilePath(paths: ClaudeLoginPaths, name: string): string {
  return join(paths.profiles, `${name}.json`);
}

/** Give what this command made the owner of ~/.claude, so a run under `sudo`
 *  does not leave the profiles to root. */
function ownLikeClaudeDir(paths: ClaudeLoginPaths, path: string): void {
  if (process.platform === 'win32') return;
  const ref = statSync(dirname(paths.profiles));
  if (process.getuid?.() !== ref.uid) chownSync(path, ref.uid, ref.gid);
}

function ensureProfilesDir(paths: ClaudeLoginPaths): void {
  mkdirSync(paths.profiles, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(paths.profiles, 0o700);
  ownLikeClaudeDir(paths, paths.profiles);
}

function recordActive(paths: ClaudeLoginPaths, name: string): void {
  const path = join(paths.profiles, ACTIVE_FILE);
  writeFileSync(path, `${name}\n`, { mode: 0o600 });
  ownLikeClaudeDir(paths, path);
}

/** Write a profile file, private and owned like ~/.claude. */
function writeProfile(paths: ClaudeLoginPaths, file: string, text: string): void {
  writePrivateFile(file, text);
  ownLikeClaudeDir(paths, file);
}

function recordedActive(paths: ClaudeLoginPaths): string | null {
  const raw = readIfThere(join(paths.profiles, ACTIVE_FILE))?.trim().toLowerCase() ?? '';
  return NAME.test(raw) && existsSync(profilePath(paths, raw)) ? raw : null;
}

/** The current credentials file, refusing one that is not a Claude sign-in. */
function readCurrent(paths: ClaudeLoginPaths): { text: string; id: Identity } | null {
  const text = readIfThere(paths.credentials);
  if (text === null) return null;
  const id = identityOf(text);
  if (!id) throw new Error(`${paths.credentials} is not a Claude sign-in this command understands; nothing was changed`);
  return { text, id };
}

/** The profile the current sign-in belongs to: same tokens or account first,
 *  else the one recorded as active. */
function ownerOf(paths: ClaudeLoginPaths, id: Identity): { name: string; how: 'match' | 'recorded' } | null {
  for (const name of profileNames(paths)) {
    const other = identityOf(readFileSync(profilePath(paths, name), 'utf8'));
    if (other && sameAccount(id, other)) return { name, how: 'match' };
  }
  const recorded = recordedActive(paths);
  return recorded ? { name: recorded, how: 'recorded' } : null;
}

export interface ClaudeLoginListing {
  credentials: string;
  signedIn: boolean;
  profiles: string[];
  /** The profile the current sign-in belongs to, and how that was decided. */
  active: { name: string; how: 'match' | 'recorded' } | null;
}

/** Profile names and which is active. Never a value. */
export function listClaudeLogins(home?: string): ClaudeLoginListing {
  const paths = claudeLoginPaths(home);
  const current = readCurrent(paths);
  return {
    credentials: paths.credentials,
    signedIn: current !== null,
    profiles: profileNames(paths),
    active: current ? ownerOf(paths, current.id) : null,
  };
}

/** Store the current sign-in as profile `name` (replacing one of that name). */
export function saveClaudeLogin(rawName: string, home?: string): { name: string; replaced: boolean } {
  const name = checkName(rawName);
  const paths = claudeLoginPaths(home);
  const current = readCurrent(paths);
  if (!current) throw new Error(`there is no Claude sign-in at ${paths.credentials}: sign in first with \`claude /login\``);
  for (const other of profileNames(paths)) {
    if (other === name) continue;
    const id = identityOf(readFileSync(profilePath(paths, other), 'utf8'));
    if (id && sameAccount(current.id, id)) throw new Error(`this sign-in is already saved as "${other}"; sign in with the other account (\`claude /login\`) before saving it`);
  }
  ensureProfilesDir(paths);
  const target = profilePath(paths, name);
  const replaced = existsSync(target);
  writeProfile(paths, target, current.text);
  recordActive(paths, name);
  return { name, replaced };
}

export interface ClaudeLoginSwitch {
  name: string;
  /** The profile the previous sign-in was copied back into, if any. */
  savedBack: string | null;
  /** True when the chosen profile was already the sign-in in place. */
  already: boolean;
  /** Where the copy the save-back replaced was kept, when the owner was only
   *  the recorded name (a refresh, or a `claude /login` nobody saved). */
  kept: string | null;
}

/**
 * Put profile `name` in place as the CLI's sign-in. First copies the current
 * sign-in back into the profile it belongs to, so its rotated refresh token is
 * not lost; refuses when it belongs to none, unless `discardCurrent`.
 */
export function useClaudeLogin(rawName: string, opts: { home?: string; discardCurrent?: boolean } = {}): ClaudeLoginSwitch {
  const name = checkName(rawName);
  const paths = claudeLoginPaths(opts.home);
  const names = profileNames(paths);
  if (!names.includes(name)) {
    throw new Error(names.length
      ? `there is no profile named "${rawName}". Profiles: ${names.join(', ')}`
      : 'there are no profiles yet: sign in (`claude /login`) and run `ai-bridge claude-login save <name>` for each account');
  }
  const chosen = readFileSync(profilePath(paths, name), 'utf8');
  if (!identityOf(chosen)) throw new Error(`profile "${name}" is not a Claude sign-in this command understands; nothing was changed`);

  const current = readCurrent(paths);
  let savedBack: string | null = null;
  let kept: string | null = null;
  if (current) {
    const owner = ownerOf(paths, current.id);
    if (owner) {
      const file = profilePath(paths, owner.name);
      const stored = readFileSync(file, 'utf8');
      if (stored !== current.text) {
        // Matched only by the recorded name: the tokens may have been refreshed,
        // or this may be another account signed in with `claude /login` and
        // never saved. The two look the same, so the copy being replaced is
        // kept one generation back rather than lost.
        if (owner.how === 'recorded') {
          kept = `${file}.prev`;
          writeProfile(paths, kept, stored);
        }
        writeProfile(paths, file, current.text);
      }
      savedBack = owner.name;
      // A Claude process may refresh while this runs: whatever it wrote is
      // saved too before the file is replaced, so its new refresh token is kept.
      let saved = current.text;
      for (let i = 0; i < 3 && savedBack !== name; i++) {
        const now = readIfThere(paths.credentials);
        if (now === null || now === saved || !identityOf(now)) break;
        writeProfile(paths, file, now);
        saved = now;
      }
    } else if (!opts.discardCurrent) {
      throw new Error('the current Claude sign-in is not saved as any profile. Save it first (`ai-bridge claude-login save <name>`), or pass --discard-current to replace it anyway');
    }
  }
  if (savedBack === name) {
    recordActive(paths, name);
    return { name, savedBack, already: true, kept };
  }
  try {
    writePrivateFile(paths.credentials, chosen);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EBUSY') throw new Error(`could not replace ${paths.credentials} (${code}): close Claude and try again`);
    throw err;
  }
  recordActive(paths, name);
  return { name, savedBack, already: false, kept };
}

/** How many Claude CLI processes this user runs besides this one; null
 *  when that cannot be told here. Only a count: nothing about them is read
 *  beyond their name. */
export function runningClaudeProcesses(): number | null {
  if (process.platform === 'win32') return null;
  if (existsSync('/proc/self/comm')) {
    let count = 0;
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      try {
        if (readFileSync(`/proc/${entry}/comm`, 'utf8').trim() !== 'claude') continue;
        // Only this user's: another user's Claude has a sign-in of its own.
        if (statSync(`/proc/${entry}`).uid === process.getuid?.()) count++;
      } catch { /* gone, or not ours to read */ }
    }
    return count;
  }
  const res = spawnSync('pgrep', ['-x', '-u', String(process.getuid?.() ?? ''), 'claude'], { encoding: 'utf8', timeout: 3000 });
  if (res.error || (res.status !== 0 && res.status !== 1)) return null;
  return res.stdout.split('\n').filter((l) => l.trim() !== '' && Number(l) !== process.pid).length;
}
