/**
 * A small MCP server for the upstream tests, over stdio (run this file with
 * `--stdio`) or Streamable HTTP (import makeServer). Raw handlers rather than
 * McpServer, so every `_meta` goes out exactly as written here.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const obj = { type: 'object', properties: {} };

export const VIEW_URI = 'ui://fx/view.html';
export const LISTED_URI = 'ui://fx/listed.html';
export const VIEW_UI = {
  csp: { connectDomains: ['https://api.example.com'], resourceDomains: ['https://cdn.example.com'] },
  permissions: { camera: {}, clipboardWrite: {} },
  domain: 'fx.example.com',
  prefersBorder: false,
};
export const LISTED_UI = { csp: { frameDomains: ['https://player.example.com'] }, prefersBorder: true };

export function makeServer({ onExit } = {}) {
  const extra = [];
  let listDelayMs = 0;
  const tools = () => [
    { name: 'show', description: 'Show x', inputSchema: obj, _meta: { ui: { resourceUri: VIEW_URI } } },
    { name: 'app_only', description: 'For the view', inputSchema: obj, _meta: { ui: { resourceUri: VIEW_URI, visibility: ['app'] } } },
    { name: 'model_only', description: 'For the model', inputSchema: obj, _meta: { ui: { visibility: ['model'] } } },
    { name: 'plain', description: 'No view', inputSchema: obj },
    { name: 'slow', description: 'Waits args.ms', inputSchema: obj },
    { name: 'die', description: 'Exits', inputSchema: obj },
    { name: 'fail', description: 'isError', inputSchema: obj },
    { name: 'throws', description: 'JSON-RPC error', inputSchema: obj },
    { name: 'echo_env', description: 'An env var', inputSchema: obj },
    { name: 'structured_only', description: 'No text', inputSchema: obj },
    { name: 'pid', description: 'process id', inputSchema: obj },
    { name: 'add_tool', description: 'Adds one and says so', inputSchema: obj },
    { name: 'add_tool_silently', description: 'Adds one without tools/list_changed', inputSchema: obj },
    { name: 'slow_lists', description: 'Makes tools/list wait args.ms', inputSchema: obj },
    ...extra,
  ];
  const server = new Server({ name: 'fx', version: '1.0.0' }, { capabilities: { tools: { listChanged: true }, resources: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (listDelayMs) await new Promise((r) => setTimeout(r, listDelayMs));
    return { tools: tools() };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const a = req.params.arguments ?? {};
    switch (req.params.name) {
      case 'show': return { content: [{ type: 'text', text: `shown ${a.x}` }], structuredContent: { x: a.x }, _meta: { 'fx/secretish': 'host only' } };
      case 'app_only': return { content: [{ type: 'text', text: 'app ok' }] };
      case 'model_only': return { content: [{ type: 'text', text: 'model ok' }] };
      case 'plain': return { content: [{ type: 'text', text: 'plain ok' }] };
      case 'slow': await new Promise((r) => setTimeout(r, Number(a.ms ?? 1000))); return { content: [{ type: 'text', text: 'slow done' }] };
      case 'die': setTimeout(() => (onExit ? onExit() : process.exit(3)), 5); return new Promise(() => {});
      case 'fail': return { content: [{ type: 'text', text: 'it failed' }], isError: true };
      case 'throws': throw new Error('fixture refused');
      case 'echo_env': return { content: [{ type: 'text', text: `value=${process.env[String(a.name)] ?? '(unset)'}` }] };
      case 'structured_only': return { content: [], structuredContent: { n: 7 } };
      case 'pid': return { content: [{ type: 'text', text: String(process.pid) }] };
      case 'add_tool':
        extra.push({ name: 'added', description: 'Added later', inputSchema: obj });
        await server.sendToolListChanged();
        return { content: [{ type: 'text', text: 'added' }] };
      case 'add_tool_silently':
        extra.push({ name: 'silent', description: 'Added without notice', inputSchema: obj });
        return { content: [{ type: 'text', text: 'added silently' }] };
      case 'slow_lists':
        listDelayMs = Number(a.ms ?? 1000);
        return { content: [{ type: 'text', text: 'lists are slow now' }] };
      default: throw new Error(`no tool ${req.params.name}`);
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: VIEW_URI, name: 'view', mimeType: 'text/html;profile=mcp-app' },
      { uri: LISTED_URI, name: 'listed', mimeType: 'text/html;profile=mcp-app', _meta: { ui: LISTED_UI } },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri === VIEW_URI) {
      return { contents: [{ uri: VIEW_URI, mimeType: 'text/html;profile=mcp-app', text: '<p>view</p>', _meta: { ui: VIEW_UI } }] };
    }
    if (req.params.uri === LISTED_URI) {
      return { contents: [{ uri: LISTED_URI, mimeType: 'text/html;profile=mcp-app', text: '<p>listed</p>' }] };
    }
    throw new Error(`no resource ${req.params.uri}`);
  });
  return server;
}

if (process.argv.includes('--stdio')) {
  await makeServer().connect(new StdioServerTransport());
}
