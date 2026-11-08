/**
 * Tool results with content parts: text and images.
 *
 * A server tool usually answers with one value (`tool_resolve.result`), which
 * the MCP server hands the CLI as one text block. A server that read
 * `hello.tool_result_content` may also send `tool_resolve.content`: the MCP
 * `CallToolResult` content list, text and image parts, so a tool can show the
 * model a picture (a rendered map) beside its text. `result` stays the text
 * alone, for a bridge that predates this.
 *
 * What is accepted is checked here, once, on the way in. A part this bridge
 * cannot pass on is refused as a whole content list, not quietly dropped: the
 * CLI then gets `result`, exactly what an older bridge would have given it,
 * and the log says why.
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('ToolContent');

/** The image types every CLI that takes images reads (Anthropic's list). */
export const TOOL_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** At most this many parts in one result. */
export const MAX_TOOL_CONTENT_PARTS = 32;

export type ToolContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/**
 * A server tool's answer that carries content parts.
 *
 * What the MCP server returns to the CLI as content blocks, instead of the one
 * text block a plain result becomes. `text` is the server's `result`, kept for
 * logs and for anything that only wants the words.
 */
export class ToolContentResult {
  constructor(
    readonly content: ToolContentPart[],
    readonly text: string,
  ) {}

  /** Decoded size of the images, in bytes, for logs. */
  imageBytes(): number {
    return this.content.reduce(
      (sum, part) => sum + (part.type === 'image' ? Math.floor((part.data.length * 3) / 4) : 0),
      0,
    );
  }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Read `tool_resolve.content`, or null when there is none to use.
 *
 * Null for an absent field (an older server), and for one this bridge will not
 * pass on, which is logged. The caller then answers with `result`.
 */
export function parseToolResultContent(raw: unknown, toolCallId: string): ToolContentPart[] | null {
  if (raw === undefined || raw === null) return null;

  const refuse = (reason: string): null => {
    log.warn('tool_resolve.content refused, the CLI gets the text result', { toolCallId, reason });
    return null;
  };

  if (!Array.isArray(raw)) return refuse('content is not a list');
  if (raw.length === 0) return refuse('content is empty');
  if (raw.length > MAX_TOOL_CONTENT_PARTS) return refuse(`more than ${MAX_TOOL_CONTENT_PARTS} parts`);

  const parts: ToolContentPart[] = [];
  for (const [i, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null) return refuse(`part ${i} is not an object`);
    const part = item as Record<string, unknown>;

    if (part['type'] === 'text') {
      if (typeof part['text'] !== 'string') return refuse(`part ${i}: text is not a string`);
      parts.push({ type: 'text', text: part['text'] });
      continue;
    }

    if (part['type'] === 'image') {
      const data = part['data'];
      const mimeType = part['mimeType'];
      if (typeof mimeType !== 'string' || !(TOOL_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
        return refuse(`part ${i}: mimeType must be one of ${TOOL_IMAGE_MIME_TYPES.join(', ')}`);
      }
      if (typeof data !== 'string' || data === '' || data.length % 4 !== 0 || !BASE64.test(data)) {
        return refuse(`part ${i}: data is not base64`);
      }
      parts.push({ type: 'image', data, mimeType });
      continue;
    }

    return refuse(`part ${i}: unknown type ${JSON.stringify(String(part['type'])).slice(0, 40)}`);
  }

  return parts;
}
