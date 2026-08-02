/**
 * Cloudflare Worker entry point.
 *
 * `createMcpHandler` from the MCP TypeScript SDK v2 returns a web-standard
 * `{ fetch, … }` object — exactly the shape Workers expect — and serves both
 * the 2026-07-28 protocol revision and, statelessly, 2025-era Streamable HTTP
 * clients from the same endpoint. That second part matters in practice: the
 * Cloudflare AI Playground and MCP Inspector are 2025-era clients.
 *
 * Because serving is stateless, this Worker needs no Durable Object, no KV and
 * no session affinity; any isolate can answer any request.
 *
 * The endpoint is deliberately public and unauthenticated — every tool is
 * read-only over public datasets, so there is nothing to protect from
 * disclosure. What there is to protect is the account's request budget and the
 * Worker's standing with the upstreams it proxies, which is what the limits
 * below are for.
 */

import { createMcpHandler } from '@modelcontextprotocol/server';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { dataMeta } from './data/index.js';

/** Path the MCP endpoint is served from. */
const MCP_PATH = '/mcp';

/**
 * Legacy alias. Clients that were configured against the deprecated HTTP+SSE
 * transport point here; they are served the same Streamable HTTP handler.
 */
const LEGACY_PATH = '/sse';

/**
 * Largest request body accepted, in bytes.
 *
 * `audit_css` caps its `source` argument at 400 000 characters in its schema,
 * so a legitimate call fits comfortably. Rejecting oversized bodies on the
 * declared length costs nothing and avoids parsing megabytes to discover the
 * same thing.
 */
const MAX_BODY_BYTES = 1_000_000;

export interface Env {
  SERVER_VERSION?: string;
  /**
   * Per-client request limiter. Optional so the Worker still runs when the
   * binding is absent — an old deployment, or a test harness.
   */
  MCP_RATE_LIMITER?: RateLimit;
}

const handler = createMcpHandler(() => createServer(), {
  onerror: (error) => console.error('mcp handler error', error),
});

/**
 * Browsers preflight cross-origin MCP requests; the AI Playground is one such
 * caller. The endpoint is public and read-only, so any origin is allowed.
 */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version, mcp-session-id',
  'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
  'access-control-max-age': '86400',
};

/**
 * Headers applied to every response.
 *
 * This Worker only ever emits JSON and event streams, never HTML, so the
 * browser-facing surface is small — but `nosniff` costs nothing and stops a
 * client from being talked into treating a tool result as markup. The frame
 * and referrer directives are belt-and-braces for the same reason.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

function decorate(response: Response, extra: Record<string, string> = {}): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries({ ...CORS_HEADERS, ...SECURITY_HEADERS, ...extra })) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Reads and throws away a request body we are answering without parsing.
 *
 * Leaving the stream unread is not free: `wrangler dev`'s drain middleware
 * raises `Failed to drain the unused request body` and takes the process down,
 * and a client may see a connection error instead of the status we sent.
 *
 * Draining rather than cancelling keeps the connection reusable, which matters
 * for the rate-limited path — a client told to retry in 60 seconds should not
 * also have its connection reset. Only safe for bodies already known to be
 * small; use {@link abandonBody} otherwise.
 */
async function drainBody(request: Request): Promise<void> {
  try {
    await request.arrayBuffer();
  } catch {
    // The peer may have hung up already; nothing to clean up.
  }
}

/**
 * Discards an oversized body without buffering it.
 *
 * Cancelling resets the connection, which is the correct outcome for a body we
 * are refusing on size — the alternative is reading the megabytes we just said
 * were too many. Clients that reuse the connection anyway will see a reset;
 * that is their bug, and the status line told them why.
 */
async function abandonBody(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch {
    // Already closed.
  }
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return decorate(
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
    extra,
  );
}

/**
 * Applies the per-client request limit.
 *
 * The key is the client IP. Cloudflare's own guidance prefers a stable user or
 * tenant id, and warns that an IP can be shared by many legitimate users behind
 * NAT or a privacy proxy — but this endpoint has no authentication and
 * therefore no such id to key on. The limit is set generously enough
 * (`limit`/`period` in `wrangler.jsonc`) that a shared address running normal
 * agent traffic will not reach it, which is the right trade for the only
 * identifier available.
 *
 * Limits are per Cloudflare location rather than global, so the effective
 * ceiling for a distributed caller is higher. That is fine: the goal is to stop
 * one client hammering one colo, not to meter usage precisely.
 *
 * @returns A 429 response when the caller is over budget, otherwise `undefined`.
 */
async function enforceRateLimit(request: Request, env: Env): Promise<Response | undefined> {
  if (!env.MCP_RATE_LIMITER) return undefined;

  const clientIp = request.headers.get('cf-connecting-ip') ?? 'unknown';

  try {
    const { success } = await env.MCP_RATE_LIMITER.limit({ key: clientIp });
    if (success) return undefined;
  } catch (error) {
    // A limiter failure must not take the endpoint down with it; the request
    // budget is worth less than availability here.
    console.error('rate limiter unavailable', error);
    return undefined;
  }

  return json(
    {
      error: 'Too many requests',
      detail:
        'This endpoint is free and shared. Slow down, or run your own instance — ' +
        'see https://github.com/LuSrodri/css-sota-mcp',
    },
    429,
    { 'retry-after': '60' },
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return decorate(new Response(null, { status: 204 }));
    }

    if (url.pathname === MCP_PATH || url.pathname === LEGACY_PATH) {
      const declaredLength = Number(request.headers.get('content-length') ?? '0');
      if (declaredLength > MAX_BODY_BYTES) {
        await abandonBody(request);
        return json(
          {
            error: 'Payload too large',
            detail: `Request bodies are limited to ${MAX_BODY_BYTES} bytes.`,
          },
          413,
        );
      }

      const limited = await enforceRateLimit(request, env);
      if (limited) {
        await drainBody(request);
        return limited;
      }

      return decorate(await handler.fetch(request));
    }

    if (url.pathname === '/health') {
      return json({
        status: 'ok',
        server: SERVER_NAME,
        version: env.SERVER_VERSION ?? SERVER_VERSION,
        data: dataMeta,
      });
    }

    if (url.pathname === '/' || url.pathname === '') {
      return json({
        name: SERVER_NAME,
        version: env.SERVER_VERSION ?? SERVER_VERSION,
        description:
          'MCP server for state-of-the-art CSS: Baseline status, browser support, and CSS audits.',
        endpoint: new URL(MCP_PATH, url.origin).toString(),
        transport: 'streamable-http',
        tools: [
          'search_css_features',
          'whats_new',
          'get_feature',
          'check_support',
          'audit_css',
          'dont_make_me_think',
        ],
        docs: 'https://github.com/LuSrodri/css-sota-mcp',
      });
    }

    return json({ error: 'Not found', endpoint: MCP_PATH }, 404);
  },
} satisfies ExportedHandler<Env>;

export { handler };
