/**
 * Parsing and evaluation of the browser targets `audit_css` checks against.
 *
 * Two target styles are supported, because they answer different questions:
 *
 * - A **Baseline level** (`baseline-widely`, `baseline-newly`) asks "is this
 *   interoperable enough to ship?" and is judged against `web-features`'
 *   Baseline status.
 * - An **explicit browser list** (`chrome 120, safari 17.4`) asks "does this
 *   work for *my* users?" and is judged against per-browser BCD versions.
 *
 * Browserslist queries such as `last 2 versions` or `>0.5%` are deliberately
 * not accepted: resolving them needs usage data this server does not carry, and
 * silently approximating them would produce confidently wrong audits.
 */

import { BROWSERS, type BrowserId } from './data/schema.js';
import type { BcdEntry, SupportValue } from './data/schema.js';

/** Baseline levels usable as an audit target. */
export type BaselineLevel = 'newly' | 'widely';

export type Targets =
  | { kind: 'baseline'; level: BaselineLevel }
  | { kind: 'browsers'; entries: BrowserTarget[] };

/** One browser pinned to a minimum version. */
export interface BrowserTarget {
  browser: BrowserId;
  version: string;
}

/** Aliases accepted for browser ids, including the caniuse/browserslist spellings. */
const BROWSER_ALIASES: Record<string, BrowserId> = {
  chrome: 'chrome',
  chrome_android: 'chrome_android',
  'chrome-android': 'chrome_android',
  and_chr: 'chrome_android',
  android: 'chrome_android',
  edge: 'edge',
  firefox: 'firefox',
  ff: 'firefox',
  firefox_android: 'firefox_android',
  'firefox-android': 'firefox_android',
  and_ff: 'firefox_android',
  safari: 'safari',
  safari_ios: 'safari_ios',
  'safari-ios': 'safari_ios',
  ios_saf: 'safari_ios',
  ios: 'safari_ios',
  opera: 'opera',
  op: 'opera',
  opera_android: 'opera_android',
  'opera-android': 'opera_android',
  op_mob: 'opera_android',
  samsunginternet_android: 'samsunginternet_android',
  samsung: 'samsunginternet_android',
  webview_android: 'webview_android',
  'webview-android': 'webview_android',
  ie: 'ie',
  explorer: 'ie',
};

/** The browsers that decide Baseline status, per the WebDX Community Group. */
export const BASELINE_BROWSERS: BrowserId[] = [
  'chrome',
  'chrome_android',
  'edge',
  'firefox',
  'firefox_android',
  'safari',
  'safari_ios',
];

/** Decoded form of a {@link SupportValue}. */
export interface Support {
  /** First supporting version, or `null` when unsupported. */
  since: string | null;
  /** Version support was removed in, if it was. */
  removed?: string;
  /** Vendor prefix required, e.g. `-webkit-`. */
  prefix?: string;
  /** Name the feature ships under instead. */
  alternativeName?: string;
  /** Implementation is known to be incomplete. */
  partial?: boolean;
}

/** Decodes one positional entry of a `SupportTuple`. */
export function decodeSupport(value: SupportValue | undefined): Support {
  // Catches the `0` sentinel, an absent slot, and an empty string alike.
  if (!value) return { since: null };

  const [version, ...qualifiers] = value.split('|');
  const support: Support = { since: version ?? null };

  for (const qualifier of qualifiers) {
    if (qualifier === '~') support.partial = true;
    else if (qualifier.startsWith('p:')) support.prefix = qualifier.slice(2);
    else if (qualifier.startsWith('a:')) support.alternativeName = qualifier.slice(2);
    else if (qualifier.startsWith('-')) support.removed = qualifier.slice(1);
  }

  return support;
}

/** Decodes a whole compat entry into a per-browser map. */
export function decodeEntry(entry: BcdEntry): Record<BrowserId, Support> {
  const result = {} as Record<BrowserId, Support>;
  BROWSERS.forEach((browser, index) => {
    result[browser] = decodeSupport(entry.s[index]);
  });
  return result;
}

/**
 * Compares two browser version strings numerically, segment by segment.
 *
 * Browser versions are dotted numbers (`17.5`, `2.0`, `126`) rather than
 * semver, so a plain numeric comparison per segment is both correct and enough.
 * Non-numeric segments compare as 0, which keeps odd values like BCD's
 * `"≤37"` — already normalised away at build time — from throwing.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i++) {
    const x = Number.parseFloat(left[i] ?? '0');
    const y = Number.parseFloat(right[i] ?? '0');
    const xn = Number.isNaN(x) ? 0 : x;
    const yn = Number.isNaN(y) ? 0 : y;
    if (xn !== yn) return xn < yn ? -1 : 1;
  }
  return 0;
}

/**
 * Parses a target string.
 *
 * @throws {TargetParseError} when nothing in the input is recognisable.
 */
export function parseTargets(input: string): Targets {
  const trimmed = input.trim();
  if (!trimmed) throw new TargetParseError('Target is empty.');

  const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
  if (/^(baseline[- ])?widely( available)?$/.test(normalized)) {
    return { kind: 'baseline', level: 'widely' };
  }
  if (/^(baseline[- ])?newly( available)?$/.test(normalized)) {
    return { kind: 'baseline', level: 'newly' };
  }
  if (normalized === 'baseline') {
    // Bare "baseline" is ambiguous; Widely is the conservative reading.
    return { kind: 'baseline', level: 'widely' };
  }

  const entries: BrowserTarget[] = [];
  const unknown: string[] = [];

  for (const part of trimmed.split(/[,;]/)) {
    const piece = part.trim();
    if (!piece) continue;

    const match = /^([a-zA-Z_][a-zA-Z_-]*)\s*(?:>=|>|\s)\s*v?(\d[\d.]*)$/.exec(piece);
    if (!match) {
      unknown.push(piece);
      continue;
    }

    const browser = BROWSER_ALIASES[match[1]!.toLowerCase()];
    if (!browser) {
      unknown.push(piece);
      continue;
    }

    entries.push({ browser, version: match[2]! });
  }

  if (entries.length === 0) {
    throw new TargetParseError(
      `Could not parse any browser target from ${JSON.stringify(trimmed)}. ` +
        `Use a Baseline level ("baseline-widely", "baseline-newly") or a list of ` +
        `browser/version pairs ("chrome 120, safari 17.4, firefox 128"). ` +
        `Browserslist queries like "last 2 versions" are not supported.`,
    );
  }

  if (unknown.length > 0) {
    throw new TargetParseError(
      `Unrecognised target${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => JSON.stringify(u)).join(', ')}. ` +
        `Expected "<browser> <version>", e.g. "safari 17.4". ` +
        `Known browsers: ${[...new Set(Object.values(BROWSER_ALIASES))].join(', ')}.`,
    );
  }

  return { kind: 'browsers', entries };
}

/** Raised when a target string cannot be interpreted. */
export class TargetParseError extends Error {
  override readonly name = 'TargetParseError';
}

/** Why a browser fails a target. */
export type FailureReason = 'unsupported' | 'too-old' | 'removed' | 'prefix-only' | 'partial';

/** One browser's verdict against its target version. */
export interface BrowserVerdict {
  browser: BrowserId;
  targetVersion: string;
  support: Support;
  reason?: FailureReason;
}

/**
 * Checks one compat entry against an explicit browser list.
 *
 * `prefix-only` and `partial` are reported as failures because both mean the
 * feature does not work as written — but they are distinguished from outright
 * absence so the caller can present them as the softer problems they are.
 */
export function checkBrowserTargets(entry: BcdEntry, entries: BrowserTarget[]): BrowserVerdict[] {
  const support = decodeEntry(entry);

  return entries.map(({ browser, version }) => {
    const browserSupport = support[browser];
    const verdict: BrowserVerdict = { browser, targetVersion: version, support: browserSupport };

    if (browserSupport.since === null) {
      verdict.reason = 'unsupported';
      return verdict;
    }
    if (compareVersions(version, browserSupport.since) < 0) {
      verdict.reason = 'too-old';
      return verdict;
    }
    if (browserSupport.removed && compareVersions(version, browserSupport.removed) >= 0) {
      verdict.reason = 'removed';
      return verdict;
    }
    if (browserSupport.prefix) {
      verdict.reason = 'prefix-only';
      return verdict;
    }
    if (browserSupport.partial) {
      verdict.reason = 'partial';
      return verdict;
    }
    return verdict;
  });
}

/** Human-readable label for the browsers in a target list. */
export function describeTargets(targets: Targets): string {
  if (targets.kind === 'baseline') return `Baseline ${targets.level} available`;
  return targets.entries.map((t) => `${t.browser} ${t.version}`).join(', ');
}
