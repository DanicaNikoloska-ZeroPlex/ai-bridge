/**
 * Host binding for attachments.
 *
 * This is the control that stops a compromised or hostile server turning every
 * connected bridge into a fetcher for arbitrary hosts, with the operator's own
 * connection token attached. The tests are mostly about what is REFUSED.
 */

import { describe, it, expect } from 'vitest';
import {
  assertAllowedAttachmentUrl,
  isLoopbackHost,
  originFromServerUrl,
  resolveApiOrigin,
} from '../../src/attachments/origin.js';

describe('originFromServerUrl', () => {
  it('maps wss:// to https://', () => {
    expect(originFromServerUrl('wss://app.example.com/api/ai-bridge/ws'))
      .toBe('https://app.example.com');
  });

  it('maps ws:// to http://', () => {
    expect(originFromServerUrl('ws://127.0.0.1:8085/ws')).toBe('http://127.0.0.1:8085');
  });

  it('keeps an explicit port, because a different port is a different origin', () => {
    expect(originFromServerUrl('wss://app.example.com:8443/ws'))
      .toBe('https://app.example.com:8443');
  });
});

describe('resolveApiOrigin', () => {
  it('derives the origin from the server URL by default', () => {
    expect(resolveApiOrigin('wss://app.example.com/ws')).toBe('https://app.example.com');
  });

  it('accepts an https --api override for split deployments', () => {
    expect(resolveApiOrigin('wss://ws.example.com/ws', 'https://api.example.com'))
      .toBe('https://api.example.com');
  });

  it('accepts a loopback http --api, which is how the server itself is developed', () => {
    expect(resolveApiOrigin('ws://127.0.0.1:8085/ws', 'http://localhost:8000'))
      .toBe('http://localhost:8000');
  });

  it('refuses a plaintext --api for a real host — the token goes to it as a bearer', () => {
    expect(() => resolveApiOrigin('wss://x.example.com/ws', 'http://api.example.com'))
      .toThrow(/https/);
  });
});

describe('isLoopbackHost', () => {
  it('recognises the loopback forms', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'LOCALHOST']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it('does not treat a lookalike host as loopback', () => {
    for (const host of ['127.0.0.1.evil.com', 'localhost.evil.com', 'notlocalhost']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe('assertAllowedAttachmentUrl', () => {
  const origin = 'https://app.example.com';

  it('accepts a URL on the connected server origin', () => {
    const url = assertAllowedAttachmentUrl(`${origin}/ai-bridge/attachments/att_1`, origin);
    expect(url.pathname).toBe('/ai-bridge/attachments/att_1');
  });

  it('refuses a URL on any other host', () => {
    expect(() => assertAllowedAttachmentUrl('https://evil.example.com/x', origin))
      .toThrow(/not the server this bridge is connected to/);
  });

  it('refuses a different port on the same hostname', () => {
    expect(() => assertAllowedAttachmentUrl('https://app.example.com:8443/x', origin))
      .toThrow(/not the server this bridge is connected to/);
  });

  it('refuses plaintext http for a non-loopback host', () => {
    expect(() => assertAllowedAttachmentUrl('http://app.example.com/x', origin))
      .toThrow(/https/);
  });

  it('refuses a non-http scheme outright', () => {
    expect(() => assertAllowedAttachmentUrl('file:///etc/passwd', origin)).toThrow();
    expect(() => assertAllowedAttachmentUrl('ftp://app.example.com/x', origin)).toThrow();
  });

  it('refuses userinfo used to fake the host', () => {
    // https://app.example.com@evil.com/ has host evil.com, not app.
    expect(() => assertAllowedAttachmentUrl('https://app.example.com@evil.com/x', origin))
      .toThrow(/not the server this bridge is connected to/);
  });

  it('refuses something that is not a URL at all', () => {
    expect(() => assertAllowedAttachmentUrl('not a url', origin)).toThrow(/not a valid URL/);
  });

  it('allows plaintext loopback, where there is no wire to eavesdrop on', () => {
    const local = 'http://127.0.0.1:8085';
    expect(assertAllowedAttachmentUrl(`${local}/ai-bridge/attachments/a`, local).host)
      .toBe('127.0.0.1:8085');
  });
});
