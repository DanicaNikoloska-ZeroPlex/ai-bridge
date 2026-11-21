/**
 * Which host the bridge is willing to fetch attachments from, and upload them
 * to.
 *
 * This is the load-bearing control on the attachment path. Without it, a
 * compromised or simply hostile server turns every connected bridge into a
 * fetcher for arbitrary hosts — with the operator's own connection token
 * attached as a bearer credential, from inside whatever network the developer's
 * machine happens to sit in. The bridge therefore talks to exactly one origin:
 * the one it is connected to.
 */

/**
 * A URL this bridge will not fetch, as a type rather than as a sentence.
 *
 * The caller reports a policy refusal (`attachment_refused`) differently from
 * a download that failed (`attachment_failed`), because one is a misconfigured
 * or hostile server and the other is a network. Deriving that distinction by
 * matching the message text would make a reworded string quietly turn a
 * host-binding refusal into something the server may retry.
 */
export class AttachmentUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentUrlError';
  }
}

/**
 * Derive the HTTP origin that matches a WebSocket server URL.
 *
 * `wss://app.example.com/api/ai-bridge/ws` gives `https://app.example.com`.
 * The port is preserved when one is explicit, because a different port is a
 * different origin.
 */
export function originFromServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  const scheme = url.protocol === 'ws:' ? 'http:' : url.protocol === 'wss:' ? 'https:' : url.protocol;
  return `${scheme}//${url.host}`;
}

/**
 * The origin attachment URLs must be on.
 *
 * `--api` exists for split deployments, where the WebSocket endpoint and the
 * HTTP API are not the same host. It is an OPERATOR flag on purpose: letting
 * the server nominate its own second origin would give back exactly the
 * freedom this check removes.
 */
export function resolveApiOrigin(serverUrl: string, apiOverride?: string): string {
  if (apiOverride) {
    const url = new URL(apiOverride);
    if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
      throw new Error(
        `--api must be an https:// URL for a non-loopback host (got "${apiOverride}"). `
        + 'The connection token is sent to it as a bearer credential.',
      );
    }
    return `${url.protocol}//${url.host}`;
  }
  return originFromServerUrl(serverUrl);
}

/**
 * True for addresses that never leave the machine.
 *
 * The plaintext exception below is scoped to these, and only these. It exists
 * because a developer working on the server this bridge talks to runs it on
 * `http://127.0.0.1:8085`, and a rule that made that impossible would be
 * routed around rather than followed.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') {
    return true;
  }
  // A complete dotted quad, anchored at both ends. A prefix test on `127.`
  // would accept `127.0.0.1.evil.com`, which is an ordinary DNS name someone
  // else controls — and accepting it would hand this bridge's token to that
  // host in cleartext, on the strength of it merely looking local.
  const quad = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!quad) {
    return false;
  }
  return quad.slice(1).every((part) => Number(part) <= 255);
}

/**
 * Refuse any attachment URL that is not on the connected server's origin, and
 * any that is not HTTPS.
 *
 * Both halves matter and they close different holes. The origin match is what
 * stops the bridge being aimed at a third party. The HTTPS requirement is what
 * stops the bearer token going out in cleartext — moot on loopback, which is
 * why that is the one exception, and why the exception is expressed as "the
 * host never leaves this machine" rather than as a flag someone can set.
 *
 * @throws Error when the URL is unusable — the caller turns this into a refusal.
 */
export function assertAllowedAttachmentUrl(rawUrl: string, expectedOrigin: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AttachmentUrlError(`attachment URL is not a valid URL: "${rawUrl}"`);
  }

  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
    throw new AttachmentUrlError(
      `attachment URL must use https:// (got "${url.protocol}//" for host "${url.hostname}").`,
    );
  }

  const origin = `${url.protocol}//${url.host}`;
  if (origin !== expectedOrigin) {
    throw new AttachmentUrlError(
      `attachment URL host "${origin}" is not the server this bridge is connected to (${expectedOrigin}). `
      + 'Refusing to fetch it. Use --api if the HTTP API is genuinely on another host.',
    );
  }

  return url;
}
