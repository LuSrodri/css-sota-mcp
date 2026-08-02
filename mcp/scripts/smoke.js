/**
 * End-to-end smoke test against a running MCP endpoint.
 *
 * Speaks the 2025-era Streamable HTTP flow — initialize, tools/list, tools/call
 * — because that is what the Cloudflare AI Playground and MCP Inspector do. If
 * this passes against a URL, those clients will work against it too.
 *
 * Usage: node scripts/smoke.js [url]   (default http://127.0.0.1:8787/mcp)
 */

const endpoint = process.argv[2] ?? 'http://127.0.0.1:8787/mcp';

let sessionId;
let nextId = 1;

/**
 * Sends one JSON-RPC message and returns the parsed result.
 *
 * The endpoint may answer with either a JSON body or an SSE stream depending on
 * negotiation, so both are handled.
 */
async function rpc(method, params) {
  const id = nextId++;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });

  const capturedSession = response.headers.get('mcp-session-id');
  if (capturedSession) sessionId = capturedSession;

  const text = await response.text();
  if (!response.ok) throw new Error(`${method} -> HTTP ${response.status}: ${text.slice(0, 400)}`);

  // SSE frames arrive as `data: {...}` lines; take the last one.
  const payload = text.includes('data:')
    ? text
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .at(-1)
    : text;

  const message = JSON.parse(payload);
  if (message.error) throw new Error(`${method} -> ${JSON.stringify(message.error)}`);
  return message.result;
}

async function notify(method, params) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method, params }),
  });
}

function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return true;
  }
  console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  return false;
}

async function main() {
  console.log(`Smoke testing ${endpoint}\n`);
  let failures = 0;
  const record = (...args) => {
    if (!check(...args)) failures++;
  };

  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'css-sota-smoke', version: '1.0.0' },
  });
  record('initialize', Boolean(init.serverInfo?.name), JSON.stringify(init).slice(0, 200));
  console.log(`        server: ${init.serverInfo?.name} ${init.serverInfo?.version}`);

  await notify('notifications/initialized', {});

  const { tools } = await rpc('tools/list', {});
  const names = tools.map((tool) => tool.name).sort();
  console.log(`        tools: ${names.join(', ')}`);
  record(
    'tools/list returns all five tools',
    ['audit_css', 'check_support', 'get_feature', 'search_css_features', 'whats_new'].every((n) =>
      names.includes(n),
    ),
  );
  record(
    'every tool declares an input and output schema',
    tools.every((tool) => tool.inputSchema && tool.outputSchema),
  );

  const audit = await rpc('tools/call', {
    name: 'audit_css',
    arguments: { source: '.a { anchor-name: --tip; color: red; }', target: 'chrome 100' },
  });
  record('audit_css flags an unsupported property', audit.structuredContent?.failing > 0);

  const supportResult = await rpc('tools/call', {
    name: 'check_support',
    arguments: { property: 'display', value: 'grid' },
  });
  record(
    'check_support resolves display: grid',
    supportResult.structuredContent?.key === 'css.properties.display.grid',
  );

  const search = await rpc('tools/call', {
    name: 'search_css_features',
    arguments: { query: 'container queries', limit: 5 },
  });
  record(
    'search_css_features reaches the live dashboard',
    Array.isArray(search.structuredContent?.features) &&
      search.structuredContent.features.length > 0,
    JSON.stringify(search).slice(0, 300),
  );

  const feature = await rpc('tools/call', {
    name: 'get_feature',
    arguments: { feature_id: 'subgrid' },
  });
  record('get_feature returns a live record', feature.structuredContent?.found === true);
  record(
    'get_feature includes MDN prose',
    Boolean(feature.structuredContent?.mdnUrl),
    JSON.stringify(feature.structuredContent).slice(0, 300),
  );

  const news = await rpc('tools/call', {
    name: 'whats_new',
    arguments: { since: '2025-01-01', limit: 10 },
  });
  record('whats_new returns a window of features', news.structuredContent?.count >= 0);

  const bad = await rpc('tools/call', {
    name: 'check_support',
    arguments: { bcd_key: 'css.properties.nope' },
  });
  record('an unresolvable lookup returns isError with suggestions', bad.isError === true);

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
