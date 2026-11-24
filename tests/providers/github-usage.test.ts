/**
 * The GitHub API allowance a usage_request with provider `github` reports.
 *
 * Worth guarding: it must cost no API call (rate_limit is free; the login comes from gh's own
 * file, never `gh auth status`), it must never answer for an account it cannot name the way gh
 * does, and an old/odd machine must get `no_credential` or `failed`, never a made-up figure.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Bridge } from '../../src/bridge.js';
import type { ProviderAdapter } from '../../src/providers/base.js';
import type { BridgeToServerMessage, UsageResultMessage } from '../../src/protocol/types.js';
import { activeGitHubLogin, readGitHubUsage } from '../../src/providers/github-usage.js';

const RATE = JSON.stringify({ resources: { core: { limit: 5000, remaining: 750, reset: 1795516285, used: 4250 } } });

async function hosts(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gh-'));
  const path = join(dir, 'hosts.yml');
  await writeFile(path, content);
  return path;
}

describe('activeGitHubLogin', () => {
  it('reads the active account, not a nested users entry', async () => {
    const path = await hosts(
      'github.com:\n    users:\n        old-account:\n            oauth_token: x\n        current-account:\n            oauth_token: y\n    user: current-account\n    oauth_token: y\n    git_protocol: https\n',
    );
    expect(await activeGitHubLogin(path)).toBe('current-account');
  });

  it('ignores another host', async () => {
    const path = await hosts('git.example.org:\n    user: someone\n');
    expect(await activeGitHubLogin(path)).toBeNull();
  });

  it('accepts an underscore login (Enterprise Managed Users)', async () => {
    const path = await hosts('github.com:\n    user: name_short\n');
    expect(await activeGitHubLogin(path)).toBe('name_short');
  });

  it('follows GH_CONFIG_DIR like gh does', async () => {
    const path = await hosts('github.com:\n    user: from-config-dir\n');
    const before = process.env['GH_CONFIG_DIR'];
    process.env['GH_CONFIG_DIR'] = dirname(path);
    try {
      expect(await activeGitHubLogin()).toBe('from-config-dir');
    } finally {
      if (before === undefined) delete process.env['GH_CONFIG_DIR'];
      else process.env['GH_CONFIG_DIR'] = before;
    }
  });

  it('is null without a hosts file', async () => {
    expect(await activeGitHubLogin('/nonexistent/hosts.yml')).toBeNull();
  });
});

describe('readGitHubUsage', () => {
  it('reports calls left, the hour size, the reset and the percent used', async () => {
    const answer = await readGitHubUsage(async () => RATE);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.limits).toHaveLength(1);
    expect(answer.limits[0]).toMatchObject({
      label: 'GitHub API',
      kind: 'github_core',
      remaining: 750,
      limit: 5000,
      percent: 85,
      resets_at: new Date(1795516285 * 1000).toISOString(),
    });
  });

  it('asks gh for rate_limit only (free), never auth status or user', async () => {
    const run = vi.fn(async () => RATE);
    await readGitHubUsage(run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(['api', 'rate_limit']);
  });

  it('no gh installed: no_credential', async () => {
    const answer = await readGitHubUsage(async () => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    });
    expect(answer).toEqual({ ok: false, reason: 'no_credential' });
  });

  it('gh not signed in: no_credential', async () => {
    const answer = await readGitHubUsage(async () => {
      throw Object.assign(new Error('exit 4'), { code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' });
    });
    expect(answer).toEqual({ ok: false, reason: 'no_credential' });
  });

  it('a revoked or bad token: no_credential, not failed', async () => {
    const answer = await readGitHubUsage(async () => {
      throw Object.assign(new Error('exit 1'), { code: 1, stderr: 'HTTP 401: Bad credentials (https://api.github.com/rate_limit)' });
    });
    expect(answer).toEqual({ ok: false, reason: 'no_credential' });
  });

  it('names no account when gh answers for a token in the environment', async () => {
    const before = process.env['GH_TOKEN'];
    process.env['GH_TOKEN'] = 'not-a-real-token';
    try {
      const answer = await readGitHubUsage(async () => RATE);
      expect(answer.ok && answer.limits[0]?.account).toBeFalsy();
    } finally {
      if (before === undefined) delete process.env['GH_TOKEN'];
      else process.env['GH_TOKEN'] = before;
    }
  });

  it('a proxy asking for its own sign-in (407): failed, not no_credential', async () => {
    const answer = await readGitHubUsage(async () => {
      throw Object.assign(new Error('exit 1'), { code: 1, stderr: 'error connecting to api.github.com: Proxy Authentication Required (407)' });
    });
    expect(answer).toEqual({ ok: false, reason: 'failed' });
  });

  it('follows XDG_CONFIG_HOME when GH_CONFIG_DIR is not set', async () => {
    const path = await hosts('github.com:\n    user: from-xdg\n');
    const saved = { gh: process.env['GH_CONFIG_DIR'], xdg: process.env['XDG_CONFIG_HOME'] };
    delete process.env['GH_CONFIG_DIR'];
    const xdg = await mkdtemp(join(tmpdir(), 'xdg-'));
    const { mkdir, copyFile } = await import('node:fs/promises');
    await mkdir(join(xdg, 'gh'));
    await copyFile(path, join(xdg, 'gh', 'hosts.yml'));
    process.env['XDG_CONFIG_HOME'] = xdg;
    try {
      expect(await activeGitHubLogin()).toBe('from-xdg');
    } finally {
      if (saved.gh === undefined) delete process.env['GH_CONFIG_DIR']; else process.env['GH_CONFIG_DIR'] = saved.gh;
      if (saved.xdg === undefined) delete process.env['XDG_CONFIG_HOME']; else process.env['XDG_CONFIG_HOME'] = saved.xdg;
    }
  });

  it('timeout or other error: failed', async () => {
    const answer = await readGitHubUsage(async () => {
      throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
    });
    expect(answer).toEqual({ ok: false, reason: 'failed' });
  });

  it('unreadable answer: failed, never a made-up figure', async () => {
    expect(await readGitHubUsage(async () => 'not json')).toEqual({ ok: false, reason: 'failed' });
    expect(await readGitHubUsage(async () => '{"resources":{}}')).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('usage_request with provider github', () => {
  it('is answered exactly once with the reading, also on a machine whose only CLI is claude', async () => {
    const reading = { ok: true as const, limits: [{ label: 'GitHub API', kind: 'github_core', percent: 85, remaining: 750, limit: 5000, account: 'current-account' }] };
    const module = await import('../../src/providers/github-usage.js');
    const spy = vi.spyOn(module, 'readGitHubUsage').mockResolvedValue(reading);

    const bridge = new Bridge({
      serverUrl: 'wss://example.test/bridge',
      token: 'irrelevant',
      providers: [{ name: 'claude', version: '1.0.0', available: true, supports_streaming: true }] as never,
      adapters: new Map<string, ProviderAdapter>(),
      sessionStorePath: null,
    });
    const sent: BridgeToServerMessage[] = [];
    const inner = bridge as unknown as { send(m: BridgeToServerMessage): void; onMessage(d: Buffer): void };
    inner.send = (m) => {
      sent.push(m);
    };

    inner.onMessage(Buffer.from(JSON.stringify({ type: 'usage_request', id: 'g1', provider: 'github' })));

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0] as UsageResultMessage).toEqual({ type: 'usage_result', id: 'g1', ok: true, limits: reading.limits });
    spy.mockRestore();
  });
});
