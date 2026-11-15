import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  applyClaudeToken, currentClaudeToken, listClaudeTokens, loadClaudeToken, parseClaudeEnv, parseClaudeTokenFile,
  useClaudeToken, useClaudeTokenFile, type ClaudeTokenOutcome,
} from '../../src/providers/claude-token.js';

/**
 * A bridge installed as a service on a server nobody signs into: Claude has to
 * get its long-lived token (claude setup-token) from somewhere, and before this
 * the service had none, so every turn answered "Not logged in".
 */
describe('the long-lived Claude token', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'claude-token-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const file = (text: string, mode = 0o600): string => {
    const path = join(dir, 'claude.env');
    writeFileSync(path, text);
    chmodSync(path, mode);
    return path;
  };

  test('is read from its file into the environment Claude inherits', () => {
    const env: NodeJS.ProcessEnv = {};
    const outcome = loadClaudeToken(file('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc\n'), env);
    expect(outcome.status).toBe('loaded');
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat01-abc');
  });

  test('accepts the shapes people write a file they also source in', () => {
    expect(parseClaudeEnv('# made 2026-10-25\nexport CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-x"\n')).toBe('sk-ant-oat01-x');
    expect(parseClaudeEnv("CLAUDE_CODE_OAUTH_TOKEN='y'")).toBe('y');
    expect(parseClaudeEnv('OTHER=1\n')).toBeNull();
    expect(parseClaudeEnv('CLAUDE_CODE_OAUTH_TOKEN=\n')).toBeNull();
  });

  test('a token already in the environment wins, so one run can override it', () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'from-env' };
    expect(loadClaudeToken(file('CLAUDE_CODE_OAUTH_TOKEN=from-file\n'), env).status).toBe('already_set');
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('from-env');
  });

  test.skipIf(process.platform === 'win32')('a file others can read is refused, not used', () => {
    const env: NodeJS.ProcessEnv = {};
    const outcome = loadClaudeToken(file('CLAUDE_CODE_OAUTH_TOKEN=t\n', 0o644), env);
    expect(outcome).toMatchObject({ status: 'too_open', mode: '644' });
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
  });

  test('a missing file or one without the line says so instead of failing quietly', () => {
    expect(loadClaudeToken(join(dir, 'nope.env'), {}).status).toBe('unreadable');
    expect(loadClaudeToken(file('SOMETHING=else\n'), {}).status).toBe('no_token');
  });
});

/**
 * Two accounts, one file: a person who hits one subscription's weekly limit
 * switches the bridge to the other with one command, no unit edit, no restart.
 */
describe('several named tokens, one active', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'claude-tokens-')); });
  afterEach(() => { useClaudeTokenFile(null); rmSync(dir, { recursive: true, force: true }); });

  const file = (text: string, mode = 0o600): string => {
    const path = join(dir, 'claude-tokens.env');
    writeFileSync(path, text);
    chmodSync(path, mode);
    return path;
  };
  const TWO = '# tokens\nCLAUDE_CODE_OAUTH_TOKEN_WORK=tok-work-1234\nCLAUDE_CODE_OAUTH_TOKEN_HOME="tok-home-5678"\nCLAUDE_TOKEN_ACTIVE=work\n';

  test('parses named slots, empty ones included, and the active name', () => {
    const parsed = parseClaudeTokenFile(TWO + 'CLAUDE_CODE_OAUTH_TOKEN_SPARE=\n');
    expect([...parsed.tokens.keys()]).toEqual(['work', 'home', 'spare']);
    expect(parsed.tokens.get('home')).toBe('tok-home-5678');
    expect(parsed.tokens.get('spare')).toBe('');
    expect(parsed.active).toBe('work');
  });

  test('the active one is chosen; without an active line the single token, as before', () => {
    expect(parseClaudeEnv(TWO)).toBe('tok-work-1234');
    expect(parseClaudeEnv(TWO.replace('ACTIVE=work', 'ACTIVE=HOME'))).toBe('tok-home-5678');
    expect(parseClaudeEnv('CLAUDE_CODE_OAUTH_TOKEN=single\nCLAUDE_CODE_OAUTH_TOKEN_WORK=w\n')).toBe('single');
    expect(parseClaudeEnv('CLAUDE_CODE_OAUTH_TOKEN_WORK=w\n')).toBeNull();
  });

  test('an empty active slot or an unknown active name means no token, so Claude keeps its own sign-in', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadClaudeToken(file('CLAUDE_CODE_OAUTH_TOKEN_A=\nCLAUDE_CODE_OAUTH_TOKEN_B=\nCLAUDE_TOKEN_ACTIVE=a\n'), env)).toMatchObject({ status: 'no_token', name: 'a' });
    expect(loadClaudeToken(file('CLAUDE_CODE_OAUTH_TOKEN_A=x\nCLAUDE_TOKEN_ACTIVE=zzz\n'), env)).toMatchObject({ status: 'unknown_active', name: 'zzz' });
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
  });

  test('every run reads the file again, so a switch needs no restart', () => {
    const path = file(TWO);
    const heard: ClaudeTokenOutcome[] = [];
    useClaudeTokenFile(path, (o) => heard.push(o));
    const first: NodeJS.ProcessEnv = {};
    applyClaudeToken(first);
    expect(first['CLAUDE_CODE_OAUTH_TOKEN']).toBe('tok-work-1234');
    useClaudeToken(path, 'home');
    const second: NodeJS.ProcessEnv = {};
    applyClaudeToken(second);
    expect(second['CLAUDE_CODE_OAUTH_TOKEN']).toBe('tok-home-5678');
    // One report per change, not one per run.
    applyClaudeToken({});
    expect(heard.map((o) => o.status === 'loaded' && o.name)).toEqual(['work', 'home']);
  });

  test('a run whose environment already has a token keeps it', () => {
    useClaudeTokenFile(file(TWO));
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'from-env' };
    applyClaudeToken(env);
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('from-env');
  });

  test('usage asks about the account runs use', () => {
    useClaudeTokenFile(file(TWO));
    const saved = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    try {
      expect(currentClaudeToken()).toBe('tok-work-1234');
    } finally {
      if (saved !== undefined) process.env['CLAUDE_CODE_OAUTH_TOKEN'] = saved;
    }
  });

  test('list names the slots and the active one, and never a value', () => {
    const listing = listClaudeTokens(file(TWO + 'CLAUDE_CODE_OAUTH_TOKEN_SPARE=\n'));
    expect(listing.slots).toEqual([
      { name: 'work', filled: true, active: true },
      { name: 'home', filled: true, active: false },
      { name: 'spare', filled: false, active: false },
    ]);
    expect(listing.inUse).toBe('work');
    expect(JSON.stringify(listing)).not.toMatch(/tok-/);
  });

  test.skipIf(process.platform === 'win32')('use rewrites only the active line, atomically, keeping 0600', () => {
    const path = file(TWO);
    const result = useClaudeToken(path, 'HOME');
    expect(result).toEqual({ name: 'home', filled: true });
    expect(readFileSync(path, 'utf8')).toBe(TWO.replace('ACTIVE=work', 'ACTIVE=home'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['claude-tokens.env']);
  });

  test('use adds an active line to a file that had none, before a trailing newline', () => {
    const path = file('CLAUDE_CODE_OAUTH_TOKEN=one\nCLAUDE_CODE_OAUTH_TOKEN_TWO=two\n');
    useClaudeToken(path, 'two');
    expect(readFileSync(path, 'utf8')).toBe('CLAUDE_CODE_OAUTH_TOKEN=one\nCLAUDE_CODE_OAUTH_TOKEN_TWO=two\nCLAUDE_TOKEN_ACTIVE=two\n');
    useClaudeToken(path, 'default');
    expect(parseClaudeEnv(readFileSync(path, 'utf8'))).toBe('one');
  });

  test('use refuses an unknown name, lists the real ones, and leaves the file alone', () => {
    const path = file(TWO);
    expect(() => useClaudeToken(path, 'nope')).toThrow(/no token named "nope".*work, home/);
    expect(readFileSync(path, 'utf8')).toBe(TWO);
  });

  test.skipIf(process.platform === 'win32')('list and use refuse a file others can read', () => {
    const path = file(TWO, 0o644);
    expect(() => listClaudeTokens(path)).toThrow(/chmod 600/);
    expect(() => useClaudeToken(path, 'home')).toThrow(/chmod 600/);
  });
});

test('nothing in src passes arguments to a shell (DEP0190 on Node 24)', () => {
  // `execFileSync(cmd, args, { shell: true })` concatenates args unescaped,
  // and Node 24 prints a deprecation warning in the middle of every install.
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') ? [join(d, e.name)] : []);
  const offenders = walk(join(__dirname, '..', '..', 'src')).filter((f) => /shell:\s*true/.test(readFileSync(f, 'utf8')));
  expect(offenders).toEqual([]);
});
