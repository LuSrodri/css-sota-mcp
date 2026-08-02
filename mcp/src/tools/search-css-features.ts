/**
 * `search_css_features` — finds CSS features on the Web Platform Dashboard by
 * free text, Baseline status and the date they reached Baseline.
 */

import { z } from 'zod';
import { buildQuery, quoteQueryValue, searchAllFeatures, type WebStatusFeature } from '../webstatus.js';
import { baselineLabel, featureListItem, sections } from '../format.js';
import { baselineDateOf, baselineDateTerm, baselineSchema, dateSchema, ok } from './shared.js';

export const name = 'search_css_features';

export const config = {
  title: 'Search CSS features',
  description:
    'Search CSS features on the Web Platform Dashboard (webstatus.dev) by keyword, Baseline ' +
    'status, and the date range in which they reached Baseline. Use this to answer questions ' +
    'like "which CSS features for scroll animations are Baseline yet?" or "what limited-support ' +
    'CSS is there for anchoring?". Returns live Baseline data. For the browser versions a ' +
    'specific property shipped in, use check_support instead.',
  inputSchema: z.object({
    query: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Free-text search over feature names and descriptions, e.g. "container queries", ' +
          '"anchor", "scroll". Omit to list all CSS features matching the other filters.',
      ),
    baseline: baselineSchema
      .optional()
      .describe(
        'Filter by Baseline status: "widely" (interoperable for 30+ months, safe to use), ' +
          '"newly" (interoperable across all major engines recently), or "limited" (not yet ' +
          'available across all major engines).',
      ),
    since: dateSchema
      .optional()
      .describe('Only features that reached Baseline on or after this date (YYYY-MM-DD).'),
    until: dateSchema
      .optional()
      .describe('Only features that reached Baseline on or before this date (YYYY-MM-DD).'),
    limit: z
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Maximum number of features to return.'),
  }),
  outputSchema: z.object({
    query: z.string().describe('The dashboard query that was executed.'),
    total: z.int().optional().describe('Total matches upstream, across all pages.'),
    truncated: z.boolean().describe('Whether more matches exist than were returned.'),
    features: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        baseline: z.string().nullable(),
        baselineDate: z.string().nullable(),
        spec: z.string().nullable(),
      }),
    ),
  }),
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
} as const;

type Args = z.infer<typeof config.inputSchema>;

function toStructured(feature: WebStatusFeature) {
  return {
    id: feature.feature_id,
    name: feature.name,
    baseline: feature.baseline?.status ?? null,
    baselineDate: baselineDateOf(feature) ?? null,
    spec: feature.spec?.links?.find((link) => link.link)?.link ?? null,
  };
}

export async function handler(args: Args) {
  const query = buildQuery([
    // Every tool in this server is about CSS, so the group filter is implicit
    // rather than something the caller has to remember.
    'group:css',
    args.query ? quoteQueryValue(args.query) : undefined,
    args.baseline ? `baseline_status:${args.baseline}` : undefined,
    baselineDateTerm(args.since, args.until),
  ]);

  const { features, total, truncated } = await searchAllFeatures({ query, limit: args.limit });

  const structured = {
    query,
    ...(total !== undefined ? { total } : {}),
    truncated,
    features: features.map(toStructured),
  };

  if (features.length === 0) {
    return ok(
      sections(
        `No CSS features matched \`${query}\`.`,
        'Try a broader keyword, drop the Baseline filter, or widen the date range.',
      ),
      structured,
    );
  }

  const header =
    total !== undefined && total > features.length
      ? `Showing ${features.length} of ${total} CSS features matching \`${query}\`:`
      : `${features.length} CSS feature${features.length === 1 ? '' : 's'} matching \`${query}\`:`;

  const body = features.map(featureListItem).join('\n');

  const counts = new Map<string, number>();
  for (const feature of features) {
    const status = feature.baseline?.status ?? 'unknown';
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .map(([status, count]) => `${count} ${baselineLabel(status as never).replace(/ \(.*\)$/, '')}`)
    .join(', ');

  return ok(
    sections(
      header,
      body,
      summary && `Breakdown: ${summary}.`,
      truncated ? 'More matches exist upstream; narrow the query or raise `limit`.' : undefined,
      'Call `get_feature` with a feature id for full details.',
    ),
    structured,
  );
}
