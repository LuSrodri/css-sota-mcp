/**
 * Compacts the CSS slice of `@mdn/browser-compat-data` and `web-features` into
 * the small JSON bundles the Worker imports at build time.
 *
 * Shipping either package whole is not an option: BCD alone unpacks to ~20 MB,
 * well past a Worker's bundle budget. The CSS subtree is ~3.8 MB of raw JSON,
 * and dropping the fields the server never reads (notes, `source_file`, release
 * metadata, non-CSS trees) brings it to ~1 MB — about 120 KB gzipped.
 *
 * Output lands in `src/data/generated/` and is gitignored; every build, test
 * and deploy regenerates it so the data tracks whatever version npm resolved.
 *
 * Run with: npm run build:data --workspace mcp
 */

import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const bcd = require('@mdn/browser-compat-data');
const { features } = require('web-features');

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'generated');

/**
 * Reads a dependency's declared version.
 *
 * Neither package exposes `./package.json` through its `exports` map, so the
 * manifest is located by walking up from the resolved entry point rather than
 * required directly.
 *
 * @param {string} specifier
 * @returns {Promise<string>}
 */
async function packageVersion(specifier) {
  let dir = dirname(require.resolve(specifier));
  const { root } = parse(dir);
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      if (manifest.name === specifier) return manifest.version;
    } catch {
      // Not this directory; keep walking up.
    }
    if (dir === root) throw new Error(`Could not locate package.json for ${specifier}`);
    dir = dirname(dir);
  }
}

/** Must stay in sync with `BROWSERS` in `src/data/schema.ts`. */
const BROWSERS = [
  'chrome',
  'chrome_android',
  'edge',
  'firefox',
  'firefox_android',
  'safari',
  'safari_ios',
  'opera',
  'opera_android',
  'samsunginternet_android',
  'webview_android',
  'ie',
];

const MDN_PREFIX = 'https://developer.mozilla.org/docs/';
const WEB_FEATURES_TAG = 'web-features:';

/**
 * Collects every node under `css.*` that carries a `__compat` block, keyed by
 * its dotted BCD path (`css.properties.display.flex`).
 *
 * @param {Record<string, unknown>} node
 * @param {string} path
 * @param {Map<string, any>} out
 */
function collectCompatNodes(node, path, out) {
  for (const [key, value] of Object.entries(node)) {
    if (key === '__compat') {
      out.set(path, value);
      continue;
    }
    if (value && typeof value === 'object') {
      collectCompatNodes(value, path ? `${path}.${key}` : key, out);
    }
  }
}

/**
 * Encodes BCD's per-browser support into the positional tuple documented in
 * `src/data/schema.ts`.
 *
 * BCD may list several support statements per browser (newest first); only the
 * first is kept, since that is the one describing current behaviour. Support
 * that exists solely behind a flag is encoded as unsupported — a flag is not
 * something a site can ship.
 *
 * @param {Record<string, any> | undefined} support
 * @returns {(string | 0)[]}
 */
function encodeSupport(support) {
  return BROWSERS.map((browser) => {
    const statement = support?.[browser];
    if (!statement) return 0;

    const current = Array.isArray(statement) ? statement[0] : statement;
    const added = current.version_added;
    if (added === false || added == null) return 0;
    if (Array.isArray(current.flags) && current.flags.length > 0) return 0;

    const version = added === true ? '1' : String(added);
    const qualifiers = [];
    if (current.version_removed) qualifiers.push(`-${current.version_removed}`);
    if (current.prefix) qualifiers.push(`p:${current.prefix}`);
    if (current.alternative_name) qualifiers.push(`a:${current.alternative_name}`);
    if (current.partial_implementation) qualifiers.push('~');

    return qualifiers.length > 0 ? `${version}|${qualifiers.join('|')}` : version;
  });
}

/** @param {unknown} value */
function firstUrl(value) {
  return Array.isArray(value) ? value[0] : value;
}

function buildBcdIndex() {
  const nodes = new Map();
  collectCompatNodes(bcd.css, 'css', nodes);

  /** @type {Record<string, any>} */
  const index = {};
  for (const [path, compat] of nodes) {
    /** @type {any} */
    const entry = { s: encodeSupport(compat.support) };

    if (compat.mdn_url) entry.u = String(compat.mdn_url).replace(MDN_PREFIX, '');

    const tag = (compat.tags ?? []).find((t) => t.startsWith(WEB_FEATURES_TAG));
    if (tag) entry.f = tag.slice(WEB_FEATURES_TAG.length);

    if (compat.status?.deprecated) entry.d = 1;
    if (compat.status?.experimental) entry.x = 1;

    const spec = firstUrl(compat.spec_url);
    if (spec) entry.p = spec;

    index[path] = entry;
  }
  return index;
}

/**
 * Translates `web-features`' Baseline encoding into the dashboard's vocabulary.
 *
 * The npm package says `"high"` / `"low"` / `false`, while api.webstatus.dev and
 * every piece of Baseline documentation say `widely` / `newly` / `limited`.
 * Normalising here means the two halves of the server never disagree about what
 * a status is called.
 *
 * @param {'high' | 'low' | false | undefined} baseline
 * @returns {'widely' | 'newly' | 'limited'}
 */
function normalizeBaseline(baseline) {
  if (baseline === 'high') return 'widely';
  if (baseline === 'low') return 'newly';
  return 'limited';
}

function buildFeatureIndex() {
  /** @type {Record<string, any>} */
  const index = {};

  for (const [id, feature] of Object.entries(features)) {
    // `kind: 'moved'` / `'split'` entries are redirects to a renamed feature,
    // not features in their own right — they carry no status or compat data.
    if (feature.kind && feature.kind !== 'feature') continue;

    const groups = Array.isArray(feature.group)
      ? feature.group
      : feature.group
        ? [feature.group]
        : [];
    const cssCompat = (feature.compat_features ?? []).filter((key) => key.startsWith('css.'));

    // A feature counts as CSS if it is filed under a CSS group or touches any
    // `css.*` compat key. The group check alone misses cross-cutting features
    // like anchor positioning, which carry no group but are pure CSS.
    const isCss = cssCompat.length > 0 || groups.some((g) => g === 'css' || g.startsWith('css-'));
    if (!isCss) continue;

    /** @type {any} */
    const entry = {
      n: feature.name,
      g: groups,
      c: cssCompat,
      s: normalizeBaseline(feature.status?.baseline),
    };

    if (feature.description) entry.d = feature.description;
    if (feature.status?.baseline_low_date) entry.l = feature.status.baseline_low_date;
    if (feature.status?.baseline_high_date) entry.h = feature.status.baseline_high_date;
    if (feature.spec) entry.p = feature.spec;
    if (feature.caniuse) entry.ci = feature.caniuse;

    index[id] = entry;
  }
  return index;
}

/**
 * @param {string} name
 * @param {unknown} value
 */
async function emit(name, value) {
  const json = JSON.stringify(value);
  await writeFile(join(OUT_DIR, name), json, 'utf8');
  const raw = (json.length / 1024).toFixed(0);
  const gz = (gzipSync(json).length / 1024).toFixed(0);
  console.log(`  ${name.padEnd(18)} ${raw.padStart(5)} KB  (${gz} KB gzipped)`);
  return json.length;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const bcdIndex = buildBcdIndex();
  const featureIndex = buildFeatureIndex();

  /** @type {import('../src/data/schema.ts').DataMeta} */
  const meta = {
    generatedAt: new Date().toISOString(),
    bcdVersion: bcd.__meta?.version ?? (await packageVersion('@mdn/browser-compat-data')),
    webFeaturesVersion: await packageVersion('web-features'),
    bcdKeys: Object.keys(bcdIndex).length,
    features: Object.keys(featureIndex).length,
  };

  console.log(`css-sota-mcp data build`);
  console.log(`  @mdn/browser-compat-data ${meta.bcdVersion}, web-features ${meta.webFeaturesVersion}`);

  await emit('bcd-css.json', bcdIndex);
  await emit('features-css.json', featureIndex);
  await emit('meta.json', meta);

  console.log(`  ${meta.bcdKeys} BCD keys, ${meta.features} CSS features`);

  // A silent drop to near-zero keys would mean an upstream restructure quietly
  // gutted the dataset, and the server would still deploy and answer wrongly.
  if (meta.bcdKeys < 2000 || meta.features < 200) {
    throw new Error(
      `Generated data looks truncated (${meta.bcdKeys} BCD keys, ${meta.features} features). ` +
        `Upstream layout may have changed.`,
    );
  }
}

await main();
