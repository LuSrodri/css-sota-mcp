import { describe, expect, it } from 'vitest';
import { buildQuery, quoteQueryValue } from '../src/webstatus.js';
import { baselineDateTerm, baselineDateOf, toIsoDate } from '../src/tools/shared.js';

describe('quoteQueryValue', () => {
  it('leaves a bare identifier unquoted', () => {
    expect(quoteQueryValue('grid')).toBe('grid');
    expect(quoteQueryValue('text-wrap-balance')).toBe('text-wrap-balance');
  });

  it('quotes anything containing a space', () => {
    expect(quoteQueryValue('container queries')).toBe('"container queries"');
  });

  it('quotes values starting with a non-letter, which the grammar rejects bare', () => {
    expect(quoteQueryValue('@container')).toBe('"@container"');
    expect(quoteQueryValue(':has()')).toBe('":has()"');
  });

  it('drops embedded double quotes, which the grammar cannot escape', () => {
    expect(quoteQueryValue('say "hi"')).toBe('"say hi"');
  });
});

describe('buildQuery', () => {
  it('joins terms with AND', () => {
    expect(buildQuery(['group:css', 'baseline_status:newly'])).toBe(
      'group:css AND baseline_status:newly',
    );
  });

  it('drops absent and blank terms', () => {
    expect(buildQuery(['group:css', undefined, '', '   '])).toBe('group:css');
  });
});

describe('baselineDateTerm', () => {
  it('is absent when neither bound is given', () => {
    expect(baselineDateTerm()).toBeUndefined();
  });

  it('fills in an open start', () => {
    expect(baselineDateTerm(undefined, '2026-01-01')).toBe('baseline_date:1990-01-01..2026-01-01');
  });

  it('fills in an open end with today', () => {
    const term = baselineDateTerm('2026-01-01');

    expect(term).toBe(`baseline_date:2026-01-01..${toIsoDate(new Date())}`);
  });

  it('uses both bounds when given', () => {
    expect(baselineDateTerm('2025-01-01', '2026-01-01')).toBe(
      'baseline_date:2025-01-01..2026-01-01',
    );
  });
});

describe('baselineDateOf', () => {
  it('uses the high date for widely available features', () => {
    expect(
      baselineDateOf({ baseline: { status: 'widely', low_date: '2020-01-01', high_date: '2022-07-01' } }),
    ).toBe('2022-07-01');
  });

  it('uses the low date for newly available features', () => {
    expect(baselineDateOf({ baseline: { status: 'newly', low_date: '2026-01-01' } })).toBe(
      '2026-01-01',
    );
  });

  it('falls back to the low date when a widely feature has no high date', () => {
    expect(baselineDateOf({ baseline: { status: 'widely', low_date: '2020-01-01' } })).toBe(
      '2020-01-01',
    );
  });

  it('is absent for a feature with no Baseline data', () => {
    expect(baselineDateOf({})).toBeUndefined();
  });
});
