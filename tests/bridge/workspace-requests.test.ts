/**
 * The bridge end of workspaces and attachments, driven over a real WebSocket.
 *
 * A fake server rather than poking at private methods: what matters is the
 * frames that actually go out — that `hello` advertises the operator's
 * allow-list, that a refused turn reports its own code and terminates, and
 * that a refusal is never dressed up as `session_lost`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { Bridge } from '../../src/bridge.js';
import { ProviderAdapter, type AdapterStreamEvent, type ExecutionContext } from '../../src/providers/base.js';
import type { AllowedRoot } from '../../src/workspace/allowlist.js';
import type { ModelInfo } from '../../src/protocol/types.js';
import { attachmentDirFor } from '../../src/attachments/store.js';

/** Records the context it was executed with, and reports a session id. */
class RecordingAdapter extends ProviderAdapter {
  readonly providerName = 'fake';
  readonly seen: ExecutionContext[] = [];
  sessionId: string | null = 'sess-1';

  execute(context: ExecutionContext, onEvent: (e: AdapterStreamEvent) => void): Promise<string | null> {
    this.seen.push(context);
    onEvent({ event: 'done', data: {} });
    return Promise.resolve(this.sessionId);
  }
  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([]);
  }
}

let wss: WebSocketServer;
let url: string;
let socket: WsSocket;
/** Every frame the bridge sent us. */
let frames: Record<string, unknown>[];
let bridge: Bridge | null = null;
let root: string;
let checkout: string;

/** Wait until a frame matching `match` arrives, or fail the test. */
async function waitFor(
  match: (f: Record<string, unknown>) => boolean,
  what: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 4000;
  for (;;) {
    const found = frames.find(match);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}; saw: ${JSON.stringify(frames)}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Stream events for one request, in order. */
function streamEvents(requestId: string): { event: string; data: Record<string, unknown> }[] {
  return frames
    .filter((f) => f['type'] === 'stream' && f['request_id'] === requestId)
    .map((f) => ({ event: f['event'] as string, data: f['data'] as Record<string, unknown> }));
}

async function startBridge(
  allowedRoots: AllowedRoot[],
  adapter: RecordingAdapter,
  extra: Partial<ConstructorParameters<typeof Bridge>[0]> = {},
): Promise<void> {
  bridge = new Bridge({
    ...extra,
    serverUrl: url,
    token: 'tok',
    providers: [{
      name: 'fake', version: '1', available: true, supports_streaming: true,
      supports_tools: true, supports_thinking: false, supports_session_resume: true,
    }],
    adapters: new Map([['fake', adapter as unknown as ProviderAdapter]]),
    // Never the operator's real store — the suite must not overwrite it.
    sessionStorePath: null,
    allowedRoots,
  });
  bridge.connect();
  await waitFor((f) => f['type'] === 'hello', 'hello');
  socket.send(JSON.stringify({
    type: 'welcome',
    session_id: 'conn-1',
    tools: [],
    config: { heartbeat_interval: 30, request_timeout: 30 },
    cli_isolation: 'workspace',
  }));
  await new Promise((r) => setTimeout(r, 50));
}

function sendRequest(overrides: Record<string, unknown>): string {
  const requestId = `req_${Math.random().toString(36).slice(2, 8)}`;
  socket.send(JSON.stringify({
    type: 'ai_request',
    request_id: requestId,
    conversation_id: 'conv-1',
    provider: 'fake',
    message: 'hello',
    system_prompt: null,
    options: {},
    cli_session_id: null,
    ...overrides,
  }));
  return requestId;
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-ws-')));
  checkout = join(root, 'repo');
  mkdirSync(checkout, { recursive: true });

  frames = [];
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`;

  const connected = new Promise<void>((resolve) => {
    wss.once('connection', (ws) => {
      socket = ws;
      ws.on('message', (raw) => {
        frames.push(JSON.parse(raw.toString()) as Record<string, unknown>);
      });
      resolve();
    });
  });
  // Resolved by whichever bridge the test starts.
  void connected;
});

afterEach(async () => {
  await bridge?.disconnect();
  bridge = null;
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

describe('a turn sent immediately after the welcome', () => {
  it('gets the tool channel instead of racing it', async () => {
    // A server with a queued turn sends `ai_request` in the same breath as it
    // answers `hello`. The MCP server assigns its listener synchronously but
    // only learns its port on the listen callback, so a readiness check on the
    // object alone is true during a window where getBaseUrl() still throws —
    // and the turn died with `provider_error: BridgeMcpServer not started`.
    // Found by the manual end-to-end harness; every unit test paused after the
    // welcome and so could not see it.
    const adapter = new RecordingAdapter();
    bridge = new Bridge({
      serverUrl: url,
      token: 'tok',
      providers: [],
      adapters: new Map([['fake', adapter as unknown as ProviderAdapter]]),
      allowedRoots: [{ path: root, label: 'root' }],
      sessionStorePath: null,
    });
    bridge.connect();
    await waitFor((f) => f['type'] === 'hello', 'hello');

    // Welcome and request back to back, with no pause between them.
    socket.send(JSON.stringify({
      type: 'welcome',
      session_id: 'conn-1',
      tools: [],
      config: { heartbeat_interval: 30, request_timeout: 30 },
      cli_isolation: 'workspace',
    }));
    const id = sendRequest({ working_dir: checkout });

    await waitFor(
      (f) => f['type'] === 'stream' && f['request_id'] === id && f['event'] === 'done',
      'done',
    );

    expect(streamEvents(id).map((e) => e.event)).toEqual(['done']);
    expect(adapter.seen).toHaveLength(1);
    // The turn got its MCP channel rather than silently running without tools.
    expect(adapter.seen[0]!.mcp).not.toBeNull();
  });
});

describe('hello', () => {
  it('advertises the operator allow-list so the server can show a picker', async () => {
    await startBridge([{ path: checkout, label: 'Acme app' }], new RecordingAdapter());
    const hello = await waitFor((f) => f['type'] === 'hello', 'hello');
    expect(hello['workspaces']).toEqual([{ path: checkout, label: 'Acme app' }]);
  });

  it('omits workspaces entirely when the operator allowed none', async () => {
    // "No workspaces" and "this bridge predates workspaces" must look the same
    // to the server: in both cases naming a directory is refused.
    await startBridge([], new RecordingAdapter());
    const hello = await waitFor((f) => f['type'] === 'hello', 'hello');
    expect(hello).not.toHaveProperty('workspaces');
  });

  it('reports the attachment limits, in bytes, so a server need not mirror them', async () => {
    await startBridge([], new RecordingAdapter(), {
      attachmentLimits: { maxFileBytes: 5 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024, maxCount: 7 },
    });
    const hello = await waitFor((f) => f['type'] === 'hello', 'hello');
    expect(hello['attachment_limits']).toEqual({
      max_file_bytes: 5 * 1024 * 1024, max_total_bytes: 20 * 1024 * 1024, max_count: 7,
    });
  });

  it('reports the defaults when the operator set none', async () => {
    await startBridge([], new RecordingAdapter());
    const hello = await waitFor((f) => f['type'] === 'hello', 'hello');
    expect(hello['attachment_limits']).toEqual({
      max_file_bytes: 25 * 1024 * 1024, max_total_bytes: 100 * 1024 * 1024, max_count: 50,
    });
  });
});

describe('a request naming a working directory', () => {
  it('runs the CLI in that directory when it is allowed', async () => {
    const adapter = new RecordingAdapter();
    await startBridge([{ path: root, label: 'root' }], adapter);

    const id = sendRequest({ working_dir: checkout });
    await waitFor((f) => f['type'] === 'stream' && f['request_id'] === id && f['event'] === 'done', 'done');

    expect(adapter.seen).toHaveLength(1);
    expect(adapter.seen[0]!.workingDir).toBe(checkout);
  });

  it('is refused, and terminated, when the operator allowed nothing', async () => {
    const adapter = new RecordingAdapter();
    await startBridge([], adapter);

    const id = sendRequest({ working_dir: checkout });
    await waitFor((f) => f['type'] === 'stream' && f['request_id'] === id && f['event'] === 'done', 'done');

    const events = streamEvents(id);
    expect(events.map((e) => e.event)).toEqual(['error', 'done']);
    expect(events[0]!.data['code']).toBe('working_dir_not_allowed');
    // Never spawned — the whole point is that there is no silent fallback to
    // the scratch directory.
    expect(adapter.seen).toEqual([]);
  });

  it('still acknowledges the request before refusing it', async () => {
    await startBridge([], new RecordingAdapter());
    const id = sendRequest({ working_dir: checkout });
    await waitFor(
      (f) => f['type'] === 'ai_request_ack' && f['request_id'] === id,
      'ack',
    );
  });

  it('uses the scratch directory when the server names nothing', async () => {
    const adapter = new RecordingAdapter();
    await startBridge([{ path: root, label: 'root' }], adapter);

    const id = sendRequest({});
    await waitFor((f) => f['type'] === 'stream' && f['request_id'] === id && f['event'] === 'done', 'done');

    expect(adapter.seen[0]!.workingDir).not.toBe(checkout);
    expect(adapter.seen[0]!.workingDir).toContain('.cache');
  });
});

describe('a working directory belongs to its CLI session', () => {
  it('refuses a resume that names a different directory', async () => {
    const other = join(root, 'other');
    mkdirSync(other, { recursive: true });

    const adapter = new RecordingAdapter();
    await startBridge([{ path: root, label: 'root' }], adapter);

    // First turn establishes the session in `checkout`.
    const first = sendRequest({ working_dir: checkout });
    await waitFor((f) => f['type'] === 'stream' && f['request_id'] === first && f['event'] === 'done', 'first done');

    // Second turn resumes that session but points somewhere else.
    const second = sendRequest({ working_dir: other, cli_session_id: 'sess-1' });
    await waitFor((f) => f['type'] === 'stream' && f['request_id'] === second && f['event'] === 'done', 'second done');

    const events = streamEvents(second);
    expect(events[0]!.data['code']).toBe('working_dir_changed');
    // And crucially NOT session_lost, which would make the server wipe the
    // session and silently re-issue the turn — retrying the refusal forever.
    expect(events[0]!.data['code']).not.toBe('session_lost');
    expect(adapter.seen).toHaveLength(1);
  });

  it('allows a resume that names the same directory', async () => {
    const adapter = new RecordingAdapter();
    await startBridge([{ path: root, label: 'root' }], adapter);

    const first = sendRequest({ working_dir: checkout });
    await waitFor((f) => f['type'] === 'stream' && f['request_id'] === first && f['event'] === 'done', 'first done');

    const second = sendRequest({ working_dir: checkout, cli_session_id: 'sess-1' });
    await waitFor((f) => f['type'] === 'stream' && f['request_id'] === second && f['event'] === 'done', 'second done');

    expect(streamEvents(second).map((e) => e.event)).toEqual(['done']);
    expect(adapter.seen).toHaveLength(2);
  });

  it('keeps the session directory when a resume names nothing', async () => {
    // The protocol says absent means "the default", and once a session exists
    // its own directory IS the default. Reading absent as "the scratch dir"
    // would refuse the turn as working_dir_changed with a message claiming the
    // request asked for a temp directory it never mentioned — and the
    // documented recovery would then run in that empty directory, which is the
    // outcome the whole module exists to prevent.
    const adapter = new RecordingAdapter();
    await startBridge([{ path: root, label: 'root' }], adapter);

    const first = sendRequest({ working_dir: checkout });
    await waitFor((f) => f['type'] === 'stream' && f['request_id'] === first && f['event'] === 'done', 'first done');

    const second = sendRequest({ cli_session_id: 'sess-1' });
    await waitFor((f) => f['type'] === 'stream' && f['request_id'] === second && f['event'] === 'done', 'second done');

    expect(streamEvents(second).map((e) => e.event)).toEqual(['done']);
    expect(adapter.seen).toHaveLength(2);
    expect(adapter.seen[1]!.workingDir).toBe(checkout);
  });

  it('allows a resume for a session it has no record of', async () => {
    // The position a restarted bridge is in. Refusing here would break every
    // conversation across a bridge restart.
    const adapter = new RecordingAdapter();
    await startBridge([{ path: root, label: 'root' }], adapter);

    const id = sendRequest({ working_dir: checkout, cli_session_id: 'sess-unknown' });
    await waitFor((f) => f['type'] === 'stream' && f['request_id'] === id && f['event'] === 'done', 'done');

    expect(streamEvents(id).map((e) => e.event)).toEqual(['done']);
  });
});

describe('refusals do not leak per-turn state', () => {
  it('revokes the per-spawn MCP token even when the turn is refused', async () => {
    // The token is issued before the working directory is resolved. A refusal
    // that threw past the revoke would leave one live credential in the MCP
    // server's map per refused turn, for the life of a background service.
    const adapter = new RecordingAdapter();
    // An allow-list, so `workspace` is accepted, the bridge registers its own
    // tool, the MCP server starts and a token really is issued per turn.
    await startBridge([{ path: root, label: 'root' }], adapter);

    const mcpServer = (bridge as unknown as {
      mcpServer: { tokens: Map<string, string>; isRunning(): boolean };
    }).mcpServer;
    expect(mcpServer.isRunning()).toBe(true);

    // Refused: inside no allowed root.
    for (let i = 0; i < 3; i++) {
      const id = sendRequest({ working_dir: '/etc' });
      await waitFor((f) => f['type'] === 'stream' && f['request_id'] === id && f['event'] === 'done', 'done');
      expect(streamEvents(id)[0]!.data['code']).toBe('working_dir_not_allowed');
    }

    expect(mcpServer.tokens.size).toBe(0);
    expect(adapter.seen).toEqual([]);
  });
});

describe('attachments', () => {
  it('leaves nothing on disk when a turn is refused part-way through fetching', async () => {
    // The spec asks for the directory to be gone after done, error AND cancel.
    // A refusal mid-fetch is the awkward one: some files are already written.
    const adapter = new RecordingAdapter();
    await startBridge([{ path: root, label: 'root' }], adapter);

    const id = sendRequest({
      attachments: [{
        id: 'att_1', name: 'x.pdf', mime_type: 'application/pdf', size: 3,
        sha256: 'abc', url: 'https://evil.example.com/x.pdf',
      }],
    });
    await waitFor((f) => f['type'] === 'stream' && f['request_id'] === id && f['event'] === 'done', 'done');

    expect(existsSync(attachmentDirFor(id))).toBe(false);
  });

  it('refuses a turn whose attachment points at another host, without spawning', async () => {
    const adapter = new RecordingAdapter();
    await startBridge([{ path: root, label: 'root' }], adapter);

    const id = sendRequest({
      attachments: [{
        id: 'att_1', name: 'x.pdf', mime_type: 'application/pdf', size: 3,
        sha256: 'abc', url: 'https://evil.example.com/x.pdf',
      }],
    });
    await waitFor((f) => f['type'] === 'stream' && f['request_id'] === id && f['event'] === 'done', 'done');

    const events = streamEvents(id);
    expect(events[0]!.event).toBe('error');
    expect(events[0]!.data['code']).toBe('attachment_refused');
    expect(adapter.seen).toEqual([]);
  });
});

describe('the attachment store', () => {
  it('is swept when the bridge starts, so what expired while it was down goes', async () => {
    const dir = join(root, 'store');
    mkdirSync(dir);
    const expired = join(dir, 'a'.repeat(64));
    const fresh = join(dir, 'b'.repeat(64));
    writeFileSync(expired, 'x');
    writeFileSync(fresh, 'y');
    const longAgo = new Date(Date.now() - 10 * 60 * 60 * 1000);
    utimesSync(expired, longAgo, longAgo);

    await startBridge([], new RecordingAdapter(), {
      attachmentCache: { dir, ttlMs: 60 * 60 * 1000, maxBytes: 1024 * 1024 },
    });
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});
