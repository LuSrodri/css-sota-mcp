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

## Limits on the hosted endpoint

The endpoint is public and unauthenticated on purpose: every tool is read-only over public
datasets, so there is nothing to protect from disclosure. What is worth protecting is the account's
request budget and the server's standing with the upstreams it proxies.

| Limit | Value | On exceeding |
| --- | --- | --- |
| Requests per client IP | 120 / minute, per Cloudflare location | `429` with `Retry-After: 60` |
| Request body | 1 MB | `413` |
| `audit_css` source | 400 000 characters | schema validation error |

120/minute is sized against real usage rather than a round number: an agent working through a task
calls a handful of tools per turn, so a burst of twenty is unremarkable and 120 leaves room for a
shared address running several clients.

Cloudflare's own guidance prefers keying rate limits on a user or tenant id rather than an IP,
since an IP can be shared behind NAT or a privacy relay. This endpoint has no authentication and so
no such id; the limit is set generously enough that the trade is a fair one.

If you expect sustained traffic above this, run your own instance — the whole thing is one Worker
and deploys in a minute.

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

Pushing to `main` deploys both. Cloudflare builds from this repo directly — no API token is
stored in GitHub, and Cloudflare issues its own build credential.

| Target | Product | Root | Build | Deploy |
| --- | --- | --- | --- | --- |
| Worker | Workers Builds | `mcp` | `npm run build:data` | `npx wrangler deploy` |
| Landing | Pages Git integration | `landing` | `npm run build` | output `dist` |

The Worker's build command is **not** optional: `mcp/src/data/generated/` is gitignored, and
`src/data/index.ts` imports it statically, so a build that skips it fails to bundle.

Because the two are independent products, neither waits for the other. `.github/workflows/verify.yml`
covers that gap — it smoke-tests the live endpoint on a schedule and on demand.

#### Previewing a pull request

Every push to a PR branch uploads a Worker version and builds the landing site, each reachable
before merge:

| | URL |
| --- | --- |
| Worker | `https://<version-prefix>-css-sota-mcp.lusrodri.workers.dev/mcp` |
| Landing | `https://<deployment-id>.css-sota-mcp.pages.dev` |

The version prefix is in the Workers Builds log, or under **Deployments** on the Worker. Point the
[AI Playground](https://playground.ai.cloudflare.com/) or MCP Inspector at the Worker URL to try a
PR's server for real.

Two things this does *not* do. There is no stable per-branch alias and no automatic PR comment —
those need the Workers Builds preview feature, which this account cannot enable
(`12044: This account does not have access to Workers Previews`). And a landing preview always
calls **production**, since `VITE_MCP_ORIGIN` falls back to it: a PR touching both halves will show
a new front end against the old server. Set `VITE_MCP_ORIGIN` on the preview build to that PR's
Worker version if that matters for a given change.

To deploy by hand instead:

```bash
npm run deploy --workspace mcp      # Worker
npm run deploy --workspace landing  # Pages
```

Both need Cloudflare credentials — either `wrangler login`, or `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in the environment. Note that `wrangler login` needs a real terminal; in a
non-interactive shell it refuses and asks for the token variable instead.

#### Account prerequisites

Cloudflare gates Workers behind these, and the errors only surface at deploy time:

- **Workers enabled on the account.** Until the Workers & Pages dashboard has been opened once,
  every Workers API call fails with `10034: You need to verify your email address to use Workers` —
  which is misleading, since a verified email does not clear it. Opening the page does.
- **A `workers.dev` subdomain**, if you want a `*.workers.dev` URL. Absent one, the API answers
  `10007`.
- **The Cloudflare GitHub App installed**, for Git-based deploys. Without it the repository
  connection API answers `8000008`, regardless of account permissions.

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
