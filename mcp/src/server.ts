/**
 * Builds the MCP server and registers the CSS tools on it.
 *
 * A fresh server is constructed per request — `createMcpHandler` calls this
 * factory for every HTTP request, which is what makes the deployment stateless
 * and therefore horizontally scalable across Workers isolates.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { dataMeta } from './data/index.js';
import * as auditCss from './tools/audit-css.js';
import * as checkSupport from './tools/check-support.js';
import * as dontMakeMeThink from './tools/dont-make-me-think.js';
import * as getFeature from './tools/get-feature.js';
import * as searchCssFeatures from './tools/search-css-features.js';
import * as whatsNew from './tools/whats-new.js';
import { WebStatusError } from './webstatus.js';

export const SERVER_NAME = 'css-sota-mcp';
export const SERVER_VERSION = '0.1.0';

/** Guidance shown to clients that surface server instructions. */
const INSTRUCTIONS = `Answers "what CSS can I actually ship?" from live Baseline data and MDN browser-compat-data.

Pick a tool by the question:
- Which features exist for X, and are they safe yet? -> search_css_features
- What became usable recently? -> whats_new
- Everything about one feature -> get_feature
- Which browser versions support one property/value/selector? -> check_support
- Does this stylesheet work for my users? -> audit_css
- How should this UI be designed, or is this page any good? -> dont_make_me_think

Baseline levels: "widely" means interoperable across Chrome, Edge, Firefox and Safari
(desktop and mobile) for 30+ months; "newly" means interoperable but recently so;
"limited" means at least one major engine is missing it.

search_css_features, whats_new and get_feature query api.webstatus.dev live.
check_support and audit_css answer from bundled data (browser-compat-data ${dataMeta.bcdVersion},
web-features ${dataMeta.webFeaturesVersion}) and need no network access.`;

/** Any of the tool modules; they all expose the same three exports. */
interface ToolModule {
  name: string;
  config: Record<string, unknown>;
  handler: (args: never) => Promise<unknown>;
}

const TOOLS: ToolModule[] = [
  searchCssFeatures as unknown as ToolModule,
  whatsNew as unknown as ToolModule,
  getFeature as unknown as ToolModule,
  checkSupport as unknown as ToolModule,
  auditCss as unknown as ToolModule,
  dontMakeMeThink as unknown as ToolModule,
];

/**
 * Turns an upstream or unexpected failure into a tool result rather than a
 * protocol error.
 *
 * A model that is told "api.webstatus.dev returned 503" can retry or fall back
 * to `check_support`; one that receives a transport-level error usually just
 * gives up. Schema violations still throw, because those are bugs in the call
 * the model made and the SDK reports them precisely.
 */
function describeFailure(error: unknown): string {
  if (error instanceof WebStatusError) {
    return (
      `Upstream lookup failed: ${error.message}\n\n` +
      `The Web Platform Dashboard may be temporarily unavailable. ` +
      `\`check_support\` and \`audit_css\` work from bundled data and are unaffected.`
    );
  }
  if (error instanceof Error) return `Tool failed: ${error.message}`;
  return `Tool failed: ${String(error)}`;
}

/**
 * Creates a server instance with every tool registered.
 *
 * Called once per HTTP request by `createMcpHandler`.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  for (const tool of TOOLS) {
    server.registerTool(tool.name, tool.config as never, (async (args: never) => {
      try {
        return await tool.handler(args);
      } catch (error) {
        // Results flagged `isError` are exempt from output-schema validation,
        // so no `structuredContent` is needed here.
        return {
          content: [{ type: 'text' as const, text: describeFailure(error) }],
          isError: true,
        };
      }
    }) as never);
  }

  return server;
}
