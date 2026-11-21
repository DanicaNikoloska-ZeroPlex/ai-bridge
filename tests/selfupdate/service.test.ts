import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect, parseShow, pinVersion, type DetectDeps } from '../../src/selfupdate/service.js';

const CGROUP = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/ai-bridge-acme.service\n';
const ENV = '/home/u/.config/ai-bridge-acme.env';
// What `systemctl show` really prints for a bridge installed as a user unit.
const SHOW = [
  'Restart=always',
  'ExecStart={ path=/usr/bin/env ; argv[]=/usr/bin/env npx --yes @tetrixdev/ai-bridge@${AI_BRIDGE_VERSION} --allow-dir /srv/x --allow-native ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }',
  `EnvironmentFiles=${ENV} (ignore_errors=no)`,
  '',
].join('\n');

function deps(over: Partial<DetectDeps> = {}, files: Record<string, string> = { [ENV]: 'AI_BRIDGE_TOKEN=x\nAI_BRIDGE_VERSION=0.24.0\n' }): DetectDeps {
  return {
    env: { INVOCATION_ID: 'abc' },
    platform: 'linux',
    readCgroup: () => CGROUP,
    showUnit: () => SHOW,
    readFile: (p) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p]!;
    },
    writable: () => true,
    ...over,
  };
}

describe('is this bridge a service that can update itself', () => {
  it('yes, for a user unit that restarts it, starts the pinned version, and has one env file setting it', () => {
    expect(detect(deps())).toEqual({ managed: { kind: 'systemd', scope: 'user', unit: 'ai-bridge-acme.service', envFile: ENV } });
  });

  it('a system unit is recognised as one, and on-failure restarts count', () => {
    const r = detect(deps({
      readCgroup: () => '0::/system.slice/ai-bridge.service\n',
      showUnit: (scope) => (scope === 'system' ? SHOW.replace('Restart=always', 'Restart=on-failure') : ''),
    }));
    expect(r).toMatchObject({ managed: { scope: 'system', unit: 'ai-bridge.service' } });
  });

  it('accepts $AI_BRIDGE_VERSION without braces too', () => {
    expect('managed' in detect(deps({ showUnit: () => SHOW.replace('${AI_BRIDGE_VERSION}', '$AI_BRIDGE_VERSION') }))).toBe(true);
  });

  const no = (d: DetectDeps, why: RegExp): void => {
    const r = detect(d);
    expect('reason' in r ? r.reason : 'managed').toMatch(why);
  };

  it('no, in a terminal: no INVOCATION_ID', () => no(deps({ env: {} }), /not running as a systemd service/));
  it('no, off Linux', () => no(deps({ platform: 'darwin' }), /by hand/));
  it('no, when the cgroup names no unit', () => no(deps({ readCgroup: () => '0::/user.slice/user-1000.slice/session-3.scope\n' }), /which systemd unit/));
  it('no, when the unit would not restart it', () => no(deps({ showUnit: () => SHOW.replace('Restart=always', 'Restart=no') }), /Restart=no/));
  it('no, for an unpinned unit, which would come back on whatever npx resolves', () =>
    no(deps({ showUnit: () => SHOW.replace('@tetrixdev/ai-bridge@${AI_BRIDGE_VERSION}', '@tetrixdev/ai-bridge') }), /does not start/));
  it('no, for a unit pinned to a literal version', () =>
    no(deps({ showUnit: () => SHOW.replace('${AI_BRIDGE_VERSION}', '0.23.0') }), /does not start/));
  it('no, when no env file sets AI_BRIDGE_VERSION', () => no(deps({}, { [ENV]: 'AI_BRIDGE_TOKEN=x\n' }), /no env file/));
  it('no, when the env file is not writable', () => no(deps({ writable: () => false }), /not writable/));

  it('two env files setting it is ambiguous, until AI_BRIDGE_ENV_FILE names one', () => {
    const other = '/etc/ai-bridge.env';
    const files = { [ENV]: 'AI_BRIDGE_VERSION=0.24.0\n', [other]: 'AI_BRIDGE_VERSION=0.24.0\n' };
    const show = `${SHOW}EnvironmentFiles=${other} (ignore_errors=yes)\n`;
    no(deps({ showUnit: () => show }, files), /more than one/);
    expect(detect(deps({ showUnit: () => show, env: { INVOCATION_ID: 'a', AI_BRIDGE_ENV_FILE: other } }, files)))
      .toMatchObject({ managed: { envFile: other } });
  });
});

describe('systemctl show', () => {
  it('joins a repeated property', () => {
    expect(parseShow('EnvironmentFiles=/a (ignore_errors=no)\nEnvironmentFiles=/b (ignore_errors=no)\nRestart=always\n').get('EnvironmentFiles'))
      .toBe('/a (ignore_errors=no)\n/b (ignore_errors=no)');
  });
});

describe('pinning the version in the env file', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('changes that line only, records the previous version, and keeps the file mode', () => {
    dir = mkdtempSync(join(tmpdir(), 'pin-'));
    const file = join(dir, 'b.env');
    writeFileSync(file, '# Acme\nAI_BRIDGE_SERVER=wss://x\nAI_BRIDGE_TOKEN=secret\nAI_BRIDGE_VERSION=0.24.0\nOTHER=1\n');
    chmodSync(file, 0o600);
    pinVersion(file, '0.25.1', '0.24.0');
    expect(readFileSync(file, 'utf8')).toBe('# Acme\nAI_BRIDGE_SERVER=wss://x\nAI_BRIDGE_TOKEN=secret\nAI_BRIDGE_VERSION=0.25.1\nOTHER=1\nAI_BRIDGE_PREVIOUS_VERSION=0.24.0\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    pinVersion(file, '0.24.0', '0.25.1');
    expect(readFileSync(file, 'utf8')).toContain('AI_BRIDGE_VERSION=0.24.0\nOTHER=1\nAI_BRIDGE_PREVIOUS_VERSION=0.25.1\n');
  });

  it('replaces a quoted or exported value', () => {
    dir = mkdtempSync(join(tmpdir(), 'pin-'));
    const file = join(dir, 'b.env');
    writeFileSync(file, 'export AI_BRIDGE_VERSION="0.24.0"\n');
    pinVersion(file, '0.26.0', '0.24.0');
    expect(readFileSync(file, 'utf8')).toBe('AI_BRIDGE_VERSION=0.26.0\nAI_BRIDGE_PREVIOUS_VERSION=0.24.0\n');
  });
});
