/**
 * UpstreamHub against a real MCP server, over stdio (a child process) and
 * Streamable HTTP (in this process): what the model is offered, what the host
 * gets, what is refused, and what happens when the server is slow or dies.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  UpstreamHub, UpstreamError, parseUpstreamConfig, visibility,
  type UpstreamConfig, type SecretResolver,
} from '../../src/mcp/upstream.js';
import { makeServer, VIEW_URI, LISTED_URI, VIEW_UI, LISTED_UI } from './fixtures/upstream-server.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/upstream-server.mjs', import.meta.url));
const stdio = (extra: Partial<UpstreamConfig> = {}): UpstreamConfig => ({ command: process.execPath, args: [FIXTURE, '--stdio'], ...extra } as UpstreamConfig);

let hub: UpstreamHub | null = null;
afterEach(async () => {
  await hub?.close();
  hub = null;
});

async function until<T>(fn: () => T | undefined | false, what: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function rejection(p: Promise<unknown>): Promise<UpstreamError> {
  try { await p; } catch (err) { return err as UpstreamError; }
  throw new Error('expected a rejection');
}

// ---------------------------------------------------------------------------

describe('parseUpstreamConfig', () => {
  it('accepts the mcpServers wrapper and the bare map', () => {
    expect(parseUpstreamConfig({ mcpServers: { a: { command: 'x' } } })).toEqual({ a: { command: 'x' } });
    expect(parseUpstreamConfig({ a: { url: 'https://h/mcp' } })).toEqual({ a: { url: 'https://h/mcp' } });
  });

  it('reads tools_refresh_ms and refuses a bad one', () => {
    expect(parseUpstreamConfig({ a: { command: 'x', tools_refresh_ms: 0 } })['a']).toMatchObject({ tools_refresh_ms: 0 });
    expect(() => parseUpstreamConfig({ a: { command: 'x', tools_refresh_ms: -1 } })).toThrow(/tools_refresh_ms/);
    expect(() => parseUpstreamConfig({ a: { command: 'x', tools_refresh_ms: '60' } })).toThrow(/tools_refresh_ms/);
    expect(() => parseUpstreamConfig({ a: { command: 'x', tools_refresh_ms: 60 } })).toThrow(/milliseconds/);
    expect(() => parseUpstreamConfig({ a: { command: 'x', tools_refresh_ms: 86_400_001 } })).toThrow(/1 day/);
    expect(parseUpstreamConfig({ a: { command: 'x', tools_refresh_ms: 5000 } })['a']).toMatchObject({ tools_refresh_ms: 5000 });
    expect(parseUpstreamConfig({ a: { command: 'x', tools_refresh_ms: 86_400_000 } })['a']).toMatchObject({ tools_refresh_ms: 86_400_000 });
  });

  it('keeps env/vault references and literal non-secrets', () => {
    const cfg = parseUpstreamConfig({ mcpServers: {
      gh: { url: 'https://h/mcp', headers: { Authorization: { env: 'GH_TOKEN', prefix: 'Bearer ' }, 'X-Org': 'acme' } },
      db: { command: 'db-mcp', env: { DB_PASSWORD: { vault: { space_id: 's1', secret_id: 'v1' } }, DB_HOST: 'localhost' }, timeout_ms: 5000 },
    } });
    expect(cfg['gh']).toEqual({ url: 'https://h/mcp', headers: { Authorization: { env: 'GH_TOKEN', prefix: 'Bearer ' }, 'X-Org': 'acme' } });
    expect(cfg['db']).toMatchObject({ env: { DB_PASSWORD: { vault: { space_id: 's1', secret_id: 'v1' } }, DB_HOST: 'localhost' }, timeout_ms: 5000 });
  });

  it.each([
    [{ a: { url: 'https://h', headers: { Authorization: 'Bearer abc' } } }, /looks like a credential/],
    [{ a: { command: 'x', env: { GITHUB_TOKEN: 'ghp_x' } } }, /looks like a credential/],
    [{ a: { command: 'x', env: { OPENAI_API_KEY: 'sk' } } }, /looks like a credential/],
    [{ a: { url: 'https://user:pw@h/mcp' } }, /no credentials in the url/],
    [{ a: { url: 'ftp://h' } }, /http\(s\)/],
    [{ 'a__b': { command: 'x' } }, /a name is/],
    [{ 'a b': { command: 'x' } }, /a name is/],
    [{ a: {} }, /needs "command"/],
    [{ a: { command: 'x', url: 'https://h' } }, /not both/],
    [{ a: { command: 'x', args: [1] } }, /args/],
    [{ a: { command: 'x', timeout_ms: 5 } }, /timeout_ms/],
    [{ a: { command: 'x', env: { X: { vault: { space_id: 's' } } } } }, /must be a string/],
  ])('refuses %j', (doc, msg) => {
    expect(() => parseUpstreamConfig(doc)).toThrow(msg);
  });
});

describe('visibility', () => {
  it('defaults to model and app, per spec', () => {
    expect(visibility(undefined)).toEqual(['model', 'app']);
    expect(visibility({ ui: { resourceUri: 'ui://x' } })).toEqual(['model', 'app']);
    expect(visibility({ ui: { visibility: ['app'] } })).toEqual(['app']);
    expect(visibility({ ui: { visibility: [] } })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('UpstreamHub over stdio', () => {
  it('offers model-visible tools namespaced, with _meta, and never app-only ones', async () => {
    hub = new UpstreamHub({ fx: stdio() });
    await hub.start();
    const defs = hub.definitions();
    const names = defs.map((d) => d.name);
    expect(names).toContain('fx__show');
    expect(names).toContain('fx__model_only');
    expect(names).toContain('fx__plain');
    expect(names).not.toContain('fx__app_only');
    expect(defs.find((d) => d.name === 'fx__show')!._meta).toEqual({ ui: { resourceUri: VIEW_URI } });
    expect(hub.owns('fx__app_only')).toBe(false);
    await expect(hub.callFromModel('fx__app_only', {})).rejects.toMatchObject({ code: 'refused' });
  });

  it('gives the model text only and keeps the whole result for the host, once, by the provider call id', async () => {
    hub = new UpstreamHub({ fx: stdio() });
    await hub.start();
    const out = await hub.callFromModel('fx__show', { x: 5 }, 'toolu_1');
    expect(out).toEqual({ text: 'shown 5', isError: false });
    const ui = hub.takeUi('toolu_1');
    expect(ui).toEqual({
      server: 'fx', tool_name: 'show', resource_uri: VIEW_URI, arguments: { x: 5 },
      result: { content: [{ type: 'text', text: 'shown 5' }], structuredContent: { x: 5 }, _meta: { 'fx/secretish': 'host only' } },
    });
    expect(hub.takeUi('toolu_1')).toBeUndefined();
  });

  it('keeps no view for a tool without one, or a call without a provider id', async () => {
    hub = new UpstreamHub({ fx: stdio() });
    await hub.start();
    await hub.callFromModel('fx__plain', {}, 'toolu_2');
    expect(hub.takeUi('toolu_2')).toBeUndefined();
    await hub.callFromModel('fx__show', { x: 1 });
    expect(hub.takeUi('undefined')).toBeUndefined();
  });

  it('passes isError through and falls back to structuredContent when there is no text', async () => {
    hub = new UpstreamHub({ fx: stdio() });
    await hub.start();
    expect(await hub.callFromModel('fx__fail', {})).toEqual({ text: 'it failed', isError: true });
    expect(await hub.callFromModel('fx__structured_only', {})).toEqual({ text: '{"n":7}', isError: false });
  });

  it('reads a ui:// view with its declared csp and permissions unchanged', async () => {
    hub = new UpstreamHub({ fx: stdio() });
    await hub.start();
    const res = await hub.request('fx', 'resources/read', { uri: VIEW_URI }) as { contents: Record<string, unknown>[] };
    expect(res.contents[0]).toMatchObject({ uri: VIEW_URI, text: '<p>view</p>', mimeType: 'text/html;profile=mcp-app' });
    expect(res.contents[0]!['_meta']).toEqual({ ui: VIEW_UI });
  });

  it('fills a content item without _meta.ui from its resources/list entry', async () => {
    hub = new UpstreamHub({ fx: stdio() });
    await hub.start();
    const res = await hub.request('fx', 'resources/read', { uri: LISTED_URI }) as { contents: Record<string, unknown>[] };
    expect(res.contents[0]!['_meta']).toEqual({ ui: LISTED_UI });
  });

  it('refuses what a view may not do', async () => {
    hub = new UpstreamHub({ fx: stdio() });
    await hub.start();
    expect(await rejection(hub.request('fx', 'resources/read', { uri: 'file:///etc/passwd' }))).toMatchObject({ code: 'refused' });
    expect(await rejection(hub.request('fx', 'tools/call', { name: 'model_only' }))).toMatchObject({ code: 'refused' });
    expect(await rejection(hub.request('fx', 'tools/call', { name: 'nope' }))).toMatchObject({ code: 'refused' });
    expect(await rejection(hub.request('fx', 'prompts/list', {}))).toMatchObject({ code: 'unsupported' });
    expect(await rejection(hub.request('other', 'tools/call', { name: 'show' }))).toMatchObject({ code: 'unknown_server' });
  });

  it('lets a view call app-visible tools, including app-only ones', async () => {
    hub = new UpstreamHub({ fx: stdio() });
    await hub.start();
    expect(await hub.request('fx', 'tools/call', { name: 'app_only', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: 'app ok' }] });
    expect(await hub.request('fx', 'tools/call', { name: 'show', arguments: { x: 2 } })).toMatchObject({ structuredContent: { x: 2 } });
  });

  it('maps a server error to upstream_error and keeps the connection', async () => {
    hub = new UpstreamHub({ fx: stdio() });
    await hub.start();
    const pid = (await hub.callFromModel('fx__pid', {})).text;
    const err = await rejection(hub.request('fx', 'tools/call', { name: 'throws' }));
    expect(err.code).toBe('upstream_error');
    expect(err.message).toMatch(/fixture refused/);
    expect((await hub.callFromModel('fx__pid', {})).text).toBe(pid);
  });

  it('times out a slow call with code timeout, and the connection survives', async () => {
    hub = new UpstreamHub({ fx: stdio({ timeout_ms: 300 }) });
    await hub.start();
    const err = await rejection(hub.request('fx', 'tools/call', { name: 'slow', arguments: { ms: 2000 } }));
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.code).toBe('timeout');
    expect((await hub.callFromModel('fx__plain', {})).text).toBe('plain ok');
  });

  it('fails a call in flight when the server dies, and reconnects on the next use', async () => {
    hub = new UpstreamHub({ fx: stdio() });
    await hub.start();
    const pid1 = (await hub.callFromModel('fx__pid', {})).text;
    const err = await rejection(hub.callFromModel('fx__die', {}));
    expect(err.code).toBe('upstream_error');
    // Its tools stay offered while it is down.
    expect(hub.definitions().map((d) => d.name)).toContain('fx__show');
    const pid2 = (await hub.callFromModel('fx__pid', {})).text;
    expect(pid2).not.toBe(pid1);
    expect(hub.status()['fx']!.connected).toBe(true);
  });

  it('reconnects in the background after the server dies', async () => {
    hub = new UpstreamHub({ fx: stdio() });
    await hub.start();
    await rejection(hub.callFromModel('fx__die', {}));
    await until(() => hub!.status()['fx']!.connected, 'background reconnect');
  });

  it('leaves out a server that will not start, retries it, and says why', async () => {
    let changes = 0;
    hub = new UpstreamHub({ bad: { command: '/nonexistent/mcp-server' }, fx: stdio() }, { onToolsChanged: () => { changes++; } });
    await hub.start();
    expect(hub.status()['bad']).toMatchObject({ connected: false, tools: 0 });
    expect(hub.status()['bad']!.last_error).toBeTruthy();
    expect(hub.status()['fx']!.connected).toBe(true);
    expect(changes).toBeGreaterThanOrEqual(1);
    expect(await rejection(hub.request('bad', 'resources/read', { uri: 'ui://x' }))).toMatchObject({ code: 'unavailable' });
  });

  it('times out a server that never finishes initializing', async () => {
    hub = new UpstreamHub({ hang: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], connect_timeout_ms: 300 } });
    const t0 = Date.now();
    await hub.start();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(hub.status()['hang']!.last_error).toMatch(/timed out/);
  });

  it('picks up tools/list_changed', async () => {
    let changes = 0;
    hub = new UpstreamHub({ fx: stdio() }, { onToolsChanged: () => { changes++; } });
    await hub.start();
    const before = changes;
    await hub.callFromModel('fx__add_tool', {});
    await until(() => hub!.owns('fx__added'), 'the added tool');
    expect(changes).toBeGreaterThan(before);
  });

  describe('background refresh of tool lists (D10067)', () => {
    it('shows a tool the server added without tools/list_changed after the next background read', async () => {
      let changes = 0;
      hub = new UpstreamHub({ fx: stdio({ tools_refresh_ms: 50 } as Partial<UpstreamConfig>) }, { onToolsChanged: () => { changes++; } });
      await hub.start();
      const before = changes;
      await hub.callFromModel('fx__add_tool_silently', {});
      expect(hub.owns('fx__silent')).toBe(false);
      await until(() => hub!.owns('fx__silent'), 'the background refresh');
      expect(changes).toBe(before + 1);
    });

    it('never refreshes with tools_refresh_ms 0', async () => {
      hub = new UpstreamHub({ fx: stdio({ tools_refresh_ms: 0 } as Partial<UpstreamConfig>) });
      await hub.start();
      await hub.callFromModel('fx__add_tool_silently', {});
      await new Promise((r) => setTimeout(r, 200));
      expect(hub.owns('fx__silent')).toBe(false);
    });

    it('does not report a change when the list is the same', async () => {
      let changes = 0;
      hub = new UpstreamHub({ fx: stdio({ tools_refresh_ms: 30 } as Partial<UpstreamConfig>) }, { onToolsChanged: () => { changes++; } });
      await hub.start();
      const before = changes;
      await new Promise((r) => setTimeout(r, 200));
      expect(changes).toBe(before);
    });

    it('keeps the list and the connection while reads are slow or fail, and catches up afterwards', async () => {
      hub = new UpstreamHub({ fx: stdio({ tools_refresh_ms: 30, timeout_ms: 100 } as Partial<UpstreamConfig>) });
      await hub.start();
      await hub.callFromModel('fx__slow_lists', { ms: 400 });
      await hub.callFromModel('fx__add_tool_silently', {});
      await new Promise((r) => setTimeout(r, 300));
      expect(hub.owns('fx__plain')).toBe(true);
      expect(hub.owns('fx__silent')).toBe(false);
      await hub.callFromModel('fx__slow_lists', { ms: 0 });
      await until(() => hub!.owns('fx__silent'), 'the refresh after reads are fast again');
    });

    it('stops refreshing when closed', async () => {
      hub = new UpstreamHub({ fx: stdio({ tools_refresh_ms: 20 } as Partial<UpstreamConfig>) });
      await hub.start();
      await hub.close();
      await new Promise((r) => setTimeout(r, 100));
      expect(hub.status()['fx']?.connected).toBe(false);
      hub = null;
    });
  });

  it('starts a stdio server with only the safe environment plus what the config names, and redacts secrets', async () => {
    process.env['AIB_TEST_LEAK'] = 'bridge-only-value';
    const resolver: SecretResolver = async (ref) => ('env' in ref && ref.env === 'SRC' ? 'super-secret-value-123' : 'x');
    hub = new UpstreamHub({ fx: stdio({ env: { FX_SECRET: { env: 'SRC' }, FX_PLAIN: 'hello' } } as Partial<UpstreamConfig>) }, { resolveSecret: resolver });
    await hub.start();
    expect((await hub.callFromModel('fx__echo_env', { name: 'AIB_TEST_LEAK' })).text).toBe('value=(unset)');
    expect((await hub.callFromModel('fx__echo_env', { name: 'FX_PLAIN' })).text).toBe('value=hello');
    expect((await hub.callFromModel('fx__echo_env', { name: 'FX_SECRET' })).text).toBe('value=[redacted: fx.FX_SECRET]');
    const viaView = await hub.request('fx', 'tools/call', { name: 'echo_env', arguments: { name: 'FX_SECRET' } });
    expect(JSON.stringify(viaView)).not.toContain('super-secret-value-123');
    delete process.env['AIB_TEST_LEAK'];
  });

  it('reports a reference it cannot resolve as unavailable, without starting the server', async () => {
    hub = new UpstreamHub({ fx: stdio({ env: { FX_SECRET: { env: 'AIB_DEFINITELY_UNSET' } } } as Partial<UpstreamConfig>) });
    await hub.start();
    expect(hub.status()['fx']).toMatchObject({ connected: false });
    expect(hub.status()['fx']!.last_error).toMatch(/AIB_DEFINITELY_UNSET is not set/);
  });

  it('close() stops background reconnects and refuses further use', async () => {
    hub = new UpstreamHub({ bad: { command: '/nonexistent/mcp-server' } });
    await hub.start();
    await hub.close();
    expect(await rejection(hub.request('bad', 'resources/read', { uri: 'ui://x' }))).toMatchObject({ code: 'unavailable' });
  });
});

// ---------------------------------------------------------------------------

describe('UpstreamHub over Streamable HTTP', () => {
  let http: HttpServer;
  let url: string;
  let seen: IncomingHttpHeaders[];
  let transports: Map<string, StreamableHTTPServerTransport>;

  beforeEach(async () => {
    seen = [];
    transports = new Map();
    http = createServer(async (req, res) => {
      seen.push(req.headers);
      const sid = req.headers['mcp-session-id'] as string | undefined;
      let transport = sid ? transports.get(sid) : undefined;
      if (!transport) {
        if (sid) { res.writeHead(404).end(); return; }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { transports.set(id, transport!); },
        });
        await makeServer({ onExit: () => { transports.clear(); } }).connect(transport);
      }
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  });

  afterEach(async () => {
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
  });

  it('connects with resolved headers, offers tools, and proxies a view', async () => {
    const resolver: SecretResolver = async (ref) => ('env' in ref ? `${ref.prefix ?? ''}tok-abc-123` : '');
    hub = new UpstreamHub({ web: { url, headers: { Authorization: { env: 'X', prefix: 'Bearer ' }, 'X-Org': 'acme' } } }, { resolveSecret: resolver });
    await hub.start();
    expect(seen[0]!['authorization']).toBe('Bearer tok-abc-123');
    expect(seen[0]!['x-org']).toBe('acme');
    expect(hub.definitions().map((d) => d.name)).toContain('web__show');
    expect(hub.definitions().map((d) => d.name)).not.toContain('web__app_only');
    const res = await hub.request('web', 'resources/read', { uri: VIEW_URI }) as { contents: Record<string, unknown>[] };
    expect(res.contents[0]!['_meta']).toEqual({ ui: VIEW_UI });
    expect(await hub.request('web', 'tools/call', { name: 'app_only' })).toMatchObject({ content: [{ text: 'app ok' }] });
    await hub.callFromModel('web__show', { x: 9 }, 'toolu_h');
    expect(hub.takeUi('toolu_h')).toMatchObject({ server: 'web', resource_uri: VIEW_URI, result: { structuredContent: { x: 9 } } });
  });

  it('times out a slow call', async () => {
    hub = new UpstreamHub({ web: { url, timeout_ms: 300 } });
    await hub.start();
    expect(await rejection(hub.request('web', 'tools/call', { name: 'slow', arguments: { ms: 2000 } }))).toMatchObject({ code: 'timeout' });
  });

  it('reconnects when the server forgets the session (a restart)', async () => {
    hub = new UpstreamHub({ web: { url } });
    await hub.start();
    transports.clear();
    // The first use after a restart fails (404 on the old session) and drops the connection...
    const err = await rejection(hub.callFromModel('web__plain', {}));
    expect(err.code).toBe('upstream_error');
    // ...and the next one opens a new session.
    expect((await hub.callFromModel('web__plain', {})).text).toBe('plain ok');
  });

  it('is unavailable while the server is down', async () => {
    hub = new UpstreamHub({ web: { url: 'http://127.0.0.1:1/mcp', connect_timeout_ms: 2000 } });
    await hub.start();
    expect(hub.status()['web']!.connected).toBe(false);
    expect(await rejection(hub.request('web', 'resources/read', { uri: VIEW_URI }))).toMatchObject({ code: 'unavailable' });
  });
});
