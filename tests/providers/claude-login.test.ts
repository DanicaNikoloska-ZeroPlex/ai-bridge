import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  claudeLoginPaths, listClaudeLogins, saveClaudeLogin, useClaudeLogin,
} from '../../src/providers/claude-login.js';
import { readClaudeUsage } from '../../src/providers/usage.js';

/**
 * One machine, two Claude accounts: the CLI's own sign-in is swapped by
 * profile, so the bridge's runs and its usage report (both read
 * ~/.claude/.credentials.json) follow it without a restart.
 */
describe('Claude sign-in profiles', () => {
  let home: string;
  let paths: ReturnType<typeof claudeLoginPaths>;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'claude-login-'));
    paths = claudeLoginPaths(home);
    mkdirSync(join(home, '.claude'), { mode: 0o700 });
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  const creds = (access: string, refresh: string): string =>
    JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: 1, scopes: ['user:inference'] } });
  const signIn = (access: string, refresh: string): void => {
    writeFileSync(paths.credentials, creds(access, refresh), { mode: 0o600 });
  };
  const current = (): string => readFileSync(paths.credentials, 'utf8');
  const profile = (name: string): string => readFileSync(join(paths.profiles, `${name}.json`), 'utf8');
  const mode = (path: string): number => statSync(path).mode & 0o777;

  /** Signs in as work, saves; signs in as home, saves. */
  const twoAccounts = (): void => {
    signIn('acc-work-1', 'ref-work-1');
    saveClaudeLogin('work', home);
    signIn('acc-home-1', 'ref-home-1');
    saveClaudeLogin('home', home);
  };

  test('save stores the sign-in in a 0700 directory as a 0600 file, and list shows it active', () => {
    signIn('acc-work-1', 'ref-work-1');
    expect(saveClaudeLogin('Work', home)).toEqual({ name: 'work', replaced: false });
    expect(profile('work')).toBe(current());
    if (process.platform !== 'win32') {
      expect(mode(paths.profiles)).toBe(0o700);
      expect(mode(join(paths.profiles, 'work.json'))).toBe(0o600);
    }
    expect(listClaudeLogins(home)).toMatchObject({ signedIn: true, profiles: ['work'], active: { name: 'work', how: 'match' } });
  });

  test('use swaps the sign-in in place and list follows it', () => {
    twoAccounts();
    const result = useClaudeLogin('work', { home });
    expect(result).toEqual({ name: 'work', savedBack: 'home', already: false });
    expect(current()).toBe(creds('acc-work-1', 'ref-work-1'));
    expect(listClaudeLogins(home).active).toEqual({ name: 'work', how: 'match' });
  });

  test('switching first copies the refreshed sign-in back into its own profile', () => {
    twoAccounts();
    useClaudeLogin('work', { home });
    // Claude refreshed: both tokens rotated, so nothing matches by token any more.
    signIn('acc-work-2', 'ref-work-2');
    expect(listClaudeLogins(home).active).toEqual({ name: 'work', how: 'recorded' });
    const result = useClaudeLogin('home', { home });
    expect(result.savedBack).toBe('work');
    expect(profile('work')).toBe(creds('acc-work-2', 'ref-work-2'));
    expect(current()).toBe(creds('acc-home-1', 'ref-home-1'));
    // And back: home's copy is current, work gets its rotated tokens.
    useClaudeLogin('work', { home });
    expect(current()).toBe(creds('acc-work-2', 'ref-work-2'));
  });

  test.skipIf(process.platform === 'win32')('the swap is atomic and keeps the file 0600, leaving no temp files', () => {
    twoAccounts();
    chmodSync(paths.credentials, 0o600);
    const before = statSync(paths.credentials).ino;
    useClaudeLogin('work', { home });
    expect(mode(paths.credentials)).toBe(0o600);
    expect(statSync(paths.credentials).ino).not.toBe(before); // renamed over, not rewritten in place
    expect(readdirSync(join(home, '.claude')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(paths.profiles).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('a sign-in saved as no profile is never overwritten silently', () => {
    twoAccounts();
    rmSync(join(paths.profiles, 'active'));
    signIn('acc-third', 'ref-third');
    expect(() => useClaudeLogin('work', { home })).toThrow(/not saved as any profile/);
    expect(current()).toBe(creds('acc-third', 'ref-third'));
    useClaudeLogin('work', { home, discardCurrent: true });
    expect(current()).toBe(creds('acc-work-1', 'ref-work-1'));
  });

  test('an unknown profile is refused with the names there are, and nothing changes', () => {
    twoAccounts();
    const before = current();
    expect(() => useClaudeLogin('play', { home })).toThrow(/no profile named "play". Profiles: home, work/);
    expect(() => useClaudeLogin('../x', { home })).toThrow(/not a profile name/);
    expect(current()).toBe(before);
  });

  test('saving the same account under a second name is refused', () => {
    signIn('acc-work-1', 'ref-work-1');
    saveClaudeLogin('work', home);
    expect(() => saveClaudeLogin('other', home)).toThrow(/already saved as "work"/);
  });

  test('save without a sign-in, or of a file that is not one, is refused', () => {
    expect(() => saveClaudeLogin('work', home)).toThrow(/claude \/login/);
    writeFileSync(paths.credentials, 'not json', { mode: 0o600 });
    expect(() => saveClaudeLogin('work', home)).toThrow(/not a Claude sign-in/);
  });

  test('the listing carries names only, never a token', () => {
    twoAccounts();
    const text = JSON.stringify(listClaudeLogins(home));
    for (const secret of ['acc-work-1', 'ref-work-1', 'acc-home-1', 'ref-home-1']) expect(text).not.toContain(secret);
  });

  test("the bridge's usage report asks about the account switched to, without a restart", async () => {
    twoAccounts();
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers['authorization']!);
      return { ok: true, status: 200, json: async () => ({ limits: [] }) };
    }));
    const oldHome = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      useClaudeLogin('work', { home });
      await readClaudeUsage();
      useClaudeLogin('home', { home });
      await readClaudeUsage();
    } finally {
      process.env['HOME'] = oldHome;
      vi.unstubAllGlobals();
    }
    expect(seen).toEqual(['Bearer acc-work-1', 'Bearer acc-home-1']);
  });
});
