/**
 * Web search on a turn (`options.web_search: true`, decision 0016), driven over
 * a real WebSocket against the real Claude adapter with only its spawn
 * intercepted: what matters is the argv the CLI would be launched with.
 *
 * On a bridge started with `--allow-web-search` the opt-in adds exactly Claude
 * Code's built-in `WebSearch` to an isolated turn's allowed tools, and nothing
 * else built in. Absent, false or any value other than `true` changes nothing.
 * Without the operator's flag hello has no `web_search` and an isolated turn
 * asking is refused, never run without the tool; so is one on another provider.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { Bridge, resolveWebSearch } from '../../src/bridge.js';
import { ClaudeAdapter } from '../../src/providers/claude.js';
import { ProviderAdapter, type AdapterStreamEvent, type ExecutionContext } from '../../src/providers/base.js';
import type { ModelInfo } from '../../src/protocol/types.js';
import { BRIDGE_MCP_SERVER_NAME } from '../../src/mcp/cli-config.js';

/** The real Claude adapter, launching a no-op process instead of claude. */
class ClaudeProbe extends ClaudeAdapter {
  readonly launches: string[][] = [];
  protected override spawnCli(
    _command: string, args: string[], env: NodeJS.ProcessEnv, stdinInput?: string, cwd?: string,
  ): ChildProcessByStdio<Writable | null, Readable, Readable> {
    this.launches.push(args);
    return spawn(process.execPath, ['-e', ''], {
      env, cwd, stdio: [stdinInput !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
  }
}

/** Another provider: records the context it was handed. */
class OtherAdapter extends ProviderAdapter {
  readonly providerName = 'codex';
  readonly seen: ExecutionContext[] = [];
  execute(context: ExecutionContext, onEvent: (e: AdapterStreamEvent) => void): Promise<string | null> {
    this.seen.push(context);
    onEvent({ event: 'done', data: {} });
    return Promise.resolve(null);
  }
  listModels(): Promise<ModelInfo[]> { return Promise.resolve([]); }
}

let wss: WebSocketServer | null = null;
let socket: WsSocket;
let frames: Record<string, unknown>[];
let bridge: Bridge | null = null;
let root: string | null = null;
let claude: ClaudeProbe;
let other: OtherAdapter;

async function waitFor(match: (f: Record<string, unknown>) => boolean, what: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const found = frames.find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; saw: ${JSON.stringify(frames).slice(0, 2000)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function finished(id: string): Promise<{ event: string; data: Record<string, unknown> }[]> {
  await waitFor((f) => f['type'] === 'stream' && f['request_id'] === id && f['event'] === 'done', `done for ${id}`);
  return frames.filter((f) => f['type'] === 'stream' && f['request_id'] === id)
    .map((f) => ({ event: f['event'] as string, data: f['data'] as Record<string, unknown> }));
}
const errorCode = (out: { event: string; data: Record<string, unknown> }[]) => out.find((e) => e.event === 'error')?.data['code'];
/** Not refused for web search (the stand-in CLI says nothing, so the turn itself ends empty). */
const notRefused = (out: { event: string; data: Record<string, unknown> }[]) => expect(String(errorCode(out) ?? '')).not.toMatch(/^web_search_/);

function sendRequest(overrides: Record<string, unknown>): string {
  const requestId = `req_${Math.random().toString(36).slice(2, 8)}`;
  socket.send(JSON.stringify({
    type: 'ai_request', request_id: requestId, conversation_id: 'conv-1', provider: 'claude',
    message: 'hello', system_prompt: 'be useful', options: {}, cli_session_id: null, ...overrides,
  }));
  return requestId;
}

/** A bridge on a connection whose server adopted `posture`. */
async function connect(posture: 'isolated' | 'workspace', webSearch?: boolean): Promise<void> {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'web-search-')));
  mkdirSync(join(root, 'repo'), { recursive: true });
  frames = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss = server;
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  server.once('connection', (ws) => {
    socket = ws;
    ws.on('message', (raw) => { frames.push(JSON.parse(raw.toString()) as Record<string, unknown>); });
  });
  claude = new ClaudeProbe();
  other = new OtherAdapter();
  bridge = new Bridge({
    serverUrl: url, token: 'tok', sessionStorePath: null,
    providers: [
      { name: 'claude', version: '1', available: true, supports_streaming: true, supports_tools: true, supports_thinking: true, supports_session_resume: true },
      { name: 'codex', version: '1', available: true, supports_streaming: true, supports_tools: true, supports_thinking: false, supports_session_resume: true },
    ],
    adapters: new Map<string, ProviderAdapter>([['claude', claude], ['codex', other]]),
    allowedRoots: [{ path: root, label: 'root' }],
    ...(webSearch === undefined ? {} : { webSearch }),
  });
  bridge.connect();
  await waitFor((f) => f['type'] === 'hello', 'hello');
  socket.send(JSON.stringify({
    type: 'welcome', session_id: 'conn-1',
    tools: [{ name: 'read', description: 'Read a row', parameters: { type: 'object', properties: {} } }],
    config: { heartbeat_interval: 30, request_timeout: 30 },
    cli_isolation: posture,
  }));
  await waitFor((f) => f['type'] === 'posture', 'posture');
}

afterEach(async () => {
  await bridge?.disconnect();
  bridge = null;
  if (wss) await new Promise<void>((resolve) => wss!.close(() => resolve()));
  wss = null;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

const flag = (args: string[], name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const allowedOf = (args: string[]) => (flag(args, '--allowedTools') ?? '').split(',');
const BRIDGE_TOOLS = `mcp__${BRIDGE_MCP_SERVER_NAME}__*`;
const claudeLike = { enforcesServerToolsOnly: true, providerName: 'claude' };
const codexLike = { enforcesServerToolsOnly: false, providerName: 'codex' };

describe('a bridge started with --allow-web-search, on an isolated connection', () => {
  it('announces web_search in hello', async () => {
    await connect('isolated', true);
    expect(frames.find((f) => f['type'] === 'hello')!['web_search']).toBe(true);
  });

  it('adds exactly WebSearch to a turn that asks with true', async () => {
    await connect('isolated', true);
    const id = sendRequest({ options: { web_search: true } });
    notRefused(await finished(id));
    const args = claude.launches.at(-1)!;
    expect(allowedOf(args)).toEqual([BRIDGE_TOOLS, 'WebSearch']);
    // Still the posture that denies everything else: no WebFetch, Bash, Read.
    expect(flag(args, '--permission-mode')).toBe('manual');
    expect(args).toContain('--strict-mcp-config');
    // (The allow-list above is the whole grant; the system prompt may mention tool names, so not the joined argv.)
    expect(args).not.toContain('bypassPermissions');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('changes nothing when the field is absent, false, or anything but true', async () => {
    await connect('isolated', true);
    for (const options of [{}, { web_search: false }, { web_search: null }, { web_search: 'yes' }, { web_search: 1 }]) {
      const id = sendRequest({ options });
      notRefused(await finished(id));
      expect(allowedOf(claude.launches.at(-1)!), JSON.stringify(options)).toEqual([BRIDGE_TOOLS]);
    }
  });

  it('refuses it on a provider that cannot be given exactly that tool', async () => {
    await connect('isolated', true);
    const id = sendRequest({ provider: 'codex', options: { web_search: true } });
    expect(errorCode(await finished(id))).toBe('web_search_unsupported');
    expect(other.seen).toHaveLength(0);
  });
});

describe('a bridge started without --allow-web-search (the default)', () => {
  it('does not announce web_search in hello', async () => {
    await connect('isolated');
    expect(frames.find((f) => f['type'] === 'hello')!).not.toHaveProperty('web_search');
  });

  it('refuses an isolated turn that asks, rather than running it without search', async () => {
    await connect('isolated');
    const id = sendRequest({ options: { web_search: true } });
    expect(errorCode(await finished(id))).toBe('web_search_not_allowed');
    expect(claude.launches).toHaveLength(0);
  });

  it('runs every other turn exactly as before', async () => {
    await connect('isolated');
    const id = sendRequest({ options: { web_search: false } });
    notRefused(await finished(id));
    expect(allowedOf(claude.launches.at(-1)!)).toEqual([BRIDGE_TOOLS]);
  });
});

describe('a workspace connection', () => {
  it('a turn narrowed to isolated gets WebSearch when it asks, and still nothing else', async () => {
    await connect('workspace', true);
    const id = sendRequest({ cli_isolation: 'isolated', options: { web_search: true } });
    notRefused(await finished(id));
    const args = claude.launches.at(-1)!;
    expect(allowedOf(args)).toEqual([BRIDGE_TOOLS, 'WebSearch']);
    expect(flag(args, '--permission-mode')).toBe('manual');
  });

  it('an ordinary workspace turn is unchanged by the field, flag or not', async () => {
    await connect('workspace');
    const id = sendRequest({ working_dir: join(root!, 'repo'), options: { web_search: true } });
    notRefused(await finished(id));
    const args = claude.launches.at(-1)!;
    // Every built-in tool is already allowed there; no list is added.
    expect(args).not.toContain('--allowedTools');
    expect(flag(args, '--permission-mode')).toBe('bypassPermissions');
  });
});

describe('resolveWebSearch', () => {
  it('grants it only for options.web_search === true on an isolated Claude turn of a bridge that allows it', () => {
    const yes = { options: { web_search: true } };
    expect(resolveWebSearch(yes, true, 'isolated', claudeLike)).toEqual({ webSearch: true, refusal: null });
    expect(resolveWebSearch(yes, false, 'isolated', claudeLike).refusal?.code).toBe('web_search_not_allowed');
    expect(resolveWebSearch(yes, true, 'isolated', codexLike).refusal?.code).toBe('web_search_unsupported');
    expect(resolveWebSearch(yes, false, 'workspace', claudeLike)).toEqual({ webSearch: false, refusal: null });
    expect(resolveWebSearch({ options: {} }, true, 'isolated', claudeLike)).toEqual({ webSearch: false, refusal: null });
    expect(resolveWebSearch({ options: { web_search: 'true' as unknown as boolean } }, true, 'isolated', claudeLike))
      .toEqual({ webSearch: false, refusal: null });
  });
});
