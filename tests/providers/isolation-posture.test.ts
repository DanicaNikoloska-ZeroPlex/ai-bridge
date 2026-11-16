/**
 * What each CLI is actually launched with, per isolation posture.
 *
 * The flags are the whole of the security story for `workspace`, so they are
 * asserted directly rather than inferred from a comment. Each adapter's
 * spawnCli is intercepted: the arguments and cwd are recorded, and a trivial
 * node process stands in for the real CLI so the turn terminates.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { ClaudeAdapter } from '../../src/providers/claude.js';
import { CodexAdapter } from '../../src/providers/codex.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import type { AdapterStreamEvent, ExecutionContext } from '../../src/providers/base.js';
import type { AiRequestMessage, CliIsolation } from '../../src/protocol/types.js';
import { BRIDGE_MCP_SERVER_NAME } from '../../src/mcp/cli-config.js';

let workingDir: string;

beforeAll(() => {
  workingDir = realpathSync(mkdtempSync(join(tmpdir(), 'posture-')));
  mkdirSync(join(workingDir, 'src'), { recursive: true });
});

afterAll(() => {
  rmSync(workingDir, { recursive: true, force: true });
});

interface Launch {
  command: string;
  args: string[];
  cwd?: string;
}

/**
 * Run one adapter to the point of spawning, and report what it would have run.
 *
 * The stand-in child exits immediately with no output, which every adapter
 * treats as an empty response — fine, because the assertion is about the
 * launch, not the parse.
 */
async function launch(
  AdapterClass: new () => ClaudeAdapter | CodexAdapter | GeminiAdapter,
  isolation: CliIsolation,
  withMcp = true,
  attachmentDir: string | null = null,
  webSearch = false,
): Promise<Launch> {
  const recorded: Launch = { command: '', args: [] };

  class Probe extends (AdapterClass as new () => ClaudeAdapter) {
    protected override spawnCli(
      command: string,
      args: string[],
      env: NodeJS.ProcessEnv,
      stdinInput?: string,
      cwd?: string,
    ): ChildProcessByStdio<Writable | null, Readable, Readable> {
      recorded.command = command;
      recorded.args = args;
      recorded.cwd = cwd;
      return spawn(process.execPath, ['-e', ''], {
        env,
        cwd,
        stdio: [stdinInput !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
    }
  }

  const request: AiRequestMessage = {
    type: 'ai_request',
    request_id: 'req_posture',
    conversation_id: 'conv_1',
    provider: 'x',
    message: 'do the thing',
    system_prompt: 'be useful',
    options: {},
    cli_session_id: null,
  };

  const context: ExecutionContext = {
    request,
    requestId: request.request_id,
    tools: [],
    mcp: withMcp ? { url: 'http://127.0.0.1:1/mcp', bearerToken: 'tok' } : null,
    cliIsolation: isolation,
    workingDir,
    signal: new AbortController().signal,
    requestTimeoutSeconds: 30,
    silenceTimeoutSeconds: 0,
    cliSessionId: null,
    attachmentDir,
    bridgeEnv: {},
    bridgeAddendum: null,
    ...(webSearch ? { webSearch: true } : {}),
  };

  await new Probe().execute(context, (_e: AdapterStreamEvent) => undefined);
  return recorded;
}

/** True when `args` contains `-c <value>` (codex's config-override form). */
function hasConfig(args: string[], value: string): boolean {
  return args.some((a, i) => a === '-c' && args[i + 1] === value);
}

describe('every provider spawns in the resolved working directory', () => {
  it('claude does', async () => {
    expect((await launch(ClaudeAdapter, 'isolated')).cwd).toBe(workingDir);
  });
  it('codex does', async () => {
    expect((await launch(CodexAdapter, 'isolated')).cwd).toBe(workingDir);
  });
  it('gemini does', async () => {
    expect((await launch(GeminiAdapter, 'isolated')).cwd).toBe(workingDir);
  });
});

describe('claude', () => {
  it('in isolated, restricts tools to the bridge MCP namespace and never bypasses permissions', async () => {
    const { args } = await launch(ClaudeAdapter, 'isolated');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain(`mcp__${BRIDGE_MCP_SERVER_NAME}__*`);
    expect(args).not.toContain('bypassPermissions');
  });

  it('in isolated, states the permission mode instead of trusting the operator settings', async () => {
    // --allowedTools only asks; the denial comes from Claude's permission
    // system, which reads the operator's ~/.claude/settings.json. A developer
    // who set `permissions.defaultMode: "auto"` for their own work turns
    // `isolated` into "everything allowed" for every turn a server sends them.
    // Verified against 2.1.260 both ways.
    const { args } = await launch(ClaudeAdapter, 'isolated');
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('manual');
  });

  it('in isolated, takes the web tools out of the tool list unless the turn may search', async () => {
    const flag = (args: string[]) => args[args.indexOf('--disallowedTools') + 1];
    expect(flag((await launch(ClaudeAdapter, 'isolated')).args)).toBe('WebSearch,WebFetch');
    expect(flag((await launch(ClaudeAdapter, 'isolated', true, null, true)).args)).toBe('WebFetch');
    expect((await launch(ClaudeAdapter, 'workspace')).args).not.toContain('--disallowedTools');
    expect((await launch(ClaudeAdapter, 'native')).args).not.toContain('--disallowedTools');
  });

  it('in workspace, keeps strict-mcp-config but allows the built-in tools', async () => {
    const { args } = await launch(ClaudeAdapter, 'workspace');
    // The operator's own MCP servers stay out — that half of isolation holds.
    expect(args).toContain('--strict-mcp-config');
    // ...but the built-in Read/Edit/Write/Bash tools are the point.
    expect(args).not.toContain('--allowedTools');
    // acceptEdits stalls on shell in headless -p mode, so this is what runs a
    // real task. Asserted so nobody "hardens" it into something that hangs.
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
  });

  it('lets an isolated turn read the files the user attached', async () => {
    // The preamble names absolute paths and tells the model to read them. With
    // only `mcp__bridge__*` allowed, Read is denied in headless mode and the
    // turn ends with the model saying it cannot see a file the user just
    // attached — and nothing in the logs points at this flag.
    const attachDir = '/home/dev/.cache/ai-bridge/attachments/req-1';
    const { args } = await launch(ClaudeAdapter, 'isolated', true, attachDir);
    const allowed = args[args.indexOf('--allowedTools') + 1] ?? '';

    expect(allowed).toContain(`mcp__${BRIDGE_MCP_SERVER_NAME}__*`);
    // Scoped to the attachment directory and nothing else. A bare `Read` here
    // is a whole-filesystem read grant — verified against the real CLI — which
    // a server could switch on by sending a field.
    expect(allowed).toContain(`Read(/${attachDir}/**)`);
    expect(allowed.split(',')).not.toContain('Read');
    expect(allowed.split(',')).not.toContain('Glob');
    expect(allowed.split(',')).not.toContain('Grep');
    expect(allowed.split(',')).not.toContain('Write');
    expect(allowed.split(',')).not.toContain('Bash');
  });

  it('does not widen the tool surface on a turn with no attachments', async () => {
    const { args } = await launch(ClaudeAdapter, 'isolated', true, null);
    const allowed = args[args.indexOf('--allowedTools') + 1] ?? '';

    expect(allowed).toBe(`mcp__${BRIDGE_MCP_SERVER_NAME}__*`);
  });

  it('adds exactly WebSearch to an isolated turn allowed to search, beside the attachment grant', async () => {
    // Decision 0016. WebSearch runs at Anthropic and reaches nothing here;
    // WebFetch (any URL), Bash and a bare Read stay denied.
    const attachDir = '/home/dev/.cache/ai-bridge/attachments/req-2';
    const { args } = await launch(ClaudeAdapter, 'isolated', true, attachDir, true);
    const allowed = (args[args.indexOf('--allowedTools') + 1] ?? '').split(',');
    expect(allowed).toEqual([`mcp__${BRIDGE_MCP_SERVER_NAME}__*`, `Read(/${attachDir}/**)`, 'WebSearch']);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('manual');
  });

  it('adds no list to a workspace turn allowed to search (every built-in is already allowed)', async () => {
    const { args } = await launch(ClaudeAdapter, 'workspace', true, null, true);
    expect(args).not.toContain('--allowedTools');
  });

  it('in native, bypasses permissions and does not restrict MCP config', async () => {
    const { args } = await launch(ClaudeAdapter, 'native');
    expect(args).not.toContain('--strict-mcp-config');
    expect(args).toContain('bypassPermissions');
  });

  it('in workspace with no MCP channel, keeps BOTH halves of the posture', async () => {
    // `mcp` is null when the bridge's own MCP server failed to start, and the
    // turn still runs. Asserting only the permissive half would let
    // `--strict-mcp-config` be skipped exactly there — loading the operator's
    // own MCP servers at the same moment the CLI is bypassing permissions.
    const { args } = await launch(ClaudeAdapter, 'workspace', false);
    expect(args).toContain('bypassPermissions');
    expect(args).toContain('--strict-mcp-config');
  });

  it('in isolated with no MCP channel, still refuses the operator own MCP servers', async () => {
    const { args } = await launch(ClaudeAdapter, 'isolated', false);
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('bypassPermissions');
  });
});

describe('web search reaches only Claude', () => {
  it('codex launches the same with or without it', async () => {
    expect((await launch(CodexAdapter, 'isolated', true, null, true)).args)
      .toEqual((await launch(CodexAdapter, 'isolated')).args);
  });
  it('gemini launches the same with or without it', async () => {
    expect((await launch(GeminiAdapter, 'isolated', true, null, true)).args)
      .toEqual((await launch(GeminiAdapter, 'isolated')).args);
  });
});

describe('codex', () => {
  it('in isolated, states the read-only sandbox rather than assuming it', async () => {
    // The default is read from the operator's ~/.codex/config.toml, so an
    // operator who set danger-full-access there for their own work would hand
    // every isolated turn full access. The posture has to be asserted.
    const { args } = await launch(CodexAdapter, 'isolated');
    expect(hasConfig(args, 'sandbox_mode=read-only')).toBe(true);
    expect(hasConfig(args, 'sandbox_mode=workspace-write')).toBe(false);
    expect(hasConfig(args, 'sandbox_mode=danger-full-access')).toBe(false);
  });

  it('in workspace, uses workspace-write — NOT danger-full-access', async () => {
    const { args } = await launch(CodexAdapter, 'workspace');
    expect(hasConfig(args, 'sandbox_mode=workspace-write')).toBe(true);
    expect(hasConfig(args, 'sandbox_mode=danger-full-access')).toBe(false);
    // Headless exec cannot show an approval prompt, so anything that asks for
    // one hangs until the request timeout rather than reporting a problem.
    expect(hasConfig(args, 'approval_policy=never')).toBe(true);
  });

  it('in native, keeps the legacy danger-full-access posture', async () => {
    const { args } = await launch(CodexAdapter, 'native');
    expect(hasConfig(args, 'sandbox_mode=danger-full-access')).toBe(true);
  });

  it('puts the prompt last, after every flag', async () => {
    const { args } = await launch(CodexAdapter, 'workspace');
    expect(args[args.length - 1]).toContain('do the thing');
  });
});

describe('gemini', () => {
  it('in isolated, withholds --yolo so built-ins stall rather than run', async () => {
    const { args } = await launch(GeminiAdapter, 'isolated');
    expect(args).not.toContain('--yolo');
  });

  it('with no MCP channel, still restricts the visible MCP server set', async () => {
    // `mcp` is null when the bridge's own MCP server failed to start, and the
    // turn still runs. Inside the `if (context.mcp)` block this flag was
    // dropped exactly there — so a workspace turn launched with `--yolo` and
    // no server restriction, loading the operator's ~/.gemini servers and the
    // checkout's own, auto-approving every tool they expose.
    for (const posture of ['isolated', 'workspace'] as const) {
      const { args } = await launch(GeminiAdapter, posture, false);
      expect(args).toContain('--allowed-mcp-server-names');
      expect(args).toContain(BRIDGE_MCP_SERVER_NAME);
    }
  });

  it('in workspace, passes --yolo because it is the only lever gemini offers', async () => {
    const { args } = await launch(GeminiAdapter, 'workspace');
    expect(args).toContain('--yolo');
  });

  it('in native, passes --yolo as before', async () => {
    expect((await launch(GeminiAdapter, 'native')).args).toContain('--yolo');
  });
});
