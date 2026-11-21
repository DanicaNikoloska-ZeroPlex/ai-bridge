/**
 * `aib secret run` (src/secrets/run.ts, decision 0020): the environment it
 * hands over, "{SECRET_FILE}", output masking (also across chunks), exit codes.
 */
import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { MASK, MaskingFilter, dotenvVariables, maskValues, parseDotenv, runWithSecret } from '../../src/secrets/run.js';

const VALUE = 'sk-test-0123456789-very-secret';

function sink(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  return {
    stream: new Writable({ write(chunk: Buffer, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

async function run(content: string, command: string[], extra: Partial<Parameters<typeof runWithSecret>[0]> = {}) {
  const out = sink();
  const err = sink();
  const code = await runWithSecret({
    name: 'demo', path: '/tmp/demo-secret', content: Buffer.from(content), command,
    stdout: out.stream, stderr: err.stream, env: { PATH: process.env['PATH'], AI_BRIDGE_TOKEN: 'tok' }, ...extra,
  });
  return { code, out: out.text(), err: err.text() };
}

describe('parseDotenv', () => {
  it('strips export and matching quotes, skips comments, blanks and unusable lines', () => {
    expect(parseDotenv('# c\n\nexport A=1\nB="two words"\nC=\'x\'\nD="mismatch\'\nnot a line\n1X=bad\nE = spaced \n'))
      .toEqual([['A', '1'], ['B', 'two words'], ['C', 'x'], ['D', '"mismatch\''], ['E', 'spaced']]);
  });
});

describe('dotenvVariables', () => {
  it('refuses a secret that would set a variable that makes programs load code', () => {
    expect(dotenvVariables('A=1\nB=2')).toEqual([['A', '1'], ['B', '2']]);
    for (const key of ['LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'PATH', 'BASH_ENV', 'PYTHONSTARTUP', 'GIT_SSH_COMMAND', 'PERL5OPT', 'JAVA_TOOL_OPTIONS', 'HOME', 'XDG_CONFIG_HOME', 'SECRET_FILE', 'npm_config_script_shell']) {
      expect(() => dotenvVariables(`A=1\n${key}=x`)).toThrow(key);
    }
  });
});

describe('maskValues', () => {
  it('masks the content, each dotenv value and JSON secret-key values of 8+ characters, never short ones', () => {
    expect(maskValues('short')).toEqual([]);
    expect(maskValues(`${VALUE}\n`)).toContain(VALUE);
    expect(maskValues(`${VALUE}\n`)).toContain(`${VALUE}\\n`);
    const env = maskValues('A=abcdefghij\nB=short\n');
    expect(env).toContain('abcdefghij');
    expect(env).not.toContain('short');
    const json = maskValues(JSON.stringify({ client_id: 'public-identifier', client_secret: 'secret-value-123', nested: { apiKey: 'nested-key-4567' } }));
    expect(json).toContain('secret-value-123');
    expect(json).toContain('nested-key-4567');
    expect(json).not.toContain('public-identifier');
  });

  it('masks each line of a multi-line secret and the JSON-escaped form', () => {
    const pem = '-----BEGIN KEY-----\nAAAABBBBCCCCDDDD\nEEEEFFFFGGGGHHHH\n-----END KEY-----\n';
    const values = maskValues(pem);
    expect(values).toContain('AAAABBBBCCCCDDDD');
    expect(values).toContain('-----BEGIN KEY-----\\nAAAABBBBCCCCDDDD\\nEEEEFFFFGGGGHHHH\\n-----END KEY-----');
  });
});

describe('MaskingFilter', () => {
  it('masks a value split across chunks, and lets everything else through', () => {
    const filter = new MaskingFilter([VALUE]);
    const parts = [`before ${VALUE.slice(0, 5)}`, VALUE.slice(5, 12), `${VALUE.slice(12)} after `, 'sk-'];
    let out = '';
    for (const p of parts) out += filter.push(Buffer.from(p)).toString('latin1');
    out += filter.end().toString('latin1');
    expect(out).toBe(`before ${MASK} after sk-`);
  });

  it('holds back in linear time: a 200 KB value and a 64 KB chunk take well under a second', () => {
    const big = 'x'.repeat(200_000);
    const filter = new MaskingFilter([big]);
    const started = Date.now();
    const out = filter.push(Buffer.from(`${'x'.repeat(65_535)}y`));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out.length).toBe(65_536);
  });

  it('holds back a start that repeats inside the value', () => {
    const filter = new MaskingFilter(['aabaabaaab']);
    let out = filter.push(Buffer.from('xx aabaabaa')).toString('latin1');
    out += filter.push(Buffer.from('ab yy')).toString('latin1');
    out += filter.end().toString('latin1');
    expect(out).toBe(`xx ${MASK} yy`);
  });
});

describe('runWithSecret', () => {
  it('sets SECRET_FILE and SECRET_NAME, replaces {SECRET_FILE}, strips the bridge token, masks the output', async () => {
    const r = await run(VALUE, ['sh', '-c', 'echo "$SECRET_NAME $SECRET_FILE $1 tok=${AI_BRIDGE_TOKEN:-none}"; echo "leak $V" >&2', 'sh', '{SECRET_FILE}'], { envVar: 'V' });
    expect(r.code).toBe(0);
    expect(r.out).toBe('demo /tmp/demo-secret /tmp/demo-secret tok=none\n');
    expect(r.err).toBe(`leak ${MASK}\n`);
  });

  it('--env puts the trimmed content in the variable', async () => {
    const r = await run(`  ${VALUE}\n`, ['sh', '-c', 'printf "[%s]" "$V" | wc -c'], { envVar: 'V' });
    expect(r.out.trim()).toBe(String(VALUE.length + 2));
  });

  it('--dotenv sets each KEY=VALUE and masks each value', async () => {
    const r = await run('export API_KEY="abcdefghijkl"\n# x\nREGION=eu\n', ['sh', '-c', 'echo "$API_KEY $REGION"'], { dotenv: true });
    expect(r.out).toBe(`${MASK} eu\n`);
  });

  it('--dotenv refuses a secret that sets LD_PRELOAD, and runs nothing', async () => {
    await expect(run('LD_PRELOAD=/tmp/x.so\n', ['sh', '-c', 'echo ran'], { dotenv: true })).rejects.toThrow(/LD_PRELOAD/);
  });

  it('masks a KEY=VALUE value without --dotenv too (a .env read through SECRET_FILE)', async () => {
    const r = await run('FOO=abcdefghijk\n', ['sh', '-c', 'echo abcdefghijk']);
    expect(r.out).toBe(`${MASK}\n`);
  });

  it('masks JSON secret values', async () => {
    const r = await run(JSON.stringify({ token: 'json-token-98765' }), ['sh', '-c', 'echo json-token-98765']);
    expect(r.out).toBe(`${MASK}\n`);
  });



  it('passes the exit code through, 127 for a command not found', async () => {
    expect((await run(VALUE, ['sh', '-c', 'exit 7'])).code).toBe(7);
    const missing = await run(VALUE, ['definitely-not-a-command-xyz']);
    expect(missing.code).toBe(127);
    expect(missing.err).toMatch(/command not found/);
    expect((await run(VALUE, ['sh', '-c', 'kill -TERM $$'])).code).toBe(143);
    expect((await run(VALUE, ['sh', '-c', 'kill -SEGV $$'])).code).toBe(139);
  });
});
