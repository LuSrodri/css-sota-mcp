/**
 * `whats_new` — lists the CSS features that reached Baseline in a date window.
 */

import { z } from 'zod';
import { buildQuery, searchAllFeatures, type WebStatusFeature } from '../webstatus.js';
import { featureListItem, sections, specLink } from '../format.js';
import { baselineDateOf, dateSchema, daysAgo, ok, today } from './shared.js';

export const name = 'whats_new';

/** Window used when the caller gives no `since`. */
const DEFAULT_WINDOW_DAYS = 180;

export const config = {
  title: "What's new in CSS",
  description:
    'List CSS features that reached Baseline within a date range, newest first. Use this to ' +
    'answer "what CSS can I start using now?", to write release notes, or to catch up after ' +
    'time away. Defaults to the last 180 days. Note that the date used is when a feature ' +
    'became interoperable across browsers, which is often well after it first shipped in one.',
  inputSchema: z.object({
    since: dateSchema
      .optional()
      .describe(
        'Start of the window (YYYY-MM-DD), inclusive. Defaults to 180 days before today.',
      ),
    until: dateSchema
      .optional()
      .describe('End of the window (YYYY-MM-DD), inclusive. Defaults to today.'),
    baseline: z
      .enum(['newly', 'widely', 'any'])
      .default('newly')
      .describe(
        'Which transition to report: "newly" for features that became Baseline Newly available ' +
          '(the usual meaning of new), "widely" for those that crossed into Widely available, ' +
          'or "any" for both.',
      ),
    limit: z.int().min(1).max(100).default(50).describe('Maximum number of features to return.'),
  }),
  outputSchema: z.object({
    since: z.string(),
    until: z.string(),
    query: z.string(),
    count: z.int(),
    truncated: z.boolean(),
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

/**
 * Orders features by their Baseline date, newest first.
 *
 * The dashboard API accepts a `sort` parameter but does not honour it for
 * `baseline_date`, so ordering is done here rather than trusted upstream.
 */
function byBaselineDateDesc(a: WebStatusFeature, b: WebStatusFeature): number {
  const left = baselineDateOf(a) ?? '';
  const right = baselineDateOf(b) ?? '';
  if (left === right) return a.name.localeCompare(b.name);
  return left < right ? 1 : -1;
}

export async function handler(args: Args) {
  const since = args.since ?? daysAgo(DEFAULT_WINDOW_DAYS);
  const until = args.until ?? today();

  if (since > until) {
    return ok(
      `The window is empty: \`since\` (${since}) is after \`until\` (${until}).`,
      { since, until, query: '', count: 0, truncated: false, features: [] },
    );
  }

  const query = buildQuery([
    'group:css',
    `baseline_date:${since}..${until}`,
    args.baseline === 'any' ? undefined : `baseline_status:${args.baseline}`,
  ]);

  const { features, truncated } = await searchAllFeatures({ query, limit: args.limit });
  const sorted = [...features].sort(byBaselineDateDesc);

  const structured = {
    since,
    until,
    query,
    count: sorted.length,
    truncated,
    features: sorted.map((feature) => ({
      id: feature.feature_id,
      name: feature.name,
      baseline: feature.baseline?.status ?? null,
      baselineDate: baselineDateOf(feature) ?? null,
      spec: specLink(feature) ?? null,
    })),
  };

  if (sorted.length === 0) {
    return ok(
      `No CSS features reached Baseline ${args.baseline === 'any' ? '' : `${args.baseline} `}` +
        `between ${since} and ${until}. Try widening the window.`,
      structured,
    );
  }

  // Group by month so a long window reads as a timeline rather than a wall.
  const byMonth = new Map<string, WebStatusFeature[]>();
  for (const feature of sorted) {
    const month = (baselineDateOf(feature) ?? 'unknown').slice(0, 7);
    const bucket = byMonth.get(month);
    if (bucket) bucket.push(feature);
    else byMonth.set(month, [feature]);
  }

  const timeline = [...byMonth.entries()]
    .map(([month, group]) => `### ${month}\n\n${group.map(featureListItem).join('\n')}`)
    .join('\n\n');

  return ok(
    sections(
      `${sorted.length} CSS feature${sorted.length === 1 ? '' : 's'} reached Baseline ` +
        `${args.baseline === 'any' ? '' : `${args.baseline} `}between ${since} and ${until}, newest first:`,
      timeline,
      truncated ? 'More features exist in this window; raise `limit` to see them.' : undefined,
      'Call `get_feature` with a feature id for full details.',
    ),
    structured,
  );
}
