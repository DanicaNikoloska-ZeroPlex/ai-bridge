/**
 * Bridge MCP server unit tests.
 *
 * Exercises the HTTP MCP server end-to-end against an in-process MCP client
 * — the same client every spawned CLI would use — so we cover:
 *   - tools/list returns the registered tool set
 *   - tools/call dispatches to handleCall with the request id mapped from
 *     the per-spawn bearer token
 *   - unknown / missing bearer tokens are rejected with 401
 *   - revokeToken invalidates a previously-issued token
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BridgeMcpServer, type ToolCallHandler } from '../../src/mcp/server.js';

async function buildClient(url: string, bearer: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { Authorization: `Bearer ${bearer}` },
    },
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

describe('BridgeMcpServer', () => {
  let server: BridgeMcpServer;
  let handler: ToolCallHandler;

  beforeEach(async () => {
    handler = vi.fn(async () => 'ok') as unknown as ToolCallHandler;
    server = new BridgeMcpServer(handler);
    server.setTools([
      {
        name: 'roll_dice',
        description: 'Roll a die',
        parameters: {
          type: 'object',
          properties: { sides: { type: 'integer' } },
          required: ['sides'],
        },
      },
    ]);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('lists registered tools', async () => {
    const token = server.issueToken('req-1');
    const client = await buildClient(server.getBaseUrl(), token);

    try {
      const result = await client.listTools();
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]).toMatchObject({
        name: 'roll_dice',
        description: 'Roll a die',
      });
      expect(result.tools[0].inputSchema.type).toBe('object');
    } finally {
      await client.close();
    }
  });

  it('routes tools/call through handleCall with the request id from the bearer token', async () => {
    const token = server.issueToken('req-42');
    const client = await buildClient(server.getBaseUrl(), token);

    try {
      const result = await client.callTool({
        name: 'roll_dice',
        arguments: { sides: 6 },
      });
      expect(handler).toHaveBeenCalledWith('req-42', 'roll_dice', { sides: 6 });
      expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
    } finally {
      await client.close();
    }
  });

  it('returns isError: true when the handler throws', async () => {
    handler = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as ToolCallHandler;
    await server.stop();
    server = new BridgeMcpServer(handler);
    server.setTools([
      { name: 'roll_dice', description: 'd', parameters: { type: 'object', properties: {} } },
    ]);
    await server.start();

    const token = server.issueToken('req-err');
    const client = await buildClient(server.getBaseUrl(), token);

    try {
      const result = await client.callTool({ name: 'roll_dice', arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: 'boom' }]);
    } finally {
      await client.close();
    }
  });

  it('rejects requests whose bearer token is not registered', async () => {
    // No issueToken call — connect() should fail because the initialize
    // request is itself rejected with 401.
    await expect(buildClient(server.getBaseUrl(), 'nope')).rejects.toThrow();
  });

  it('revokeToken invalidates a previously-issued token', async () => {
    const token = server.issueToken('req-revoke');
    server.revokeToken(token);

    await expect(buildClient(server.getBaseUrl(), token)).rejects.toThrow();
  });

  it('different requestIds map to different tokens', async () => {
    const t1 = server.issueToken('req-a');
    const t2 = server.issueToken('req-b');

    const c1 = await buildClient(server.getBaseUrl(), t1);
    const c2 = await buildClient(server.getBaseUrl(), t2);

    try {
      await c1.callTool({ name: 'roll_dice', arguments: { sides: 4 } });
      await c2.callTool({ name: 'roll_dice', arguments: { sides: 20 } });
      expect(handler).toHaveBeenNthCalledWith(1, 'req-a', 'roll_dice', { sides: 4 });
      expect(handler).toHaveBeenNthCalledWith(2, 'req-b', 'roll_dice', { sides: 20 });
    } finally {
      await c1.close();
      await c2.close();
    }
  });
});

describe('BridgeMcpServer: a turn held to the server\'s tools', () => {
  let server: BridgeMcpServer;
  let handler: ToolCallHandler;

  beforeEach(async () => {
    handler = vi.fn(async () => 'ok') as unknown as ToolCallHandler;
    server = new BridgeMcpServer(handler);
    server.setTools([{ name: 'memory_query', description: 'Ask memory', parameters: { type: 'object', properties: {} } }]);
    server.setBridgeTools([{ name: 'bridge__attach_file', description: 'Upload a file from this disk', parameters: { type: 'object', properties: {} } }]);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('lists only the server tools to that turn, and every tool to an ordinary one', async () => {
    const held = await buildClient(server.getBaseUrl(), server.issueToken('req-held', { serverToolsOnly: true }));
    const open = await buildClient(server.getBaseUrl(), server.issueToken('req-open'));
    try {
      expect((await held.listTools()).tools.map((t) => t.name)).toEqual(['memory_query']);
      expect((await open.listTools()).tools.map((t) => t.name)).toEqual(['memory_query', 'bridge__attach_file']);
    } finally {
      await held.close();
      await open.close();
    }
  });

  it('refuses a bridge tool called by name from that turn, without reaching the handler', async () => {
    const held = await buildClient(server.getBaseUrl(), server.issueToken('req-held', { serverToolsOnly: true }));
    try {
      const refused = await held.callTool({ name: 'bridge__attach_file', arguments: { path: '/etc/passwd' } });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain('server\'s own tools only');
      expect(handler).not.toHaveBeenCalled();
      const allowed = await held.callTool({ name: 'memory_query', arguments: {} });
      expect(allowed.isError).toBeFalsy();
      expect(handler).toHaveBeenCalledWith('req-held', 'memory_query', {});
    } finally {
      await held.close();
    }
  });
});
