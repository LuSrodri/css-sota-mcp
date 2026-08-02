/**
 * Tests the Worker's request handling — the layer around the MCP handler:
 * routing, CORS, security headers, the body cap and the rate limiter.
 *
 * The MCP handler itself is exercised end to end by `scripts/smoke.js` against
 * a real workerd instance in CI. What is checked here is everything that
 * decides whether a request reaches it at all.
 */

import { describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index.js';

/** A stand-in for `ExecutionContext`; the Worker never uses it. */
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

/** Builds an env, optionally with a limiter that always allows or always denies. */
function env(options: { rateLimit?: 'allow' | 'deny' | 'throw' } = {}): Env {
  if (!options.rateLimit) return {};
  return {
    MCP_RATE_LIMITER: {
      limit: vi.fn(async () => {
        if (options.rateLimit === 'throw') throw new Error('limiter down');
        return { success: options.rateLimit === 'allow' };
      }),
    } as unknown as RateLimit,
  };
}

function get(path: string, init?: RequestInit): Request {
  return new Request(`https://example.com${path}`, init);
}

/** A minimal, valid MCP initialize request. */
function initializeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
  });
}

describe('routing', () => {
  it('serves service metadata at the root', async () => {
    const response = await worker.fetch(get('/'), env(), ctx);
    const body = (await response.json()) as { endpoint: string; tools: string[] };

    expect(response.status).toBe(200);
    expect(body.endpoint).toBe('https://example.com/mcp');
    // Named rather than counted: a bare length assertion goes stale silently
    // the moment a tool is added, and says nothing about which ones are served.
    expect([...body.tools].sort()).toEqual([
      'audit_css',
      'check_support',
      'dont_make_me_think',
      'get_feature',
      'search_css_features',
      'whats_new',
    ]);
  });

  it('reports data provenance at /health', async () => {
    const response = await worker.fetch(get('/health'), env(), ctx);
    const body = (await response.json()) as { status: string; data: { bcdKeys: number } };

    expect(body.status).toBe('ok');
    expect(body.data.bcdKeys).toBeGreaterThan(3000);
  });

  it('404s an unknown path and points at the endpoint', async () => {
    const response = await worker.fetch(get('/nope'), env(), ctx);

    expect(response.status).toBe(404);
    expect((await response.json() as { endpoint: string }).endpoint).toBe('/mcp');
  });

  it('answers preflight without a body', async () => {
    const response = await worker.fetch(get('/mcp', { method: 'OPTIONS' }), env(), ctx);

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('serves the legacy /sse alias with the same handler', async () => {
    const request = new Request('https://example.com/sse', initializeRequest());
    const response = await worker.fetch(request, env(), ctx);

    // Not a 404: the alias routes into the MCP handler rather than falling through.
    expect(response.status).not.toBe(404);
  });
});

describe('headers', () => {
  it('applies CORS and security headers to every response', async () => {
    for (const path of ['/', '/health', '/nope']) {
      const response = await worker.fetch(get(path), env(), ctx);

      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });
});

describe('body size cap', () => {
  it('rejects a body larger than the cap without parsing it', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '2000000' },
        body: '{}',
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(413);
  });

  it('allows a body within the cap', async () => {
    const response = await worker.fetch(initializeRequest(), env(), ctx);

    expect(response.status).not.toBe(413);
  });
});

describe('rate limiting', () => {
  it('passes the request through when under the limit', async () => {
    const response = await worker.fetch(initializeRequest(), env({ rateLimit: 'allow' }), ctx);

    expect(response.status).not.toBe(429);
  });

  it('returns 429 with Retry-After when over the limit', async () => {
    const response = await worker.fetch(initializeRequest(), env({ rateLimit: 'deny' }), ctx);

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect((await response.json() as { error: string }).error).toBe('Too many requests');
  });

  it('keys the limit on the client IP', async () => {
    const environment = env({ rateLimit: 'allow' });
    await worker.fetch(
      initializeRequest({ 'cf-connecting-ip': '203.0.113.7' }),
      environment,
      ctx,
    );

    expect(environment.MCP_RATE_LIMITER!.limit).toHaveBeenCalledWith({ key: '203.0.113.7' });
  });

  // Availability is worth more than the request budget: a broken limiter must
  // not take the endpoint down with it.
  it('serves the request when the limiter itself fails', async () => {
    const response = await worker.fetch(initializeRequest(), env({ rateLimit: 'throw' }), ctx);

    expect(response.status).not.toBe(429);
  });

  it('does not rate limit /health, which CI polls while waiting for boot', async () => {
    const environment = env({ rateLimit: 'deny' });
    const response = await worker.fetch(get('/health'), environment, ctx);

    expect(response.status).toBe(200);
    expect(environment.MCP_RATE_LIMITER!.limit).not.toHaveBeenCalled();
  });
});
