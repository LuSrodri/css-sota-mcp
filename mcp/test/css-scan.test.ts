import { describe, expect, it } from 'vitest';
import { scanCss, type CssUsage } from '../src/css-scan.js';

/** Names found for a given usage kind, for terser assertions. */
function names(usages: CssUsage[], kind: CssUsage['kind']): string[] {
  return usages.filter((usage) => usage.kind === kind).map((usage) => usage.name);
}

describe('scanCss', () => {
  it('finds properties and their value idents', () => {
    const usages = scanCss('.a { display: grid; text-wrap: balance; }');

    expect(names(usages, 'property')).toEqual(['display', 'text-wrap']);
    expect(names(usages, 'value')).toEqual(['grid', 'balance']);
  });

  it('associates values with the property they were declared on', () => {
    const usages = scanCss('.a { display: grid; }');
    const value = usages.find((usage) => usage.kind === 'value');

    expect(value?.property).toBe('display');
  });

  it('reports at-rules by name', () => {
    const usages = scanCss('@container (width > 40em) { .a { color: red; } }');

    expect(names(usages, 'at-rule')).toEqual(['container']);
  });

  it('reports at-rules that end in a semicolon rather than a block', () => {
    const usages = scanCss('@import url("x.css");\n@layer base, page;');

    expect(names(usages, 'at-rule')).toEqual(['import', 'layer']);
  });

  it('reports pseudo-classes and pseudo-elements without their arguments', () => {
    const usages = scanCss('.card:has(> img)::backdrop { color: red; }');

    expect(names(usages, 'selector')).toEqual([':has', '::backdrop']);
  });

  it('reports value functions but skips ubiquitous ones', () => {
    const usages = scanCss('.a { color: color-mix(in oklch, red, blue); width: calc(1px + var(--x)); }');

    expect(names(usages, 'function')).toEqual(['color-mix']);
  });

  it('does not treat function arguments as value idents', () => {
    const usages = scanCss('.a { color: color-mix(in oklch, red, blue); }');

    expect(names(usages, 'value')).toEqual([]);
  });

  it('ignores CSS-wide keywords as values', () => {
    const usages = scanCss('.a { display: inherit; color: initial; margin: auto; }');

    expect(names(usages, 'value')).toEqual([]);
  });

  it('reports the property but nothing inside a custom property body', () => {
    const usages = scanCss('.a { --brand: color-mix(in oklch, red, blue); }');

    expect(names(usages, 'property')).toEqual(['--brand']);
    expect(names(usages, 'function')).toEqual([]);
  });

  it('strips !important before reading the value', () => {
    const usages = scanCss('.a { display: grid !important; }');

    expect(names(usages, 'value')).toEqual(['grid']);
  });

  it('handles nested rules', () => {
    const usages = scanCss('.card { color: red; &:hover { text-wrap: balance; } }');

    expect(names(usages, 'property')).toEqual(['color', 'text-wrap']);
    expect(names(usages, 'selector')).toEqual([':hover']);
  });

  describe('lexical edge cases', () => {
    it('ignores declarations inside comments', () => {
      const usages = scanCss('.a { /* display: grid; */ color: red; }');

      expect(names(usages, 'property')).toEqual(['color']);
    });

    it('does not treat braces or semicolons inside strings as structure', () => {
      const usages = scanCss('.a::before { content: "} display: grid;"; color: red; }');

      expect(names(usages, 'property')).toEqual(['content', 'color']);
    });

    it('handles escaped quotes inside strings', () => {
      const usages = scanCss(String.raw`.a::before { content: "he said \"hi\""; color: red; }`);

      expect(names(usages, 'property')).toEqual(['content', 'color']);
    });

    it('does not treat an unquoted url() body as structure', () => {
      const usages = scanCss('.a { background: url(a;b{c.png); color: red; }');

      expect(names(usages, 'property')).toEqual(['background', 'color']);
    });

    it('reports 1-based line numbers', () => {
      const usages = scanCss('.a {\n  color: red;\n\n  display: grid;\n}');
      const display = usages.find((usage) => usage.name === 'display');

      expect(display?.line).toBe(4);
    });

    it('counts lines past a multi-line comment correctly', () => {
      const usages = scanCss('.a {\n/* one\ntwo\nthree */\n  display: grid;\n}');
      const display = usages.find((usage) => usage.name === 'display');

      expect(display?.line).toBe(5);
    });

    it('returns results rather than throwing on unbalanced braces', () => {
      const usages = scanCss('.a { color: red;');

      expect(names(usages, 'property')).toEqual(['color']);
    });

    it('returns nothing for an empty stylesheet', () => {
      expect(scanCss('')).toEqual([]);
      expect(scanCss('   \n\n  ')).toEqual([]);
    });

    it('does not mistake a selector for a declaration', () => {
      const usages = scanCss('a:hover { color: red; }');

      expect(names(usages, 'property')).toEqual(['color']);
      expect(names(usages, 'selector')).toEqual([':hover']);
    });

    it('lowercases property and value names', () => {
      const usages = scanCss('.a { DISPLAY: GRID; }');

      expect(names(usages, 'property')).toEqual(['display']);
      expect(names(usages, 'value')).toEqual(['grid']);
    });
  });
});
