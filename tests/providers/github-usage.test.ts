/**
 * The GitHub API allowance a usage_request with provider `github` reports (D10042).
 *
 * Worth guarding: it must cost no API call (rate_limit is free; the login comes from gh's own
 * file, never `gh auth status`), it must never answer for an account it cannot name the way gh
 * does, and an old/odd machine must get `no_credential` or `failed`, never a made-up figure.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      'github.com:\n    users:\n        old-account:\n            oauth_token: x\n        Danica-ZP:\n            oauth_token: y\n    user: Danica-ZP\n    oauth_token: y\n    git_protocol: https\n',
    );
    expect(await activeGitHubLogin(path)).toBe('Danica-ZP');
  });

  it('ignores another host', async () => {
    const path = await hosts('git.example.org:\n    user: someone\n');
    expect(await activeGitHubLogin(path)).toBeNull();
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
  it('is answered exactly once, also on a machine whose only CLI is claude', async () => {
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

    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 15_000 });
    const answer = sent[0] as UsageResultMessage;
    expect(answer.type).toBe('usage_result');
    expect(answer.id).toBe('g1');
    // Whatever this machine's gh says, it is never the Claude path's "unsupported".
    expect(answer.reason).not.toBe('unsupported');
  });
});
