/**
 * `ai_request.options.thinking_display` — readable thinking.
 *
 * A value in CLAUDE_THINKING_DISPLAYS becomes `--thinking-display <value>` on a
 * fresh and a resumed turn, when the detected Claude Code is new enough; any
 * other value, or an older or unknown CLI, is dropped and the turn runs as if
 * the option were absent. Codex and Gemini ignore it.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { ClaudeAdapter } from '../../src/providers/claude.js';
import { CodexAdapter } from '../../src/providers/codex.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import {
  CLAUDE_THINKING_DISPLAYS,
  THINKING_DISPLAY_MIN_VERSION,
  claudeThinkingDisplayArgs,
} from '../../src/providers/claude-thinking-display.js';
import { getDetectedClaudeVersion, noteDetectedClaudeVersion } from '../../src/providers/subagent-prompt.js';
import type { AdapterStreamEvent, ExecutionContext } from '../../src/providers/base.js';
import type { AiRequestMessage } from '../../src/protocol/types.js';

let workingDir: string;

beforeAll(() => {
  workingDir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-thinking-display-')));
});

afterAll(() => {
  rmSync(workingDir, { recursive: true, force: true });
});

async function launch(
  AdapterClass: new () => ClaudeAdapter | CodexAdapter | GeminiAdapter,
  options: Record<string, unknown>,
  cliSessionId: string | null = null,
): Promise<string[]> {
  let recorded: string[] = [];

  class Probe extends (AdapterClass as new () => ClaudeAdapter) {
    protected override spawnCli(
      _command: string,
      args: string[],
      env: NodeJS.ProcessEnv,
      stdinInput?: string,
      cwd?: string,
    ): ChildProcessByStdio<Writable | null, Readable, Readable> {
      recorded = args;
      return spawn(process.execPath, ['-e', ''], {
        env,
        cwd,
        stdio: [stdinInput !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
    }
  }

  const request = {
    type: 'ai_request',
    request_id: 'req_thinking_display',
    conversation_id: 'conv_1',
    provider: 'x',
    message: 'think about it',
    system_prompt: null,
    options,
    cli_session_id: cliSessionId,
  } as AiRequestMessage;

  const context: ExecutionContext = {
    request,
    requestId: request.request_id,
    tools: [],
    mcp: null,
    cliIsolation: 'workspace',
    workingDir,
    signal: new AbortController().signal,
    requestTimeoutSeconds: 30,
    silenceTimeoutSeconds: 0,
    cliSessionId,
    attachmentDir: null,
    bridgeEnv: {},
    bridgeAddendum: null,
  };

  await new Probe().execute(context, (_e: AdapterStreamEvent) => undefined);
  return recorded;
}

const before = getDetectedClaudeVersion();
afterEach(() => noteDetectedClaudeVersion(before));

function displayOf(args: string[]): string | null {
  const i = args.indexOf('--thinking-display');
  return i >= 0 ? args[i + 1]! : null;
}

describe('claudeThinkingDisplayArgs()', () => {
  it('takes summarized and omitted on a CLI that has the flag', () => {
    expect([...CLAUDE_THINKING_DISPLAYS]).toEqual(['summarized', 'omitted']);
    for (const v of CLAUDE_THINKING_DISPLAYS) {
      expect(claudeThinkingDisplayArgs(v, THINKING_DISPLAY_MIN_VERSION)).toEqual(['--thinking-display', v]);
      expect(claudeThinkingDisplayArgs(v, '2.2.0')).toEqual(['--thinking-display', v]);
    }
  });

  it('ignores anything else instead of failing', () => {
    for (const v of ['SUMMARIZED', 'highlights', 'updates', ' summarized', 'summarized; rm -rf /', 1, true, {}, ['summarized']]) {
      expect(claudeThinkingDisplayArgs(v, '2.1.311')).toEqual([]);
    }
  });

  it('treats absent, null and empty as not asked', () => {
    for (const v of [undefined, null, '']) expect(claudeThinkingDisplayArgs(v, '2.1.311')).toEqual([]);
  });

  it('leaves the flag off a CLI too old for it, or of unknown version', () => {
    expect(claudeThinkingDisplayArgs('summarized', '2.1.309')).toEqual([]);
    expect(claudeThinkingDisplayArgs('summarized', null)).toEqual([]);
    expect(claudeThinkingDisplayArgs('summarized', 'garbage')).toEqual([]);
  });
});

describe('claude --thinking-display', () => {
  it('passes it on a fresh turn, beside --model and --effort', async () => {
    noteDetectedClaudeVersion('2.1.311');
    const args = await launch(ClaudeAdapter, { model: 'opus', effort: 'high', thinking_display: 'summarized' });
    expect(displayOf(args)).toBe('summarized');
    expect(args).toContain('--model');
    expect(args).toContain('--effort');
    expect(args).not.toContain('--resume');
  });

  it('passes it on a resumed turn too', async () => {
    noteDetectedClaudeVersion('2.1.311');
    const args = await launch(ClaudeAdapter, { thinking_display: 'summarized' }, '11111111-2222-3333-4444-555555555555');
    expect(args).toContain('--resume');
    expect(displayOf(args)).toBe('summarized');
  });

  it('drops it on an older CLI and still runs the turn', async () => {
    noteDetectedClaudeVersion('2.1.287');
    const args = await launch(ClaudeAdapter, { thinking_display: 'summarized' });
    expect(args.length).toBeGreaterThan(0);
    expect(args).not.toContain('--thinking-display');
  });

  it('leaves the arguments exactly as before when the option is absent', async () => {
    noteDetectedClaudeVersion('2.1.311');
    const without = await launch(ClaudeAdapter, {});
    const withNull = await launch(ClaudeAdapter, { thinking_display: null });
    expect(without).not.toContain('--thinking-display');
    const strip = (a: string[]): string[] => a.map((x) => (x.includes(tmpdir()) ? '<tmp>' : x));
    expect(strip(withNull)).toEqual(strip(without));
  });

  it('is ignored by Codex and Gemini', async () => {
    noteDetectedClaudeVersion('2.1.311');
    for (const Adapter of [CodexAdapter, GeminiAdapter]) {
      const args = await launch(Adapter as never, { thinking_display: 'summarized' });
      expect(args).not.toContain('--thinking-display');
      expect(args.join(' ')).not.toContain('summarized');
    }
  });
});
