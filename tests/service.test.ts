import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { nameFromServer, normaliseName } from '../src/service/naming.js';
import { deviceOf, readConfig, replaceable, writeConfig } from '../src/service/config.js';
import { configForInstall } from '../src/service/index.js';
import { ATTACHMENT_OPTIONS } from '../src/attachments/options.js';
import { readFileSync } from 'node:fs';

/**
 * What these pin is the rule the whole module exists for: a second install
 * JOINS unless it is plainly the same install again.
 *
 * Before it, every install wrote the same two fixed paths, so pointing a
 * machine at a test server overwrote its production credentials -- and reported
 * success, because nothing restarts a running service on `enable --now`. The
 * machine went on answering the old server until the next reboot, and then
 * answered the new one, with the old pairing gone.
 */

describe('what an install is called', () => {
  test('defaults to the server, so one bridge per server', () => {
    expect(nameFromServer('wss://engram.dev.tetrix.dev/bridge?device=abc')).toBe('engram-dev-tetrix-dev');
    expect(nameFromServer('wss://engram.tetrix.dev/bridge?device=abc')).toBe('engram-tetrix-dev');
  });

  test('two servers never collide, which is the whole point', () => {
    const a = nameFromServer('wss://engram.tetrix.dev/bridge?device=1');
    const b = nameFromServer('wss://engram.dev.tetrix.dev/bridge?device=2');
    expect(a).not.toBe(b);
  });

  test('a name somebody typed is held to a shape a unit file accepts', () => {
    expect(normaliseName('My Laptop')).toBe('my-laptop');
    expect(normaliseName('repo/b')).toBe('repo-b');
    // Rejected rather than mangled into something unrecognisable: the name is
    // how somebody finds this service again.
    expect(() => normaliseName('///')).toThrow(/no letters or digits/);
    expect(() => normaliseName('x'.repeat(61))).toThrow(/too long/);
  });
});

describe('when an install may replace what is already there', () => {
  const prod = { server: 'wss://engram.tetrix.dev/bridge?device=aaa', token: 't1' };
  const staging = { server: 'wss://engram.dev.tetrix.dev/bridge?device=bbb', token: 't2' };

  test('the same server as the same machine is the same install', () => {
    expect(replaceable(prod, { ...prod, token: 'rotated' })).toBe(true);
  });

  test('a different server is refused, and names both', () => {
    const verdict = replaceable(prod, staging);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain('engram.tetrix.dev');
    expect(String(verdict)).toContain('engram.dev.tetrix.dev');
  });

  test('the same server as a different machine is refused too', () => {
    const other = { server: 'wss://engram.tetrix.dev/bridge?device=zzz', token: 't3' };
    expect(replaceable(prod, other)).not.toBe(true);
  });

  test('the device is read from the address rather than written down twice', () => {
    expect(deviceOf(prod.server)).toBe('aaa');
    expect(deviceOf('not a url')).toBeNull();
  });
});

describe('the credentials file', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bridge-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('round trips, and keeps the folder somebody chose', () => {
    const path = join(dir, 'x.env');
    writeConfig(path, { server: 'wss://h/bridge?device=1', token: 'secret', allowDir: '/home/me/work' });
    expect(readConfig(path)).toEqual({
      server: 'wss://h/bridge?device=1', token: 'secret', allowDir: '/home/me/work',
    });
  });

  test('is readable only by its owner: a token is not for everyone on the box', () => {
    const path = join(dir, 'y.env');
    writeConfig(path, { server: 'wss://h/bridge?device=1', token: 'secret' });
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  test('an existing file is locked down too, not left as it was found', () => {
    const path = join(dir, 'loose.env');
    writeFileSync(path, 'AI_BRIDGE_SERVER=x\nAI_BRIDGE_TOKEN=y\n', { mode: 0o644 });
    writeConfig(path, { server: 'wss://h/bridge?device=1', token: 'secret' });
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  test('a file with nothing usable in it reads as absent, not as empty settings', () => {
    const path = join(dir, 'z.env');
    writeFileSync(path, '# a comment\nNOT_OURS=1\n');
    expect(readConfig(path)).toBeNull();
    expect(readConfig(join(dir, 'missing.env'))).toBeNull();
  });
});

describe('settings an install carries', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bridge-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('every attachment setting has a flag and an environment variable, and round trips through the file', () => {
    // The size caps used to have a flag and no variable, so a setup that wrote
    // AI_BRIDGE_ATTACHMENT_MAX_MB into this file changed nothing.
    const settings: Record<string, string> = {};
    for (const [i, option] of ATTACHMENT_OPTIONS.entries()) {
      expect(option.flag).toMatch(/^--attachment-[a-z-]+ <n>$/);
      expect(option.env).toMatch(/^AI_BRIDGE_ATTACHMENT_[A-Z_]+$/);
      settings[option.env] = String(i + 1);
    }
    const path = join(dir, 'x.env');
    writeConfig(path, { server: 'wss://h/bridge', token: 't', name: 'h', settings });
    expect(readConfig(path)).toEqual({ server: 'wss://h/bridge', token: 't', allowDir: undefined, name: 'h', settings });
  });

  test('records the install name, which keys its attachment store', () => {
    const path = join(dir, 'n.env');
    writeConfig(path, { server: 'wss://h/bridge', token: 't', name: 'repo-a' });
    expect(readFileSync(path, 'utf8')).toContain('AI_BRIDGE_NAME=repo-a');
  });

  test('a reinstall keeps the settings it is not given again', () => {
    // Rotating a token is a reinstall; it must not reset the caps.
    const existing = {
      server: 'wss://h/bridge', token: 'old',
      settings: { AI_BRIDGE_ATTACHMENT_MAX_MB: '500', AI_BRIDGE_ATTACHMENT_TOTAL_MB: '2000' },
    };
    const next = configForInstall(
      { server: 'wss://h/bridge', token: 'new', settings: { AI_BRIDGE_ATTACHMENT_TOTAL_MB: '4000' } },
      'h',
      existing,
    );
    expect(next.token).toBe('new');
    expect(next.settings).toEqual({ AI_BRIDGE_ATTACHMENT_MAX_MB: '500', AI_BRIDGE_ATTACHMENT_TOTAL_MB: '4000' });
  });

  test('lines somebody else added to the file survive a rewrite', () => {
    const path = join(dir, 'f.env');
    writeFileSync(path, 'AI_BRIDGE_SERVER=wss://h/bridge\nAI_BRIDGE_TOKEN=t\nSOMETHING_ELSE=kept\n');
    writeConfig(path, { server: 'wss://h/bridge', token: 't2' });
    const body = readFileSync(path, 'utf8');
    expect(body).toContain('SOMETHING_ELSE=kept');
    expect(body).toContain('AI_BRIDGE_TOKEN=t2');
    expect(body.match(/AI_BRIDGE_TOKEN=/g)).toHaveLength(1);
  });
});

describe('vault and Claude token, recorded for the service', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bridge-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('Engram\'s address and the token file round trip as ENGRAM_URL and AI_BRIDGE_CLAUDE_ENV', () => {
    // systemd's EnvironmentFile hands both to the bridge; --env-file reads
    // them on macOS. The token itself is never written here, only its file.
    const path = join(dir, 'v.env');
    writeConfig(path, { server: 'wss://h/bridge', token: 't', engram: 'https://h', claudeEnv: '/home/me/.config/ai-bridge/claude.env' });
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('ENGRAM_URL=https://h\n');
    expect(text).toContain('AI_BRIDGE_CLAUDE_ENV=/home/me/.config/ai-bridge/claude.env\n');
    expect(text).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(readConfig(path)).toMatchObject({ engram: 'https://h', claudeEnv: '/home/me/.config/ai-bridge/claude.env' });
  });

  test('a reinstall keeps the token file it is not given again, and drops Engram with --local-tools', () => {
    const existing = { server: 'wss://h/bridge', token: 'old', engram: 'https://h', claudeEnv: '/c.env' };
    const next = configForInstall({ server: 'wss://h/bridge', token: 'new' }, 'h', existing);
    // Changing a folder must not sign the service out of Claude...
    expect(next.claudeEnv).toBe('/c.env');
    // ...while Engram's address belongs to --local-tools, given again or gone.
    expect(next.engram).toBeUndefined();
    expect(configForInstall({ server: 'wss://h/bridge', token: 'new', claudeEnv: '' }, 'h', existing).claudeEnv).toBeUndefined();
  });

  test('a value with a line break is refused, so it cannot write a second key', () => {
    expect(() => writeConfig(join(dir, 'x.env'), { server: 'wss://h/bridge', token: 't', engram: 'https://h\nAI_BRIDGE_TOKEN=evil' }))
      .toThrow(/line break/);
    expect(() => writeConfig(join(dir, 'y.env'), { server: 'wss://h/bridge', token: 't', settings: { AI_BRIDGE_ATTACHMENT_MAX_MB: '5\nAI_BRIDGE_TOKEN=evil' } }))
      .toThrow(/line break/);
  });
});

describe('a pinned service', () => {
  test('the systemd unit starts the version in the env file, with the flags asked for, and restarts', async () => {
    const { systemdUnit } = await import('../src/service/platform.js');
    const { pathsFor } = await import('../src/service/naming.js');
    const unit = systemdUnit(pathsFor('acme'), { server: 'wss://x', token: 't', allowDir: '/srv/app' }, ['--allow-native'], '/usr/bin/npx');
    expect(unit).toContain('ExecStart=/usr/bin/npx -y --ignore-scripts @tetrixdev/ai-bridge@${AI_BRIDGE_VERSION} --allow-dir "/srv/app" --allow-native\n');
    expect(unit).toContain('Restart=always');
    expect(unit).toMatch(/EnvironmentFile=.*acme\.env/);
  });

  test('install refuses a flag outside its short list', async () => {
    const { install } = await import('../src/service/platform.js');
    const { pathsFor } = await import('../src/service/naming.js');
    expect(() => install(pathsFor('x'), { server: 'wss://x', token: 't' }, ['--allow-native; rm -rf ~'])).toThrow(/not a flag/);
  });

  test('the env file records the installed version, and a reinstall keeps the previous-version note', async () => {
    const { writeConfig, readConfig } = await import('../src/service/config.js');
    const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'svc-'));
    const file = join(dir, 'b.env');
    try {
      writeConfig(file, { server: 'wss://x', token: 't', version: '0.24.0' });
      expect(readFileSync(file, 'utf8')).toContain('AI_BRIDGE_VERSION=0.24.0\n');
      writeFileSync(file, `${readFileSync(file, 'utf8')}AI_BRIDGE_PREVIOUS_VERSION=0.23.0\n`);
      writeConfig(file, { server: 'wss://x', token: 't', version: '0.25.0' });
      const text = readFileSync(file, 'utf8');
      expect(text.match(/AI_BRIDGE_VERSION=/g)).toHaveLength(1);
      expect(text).toContain('AI_BRIDGE_VERSION=0.25.0\n');
      expect(text).toContain('AI_BRIDGE_PREVIOUS_VERSION=0.23.0\n');
      expect(readConfig(file)?.version).toBe('0.25.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
