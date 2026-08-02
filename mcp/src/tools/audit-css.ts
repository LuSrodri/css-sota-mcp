/**
 * `audit_css` — scans a stylesheet and reports which of the features it uses
 * fall short of a browser or Baseline target.
 */

import { z } from 'zod';
import { scanCss, type CssUsage } from '../css-scan.js';
import {
  featureIdForBcdKey,
  getBcdEntry,
  getFeature,
  resolveAtRuleKey,
  resolveFunctionKey,
  resolvePropertyKey,
  resolveSelectorKey,
} from '../data/index.js';
import { BROWSER_LABELS } from '../data/schema.js';
import type { BcdEntry, BrowserId } from '../data/schema.js';
import { baselineLabel, sections, supportCell } from '../format.js';
import {
  BASELINE_BROWSERS,
  checkBrowserTargets,
  decodeEntry,
  describeTargets,
  parseTargets,
  TargetParseError,
  type BrowserVerdict,
  type Targets,
} from '../targets.js';
import { fail, ok } from './shared.js';

export const name = 'audit_css';

/** Cap on input size; well past any hand-written stylesheet. */
const MAX_SOURCE_CHARS = 400_000;

/** Findings listed individually before the report switches to a summary. */
const MAX_LISTED_FINDINGS = 40;

export const config = {
  title: 'Audit CSS against browser targets',
  description:
    'Scan CSS source and report every feature in it that does not meet a browser support ' +
    'target. Targets are either a Baseline level ("baseline-widely", "baseline-newly") or an ' +
    'explicit browser list ("chrome 120, safari 17.4, firefox 128"). Reports the offending ' +
    'line, what is wrong (unsupported, too old, prefix-only, partial), and the minimum ' +
    'version that would work. Browserslist queries like "last 2 versions" are not supported. ' +
    'IMPORTANT when reading Baseline-level results: Baseline describes a whole feature, and a ' +
    'feature can be "Limited" because one part of it is not interoperable while the exact ' +
    'declaration you wrote works everywhere. "Cursor styles" is Limited, so `cursor: pointer` ' +
    'is reported — yet it only lacks iOS Safari, where a cursor is meaningless rather than ' +
    'broken. Each finding therefore also names the browsers missing that specific key, or says ' +
    'that the key ships everywhere and the status comes from elsewhere in the feature. Read ' +
    'that line before removing anything: a key that ships everywhere is still not proof the ' +
    'code works, since it may be inert without the parts that do not.',
  inputSchema: z.object({
    source: z
      .string()
      .min(1)
      .max(MAX_SOURCE_CHARS)
      .describe('The CSS source to audit. Malformed CSS is tolerated and scanned best-effort.'),
    target: z
      .string()
      .default('baseline-widely')
      .describe(
        'Support target. Either a Baseline level ("baseline-widely", "baseline-newly") or a ' +
          'comma-separated browser list ("chrome 120, safari 17.4, firefox 128"). Known ' +
          'browsers: chrome, chrome_android, edge, firefox, firefox_android, safari, ' +
          'safari_ios, opera, opera_android, samsunginternet_android, webview_android, ie.',
      ),
    include_passing: z
      .boolean()
      .default(false)
      .describe('Also list the features that meet the target, not just the ones that fail.'),
  }),
  outputSchema: z.object({
    target: z.string(),
    featuresChecked: z.int(),
    failing: z.int(),
    unknown: z.int(),
    findings: z.array(
      z.object({
        key: z.string(),
        featureId: z.string().nullable(),
        kind: z.string(),
        name: z.string(),
        line: z.int(),
        occurrences: z.int(),
        snippet: z.string(),
        status: z.enum(['pass', 'fail', 'unknown']),
        reasons: z.array(z.string()),
        baseline: z.string().nullable(),
      }),
    ),
  }),
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
  },
} as const;

type Args = z.infer<typeof config.inputSchema>;

/** A distinct feature use, after mapping usages onto compat keys. */
interface Candidate {
  key: string;
  usage: CssUsage;
  occurrences: number;
}

/**
 * Maps one scanned usage onto a compat key.
 *
 * Value idents only produce a candidate when BCD tracks that value separately;
 * otherwise the value's support is the property's support, which the property
 * usage already covers, and reporting it again would double-count.
 */
function keyForUsage(usage: CssUsage): string | undefined {
  switch (usage.kind) {
    case 'property':
      return resolvePropertyKey(usage.name);
    case 'value': {
      if (!usage.property) return undefined;
      const key = `css.properties.${usage.property.toLowerCase()}.${usage.name}`;
      return getBcdEntry(key) ? key : undefined;
    }
    case 'at-rule':
      return resolveAtRuleKey(usage.name);
    case 'selector':
      return resolveSelectorKey(usage.name);
    case 'function':
      return resolveFunctionKey(usage.name);
    default:
      return undefined;
  }
}

/**
 * Collapses scanned usages into one candidate per compat key, keeping the first
 * occurrence for reporting and counting the rest.
 */
function collectCandidates(usages: CssUsage[]): Candidate[] {
  const byKey = new Map<string, Candidate>();

  for (const usage of usages) {
    const key = keyForUsage(usage);
    if (!key) continue;

    const existing = byKey.get(key);
    if (existing) existing.occurrences++;
    else byKey.set(key, { key, usage, occurrences: 1 });
  }

  return [...byKey.values()];
}

/** Human-readable description of why a browser verdict failed. */
function explainVerdict(verdict: BrowserVerdict): string {
  const label = `${BROWSER_LABELS[verdict.browser]} ${verdict.targetVersion}`;
  switch (verdict.reason) {
    case 'unsupported':
      return `${label}: not supported at all`;
    case 'too-old':
      return `${label}: needs ${verdict.support.since}+`;
    case 'removed':
      return `${label}: removed in ${verdict.support.removed}`;
    case 'prefix-only':
      return `${label}: only with the ${verdict.support.prefix} prefix`;
    case 'partial':
      return `${label}: partial implementation`;
    default:
      return label;
  }
}

interface Finding {
  key: string;
  featureId: string | null;
  kind: string;
  name: string;
  line: number;
  occurrences: number;
  snippet: string;
  status: 'pass' | 'fail' | 'unknown';
  reasons: string[];
  baseline: string | null;
}

/** Judges one candidate against an explicit browser list. */
function judgeBrowsers(candidate: Candidate, entry: BcdEntry, targets: Targets & { kind: 'browsers' }): Finding {
  const verdicts = checkBrowserTargets(entry, targets.entries);
  const failures = verdicts.filter((verdict) => verdict.reason);
  const featureId = entry.f ?? featureIdForBcdKey(candidate.key) ?? null;

  return {
    key: candidate.key,
    featureId,
    kind: candidate.usage.kind,
    name: candidate.usage.name,
    line: candidate.usage.line,
    occurrences: candidate.occurrences,
    snippet: candidate.usage.snippet,
    status: failures.length > 0 ? 'fail' : 'pass',
    reasons: failures.map(explainVerdict),
    baseline: featureId ? (getFeature(featureId)?.s ?? null) : null,
  };
}

/**
 * Judges one candidate against a Baseline level.
 *
 * Baseline is a property of a *feature*, not of a compat key, so a key with no
 * owning feature cannot be judged this way. Rather than guess, such keys are
 * reported as `unknown` alongside the raw support data — silently passing them
 * would hide exactly the novel features an audit exists to catch.
 */
function judgeBaseline(candidate: Candidate, entry: BcdEntry, level: 'newly' | 'widely'): Finding {
  const featureId = entry.f ?? featureIdForBcdKey(candidate.key) ?? null;
  const feature = featureId ? getFeature(featureId) : undefined;

  const base: Omit<Finding, 'status' | 'reasons' | 'baseline'> = {
    key: candidate.key,
    featureId,
    kind: candidate.usage.kind,
    name: candidate.usage.name,
    line: candidate.usage.line,
    occurrences: candidate.occurrences,
    snippet: candidate.usage.snippet,
  };

  if (!feature) {
    const support = decodeEntry(entry);
    const missing = BASELINE_BROWSERS.filter((browser) => support[browser].since === null);
    return {
      ...base,
      status: missing.length > 0 ? 'unknown' : 'pass',
      baseline: null,
      reasons:
        missing.length > 0
          ? [
              `not mapped to a Baseline feature; unsupported in ${missing
                .map((browser) => BROWSER_LABELS[browser])
                .join(', ')}`,
            ]
          : [],
    };
  }

  const meets = level === 'widely' ? feature.s === 'widely' : feature.s === 'widely' || feature.s === 'newly';

  if (meets) {
    return { ...base, status: 'pass', baseline: feature.s, reasons: [] };
  }

  // A Baseline status describes the whole feature, and features are coarse:
  // "Cursor styles" covers 39 compat keys, so `cursor: pointer` inherits
  // Limited from whichever of them is not interoperable. Reporting only the
  // feature's status invites the reader to delete a declaration that has worked
  // everywhere for twenty years, so the gap for *this* key is spelled out too.
  const support = decodeEntry(entry);
  const missing = BASELINE_BROWSERS.filter((browser) => support[browser].since === null);

  const reasons = [`${feature.n} is ${baselineLabel(feature.s, feature.l, feature.h)}`];
  reasons.push(
    missing.length > 0
      ? `\`${candidate.key}\` specifically is unsupported in ${missing
          .map((browser) => BROWSER_LABELS[browser])
          .join(', ')}`
      : // Deliberately not "safe to keep". The key shipping everywhere does not
        // mean the code is fine: `anchor-name` is in every Baseline browser, but
        // it is inert without the parts of anchor positioning that are not, so a
        // blanket reassurance here would be worse than the coarse status it is
        // trying to correct. State the fact and name the question instead.
        `\`${candidate.key}\` specifically is supported in every Baseline browser; the ` +
        `feature's status comes from other parts of it. Check whether your usage depends ` +
        `on those`,
  );

  return { ...base, status: 'fail', baseline: feature.s, reasons };
}

/** Renders one failing or unknown finding. */
function renderFinding(finding: Finding): string {
  const head = `- **line ${finding.line}** \`${finding.name}\` (${finding.kind}) — \`${finding.key}\``;
  const count = finding.occurrences > 1 ? ` ×${finding.occurrences}` : '';
  const reasons = finding.reasons.map((reason) => `\n  - ${reason}`).join('');
  return `${head}${count}${reasons}\n  - \`${finding.snippet}\``;
}

export async function handler(args: Args) {
  let targets: Targets;
  try {
    targets = parseTargets(args.target);
  } catch (error) {
    if (error instanceof TargetParseError) {
      return fail(error.message, {
        target: args.target,
        featuresChecked: 0,
        failing: 0,
        unknown: 0,
        findings: [],
      });
    }
    throw error;
  }

  const usages = scanCss(args.source);
  const candidates = collectCandidates(usages);

  const findings: Finding[] = [];
  for (const candidate of candidates) {
    const entry = getBcdEntry(candidate.key);
    if (!entry) continue;
    findings.push(
      targets.kind === 'browsers'
        ? judgeBrowsers(candidate, entry, targets)
        : judgeBaseline(candidate, entry, targets.level),
    );
  }

  const failing = findings.filter((finding) => finding.status === 'fail');
  const unknown = findings.filter((finding) => finding.status === 'unknown');
  const passing = findings.filter((finding) => finding.status === 'pass');

  // Worst offenders first: most-broken, then earliest in the file.
  const bySeverity = (a: Finding, b: Finding) =>
    b.reasons.length - a.reasons.length || a.line - b.line;
  failing.sort(bySeverity);
  unknown.sort(bySeverity);

  const structured = {
    target: describeTargets(targets),
    featuresChecked: findings.length,
    failing: failing.length,
    unknown: unknown.length,
    findings: args.include_passing ? [...failing, ...unknown, ...passing] : [...failing, ...unknown],
  };

  if (findings.length === 0) {
    return ok(
      sections(
        `Audited against **${describeTargets(targets)}**.`,
        'No recognisable CSS features were found in the source. If this is a stylesheet, it may ' +
          'use only features this server does not track; if it is not CSS, check the input.',
      ),
      structured,
    );
  }

  const headline =
    failing.length === 0
      ? `✅ All ${findings.length} recognised features meet **${describeTargets(targets)}**.`
      : `❌ ${failing.length} of ${findings.length} recognised features fall short of **${describeTargets(targets)}**.`;

  const failSection =
    failing.length > 0
      ? `## Failing\n\n${failing.slice(0, MAX_LISTED_FINDINGS).map(renderFinding).join('\n')}${
          failing.length > MAX_LISTED_FINDINGS
            ? `\n\n…and ${failing.length - MAX_LISTED_FINDINGS} more.`
            : ''
        }`
      : undefined;

  const unknownSection =
    unknown.length > 0
      ? `## Not Baseline-classified\n\nThese are not mapped to a Baseline feature, so they could ` +
        `not be judged against the target. Their raw compat data is shown instead.\n\n${unknown
          .slice(0, MAX_LISTED_FINDINGS)
          .map(renderFinding)
          .join('\n')}`
      : undefined;

  const passSection =
    args.include_passing && passing.length > 0
      ? `## Passing\n\n${passing
          .map((finding) => `- \`${finding.name}\` (${finding.kind}) — \`${finding.key}\``)
          .join('\n')}`
      : failing.length > 0 || unknown.length > 0
        ? `${passing.length} feature${passing.length === 1 ? '' : 's'} met the target.`
        : undefined;

  return ok(sections(headline, failSection, unknownSection, passSection), structured);
}

export { supportCell };
export type { BrowserId };
