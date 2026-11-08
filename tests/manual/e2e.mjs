#!/usr/bin/env node
/**
 * End-to-end checks against the built bridge and a real provider CLI.
 *
 * Not part of `npm test` — see README.md in this directory. Run from the repo
 * root after `npm run build`.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');

const WITH_CLI = process.argv.includes('--with-cli');
/** 240x160 PNG: a red triangle left, a blue square right, "K7" in black below. */
const SHAPES_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAPAAAACgCAIAAAC9uXYyAAAELUlEQVR4nO3dy3EiURBEUYzAiPHfHvmiWWgiRhKfoqtfk51Z90YtCWiSs+fySRTURf0ARCsDNEUFaIoK0BQVoCkqQFNUgKaoAE1RAZqiAjRFBWiKCtAUFaApKkBTVJagP65X9SPQSXMFjWm6mx/oL82AprsZg8Y03WYG+rtmQNNt3qCHmL7++Zh27a2cQN9qBnTqtbeyBz3BtJwXoNf3SDOgI6+9VQLoeNNyXoBe3HPNgM679lYhoLNNy3kBemWvaAZ02LW3ygEdbFrOC9DLel0zoJOuvVUU6FTTcl6AXtNWzYCOufZWaaAjTct5AXpBPc2Azrj2VoGg80zLeQF6b3s0Azrg2ltlgg4zLecF6F3t1wxo92tvFQs6ybScF6D7rdIMaOtrb5UMOsa0nBegm63VDGjfa28VDjrDtJwXoDsdoRnQptfeKh90gGk5L0Bv7jjNgHa89lYjQLublvMC9LaO1gxou2tvNQW0tWk5L0Bv6D2aAe117a0GgfY1LecF6Fd7p2ZAG117q1mgTU3LeQH6pd6vGdAu195qHGhH03JegK5TaQa0xbW3mgjazrScF6CLtJoBff5rbzUUtJdpOS9AP0tOGdDnv/ZWc0EbmZbzAvTD5IgBbXHtrUaDdjEt5wXo+8n5Atrl2ltNB21hWs4L0HeSwwW00bW3ArSBaTkvQP9OThbQXtfeCtAGpuW8AP0jOVZA2117K0AbmJbzAvT/5EwB7XjtrQBtYFrOC9D/kgMFtOm1twK0gWk5L0B/mmoG9EmuvRWgDUzLeQHaWDOgz3DtrQBtYFrOazpoOUdAu197K0AbmJbzGg1aDhHQAdfeCtAGpuW85oKWEwR0xrW3ArSBaTmvoaDl+AAdc+2tAG1gWs5rImg5O0AnXXsrQBuYlvMaB1oODtBh194K0Aam5bxmgZZTA3TetbcCtIFpOa9BoOXIAB157a0AbWBazmsKaDkvQKdeeytAG5iW8xoBWg4L0MHX3grQBqblvPJBy0kBOvvaWwHawLScVzhoOaYzXHtxOjRAYzqqzaDljM5zx/witCtAYzqqbaDlgM52h/0u1Ozd//VNdGiApqgATVEBmqICNEUFaIoK0BQVoCkqQFNUgKaoAE1RAZqiAjRFBWiKCtBFl2+tev1lR0u/XGAMVARorxioCNBeMVARoL1ioKKtQFXPQF8xUBGgvWKgIkB7xUBFgPaKgYoeYQLxOWOsIkB7xVhFgPaKsYoA7RVjFV0edPRnHfH+E2K4IkB7xXBFgPaK4YoA7RXDFT1CtgofiNfGiEWA9ooRiwDtFSMWAdorRix6BdwelIBeGyMWAdorRiwCtFeMWARorxixaCu4o19Pz2PEIkB7xYhFgPaKEYsA7RUjUlSApqgATVEBmqICNEUFaIoK0BQVoCkqQFNUgKaoAE1RAZqi+gvIkNhYcWcjZQAAAABJRU5ErkJggg==';
const BRIDGE = new URL('../../dist/cli.js', import.meta.url).pathname;

if (!existsSync(BRIDGE)) {
  console.error('dist/cli.js is missing — run `npm run build` first.');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

/**
 * Run one turn against a real bridge process and collect what the server saw.
 *
 * `isolation` of 'omit' leaves `cli_isolation` off the welcome entirely, which
 * is how a server predating this feature behaves.
 */
async function turn({ isolation = 'workspace', request, args = [], assets = {}, tools = [], toolResult = null, toolContent = null, silenceTimeout = null, timeoutMs = 120_000 }) {
  const frames = [];
  let requestSentAt = 0;
  let advertised = null;
  let toolCalled = false;

  const http = createServer((req, res) => {
    const body = assets[(req.url ?? '').split('?')[0]];
    if (!body) return void res.writeHead(404).end('no');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(body);
  });
  const wss = new WebSocketServer({ server: http });

  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  const port = http.address().port;
  const origin = `http://127.0.0.1:${port}`;

  const bridgeLog = [];
  const child = spawn(process.execPath, [
    BRIDGE, '--server', `ws://127.0.0.1:${port}`, '--token', 'manual-e2e',
    '--api', origin, ...args,
  ]);
  child.stdout.on('data', (c) => bridgeLog.push(c.toString()));
  child.stderr.on('data', (c) => bridgeLog.push(c.toString()));

  const done = new Promise((resolve) => {
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        msg.__at = Date.now();
        frames.push(msg);

        if (msg.type === 'hello') {
          advertised = msg.workspaces ?? [];
          ws.send(JSON.stringify({
            type: 'welcome',
            session_id: 'manual-e2e',
            tools,
            config: {
              heartbeat_interval: 30,
              request_timeout: 86400,
              silence_timeout: silenceTimeout ?? 900,
            },
            ...(isolation === 'omit' ? {} : { cli_isolation: isolation }),
          }));
          if (request) {
            // The port is only known now, so callers write __ORIGIN__.
            requestSentAt = Date.now();
            ws.send(JSON.stringify(request).replaceAll('__ORIGIN__', origin));
          } else {
            setTimeout(resolve, 400);
          }
        }
        if (msg.type === 'tool_call') {
          toolCalled = true;
          ws.send(JSON.stringify({
            type: 'tool_resolve', request_id: msg.request_id,
            tool_call_id: msg.tool_call_id,
            result: toolResult ?? 'Jasper Bauer — Director, badge 4471',
            ...(toolContent ? { content: toolContent } : {}),
          }));
        }
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        if (msg.type === 'stream' && msg.event === 'done') setTimeout(resolve, 200);
      });
    });
  });

  const timer = setTimeout(() => undefined, timeoutMs);
  await Promise.race([done, new Promise((r) => setTimeout(r, timeoutMs))]);
  clearTimeout(timer);

  child.kill();
  wss.close();
  await new Promise((r) => http.close(r));

  const stream = frames.filter((f) => f.type === 'stream');
  return {
    advertised,
    toolCalled,
    log: bridgeLog.join(''),
    errorCode: stream.find((f) => f.event === 'error')?.data?.code ?? null,
    errorMessage: stream.find((f) => f.event === 'error')?.data?.message ?? null,
    sawDone: stream.some((f) => f.event === 'done'),
    spawned: bridgeLog.join('').includes('Executing Claude request'),
    text: stream.filter((f) => f.event === 'block_delta').map((f) => f.data.content).join(''),
    // What the server was told about the tools that ran on this machine.
    toolBlocks: stream.filter((f) => f.event === 'block_start' && f.data.block_type === 'tool_call')
      .map((f) => ({ name: f.data.tool_name, id: f.data.tool_call_id })),
    toolResults: stream.filter((f) => f.event === 'tool_result').map((f) => f.data),
    doneData: stream.find((f) => f.event === 'done')?.data ?? null,
    // The longest the bridge said NOTHING. This is the quantity the silence
    // bound measures, so it is the only way to check the bound against a real
    // turn rather than against an assumption about one.
    // Counted from when the REQUEST went out, not from the first frame. Starting
    // at the first frame misses the longest silence a turn can have — the one
    // before it says anything at all — and makes a one-frame turn report zero.
    maxSilenceMs: stream.reduce(
      (max, f, i) => Math.max(max, (f.__at ?? 0) - (i === 0 ? requestSentAt : (stream[i - 1].__at ?? 0))),
      0,
    ),
    // Every stream frame, verbatim, so a run can be replayed through the OTHER
    // implementation. Every other check here reads the bridge's output with the
    // bridge's own eyes; this is the only way to see whether the server can
    // actually make sense of a real turn.
    rawStream: stream.map((f) => ({ event: f.event, data: f.data })),
    // Arrival times of the text deltas, relative to the first stream frame.
    // Counting deltas alone cannot tell streaming apart from a CLI that
    // buffered the whole answer and flushed it in pieces at the end.
    textDeltaTimes: (() => {
      const textBlocks = new Set(stream.filter((f) => f.event === 'block_start'
        && (f.data.block_type ?? 'text') === 'text').map((f) => f.data.block_index));
      const first = stream[0]?.__at ?? 0;
      return stream
        .filter((f) => f.event === 'block_delta' && textBlocks.has(f.data.block_index))
        .map((f) => f.__at - first);
    })(),
    turnMs: stream.length ? (stream.at(-1).__at - stream[0].__at) : 0,
  };
}

function aiRequest(extra = {}) {
  return {
    type: 'ai_request',
    request_id: `manual_${Math.random().toString(36).slice(2, 8)}`,
    conversation_id: 'manual-conv',
    provider: 'claude',
    message: 'hello',
    system_prompt: null,
    options: {},
    cli_session_id: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'ai-bridge-e2e-'));
const repo = join(root, 'repo');
mkdirSync(join(repo, 'src'), { recursive: true });
symlinkSync(homedir(), join(root, 'escape-hatch'), 'dir');
symlinkSync(homedir(), join(repo, 'inside-escape'), 'dir');

try {
  console.log('\nContainment — a server must not be able to name a directory the operator did not allow\n');

  let r = await turn({ request: aiRequest({ working_dir: repo }) });
  check('no --allow-dir refuses a named directory', r.errorCode === 'working_dir_not_allowed', `got ${r.errorCode}`);
  check('...and does not spawn the CLI anyway', !r.spawned);
  check('...and terminates the turn', r.sawDone);

  const allow = ['--allow-dir', repo];
  for (const [name, dir, expected] of [
    ['~/.ssh is refused', join(homedir(), '.ssh'), 'working_dir_not_allowed'],
    ['a traversal out of the root is refused', join(repo, '..', '..', 'etc'), 'working_dir_not_allowed'],
    ['a symlink inside the root pointing out is refused', join(repo, 'inside-escape'), 'working_dir_not_allowed'],
    ['a directory that does not exist is refused', join(repo, 'nope'), 'working_dir_not_found'],
  ]) {
    r = await turn({ request: aiRequest({ working_dir: dir }), args: allow });
    check(name, r.errorCode === expected, `got ${r.errorCode}: ${r.errorMessage}`);
  }
  check('...and the missing directory was not created', !existsSync(join(repo, 'nope')));

  r = await turn({
    request: aiRequest({
      attachments: [{
        id: 'a1', name: 'x.pdf', mime_type: 'application/pdf',
        size: 3, sha256: 'abc', url: 'https://evil.example.com/x.pdf',
      }],
    }),
    args: allow,
  });
  check('an attachment on another host is refused', r.errorCode === 'attachment_refused', `got ${r.errorCode}`);

  console.log('\nThe posture gate — the operator decides what a server may do\n');

  for (const [name, isolation, args, expected] of [
    ['workspace without --allow-dir falls back to isolated', 'workspace', [], 'isolated'],
    ['native without --allow-native falls back to isolated', 'native', [], 'isolated'],
    ['native with --allow-native is adopted', 'native', ['--allow-native'], 'native'],
    ['workspace with --allow-dir is adopted', 'workspace', allow, 'workspace'],
  ]) {
    r = await turn({ isolation, args, request: null });
    const adopted = /cliIsolation":"([a-z]+)"/.exec(r.log)?.[1];
    check(name, adopted === expected, `adopted ${adopted}`);
  }

  r = await turn({ request: null, args: allow });
  check('the allow-list is advertised on hello', r.advertised?.[0]?.path === repo, JSON.stringify(r.advertised));

  if (!WITH_CLI) {
    console.log('\nSkipping the provider turns. Pass --with-cli to run them.\n');
  } else {
    console.log('\nReal turns — these spend tokens\n');

    writeFileSync(join(repo, 'package.json'), '{ "name": "e2e", "type": "module", "private": true }');
    writeFileSync(join(repo, 'src', 'answer.js'), 'export const answer = 41;\n');
    writeFileSync(join(repo, 'test.js'),
      "import { answer } from './src/answer.js';\n"
      + "if (answer !== 42) { console.error('FAIL'); process.exit(1); }\nconsole.log('PASS');\n");

    r = await turn({
      request: aiRequest({
        working_dir: repo,
        message: "Run 'node test.js' here. It fails. Fix the source so it passes, then run it again.",
      }),
      args: allow,
      timeoutMs: 300_000,
    });
    let testPasses = false;
    try {
      execFileSync(process.execPath, ['test.js'], { cwd: repo });
      testPasses = true;
    } catch { /* still failing */ }
    check('a workspace turn reads, edits and runs the test', testPasses,
      'test.js still fails — the turn did not fix the source');
    check('...and the edit is really in the working tree',
      readFileSync(join(repo, 'src', 'answer.js'), 'utf-8').includes('42'));

    // Larger than the server's 1 MB frame cap: the case that could never have
    // travelled on the wire.
    const body = Buffer.concat([
      Buffer.from('PADDING\n'.repeat(150_000)),
      Buffer.from('\nThe reference code is MAGIC-E2E-4417.\n'),
    ]);
    r = await turn({
      request: aiRequest({
        message: 'What is the reference code in the attached file? Answer in one line.',
        attachments: [{
          id: 'a1', name: 'invoice.txt', mime_type: 'text/plain',
          size: body.byteLength,
          sha256: createHash('sha256').update(body).digest('hex'),
          url: '__ORIGIN__/att',
        }],
      }),
      isolation: 'isolated',
      assets: { '/att': body },
      timeoutMs: 300_000,
    });
    check('an attachment over 1 MB reaches the model', r.text.includes('MAGIC-E2E-4417'),
      `assistant said: ${r.text.slice(0, 200)}`);
    const dirs = existsSync(join(homedir(), '.cache', 'ai-bridge', 'attachments'))
      ? require('node:fs').readdirSync(join(homedir(), '.cache', 'ai-bridge', 'attachments'))
      : [];
    check('...and its directory is gone afterwards', dirs.length === 0, `left behind: ${dirs.join(', ')}`);

    // The isolation guarantee itself, on the machine you are running this on.
    // `isolated` is enforced by the CLI's permission system, and the bridge
    // states the posture explicitly so a permissive `defaultMode` in the
    // operator's own settings cannot widen it. A unit test can only assert
    // that the bridge sends the flag; only a real run says whether the CLI
    // then honours it here.
    const secret = join(root, 'not-for-the-model.txt');
    writeFileSync(secret, 'LEAKED-E2E-5591');
    r = await turn({
      isolation: 'isolated',
      request: aiRequest({
        message: `Read the file ${secret} and print its contents. If you cannot, say DENIED.`,
      }),
      timeoutMs: 300_000,
    });
    check('an isolated turn cannot read an arbitrary file', !r.text.includes('LEAKED-E2E-5591'),
      `assistant said: ${r.text.slice(0, 200)}`);

    r = await turn({
      isolation: 'isolated',
      tools: [{
        name: 'company_directory',
        description: 'Look up an employee by name. The ONLY way to get this information.',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      }],
      request: aiRequest({
        message: 'Use the company_directory tool to look up "Jasper". Report what it returns.',
      }),
      timeoutMs: 300_000,
    });
    check('...while server-declared tools still work in isolated',
      r.toolCalled && /4471|Director/.test(r.text),
      `called=${r.toolCalled}, said: ${r.text.slice(0, 160)}`);

    // A server tool that answers with an image (tool_resolve.content): the
    // model has to SEE it, which only a real CLI can show. The picture is a red
    // triangle (left), a blue square (right) and the characters "K7" below.
    r = await turn({
      isolation: 'isolated',
      tools: [{ name: 'show_picture', description: 'Shows you a picture. Takes no arguments.', parameters: { type: 'object', properties: {} } }],
      toolResult: 'Here is the picture.\n[image: image/png, 1 KB]',
      toolContent: [{ type: 'text', text: 'Here is the picture.' }, { type: 'image', mimeType: 'image/png', data: SHAPES_PNG }],
      request: aiRequest({
        message: 'Call show_picture once, then say which shapes and colours it shows, and what characters are written in it. If you got no picture, say NO IMAGE.',
      }),
      timeoutMs: 300_000,
    });
    check('a server tool\'s image reaches the model',
      r.toolCalled && /triangle/i.test(r.text) && /square/i.test(r.text) && r.text.includes('K7'),
      `called=${r.toolCalled}, said: ${r.text.slice(0, 200)}`);
    check('...and its bytes are not echoed back to the server',
      r.toolResults.every((x) => !JSON.stringify(x).includes(SHAPES_PNG.slice(0, 64))) && r.toolResults.length > 0,
      `echo: ${JSON.stringify(r.toolResults).slice(0, 200)}`);

    // Tool names and results. A tool that runs on this machine never reaches
    // the server any other way — the block and its result are the only account
    // of it there will ever be.
    r = await turn({
      isolation: 'workspace',
      args: ['--allow-dir', repo],
      request: aiRequest({
        working_dir: repo,
        message: 'Run these two shell commands with the Bash tool, in separate calls: '
          + '`echo alpha`, then `echo beta`. Then reply with just: done.',
      }),
      timeoutMs: 300_000,
    });

    if (process.env['AI_BRIDGE_E2E_DUMP']) {
      writeFileSync(process.env['AI_BRIDGE_E2E_DUMP'], JSON.stringify(r.rawStream, null, 2));
      console.log(`        (wrote ${r.rawStream.length} frames to ${process.env['AI_BRIDGE_E2E_DUMP']})`);
    }

    check('a locally-run tool reaches the server with its name',
      r.toolBlocks.length >= 2 && r.toolBlocks.every((t) => t.name === 'Bash'),
      `got ${JSON.stringify(r.toolBlocks)}`);

    check('...and what it returned',
      r.toolResults.some((x) => String(x.result).includes('alpha'))
      && r.toolResults.some((x) => String(x.result).includes('beta')),
      `got ${JSON.stringify(r.toolResults).slice(0, 200)}`);

    check('...paired to the call that produced it',
      r.toolResults.every((x) => r.toolBlocks.some((t) => t.id === x.tool_call_id)),
      `call ids ${JSON.stringify(r.toolBlocks.map((t) => t.id))}`);

    // This checks that the bridge FORWARDS what the CLI reported, so zero is
    // legitimate — a cold cache reports no cache reads, and a plan can bill
    // nothing. Negative is not, for a count or for money: accepting it would
    // let a regression that forwards -1 pass an end-to-end check.
    /** A reported count or amount: finite, and never negative. */
    const counted = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

    // A result too large for one frame. The unit tests prove the splitter; only
    // this says whether a result that big ever reaches the wire, and whether
    // every piece survives a real WebSocket — where an oversized frame is not
    // an error but a closed connection.
    //
    // Driven through a SERVER-declared tool on purpose. Claude Code truncates
    // its own tools' output before the bridge ever sees it: a 880 KB `cat`
    // arrives as 2.3 KB and a reference to where the CLI put the rest. That is
    // the CLI's decision and the bridge does not second-guess it — the model
    // saw the same truncation, so forwarding it verbatim is the honest thing.
    // It does mean a locally-run tool cannot exercise this path at all.
    const bigPayload = 'the quick brown fox jumps over the lazy dog\n'.repeat(20_000);
    r = await turn({
      isolation: 'isolated',
      tools: [{
        name: 'fetch_ledger',
        description: 'Fetch the full ledger. The ONLY way to get it.',
        parameters: { type: 'object', properties: {}, required: [] },
      }],
      toolResult: bigPayload,
      request: aiRequest({
        message: 'Call the fetch_ledger tool once. Then reply with just: done.',
      }),
      timeoutMs: 300_000,
    });

    const resultFrames = r.toolResults;
    const chunked = resultFrames.filter((x) => x.chunk_index !== undefined);
    const carried = resultFrames.map((x) => String(x.result ?? '')).join('');

    // `every` on an empty array is true, so the tool having actually run and
    // returned something is part of the assertion. Without that, a turn where
    // the CLI never called the tool passes every check below it.
    check('the large result reached the bridge at all',
      r.toolCalled && resultFrames.length > 0,
      `called=${r.toolCalled}, ${resultFrames.length} result frames`);

    // The number PROTOCOL.md states for a result, not the frame guard's 900 KB
    // backstop. Measured on the RESULT as JSON encodes it, which is the unit the
    // cap is written in. Checking the whole frame against 900 KB would pass a
    // regression emitting 500 KB results — out of contract, but under the
    // backstop, so nothing would notice.
    const MAX_RESULT_BYTES = 256 * 1024;
    const resultBytes = (x) => Buffer.byteLength(JSON.stringify(x.result ?? ''), 'utf8');

    check('every tool_result frame fits within the documented result size',
      resultFrames.length > 0
      && resultFrames.every((x) => resultBytes(x) <= MAX_RESULT_BYTES)
      && resultFrames.every((x) => Buffer.byteLength(JSON.stringify(x), 'utf8') < 900 * 1024),
      `largest result ${Math.max(0, ...resultFrames.map(resultBytes))} of ${MAX_RESULT_BYTES}`);

    // Either the CLI handed us the whole payload and we chunked it, or the CLI
    // cut it first. Both are correct. What must never happen is the BRIDGE
    // cutting a result it was given whole — asserting only the chunked case
    // would be asserting something this CLI does not currently do.
    check('a large result is chunked, or was cut by the CLI — never cut by us',
      chunked.length > 1
        ? chunked.every((x, i) => x.chunk_index === i)
          // The final flag on the LAST chunk specifically. "Exactly one is
          // final" also holds when the first one is, which would mean a
          // consumer reassembles a fragment and calls it the whole result.
          && chunked.every((x, i) => (x.final === true) === (i === chunked.length - 1))
          && carried.includes('the quick brown fox jumps over the lazy dog\n'.repeat(50))
        : carried.length > 0
          && carried.length < bigPayload.length
          && !carried.includes('truncated by the bridge'),
      `${resultFrames.length} frames, ${chunked.length} chunked, ${carried.length} of ${bigPayload.length} chars carried`);

    // Which of the two happened is worth SAYING rather than inferring, because
    // it changes with the CLI version and decides whether chunking is doing any
    // work at all on this machine today.
    console.log(chunked.length > 1
      ? `        (the CLI passed the result through whole; the bridge chunked it into ${chunked.length})`
      : `        (the CLI cut the result to ${carried.length} of ${bigPayload.length} chars before the bridge saw it)`);

    // How long the bridge actually goes quiet on a real turn, measured rather
    // than assumed — it is the quantity the silence bound is checked against.
    //
    // No assertion on whether a long tool trips the bound: that depends on what
    // the model decides to do, which varies run to run, and a test whose result
    // the model chooses is not a test. An ordinary turn's longest gap measures
    // in the low seconds, which is the property the bound relies on — but a
    // long tool DOES count as silence: a direct probe of `sleep 20` produced a
    // 17-second gap between output lines, and the bridge emits nothing it is
    // not given.
    check('a real turn never goes quiet for anything like the silence bound',
      r.maxSilenceMs < 60_000,
      `longest gap between frames: ${(r.maxSilenceMs / 1000).toFixed(1)}s`);
    console.log(`        (turn ran ${(r.turnMs / 1000).toFixed(1)}s; longest silence ${(r.maxSilenceMs / 1000).toFixed(1)}s)`);

    check('the turn reports its cache tokens, model and cost',
      counted(r.doneData?.usage?.cache_read_input_tokens)
      && counted(r.doneData?.usage?.cache_creation_input_tokens)
      && typeof r.doneData?.model === 'string'
      && counted(r.doneData?.cost_usd),
      `got ${JSON.stringify(r.doneData).slice(0, 200)}`);

    // Partial streaming. The unit tests replay captured output, so they prove
    // the mapping and nothing about whether the CLI actually chunks for us.
    r = await turn({
      isolation: 'isolated',
      request: aiRequest({
        message: 'Write roughly 400 words of prose about the history of the barometer. No lists, no headings.',
      }),
      timeoutMs: 300_000,
    });

    const times = r.textDeltaTimes;
    check('a long answer arrives in many chunks, not one lump',
      times.length > 5, `${times.length} text delta(s) for ${r.text.length} chars`);

    // The span the deltas cover, against the span of the whole turn. A CLI
    // that buffered and flushed at the end would still produce many deltas,
    // but they would all land in the last moment.
    const span = times.length > 1 ? times.at(-1) - times[0] : 0;
    check('...spread across the turn rather than flushed at the end',
      span > 1000 && span > r.turnMs * 0.25,
      `deltas spanned ${span}ms of a ${r.turnMs}ms turn`);

    check('...and the first chunk arrives well before the turn ends',
      times.length > 0 && times[0] < r.turnMs * 0.9,
      `first delta at ${times[0]}ms of ${r.turnMs}ms`);

    // The incident, reproduced: a background task outliving its turn makes the
    // CLI answer its own `<task-notification>` first on the next --resume, and
    // that notification's `result` used to end the turn before the real answer
    // had started. It cost two empty replies in a row in production, and no
    // unit test can show the CLI actually behaving this way.
    r = await turn({
      request: aiRequest({
        working_dir: repo,
        message: "Start `sleep 300` as a background shell task with run_in_background, then end your turn with the single word OK.",
      }),
      args: allow,
      timeoutMs: 300_000,
    });
    const leftoverSession = r.doneData?.cli_session_id ?? null;
    check('a turn can leave a background task running', typeof leftoverSession === 'string',
      `no session id came back: ${JSON.stringify(r.doneData).slice(0, 200)}`);

    r = await turn({
      request: aiRequest({
        working_dir: repo,
        cli_session_id: leftoverSession,
        message: 'Reply with exactly: MAGIC-QUEUED-8823',
      }),
      args: allow,
      timeoutMs: 300_000,
    });
    // FIRST: did the shape under test actually occur? Without the queued
    // notification this scenario is an ordinary turn, and every check below it
    // would pass against the bug it is named for. A failure here means the
    // reproduction did not reproduce — not that the fix regressed.
    check('the queued notification really was in this turn',
      r.log.includes('"origin":"task-notification"'),
      'no notification result appeared; the checks below prove nothing about the fix');

    check('the turn after it is answered, not swallowed by the queued notification',
      r.text.includes('MAGIC-QUEUED-8823'),
      `assistant said: ${JSON.stringify(r.text).slice(0, 200)}`);
    check('...and the turn reported is the real one, not the notification',
      (r.doneData?.num_turns ?? 0) > 0 && (r.doneData?.usage?.output_tokens ?? 0) > 0,
      `done said: ${JSON.stringify(r.doneData).slice(0, 200)}`);
    check('...and nothing arrived after the turn had ended',
      !r.log.includes('were dropped'),
      'the bridge logged frames dropped after settle');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
