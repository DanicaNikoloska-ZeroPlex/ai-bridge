/**
 * Reliable delivery over a real socket (PROTOCOL.md, "Short drops"): numbered
 * frames, the outbox trimmed by `stream_ack`, turns kept running through a
 * drop, `hello.running_turns` and the in-order re-send after the reconnect,
 * the grace period running out, and an old server getting the old behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { Bridge } from '../../src/bridge.js';
import { ProviderAdapter, type AdapterStreamEvent, type ExecutionContext } from '../../src/providers/base.js';
import type { ModelInfo } from '../../src/protocol/types.js';
import { StreamOutbox } from '../../src/protocol/outbox.js';

/** Emits what the test tells it to, and runs until finished or aborted. */
class StepAdapter extends ProviderAdapter {
  readonly providerName = 'fake';
  aborted = false;
  /** False: an abort only marks it, and the test ends it with finish(), like a CLI winding down. */
  finishOnAbort = true;
  emit: (e: AdapterStreamEvent) => void = () => {};
  finish: () => void = () => {};

  execute(context: ExecutionContext, onEvent: (e: AdapterStreamEvent) => void): Promise<string | null> {
    this.emit = onEvent;

    return new Promise((resolve) => {
      let done = false;
      this.finish = (): void => {
        if (done) return;
        done = true;
        onEvent({ event: 'done', data: {} });
        resolve('sess-1');
      };
      context.signal.addEventListener('abort', () => { this.aborted = true; if (this.finishOnAbort) this.finish(); }, { once: true });
    });
  }
  delta(text: string): void {
    this.emit({ event: 'block_delta', data: { block_index: 0, delta: text } as never });
  }
  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([]);
  }
}

type Frame = Record<string, unknown>;

let wss: WebSocketServer;
let url: string;
let socket: WsSocket;
/** Every frame received, tagged with the connection (1, 2, ...) it came on. */
let frames: { conn: number; frame: Frame }[];
let connections: number;
let bridge: Bridge | null = null;
let adapter: StepAdapter;

function listen(ws: WsSocket): void {
  const conn = ++connections;
  socket = ws;
  ws.on('message', (raw) => frames.push({ conn, frame: JSON.parse(raw.toString()) as Frame }));
}

async function waitFor(match: (f: Frame, conn: number) => boolean, what: string, ms = 4000): Promise<Frame> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = frames.find((f) => match(f.frame, f.conn));
    if (found) return found.frame;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; saw: ${JSON.stringify(frames)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function welcome(grace: number | undefined): void {
  socket.send(JSON.stringify({
    type: 'welcome',
    session_id: `conn-${connections}`,
    tools: [],
    config: {
      heartbeat_interval: 30, request_timeout: 0, silence_timeout: 0,
      ...(grace !== undefined ? { reconnect_grace_seconds: grace } : {}),
    },
    cli_isolation: 'isolated',
  }));
}

async function start(grace: number | undefined, reattachAckTimeoutMs?: number): Promise<void> {
  adapter = new StepAdapter();
  bridge = new Bridge({
    serverUrl: url,
    token: 'tok',
    providers: [{
      name: 'fake', version: '1', available: true, supports_streaming: true,
      supports_tools: true, supports_thinking: false, supports_session_resume: true,
    }],
    adapters: new Map([['fake', adapter as unknown as ProviderAdapter]]),
    sessionStorePath: null,
    allowedRoots: [],
    ...(reattachAckTimeoutMs !== undefined ? { reattachAckTimeoutMs } : {}),
  });
  bridge.connect();
  await waitFor((f) => f['type'] === 'hello', 'hello');
  welcome(grace);
  await sleep(50);
}

function request(id: string): void {
  socket.send(JSON.stringify({
    type: 'ai_request', request_id: id, conversation_id: 'conv-1', provider: 'fake',
    message: 'hi', system_prompt: null, options: {}, cli_session_id: null,
  }));
}

const ack = (id: string, seq: number): void => socket.send(JSON.stringify({ type: 'stream_ack', request_id: id, seq }));

/** Stream frames of a request, optionally only those on one connection. */
const streamOf = (id: string, conn?: number): Frame[] => frames
  .filter((f) => f.frame['type'] === 'stream' && f.frame['request_id'] === id && (conn === undefined || f.conn === conn))
  .map((f) => f.frame);

/** Drop the connection from the server's side, and wait until the bridge noticed. */
async function drop(): Promise<void> {
  const noticed = new Promise<void>((resolve) => bridge!.once('disconnected', () => resolve()));
  socket.close();
  await noticed;
}

/** Take the bridge's reconnect (about a second later) and return its hello. */
async function nextConnection(): Promise<Frame> {
  const ws = await new Promise<WsSocket>((resolve) => wss.once('connection', resolve));
  listen(ws);
  const conn = connections;

  return waitFor((f, c) => f['type'] === 'hello' && c === conn, 'the hello on the new connection');
}

beforeEach(async () => {
  frames = [];
  connections = 0;
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`;
  wss.once('connection', listen);
});

afterEach(async () => {
  await bridge?.disconnect();
  bridge = null;
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

describe('against a server with reliable delivery', () => {
  it('announces reliable_delivery in hello', async () => {
    await start(120);

    expect(frames[0]!.frame['reliable_delivery']).toBe(true);
    expect('running_turns' in frames[0]!.frame).toBe(false);
  });

  it('numbers every stream frame of a turn from 1, the done frame included', async () => {
    await start(120);
    request('req_1');
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await sleep(20);
    adapter.delta('a');
    adapter.delta('b');
    adapter.finish();
    await waitFor((f) => f['event'] === 'done', 'done');

    expect(streamOf('req_1').map((f) => [f['event'], f['seq']])).toEqual([
      ['block_delta', 1], ['block_delta', 2], ['done', 3],
    ]);
    // Non-turn frames carry no number.
    expect('seq' in (await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack'))).toBe(false);
  });

  it('keeps frames until stream_ack covers them, and lets go once the done is confirmed', async () => {
    await start(120);
    request('req_1');
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await sleep(20);
    adapter.delta('a');
    adapter.delta('b');
    await waitFor((f) => f['seq'] === 2, 'frame 2');
    const outbox = (bridge as unknown as { outbox: import('../../src/protocol/outbox.js').StreamOutbox }).outbox;

    expect(outbox.pending('req_1').map((f) => f.seq)).toEqual([1, 2]);
    ack('req_1', 1);
    await sleep(30);
    expect(outbox.pending('req_1').map((f) => f.seq)).toEqual([2]);

    adapter.finish();
    await waitFor((f) => f['event'] === 'done', 'done');
    expect(bridge!.isIdle()).toBe(false); // the done is not confirmed yet
    ack('req_1', 3);
    await sleep(30);
    expect(outbox.has('req_1')).toBe(false);
    expect(bridge!.isIdle()).toBe(true);
  });

  it('keeps the turn running through a drop, queues its frames, and re-sends them in order after the reconnect', async () => {
    await start(120);
    request('req_1');
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await sleep(20);
    adapter.delta('a'); // 1, confirmed
    adapter.delta('b'); // 2, written but never confirmed
    await waitFor((f) => f['seq'] === 2, 'frame 2');
    ack('req_1', 1);
    await sleep(30);

    await drop();
    // Offline: the turn goes on, and what it says waits.
    adapter.delta('c'); // 3
    adapter.finish(); // done, 4
    expect(adapter.aborted).toBe(false);

    const hello = await nextConnection();
    expect(hello['running_turns']).toEqual([{ request_id: 'req_1', last_acked_seq: 1 }]);
    // Nothing goes out before the welcome.
    await sleep(50);
    expect(streamOf('req_1', 2)).toEqual([]);

    welcome(120);
    await waitFor((f, c) => c === 2 && f['event'] === 'done', 'the re-sent done');
    expect(streamOf('req_1', 2).map((f) => [f['event'], f['seq']])).toEqual([
      ['block_delta', 2], ['block_delta', 3], ['done', 4],
    ]);
    expect((streamOf('req_1', 2)[1]!['data'] as { delta: string }).delta).toBe('c');
    // No bridge_disconnected: the turn was not lost.
    expect(frames.some((f) => f.frame['code'] === 'bridge_disconnected')).toBe(false);

    ack('req_1', 4);
    await sleep(30);
    expect(bridge!.isIdle()).toBe(true);
  }, 10_000);

  it('re-sends a final frame the server never confirmed, for a turn that ended during the drop', async () => {
    await start(120);
    request('req_1');
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await sleep(20);
    adapter.finish();
    await waitFor((f) => f['event'] === 'done', 'done');

    await drop();
    const hello = await nextConnection();
    expect(hello['running_turns']).toEqual([{ request_id: 'req_1', last_acked_seq: 0 }]);
    welcome(120);
    expect(await waitFor((f, c) => c === 2 && f['event'] === 'done', 'the re-sent done')).toMatchObject({ seq: 1 });
  }, 10_000);

  it('makes work that needs the server wait for the reconnect, and fails a tool call whose result was lost', async () => {
    await start(120);
    request('req_1');
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    const internals = bridge as unknown as {
      serverReachable(): Promise<void>;
      toolResolver: import('../../src/tools/resolver.js').ToolResolver;
    };
    // A tool call in flight when the connection drops.
    const inFlight = internals.toolResolver.call(() => {}, 'req_1', 'tc-1', 'lookup', {});

    await drop();
    await expect(inFlight).rejects.toThrow(/Result unknown.*may or may not have run.*not called again/);

    let reached = false;
    void internals.serverReachable().then(() => { reached = true; });
    await nextConnection();
    await sleep(50);
    expect(reached).toBe(false);
    welcome(120);
    await sleep(50);
    expect(reached).toBe(true);
    expect(adapter.aborted).toBe(false);
  }, 10_000);

  it('stops the turn and reports bridge_disconnected when the grace period runs out', async () => {
    await start(2);
    request('req_1');
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await sleep(20);

    await drop();
    const internals = bridge as unknown as { serverReachable(): Promise<void> };
    const waiting = internals.serverReachable();
    // The reconnect comes, but the server does not answer within the grace.
    const hello = await nextConnection();
    expect(hello['running_turns']).toEqual([{ request_id: 'req_1', last_acked_seq: 0 }]);
    await expect(waiting).rejects.toThrow(/Not done: .*nothing was sent/);
    expect(adapter.aborted).toBe(true);

    welcome(2);
    const replay = await waitFor((f) => f['type'] === 'error' && f['code'] === 'bridge_disconnected', 'the replay');
    expect(replay).toMatchObject({ request_id: 'req_1', fatal: false });
    // The aborted turn's own done is not numbered or kept any more.
    expect(streamOf('req_1', 2).every((f) => !('seq' in f))).toBe(true);
    expect(bridge!.isIdle()).toBe(true);
  }, 10_000);

  it('stops a turn the server does not take back after the reconnect', async () => {
    await start(120, 200);
    request('req_1');
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await sleep(20);
    await drop();
    adapter.delta('a');
    await nextConnection();
    welcome(120);
    await waitFor((f, c) => c === 2 && f['seq'] === 1, 'the re-sent frame');

    // No stream_ack ever comes for it: the server no longer holds the turn.
    const replay = await waitFor((f) => f['type'] === 'error' && f['code'] === 'bridge_disconnected', 'the report');
    expect(replay).toMatchObject({ request_id: 'req_1' });
    expect(adapter.aborted).toBe(true);
  }, 10_000);

  it('keeps a re-attached turn once the server confirms a frame on the new connection', async () => {
    await start(120, 200);
    request('req_1');
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await sleep(20);
    await drop();
    adapter.delta('a');
    await nextConnection();
    welcome(120);
    await waitFor((f, c) => c === 2 && f['seq'] === 1, 'the re-sent frame');
    ack('req_1', 1);
    await sleep(400);

    expect(adapter.aborted).toBe(false);
    expect(frames.some((f) => f.frame['code'] === 'bridge_disconnected')).toBe(false);
  }, 10_000);

  it('stops the kept turns when the server that answers after the drop does not do reliable delivery', async () => {
    await start(120);
    request('req_1');
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await sleep(20);
    await drop();
    expect(adapter.aborted).toBe(false);
    await nextConnection();
    welcome(undefined);

    expect(await waitFor((f) => f['code'] === 'bridge_disconnected', 'the replay')).toMatchObject({ request_id: 'req_1' });
    expect(adapter.aborted).toBe(true);
  }, 10_000);

  it('numbers a session_lost re-issue from 1 again', async () => {
    await start(120);
    request('req_1');
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await sleep(20);
    adapter.emit({ event: 'error', data: { code: 'session_lost', message: 'gone' } });
    await waitFor((f) => f['event'] === 'error', 'the error');
    adapter.finish();
    await sleep(20);
    const before = streamOf('req_1').length;

    // The server re-issues, then confirms the old error frame.
    request('req_1');
    ack('req_1', 2);
    await sleep(30);
    adapter.delta('again');
    await waitFor(() => streamOf('req_1').length > before, 'the re-issued turn\'s first frame');

    expect(streamOf('req_1').slice(before)[0]).toMatchObject({ event: 'block_delta', seq: 1 });
  });
});

describe('turn messages, final frames, closed turns and bounds', () => {
  const closedAck = (id: string, seq: number): void => socket.send(JSON.stringify({ type: 'stream_ack', request_id: id, seq, closed: true }));
  const indexOf = (match: (f: Frame) => boolean, conn: number): number => frames.findIndex((f) => f.conn === conn && match(f.frame));

  it('keeps a cancelled that is due during a drop, and sends it after the turn\'s re-sent frames', async () => {
    await start(120);
    request('req_1');
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await sleep(20);
    adapter.finishOnAbort = false;
    socket.send(JSON.stringify({ type: 'cancel', request_id: 'req_1' }));
    await sleep(30);
    expect(adapter.aborted).toBe(true);

    await drop();
    adapter.finish(); // done (kept), then cancelled (held)
    await sleep(20);
    await nextConnection();
    welcome(120);

    await waitFor((f, c) => c === 2 && f['type'] === 'cancelled', 'the kept cancelled');
    expect(indexOf((f) => f['event'] === 'done', 2)).toBeLessThan(indexOf((f) => f['type'] === 'cancelled', 2));
    expect(frames.filter((f) => f.frame['type'] === 'cancelled')).toHaveLength(1);
  }, 10_000);

  it('does not give up on a finished answer the server is slow to confirm: it sends it again', async () => {
    await start(120, 200);
    request('req_1');
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await sleep(20);
    await drop();
    adapter.delta('a');
    adapter.finish();
    await nextConnection();
    welcome(120);
    await waitFor((f, c) => c === 2 && f['event'] === 'done', 'the re-sent done');

    // No ack for well past the re-attach timeout: written again, not aborted.
    await sleep(500);
    expect(streamOf('req_1', 2).filter((f) => f['event'] === 'done').length).toBeGreaterThanOrEqual(2);
    expect(frames.some((f) => f.frame['code'] === 'bridge_disconnected')).toBe(false);

    ack('req_1', 2);
    await sleep(30);
    expect(bridge!.isIdle()).toBe(true);
  }, 10_000);

  it('lets go of a finished answer the server never confirms after a bounded number of re-sends', async () => {
    await start(120, 20);
    request('req_1');
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await sleep(20);
    await drop();
    adapter.finish();
    await nextConnection();
    welcome(120);
    await waitFor((f, c) => c === 2 && f['event'] === 'done', 'the re-sent done');
    expect(bridge!.isIdle()).toBe(false);

    // 20, 40, 80, 160, 320 ms: four re-sends, then released.
    await sleep(1200);
    const sent = streamOf('req_1', 2).filter((f) => f['event'] === 'done').length;
    expect(sent).toBe(5); // the re-attach write plus four re-sends
    expect(bridge!.isIdle()).toBe(true);
    expect(frames.some((f) => f.frame['code'] === 'bridge_disconnected')).toBe(false);
    await sleep(200);
    expect(streamOf('req_1', 2).filter((f) => f['event'] === 'done').length).toBe(sent);
  }, 10_000);

  it('stops a running turn when the server says it is closed: no more stream frames, one cancelled', async () => {
    await start(120);
    request('req_1');
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await sleep(20);
    adapter.delta('a');
    await waitFor((f) => f['seq'] === 1, 'frame 1');
    const before = frames.length;

    closedAck('req_1', 1);
    await sleep(50);
    expect(adapter.aborted).toBe(true);
    // No more stream frames (no done), and exactly one unnumbered cancelled.
    const after = frames.slice(before).filter((f) => f.frame['request_id'] === 'req_1').map((f) => f.frame);
    expect(after).toEqual([{ type: 'cancelled', request_id: 'req_1' }]);
    expect(bridge!.isIdle()).toBe(true);
  });

  it('drops the cancelled of a closed turn that stops while the connection is down', async () => {
    await start(120);
    request('req_1');
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await sleep(20);
    adapter.finishOnAbort = false;
    closedAck('req_1', 0);
    await sleep(30);
    expect(adapter.aborted).toBe(true);
    await drop();
    adapter.finish();
    await nextConnection();
    welcome(120);
    await sleep(100);

    expect(frames.filter((f) => f.conn === 2 && f.frame['request_id'] === 'req_1')).toEqual([]);
    expect(bridge!.isIdle()).toBe(true);
  }, 10_000);

  it('releases a turn whose re-sent frames are answered closed after a reconnect', async () => {
    await start(120, 200);
    request('req_1');
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await sleep(20);
    adapter.finish();
    await waitFor((f) => f['event'] === 'done', 'done');
    expect(bridge!.isIdle()).toBe(false);

    await drop();
    await nextConnection();
    welcome(120);
    await waitFor((f, c) => c === 2 && f['event'] === 'done', 'the re-sent done');
    closedAck('req_1', 0);
    await sleep(400);

    expect(bridge!.isIdle()).toBe(true);
    expect(streamOf('req_1', 2)).toHaveLength(1); // not sent again after the close
    expect(frames.some((f) => f.frame['code'] === 'bridge_disconnected')).toBe(false);
  }, 10_000);

  it('stops a turn whose kept output outgrows the bound during a drop, and says so after the reconnect', async () => {
    await start(120);
    (bridge as unknown as { outbox: StreamOutbox }).outbox = new StreamOutbox({
      turnBytes: 1_000_000, turnFrames: 3, totalBytes: 1_000_000, totalFrames: 100,
    });
    request('req_1');
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await sleep(20);
    await drop();
    for (const t of ['a', 'b', 'c', 'd']) adapter.delta(t);
    expect(adapter.aborted).toBe(true);

    await nextConnection();
    welcome(120);
    const report = await waitFor((f) => f['code'] === 'bridge_disconnected', 'the report');
    expect(report['request_id']).toBe('req_1');
    expect(report['message']).toMatch(/connection to the server dropped.*grew larger than this machine keeps.*Send the message again/);
    expect(bridge!.isIdle()).toBe(true);
  }, 10_000);

  it('on a connection that is up, blames a slow server, not a drop, for outgrowing the bound', async () => {
    await start(120);
    (bridge as unknown as { outbox: StreamOutbox }).outbox = new StreamOutbox({
      turnBytes: 1_000_000, turnFrames: 3, totalBytes: 1_000_000, totalFrames: 100,
    });
    request('req_1');
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await sleep(20);
    for (const t of ['a', 'b', 'c', 'd']) adapter.delta(t);
    expect(adapter.aborted).toBe(true);

    const report = await waitFor((f) => f['code'] === 'bridge_disconnected', 'the report');
    expect(report['message']).toMatch(/server was too slow to confirm/);
    expect(report['message']).not.toMatch(/dropped/);
  }, 10_000);

  it('delivers the final frame of a turn whose earlier output filled the bound', async () => {
    await start(120);
    (bridge as unknown as { outbox: StreamOutbox }).outbox = new StreamOutbox({
      turnBytes: 1_000_000, turnFrames: 3, totalBytes: 1_000_000, totalFrames: 100,
    });
    request('req_1');
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await sleep(20);
    for (const t of ['a', 'b', 'c']) adapter.delta(t);
    adapter.finish();
    await waitFor((f) => f['event'] === 'done', 'done');
    expect(streamOf('req_1').find((f) => f['event'] === 'done')!['seq']).toBe(4);
    expect(frames.some((f) => f.frame['code'] === 'bridge_disconnected')).toBe(false);
  }, 10_000);
});

describe('against a server without reliable delivery', () => {
  it('sends no seq and stops the running turn on a drop, as before', async () => {
    await start(undefined);
    request('req_1');
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the ack');
    await sleep(20);
    adapter.delta('a');
    await waitFor((f) => f['event'] === 'block_delta', 'the frame');
    expect('seq' in streamOf('req_1')[0]!).toBe(false);

    await drop();
    expect(adapter.aborted).toBe(true);
    const hello = await nextConnection();
    expect('running_turns' in hello).toBe(false);
    welcome(undefined);
    expect(await waitFor((f) => f['code'] === 'bridge_disconnected', 'the replay')).toMatchObject({ request_id: 'req_1' });
  }, 10_000);
});
