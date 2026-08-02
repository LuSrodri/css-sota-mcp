import { describe, expect, it } from 'vitest';
import { reviewUx } from '../src/ux-review.js';
import { handler as dontMakeMeThink } from '../src/tools/dont-make-me-think.js';
import guidelines from '../src/data/ux-guidelines.json';
import type { UxGuidelines } from '../src/data/ux-schema.js';

const kb = guidelines as unknown as UxGuidelines;

/** Ids of principles cited by a set of findings. */
function ids(findings: ReturnType<typeof reviewUx>): string[] {
  return findings.map((f) => f.principleId);
}

describe('the knowledge base', () => {
  it('covers every area the tool advertises', () => {
    const covered = new Set(kb.principles.map((p) => p.topic));

    for (const topic of Object.keys(kb.topics)) {
      expect(covered, `no principle for topic "${topic}"`).toContain(topic);
    }
  });

  it('has all ten Nielsen heuristics', () => {
    const heuristics = kb.principles.filter((p) => p.topic === 'heuristics');

    expect(heuristics).toHaveLength(10);
  });

  it('gives every principle an id, rules and a source', () => {
    for (const p of kb.principles) {
      expect(p.id, JSON.stringify(p)).toMatch(/^[a-z0-9-]+$/);
      expect(p.rules.length, p.id).toBeGreaterThan(0);
      expect(p.source, p.id).toMatch(/^https:\/\//);
      expect(p.why.length, p.id).toBeGreaterThan(20);
    }
  });

  it('has no duplicate ids', () => {
    const seen = kb.principles.map((p) => p.id);

    expect(new Set(seen).size).toBe(seen.length);
  });

  // Every finding cites a principle by id; a typo would produce a finding that
  // explains nothing.
  it('is referenced only by ids that exist', () => {
    const known = new Set(kb.principles.map((p) => p.id));
    const samples = [
      '<html><body><img src="x.png"></body></html>',
      '<a href="/x">click here</a>',
      '<button></button>',
      '<input type="text">',
      '<video autoplay></video>',
      '<svg viewBox="0 0 1 1"></svg>',
      '<h1>a</h1><h4>b</h4>',
      '<h1>a</h1><h1>b</h1>',
      '<nav><a>1</a><a>2</a><a>3</a><a>4</a><a>5</a><a>6</a><a>7</a><a>8</a></nav>',
      '<div tabindex="3"></div>',
    ];

    for (const html of samples) {
      for (const finding of reviewUx({ html })) {
        expect(known, `${finding.principleId} is not a real principle`).toContain(
          finding.principleId,
        );
      }
    }

    const cssSamples = [
      'a { transition: color 1s; }',
      'a:focus { outline: none; }',
      ':root { color-scheme: dark; }',
      'p { font-size: 11px; }',
      '.x { transition: width 200ms; }',
      '@media (prefers-color-scheme: dark) { :root { --a: #000 } }',
    ];
    for (const css of cssSamples) {
      for (const finding of reviewUx({ css })) {
        expect(known, `${finding.principleId} is not a real principle`).toContain(
          finding.principleId,
        );
      }
    }
  });
});

describe('HTML review', () => {
  it('flags an image with no alt', () => {
    expect(ids(reviewUx({ html: '<img src="a.png" width="1" height="1">' }))).toContain(
      'wcag-perceivable-text-alternatives',
    );
  });

  it('accepts an explicitly decorative image', () => {
    const findings = reviewUx({ html: '<img src="a.png" alt="" width="1" height="1">' });

    expect(ids(findings)).not.toContain('wcag-perceivable-text-alternatives');
  });

  it('flags a viewport that blocks zoom', () => {
    const html =
      '<html lang="en"><head><title>t</title>' +
      '<meta name="viewport" content="width=device-width, user-scalable=no"></head><body></body></html>';

    expect(ids(reviewUx({ html }))).toContain('wcag-zoom-reflow');
  });

  it('accepts a viewport that allows zoom', () => {
    const html =
      '<html lang="en"><head><title>t</title>' +
      '<meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>';

    expect(ids(reviewUx({ html }))).not.toContain('wcag-zoom-reflow');
  });

  it('flags vague link text', () => {
    expect(ids(reviewUx({ html: '<a href="/pricing">Click here</a>' }))).toContain(
      'neuro-plain-language',
    );
  });

  it('accepts link text that names the destination', () => {
    expect(ids(reviewUx({ html: '<a href="/pricing">See pricing</a>' }))).not.toContain(
      'neuro-plain-language',
    );
  });

  it('flags a control with no accessible name', () => {
    expect(ids(reviewUx({ html: '<button><svg aria-hidden="true"></svg></button>' }))).toContain(
      'wcag-perceivable-text-alternatives',
    );
  });

  it('accepts an icon button labelled with aria-label', () => {
    const html = '<button aria-label="Close"><svg aria-hidden="true"></svg></button>';

    expect(ids(reviewUx({ html }))).not.toContain('wcag-perceivable-text-alternatives');
  });

  it('flags an unlabelled form control', () => {
    expect(ids(reviewUx({ html: '<input type="text" id="a">' }))).toContain(
      'wcag-semantics-landmarks',
    );
  });

  it('accepts a control labelled by a for/id pair', () => {
    const html = '<label for="a">Name</label><input type="text" id="a">';

    expect(ids(reviewUx({ html }))).not.toContain('wcag-semantics-landmarks');
  });

  it('flags autoplaying media', () => {
    expect(ids(reviewUx({ html: '<video autoplay src="a.mp4"></video>' }))).toContain(
      'neuro-predictability',
    );
  });

  it('flags a skipped heading level', () => {
    expect(ids(reviewUx({ html: '<h1>a</h1><h4>b</h4>' }))).toContain('wcag-semantics-landmarks');
  });

  it('flags a nav wider than a person can scan', () => {
    const links = Array.from({ length: 9 }, (_, i) => `<a href="/${i}">${i}</a>`).join('');

    expect(ids(reviewUx({ html: `<nav>${links}</nav>` }))).toContain('hicks-law');
  });

  it('accepts a nav within Hick range', () => {
    const links = Array.from({ length: 5 }, (_, i) => `<a href="/${i}">${i}</a>`).join('');

    expect(ids(reviewUx({ html: `<nav>${links}</nav>` }))).not.toContain('hicks-law');
  });

  it('flags an SVG that is neither labelled nor hidden', () => {
    expect(ids(reviewUx({ html: '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>' }))).toContain(
      'svg-craft',
    );
  });

  it('accepts a decorative SVG', () => {
    const html = '<svg aria-hidden="true" viewBox="0 0 1 1"><path d="M0 0"/></svg>';

    expect(ids(reviewUx({ html }))).not.toContain('svg-craft');
  });

  it('does not flag document-level rules on a fragment', () => {
    const findings = reviewUx({ html: '<p>hello</p>' });

    expect(findings).toHaveLength(0);
  });

  it('ignores markup inside comments and scripts', () => {
    const html = '<!-- <img src="a.png"> --><script>document.write("<img src=b.png>")</script>';

    expect(reviewUx({ html })).toHaveLength(0);
  });
});

describe('CSS review', () => {
  it('flags animation with no reduced-motion path', () => {
    expect(ids(reviewUx({ css: '.a { transition: opacity 200ms; }' }))).toContain('motion-reduced');
  });

  it('accepts animation that honours reduced motion', () => {
    const css =
      '.a { transition: opacity 200ms; }\n' +
      '@media (prefers-reduced-motion: reduce) { .a { transition-duration: 0.001ms; } }';

    expect(ids(reviewUx({ css }))).not.toContain('motion-reduced');
  });

  it('flags a removed focus ring with no replacement', () => {
    expect(ids(reviewUx({ css: 'button:focus { outline: none; }' }))).toContain(
      'wcag-focus-visible',
    );
  });

  it('accepts a reset paired with a focus-visible style', () => {
    const css = 'button:focus { outline: none; }\nbutton:focus-visible { outline: 2px solid; }';

    expect(ids(reviewUx({ css }))).not.toContain('wcag-focus-visible');
  });

  it('flags a dark-only colour scheme', () => {
    expect(ids(reviewUx({ css: ':root { color-scheme: dark; }' }))).toContain('theme-light-first');
  });

  it('accepts a scheme that includes light', () => {
    const findings = reviewUx({ css: ':root { color-scheme: light dark; }' });

    expect(ids(findings)).not.toContain('theme-light-first');
  });

  // The first run against this project's own landing page reported it as
  // dark-only. It has no `color-scheme` declaration at all — the pattern was
  // matching the `color-scheme: dark` inside `prefers-color-scheme: dark`.
  it('does not mistake the prefers-color-scheme media query for the property', () => {
    const css = '@media (prefers-color-scheme: dark) { :root { --ink: white; } }';
    const darkOnly = reviewUx({ css }).filter((f) => /dark-only/.test(f.message));

    expect(darkOnly).toHaveLength(0);
  });

  it('still flags a real dark-only declaration inside a media query', () => {
    const css = '@media (min-width: 40em) { :root { color-scheme: dark; } }';

    expect(reviewUx({ css }).some((f) => /dark-only/.test(f.message))).toBe(true);
  });

  it('flags a transition past the 400ms threshold', () => {
    const css =
      '.a { transition: opacity 900ms; }\n@media (prefers-reduced-motion: reduce) { .a { transition: none } }';

    expect(ids(reviewUx({ css }))).toContain('motion-timing');
  });

  it('flags transitioning a layout property', () => {
    const css =
      '.a { transition: width 200ms; }\n@media (prefers-reduced-motion: reduce) { .a { transition: none } }';
    const finding = reviewUx({ css }).find((f) => f.principleId === 'motion-timing');

    expect(finding?.message).toMatch(/width/);
  });

  it('ignores durations inside comments', () => {
    const css = '/* transition: opacity 900ms; */ .a { color: red }';

    expect(reviewUx({ css })).toHaveLength(0);
  });
});

describe('dont_make_me_think tool', () => {
  it('returns every principle by default', async () => {
    const result = await dontMakeMeThink({ mode: 'guidelines' });

    expect(result.structuredContent.principles.length).toBe(kb.principles.length);
  });

  it('filters guidelines by topic', async () => {
    const result = await dontMakeMeThink({ mode: 'guidelines', topic: 'svg' });

    expect(result.structuredContent.principles.length).toBeGreaterThan(0);
    expect(result.structuredContent.principles.every((p) => p.topic === 'svg')).toBe(true);
  });

  it('reviews supplied source and counts by severity', async () => {
    const result = await dontMakeMeThink({
      mode: 'review',
      html: '<img src="a.png">',
      css: '.a { transition: opacity 200ms; }',
    });

    expect(result.structuredContent.counts.blocker).toBeGreaterThan(0);
    expect(result.structuredContent.reviewed).toEqual(['html', 'css']);
  });

  it('attaches the cited principles to a review, so a finding explains itself', async () => {
    const result = await dontMakeMeThink({ mode: 'review', html: '<img src="a.png">' });
    const cited = result.structuredContent.principles.map((p) => p.id);

    expect(cited).toContain('wcag-perceivable-text-alternatives');
    expect(result.structuredContent.findings[0]!.principleTitle).toBeTruthy();
  });

  it('asks for input rather than reporting a clean page when given none', async () => {
    const result = await dontMakeMeThink({ mode: 'review' });

    expect(result.isError).toBe(true);
  });

  // A clean static result is a floor, not a pass, and the tool has to say so or
  // it will be read as certification.
  it('states its own limits on a clean review', async () => {
    const result = await dontMakeMeThink({ mode: 'review', html: '<p>hello</p>' });

    expect(result.structuredContent.findings).toHaveLength(0);
    expect(result.content[0]!.text).toMatch(/static read|computed contrast/i);
  });
});
