# css-sota-mcp

An MCP server that answers **what CSS you can actually ship today** — from live Baseline data and
MDN browser-compat-data, not from a model's training set.

Agents are confidently wrong about browser support. They will tell you `anchor-name` is fine, or
that `:has()` needs a polyfill, depending on when their weights were frozen. This server replaces
the guess with the current answer.

- **Endpoint** — `https://css-sota-mcp.lusrodri.workers.dev/mcp` (Streamable HTTP, no auth)
- **Docs** — [css-sota-mcp.pages.dev](https://css-sota-mcp.pages.dev)

## Tools

| Tool | Answers | Source |
| --- | --- | --- |
| `search_css_features` | "Which features exist for this, and are they safe yet?" | webstatus.dev |
| `whats_new` | "What can I start using that I couldn't before?" | webstatus.dev |
| `get_feature` | "Tell me everything about this one feature." | webstatus.dev + mdn/content |
| `check_support` | "Which browser versions support this exactly?" | bundled browser-compat-data |
| `audit_css` | "Does this stylesheet work for my users?" | bundled browser-compat-data |

`check_support` and `audit_css` answer with no network call at all — the data they need is compiled
into the Worker.

### `audit_css` targets

Two target styles, because they answer different questions:

- **A Baseline level** — `baseline-widely`, `baseline-newly`. Asks "is this interoperable enough to
  ship?", judged against `web-features`' Baseline status.
- **An explicit browser list** — `chrome 120, safari 17.4, firefox 128`. Asks "does this work for
  *my* users?", judged against per-browser versions.

Browserslist queries (`last 2 versions`, `>0.5%`) are **not** accepted. Resolving them needs usage
data this server does not carry, and approximating them would produce confidently wrong audits —
exactly the failure mode the server exists to fix. The tool says so rather than guessing.

## Connect

```bash
claude mcp add --transport http css-sota https://css-sota-mcp.lusrodri.workers.dev/mcp
```

<details>
<summary>Claude Desktop</summary>

```json
{
  "mcpServers": {
    "css-sota": {
      "type": "http",
      "url": "https://css-sota-mcp.lusrodri.workers.dev/mcp"
    }
  }
}
```

</details>

<details>
<summary>Cloudflare AI Playground</summary>

Open [playground.ai.cloudflare.com](https://playground.ai.cloudflare.com/), paste the endpoint into
the MCP server field, and connect. The five tools appear immediately.

</details>

<details>
<summary>MCP Inspector</summary>

```bash
npx @modelcontextprotocol/inspector@latest
```

Set transport to Streamable HTTP and connect to the endpoint.

</details>

## Layout

```
mcp/       The MCP server — a Cloudflare Worker
landing/   Documentation site — Vite, on Cloudflare Pages
```

### How the data is put together

`@mdn/browser-compat-data` unpacks to ~20 MB, far past a Worker's bundle budget. At build time
`mcp/scripts/build-data.js` extracts the CSS slice of it plus the `web-features` catalog, drops
every field the server never reads, and encodes per-browser support positionally. The result is
about 1 MB of JSON — 120 KB gzipped — which ships inside the Worker.

The generated files are gitignored. Every build, test and deploy regenerates them, so the data
always matches whatever version npm resolved.

Two details worth knowing, both found the hard way:

- `web-features` encodes Baseline as `"high"` / `"low"` / `false`, while api.webstatus.dev and all
  Baseline documentation say `widely` / `newly` / `limited`. The build normalises to the latter so
  the two halves of the server never disagree.
- MDN reorganised its CSS reference under `Web/CSS/Reference/…`. Compat data records the slug a page
  had when the entry was written, so building a raw GitHub path from `mdn_url` 404s. `get_feature`
  resolves the canonical slug through MDN first, then reads the source.

## Development

```bash
npm install

npm run dev --workspace mcp        # wrangler dev on :8787
npm test --workspace mcp           # vitest
npm run typecheck                  # both workspaces

node mcp/scripts/smoke.js          # real MCP protocol call against :8787
node mcp/scripts/smoke.js <url>    # ...or against a deployment
```

`smoke.js` speaks the 2025-era Streamable HTTP flow — the same one the AI Playground and MCP
Inspector use — so a passing run means those clients will work too.

### Deploy

Pushing to `main` deploys both, via `.github/workflows/deploy.yml`. The Worker goes out first
and is smoke-tested against its live URL before the landing site follows, since the page's hero
demo calls the Worker.

Two repository secrets are required:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Token with **Workers Scripts: Edit** and **Cloudflare Pages: Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | The account id |

To deploy by hand instead:

```bash
npm run deploy --workspace mcp      # Worker
npm run deploy --workspace landing  # Pages
```

Both need Cloudflare credentials — either `wrangler login`, or the same two environment variables.

#### Account prerequisites

Cloudflare gates Workers behind these, and the errors are only visible at deploy time:

- **A verified account email.** Without it every Workers API call fails with
  `10034: You need to verify your email address to use Workers`, and Pages project creation fails
  with `8000077`. This blocks every deploy method equally — Wrangler, CI and dashboard alike.
- **A `workers.dev` subdomain**, if you want a `*.workers.dev` URL. Absent one, the API answers
  `10007`.

## Built with

[MCP TypeScript SDK v2](https://github.com/modelcontextprotocol/typescript-sdk) ·
[Cloudflare Workers](https://workers.cloudflare.com/) ·
[webstatus.dev](https://webstatus.dev) ·
[@mdn/browser-compat-data](https://github.com/mdn/browser-compat-data) ·
[web-features](https://github.com/web-platform-dx/web-features)

The server uses `createMcpHandler`, which returns a web-standard `{ fetch }` object and serves
requests statelessly — so there is no Durable Object, no KV, and no session affinity. Any isolate
can answer any request.

## License

MIT
