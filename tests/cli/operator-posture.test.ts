/**
 * The wire from the operator's flags to what a server is allowed to do.
 *
 * Everything else in this suite builds a `Bridge` directly, so it proves the
 * gates honour their fields and never that the flags reach them. Hardcoding
 * `allowNative: true` in the CLI handler used to leave the whole suite green —
 * i.e. every deployment silently granting `native` to any server that asked,
 * with nothing failing. A rename on either side of that assignment opens or
 * closes the gate in silence.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { resolveOperatorPosture, type OperatorOptions } from '../../src/cli.js';

let root: string;
let repo: string;

const SERVER = 'wss://studio.example.com/api/ai-bridge/ws';

function options(overrides: Partial<OperatorOptions> = {}): OperatorOptions {
  return {
    allowDir: [],
    allowNative: false,
    keepAttachments: false,
    attachmentMaxMb: '25',
    attachmentTotalMb: '100',
    ...overrides,
  };
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'posture-cli-')));
  repo = join(root, 'studio');
  mkdirSync(repo, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the defaults', () => {
  it('permit nothing a server could ask for', () => {
    const posture = resolveOperatorPosture(options(), SERVER, {});

    // Both permissive postures off, and no directory may be named.
    expect(posture.allowNative).toBe(false);
    expect(posture.allowedRoots).toEqual([]);
    expect(posture.keepAttachments).toBe(false);
  });
});

describe('--allow-native', () => {
  it('is off unless passed', () => {
    expect(resolveOperatorPosture(options(), SERVER, {}).allowNative).toBe(false);
  });

  it('reaches the bridge when passed', () => {
    expect(resolveOperatorPosture(options({ allowNative: true }), SERVER, {}).allowNative).toBe(true);
  });

  it('does not imply an allow-list', () => {
    expect(resolveOperatorPosture(options({ allowNative: true }), SERVER, {}).allowedRoots).toEqual([]);
  });
});

describe('--allow-web-search', () => {
  it('is off unless passed (decision 0016)', () => {
    expect(resolveOperatorPosture(options(), SERVER, {}).webSearch).toBe(false);
  });

  it('reaches the bridge when passed', () => {
    expect(resolveOperatorPosture(options({ allowWebSearch: true }), SERVER, {}).webSearch).toBe(true);
  });

  it('is not switched on by an environment variable', () => {
    expect(resolveOperatorPosture(options(), SERVER, { AI_BRIDGE_WEB_SEARCH: '1' }).webSearch).toBe(false);
  });
});

describe('--allow-dir', () => {
  it('reaches the bridge as resolved roots', () => {
    const posture = resolveOperatorPosture(options({ allowDir: [`${repo}=Studio`] }), SERVER, {});
    expect(posture.allowedRoots).toEqual([{ path: repo, label: 'Studio' }]);
  });

  it('reads the environment variable too', () => {
    const posture = resolveOperatorPosture(options(), SERVER, {
      AI_BRIDGE_ALLOWED_DIRS: [repo, root].join(delimiter),
    });
    expect(posture.allowedRoots.map((r) => r.path)).toEqual([repo, root]);
  });

  it('does not imply --allow-native', () => {
    expect(resolveOperatorPosture(options({ allowDir: [repo] }), SERVER, {}).allowNative).toBe(false);
  });

  it('throws rather than quietly allowing nothing when every entry is bad', () => {
    expect(() => resolveOperatorPosture(options({ allowDir: [join(root, 'nope')] }), SERVER, {}))
      .toThrow(/could be used/);
  });
});

describe('the attachment origin', () => {
  it('defaults to the https origin of the server URL', () => {
    expect(resolveOperatorPosture(options(), SERVER, {}).apiOrigin)
      .toBe('https://studio.example.com');
  });

  it('takes an explicit --api for split deployments', () => {
    expect(resolveOperatorPosture(options({ api: 'https://api.example.com' }), SERVER, {}).apiOrigin)
      .toBe('https://api.example.com');
  });

  it('throws on a plaintext --api for a real host', () => {
    expect(() => resolveOperatorPosture(options({ api: 'http://api.example.com' }), SERVER, {}))
      .toThrow(/https/);
  });
});

describe('the attachment caps', () => {
  it('convert megabytes to bytes', () => {
    const posture = resolveOperatorPosture(
      options({ attachmentMaxMb: '10', attachmentTotalMb: '40' }),
      SERVER,
      {},
    );
    expect(posture.attachmentLimits.maxFileBytes).toBe(10 * 1024 * 1024);
    expect(posture.attachmentLimits.maxTotalBytes).toBe(40 * 1024 * 1024);
  });

  it('take the defaults when nothing was set', () => {
    const posture = resolveOperatorPosture(
      { allowDir: [], allowNative: false, keepAttachments: false }, SERVER, {},
    );
    expect(posture.attachmentLimits).toEqual({
      maxFileBytes: 25 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024, maxCount: 50,
    });
    expect(posture.attachmentTimeouts).toEqual({ stallMs: 60_000, ceilingMs: 60 * 60_000 });
    expect(posture.attachmentCache.ttlMs).toBe(72 * 60 * 60 * 1000);
    expect(posture.attachmentCache.maxBytes).toBe(1024 * 1024 * 1024);
  });

  it('take the count cap as a whole number', () => {
    expect(resolveOperatorPosture(options({ attachmentMaxCount: '120' }), SERVER, {}).attachmentLimits.maxCount)
      .toBe(120);
    for (const bad of ['0', '2.5', 'many']) {
      expect(() => resolveOperatorPosture(options({ attachmentMaxCount: bad }), SERVER, {}))
        .toThrow(/--attachment-max-count/);
    }
  });

  it('throw on a value that is not a positive number', () => {
    // A mistyped cap that silently became the default would only be noticed
    // when a large attachment was refused for reasons that make no sense.
    for (const bad of ['nonsense', '0', '-5', '']) {
      expect(() => resolveOperatorPosture(options({ attachmentMaxMb: bad }), SERVER, {}))
        .toThrow(/--attachment-max-mb/);
    }
  });
});

describe('the download clocks', () => {
  it('convert seconds and minutes', () => {
    const posture = resolveOperatorPosture(
      options({ attachmentStallSeconds: '30', attachmentTimeoutMinutes: '240' }), SERVER, {},
    );
    expect(posture.attachmentTimeouts).toEqual({ stallMs: 30_000, ceilingMs: 240 * 60_000 });
  });

  it('refuse zero: a download with no stall clock is the bug being fixed', () => {
    expect(() => resolveOperatorPosture(options({ attachmentStallSeconds: '0' }), SERVER, {}))
      .toThrow(/--attachment-stall-seconds/);
    expect(() => resolveOperatorPosture(options({ attachmentTimeoutMinutes: '-1' }), SERVER, {}))
      .toThrow(/--attachment-timeout-minutes/);
  });
});

describe('the attachment store', () => {
  it('converts hours and megabytes, and 0 turns it off', () => {
    const posture = resolveOperatorPosture(
      options({ attachmentCacheTtlHours: '24', attachmentCacheMaxMb: '0' }), SERVER, {},
    );
    expect(posture.attachmentCache.ttlMs).toBe(24 * 60 * 60 * 1000);
    expect(posture.attachmentCache.maxBytes).toBe(0);
  });

  it('refuses a negative or unreadable value', () => {
    expect(() => resolveOperatorPosture(options({ attachmentCacheTtlHours: '-1' }), SERVER, {}))
      .toThrow(/--attachment-cache-ttl-hours/);
    expect(() => resolveOperatorPosture(options({ attachmentCacheMaxMb: 'lots' }), SERVER, {}))
      .toThrow(/--attachment-cache-max-mb/);
  });

  it('is one per server, never shared between two installs pointed at different servers', () => {
    const prod = resolveOperatorPosture(options(), SERVER, {}).attachmentCache.dir;
    const test = resolveOperatorPosture(options(), 'wss://test.example.com/ws', {}).attachmentCache.dir;
    expect(prod).not.toBe(test);
  });

  it('follows the install name a service was started with', () => {
    const a = resolveOperatorPosture(options({ installName: 'repo-a' }), SERVER, {}).attachmentCache.dir;
    const b = resolveOperatorPosture(options({ installName: 'repo-b' }), SERVER, {}).attachmentCache.dir;
    expect(a).not.toBe(b);
  });
});
