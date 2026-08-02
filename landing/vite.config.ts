import { defineConfig } from 'vite';

/** Branch that Pages treats as production. */
const PRODUCTION_BRANCH = 'main';

/** Worker name and workers.dev subdomain the preview aliases are built from. */
const WORKER = 'css-sota-mcp';
const SUBDOMAIN = 'lusrodri';

/**
 * Turns a Git branch name into the preview alias Cloudflare derives from it.
 *
 * Verified against a real branch: `chore/pin-preview-urls` serves at
 * `chore-pin-preview-urls-css-sota-mcp.lusrodri.workers.dev`. Aliases are
 * documented as lowercase letters, numbers and dashes only, so every other
 * character collapses to a dash.
 */
function branchAlias(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Picks the MCP endpoint this build should talk to.
 *
 * A preview of the landing page that calls *production* is a trap: a pull
 * request touching both halves shows a new front end against the old server,
 * looks green, and breaks on merge. Since Workers Builds gives every branch a
 * stable Worker alias, a preview build can point at its own branch's server.
 *
 * An explicit `VITE_MCP_ORIGIN` always wins, so local development and one-off
 * builds keep working. Production builds get nothing here and fall through to
 * the default in `main.ts`.
 *
 * The alias is derived, not looked up, so a mismatch would point the demo at a
 * URL that 404s. That fails visibly rather than silently: the endpoint is
 * printed on the page, and the hero demo reports it could not reach the server.
 */
function resolveMcpOrigin(): string | undefined {
  if (process.env.VITE_MCP_ORIGIN) return process.env.VITE_MCP_ORIGIN;

  // Set by Cloudflare Pages builds. Empty everywhere else.
  const branch = process.env.CF_PAGES_BRANCH;
  if (!branch || branch === PRODUCTION_BRANCH) return undefined;

  const alias = branchAlias(branch);
  if (!alias) return undefined;

  return `https://${alias}-${WORKER}.${SUBDOMAIN}.workers.dev`;
}

export default defineConfig(() => {
  const mcpOrigin = resolveMcpOrigin();

  if (process.env.CF_PAGES_BRANCH) {
    // Shows up in the Pages build log, which is the only place to confirm what
    // a preview actually wired itself to.
    console.log(
      `[css-sota] branch=${process.env.CF_PAGES_BRANCH} -> MCP origin ${mcpOrigin ?? '(production default)'}`,
    );
  }

  return {
    build: {
      outDir: 'dist',
      target: 'es2022',
    },
    ...(mcpOrigin
      ? { define: { 'import.meta.env.VITE_MCP_ORIGIN': JSON.stringify(mcpOrigin) } }
      : {}),
  };
});
