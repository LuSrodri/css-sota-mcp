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

export interface Env {
  SERVER_VERSION?: string;
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

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(body: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }

    if (url.pathname === MCP_PATH || url.pathname === LEGACY_PATH) {
      return withCors(await handler.fetch(request));
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
        tools: ['search_css_features', 'whats_new', 'get_feature', 'check_support', 'audit_css'],
        docs: 'https://github.com/LuSrodri/css-sota-mcp',
      });
    }

    return json({ error: 'Not found', endpoint: MCP_PATH }, 404);
  },
} satisfies ExportedHandler<Env>;

export { handler };
