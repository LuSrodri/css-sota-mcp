/**
 * Typed access to the generated CSS data bundles, plus the reverse indexes the
 * tools need.
 *
 * The JSON is imported statically so it is inlined into the Worker bundle at
 * build time — there is no filesystem to read from at runtime. Derived indexes
 * are built lazily on first use and memoised for the life of the isolate, which
 * keeps cold starts cheap for requests that never touch them.
 */

import bcdJson from './generated/bcd-css.json';
import featuresJson from './generated/features-css.json';
import metaJson from './generated/meta.json';
import { BROWSERS, type BcdEntry, type BcdIndex, type DataMeta, type FeatureEntry, type FeatureIndex } from './schema.js';

export const bcdIndex = bcdJson as unknown as BcdIndex;
export const featureIndex = featuresJson as unknown as FeatureIndex;
export const dataMeta = metaJson as unknown as DataMeta;

/** Lazily-built, memoised derived index. */
function memo<T>(build: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= build());
}

/**
 * Last path segment of every `css.types.*` key to its full key(s).
 *
 * Value functions are filed inconsistently in BCD — `css.types.clamp` sits at
 * the top level while `color-mix` is `css.types.color.color-mix` and
 * `linear-gradient` is `css.types.gradient.linear-gradient` — so resolving a
 * function name means searching by leaf rather than guessing a path.
 */
const typeKeysByName = memo(() => {
  const byName = new Map<string, string[]>();
  for (const key of Object.keys(bcdIndex)) {
    if (!key.startsWith('css.types.')) continue;
    const leaf = key.slice(key.lastIndexOf('.') + 1);
    const existing = byName.get(leaf);
    if (existing) existing.push(key);
    else byName.set(leaf, [key]);
  }
  return byName;
});

/** `web-features` id to the CSS BCD keys it covers, for feature-level rollups. */
const featureIdByBcdKey = memo(() => {
  const byKey = new Map<string, string>();
  for (const [key, entry] of Object.entries(bcdIndex)) {
    if (entry.f) byKey.set(key, entry.f);
  }
  return byKey;
});

/** Lowercased feature name and id, for fuzzy `get_feature` lookups. */
const featureIdsByLowerName = memo(() => {
  const byName = new Map<string, string>();
  for (const [id, feature] of Object.entries(featureIndex)) {
    byName.set(id.toLowerCase(), id);
    byName.set(feature.n.toLowerCase(), id);
  }
  return byName;
});

/** Returns the compat entry for an exact BCD key, if the bundle has one. */
export function getBcdEntry(key: string): BcdEntry | undefined {
  return bcdIndex[key];
}

/** Returns the `web-features` entry for an exact feature id. */
export function getFeature(id: string): FeatureEntry | undefined {
  return featureIndex[id];
}

/**
 * Resolves a user-supplied feature reference to a canonical id.
 *
 * Accepts the id itself, the display name, or either with different casing and
 * separators — `"Container Queries"`, `"container-queries"` and
 * `"container queries"` all land on the same feature.
 */
export function resolveFeatureId(input: string): string | undefined {
  const trimmed = input.trim();
  if (featureIndex[trimmed]) return trimmed;

  const lower = trimmed.toLowerCase();
  const direct = featureIdsByLowerName().get(lower);
  if (direct) return direct;

  const dashed = lower.replace(/\s+/g, '-');
  return featureIdsByLowerName().get(dashed);
}

/** The `web-features` id owning a BCD key, if any. */
export function featureIdForBcdKey(key: string): string | undefined {
  return featureIdByBcdKey().get(key);
}

/**
 * Resolves a CSS value function name to its BCD key.
 *
 * When a name is filed in several places (rare, but `color()` exists as both a
 * type and a nested colour function) the shortest key wins, which is the more
 * general entry.
 */
export function resolveFunctionKey(name: string): string | undefined {
  const candidates = typeKeysByName().get(name.toLowerCase());
  if (!candidates || candidates.length === 0) return undefined;
  return [...candidates].sort((a, b) => a.length - b.length)[0];
}

/** Resolves a selector name (with or without leading colons) to its BCD key. */
export function resolveSelectorKey(name: string): string | undefined {
  const bare = name.replace(/^::?/, '').toLowerCase();
  const key = `css.selectors.${bare}`;
  return bcdIndex[key] ? key : undefined;
}

/** Resolves an at-rule name (with or without leading `@`) to its BCD key. */
export function resolveAtRuleKey(name: string): string | undefined {
  const bare = name.replace(/^@/, '').toLowerCase();
  const key = `css.at-rules.${bare}`;
  return bcdIndex[key] ? key : undefined;
}

/**
 * Resolves a property, optionally with a value, to its BCD key.
 *
 * With a value, the per-value key (`css.properties.display.flex`) is preferred
 * and the property key is the fallback — BCD only tracks values that diverged
 * from their property's own support.
 */
export function resolvePropertyKey(property: string, value?: string): string | undefined {
  const prop = property.trim().toLowerCase();

  // Every `--x` declaration is the same platform feature; BCD files them all
  // under one key rather than one per author-chosen name.
  if (prop.startsWith('--')) {
    return bcdIndex['css.properties.custom-property'] ? 'css.properties.custom-property' : undefined;
  }

  const propertyKey = `css.properties.${prop}`;

  if (value) {
    const ident = value.trim().toLowerCase();
    const valueKey = `${propertyKey}.${ident}`;
    if (bcdIndex[valueKey]) return valueKey;
  }

  return bcdIndex[propertyKey] ? propertyKey : undefined;
}

/**
 * Finds BCD keys whose path contains every whitespace-separated term in
 * `query`, for surfacing near-misses when an exact lookup fails.
 */
export function searchBcdKeys(query: string, limit = 10): string[] {
  const terms = query.toLowerCase().split(/[\s.]+/).filter(Boolean);
  if (terms.length === 0) return [];

  const matches: string[] = [];
  for (const key of Object.keys(bcdIndex)) {
    const lower = key.toLowerCase();
    if (terms.every((term) => lower.includes(term))) {
      matches.push(key);
      if (matches.length >= limit * 4) break;
    }
  }
  // Shorter keys are the more general entries, and better suggestions.
  return matches.sort((a, b) => a.length - b.length).slice(0, limit);
}

/** Finds CSS features whose id, name or description matches every term. */
export function searchFeatures(query: string, limit = 10): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const matches: Array<{ id: string; score: number }> = [];
  for (const [id, feature] of Object.entries(featureIndex)) {
    const name = feature.n.toLowerCase();
    const haystack = `${id} ${name} ${feature.d ?? ''}`.toLowerCase();
    if (!terms.every((term) => haystack.includes(term))) continue;
    // Rank name and id hits above description-only hits.
    const score = terms.every((term) => `${id} ${name}`.includes(term)) ? 0 : 1;
    matches.push({ id, score });
  }

  return matches
    .sort((a, b) => a.score - b.score || a.id.length - b.id.length)
    .slice(0, limit)
    .map((m) => m.id);
}

export { BROWSERS };
export type { BcdEntry, FeatureEntry, DataMeta };
