/**
 * `aib secret run` (src/secrets/run.ts, decision 0020): the environment it
 * hands over, "{SECRET_FILE}", output masking (also across chunks), exit codes.
 */
import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { MASK, MaskingFilter, maskValues, parseDotenv, runWithSecret } from '../../src/secrets/run.js';

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

describe('maskValues', () => {
  it('masks the content, each dotenv value and JSON secret-key values of 8+ characters, never short ones', () => {
    expect(maskValues('short')).toEqual([]);
    expect(maskValues(`${VALUE}\n`)).toEqual([`${VALUE}\n`, VALUE]);
    const env = maskValues('A=abcdefghij\nB=short\n', { dotenv: true });
    expect(env).toContain('abcdefghij');
    expect(env).not.toContain('short');
    const json = maskValues(JSON.stringify({ client_id: 'public-identifier', client_secret: 'secret-value-123', nested: { apiKey: 'nested-key-4567' } }));
    expect(json).toContain('secret-value-123');
    expect(json).toContain('nested-key-4567');
    expect(json).not.toContain('public-identifier');
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

  it('masks JSON secret values', async () => {
    const r = await run(JSON.stringify({ token: 'json-token-98765' }), ['sh', '-c', 'echo json-token-98765']);
    expect(r.out).toBe(`${MASK}\n`);
  });

  it('--no-mask passes output through untouched', async () => {
    const r = await run(VALUE, ['true'], { mask: false });
    expect(r.code).toBe(0);
  });

  it('passes the exit code through, 127 for a command not found', async () => {
    expect((await run(VALUE, ['sh', '-c', 'exit 7'])).code).toBe(7);
    const missing = await run(VALUE, ['definitely-not-a-command-xyz']);
    expect(missing.code).toBe(127);
    expect(missing.err).toMatch(/command not found/);
    expect((await run(VALUE, ['sh', '-c', 'kill -TERM $$'])).code).toBe(143);
  });
});
