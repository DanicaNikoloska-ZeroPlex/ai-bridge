import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolResolver } from '../../src/tools/resolver.js';
import type { SendToolCallFn } from '../../src/tools/resolver.js';

describe('ToolResolver', () => {
  let resolver: ToolResolver;
  let mockSendFn: SendToolCallFn;

  beforeEach(() => {
    vi.useFakeTimers();
    resolver = new ToolResolver(5000); // 5s timeout for tests
    mockSendFn = vi.fn();
  });

  afterEach(() => {
    resolver.cancelAll();
    vi.useRealTimers();
  });

  describe('call() and resolve()', () => {
    it('happy path: call sends message and resolve() resolves the promise', async () => {
      const promise = resolver.call(mockSendFn, 'req-1', 'tc-1', 'myTool', { foo: 'bar' });

      expect(mockSendFn).toHaveBeenCalledWith('req-1', 'tc-1', 'myTool', { foo: 'bar' });
      expect(resolver.pendingCount()).toBe(1);

      resolver.resolve('tc-1', { answer: 42 });

      const result = await promise;
      expect(result).toEqual({ answer: 42 });
      expect(resolver.pendingCount()).toBe(0);
    });

    it('resolves with string result', async () => {
      const promise = resolver.call(mockSendFn, 'req-1', 'tc-2', 'echo', {});
      resolver.resolve('tc-2', 'hello world');
      const result = await promise;
      expect(result).toBe('hello world');
    });

    it('resolves with null result', async () => {
      const promise = resolver.call(mockSendFn, 'req-1', 'tc-3', 'noop', {});
      resolver.resolve('tc-3', null);
      const result = await promise;
      expect(result).toBeNull();
    });
  });

  describe('timeout', () => {
    it('rejects with timeout error after configured timeout', async () => {
      const promise = resolver.call(mockSendFn, 'req-1', 'tc-timeout', 'slowTool', {});

      // Advance time past timeout
      vi.advanceTimersByTime(5001);

      await expect(promise).rejects.toThrow('timed out after 5s');
      expect(resolver.pendingCount()).toBe(0);
    });

    it('does not time out if resolved before timeout', async () => {
      const promise = resolver.call(mockSendFn, 'req-1', 'tc-fast', 'fastTool', {});

      vi.advanceTimersByTime(3000); // Less than 5s timeout
      resolver.resolve('tc-fast', 'done');

      const result = await promise;
      expect(result).toBe('done');
    });

    it('uses updated timeout from setTimeoutMs()', async () => {
      resolver.setTimeoutMs(1000); // Reduce to 1s

      const promise = resolver.call(mockSendFn, 'req-1', 'tc-short', 'tool', {});
      vi.advanceTimersByTime(1001);

      await expect(promise).rejects.toThrow('timed out after 1s');
    });
  });

  describe('cancelAll()', () => {
    it('rejects all pending calls with disconnect error', async () => {
      const p1 = resolver.call(mockSendFn, 'req-1', 'tc-a', 'toolA', {});
      const p2 = resolver.call(mockSendFn, 'req-1', 'tc-b', 'toolB', {});
      const p3 = resolver.call(mockSendFn, 'req-1', 'tc-c', 'toolC', {});

      expect(resolver.pendingCount()).toBe(3);

      resolver.cancelAll();

      await expect(p1).rejects.toThrow('Result unknown');
      await expect(p2).rejects.toThrow('Result unknown');
      await expect(p3).rejects.toThrow('Result unknown');
      expect(resolver.pendingCount()).toBe(0);
    });

    it('does nothing when there are no pending calls', () => {
      expect(() => resolver.cancelAll()).not.toThrow();
      expect(resolver.pendingCount()).toBe(0);
    });
  });

  describe('reject()', () => {
    it('rejects a specific pending call with an error', async () => {
      const promise = resolver.call(mockSendFn, 'req-1', 'tc-fail', 'failTool', {});

      const rejected = resolver.reject('tc-fail', 'Something went wrong');
      expect(rejected).toBe(true);

      await expect(promise).rejects.toThrow('Tool error (failTool): Something went wrong');
      expect(resolver.pendingCount()).toBe(0);
    });

    it('returns false for unknown toolCallId', () => {
      const result = resolver.reject('unknown-id', 'error');
      expect(result).toBe(false);
    });

    it('does not affect other pending calls', async () => {
      const p1 = resolver.call(mockSendFn, 'req-1', 'tc-1', 'tool1', {});
      const p2 = resolver.call(mockSendFn, 'req-1', 'tc-2', 'tool2', {});

      resolver.reject('tc-1', 'failed');
      await expect(p1).rejects.toThrow();

      expect(resolver.pendingCount()).toBe(1);

      resolver.resolve('tc-2', 'ok');
      const result = await p2;
      expect(result).toBe('ok');
    });
  });

  describe('duplicate toolCallId handling', () => {
    it('overwrites a pending call if the same toolCallId is used again', async () => {
      const p1 = resolver.call(mockSendFn, 'req-1', 'tc-dup', 'tool1', {});
      const p2 = resolver.call(mockSendFn, 'req-1', 'tc-dup', 'tool2', {});

      // Only the second call is tracked — resolve should resolve p2
      resolver.resolve('tc-dup', 'result');
      const result = await p2;
      expect(result).toBe('result');

      // The first promise's timer is still active; it will time out eventually
      // This is an edge case — the map overwrite means p1 is orphaned
      expect(resolver.pendingCount()).toBe(0);
    });
  });

  describe('resolve() with unknown toolCallId', () => {
    it('returns false for unknown toolCallId', () => {
      const result = resolver.resolve('nonexistent', 'data');
      expect(result).toBe(false);
    });
  });

  describe('pendingCount()', () => {
    it('returns 0 initially', () => {
      expect(resolver.pendingCount()).toBe(0);
    });

    it('increments with each call and decrements on resolve', async () => {
      resolver.call(mockSendFn, 'req-1', 'tc-1', 'tool', {});
      expect(resolver.pendingCount()).toBe(1);

      resolver.call(mockSendFn, 'req-1', 'tc-2', 'tool', {});
      expect(resolver.pendingCount()).toBe(2);

      resolver.resolve('tc-1', 'done');
      expect(resolver.pendingCount()).toBe(1);

      resolver.resolve('tc-2', 'done');
      expect(resolver.pendingCount()).toBe(0);
    });

    it('decrements on reject', async () => {
      const promise = resolver.call(mockSendFn, 'req-1', 'tc-1', 'tool', {});
      expect(resolver.pendingCount()).toBe(1);

      resolver.reject('tc-1', 'err');
      expect(resolver.pendingCount()).toBe(0);

      // Catch the expected rejection to avoid unhandled promise rejection
      await expect(promise).rejects.toThrow();
    });

    it('decrements on timeout', async () => {
      const promise = resolver.call(mockSendFn, 'req-1', 'tc-1', 'tool', {});
      expect(resolver.pendingCount()).toBe(1);

      vi.advanceTimersByTime(5001);
      expect(resolver.pendingCount()).toBe(0);

      // Catch the expected rejection to avoid unhandled promise rejection
      await expect(promise).rejects.toThrow();
    });

    // singular/plural correctness at the 60-second boundary
    it('uses "1 minute" (singular) when timeout is exactly 60 seconds', async () => {
      resolver.setTimeoutMs(60_000); // exactly 60s
      const promise = resolver.call(mockSendFn, 'req-1', 'tc-60s', 'myTool', {});

      vi.advanceTimersByTime(60_001);

      await expect(promise).rejects.toThrow('1 minute');
      await expect(promise).rejects.not.toThrow('1 minutes');
    });

    it('uses "2 minutes" (plural) for 120-second timeout', async () => {
      resolver.setTimeoutMs(120_000);
      const promise = resolver.call(mockSendFn, 'req-1', 'tc-120s', 'myTool', {});

      vi.advanceTimersByTime(120_001);

      await expect(promise).rejects.toThrow('2 minutes');
    });

    it('uses seconds format for sub-60-second timeouts', async () => {
      // resolver is initialized with 5s timeout
      const promise = resolver.call(mockSendFn, 'req-1', 'tc-5s', 'myTool', {});

      vi.advanceTimersByTime(5_001);

      await expect(promise).rejects.toThrow('5s');
    });
  });
});

describe('a per-call wait', () => {
  it('overrides the configured wait for that one call', async () => {
    // How a tool call is kept inside the time left in its turn. If the resolver
    // ignored the argument, every call would wait the configured value again.
    const resolver = new ToolResolver(60_000);
    const started = Date.now();

    await expect(
      resolver.call(() => undefined, 'req', 'tc-1', 'slow', {}, 50),
    ).rejects.toThrow(/timed out after 50ms/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
