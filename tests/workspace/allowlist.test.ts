/**
 * Parsing the operator's --allow-dir entries.
 *
 * The parsing is where a typo becomes either a clear startup error or a bridge
 * that silently refuses everything, so most of these are about which of the
 * two happens.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { buildAllowedRoots, rootPaths, toWorkspaceRefs } from '../../src/workspace/allowlist.js';

let root: string;
let repoA: string;
let repoB: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'allow-test-')));
  repoA = join(root, 'repo-a');
  repoB = join(root, 'repo-b');
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('buildAllowedRoots', () => {
  it('is empty when the operator passed nothing', () => {
    expect(buildAllowedRoots([], undefined)).toEqual([]);
    expect(buildAllowedRoots([], '')).toEqual([]);
  });

  it('resolves a plain path and labels it with the basename', () => {
    const roots = buildAllowedRoots([repoA]);
    expect(roots).toEqual([{ path: repoA, label: 'repo-a' }]);
  });

  it('takes an explicit label after =', () => {
    const roots = buildAllowedRoots([`${repoA}=Acme app`]);
    expect(roots).toEqual([{ path: repoA, label: 'Acme app' }]);
  });

  it('splits on the LAST = so a directory containing one still parses', () => {
    const odd = join(root, 'a=b');
    mkdirSync(odd, { recursive: true });
    expect(buildAllowedRoots([`${odd}=Odd One`])).toEqual([{ path: odd, label: 'Odd One' }]);
    // And with no label, the whole thing is the path.
    expect(buildAllowedRoots([odd])).toEqual([{ path: odd, label: 'a=b' }]);
  });

  it('falls back to the basename when the label is empty', () => {
    expect(buildAllowedRoots([`${repoA}=`])).toEqual([{ path: repoA, label: 'repo-a' }]);
  });

  it('reads AI_BRIDGE_ALLOWED_DIRS, delimiter-separated', () => {
    const roots = buildAllowedRoots([], [repoA, repoB].join(delimiter));
    expect(rootPaths(roots)).toEqual([repoA, repoB]);
  });

  it('combines flags and the environment variable', () => {
    const roots = buildAllowedRoots([repoA], repoB);
    expect(rootPaths(roots)).toEqual([repoA, repoB]);
  });

  it('deduplicates the same directory named twice', () => {
    const roots = buildAllowedRoots([repoA, `${repoA}=Again`]);
    expect(roots).toEqual([{ path: repoA, label: 'repo-a' }]);
  });

  it('resolves symlinked roots, so containment checks compare like with like', () => {
    const link = join(root, 'link-to-a');
    symlinkSync(repoA, link, 'dir');
    try {
      expect(buildAllowedRoots([link])[0]?.path).toBe(repoA);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('drops a bad entry but keeps the good ones', () => {
    const roots = buildAllowedRoots([repoA, join(root, 'does-not-exist')]);
    expect(rootPaths(roots)).toEqual([repoA]);
  });

  it('throws when every entry was unusable, rather than silently allowing nothing', () => {
    // The failure this prevents: a bridge that starts "fine" and then refuses
    // every workspace request, which reads as the feature being broken.
    expect(() => buildAllowedRoots([join(root, 'nope')])).toThrow(/could be used/);
  });

  it('rejects a file masquerading as a root', () => {
    const file = join(root, 'a-file');
    writeFileSync(file, 'x');
    expect(() => buildAllowedRoots([file])).toThrow(/not a directory/);
  });

  it('renders workspace refs for the hello message', () => {
    expect(toWorkspaceRefs(buildAllowedRoots([`${repoA}=Acme`]))).toEqual([
      { path: repoA, label: 'Acme' },
    ]);
  });
});
