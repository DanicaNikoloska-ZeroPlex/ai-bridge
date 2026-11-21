/**
 * The attachment store that outlives a turn.
 *
 * Always in a temporary directory: the real store belongs to whatever bridge
 * is running on this machine, and a suite that filled or swept it would be
 * evicting somebody's files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentCache, attachmentCacheScope } from '../../src/attachments/cache.js';
import { nameFromServer } from '../../src/service/naming.js';

const HOUR = 60 * 60 * 1000;
const SETTINGS = { ttlMs: 72 * HOUR, maxBytes: 10 * 1024 * 1024 };

let root: string;
let store: string;
let turn: string;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** A file as fetchAttachments would have left it in a turn directory. */
function downloaded(name: string, body: Buffer): string {
  const path = join(turn, name);
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

function ageBy(path: string, ms: number): void {
  const then = new Date(Date.now() - ms);
  utimesSync(path, then, then);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'attachment-cache-'));
  store = join(root, 'store');
  turn = join(root, 'turn');
  mkdirSync(turn);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a file kept for later turns', () => {
  it('is handed to the next turn without a download, at that turn\'s own path', async () => {
    const cache = new AttachmentCache(store, SETTINGS);
    const body = randomBytes(4096);
    cache.put(sha256(body), body.byteLength, downloaded('dump.sql', body));

    const next = join(turn, 'next', 'dump.sql');
    mkdirSync(join(turn, 'next'));
    expect(await cache.take(sha256(body), body.byteLength, next)).toBe(true);
    expect(readFileSync(next).equals(body)).toBe(true);
  });

  it('is hard-linked, so a kept file costs no second copy on disk', async () => {
    const cache = new AttachmentCache(store, SETTINGS);
    const body = Buffer.from('linked');
    cache.put(sha256(body), body.byteLength, downloaded('a.txt', body));
    const dest = join(turn, 'b.txt');
    await cache.take(sha256(body), body.byteLength, dest);
    expect(statSync(dest).ino).toBe(statSync(join(store, sha256(body))).ino);
  });

  it('is copied where the filesystem refuses a hard link', async () => {
    // Across filesystems, some network mounts, FAT. Slower, but not a miss.
    const exdev = (): void => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    };
    const cache = new AttachmentCache(store, SETTINGS, exdev);
    const body = Buffer.from('copied');
    cache.put(sha256(body), body.byteLength, downloaded('a.txt', body));
    expect(existsSync(join(store, sha256(body)))).toBe(true);

    const dest = join(turn, 'b.txt');
    expect(await cache.take(sha256(body), body.byteLength, dest)).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe('copied');
    expect(statSync(dest).ino).not.toBe(statSync(join(store, sha256(body))).ino);
  });

  it('is a miss, not an error, when nothing was kept', async () => {
    const cache = new AttachmentCache(store, SETTINGS);
    expect(await cache.take(sha256(Buffer.from('never seen')), 10, join(turn, 'x'))).toBe(false);
    expect(existsSync(join(turn, 'x'))).toBe(false);
  });

  it('is re-verified before it is trusted, and dropped when it no longer matches', async () => {
    // One inode with the turn's copy: an assistant that edited the file in
    // place edited this too. The checksum is what catches it.
    const cache = new AttachmentCache(store, SETTINGS);
    const body = Buffer.from('original contents');
    const first = downloaded('a.txt', body);
    cache.put(sha256(body), body.byteLength, first);
    writeFileSync(first, Buffer.from('EDITED   contents'));

    const dest = join(turn, 'again.txt');
    expect(await cache.take(sha256(body), body.byteLength, dest)).toBe(false);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(join(store, sha256(body)))).toBe(false);
  });

  it('is a miss once it has gone unused past the TTL', async () => {
    const cache = new AttachmentCache(store, { ...SETTINGS, ttlMs: HOUR });
    const body = Buffer.from('old');
    cache.put(sha256(body), body.byteLength, downloaded('a.txt', body));
    ageBy(join(store, sha256(body)), 2 * HOUR);
    expect(await cache.take(sha256(body), body.byteLength, join(turn, 'b.txt'))).toBe(false);
  });

  it('never joins a digest that is not one onto a path', async () => {
    // The digest comes from the server.
    const cache = new AttachmentCache(store, SETTINGS);
    const body = Buffer.from('x');
    cache.put('../../escape', 1, downloaded('a.txt', body));
    expect(existsSync(join(root, 'escape'))).toBe(false);
    expect(await cache.take('../turn/a.txt', 1, join(turn, 'b.txt'))).toBe(false);
  });

  it('keeps nothing when it is turned off', async () => {
    const cache = new AttachmentCache(store, { ...SETTINGS, ttlMs: 0 });
    const body = Buffer.from('x');
    cache.put(sha256(body), 1, downloaded('a.txt', body));
    expect(existsSync(store)).toBe(false);
    expect(AttachmentCache.disabled().enabled).toBe(false);
  });
});

describe('sweeping', () => {
  function keep(cache: AttachmentCache, body: Buffer, ageMs: number): string {
    cache.put(sha256(body), body.byteLength, downloaded(`${sha256(body)}.bin`, body));
    const entry = join(store, sha256(body));
    ageBy(entry, ageMs);
    return entry;
  }

  it('expires what has gone unused past the TTL', () => {
    const cache = new AttachmentCache(store, { ...SETTINGS, ttlMs: HOUR });
    const stale = keep(cache, Buffer.from('stale'), 2 * HOUR);
    const fresh = keep(cache, Buffer.from('fresh'), 0);
    cache.sweep();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('evicts the least recently used first until the store fits its cap', () => {
    const cache = new AttachmentCache(store, { ...SETTINGS, maxBytes: 2500 });
    const oldest = keep(cache, randomBytes(1000), 3000);
    const middle = keep(cache, randomBytes(1000), 2000);
    const newest = keep(cache, randomBytes(1000), 1000);
    cache.sweep();
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(newest)).toBe(true);
  });

  it('counts a reuse as use, so a file still being asked for is not the one evicted', async () => {
    const cache = new AttachmentCache(store, { ...SETTINGS, maxBytes: 1500 });
    const a = randomBytes(1000);
    const first = keep(cache, a, 5000);
    const second = keep(cache, randomBytes(1000), 1000);
    await cache.take(sha256(a), a.byteLength, join(turn, 'reused.bin'));
    cache.sweep();
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(false);
  });

  it('empties a store that has since been turned off', () => {
    const on = new AttachmentCache(store, SETTINGS);
    const entry = keep(on, Buffer.from('left behind'), 0);
    new AttachmentCache(store, { ...SETTINGS, maxBytes: 0 }).sweep();
    expect(existsSync(entry)).toBe(false);
  });

  it('clears a crash\'s half-written leftovers, but not a write in progress', () => {
    const cache = new AttachmentCache(store, SETTINGS);
    mkdirSync(store, { recursive: true });
    const crashed = join(store, `.${'a'.repeat(64)}.dead`);
    const writing = join(store, `.${'b'.repeat(64)}.live`);
    writeFileSync(crashed, 'x');
    writeFileSync(writing, 'x');
    ageBy(crashed, 2 * HOUR);
    cache.sweep();
    expect(readdirSync(store)).toEqual([`.${'b'.repeat(64)}.live`]);
  });

  it('does nothing, and does not throw, when there is no store yet', () => {
    expect(new AttachmentCache(join(root, 'nothing-here'), SETTINGS).sweep()).toEqual({ removed: 0, bytes: 0 });
  });
});

describe('whose store it is', () => {
  const PROD = 'wss://app.example.com/api/ai-bridge/ws';
  const TEST = 'wss://test.app.example.com/api/ai-bridge/ws';

  it('is one per server, so one server\'s files never reach another server\'s turns', () => {
    expect(attachmentCacheScope(PROD)).not.toBe(attachmentCacheScope(TEST));
  });

  it('is the same for a bridge run by hand as for the service installed for that server', () => {
    // The default install name IS nameFromServer, so a run with no name and the
    // default install land on one store.
    expect(attachmentCacheScope(PROD)).toBe(attachmentCacheScope(PROD, nameFromServer(PROD)));
  });

  it('keeps two named installs to the same server apart', () => {
    expect(attachmentCacheScope(PROD, 'repo-a')).not.toBe(attachmentCacheScope(PROD, 'repo-b'));
  });

  it('does not follow a name that was pointed at a different server', () => {
    // `install --force` can reuse a name for another server; the old server's
    // files must not come with it.
    expect(attachmentCacheScope(PROD, 'laptop')).not.toBe(attachmentCacheScope(TEST, 'laptop'));
  });

  it('tells two devices on one server apart', () => {
    expect(attachmentCacheScope(`${PROD}?device=aaa`)).not.toBe(attachmentCacheScope(`${PROD}?device=bbb`));
  });

  it('is a single, safe path component', () => {
    for (const scope of [attachmentCacheScope(PROD, '../../x'), attachmentCacheScope('not a url')]) {
      expect(scope).not.toContain('/');
      expect(scope).not.toContain('..');
    }
  });
});
