/**
 * A minimal browser MCP client, just large enough to call one tool.
 *
 * The hero demo talks to the deployed Worker over the real protocol rather than
 * a bespoke REST shim, so what the page shows is exactly what an agent would
 * get back. Only the 2025-era Streamable HTTP flow is implemented — initialize,
 * initialized, tools/call — because that is the widest-compatibility path and
 * the server serves it statelessly.
 */

/** Protocol revision this client speaks. */
const PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

/** A tool result, in the shape the MCP spec defines. */
export interface CallToolResult<T> {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: T;
  isError?: boolean;
}

export class McpClientError extends Error {}

export class McpClient {
  #endpoint: string;
  #sessionId: string | undefined;
  #initialized: Promise<void> | undefined;
  #nextId = 1;

  constructor(endpoint: string) {
    this.#endpoint = endpoint;
  }

  /**
   * Parses a response body that may be either a JSON document or an SSE
   * stream, depending on how the server chose to answer.
   */
  static #parseBody(body: string): JsonRpcResponse {
    if (!body.includes('data:')) return JSON.parse(body) as JsonRpcResponse;

    const lastFrame = body
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .at(-1);

    if (!lastFrame) throw new McpClientError('Server sent an empty event stream.');
    return JSON.parse(lastFrame) as JsonRpcResponse;
  }

  async #post(message: Record<string, unknown>, expectResponse: boolean): Promise<unknown> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
    };
    if (this.#sessionId) headers['mcp-session-id'] = this.#sessionId;

    const response = await fetch(this.#endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...message }),
    });

    const session = response.headers.get('mcp-session-id');
    if (session) this.#sessionId = session;

    if (!response.ok) {
      throw new McpClientError(`Server responded ${response.status}.`);
    }
    if (!expectResponse) return undefined;

    const parsed = McpClient.#parseBody(await response.text());
    if (parsed.error) throw new McpClientError(parsed.error.message);
    return parsed.result;
  }

  /** Runs the handshake once, reusing it for every later call. */
  #ensureInitialized(): Promise<void> {
    this.#initialized ??= (async () => {
      await this.#post(
        {
          id: this.#nextId++,
          method: 'initialize',
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'css-sota-landing', version: '1.0.0' },
          },
        },
        true,
      );
      await this.#post({ method: 'notifications/initialized', params: {} }, false);
    })();

    return this.#initialized;
  }

  /** Calls a tool and returns its result. */
  async callTool<T>(name: string, args: Record<string, unknown>): Promise<CallToolResult<T>> {
    await this.#ensureInitialized();
    const result = await this.#post(
      { id: this.#nextId++, method: 'tools/call', params: { name, arguments: args } },
      true,
    );
    return result as CallToolResult<T>;
  }
}
