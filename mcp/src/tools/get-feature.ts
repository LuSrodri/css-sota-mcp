/**
 * `get_feature` — full detail for one CSS feature, combining the live dashboard
 * record, the bundled `web-features` catalog and MDN reference prose.
 */

import { z } from 'zod';
import { getFeatureById, type WebStatusFeature } from '../webstatus.js';
import { fetchMdnDoc, type MdnDoc } from '../mdn.js';
import { getBcdEntry, getFeature as getLocalFeature, resolveFeatureId, searchFeatures } from '../data/index.js';
import { baselineLabel, implementationTable, sections, specLink, usageLabel } from '../format.js';
import { fail, ok } from './shared.js';
import type { FeatureEntry } from '../data/schema.js';

export const name = 'get_feature';

/** How many BCD keys to list before summarising the rest. */
const MAX_LISTED_KEYS = 12;

export const config = {
  title: 'Get CSS feature details',
  description:
    'Get everything known about one CSS feature: Baseline status and dates, the browser ' +
    'versions it shipped in, its description, spec links, Web Platform Tests scores, usage, ' +
    'and MDN reference prose. Accepts a web-features id ("container-queries") or a display ' +
    'name ("Container queries"). Use search_css_features first if you do not know the id.',
  inputSchema: z.object({
    feature_id: z
      .string()
      .min(1)
      .max(120)
      .describe(
        'The web-features id, e.g. "anchor-positioning", "container-queries", "subgrid". ' +
          'A display name such as "Anchor positioning" also works.',
      ),
    include_mdn: z
      .boolean()
      .default(true)
      .describe('Fetch MDN reference prose for the feature. Set false for a faster, terser answer.'),
  }),
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    found: z.boolean(),
    description: z.string().nullable(),
    baseline: z.string().nullable(),
    baselineLowDate: z.string().nullable(),
    baselineHighDate: z.string().nullable(),
    spec: z.array(z.string()),
    browsers: z.record(
      z.string(),
      z.object({ version: z.string().nullable(), date: z.string().nullable() }),
    ),
    bcdKeys: z.array(z.string()),
    caniuse: z.array(z.string()),
    mdnUrl: z.string().nullable(),
    suggestions: z.array(z.string()),
  }),
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
} as const;

type Args = z.infer<typeof config.inputSchema>;

function specUrls(local: FeatureEntry | undefined, remote: WebStatusFeature | undefined): string[] {
  const urls = new Set<string>();
  const fromLocal = local?.p;
  if (typeof fromLocal === 'string') urls.add(fromLocal);
  else if (Array.isArray(fromLocal)) for (const url of fromLocal) urls.add(url);
  const fromRemote = specLink(remote ?? ({} as WebStatusFeature));
  if (fromRemote) urls.add(fromRemote);
  return [...urls];
}

function asArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Picks the BCD key whose MDN page best represents the feature.
 *
 * A feature spans many keys; the shortest one carrying an `mdn_url` is the most
 * general — `css.properties.anchor-name` rather than
 * `css.properties.anchor-name.none`.
 */
function primaryMdnReference(bcdKeys: string[]): string | undefined {
  const documented = bcdKeys
    .map((key) => ({ key, url: getBcdEntry(key)?.u }))
    .filter((entry): entry is { key: string; url: string } => Boolean(entry.url))
    .sort((a, b) => a.key.length - b.key.length);
  return documented[0]?.url;
}

export async function handler(args: Args) {
  const requested = args.feature_id.trim();
  const localId = resolveFeatureId(requested);
  const lookupId = localId ?? requested;

  const remote = await getFeatureById(lookupId);
  const local = localId ? getLocalFeature(localId) : undefined;

  if (!remote && !local) {
    const suggestions = searchFeatures(requested, 8);
    return fail(
      sections(
        `No CSS feature found for \`${requested}\`.`,
        suggestions.length > 0
          ? `Did you mean:\n${suggestions.map((id) => `- \`${id}\` — ${getLocalFeature(id)?.n ?? ''}`).join('\n')}`
          : 'Try `search_css_features` with a keyword to find the right id.',
      ),
      {
        id: requested,
        name: requested,
        found: false,
        description: null,
        baseline: null,
        baselineLowDate: null,
        baselineHighDate: null,
        spec: [],
        browsers: {},
        bcdKeys: [],
        caniuse: [],
        mdnUrl: null,
        suggestions,
      },
    );
  }

  const id = localId ?? remote?.feature_id ?? requested;
  const displayName = remote?.name ?? local?.n ?? id;

  // The dashboard is authoritative for status because it is live; the bundled
  // catalog only fills in when the API did not answer.
  const baseline = remote?.baseline?.status ?? local?.s ?? null;
  const lowDate = remote?.baseline?.low_date ?? local?.l ?? null;
  const highDate = remote?.baseline?.high_date ?? local?.h ?? null;

  const bcdKeys = local?.c ?? [];
  const mdnReference = primaryMdnReference(bcdKeys);

  let mdn: MdnDoc | undefined;
  if (args.include_mdn && mdnReference) {
    mdn = await fetchMdnDoc(mdnReference);
  }

  const browsers: Record<string, { version: string | null; date: string | null }> = {};
  for (const [browser, implementation] of Object.entries(remote?.browser_implementations ?? {})) {
    if (implementation?.status !== 'available') continue;
    browsers[browser] = {
      version: implementation.version ?? null,
      date: implementation.date ?? null,
    };
  }

  const specs = specUrls(local, remote);

  const structured = {
    id,
    name: displayName,
    found: true,
    description: local?.d ?? null,
    baseline,
    baselineLowDate: lowDate,
    baselineHighDate: highDate,
    spec: specs,
    browsers,
    bcdKeys,
    caniuse: asArray(local?.ci),
    mdnUrl: mdn?.url ?? (mdnReference ? `https://developer.mozilla.org/docs/${mdnReference}` : null),
    suggestions: [],
  };

  const keyList =
    bcdKeys.length === 0
      ? undefined
      : bcdKeys.length <= MAX_LISTED_KEYS
        ? `**Compat keys** (use with \`check_support\`):\n${bcdKeys.map((key) => `- \`${key}\``).join('\n')}`
        : `**Compat keys**: ${bcdKeys.length} total, including ` +
          `${bcdKeys.slice(0, MAX_LISTED_KEYS).map((key) => `\`${key}\``).join(', ')}. ` +
          `Pass any of them to \`check_support\`.`;

  const usage = remote ? usageLabel(remote) : undefined;
  const implementations = remote ? implementationTable(remote) : '';

  return ok(
    sections(
      `# ${displayName}\n\n\`${id}\` — ${baselineLabel(baseline as never, lowDate ?? undefined, highDate ?? undefined)}`,
      local?.d,
      implementations && `**Browser support**\n\n${implementations}`,
      usage && `**Usage**: ${usage}.`,
      mdn?.body ? `**From MDN**\n\n${mdn.body}` : mdn?.summary && `**From MDN**: ${mdn.summary}`,
      keyList,
      sections(
        specs.length > 0 ? `**Spec**: ${specs.map((url) => `<${url}>`).join(', ')}` : undefined,
        structured.mdnUrl ? `**MDN**: <${structured.mdnUrl}>` : undefined,
        `**Dashboard**: <https://webstatus.dev/features/${encodeURIComponent(id)}>`,
      ),
    ),
    structured,
  );
}
