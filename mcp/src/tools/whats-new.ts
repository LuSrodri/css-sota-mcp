/**
 * `whats_new` — lists the CSS features that crossed a Baseline threshold in a
 * date window.
 *
 * The dashboard's `baseline_date` term filters on a feature's *low* date — when
 * it became Baseline Newly available — and nothing else. Two consequences shape
 * this tool, both verified against the live API rather than assumed:
 *
 * 1. `baseline_status` filters on a feature's status *today*, not on a
 *    transition. Combining `baseline_date:2022-01-01..2022-12-31` with
 *    `baseline_status:newly` returns nothing at all, because everything that
 *    went Newly in 2022 has since graduated to Widely. The newly listing
 *    therefore applies no status filter — the date range already says it.
 * 2. There is no query term for the Widely transition. Since Widely is reached
 *    30 months after Newly, that listing queries a low-date window offset by
 *    roughly that much and then filters precisely on `high_date` here.
 */

import { z } from 'zod';
import { buildQuery, searchAllFeatures, type WebStatusFeature } from '../webstatus.js';
import { baselineMarker, sections, specLink } from '../format.js';
import { dateSchema, daysAgo, ok, shiftMonths, today } from './shared.js';

export const name = 'whats_new';

/** Window used when the caller gives no `since`. */
const DEFAULT_WINDOW_DAYS = 180;

/**
 * Months between the Newly and Widely thresholds.
 *
 * The window queried for Widely transitions is padded either side of this so a
 * change to the rule degrades into extra rows filtered out here, rather than
 * into silently missing results.
 */
const WIDELY_OFFSET_MONTHS = 30;
const WIDELY_OFFSET_SLACK = 6;

export const config = {
  title: "What's new in CSS",
  description:
    'List CSS features that crossed a Baseline threshold within a date range, newest first. ' +
    'Use this to answer "what CSS can I start using now?", to write release notes, or to catch ' +
    'up after time away. Defaults to the last 180 days. The date is when a feature became ' +
    'interoperable across browsers, which is usually well after it first shipped in one.',
  inputSchema: z.object({
    since: dateSchema
      .optional()
      .describe('Start of the window (YYYY-MM-DD), inclusive. Defaults to 180 days before today.'),
    until: dateSchema
      .optional()
      .describe('End of the window (YYYY-MM-DD), inclusive. Defaults to today.'),
    transition: z
      .enum(['newly', 'widely', 'any'])
      .default('newly')
      .describe(
        'Which threshold was crossed in the window: "newly" for features that became ' +
          'interoperable across all major engines (the usual meaning of new), "widely" for those ' +
          'that reached the 30-month Widely available mark, or "any" for both.',
      ),
    limit: z.int().min(1).max(100).default(50).describe('Maximum number of features to return.'),
  }),
  outputSchema: z.object({
    since: z.string(),
    until: z.string(),
    count: z.int(),
    truncated: z.boolean(),
    features: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        transition: z.enum(['newly', 'widely']),
        date: z.string(),
        baseline: z.string().nullable(),
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
type Transition = 'newly' | 'widely';

/** One feature paired with the transition that landed it in the window. */
interface Crossing {
  feature: WebStatusFeature;
  transition: Transition;
  date: string;
}

/**
 * Features that became Baseline Newly available in the window.
 *
 * No `baseline_status` term: `baseline_date` already means "reached Newly in
 * this range", and filtering on today's status would drop everything that has
 * since graduated.
 */
async function newlyCrossings(since: string, until: string, limit: number) {
  const { features, truncated } = await searchAllFeatures({
    query: buildQuery(['group:css', `baseline_date:${since}..${until}`]),
    limit,
  });

  const crossings = features
    .filter((feature) => feature.baseline?.low_date)
    .map<Crossing>((feature) => ({
      feature,
      transition: 'newly',
      date: feature.baseline!.low_date!,
    }));

  return { crossings, truncated };
}

/**
 * Features that reached Baseline Widely available in the window.
 *
 * Queried by the low date that would put a feature's Widely date in range, then
 * filtered exactly on `high_date`.
 */
async function widelyCrossings(since: string, until: string, limit: number) {
  const lowSince = shiftMonths(since, -(WIDELY_OFFSET_MONTHS + WIDELY_OFFSET_SLACK));
  const lowUntil = shiftMonths(until, -(WIDELY_OFFSET_MONTHS - WIDELY_OFFSET_SLACK));

  const { features, truncated } = await searchAllFeatures({
    query: buildQuery([
      'group:css',
      'baseline_status:widely',
      `baseline_date:${lowSince}..${lowUntil}`,
    ]),
    // The padded window overshoots, so fetch generously and trim after filtering.
    limit: Math.min(limit * 3, 100),
  });

  const crossings = features
    .filter((feature) => {
      const high = feature.baseline?.high_date;
      return Boolean(high && high >= since && high <= until);
    })
    .map<Crossing>((feature) => ({
      feature,
      transition: 'widely',
      date: feature.baseline!.high_date!,
    }));

  return { crossings, truncated };
}

/** One line summarising a crossing. */
function crossingLine(crossing: Crossing): string {
  const verb = crossing.transition === 'widely' ? 'Widely' : 'Newly';
  return (
    `- ${baselineMarker(crossing.feature.baseline?.status)} **${crossing.feature.name}** ` +
    `\`${crossing.feature.feature_id}\` — ${verb} on ${crossing.date}`
  );
}

export async function handler(args: Args) {
  const since = args.since ?? daysAgo(DEFAULT_WINDOW_DAYS);
  const until = args.until ?? today();

  if (since > until) {
    return ok(`The window is empty: \`since\` (${since}) is after \`until\` (${until}).`, {
      since,
      until,
      count: 0,
      truncated: false,
      features: [],
    });
  }

  const wantNewly = args.transition === 'newly' || args.transition === 'any';
  const wantWidely = args.transition === 'widely' || args.transition === 'any';

  const [newly, widely] = await Promise.all([
    wantNewly ? newlyCrossings(since, until, args.limit) : Promise.resolve(undefined),
    wantWidely ? widelyCrossings(since, until, args.limit) : Promise.resolve(undefined),
  ]);

  const crossings = [...(newly?.crossings ?? []), ...(widely?.crossings ?? [])].sort(
    (a, b) => (a.date === b.date ? a.feature.name.localeCompare(b.feature.name) : a.date < b.date ? 1 : -1),
  );

  const trimmed = crossings.slice(0, args.limit);
  const truncated =
    Boolean(newly?.truncated) || Boolean(widely?.truncated) || crossings.length > args.limit;

  const structured = {
    since,
    until,
    count: trimmed.length,
    truncated,
    features: trimmed.map((crossing) => ({
      id: crossing.feature.feature_id,
      name: crossing.feature.name,
      transition: crossing.transition,
      date: crossing.date,
      baseline: crossing.feature.baseline?.status ?? null,
      spec: specLink(crossing.feature) ?? null,
    })),
  };

  if (trimmed.length === 0) {
    return ok(
      `No CSS features crossed the Baseline ${args.transition === 'any' ? '' : `${args.transition} `}` +
        `threshold between ${since} and ${until}. Try widening the window.`,
      structured,
    );
  }

  // Group by month so a long window reads as a timeline rather than a wall.
  const byMonth = new Map<string, Crossing[]>();
  for (const crossing of trimmed) {
    const month = crossing.date.slice(0, 7);
    const bucket = byMonth.get(month);
    if (bucket) bucket.push(crossing);
    else byMonth.set(month, [crossing]);
  }

  const timeline = [...byMonth.entries()]
    .map(([month, group]) => `### ${month}\n\n${group.map(crossingLine).join('\n')}`)
    .join('\n\n');

  const what =
    args.transition === 'any'
      ? 'crossed a Baseline threshold'
      : `became Baseline ${args.transition === 'widely' ? 'Widely' : 'Newly'} available`;

  return ok(
    sections(
      `${trimmed.length} CSS feature${trimmed.length === 1 ? '' : 's'} ${what} between ` +
        `${since} and ${until}, newest first:`,
      timeline,
      truncated ? 'More features exist in this window; raise `limit` to see them.' : undefined,
      'Call `get_feature` with a feature id for full details.',
    ),
    structured,
  );
}
