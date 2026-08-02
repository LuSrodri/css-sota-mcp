/**
 * End-to-end tests for the two offline tools, exercised against the real
 * generated data. Neither touches the network.
 */

import { describe, expect, it } from 'vitest';
import { handler as auditCss } from '../src/tools/audit-css.js';
import { handler as checkSupport } from '../src/tools/check-support.js';

/** Invokes `audit_css` with the schema defaults applied. */
function audit(source: string, target = 'baseline-widely', includePassing = false) {
  return auditCss({ source, target, include_passing: includePassing });
}

/** Invokes `check_support` with the schema defaults applied. */
function support(args: {
  bcd_key?: string;
  property?: string;
  value?: string;
  all_browsers?: boolean;
}) {
  return checkSupport({ all_browsers: false, ...args });
}

describe('audit_css', () => {
  it('passes a stylesheet that only uses long-standing features', async () => {
    const result = await audit('.a { color: red; margin: 0; display: block; }');

    expect(result.structuredContent.failing).toBe(0);
    expect(result.structuredContent.featuresChecked).toBeGreaterThan(0);
  });

  it('flags a feature that is not yet Baseline widely available', async () => {
    const result = await audit('.a { anchor-name: --tip; }', 'baseline-widely');
    const finding = result.structuredContent.findings.find(
      (item) => item.key === 'css.properties.anchor-name',
    );

    expect(finding?.status).toBe('fail');
    expect(result.structuredContent.failing).toBeGreaterThan(0);
  });

  it('reports the line the offending declaration is on', async () => {
    const result = await audit('.a {\n  color: red;\n}\n\n.b {\n  anchor-name: --tip;\n}');
    const finding = result.structuredContent.findings.find(
      (item) => item.key === 'css.properties.anchor-name',
    );

    expect(finding?.line).toBe(6);
  });

  it('fails a property against a browser version that predates it', async () => {
    const result = await audit('.a { anchor-name: --tip; }', 'chrome 100');
    const finding = result.structuredContent.findings.find(
      (item) => item.key === 'css.properties.anchor-name',
    );

    expect(finding?.status).toBe('fail');
    expect(finding?.reasons.join(' ')).toMatch(/Chrome 100/);
  });

  it('passes the same property against a recent enough browser', async () => {
    const result = await audit('.a { anchor-name: --tip; }', 'chrome 140');
    const finding = result.structuredContent.findings.find(
      (item) => item.key === 'css.properties.anchor-name',
    );

    expect(finding).toBeUndefined();
    expect(result.structuredContent.failing).toBe(0);
  });

  it('audits selectors and at-rules, not just properties', async () => {
    const result = await audit(
      '@container (width > 40em) { .card:has(img) { color: red; } }',
      'chrome 90',
    );
    const keys = result.structuredContent.findings.map((item) => item.key);

    expect(keys).toContain('css.at-rules.container');
    expect(keys).toContain('css.selectors.has');
  });

  it('audits value functions', async () => {
    const result = await audit('.a { color: color-mix(in oklch, red, blue); }', 'chrome 100');
    const keys = result.structuredContent.findings.map((item) => item.key);

    expect(keys).toContain('css.types.color.color-mix');
  });

  it('counts repeated uses once, with an occurrence count', async () => {
    const result = await audit(
      '.a { anchor-name: --x; }\n.b { anchor-name: --y; }\n.c { anchor-name: --z; }',
      'chrome 100',
    );
    const findings = result.structuredContent.findings.filter(
      (item) => item.key === 'css.properties.anchor-name',
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.occurrences).toBe(3);
  });

  it('rejects a browserslist query with an actionable message', async () => {
    const result = await audit('.a { color: red; }', 'last 2 versions');

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/not supported/i);
    expect(result.content[0]!.text).toMatch(/baseline-widely/);
  });

  it('omits passing features unless asked for them', async () => {
    const source = '.a { color: red; anchor-name: --tip; }';
    const without = await audit(source, 'baseline-widely', false);
    const with_ = await audit(source, 'baseline-widely', true);

    expect(with_.structuredContent.findings.length).toBeGreaterThan(
      without.structuredContent.findings.length,
    );
    expect(with_.structuredContent.findings.some((item) => item.status === 'pass')).toBe(true);
  });

  it('says so plainly when nothing recognisable is in the input', async () => {
    const result = await audit('not css at all', 'baseline-widely');

    expect(result.structuredContent.featuresChecked).toBe(0);
    expect(result.content[0]!.text).toMatch(/No recognisable CSS features/);
  });

  it('treats a Baseline newly target as looser than widely', async () => {
    const source = '.a { anchor-name: --tip; }';
    const widely = await audit(source, 'baseline-widely');
    const newly = await audit(source, 'baseline-newly');

    expect(newly.structuredContent.failing).toBeLessThanOrEqual(widely.structuredContent.failing);
  });
});

describe('check_support', () => {
  it('resolves an explicit BCD key', async () => {
    const result = await support({ bcd_key: 'css.properties.display' });

    expect(result.structuredContent.resolved).toBe(true);
    expect(result.structuredContent.key).toBe('css.properties.display');
  });

  it('resolves a property with a value to the value-specific key', async () => {
    const result = await support({ property: 'display', value: 'grid' });

    expect(result.structuredContent.key).toBe('css.properties.display.grid');
  });

  it('resolves a selector passed in the property field', async () => {
    const result = await support({ property: ':has' });

    expect(result.structuredContent.key).toBe('css.selectors.has');
  });

  it('resolves an at-rule passed in the property field', async () => {
    const result = await support({ property: '@container' });

    expect(result.structuredContent.key).toBe('css.at-rules.container');
  });

  it('resolves a function passed in the property field', async () => {
    const result = await support({ property: 'color-mix' });

    expect(result.structuredContent.key).toBe('css.types.color.color-mix');
  });

  it('reports per-browser versions', async () => {
    const result = await support({ bcd_key: 'css.selectors.has' });
    const chrome = result.structuredContent.support.chrome as { since: string | null };

    expect(chrome.since).toBeTruthy();
  });

  it('links the key to the Baseline feature that owns it', async () => {
    const result = await support({ bcd_key: 'css.selectors.has' });

    expect(result.structuredContent.featureId).toBe('has');
    expect(['widely', 'newly', 'limited']).toContain(result.structuredContent.baseline);
  });

  it('limits browsers to the Baseline set by default and widens on request', async () => {
    const narrow = await support({ bcd_key: 'css.properties.display' });
    const wide = await support({ bcd_key: 'css.properties.display', all_browsers: true });

    expect(Object.keys(narrow.structuredContent.support)).toHaveLength(7);
    expect(Object.keys(wide.structuredContent.support).length).toBeGreaterThan(7);
  });

  it('suggests near misses when a key does not resolve', async () => {
    const result = await support({ bcd_key: 'css.properties.anchor' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.suggestions.length).toBeGreaterThan(0);
  });

  it('requires at least one of bcd_key or property', async () => {
    const result = await support({});

    expect(result.isError).toBe(true);
  });
});
