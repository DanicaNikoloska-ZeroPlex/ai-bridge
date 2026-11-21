/**
 * The record of where each CLI session runs.
 *
 * Persisted, because in memory it was worth very little: a bridge is a
 * background service that gets restarted, and an empty map turns "a resume
 * that names nothing keeps its directory" into "runs in the empty scratch
 * directory" — which is the failure the whole workspace module exists to
 * prevent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWorkingDirs } from '../../src/workspace/sessions.js';

let dir: string;
let store: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sessions-'));
  store = join(dir, 'sessions.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** An instance that never touches disk — the shape most tests want. */
function inMemory(capacity = 500): SessionWorkingDirs {
  return new SessionWorkingDirs(capacity, null);
}

describe('remembering', () => {
  it('remembers where a session was started', () => {
    const s = inMemory();
    s.remember('sess-1', '/repos/a');
    expect(s.get('sess-1')).toBe('/repos/a');
  });

  it('returns undefined for a session it never saw', () => {
    expect(inMemory().get('sess-x')).toBeUndefined();
  });

  it('forgets on request', () => {
    const s = inMemory();
    s.remember('sess-1', '/repos/a');
    s.forget('sess-1');
    expect(s.get('sess-1')).toBeUndefined();
  });

  it('evicts the oldest entries past its capacity', () => {
    const s = inMemory(3);
    s.remember('a', '/1');
    s.remember('b', '/2');
    s.remember('c', '/3');
    s.remember('d', '/4');
    expect(s.size).toBe(3);
    expect(s.get('a')).toBeUndefined();
    expect(s.get('d')).toBe('/4');
  });

  it('refreshes an entry position when re-recorded', () => {
    const s = inMemory(3);
    s.remember('a', '/1');
    s.remember('b', '/2');
    s.remember('a', '/1-moved');
    s.remember('c', '/3');
    s.remember('d', '/4');
    // 'b' was the least recently recorded, so it is the one that goes.
    expect(s.get('b')).toBeUndefined();
    expect(s.get('a')).toBe('/1-moved');
  });
});

describe('surviving a restart', () => {
  it('reads back what a previous run recorded', () => {
    new SessionWorkingDirs(500, store).remember('sess-1', '/repos/acme-app');

    // A fresh process.
    expect(new SessionWorkingDirs(500, store).get('sess-1')).toBe('/repos/acme-app');
  });

  it('reads back a forget too', () => {
    const first = new SessionWorkingDirs(500, store);
    first.remember('sess-1', '/repos/acme-app');
    first.forget('sess-1');

    expect(new SessionWorkingDirs(500, store).get('sess-1')).toBeUndefined();
  });

  it('starts empty when there is no store yet', () => {
    expect(new SessionWorkingDirs(500, join(dir, 'not-there.json')).size).toBe(0);
  });

  it('starts empty rather than throwing on a corrupt store', () => {
    writeFileSync(store, '{ this is not json');
    expect(new SessionWorkingDirs(500, store).size).toBe(0);
  });

  it('ignores entries whose value is not a path', () => {
    // The values are handed to spawn() as cwd, so anything that is not a
    // plain string is dropped rather than trusted.
    writeFileSync(store, JSON.stringify({ ok: '/repos/a', bad: 42, worse: { x: 1 }, empty: '' }));
    const s = new SessionWorkingDirs(500, store);
    expect(s.get('ok')).toBe('/repos/a');
    expect(s.get('bad')).toBeUndefined();
    expect(s.get('worse')).toBeUndefined();
    expect(s.get('empty')).toBeUndefined();
  });

  it('honours a capacity that shrank between runs', () => {
    writeFileSync(store, JSON.stringify({ a: '/1', b: '/2', c: '/3', d: '/4' }));
    expect(new SessionWorkingDirs(2, store).size).toBe(2);
  });

  it('keeps working when the store cannot be written', () => {
    // A full or read-only cache directory costs the resume check, which is a
    // far smaller thing than failing every turn.
    const readOnly = join(dir, 'ro');
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);
    try {
      const s = new SessionWorkingDirs(500, join(readOnly, 'sessions.json'));
      expect(() => s.remember('sess-1', '/repos/a')).not.toThrow();
      expect(s.get('sess-1')).toBe('/repos/a');
    } finally {
      chmodSync(readOnly, 0o700);
    }
  });

  it('writes the store readable only by its owner', () => {
    new SessionWorkingDirs(500, store).remember('sess-1', '/repos/a');
    expect(JSON.parse(readFileSync(store, 'utf-8'))).toEqual({ 'sess-1': '/repos/a' });
  });
});
