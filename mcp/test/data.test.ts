/**
 * Checks the resolvers against the real generated bundle.
 *
 * These assertions double as a contract test for `scripts/build-data.js`: if an
 * upstream restructure changes how CSS is filed, the lookups here are what
 * break, rather than a tool quietly returning "not found" in production.
 */

import { describe, expect, it } from 'vitest';
import {
  dataMeta,
  featureIdForBcdKey,
  getBcdEntry,
  getFeature,
  resolveAtRuleKey,
  resolveFeatureId,
  resolveFunctionKey,
  resolvePropertyKey,
  resolveSelectorKey,
  searchBcdKeys,
  searchFeatures,
} from '../src/data/index.js';
import { BROWSERS } from '../src/data/schema.js';

describe('generated bundle', () => {
  it('carries provenance for the sources it was built from', () => {
    expect(dataMeta.bcdVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(dataMeta.webFeaturesVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(dataMeta.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('covers the whole CSS surface, not a fragment of it', () => {
    expect(dataMeta.bcdKeys).toBeGreaterThan(3000);
    expect(dataMeta.features).toBeGreaterThan(300);
  });

  it('gives every entry one support slot per browser', () => {
    const entry = getBcdEntry('css.properties.display');

    expect(entry?.s).toHaveLength(BROWSERS.length);
  });

  it('normalises Baseline status to the dashboard vocabulary', () => {
    const statuses = new Set<string>();
    for (const key of ['grid', 'flexbox', 'anchor-positioning', 'container-queries']) {
      const feature = getFeature(key);
      if (feature) statuses.add(feature.s);
    }

    expect(statuses.size).toBeGreaterThan(0);
    for (const status of statuses) {
      expect(['widely', 'newly', 'limited']).toContain(status);
    }
  });
});

describe('resolvePropertyKey', () => {
  it('resolves a plain property', () => {
    expect(resolvePropertyKey('display')).toBe('css.properties.display');
  });

  it('is case-insensitive', () => {
    expect(resolvePropertyKey('DISPLAY')).toBe('css.properties.display');
  });

  it('prefers the value-specific key when BCD tracks one', () => {
    expect(resolvePropertyKey('display', 'grid')).toBe('css.properties.display.grid');
  });

  it('falls back to the property when the value is not tracked separately', () => {
    expect(resolvePropertyKey('display', 'not-a-real-value')).toBe('css.properties.display');
  });

  it('maps every custom property to the single custom-property entry', () => {
    expect(resolvePropertyKey('--brand')).toBe('css.properties.custom-property');
    expect(resolvePropertyKey('--anything-else')).toBe('css.properties.custom-property');
  });

  it('returns undefined for an unknown property', () => {
    expect(resolvePropertyKey('not-a-property')).toBeUndefined();
  });
});

describe('resolveSelectorKey', () => {
  it('resolves a pseudo-class with or without its colon', () => {
    expect(resolveSelectorKey(':has')).toBe('css.selectors.has');
    expect(resolveSelectorKey('has')).toBe('css.selectors.has');
  });

  it('resolves a pseudo-element', () => {
    expect(resolveSelectorKey('::backdrop')).toBe('css.selectors.backdrop');
  });

  it('returns undefined for an unknown selector', () => {
    expect(resolveSelectorKey(':not-a-selector')).toBeUndefined();
  });
});

describe('resolveAtRuleKey', () => {
  it('resolves an at-rule with or without its sigil', () => {
    expect(resolveAtRuleKey('@container')).toBe('css.at-rules.container');
    expect(resolveAtRuleKey('supports')).toBe('css.at-rules.supports');
  });

  it('returns undefined for an unknown at-rule', () => {
    expect(resolveAtRuleKey('@nope')).toBeUndefined();
  });
});

describe('resolveFunctionKey', () => {
  it('resolves a top-level type', () => {
    expect(resolveFunctionKey('clamp')).toBe('css.types.clamp');
  });

  it('resolves a function filed under a nested type', () => {
    expect(resolveFunctionKey('color-mix')).toBe('css.types.color.color-mix');
  });

  it('returns undefined for an unknown function', () => {
    expect(resolveFunctionKey('not-a-function')).toBeUndefined();
  });
});

describe('resolveFeatureId', () => {
  it('passes an exact id through', () => {
    expect(resolveFeatureId('grid')).toBe('grid');
  });

  it('resolves a display name', () => {
    expect(resolveFeatureId('Subgrid')).toBe('subgrid');
  });

  it('resolves a spaced name to its dashed id', () => {
    expect(resolveFeatureId('anchor positioning')).toBe('anchor-positioning');
  });

  it('returns undefined for an unknown feature', () => {
    expect(resolveFeatureId('definitely not a feature')).toBeUndefined();
  });
});

describe('featureIdForBcdKey', () => {
  it('maps a compat key back to the feature that owns it', () => {
    expect(featureIdForBcdKey('css.selectors.has')).toBe('has');
  });
});

describe('search helpers', () => {
  it('finds compat keys containing every term', () => {
    const keys = searchBcdKeys('anchor name');

    expect(keys).toContain('css.properties.anchor-name');
  });

  it('ranks the more general key first', () => {
    const keys = searchBcdKeys('anchor name');

    expect(keys[0]!.length).toBeLessThanOrEqual(keys[keys.length - 1]!.length);
  });

  it('finds features by name and by description', () => {
    expect(searchFeatures('subgrid')).toContain('subgrid');
    expect(searchFeatures('container queries').length).toBeGreaterThan(0);
  });

  it('returns nothing for an empty query', () => {
    expect(searchBcdKeys('   ')).toEqual([]);
    expect(searchFeatures('')).toEqual([]);
  });
});
