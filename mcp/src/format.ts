/**
 * Markdown rendering for tool results.
 *
 * Every tool returns both `structuredContent` for programmatic consumers and a
 * Markdown rendering for the model reading the result. These helpers own the
 * second half, so that "Baseline newly available" reads the same way in all
 * five tools.
 */

import { BROWSER_LABELS, type BrowserId } from './data/schema.js';
import type { BcdEntry } from './data/schema.js';
import { BASELINE_BROWSERS, decodeEntry, type Support } from './targets.js';
import type { BaselineStatus, WebStatusFeature } from './webstatus.js';

/** Renders a Baseline status as a short, unambiguous phrase. */
export function baselineLabel(
  status: BaselineStatus | undefined,
  lowDate?: string,
  highDate?: string,
): string {
  switch (status) {
    case 'widely':
      return `Baseline Widely available${highDate ? ` (since ${highDate})` : ''}`;
    case 'newly':
      return `Baseline Newly available${lowDate ? ` (since ${lowDate})` : ''}`;
    case 'limited':
      return 'Limited availability (not Baseline)';
    default:
      return 'Unknown Baseline status';
  }
}

/** A leading marker that survives plain-text rendering. */
export function baselineMarker(status: BaselineStatus | undefined): string {
  switch (status) {
    case 'widely':
      return '[widely]';
    case 'newly':
      return '[newly]';
    case 'limited':
      return '[limited]';
    default:
      return '[unknown]';
  }
}

/** Describes one browser's support in a table cell. */
export function supportCell(support: Support): string {
  if (support.since === null) return 'No';

  const notes: string[] = [];
  if (support.prefix) notes.push(`needs ${support.prefix} prefix`);
  if (support.alternativeName) notes.push(`as ${support.alternativeName}`);
  if (support.partial) notes.push('partial');
  if (support.removed) notes.push(`removed in ${support.removed}`);

  return notes.length > 0 ? `${support.since} (${notes.join(', ')})` : support.since;
}

/**
 * Renders a compat entry as a Markdown table.
 *
 * Browsers with no support at all are folded into a trailing line rather than
 * given a row each, which keeps the table readable when a feature is new.
 */
export function supportTable(entry: BcdEntry, browsers?: BrowserId[]): string {
  const support = decodeEntry(entry);
  const shown = browsers ?? BASELINE_BROWSERS;

  const supported = shown.filter((browser) => support[browser].since !== null);
  const unsupported = shown.filter((browser) => support[browser].since === null);

  const lines: string[] = [];
  if (supported.length > 0) {
    lines.push('| Browser | Since |', '| --- | --- |');
    for (const browser of supported) {
      lines.push(`| ${BROWSER_LABELS[browser]} | ${supportCell(support[browser])} |`);
    }
  }
  if (unsupported.length > 0) {
    lines.push('', `Not supported: ${unsupported.map((b) => BROWSER_LABELS[b]).join(', ')}.`);
  }
  return lines.join('\n');
}

/** Renders the browser versions the dashboard reports for a feature. */
export function implementationTable(feature: WebStatusFeature): string {
  const implementations = feature.browser_implementations ?? {};
  const rows = Object.entries(implementations)
    .filter(([, value]) => value?.status === 'available' && value.version)
    .map(([browser, value]) => `| ${browser} | ${value!.version} | ${value!.date ?? '—'} |`);

  if (rows.length === 0) return '';
  return ['| Browser | Version | Shipped |', '| --- | --- | --- |', ...rows].join('\n');
}

/** One line summarising a feature in a search result list. */
export function featureListItem(feature: WebStatusFeature): string {
  const marker = baselineMarker(feature.baseline?.status);
  const date =
    feature.baseline?.status === 'widely'
      ? feature.baseline.high_date
      : feature.baseline?.low_date;
  return `- ${marker} **${feature.name}** \`${feature.feature_id}\`${date ? ` — since ${date}` : ''}`;
}

/** The first spec link a dashboard feature carries, if any. */
export function specLink(feature: WebStatusFeature): string | undefined {
  return feature.spec?.links?.find((entry) => entry.link)?.link;
}

/** Formats a Chrome usage fraction as a percentage, when reported. */
export function usageLabel(feature: WebStatusFeature): string | undefined {
  const daily = feature.usage?.chrome?.daily;
  if (typeof daily !== 'number') return undefined;
  return `${(daily * 100).toFixed(2)}% of Chrome page loads`;
}

/** Joins sections, dropping empty ones, with a blank line between each. */
export function sections(...parts: Array<string | undefined | false>): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join('\n\n');
}
