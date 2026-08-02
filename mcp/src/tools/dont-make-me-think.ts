/**
 * `dont_make_me_think` — UI/UX guidelines, and a review of a page against them.
 *
 * Named after Steve Krug's rule: a page should be self-evident. The tool has
 * two jobs, split by `mode`, because they are the two halves of the same loop —
 * read the guidance before building, check the result against it afterwards.
 */

import { z } from 'zod';
import guidelinesJson from '../data/ux-guidelines.json';
import type { UxGuidelines, UxPrinciple, UxTopic } from '../data/ux-schema.js';
import { reviewUx, type Severity, type UxFinding } from '../ux-review.js';
import { sections } from '../format.js';
import { fail, ok } from './shared.js';

export const name = 'dont_make_me_think';

const guidelines = guidelinesJson as unknown as UxGuidelines;

const TOPICS = [
  'heuristics',
  'laws',
  'wcag',
  'neurodiversity',
  'motion',
  'svg',
  'theme',
  'performance',
  'responsive',
] as const;

/** Upper bound on reviewed source, matching `audit_css`. */
const MAX_SOURCE = 400_000;

/** How long fetched pages are cached at the edge. */
const FETCH_CACHE_SECONDS = 300;
const FETCH_TIMEOUT_MS = 10_000;

export const config = {
  title: "Don't Make Me Think",
  description:
    'UI/UX guidelines and a review of a page against them. mode="guidelines" returns the ' +
    'principles — Nielsen\'s 10 heuristics, Hick\'s and Fitts\'s laws, WCAG 2.2, ' +
    'neurodiversity-inclusive design, motion and microinteractions (including when Lottie or ' +
    'Rive are worth their bundle cost), SVG craft and animation, light-first theming, ' +
    'lightness and responsiveness — optionally filtered by topic. Read them BEFORE designing ' +
    'or building UI. mode="review" statically reviews supplied HTML and CSS, or a URL, and ' +
    'reports what violates which principle. The review reads source and does not render it, so ' +
    'it cannot measure computed contrast, real target sizes, or where focus lands — it catches ' +
    'what is visible in the markup, which is most of what actually goes wrong.',
  inputSchema: z.object({
    mode: z
      .enum(['guidelines', 'review'])
      .default('guidelines')
      .describe(
        'guidelines: return the principles to design against. review: check HTML/CSS or a URL against them.',
      ),
    topic: z
      .enum(TOPICS)
      .optional()
      .describe(
        'Restrict guidelines to one area. Omit for all of them. Ignored when mode is "review".',
      ),
    html: z.string().max(MAX_SOURCE).optional().describe('HTML source to review.'),
    css: z.string().max(MAX_SOURCE).optional().describe('CSS source to review.'),
    url: z
      .string()
      .url()
      .optional()
      .describe(
        'Page to fetch and review. Only the HTML and its inline styles are read — linked ' +
          'stylesheets are not followed, so pass `css` as well for a full review.',
      ),
  }),
  outputSchema: z.object({
    mode: z.string(),
    version: z.string(),
    principles: z.array(
      z.object({
        id: z.string(),
        topic: z.string(),
        title: z.string(),
        principle: z.string(),
        why: z.string(),
        rules: z.array(z.string()),
        source: z.string(),
      }),
    ),
    reviewed: z.array(z.string()),
    findings: z.array(
      z.object({
        principleId: z.string(),
        principleTitle: z.string(),
        severity: z.enum(['blocker', 'major', 'minor']),
        message: z.string(),
        evidence: z.string().nullable(),
        line: z.int().nullable(),
        source: z.string(),
        occurrences: z.int(),
      }),
    ),
    counts: z.object({ blocker: z.int(), major: z.int(), minor: z.int() }),
  }),
  annotations: {
    readOnlyHint: true,
    // `url` makes this reach the open web; the rest is bundled.
    openWorldHint: true,
  },
} as const;

type Args = z.infer<typeof config.inputSchema>;

function principleById(id: string): UxPrinciple | undefined {
  return guidelines.principles.find((p) => p.id === id);
}

/** Renders one principle as Markdown. */
function renderPrinciple(p: UxPrinciple): string {
  return [
    `### ${p.title}`,
    `\`${p.id}\` · ${p.topic}`,
    '',
    p.principle,
    '',
    `**Why.** ${p.why}`,
    '',
    ...p.rules.map((rule) => `- ${rule}`),
    '',
    `<${p.source}>`,
  ].join('\n');
}

/** Extracts inline `<style>` blocks so a fetched page gets its CSS reviewed too. */
function inlineStyles(html: string): string {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => match[1] ?? '')
    .join('\n');
}

async function fetchPage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { accept: 'text/html' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cf: { cacheTtl: FETCH_CACHE_SECONDS, cacheEverything: true },
  } as RequestInit);

  if (!response.ok) throw new Error(`${url} returned ${response.status}`);

  const body = await response.text();
  if (body.length > MAX_SOURCE) return body.slice(0, MAX_SOURCE);
  return body;
}

const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: '🔴 blocker',
  major: '🟠 major',
  minor: '🟡 minor',
};

function renderFinding(finding: UxFinding, title: string): string {
  const where = finding.line ? ` · ${finding.source} line ${finding.line}` : ` · ${finding.source}`;
  const count = finding.occurrences > 1 ? ` ×${finding.occurrences}` : '';
  return [
    `- **${SEVERITY_LABEL[finding.severity]}**${where}${count} — ${finding.message}`,
    `  - violates *${title}* (\`${finding.principleId}\`)`,
    finding.evidence ? `  - \`${finding.evidence}\`` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

const EMPTY_COUNTS = { blocker: 0, major: 0, minor: 0 };

export async function handler(args: Args) {
  if (args.mode === 'guidelines') {
    const selected = args.topic
      ? guidelines.principles.filter((p) => p.topic === args.topic)
      : guidelines.principles;

    const structured = {
      mode: 'guidelines',
      version: guidelines.version,
      principles: selected,
      reviewed: [],
      findings: [],
      counts: EMPTY_COUNTS,
    };

    const byTopic = new Map<UxTopic, UxPrinciple[]>();
    for (const p of selected) {
      const bucket = byTopic.get(p.topic);
      if (bucket) bucket.push(p);
      else byTopic.set(p.topic, [p]);
    }

    const body = [...byTopic.entries()]
      .map(
        ([topic, list]) =>
          `## ${guidelines.topics[topic]}\n\n${list.map(renderPrinciple).join('\n\n')}`,
      )
      .join('\n\n');

    return ok(
      sections(
        `# ${guidelines.title}`,
        guidelines.premise,
        args.topic ? undefined : `${selected.length} principles across ${byTopic.size} areas.`,
        body,
        'Call this tool again with `mode: "review"` and your HTML/CSS to check a page against these.',
      ),
      structured,
    );
  }

  // --- review ---
  let html = args.html;
  const css = args.css;
  const reviewed: string[] = [];

  if (args.url) {
    try {
      html = await fetchPage(args.url);
      reviewed.push(args.url);
    } catch (error) {
      return fail(`Could not fetch ${args.url}: ${error instanceof Error ? error.message : String(error)}`, {
        mode: 'review',
        version: guidelines.version,
        principles: [],
        reviewed: [],
        findings: [],
        counts: EMPTY_COUNTS,
      });
    }
  }

  if (!html && !css) {
    return fail('Provide `html`, `css`, or a `url` to review.', {
      mode: 'review',
      version: guidelines.version,
      principles: [],
      reviewed: [],
      findings: [],
      counts: EMPTY_COUNTS,
    });
  }

  if (args.html) reviewed.push('html');
  if (css) reviewed.push('css');

  // A fetched page carries its own <style> blocks; review them unless the
  // caller supplied stylesheet source explicitly.
  const effectiveCss = css ?? (html && args.url ? inlineStyles(html) : undefined);
  if (!css && effectiveCss) reviewed.push('inline <style>');

  const findings = reviewUx({ html, css: effectiveCss });

  const counts = { ...EMPTY_COUNTS };
  for (const finding of findings) counts[finding.severity]++;

  const cited = [...new Set(findings.map((f) => f.principleId))]
    .map(principleById)
    .filter((p): p is UxPrinciple => Boolean(p));

  const structured = {
    mode: 'review',
    version: guidelines.version,
    principles: cited,
    reviewed,
    findings: findings.map((finding) => ({
      principleId: finding.principleId,
      principleTitle: principleById(finding.principleId)?.title ?? finding.principleId,
      severity: finding.severity,
      message: finding.message,
      evidence: finding.evidence ?? null,
      line: finding.line ?? null,
      source: finding.source,
      occurrences: finding.occurrences,
    })),
    counts,
  };

  const scope = `Reviewed ${reviewed.join(', ')}.`;

  if (findings.length === 0) {
    return ok(
      sections(
        `✅ Nothing found. ${scope}`,
        'This is a static read of the source. It says nothing about computed contrast, real ' +
          'target sizes, focus order as rendered, or whether the copy is any good — check those ' +
          'yourself.',
      ),
      structured,
    );
  }

  const headline =
    `${findings.length} finding${findings.length === 1 ? '' : 's'}: ` +
    `${counts.blocker} blocker, ${counts.major} major, ${counts.minor} minor. ${scope}`;

  const list = findings
    .map((finding) => renderFinding(finding, principleById(finding.principleId)?.title ?? finding.principleId))
    .join('\n');

  const referenced =
    cited.length > 0
      ? `## Principles cited\n\n${cited.map(renderPrinciple).join('\n\n')}`
      : undefined;

  return ok(
    sections(
      headline,
      list,
      referenced,
      'Static review only: computed contrast, rendered target sizes and real focus order are ' +
        'not measurable from source. A clean result here is a floor, not a pass.',
    ),
    structured,
  );
}
