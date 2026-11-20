/**
 * A refreshed connection token is saved to the file the bridge's token came
 * from, so a restart past the original token's expiry is not refused.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateTokenFile, saveToken, tokenIn, type DetectDeps } from '../../src/selfupdate/service.js';

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
    expect(statSync(path).mode & 0o777).toBe(0o600);
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
