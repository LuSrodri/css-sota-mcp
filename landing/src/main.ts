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

  // `--scope user` is the point of the line. Without it `claude mcp add`
  // defaults to local scope, which registers the server in whichever project
  // the terminal happened to be in — so the reader copies the command, it
  // works, and then the tools are missing from the next repo they open.
  el('#snippet-cc').textContent =
    `claude mcp add --scope user --transport http css-sota ${MCP_ENDPOINT}`;

  // Claude Desktop's config file takes local stdio servers only; a remote one
  // is added through Settings -> Connectors, which wants the bare URL.
  el('#snippet-desktop').textContent = MCP_ENDPOINT;

  el('#snippet-play').textContent = MCP_ENDPOINT;
  el('#snippet-insp').textContent = `npx @modelcontextprotocol/inspector@latest`;
}

/* ---------- Copy buttons ---------- */

/** Spoken confirmation. The button's own label change is not announced. */
function announce(text: string): void {
  const status = document.getElementById('copy-status');
  if (status) status.textContent = text;
}

/** Reads what a copy target holds, whether it is a field or a code block. */
function textOf(node: Element): string {
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
    ? node.value
    : (node.textContent ?? '');
}

/**
 * Falls back to selecting the text when the clipboard is unavailable — over
 * plain HTTP, or with the permission denied. Selecting it leaves the reader one
 * keystroke away instead of one retype away, and the shortcut is not named
 * because it differs per platform.
 */
function selectText(node: Element): void {
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
    node.select();
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

async function copy(target: Element, button: HTMLButtonElement): Promise<void> {
  const label = button.querySelector('[aria-hidden="true"]') ?? button;
  const original = label.textContent;

  try {
    await navigator.clipboard.writeText(textOf(target));
    label.textContent = 'Copied';
    button.dataset.state = 'done';
    announce('Copied to clipboard.');
  } catch {
    selectText(target);
    label.textContent = 'Select';
    announce('The clipboard is unavailable. The text is selected — copy it with your keyboard.');
  }

  setTimeout(() => {
    label.textContent = original;
    delete button.dataset.state;
  }, 1600);
}

function wireCopyButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
    button.addEventListener('click', () => {
      const target = document.querySelector(button.dataset.copy!);
      if (target) void copy(target, button);
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
