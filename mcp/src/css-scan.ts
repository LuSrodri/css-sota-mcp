/**
 * A small CSS scanner that reports which platform features a stylesheet uses.
 *
 * This is deliberately not a full CSS parser. `audit_css` only needs to know
 * *which* constructs appear and where — properties, declaration values,
 * at-rules, selector pseudo-classes/elements, and value functions — not the
 * shape of the tree they form. A purpose-built scanner keeps the Worker free of
 * a parser dependency, never throws on malformed input (auditing a broken
 * stylesheet should still report what it can), and handles CSS nesting for
 * free, since it tracks nothing but brace depth.
 *
 * The scanner splits the source at top-level `{`, `}` and `;` while respecting
 * comments, strings and `url()` tokens. Text before a `{` is a *prelude* (a
 * selector list or at-rule prelude); text before a `;` or `}` is a *statement*
 * (a declaration, or an at-rule with no block).
 */

/** The kind of construct a {@link CssUsage} refers to. */
export type UsageKind = 'property' | 'value' | 'at-rule' | 'selector' | 'function';

/** One feature use found in a stylesheet. */
export interface CssUsage {
  kind: UsageKind;
  /**
   * The construct's name, normalised to lowercase and stripped of syntax:
   * `grid-template-areas`, `flex`, `container`, `:has`, `color-mix`.
   */
  name: string;
  /** For `value` and `function` usages, the declaration's property. */
  property?: string;
  /** 1-based line number of the construct in the source. */
  line: number;
  /** The source text the usage was found in, trimmed and length-capped. */
  snippet: string;
}

/** Characters that terminate a chunk at nesting depth 0 of the current block. */
const CHUNK_TERMINATORS = new Set(['{', '}', ';']);

const MAX_SNIPPET = 120;

/**
 * CSS-wide keywords, plus the handful of value idents that appear under so many
 * properties that reporting them would drown the signal. These never map to a
 * per-property BCD key worth auditing.
 */
const IGNORED_VALUE_IDENTS = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'auto',
  'none',
  'normal',
  'default',
  'currentcolor',
  'transparent',
  'important',
]);

/** Functions that are universally supported and only add noise to a report. */
const IGNORED_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'url', 'var', 'calc', 'attr']);

interface Chunk {
  text: string;
  /** The delimiter that ended the chunk. */
  end: '{' | '}' | ';' | 'eof';
  line: number;
}

/**
 * Splits `source` into chunks delimited by `{`, `}` and `;`, skipping over
 * comments, quoted strings and `url()` tokens so that delimiters appearing
 * inside them are not treated as structure.
 */
function* chunks(source: string): Generator<Chunk> {
  let buffer = '';
  let line = 1;
  let chunkLine = 1;
  let i = 0;

  const flush = (end: Chunk['end']): Chunk | undefined => {
    const text = buffer.trim();
    buffer = '';
    const startedAt = chunkLine;
    chunkLine = line;
    if (text) return { text, end, line: startedAt };
    return undefined;
  };

  while (i < source.length) {
    const char = source[i]!;

    if (char === '\n') {
      line++;
      buffer += char;
      i++;
      if (!buffer.trim()) chunkLine = line;
      continue;
    }

    // Comments: skipped entirely, but newlines inside still advance the counter.
    if (char === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? source.length : close + 2;
      for (let j = i; j < end; j++) if (source[j] === '\n') line++;
      i = end;
      continue;
    }

    // Strings: copied verbatim so that `;` or `{` inside them is inert.
    if (char === '"' || char === "'") {
      const { text, next } = readString(source, i);
      for (const c of text) if (c === '\n') line++;
      buffer += text;
      i = next;
      continue;
    }

    // `url(` may hold an unquoted value containing characters that would
    // otherwise read as structure; consume through the matching paren.
    if ((char === 'u' || char === 'U') && /^url\(/i.test(source.slice(i, i + 4))) {
      const close = source.indexOf(')', i + 4);
      const end = close === -1 ? source.length : close + 1;
      const text = source.slice(i, end);
      for (const c of text) if (c === '\n') line++;
      buffer += text;
      i = end;
      continue;
    }

    if (CHUNK_TERMINATORS.has(char)) {
      const chunk = flush(char as '{' | '}' | ';');
      i++;
      if (chunk) yield chunk;
      else chunkLine = line;
      continue;
    }

    buffer += char;
    i++;
  }

  const last = flush('eof');
  if (last) yield last;
}

/** Reads a quoted string starting at `start`, honouring backslash escapes. */
function readString(source: string, start: number): { text: string; next: number } {
  const quote = source[start]!;
  let i = start + 1;
  while (i < source.length) {
    const char = source[i]!;
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === quote) {
      i++;
      break;
    }
    i++;
  }
  return { text: source.slice(start, i), next: i };
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SNIPPET ? `${flat.slice(0, MAX_SNIPPET - 1)}…` : flat;
}

/**
 * Extracts pseudo-classes, pseudo-elements and attribute selectors from a
 * selector list.
 *
 * Names are reported without arguments (`:has(a)` becomes `:has`), since BCD
 * keys selectors by name.
 */
function scanSelectors(prelude: string, line: number, out: CssUsage[]): void {
  const pseudo = /::?([a-zA-Z-][a-zA-Z0-9-]*)/g;
  const seen = new Set<string>();
  for (const match of prelude.matchAll(pseudo)) {
    const name = `${match[0]!.startsWith('::') ? '::' : ':'}${match[1]!.toLowerCase()}`;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ kind: 'selector', name, line, snippet: snippet(prelude) });
  }
}

/**
 * Extracts the functions used in a declaration value.
 *
 * `--custom: …` declarations are skipped by the caller: their contents are an
 * arbitrary token stream that may never be used as a value.
 */
function scanFunctions(value: string, property: string, line: number, out: CssUsage[]): void {
  const fn = /([a-zA-Z-][a-zA-Z0-9-]*)\(/g;
  const seen = new Set<string>();
  for (const match of value.matchAll(fn)) {
    const name = match[1]!.toLowerCase();
    if (IGNORED_FUNCTIONS.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ kind: 'function', name, property, line, snippet: snippet(value) });
  }
}

/**
 * Extracts the bare idents from a declaration value (`display: flex` yields
 * `flex`), which BCD tracks as sub-keys of the property.
 *
 * Idents inside function arguments are skipped — `color-mix(in oklch, red, …)`
 * says nothing about `color`'s own value support — as are numbers, dimensions,
 * hex colours and custom properties.
 */
function scanValueIdents(value: string, property: string, line: number, out: CssUsage[]): void {
  const withoutFunctions = value.replace(/[a-zA-Z-][a-zA-Z0-9-]*\([^()]*\)/g, ' ');
  const seen = new Set<string>();
  for (const match of withoutFunctions.matchAll(/(^|[\s,/])(-?[a-zA-Z][a-zA-Z0-9-]*)/g)) {
    const name = match[2]!.toLowerCase();
    if (IGNORED_VALUE_IDENTS.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ kind: 'value', name, property, line, snippet: snippet(`${property}: ${value}`) });
  }
}

/**
 * Scans a stylesheet and returns every feature use found, in source order.
 *
 * Never throws: malformed input yields whatever could still be recognised.
 */
export function scanCss(source: string): CssUsage[] {
  const usages: CssUsage[] = [];

  for (const chunk of chunks(source)) {
    const { text, end, line } = chunk;

    if (text.startsWith('@')) {
      const name = /^@([a-zA-Z-][a-zA-Z0-9-]*)/.exec(text)?.[1]?.toLowerCase();
      if (name) usages.push({ kind: 'at-rule', name, line, snippet: snippet(text) });
      // An at-rule prelude can still contain selectors worth reporting, e.g.
      // `@supports selector(:has(a))`.
      if (end === '{') scanSelectors(text.replace(/^@[a-zA-Z-]+/, ''), line, usages);
      continue;
    }

    if (end === '{') {
      scanSelectors(text, line, usages);
      continue;
    }

    // Otherwise the chunk ended at `;`, `}` or EOF, so it is a declaration —
    // provided it actually splits into a property and a value.
    const colon = text.indexOf(':');
    if (colon <= 0) continue;

    // Matches a custom property (`--brand`), a vendor-prefixed property
    // (`-webkit-box-orient`) or a plain one. Anything else at this position is
    // not a declaration — most often a selector the scanner should skip.
    const property = text.slice(0, colon).trim().toLowerCase();
    if (!/^(--[a-zA-Z0-9_-]+|-?[a-zA-Z][a-zA-Z0-9_-]*)$/.test(property)) continue;

    const rawValue = text.slice(colon + 1).trim();
    const value = rawValue.replace(/!\s*important\s*$/i, '').trim();

    usages.push({ kind: 'property', name: property, line, snippet: snippet(text) });

    // Custom property bodies are an opaque token stream until substituted, so
    // nothing inside one is a reliable signal about feature support.
    if (property.startsWith('--') || !value) continue;

    scanFunctions(value, property, line, usages);
    scanValueIdents(value, property, line, usages);
  }

  return usages;
}
