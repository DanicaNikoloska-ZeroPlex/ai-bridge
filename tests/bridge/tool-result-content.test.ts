/**
 * A server tool answering with content parts (`tool_resolve.content`): text and
 * images reach the CLI as MCP content blocks; a server that sends only
 * `result` (any older one) gets the one text block it always did; content the
 * bridge will not pass on falls back to `result`.
 *
 * The fake adapter plays the CLI with a real MCP client against the bridge's
 * own MCP server, as in mcp-apps.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Bridge } from '../../src/bridge.js';
import { ProviderAdapter, type AdapterStreamEvent, type ExecutionContext } from '../../src/providers/base.js';
import type { ModelInfo, WelcomeMessage } from '../../src/protocol/types.js';

type Cli = (client: Client) => Promise<void>;

class CliAdapter extends ProviderAdapter {
  readonly providerName = 'fake';
  constructor(private readonly cli: Cli) { super(); }
  async execute(context: ExecutionContext, onEvent: (e: AdapterStreamEvent) => void): Promise<string | null> {
    if (!context.mcp) throw new Error('no MCP channel for the turn');
    const client = new Client({ name: 'fake-cli', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(context.mcp.url), {
      requestInit: { headers: { Authorization: `Bearer ${context.mcp.bearerToken}` } },
    }));
    try {
      await this.cli(client);
    } finally {
      await client.close();
    }
    onEvent({ event: 'done', data: {} });
    return 'sess-1';
  }
  listModels(): Promise<ModelInfo[]> { return Promise.resolve([]); }
}

// A 1x1 transparent PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let wss: WebSocketServer;
let socket: WsSocket;
let frames: Record<string, unknown>[];
let bridge: Bridge | null = null;
/** What the fake server answers a tool_call with, besides the ids. */
let answer: Record<string, unknown>;

async function waitFor(match: (f: Record<string, unknown>) => boolean, what: string, ms = 8000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = frames.find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  frames = [];
  answer = { result: 'plain' };
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wss.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as Record<string, unknown>;
      frames.push(f);
      if (f['type'] === 'tool_call') {
        ws.send(JSON.stringify({ type: 'tool_resolve', request_id: f['request_id'], tool_call_id: f['tool_call_id'], ...answer }));
      }
    });
  });
});

afterEach(async () => {
  await bridge?.disconnect();
  bridge = null;
  await new Promise<void>((r) => wss.close(() => r()));
});

/** Run one turn whose CLI calls the server tool `render` and returns what it got. */
async function callRender(): Promise<{ content: Record<string, unknown>[]; isError?: boolean }> {
  let got: unknown;
  bridge = new Bridge({
    serverUrl: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`,
    token: 'tok-1',
    providers: [],
    adapters: new Map([['fake', new CliAdapter(async (client) => {
      got = await client.callTool({ name: 'render', arguments: {} });
    }) as unknown as ProviderAdapter]]),
    sessionStorePath: null,
    allowedRoots: [{ path: tmpdir(), label: 'tmp' }],
  });
  bridge.connect();
  await waitFor((f) => f['type'] === 'hello', 'hello');
  socket.send(JSON.stringify({
    type: 'welcome',
    session_id: 'conn-1',
    tools: [{ name: 'render', description: 'Draw the map', parameters: { type: 'object', properties: {} } }],
    config: { heartbeat_interval: 30, request_timeout: 30 },
    cli_isolation: 'workspace',
  } satisfies Partial<WelcomeMessage> as unknown as WelcomeMessage));
  await waitFor((f) => f['type'] === 'posture', 'posture');
  socket.send(JSON.stringify({
    type: 'ai_request', request_id: 'req_1', conversation_id: 'conv-1', provider: 'fake',
    message: 'go', system_prompt: null, options: {}, cli_session_id: null,
  }));
  await waitFor((f) => f['type'] === 'stream' && (f['event'] === 'done' || f['event'] === 'error'), 'end of turn', 15000);
  return got as { content: Record<string, unknown>[]; isError?: boolean };
}

describe('tool_resolve.content', () => {
  it('is announced in hello', async () => {
    await callRender();
    expect(frames.find((f) => f['type'] === 'hello')).toMatchObject({ tool_result_content: true });
  });

  it('reaches the CLI as text and image blocks, in order', async () => {
    answer = {
      result: 'Floor 1, 40x30',
      content: [
        { type: 'text', text: 'Floor 1, 40x30' },
        { type: 'image', mimeType: 'image/png', data: PNG },
        { type: 'text', text: 'tile 2' },
      ],
    };
    const got = await callRender();
    expect(got.content).toEqual([
      { type: 'text', text: 'Floor 1, 40x30' },
      { type: 'image', mimeType: 'image/png', data: PNG },
      { type: 'text', text: 'tile 2' },
    ]);
    expect(got.isError).toBeFalsy();
  });

  it('gives a plain result (an older server) the one text block it always did', async () => {
    answer = { result: { rolled: 18 } };
    const got = await callRender();
    expect(got.content).toEqual([{ type: 'text', text: '{"rolled":18}' }]);
  });

  it.each([
    ['an unsupported image type', [{ type: 'image', mimeType: 'image/svg+xml', data: PNG }]],
    ['data that is not base64', [{ type: 'image', mimeType: 'image/png', data: 'not base64!' }]],
    ['an unknown part type', [{ type: 'audio', mimeType: 'audio/wav', data: PNG }]],
    ['a text part without text', [{ type: 'text' }]],
    ['an empty list', []],
    ['not a list', { type: 'text', text: 'x' }],
    ['more than 32 parts', Array.from({ length: 33 }, () => ({ type: 'text', text: 'x' }))],
    ['only empty text', [{ type: 'text', text: ' ' }]],
  ])('falls back to result, saying why, for %s', async (_what, content) => {
    answer = { result: 'the text', content };
    const got = await callRender();
    expect(got.content).toHaveLength(1);
    expect(got.content[0]!['text']).toMatch(/^the text\n\[images not passed on by the bridge: .+\]$/);
  });

  it('falls back to a non-string result as its JSON', async () => {
    answer = { result: { floor: 1 }, content: [{ type: 'image', mimeType: 'image/bmp', data: PNG }] };
    const got = await callRender();
    expect(got.content[0]!['text']).toMatch(/^\{"floor":1\}\n\[images not passed on by the bridge: part 0: mimeType/);
  });

  it('leaves out empty text parts (the model API refuses them)', async () => {
    answer = { result: 'x', content: [{ type: 'text', text: '' }, { type: 'image', mimeType: 'image/png', data: PNG }] };
    const got = await callRender();
    expect(got.content).toEqual([{ type: 'image', mimeType: 'image/png', data: PNG }]);
  });

  it('carries images of several megabytes (the bridge takes frames up to 10 MB)', async () => {
    // Valid base64 of ~3 MB; the bridge checks the alphabet, not the picture.
    const big = Buffer.alloc(3 * 1024 * 1024, 7).toString('base64');
    answer = { result: 'big', content: [{ type: 'text', text: 'big' }, { type: 'image', mimeType: 'image/webp', data: big }] };
    const got = await callRender();
    expect(got.content).toHaveLength(2);
    expect((got.content[1] as { data: string }).data.length).toBe(big.length);
  });
});
