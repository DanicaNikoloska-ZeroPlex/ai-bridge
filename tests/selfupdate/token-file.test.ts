/**
 * A refreshed connection token is saved to the file the bridge's token came
 * from, so a restart past the original token's expiry is not refused.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateTokenFile, saveToken, tokenIn, tokenSaver, type DetectDeps } from '../../src/selfupdate/service.js';

const CGROUP = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/ai-bridge-studio.service\n';
const ENV = '/home/u/.config/ai-bridge-studio.env';
const OTHER = '/home/u/.config/other.env';
const showWith = (...files: string[]): string => [
  'Restart=always',
  ...files.map((f) => `EnvironmentFiles=${f} (ignore_errors=no)`),
  '',
].join('\n');

function deps(files: Record<string, string>, over: Partial<DetectDeps> = {}): DetectDeps {
  return {
    env: { INVOCATION_ID: 'abc' },
    platform: 'linux',
    readCgroup: () => CGROUP,
    showUnit: () => showWith(...Object.keys(files)),
    readFile: (p) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p]!;
    },
    writable: () => true,
    ...over,
  };
}

describe('reading the token out of an env file', () => {
  it('takes the last assignment, unquoted, with or without export', () => {
    expect(tokenIn('AI_BRIDGE_TOKEN=a\nX=1\n')).toBe('a');
    expect(tokenIn('export AI_BRIDGE_TOKEN="b"\n')).toBe('b');
    expect(tokenIn("AI_BRIDGE_TOKEN=a\nAI_BRIDGE_TOKEN='c'\n")).toBe('c');
    expect(tokenIn('AI_BRIDGE_SERVER=x\n')).toBeNull();
  });

  it('reads a file with Windows line endings', () => {
    expect(tokenIn('AI_BRIDGE_SERVER=x\r\nAI_BRIDGE_TOKEN=a\r\n')).toBe('a');
    expect(tokenIn('AI_BRIDGE_TOKEN="b"\r\n')).toBe('b');
  });
});

describe('which file a refreshed token is saved to', () => {
  it('the unit env file that holds the token the bridge runs with', () => {
    expect(locateTokenFile('t1', undefined, deps({ [OTHER]: 'X=1\n', [ENV]: 'AI_BRIDGE_TOKEN=t1\n' }))).toEqual({ file: ENV });
  });

  it('--env-file, when given, without asking systemd', () => {
    const d = deps({ [ENV]: 'AI_BRIDGE_TOKEN=t1\n' }, { env: {}, readCgroup: () => { throw new Error('no'); } });
    expect(locateTokenFile('t1', ENV, d)).toEqual({ file: ENV });
  });

  it('AI_BRIDGE_ENV_FILE, when set', () => {
    const d = deps({ [ENV]: 'AI_BRIDGE_TOKEN=t1\n', [OTHER]: 'AI_BRIDGE_TOKEN=t1\n' }, { env: { INVOCATION_ID: 'abc', AI_BRIDGE_ENV_FILE: OTHER } });
    expect(locateTokenFile('t1', undefined, d)).toEqual({ file: OTHER });
  });

  const no = (r: ReturnType<typeof locateTokenFile>, why: RegExp): void => {
    expect('reason' in r ? r.reason : 'file').toMatch(why);
  };

  it('none, when the token came from somewhere else (--token, another variable)', () =>
    no(locateTokenFile('from-flag', undefined, deps({ [ENV]: 'AI_BRIDGE_TOKEN=t1\n' })), /not the AI_BRIDGE_TOKEN/));
  it('none, in a terminal without --env-file', () =>
    no(locateTokenFile('t1', undefined, deps({ [ENV]: 'AI_BRIDGE_TOKEN=t1\n' }, { env: {} })), /not running as a systemd service/));
  it('none, on a machine without systemd and without --env-file, saying so', () =>
    no(locateTokenFile('t1', undefined, deps({ [ENV]: 'AI_BRIDGE_TOKEN=t1\n' }, { platform: 'darwin' })), /no --env-file or AI_BRIDGE_ENV_FILE/));
  it('none, when AI_BRIDGE_ENV_FILE holds another token, naming that file', () =>
    no(locateTokenFile('t1', undefined, deps({ [OTHER]: 'AI_BRIDGE_TOKEN=t0\n' }, { env: { AI_BRIDGE_ENV_FILE: OTHER } })), /not the AI_BRIDGE_TOKEN in .*other\.env/));
  it('none, when two files hold it', () =>
    no(locateTokenFile('t1', undefined, deps({ [ENV]: 'AI_BRIDGE_TOKEN=t1\n', [OTHER]: 'AI_BRIDGE_TOKEN=t1\n' })), /more than one/));
  it('none, when the file is not writable', () =>
    no(locateTokenFile('t1', undefined, deps({ [ENV]: 'AI_BRIDGE_TOKEN=t1\n' }, { writable: () => false })), /not writable/));
});

describe('saving a refreshed token', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const file = (content: string): string => {
    dir = mkdtempSync(join(tmpdir(), 'aib-token-'));
    const path = join(dir, 'bridge.env');
    writeFileSync(path, content);
    chmodSync(path, 0o600);
    return path;
  };

  it('replaces only the token line and keeps the file mode', () => {
    const path = file('AI_BRIDGE_SERVER=wss://x\nAI_BRIDGE_TOKEN=old.jwt.sig\nAI_BRIDGE_VERSION=0.43.0\n');
    expect(saveToken(path, 'old.jwt.sig', 'new.jwt-sig_2')).toBe('saved');
    expect(readFileSync(path, 'utf8')).toBe('AI_BRIDGE_SERVER=wss://x\nAI_BRIDGE_TOKEN=new.jwt-sig_2\nAI_BRIDGE_VERSION=0.43.0\n');
    // Windows has no separate group and other bits to keep.
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['bridge.env']);
  });

  it('keeps export, quotes, Windows line endings and the other lines as they were', () => {
    const path = file('export AI_BRIDGE_TOKEN="old"\r\nX=1\r\n');
    expect(saveToken(path, 'old', 'new')).toBe('saved');
    expect(readFileSync(path, 'utf8')).toBe('export AI_BRIDGE_TOKEN="new"\r\nX=1\r\n');
    expect(tokenIn(readFileSync(path, 'utf8'))).toBe('new');
  });

  it('replaces the last assignment, the one systemd uses', () => {
    const path = file('AI_BRIDGE_TOKEN=stale\nAI_BRIDGE_TOKEN=old\n');
    expect(saveToken(path, 'old', 'new')).toBe('saved');
    expect(readFileSync(path, 'utf8')).toBe('AI_BRIDGE_TOKEN=stale\nAI_BRIDGE_TOKEN=new\n');
  });

  it('saves refresh after refresh, each against the token it saved last', () => {
    const path = file('AI_BRIDGE_TOKEN=t0\n');
    const save = tokenSaver(path, 't0');
    expect(save('t1')).toBe('saved');
    expect(save('t2')).toBe('saved');
    expect(readFileSync(path, 'utf8')).toBe('AI_BRIDGE_TOKEN=t2\n');
  });

  it('once somebody installed another token, keeps leaving it alone', () => {
    const path = file('AI_BRIDGE_TOKEN=t0\n');
    const save = tokenSaver(path, 't0');
    expect(save('t1')).toBe('saved');
    writeFileSync(path, 'AI_BRIDGE_TOKEN=reinstalled\n');
    expect(save('t2')).toBe('changed');
    expect(save('t3')).toBe('changed');
    expect(readFileSync(path, 'utf8')).toBe('AI_BRIDGE_TOKEN=reinstalled\n');
  });

  it('a failed save leaves the file, no temporary copy, and is tried again on the next refresh', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return; // a read-only directory stops neither
    const path = file('AI_BRIDGE_TOKEN=t0\n');
    const save = tokenSaver(path, 't0');
    chmodSync(dir, 0o500);
    try {
      expect(() => save('t1')).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readdirSync(dir)).toEqual(['bridge.env']);
    expect(readFileSync(path, 'utf8')).toBe('AI_BRIDGE_TOKEN=t0\n');
    expect(save('t2')).toBe('saved');
    expect(readFileSync(path, 'utf8')).toBe('AI_BRIDGE_TOKEN=t2\n');
  });

  it('never puts the token in the error it throws', () => {
    const path = file('AI_BRIDGE_TOKEN=old\n');
    expect(() => saveToken(path, 'old', 'secret value')).toThrow(/^(?!.*secret).*$/);
  });

  it('leaves a token somebody installed since the bridge started', () => {
    const path = file('AI_BRIDGE_TOKEN=reinstalled\n');
    expect(saveToken(path, 'old', 'refreshed')).toBe('changed');
    expect(readFileSync(path, 'utf8')).toBe('AI_BRIDGE_TOKEN=reinstalled\n');
  });

  it('refuses a value that would break the line', () => {
    const path = file('AI_BRIDGE_TOKEN=old\n');
    expect(() => saveToken(path, 'old', 'a\nAI_BRIDGE_SERVER=evil')).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('AI_BRIDGE_TOKEN=old\n');
  });
});
