import { describe, expect, it } from 'vitest';
import {
  checkBrowserTargets,
  compareVersions,
  decodeSupport,
  describeTargets,
  parseTargets,
  TargetParseError,
} from '../src/targets.js';
import { BROWSERS } from '../src/data/schema.js';
import type { BcdEntry, SupportValue } from '../src/data/schema.js';

/** Builds a compat entry from a partial browser map, defaulting to unsupported. */
function entry(support: Partial<Record<(typeof BROWSERS)[number], SupportValue>>): BcdEntry {
  return { s: BROWSERS.map((browser) => support[browser] ?? 0) };
}

describe('decodeSupport', () => {
  it('treats the 0 sentinel as unsupported', () => {
    expect(decodeSupport(0)).toEqual({ since: null });
    expect(decodeSupport(undefined)).toEqual({ since: null });
  });

  it('reads a bare version', () => {
    expect(decodeSupport('120')).toEqual({ since: '120' });
  });

  it('reads a required prefix', () => {
    expect(decodeSupport('9|p:-webkit-')).toEqual({ since: '9', prefix: '-webkit-' });
  });

  it('reads a partial implementation', () => {
    expect(decodeSupport('11|~')).toEqual({ since: '11', partial: true });
  });

  it('reads a removal version', () => {
    expect(decodeSupport('4|-63')).toEqual({ since: '4', removed: '63' });
  });

  it('reads an alternative name', () => {
    expect(decodeSupport('12|a:-ms-grid')).toEqual({ since: '12', alternativeName: '-ms-grid' });
  });

  it('reads several qualifiers at once', () => {
    expect(decodeSupport('9|p:-webkit-|~')).toEqual({
      since: '9',
      prefix: '-webkit-',
      partial: true,
    });
  });
});

describe('compareVersions', () => {
  it('compares numerically rather than lexically', () => {
    expect(compareVersions('9', '10')).toBe(-1);
    expect(compareVersions('120', '99')).toBe(1);
  });

  it('compares dotted versions segment by segment', () => {
    expect(compareVersions('17.4', '17.5')).toBe(-1);
    expect(compareVersions('17.5', '17.4')).toBe(1);
    expect(compareVersions('17.4', '17.4')).toBe(0);
  });

  it('treats a missing segment as zero', () => {
    expect(compareVersions('17', '17.0')).toBe(0);
    expect(compareVersions('17', '17.1')).toBe(-1);
  });
});

describe('parseTargets', () => {
  it('recognises Baseline levels in their common spellings', () => {
    expect(parseTargets('baseline-widely')).toEqual({ kind: 'baseline', level: 'widely' });
    expect(parseTargets('Baseline Widely')).toEqual({ kind: 'baseline', level: 'widely' });
    expect(parseTargets('newly')).toEqual({ kind: 'baseline', level: 'newly' });
    expect(parseTargets('baseline newly available')).toEqual({ kind: 'baseline', level: 'newly' });
  });

  it('reads a bare "baseline" conservatively as widely', () => {
    expect(parseTargets('baseline')).toEqual({ kind: 'baseline', level: 'widely' });
  });

  it('parses a browser list', () => {
    expect(parseTargets('chrome 120, safari 17.4')).toEqual({
      kind: 'browsers',
      entries: [
        { browser: 'chrome', version: '120' },
        { browser: 'safari', version: '17.4' },
      ],
    });
  });

  it('accepts >= between browser and version', () => {
    expect(parseTargets('chrome >= 120')).toEqual({
      kind: 'browsers',
      entries: [{ browser: 'chrome', version: '120' }],
    });
  });

  it('accepts caniuse-style browser aliases', () => {
    expect(parseTargets('ios_saf 17, and_chr 120, samsung 23')).toEqual({
      kind: 'browsers',
      entries: [
        { browser: 'safari_ios', version: '17' },
        { browser: 'chrome_android', version: '120' },
        { browser: 'samsunginternet_android', version: '23' },
      ],
    });
  });

  it('rejects browserslist queries instead of guessing at them', () => {
    expect(() => parseTargets('last 2 versions')).toThrow(TargetParseError);
    expect(() => parseTargets('>0.5%')).toThrow(TargetParseError);
  });

  it('rejects an empty target', () => {
    expect(() => parseTargets('   ')).toThrow(TargetParseError);
  });

  it('names the unrecognised entry when only part of a list is bad', () => {
    expect(() => parseTargets('chrome 120, netscape 4')).toThrow(/netscape 4/);
  });
});

describe('checkBrowserTargets', () => {
  const has = entry({ chrome: '105', firefox: '121', safari: '15.4' });

  it('passes when the target version is at or past the supporting version', () => {
    const [verdict] = checkBrowserTargets(has, [{ browser: 'chrome', version: '105' }]);

    expect(verdict?.reason).toBeUndefined();
  });

  it('fails a target older than the supporting version', () => {
    const [verdict] = checkBrowserTargets(has, [{ browser: 'chrome', version: '104' }]);

    expect(verdict?.reason).toBe('too-old');
  });

  it('fails a browser with no support at all', () => {
    const [verdict] = checkBrowserTargets(has, [{ browser: 'ie', version: '11' }]);

    expect(verdict?.reason).toBe('unsupported');
  });

  it('compares dotted versions correctly', () => {
    const [tooOld] = checkBrowserTargets(has, [{ browser: 'safari', version: '15.1' }]);
    const [fine] = checkBrowserTargets(has, [{ browser: 'safari', version: '15.4' }]);

    expect(tooOld?.reason).toBe('too-old');
    expect(fine?.reason).toBeUndefined();
  });

  it('flags prefix-only support as a failure', () => {
    const prefixed = entry({ safari: '9|p:-webkit-' });
    const [verdict] = checkBrowserTargets(prefixed, [{ browser: 'safari', version: '17' }]);

    expect(verdict?.reason).toBe('prefix-only');
  });

  it('flags partial implementations as a failure', () => {
    const partial = entry({ firefox: '100|~' });
    const [verdict] = checkBrowserTargets(partial, [{ browser: 'firefox', version: '128' }]);

    expect(verdict?.reason).toBe('partial');
  });

  it('fails a target at or past the version support was removed in', () => {
    const removed = entry({ chrome: '4|-63' });

    expect(checkBrowserTargets(removed, [{ browser: 'chrome', version: '63' }])[0]?.reason).toBe(
      'removed',
    );
    expect(
      checkBrowserTargets(removed, [{ browser: 'chrome', version: '62' }])[0]?.reason,
    ).toBeUndefined();
  });
});

describe('describeTargets', () => {
  it('describes a Baseline level', () => {
    expect(describeTargets({ kind: 'baseline', level: 'widely' })).toBe(
      'Baseline widely available',
    );
  });

  it('describes a browser list', () => {
    expect(
      describeTargets({ kind: 'browsers', entries: [{ browser: 'chrome', version: '120' }] }),
    ).toBe('chrome 120');
  });
});
