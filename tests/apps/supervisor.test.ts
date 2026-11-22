/**
 * App backends under supervision: started on the first request, one per app
 * version, stopped when idle, started again after a crash, fed by a working
 * copy fetched by content hash, confined by Node's permission model, and
 * behind the same --local-tools gate as local tools.
 */

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppSupervisor, permissionFlags } from '../../src/apps/supervisor.js';
import { SecretStore } from '../../src/local/engram.js';
import type { AppCallMessage } from '../../src/protocol/types.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A backend: echoes what it was asked, its pid and a variable, and crashes on /crash. */
const SERVER = `
const rl = require('readline').createInterface({ input: process.stdin })
let n = 0
rl.on('line', (line) => {
  const req = JSON.parse(line)
  if (req.path === '/crash') process.exit(3)
  if (req.path === '/noisy') console.log('not a response')
  let read = 'allowed'
  if (req.path === '/escape') { try { require('fs').readFileSync('/etc/hostname') } catch (e) { read = e.code } }
  const answer = () => process.stdout.write(JSON.stringify({ id: req.id, status: 201, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid: process.pid, n: ++n, path: req.path, method: req.method, body: req.body, api: req.engram.api,
      token: req.engram.token, secret: process.env.ENGRAM_MAIL_PASSWORD || null, slen: (process.env.ENGRAM_MAIL_PASSWORD || '').length, plain: process.env.ENGRAM_MAIL_USER || null,
      version: process.env.ENGRAM_APP_VERSION, read,
      vault: req.vault ? Object.keys(req.vault).sort() : null, vplain: req.vault?.ENGRAM_MAIL_USER ?? null,
      vsecret: req.vault?.ENGRAM_MAIL_PASSWORD ?? null }) }) + '\\n')
  if (req.path === '/slow') setTimeout(answer, 300); else answer()
})
`;

const files = new Map<string, string>();
let server: Server;
let origin = '';
let fetches = 0;
const dirs: string[] = [];
const supervisors: AppSupervisor[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const hash = (req.url ?? '').split('/').pop()!;
    fetches++;
    const body = files.get(hash);
    if (body === undefined) { res.statusCode = 404; res.end(); return; }
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  origin = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
afterEach(async () => {
  for (const s of supervisors.splice(0)) await s.stopAll();
});

function version(n: number, source = SERVER): AppCallMessage['files'] & { hash: string } {
  const tree: Record<string, string> = {};
  for (const [path, content] of [['server.js', source], ['lib/data.json', `{"v":${n}}`]] as const) {
    files.set(sha(content), content);
    tree[path] = sha(content);
  }
  return { base: `${origin}/app-blobs/tok/`, tree, hash: sha(`version-${n}-${source}`) };
}

function call(v: ReturnType<typeof version>, path = '/items', extra: Partial<AppCallMessage> = {}): AppCallMessage {
  return {
    type: 'app_call', id: `c${Math.random()}`,
    app: { space_id: 'space-1', name: 'todo', version: Number(v.hash.length), hash: v.hash },
    files: { base: v.base, tree: v.tree },
    backend: { main: 'server.js', folders: [], shell: false, programs: [], network: false },
    fill: [],
    request: { method: 'POST', path, headers: {}, body: '{"label":"milk"}' },
    engram: { api: `${origin}/app-api`, token: 'tok-1' },
    ...extra,
  };
}

function supervisor(opts: Partial<ConstructorParameters<typeof AppSupervisor>[0]> = {}, store = new SecretStore()) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-apps-'));
  dirs.push(dir);
  const s = new AppSupervisor({ config: { enabled: true }, apiOrigin: origin, secrets: async () => store, dataDir: dir, ...opts });
  supervisors.push(s);
  return s;
}

const json = (r: Awaited<ReturnType<AppSupervisor['handle']>>) => {
  expect(r.error).toBeUndefined();
  return JSON.parse(r.response!.body) as Record<string, unknown>;
};

describe('app backends', () => {
  it('are refused on a bridge that did not turn on local execution', async () => {
    const s = new AppSupervisor({ config: { enabled: false }, apiOrigin: origin, secrets: async () => new SecretStore() });
    const r = await s.handle(call(version(1)));
    expect(r).toMatchObject({ type: 'app_result', ok: false });
    expect(r.error).toMatch(/--local-tools/);
    expect(s.list()).toEqual([]);
  });

  it('start on the first request and answer on the same process after, one per version', async () => {
    const s = supervisor();
    const v1 = version(1);
    const before = fetches;
    const [a, b] = await Promise.all([s.handle(call(v1)), s.handle(call(v1, '/slow'))]);
    const ja = json(a), jb = json(b);
    expect(a.response).toMatchObject({ status: 201, headers: { 'content-type': 'application/json' } });
    expect(ja).toMatchObject({ path: '/items', method: 'POST', body: '{"label":"milk"}', token: 'tok-1', read: 'allowed' });
    expect(ja.pid).toBe(jb.pid);
    expect(s.list()).toHaveLength(1);
    expect(fetches - before).toBe(2);

    // Another version is another process; the first keeps running.
    const v2 = version(2);
    const c = json(await s.handle(call(v2)));
    expect(c.pid).not.toBe(ja.pid);
    expect(s.list()).toHaveLength(2);
    // The shared server.js blob came from the cache: only the changed file was fetched.
    expect(fetches - before).toBe(3);
  });

  it('stop when idle, and the next request starts a fresh one', async () => {
    const s = supervisor({ idleMs: 150 });
    const v = version(3);
    const first = json(await s.handle(call(v)));
    expect(s.list()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 400));
    expect(s.list()).toHaveLength(0);
    const second = json(await s.handle(call(v)));
    expect(second.pid).not.toBe(first.pid);
    expect(second.n).toBe(1);
  });

  it('start again after a crash, and say why the crashed request failed', async () => {
    const s = supervisor();
    const v = version(4);
    const first = json(await s.handle(call(v)));
    const crashed = await s.handle(call(v, '/crash'));
    expect(crashed.ok).toBe(false);
    expect(crashed.error).toMatch(/stopped before answering: it exited 3/);
    const after = json(await s.handle(call(v)));
    expect(after.pid).not.toBe(first.pid);
  });

  it('stop restarting a backend that keeps crashing', async () => {
    const s = supervisor();
    const v = version(5);
    for (let i = 0; i < 3; i++) await s.handle(call(v, '/crash'));
    const r = await s.handle(call(v));
    expect(r.error).toMatch(/crashed 3 times in the last minute/);
  });

  it('ignore stray stdout lines, and read files only where the manifest allows', async () => {
    const s = supervisor();
    const v = version(6);
    expect(json(await s.handle(call(v, '/noisy'))).path).toBe('/noisy');
    expect(json(await s.handle(call(v, '/escape'))).read).toBe('ERR_ACCESS_DENIED');
    expect(permissionFlags('/w', { main: 's.js', folders: [{ path: '/data/in', write: false }, { path: '/data/out', write: true }], shell: false, programs: [] }))
      .toEqual(['--permission', '--disallow-code-generation-from-strings', '--allow-fs-read=/w', '--allow-fs-read=/data/in', '--allow-fs-read=/data/out', '--allow-fs-write=/data/out']);
    expect(permissionFlags('/w', { main: 's.js', programs: ['git'] })).toContain('--allow-child-process');
    expect(() => permissionFlags('/w', { main: 's.js', folders: [{ path: '/', write: true }] })).toThrow(/whole disk/);
  });

  it('fill vault roles into the environment, and scrub sealed values from what comes back', async () => {
    const store = new SecretStore();
    store.add({ id: 'sec-1', spaceId: 'space-1', itemId: 'item-1', field: 'password', value: 'hunter2-very-secret' });
    const s = supervisor({}, store);
    const v = version(7);
    const fill = [{ role: 'mail', item_id: 'item-1', space_id: 'space-1', fields: { user: 'me@example.test' },
      sealed: [{ field: 'password', secret_id: 'sec-1', space_id: 'space-1' }] }];
    const r = await s.handle(call(v, '/items', { fill }));
    const body = json(r);
    expect(body.plain).toBe('me@example.test');
    expect(body.secret).toBe('[redacted: ENGRAM_MAIL_PASSWORD]');

    // Choosing a different item for the role restarts the version's process: still one per version.
    const other = [{ role: 'mail', item_id: 'item-2', space_id: 'space-1', fields: { user: 'you@example.test' }, sealed: [] }];
    const again = json(await s.handle(call(v, '/items', { fill: other })));
    expect(again.plain).toBe('you@example.test');
    expect(again.pid).not.toBe(body.pid);
    expect(s.list()).toHaveLength(1);
  });

  it('start again when a sealed value it holds is sealed anew under the same id, as a reconnect does', async () => {
    const store = new SecretStore();
    store.add({ id: 'sec-1', spaceId: 'space-1', itemId: 'item-1', field: 'password', value: 'old-sealed-value' });
    const s = supervisor({}, store);
    const v = version(10);
    const fill = [{ role: 'mail', item_id: 'item-1', space_id: 'space-1', fields: { user: 'me@example.test' },
      sealed: [{ field: 'password', secret_id: 'sec-1', space_id: 'space-1' }] }];
    const first = json(await s.handle(call(v, '/items', { fill })));
    // Unchanged: the same process answers.
    expect(json(await s.handle(call(v, '/items', { fill }))).pid).toBe(first.pid);

    // Re-sealed in place: same secret id, field and space, so the fill is identical.
    store.add({ id: 'sec-1', spaceId: 'space-1', itemId: 'item-1', field: 'password', value: 'new-sealed-value-2' });
    const after = json(await s.handle(call(v, '/items', { fill })));
    expect(after.pid).not.toBe(first.pid);
    expect(after.secret).toBe('[redacted: ENGRAM_MAIL_PASSWORD]');
    // The new value, not the old one, is what the fresh process holds.
    expect(first.slen).toBe('old-sealed-value'.length);
    expect(after.slen).toBe('new-sealed-value'.length + 2);
    expect(s.list()).toHaveLength(1);
  });

  it('start one process, not two, for concurrent calls that meet a re-sealed value', async () => {
    const store = new SecretStore();
    store.add({ id: 'sec-1', spaceId: 'space-1', itemId: 'item-1', field: 'password', value: 'old-sealed-value' });
    const delays: number[] = [];
    const s = supervisor({ secrets: async () => { await new Promise((r) => setTimeout(r, delays.shift() ?? 0)); return store; } });
    const v = version(12);
    const fill = [{ role: 'mail', item_id: 'item-1', space_id: 'space-1', fields: { user: 'me@example.test' },
      sealed: [{ field: 'password', secret_id: 'sec-1', space_id: 'space-1' }] }];
    const first = json(await s.handle(call(v, '/items', { fill })));
    store.add({ id: 'sec-1', spaceId: 'space-1', itemId: 'item-1', field: 'password', value: 'new-sealed-value-2' });
    // The second call's values arrive long after the first has replaced the process.
    delays.push(0, 600);
    const [a, b] = await Promise.all([s.handle(call(v, '/items', { fill })), s.handle(call(v, '/items', { fill }))]);
    const ja = json(a), jb = json(b);
    expect(ja.pid).not.toBe(first.pid);
    expect(jb.pid).toBe(ja.pid);
    expect(s.list()).toHaveLength(1);
  });

  it('keep the running process when its sealed values cannot be fetched to compare', async () => {
    const store = new SecretStore();
    store.add({ id: 'sec-1', spaceId: 'space-1', itemId: 'item-1', field: 'password', value: 'kept-sealed-value' });
    let down = false;
    const s = supervisor({ secrets: async () => { if (down) throw new Error('Engram unreachable'); return store; } });
    const v = version(11);
    const fill = [{ role: 'mail', item_id: 'item-1', space_id: 'space-1', fields: { user: 'me@example.test' },
      sealed: [{ field: 'password', secret_id: 'sec-1', space_id: 'space-1' }] }];
    const first = json(await s.handle(call(v, '/items', { fill })));
    down = true;
    expect(json(await s.handle(call(v, '/items', { fill }))).pid).toBe(first.pid);
  });

  it('hand another linked item to one request beside it, never into the environment, on the same process', async () => {
    const store = new SecretStore();
    store.add({ id: 'sec-1', spaceId: 'space-1', itemId: 'item-1', field: 'password', value: 'default-secret-value' });
    store.add({ id: 'sec-2', spaceId: 'space-1', itemId: 'item-2', field: 'password', value: 'second-secret-value' });
    const s = supervisor({}, store);
    const v = version(8);
    const fill = [{ role: 'mail', item_id: 'item-1', space_id: 'space-1', fields: { user: 'me@example.test' },
      sealed: [{ field: 'password', secret_id: 'sec-1', space_id: 'space-1' }] }];
    const use = [{ role: 'mail', item_id: 'item-2', space_id: 'space-1', fields: { user: 'work@example.test' },
      sealed: [{ field: 'password', secret_id: 'sec-2', space_id: 'space-1' }] }];

    const plain = json(await s.handle(call(v, '/items', { fill })));
    expect(plain.vault).toBeNull();
    const named = json(await s.handle(call(v, '/items', { fill, use })));
    // The same process: the defaults stay in its environment, untouched.
    expect(named.pid).toBe(plain.pid);
    expect(named.plain).toBe('me@example.test');
    expect(named.vault).toEqual(['ENGRAM_MAIL_PASSWORD', 'ENGRAM_MAIL_USER']);
    expect(named.vplain).toBe('work@example.test');
    // Opened here and handed over, then scrubbed from the answer like the fill's.
    expect(named.vsecret).toBe('[redacted: ENGRAM_MAIL_PASSWORD]');
    // The next request without `use` sees none of it.
    expect(json(await s.handle(call(v, '/items', { fill }))).vault).toBeNull();
    expect(s.list()).toHaveLength(1);

    // A role the call does not fill cannot be handed over on the side.
    const r = await s.handle(call(v, '/items', { fill, use: [{ ...use[0]!, role: 'other' }] }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/a role it does not fill/);
  });

  it('refuse files that do not match their hash, and URLs off the server it is connected to', async () => {
    const s = supervisor();
    const v = version(8);
    const bad = { ...v.tree, 'server.js': sha('something else') };
    files.set(sha('something else'), 'tampered');
    const r = await s.handle(call(v, '/items', { files: { base: v.base, tree: bad }, app: { space_id: 's', name: 'todo', version: 1, hash: sha('v8b') } }));
    expect(r.error).toMatch(/does not match its content hash/);
    const off = await s.handle(call(v, '/items', { engram: { api: 'https://elsewhere.example/app-api', token: 't' } }));
    expect(off.error).toMatch(/not the server this bridge is connected to/);
    const escape = await s.handle(call(v, '/items', { files: { base: v.base, tree: { ...v.tree, '../x.js': v.tree['server.js']! } } }));
    expect(escape.error).toMatch(/cannot be written safely/);
  });
});
