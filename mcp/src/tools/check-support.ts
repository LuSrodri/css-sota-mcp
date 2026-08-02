/**
 * `check_support` — per-browser support for one CSS construct, answered from
 * the bundled browser-compat-data index without a network round trip.
 */

import { z } from 'zod';
import {
  featureIdForBcdKey,
  getBcdEntry,
  getFeature,
  resolveAtRuleKey,
  resolveFunctionKey,
  resolvePropertyKey,
  resolveSelectorKey,
  searchBcdKeys,
} from '../data/index.js';
import { BROWSERS, BROWSER_LABELS, type BrowserId } from '../data/schema.js';
import { baselineLabel, sections, supportCell, supportTable } from '../format.js';
import { decodeEntry } from '../targets.js';
import { fail, ok } from './shared.js';

export const name = 'check_support';

export const config = {
  title: 'Check CSS browser support',
  description:
    'Look up which browser versions support a CSS property, value, selector, at-rule or ' +
    'function, from MDN browser-compat-data bundled with this server (no network call). ' +
    'Give either a BCD key ("css.properties.anchor-name") or a property with an optional ' +
    'value ("display" + "grid"). Also reports vendor prefixes, partial implementations and ' +
    'the Baseline status of the feature the key belongs to.',
  inputSchema: z.object({
    bcd_key: z
      .string()
      .optional()
      .describe(
        'A browser-compat-data key, e.g. "css.properties.text-wrap-style", ' +
          '"css.selectors.has", "css.at-rules.container", "css.types.color.color-mix". ' +
          'Takes precedence over property/value.',
      ),
    property: z
      .string()
      .optional()
      .describe('A CSS property name, e.g. "display", "anchor-name". Used when bcd_key is absent.'),
    value: z
      .string()
      .optional()
      .describe(
        'A value for that property, e.g. "grid" for display. Falls back to the property\'s own ' +
          'support when the value is not tracked separately.',
      ),
    all_browsers: z
      .boolean()
      .default(false)
      .describe(
        'Include every browser in the dataset (Opera, Samsung Internet, WebView, IE) rather ' +
          'than only the seven that determine Baseline.',
      ),
  }),
  outputSchema: z.object({
    resolved: z.boolean(),
    key: z.string().nullable(),
    featureId: z.string().nullable(),
    baseline: z.string().nullable(),
    deprecated: z.boolean(),
    experimental: z.boolean(),
    support: z.record(
      z.string(),
      z.object({
        since: z.string().nullable(),
        prefix: z.string().nullable(),
        alternativeName: z.string().nullable(),
        partial: z.boolean(),
        removedIn: z.string().nullable(),
      }),
    ),
    mdnUrl: z.string().nullable(),
    spec: z.string().nullable(),
    suggestions: z.array(z.string()),
  }),
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
  },
} as const;

type Args = z.infer<typeof config.inputSchema>;

/**
 * Resolves the caller's arguments to a BCD key.
 *
 * An explicit `bcd_key` is used as given. Otherwise the property is tried as a
 * property first, then — because callers reasonably pass `:has` or `color-mix`
 * to a field named "property" — as a selector, at-rule and function in turn.
 */
function resolveKey(args: Args): string | undefined {
  if (args.bcd_key) {
    const key = args.bcd_key.trim();
    return getBcdEntry(key) ? key : undefined;
  }

  const property = args.property?.trim();
  if (!property) return undefined;

  return (
    resolvePropertyKey(property, args.value) ??
    (property.startsWith(':') ? resolveSelectorKey(property) : undefined) ??
    (property.startsWith('@') ? resolveAtRuleKey(property) : undefined) ??
    resolveSelectorKey(property) ??
    resolveAtRuleKey(property) ??
    resolveFunctionKey(property.replace(/\(\)$/, ''))
  );
}

/** Per-browser support, as reported in `structuredContent`. */
interface SupportReport {
  since: string | null;
  prefix: string | null;
  alternativeName: string | null;
  partial: boolean;
  removedIn: string | null;
}

/**
 * The structured half of a failed lookup.
 *
 * Typed rather than inferred so that `support` stays a record here and in the
 * success path; otherwise it narrows to `{}` and callers cannot index it.
 */
const EMPTY_STRUCTURED: {
  resolved: boolean;
  key: string | null;
  featureId: string | null;
  baseline: string | null;
  deprecated: boolean;
  experimental: boolean;
  support: Record<string, SupportReport>;
  mdnUrl: string | null;
  spec: string | null;
} = {
  resolved: false,
  key: null,
  featureId: null,
  baseline: null,
  deprecated: false,
  experimental: false,
  support: {},
  mdnUrl: null,
  spec: null,
};

export async function handler(args: Args) {
  if (!args.bcd_key && !args.property) {
    return fail('Provide either `bcd_key`, or `property` (optionally with `value`).', {
      ...EMPTY_STRUCTURED,
      suggestions: [],
    });
  }

  const key = resolveKey(args);

  if (!key) {
    const searchTerm = args.bcd_key ?? [args.property, args.value].filter(Boolean).join(' ');
    const suggestions = searchBcdKeys(searchTerm, 10);
    return fail(
      sections(
        `No browser-compat-data entry found for ${
          args.bcd_key ? `key \`${args.bcd_key}\`` : `\`${args.property}${args.value ? `: ${args.value}` : ''}\``
        }.`,
        suggestions.length > 0
          ? `Closest keys:\n${suggestions.map((s) => `- \`${s}\``).join('\n')}`
          : 'Check the spelling, or use `search_css_features` to find the feature first.',
      ),
      { ...EMPTY_STRUCTURED, suggestions },
    );
  }

  const entry = getBcdEntry(key)!;
  const support = decodeEntry(entry);
  const featureId = entry.f ?? featureIdForBcdKey(key);
  const feature = featureId ? getFeature(featureId) : undefined;

  const browsers: BrowserId[] = args.all_browsers
    ? [...BROWSERS]
    : ['chrome', 'chrome_android', 'edge', 'firefox', 'firefox_android', 'safari', 'safari_ios'];

  const structuredSupport: Record<string, SupportReport> = {};
  for (const browser of browsers) {
    const value = support[browser];
    structuredSupport[browser] = {
      since: value.since,
      prefix: value.prefix ?? null,
      alternativeName: value.alternativeName ?? null,
      partial: value.partial ?? false,
      removedIn: value.removed ?? null,
    };
  }

  const structured = {
    resolved: true,
    key,
    featureId: featureId ?? null,
    baseline: feature?.s ?? null,
    deprecated: entry.d === 1,
    experimental: entry.x === 1,
    support: structuredSupport,
    mdnUrl: entry.u ? `https://developer.mozilla.org/docs/${entry.u}` : null,
    spec: entry.p ?? null,
    suggestions: [],
  };

  const warnings: string[] = [];
  if (entry.d === 1) warnings.push('⚠️ This entry is **deprecated** — avoid it in new code.');
  if (entry.x === 1) warnings.push('⚠️ This entry is **experimental** and may still change.');

  const prefixed = browsers.filter((b) => support[b].prefix);
  if (prefixed.length > 0) {
    warnings.push(
      `⚠️ Requires a vendor prefix in ${prefixed
        .map((b) => `${BROWSER_LABELS[b]} (${support[b].prefix})`)
        .join(', ')}.`,
    );
  }
  const partial = browsers.filter((b) => support[b].partial);
  if (partial.length > 0) {
    warnings.push(
      `⚠️ Partially implemented in ${partial.map((b) => BROWSER_LABELS[b]).join(', ')}.`,
    );
  }
  const removed = browsers.filter((b) => support[b].removed);
  if (removed.length > 0) {
    warnings.push(
      `⚠️ Removed in ${removed.map((b) => `${BROWSER_LABELS[b]} ${support[b].removed}`).join(', ')}.`,
    );
  }

  const baselineLine = feature
    ? `Part of **${feature.n}** (\`${featureId}\`) — ${baselineLabel(feature.s, feature.l, feature.h)}.`
    : undefined;

  const unsupported = browsers.filter((b) => support[b].since === null);
  const headline =
    unsupported.length === 0
      ? 'Supported in every browser listed below.'
      : `Not supported in ${unsupported.map((b) => BROWSER_LABELS[b]).join(', ')}.`;

  return ok(
    sections(
      `# \`${key}\`\n\n${headline}`,
      baselineLine,
      supportTable(entry, browsers),
      warnings.length > 0 ? warnings.join('\n\n') : undefined,
      sections(
        structured.mdnUrl ? `**MDN**: <${structured.mdnUrl}>` : undefined,
        entry.p ? `**Spec**: <${entry.p}>` : undefined,
        featureId ? `Call \`get_feature\` with \`${featureId}\` for the full picture.` : undefined,
      ),
    ),
    structured,
  );
}

export { supportCell };
