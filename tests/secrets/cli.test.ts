/**
 * `aib secret ...` as a person runs it: the built CLI (dist/cli.js, built by
 * `npm ci`/`npm run build`) with HOME pointing at a scratch folder. The value
 * only ever comes in on stdin or --from-file, and no command prints it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('dist/cli.js');
const VALUE = 'sk-test-0123456789-very-secret';
let home: string;

function aib(args: string[], input?: string) {
  const r = spawnSync(process.execPath, [CLI, 'secret', ...args], {
    env: { PATH: process.env['PATH'], HOME: home }, input: input ?? '', encoding: 'utf8', timeout: 15_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

beforeEach(() => {
  if (!existsSync(CLI)) throw new Error('dist/cli.js is missing: run `npm run build` first');
  home = mkdtempSync(join(tmpdir(), 'aib-secret-cli-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('aib secret', () => {
  it('add reads stdin (less one trailing newline), refuses a taken name, replaces with --replace; nothing prints the value', async () => {
    const add = aib(['add', 'db', '--description', 'Postgres'], `${VALUE}\n`);
    expect(add.code).toBe(0);
    const file = join(home, '.ai-bridge', 'secrets', 'db');
    expect(readFileSync(file, 'utf8')).toBe(VALUE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = aib(['add', 'db'], 'other-value-123');
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already exists/);
    expect(aib(['add', 'db', '--replace'], 'other-value-123').code).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('other-value-123');
    const list = aib(['list']);
    expect(list.out).toMatch(/^db\s+\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\s+Postgres$/m);
    for (const r of [add, again, list, aib(['path', 'db']), aib(['describe', 'db', 'new words'])]) {
      expect(r.out + r.err).not.toContain(VALUE);
      expect(r.out + r.err).not.toContain('other-value-123');
    }
  });

  it('add takes no value argument, and refuses an empty value', () => {
    const extra = aib(['add', 'db', VALUE], '');
    expect(extra.code).not.toBe(0);
    expect(existsSync(join(home, '.ai-bridge', 'secrets', 'db'))).toBe(false);
    expect(aib(['add', 'db'], '').code).toBe(1);
  });

  it('add --from-file stores the file as it is', () => {
    const src = join(home, 'key.pem');
    writeFileSync(src, 'line one\nline two\n');
    expect(aib(['add', 'pem', '--from-file', src]).code).toBe(0);
    expect(readFileSync(join(home, '.ai-bridge', 'secrets', 'pem'), 'utf8')).toBe('line one\nline two\n');
  });

  it('path, describe, remove (only with --yes); a missing name exits 2', () => {
    aib(['add', 'k'], VALUE);
    expect(aib(['path', 'k']).out.trim()).toBe(join(home, '.ai-bridge', 'secrets', 'k'));
    expect(aib(['describe', 'k', 'words']).code).toBe(0);
    expect(aib(['list']).out).toMatch(/words/);
    const noYes = aib(['remove', 'k']);
    expect(noYes.code).toBe(1);
    expect(noYes.err).toMatch(/--yes/);
    expect(aib(['remove', 'k', '--yes']).code).toBe(0);
    expect(aib(['path', 'k']).code).toBe(2);
  });

  it('run masks, passes the exit code, and takes options for itself only before --', () => {
    aib(['add', 'k'], VALUE);
    const r = aib(['run', 'k', '--env', 'TOKEN', '--', 'sh', '-c', 'echo "$TOKEN"; cat "$SECRET_FILE"; echo; exit 3']);
    expect(r.code).toBe(3);
    expect(r.out).toBe('***SECRET***\n***SECRET***\n');
    const literal = aib(['run', 'k', '--', 'sh', '-c', 'echo "$0"', '--env']);
    expect(literal.out).toBe('--env\n');
    expect(aib(['run', 'k', '--', 'no-such-command-xyz']).code).toBe(127);
  });

  it('import copies a folder with .desc and reports what it skipped', () => {
    const src = join(home, 'old');
    mkdirSync(join(src, '.desc'), { recursive: true });
    writeFileSync(join(src, 'gh'), VALUE);
    writeFileSync(join(src, '.desc', 'gh'), 'GitHub');
    writeFileSync(join(src, 'bad name'), 'x');
    const r = aib(['import', src]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Imported 1 .*: gh\./);
    expect(r.out).toMatch(/Skipped bad name: not a valid secret name/);
    expect(r.out).not.toContain(VALUE);
    expect(aib(['list']).out).toMatch(/^gh .*GitHub$/m);
  });
});
