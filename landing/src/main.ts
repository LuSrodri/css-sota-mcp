/**
 * Landing page behaviour: the live audit demo, the connect snippets, and the
 * copy buttons.
 */

import './styles.css';
import { McpClient, McpClientError } from './mcp-client.js';

/**
 * Where the deployed server lives.
 *
 * Overridable at build time so a preview deployment can point the demo at a
 * preview Worker instead of production.
 */
const MCP_ORIGIN = import.meta.env.VITE_MCP_ORIGIN ?? 'https://css-sota-mcp.lusrodri.workers.dev';
const MCP_ENDPOINT = `${MCP_ORIGIN}/mcp`;

const DEFAULT_SOURCE = `.card:has(> img) {
  anchor-name: --card;
  color: color-mix(in oklch, canvastext, blue 20%);
  display: grid;
}

@container (width > 40em) {
  .card { text-wrap: balance; }
}`;

/** The structured half of an `audit_css` result. */
interface AuditResult {
  target: string;
  featuresChecked: number;
  failing: number;
  unknown: number;
  findings: Array<{
    key: string;
    kind: string;
    name: string;
    line: number;
    occurrences: number;
    status: 'pass' | 'fail' | 'unknown';
    reasons: string[];
  }>;
}

function el<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing element: ${selector}`);
  return node;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}

/* ---------- Endpoint and connect snippets ---------- */

function fillSnippets(): void {
  el<HTMLInputElement>('#endpoint-url').value = MCP_ENDPOINT;

  el('#snippet-cc').textContent = `claude mcp add --transport http css-sota ${MCP_ENDPOINT}`;

  el('#snippet-json').textContent = JSON.stringify(
    { mcpServers: { 'css-sota': { type: 'http', url: MCP_ENDPOINT } } },
    null,
    2,
  );

  el('#snippet-play').textContent = MCP_ENDPOINT;
  el('#snippet-insp').textContent = `npx @modelcontextprotocol/inspector@latest`;
}

/* ---------- Copy buttons ---------- */

async function copy(text: string, button: HTMLButtonElement): Promise<void> {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Press ⌘C';
  }
  setTimeout(() => {
    button.textContent = original;
  }, 1600);
}

function wireCopyButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
    button.addEventListener('click', () => {
      const target = document.querySelector<HTMLInputElement>(button.dataset.copy!);
      if (target) void copy(target.value, button);
    });
  }
}

/* ---------- Tabs ---------- */

function wireTabs(): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tab')];

  const select = (tab: HTMLButtonElement) => {
    for (const other of tabs) {
      const selected = other === tab;
      other.setAttribute('aria-selected', String(selected));
      const panel = document.getElementById(other.getAttribute('aria-controls')!);
      if (panel) panel.hidden = !selected;
    }
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const next = tabs[(index + step + tabs.length) % tabs.length]!;
      select(next);
      next.focus();
    });
  });
}

/* ---------- The live demo ---------- */

const client = new McpClient(MCP_ENDPOINT);

function renderAudit(result: AuditResult): string {
  const failures = result.findings.filter((finding) => finding.status !== 'pass');
  const state = result.failing > 0 ? 'fail' : 'pass';
  const mark = result.failing > 0 ? '✕' : '✓';

  const headline =
    result.failing > 0
      ? `${result.failing} of ${result.featuresChecked} features fall short`
      : `All ${result.featuresChecked} features meet the target`;

  const items = failures
    .slice(0, 6)
    .map(
      (finding) => `
        <li class="finding">
          <p class="finding__head">
            <span class="finding__line">line ${finding.line}</span>
            <span class="finding__name">${escapeHtml(finding.name)}</span>
          </p>
          <ul class="finding__reasons">
            ${finding.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}
          </ul>
        </li>`,
    )
    .join('');

  return `
    <p class="verdict">
      <span class="verdict__mark" data-state="${state}">${mark}</span>
      <span>${escapeHtml(headline)} for <strong>${escapeHtml(result.target)}</strong></span>
    </p>
    ${items ? `<ul class="findings">${items}</ul>` : ''}
  `;
}

function message(text: string): string {
  return `<p class="demo__msg">${escapeHtml(text)}</p>`;
}

async function runAudit(): Promise<void> {
  const status = el('#demo-status');
  const out = el('#demo-out');
  const button = el<HTMLButtonElement>('#demo-run');

  button.disabled = true;
  status.textContent = 'Calling audit_css…';

  try {
    const result = await client.callTool<AuditResult>('audit_css', {
      source: el<HTMLTextAreaElement>('#demo-source').value,
      target: el<HTMLInputElement>('#demo-target').value,
    });

    if (result.isError || !result.structuredContent) {
      out.innerHTML = message(
        result.content?.[0]?.text ?? 'The server could not audit that input.',
      );
      status.textContent = 'Returned an error';
      return;
    }

    out.innerHTML = renderAudit(result.structuredContent);
    status.textContent = 'Live from the server';
  } catch (error) {
    // The demo is the product working. If it cannot reach the server, say so
    // plainly rather than showing a canned result that pretends otherwise.
    const detail =
      error instanceof McpClientError
        ? error.message
        : 'Could not reach the server. It may not be deployed yet.';
    out.innerHTML = message(`${detail} The endpoint above is still the one to connect to.`);
    status.textContent = 'Unavailable';
  } finally {
    button.disabled = false;
  }
}

function wireDemo(): void {
  el<HTMLTextAreaElement>('#demo-source').value = DEFAULT_SOURCE;
  el('#demo-run').addEventListener('click', () => void runAudit());

  for (const chip of document.querySelectorAll<HTMLButtonElement>('[data-target]')) {
    chip.addEventListener('click', () => {
      el<HTMLInputElement>('#demo-target').value = chip.dataset.target!;
      void runAudit();
    });
  }

  void runAudit();
}

/* ---------- Data provenance ---------- */

async function loadDataMeta(): Promise<void> {
  const node = el('#data-versions');
  try {
    const response = await fetch(`${MCP_ORIGIN}/health`);
    if (!response.ok) throw new Error(String(response.status));
    const health = (await response.json()) as {
      data?: { bcdVersion?: string; webFeaturesVersion?: string; bcdKeys?: number; features?: number };
    };
    const data = health.data;
    if (!data) throw new Error('no data');

    node.textContent =
      `browser-compat-data ${data.bcdVersion} · web-features ${data.webFeaturesVersion} · ` +
      `${data.bcdKeys?.toLocaleString()} compat keys · ${data.features} features`;
  } catch {
    node.textContent = 'Version info loads from the running server.';
  }
}

fillSnippets();
wireCopyButtons();
wireTabs();
wireDemo();
void loadDataMeta();
