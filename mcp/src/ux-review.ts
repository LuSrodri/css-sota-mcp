/**
 * Static UI/UX review of HTML and CSS source.
 *
 * This reads source; it does not render it. That boundary is the whole design
 * constraint, and it is stated rather than hidden: a Worker has no layout
 * engine, so nothing here can measure a computed contrast ratio, a rendered
 * target size, or where focus actually lands.
 *
 * What it can do is catch the failures that are *visible in the source* — a
 * missing `alt`, a blocked zoom, animation with no reduced-motion path, a
 * removed focus ring, a dark-only palette. Those are the majority of real
 * findings on most pages, and every one of them is a fact about the text rather
 * than a guess about the render.
 *
 * Every finding names the principle it violates, so the answer to "why does
 * this matter" is one lookup away rather than a matter of trust.
 */

/** How much a finding should worry you. */
export type Severity = 'blocker' | 'major' | 'minor';

export interface UxFinding {
  /** Principle id from `ux-guidelines.json`. */
  principleId: string;
  severity: Severity;
  /** What is wrong, in one sentence. */
  message: string;
  /** The offending source, trimmed. */
  evidence?: string;
  /** 1-based line in the source it was found in. */
  line?: number;
  /** Which input it came from. */
  source: 'html' | 'css';
  /** How many times the same problem occurs. */
  occurrences: number;
}

const MAX_EVIDENCE = 120;

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_EVIDENCE ? `${flat.slice(0, MAX_EVIDENCE - 1)}…` : flat;
}

/** 1-based line number of an offset. */
function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/** Strips HTML comments and the contents of script/style so they are not scanned as markup. */
function stripInert(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length))
    .replace(/<script\b[\s\S]*?<\/script>/gi, (m) => ' '.repeat(m.length))
    .replace(/<style\b[\s\S]*?<\/style>/gi, (m) => ' '.repeat(m.length));
}

/** Strips CSS comments, preserving offsets so line numbers stay honest. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Reads an attribute off a tag string. */
function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!match) return undefined;
  return match[2] ?? match[3] ?? match[4] ?? '';
}

/** Whether a tag carries the attribute at all, valued or bare. */
function hasAttr(tag: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`, 'i').test(tag);
}

interface Accumulator {
  add(finding: Omit<UxFinding, 'occurrences'>): void;
  list(): UxFinding[];
}

/** Collects findings, collapsing repeats of the same problem into one entry. */
function accumulator(): Accumulator {
  const byKey = new Map<string, UxFinding>();
  return {
    add(finding) {
      const key = `${finding.principleId}|${finding.message}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.occurrences++;
        return;
      }
      byKey.set(key, { ...finding, occurrences: 1 });
    },
    list() {
      const rank: Record<Severity, number> = { blocker: 0, major: 1, minor: 2 };
      return [...byKey.values()].sort(
        (a, b) => rank[a.severity] - rank[b.severity] || (a.line ?? 0) - (b.line ?? 0),
      );
    },
  };
}

/** Link and button text that names no destination. */
const VAGUE_LABELS = [
  'click here',
  'click',
  'here',
  'read more',
  'learn more',
  'more',
  'this link',
  'go',
  'clique aqui',
  'saiba mais',
  'leia mais',
  'veja mais',
];

/** CSS properties whose animation forces layout or paint every frame. */
const NON_COMPOSITED = [
  'width',
  'height',
  'top',
  'left',
  'right',
  'bottom',
  'margin',
  'padding',
  'font-size',
  'box-shadow',
  'filter',
];

function reviewHtml(html: string, out: Accumulator): void {
  const source = stripInert(html);
  const isFragment = !/<html[\s>]/i.test(html);

  // --- Document-level, only meaningful for a full document ---
  if (!isFragment) {
    const htmlTag = /<html\b[^>]*>/i.exec(source)?.[0] ?? '';
    if (!attr(htmlTag, 'lang')) {
      out.add({
        principleId: 'wcag-semantics-landmarks',
        severity: 'blocker',
        message: 'The html element has no lang attribute, so screen readers cannot pick a voice.',
        source: 'html',
      });
    }

    if (!/<title\b[^>]*>\s*\S/i.test(source)) {
      out.add({
        principleId: 'wcag-semantics-landmarks',
        severity: 'major',
        message: 'The document has no non-empty title.',
        source: 'html',
      });
    }

    const viewport = /<meta\b[^>]*name\s*=\s*["']?viewport["']?[^>]*>/i.exec(source)?.[0];
    if (!viewport) {
      out.add({
        principleId: 'responsive-fluid',
        severity: 'blocker',
        message: 'No viewport meta tag, so the page will be rendered at desktop width on phones.',
        source: 'html',
      });
    } else {
      const content = attr(viewport, 'content') ?? '';
      const maxScale = /maximum-scale\s*=\s*([\d.]+)/i.exec(content)?.[1];
      if (/user-scalable\s*=\s*(no|0)/i.test(content) || (maxScale && Number(maxScale) < 2)) {
        out.add({
          principleId: 'wcag-zoom-reflow',
          severity: 'blocker',
          message: 'The viewport blocks zoom, which breaks the most used accessibility feature there is.',
          evidence: snippet(viewport),
          line: lineOf(source, source.indexOf(viewport)),
          source: 'html',
        });
      }
    }
  }

  // --- Headings ---
  const headings = [...source.matchAll(/<h([1-6])\b[^>]*>/gi)].map((m) => ({
    level: Number(m[1]),
    index: m.index ?? 0,
  }));

  const h1s = headings.filter((h) => h.level === 1);
  if (!isFragment && h1s.length === 0 && headings.length > 0) {
    out.add({
      principleId: 'wcag-semantics-landmarks',
      severity: 'major',
      message: 'The page has headings but no h1, so it has no announced title in the outline.',
      source: 'html',
    });
  }
  if (h1s.length > 1) {
    out.add({
      principleId: 'wcag-semantics-landmarks',
      severity: 'minor',
      message: `The page has ${h1s.length} h1 elements; one names the page, the rest compete with it.`,
      line: lineOf(source, h1s[1]!.index),
      source: 'html',
    });
  }
  for (let i = 1; i < headings.length; i++) {
    const jump = headings[i]!.level - headings[i - 1]!.level;
    if (jump > 1) {
      out.add({
        principleId: 'wcag-semantics-landmarks',
        severity: 'minor',
        message: `Heading level jumps from h${headings[i - 1]!.level} to h${headings[i]!.level}, breaking the outline.`,
        line: lineOf(source, headings[i]!.index),
        source: 'html',
      });
    }
  }

  // --- Images ---
  for (const match of source.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    if (!hasAttr(tag, 'alt')) {
      out.add({
        principleId: 'wcag-perceivable-text-alternatives',
        severity: 'blocker',
        message: 'An img has no alt attribute. Describe it, or use alt="" if it is decorative.',
        evidence: snippet(tag),
        line: lineOf(source, match.index ?? 0),
        source: 'html',
      });
    }
    if (!(hasAttr(tag, 'width') && hasAttr(tag, 'height')) && !/aspect-ratio/i.test(tag)) {
      out.add({
        principleId: 'perf-lightness',
        severity: 'minor',
        message: 'An img has no width/height, so its space is not reserved and the layout will shift.',
        evidence: snippet(tag),
        line: lineOf(source, match.index ?? 0),
        source: 'html',
      });
    }
  }

  // --- Links and buttons ---
  for (const match of source.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const [full, , attrs = '', inner = ''] = match;
    const text = inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const accessibleName = text || attr(attrs, 'aria-label') || attr(attrs, 'title');

    if (!accessibleName) {
      out.add({
        principleId: 'wcag-perceivable-text-alternatives',
        severity: 'blocker',
        message: 'A link or button has no accessible name — add text, or aria-label if it is icon-only.',
        evidence: snippet(full),
        line: lineOf(source, match.index ?? 0),
        source: 'html',
      });
      continue;
    }

    if (text && VAGUE_LABELS.includes(text.toLowerCase().replace(/[.…!]+$/, ''))) {
      out.add({
        principleId: 'neuro-plain-language',
        severity: 'major',
        message: `"${text}" does not say what happens. Name the destination or the action instead.`,
        evidence: snippet(full),
        line: lineOf(source, match.index ?? 0),
        source: 'html',
      });
    }
  }

  // --- Form controls ---
  const labelledIds = new Set(
    [...source.matchAll(/<label\b[^>]*\bfor\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1]!),
  );
  for (const match of source.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
    const tag = match[0];
    const type = (attr(tag, 'type') ?? '').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;

    const id = attr(tag, 'id');
    const named =
      (id && labelledIds.has(id)) ||
      hasAttr(tag, 'aria-label') ||
      hasAttr(tag, 'aria-labelledby') ||
      hasAttr(tag, 'title');

    if (!named) {
      out.add({
        principleId: 'wcag-semantics-landmarks',
        severity: 'blocker',
        message: 'A form control has no associated label. Placeholder text is not a label.',
        evidence: snippet(tag),
        line: lineOf(source, match.index ?? 0),
        source: 'html',
      });
    }
  }

  // --- Autoplay ---
  for (const match of source.matchAll(/<(video|audio)\b[^>]*>/gi)) {
    if (hasAttr(match[0], 'autoplay')) {
      out.add({
        principleId: 'neuro-predictability',
        severity: 'major',
        message: 'Media autoplays. Movement and sound the user did not start is disorienting and hostile.',
        evidence: snippet(match[0]),
        line: lineOf(source, match.index ?? 0),
        source: 'html',
      });
    }
  }

  // --- Focus order ---
  for (const match of source.matchAll(/\btabindex\s*=\s*["']?(\d+)/gi)) {
    if (Number(match[1]) > 0) {
      out.add({
        principleId: 'wcag-focus-visible',
        severity: 'major',
        message: 'A positive tabindex overrides the natural focus order and desynchronises it from the visual one.',
        line: lineOf(source, match.index ?? 0),
        source: 'html',
      });
    }
  }

  // --- Navigation breadth (Hick's law) ---
  for (const match of source.matchAll(/<nav\b[^>]*>([\s\S]*?)<\/nav>/gi)) {
    const links = [...(match[1] ?? '').matchAll(/<a\b/gi)].length;
    if (links > 7) {
      out.add({
        principleId: 'hicks-law',
        severity: 'minor',
        message: `A nav offers ${links} choices at one level. Past about seven, decision time climbs — group them.`,
        line: lineOf(source, match.index ?? 0),
        source: 'html',
      });
    }
  }

  // --- Inline SVG ---
  for (const match of source.matchAll(/<svg\b[^>]*>/gi)) {
    const tag = match[0];
    const rest = source.slice(match.index ?? 0, (match.index ?? 0) + 600);
    const titled = /<title\b/i.test(rest) || hasAttr(tag, 'aria-label');
    if (!hasAttr(tag, 'aria-hidden') && !titled) {
      out.add({
        principleId: 'svg-craft',
        severity: 'major',
        message: 'An inline SVG is neither labelled nor hidden. Give it a <title>, or aria-hidden="true" if decorative.',
        evidence: snippet(tag),
        line: lineOf(source, match.index ?? 0),
        source: 'html',
      });
    }
  }
}

function reviewCss(css: string, out: Accumulator): void {
  const source = stripCssComments(css);

  const hasMotion = /\b(transition|animation)\s*:/i.test(source) || /@keyframes\b/i.test(source);
  const hasReducedMotion = /prefers-reduced-motion/i.test(source);

  if (hasMotion && !hasReducedMotion) {
    out.add({
      principleId: 'motion-reduced',
      severity: 'blocker',
      message:
        'The stylesheet animates but never mentions prefers-reduced-motion. For vestibular users that is a medical problem, not a preference.',
      source: 'css',
    });
  }

  // --- Focus rings ---
  for (const match of source.matchAll(/outline\s*:\s*(none|0)\b/gi)) {
    const index = match.index ?? 0;
    // A reset that is immediately followed by a :focus-visible rule is fine;
    // look ahead rather than flagging every reset.
    const context = source.slice(Math.max(0, index - 400), index + 800);
    if (!/:focus-visible/i.test(context)) {
      out.add({
        principleId: 'wcag-focus-visible',
        severity: 'blocker',
        message:
          'Focus outline removed with no :focus-visible replacement nearby. For a keyboard user the focus ring is the cursor.',
        evidence: snippet(match[0]),
        line: lineOf(source, index),
        source: 'css',
      });
    }
  }

  // --- Durations ---
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)\s*(m?s)\b/gi)) {
    const value = Number(match[1]);
    const ms = match[2]!.toLowerCase() === 's' ? value * 1000 : value;
    // Ignore the long, ambient durations that are obviously loops, and the
    // near-zero values used to neutralise motion under reduce.
    if (ms > 400 && ms <= 3000) {
      const context = source.slice(Math.max(0, (match.index ?? 0) - 200), match.index ?? 0);
      if (/\b(transition|animation)/i.test(context) && !/infinite/i.test(context)) {
        out.add({
          principleId: 'motion-timing',
          severity: 'minor',
          message: `A ${ms}ms transition is past the 400ms mark where the user starts waiting on the animation.`,
          evidence: snippet(match[0]),
          line: lineOf(source, match.index ?? 0),
          source: 'css',
        });
      }
    }
  }

  // --- Non-composited animation ---
  for (const match of source.matchAll(/transition\s*:\s*([^;}]+)/gi)) {
    const value = (match[1] ?? '').toLowerCase();
    const offenders = NON_COMPOSITED.filter((prop) => new RegExp(`\\b${prop}\\b`).test(value));
    if (offenders.length > 0) {
      out.add({
        principleId: 'motion-timing',
        severity: 'minor',
        message: `Transitioning ${offenders.join(', ')} forces layout or paint every frame. Prefer transform and opacity.`,
        evidence: snippet(match[0]),
        line: lineOf(source, match.index ?? 0),
        source: 'css',
      });
    }
  }

  // --- Theming ---
  // The lookbehind matters: without it this also matches the `color-scheme: dark`
  // *inside* `@media (prefers-color-scheme: dark)`, and reports a light-first
  // stylesheet as dark-only. Caught by running the checker on this project's own
  // landing page, which has no `color-scheme` declaration at all.
  for (const match of source.matchAll(/(?<!prefers-)\bcolor-scheme\s*:\s*([^;})]+)/gi)) {
    const value = (match[1] ?? '').toLowerCase();
    if (/\bdark\b/.test(value) && !/\blight\b/.test(value)) {
      out.add({
        principleId: 'theme-light-first',
        severity: 'major',
        message: 'color-scheme is dark-only. Light is the default; dark is an alternative for specific niches.',
        evidence: snippet(match[0]),
        line: lineOf(source, match.index ?? 0),
        source: 'css',
      });
    }
  }

  const hasDarkQuery = /prefers-color-scheme\s*:\s*dark/i.test(source);
  const hasLightQuery = /prefers-color-scheme\s*:\s*light/i.test(source);
  if (hasDarkQuery) {
    out.add({
      principleId: 'theme-light-first',
      severity: 'minor',
      message: hasLightQuery
        ? 'Both colour schemes are declared as queries. Make the light palette the unconditional default so it is what ships when nothing matches.'
        : 'A dark theme is offered. That is only warranted in specific niches — prolonged low-light use, media, code, photography. Confirm this is one, and that the light palette is the unconditional default.',
      line: lineOf(source, source.search(/prefers-color-scheme\s*:\s*dark/i)),
      source: 'css',
    });
  }

  // --- Typography ---
  for (const match of source.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)) {
    if (Number(match[1]) < 14) {
      out.add({
        principleId: 'neuro-visual-calm',
        severity: 'minor',
        message: `A ${match[1]}px font size is below the comfortable floor, and px does not respond to the reader's font-size preference.`,
        evidence: snippet(match[0]),
        line: lineOf(source, match.index ?? 0),
        source: 'css',
      });
    }
  }
}

/**
 * Reviews HTML and/or CSS and returns findings, worst first.
 *
 * Never throws: malformed input yields whatever could still be recognised.
 */
export function reviewUx(input: { html?: string; css?: string }): UxFinding[] {
  const out = accumulator();
  if (input.html) reviewHtml(input.html, out);
  if (input.css) reviewCss(input.css, out);
  return out.list();
}
