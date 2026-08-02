/**
 * Pieces shared by every tool: the result shape, common argument schemas, and
 * the date handling the dashboard's query grammar needs.
 */

import { z } from 'zod';

/** An MCP tool result carrying both a Markdown rendering and structured data. */
export interface ToolResult<T> {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: T;
  isError?: boolean;
}

/** Builds a successful tool result. */
export function ok<T>(text: string, structuredContent: T): ToolResult<T> {
  return { content: [{ type: 'text', text }], structuredContent };
}

/**
 * Builds a failed tool result.
 *
 * Tool-level failures are reported as results with `isError`, not thrown: the
 * model should see *why* a lookup failed — and any suggestions that came with
 * it — so it can correct the call itself.
 */
export function fail<T>(text: string, structuredContent: T): ToolResult<T> {
  return { content: [{ type: 'text', text }], structuredContent, isError: true };
}

/** `YYYY-MM-DD`, the only date format the dashboard's query grammar accepts. */
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format, e.g. 2026-01-31');

/** Baseline statuses accepted as a filter. */
export const baselineSchema = z.enum(['limited', 'newly', 'widely']);

/** Formats a `Date` as `YYYY-MM-DD` in UTC. */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Returns today's date, in UTC. */
export function today(): string {
  return toIsoDate(new Date());
}

/** Returns the date `days` before today, in UTC. */
export function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return toIsoDate(date);
}

/** Shifts a `YYYY-MM-DD` date by a number of months, in UTC. */
export function shiftMonths(date: string, months: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCMonth(parsed.getUTCMonth() + months);
  return toIsoDate(parsed);
}

/**
 * Builds a `baseline_date:from..to` term.
 *
 * The grammar has no open-ended form, so a missing bound is filled in: an
 * absent start reaches back before the web platform had versioned features, and
 * an absent end is today.
 */
export function baselineDateTerm(since?: string, until?: string): string | undefined {
  if (!since && !until) return undefined;
  return `baseline_date:${since ?? '1990-01-01'}..${until ?? today()}`;
}

/** The date that decides where a feature sits on a Baseline timeline. */
export function baselineDateOf(feature: {
  baseline?: { status?: string; low_date?: string; high_date?: string };
}): string | undefined {
  return feature.baseline?.status === 'widely'
    ? (feature.baseline.high_date ?? feature.baseline.low_date)
    : feature.baseline?.low_date;
}
