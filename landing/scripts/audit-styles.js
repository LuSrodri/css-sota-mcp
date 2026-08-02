/**
 * Audits this site's own stylesheet with the server it advertises.
 *
 * The landing page claims to be built only from CSS you can actually ship. The
 * first version of it shipped `text-wrap: pretty`, which is Limited
 * availability — precisely the mistake `audit_css` exists to catch, made on the
 * page selling the tool. Asserting the claim in a comment was not enough, so
 * this checks it.
 *
 * The bar is Baseline **newly**, not widely, and that is deliberate: the page
 * is a demonstration of current CSS and says so. What it must not contain is
 * anything below that line — a feature at Limited availability is broken in at
 * least one major engine for a real share of visitors.
 *
 * Usage: node scripts/audit-styles.js [mcp-endpoint]
 *   default http://127.0.0.1:8787/mcp — CI points this at the Worker it booted,
 *   so the check has no dependency on the deployed instance being up.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const endpoint = process.argv[2] ?? 'http://127.0.0.1:8787/mcp';
const stylesheet = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles.css');

/**
 * Findings that are correct but accepted, keyed by BCD key.
 *
 * A gate with no escape hatch is a gate that gets deleted the first time it is
 * inconvenient. These are not suppressed false positives — the data behind each
 * one is right, and checking it is how each entry got written. What is recorded
 * here is the decision to ship anyway, and why. Anything not listed still fails.
 */
const ACCEPTED = {
  'css.properties.cursor':
    'Unsupported on iOS Safari, which is why the feature is Limited. A pointer cursor on a ' +
    'touch device is meaningless rather than broken, and dropping it would degrade desktop for ' +
    'no mobile gain.',
  'css.properties.cursor.pointer': 'Same as css.properties.cursor.',
  'css.properties.resize':
    'Unsupported on iOS Safari and removed in Firefox Android 79. The textarea is fully usable ' +
    'without it — resizing is an affordance, not a requirement — and field-sizing now grows the ' +
    'box automatically where it is supported.',
};

const PROTOCOL_VERSION = '2025-06-18';
let nextId = 1;

/** Sends one JSON-RPC message, handling both JSON and SSE reply shapes. */
async function rpc(method, params, { expectResponse = true } = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...(expectResponse ? { id: nextId++ } : {}), method, params }),
  });

  if (!response.ok) throw new Error(`${method} -> HTTP ${response.status}`);
  if (!expectResponse) return undefined;

  const text = await response.text();
  const payload = text.includes('data:')
    ? text
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .at(-1)
    : text;

  const message = JSON.parse(payload);
  if (message.error) throw new Error(`${method} -> ${message.error.message}`);
  return message.result;
}

async function main() {
  const source = await readFile(stylesheet, 'utf8');
  console.log(`Auditing landing/src/styles.css (${(source.length / 1024).toFixed(1)} KB) via ${endpoint}`);

  await rpc('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'css-sota-landing-audit', version: '1.0.0' },
  });
  await rpc('notifications/initialized', {}, { expectResponse: false });

  const result = await rpc('tools/call', {
    name: 'audit_css',
    arguments: { source, target: 'baseline-newly' },
  });

  const audit = result?.structuredContent;
  if (!audit) throw new Error(`audit_css returned no structured content`);

  console.log(`  ${audit.featuresChecked} features checked against ${audit.target}`);

  const failing = audit.findings.filter((finding) => finding.status === 'fail');
  const accepted = failing.filter((finding) => finding.key in ACCEPTED);
  const blocking = failing.filter((finding) => !(finding.key in ACCEPTED));

  if (accepted.length > 0) {
    console.log(`\n  ${accepted.length} accepted exception(s):`);
    for (const finding of accepted) {
      console.log(`    ${finding.name} (${finding.kind}) — ${ACCEPTED[finding.key]}`);
    }
  }

  // An entry that no longer matches anything is stale: the CSS that justified
  // it is gone, or upstream reclassified the feature. Either way the note is
  // now lying, so say so rather than letting it rot.
  const matched = new Set(failing.map((finding) => finding.key));
  const stale = Object.keys(ACCEPTED).filter((key) => !matched.has(key));
  if (stale.length > 0) {
    console.log(`\n  ${stale.length} stale exception(s) — remove from ACCEPTED:`);
    for (const key of stale) console.log(`    ${key}`);
  }

  if (blocking.length === 0) {
    console.log(`\nClean — nothing unaccounted for below Baseline newly.`);
    return;
  }

  console.log(`\n${blocking.length} feature(s) below Baseline newly:\n`);
  for (const finding of blocking) {
    console.log(`  line ${finding.line}  ${finding.name} (${finding.kind})  [${finding.baseline ?? 'unknown'}]`);
    for (const reason of finding.reasons) console.log(`    ${reason}`);
  }
  console.log(
    `\nDrop them, put them behind @supports, or — if the finding is right and you are ` +
      `shipping anyway — add the key to ACCEPTED in this script with the reason.`,
  );

  process.exitCode = 1;
}

await main();
