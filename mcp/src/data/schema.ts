/**
 * Shape of the data bundled into the Worker by `scripts/build-data.ts`.
 *
 * The upstream sources are far too large to ship whole (`@mdn/browser-compat-data`
 * alone unpacks to ~20 MB), so the build compacts the CSS slice of both datasets
 * into the terse structures below — roughly 1 MB of JSON, ~120 KB gzipped.
 * Field names are single letters for the same reason.
 */

/**
 * Browser keys, in the order used by every `SupportTuple`.
 *
 * Positional encoding keeps the generated JSON small; index into this array to
 * translate a tuple slot back into a browser id.
 */
export const BROWSERS = [
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
] as const;

export type BrowserId = (typeof BROWSERS)[number];

/** Human-facing browser names, keyed by {@link BrowserId}. */
export const BROWSER_LABELS: Record<BrowserId, string> = {
  chrome: 'Chrome',
  chrome_android: 'Chrome Android',
  edge: 'Edge',
  firefox: 'Firefox',
  firefox_android: 'Firefox Android',
  safari: 'Safari',
  safari_ios: 'Safari iOS',
  opera: 'Opera',
  opera_android: 'Opera Android',
  samsunginternet_android: 'Samsung Internet',
  webview_android: 'WebView Android',
  ie: 'Internet Explorer',
};

/**
 * Support for one browser, positionally aligned with {@link BROWSERS}.
 *
 * `0` means "not supported, or supported only behind a flag" — the build treats
 * flagged support as unsupported because a flag is not something you can ship.
 * Otherwise it is the first supporting version, optionally followed by
 * pipe-separated qualifiers:
 *
 * - `-<version>` — support was removed in that version
 * - `p:<prefix>` — requires a vendor prefix, e.g. `p:-webkit-`
 * - `a:<name>` — shipped under an alternative name
 * - `~` — partial implementation
 *
 * So `"9|p:-webkit-"` reads as "since version 9, prefixed with `-webkit-`".
 */
export type SupportValue = string | 0;
export type SupportTuple = SupportValue[];

/** One node of browser-compat-data's `css.*` tree that carries compat info. */
export interface BcdEntry {
  /** Per-browser support, aligned with {@link BROWSERS}. */
  s: SupportTuple;
  /** MDN docs path, relative to `https://developer.mozilla.org/docs/`. */
  u?: string;
  /** The `web-features` id this key belongs to, from BCD's `web-features:` tag. */
  f?: string;
  /** Deprecated. */
  d?: 1;
  /** Experimental. */
  x?: 1;
  /** Specification URL. */
  p?: string;
}

/** BCD key (e.g. `css.properties.text-wrap-style`) to its compat entry. */
export type BcdIndex = Record<string, BcdEntry>;

/** Baseline status as reported by `web-features`. */
export type BaselineStatus = 'limited' | 'newly' | 'widely';

/** One CSS-relevant entry from the `web-features` catalog. */
export interface FeatureEntry {
  /** Display name, e.g. `"Container style queries"`. */
  n: string;
  /** Prose description. */
  d?: string;
  /** Group ids the feature belongs to. */
  g: string[];
  /** The `css.*` BCD keys this feature covers. */
  c: string[];
  /** Baseline status. */
  s: BaselineStatus;
  /** Date the feature became Baseline Newly available (`YYYY-MM-DD`). */
  l?: string;
  /** Date the feature became Baseline Widely available (`YYYY-MM-DD`). */
  h?: string;
  /** Specification URL(s). */
  p?: string | string[];
  /** caniuse.com id(s), when the feature maps to one. */
  ci?: string | string[];
}

/** `web-features` id (e.g. `container-queries`) to its entry. */
export type FeatureIndex = Record<string, FeatureEntry>;

/** Provenance for the generated bundle, surfaced by the `/health` endpoint. */
export interface DataMeta {
  /** ISO timestamp of the build that produced the bundle. */
  generatedAt: string;
  /** Version of `@mdn/browser-compat-data` the BCD index came from. */
  bcdVersion: string;
  /** Version of `web-features` the feature index came from. */
  webFeaturesVersion: string;
  /** Number of BCD keys in the index. */
  bcdKeys: number;
  /** Number of CSS features in the index. */
  features: number;
}
