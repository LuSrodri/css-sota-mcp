/**
 * Tests the MDN lookup with a stubbed `fetch`, so the slug-resolution and
 * Markdown-cleanup logic is exercised without depending on MDN being up or on
 * the exact wording of a live page.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMdnDoc } from '../src/mdn.js';

const INDEX_JSON = {
  doc: {
    title: 'text-wrap-style CSS property',
    mdn_url: '/en-US/docs/Web/CSS/Reference/Properties/text-wrap-style',
    summary: 'The text-wrap-style CSS property controls how text is wrapped.',
  },
};

const MARKDOWN = `---
title: "\`text-wrap-style\` CSS property"
slug: Web/CSS/Reference/Properties/text-wrap-style
browser-compat: css.properties.text-wrap-style
---

The **\`text-wrap-style\`** [CSS](/en-US/docs/Web/CSS) property controls how text is wrapped.

{{InteractiveExample("CSS Demo: text-wrap-style")}}

It accepts {{CSSxRef("length")}} values.

## Syntax

\`\`\`css
text-wrap-style: auto;
\`\`\`
`;

/** Installs a fetch stub that answers by URL substring. */
function stubFetch(routes: Array<[test: string, response: Response | (() => Response)]>) {
  const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
    const url = String(input instanceof URL ? input.href : input);
    for (const [needle, response] of routes) {
      if (url.includes(needle)) return typeof response === 'function' ? response() : response;
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchMdnDoc', () => {
  it('resolves the canonical slug and reads the matching source file', async () => {
    const fetchMock = stubFetch([
      ['index.json', new Response(JSON.stringify(INDEX_JSON), { status: 200 })],
      ['raw.githubusercontent.com', new Response(MARKDOWN, { status: 200 })],
    ]);

    const doc = await fetchMdnDoc('https://developer.mozilla.org/docs/Web/CSS/text-wrap-style');

    expect(doc?.url).toBe(
      'https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/text-wrap-style',
    );
    // The source path must come from the resolved slug, not the stale input.
    const requested = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(requested.some((url) => url.includes('/reference/properties/text-wrap-style/index.md'))).toBe(
      true,
    );
  });

  it('strips frontmatter and macros from the prose', async () => {
    stubFetch([
      ['index.json', new Response(JSON.stringify(INDEX_JSON), { status: 200 })],
      ['raw.githubusercontent.com', new Response(MARKDOWN, { status: 200 })],
    ]);

    const doc = await fetchMdnDoc('Web/CSS/text-wrap-style');

    expect(doc?.body).not.toMatch(/^---/);
    expect(doc?.body).not.toMatch(/InteractiveExample/);
    expect(doc?.body).toContain('controls how text is wrapped');
    // A macro with a quoted first argument keeps that argument inline.
    expect(doc?.body).toContain('It accepts length values.');
  });

  it('stops before the reference sections', async () => {
    stubFetch([
      ['index.json', new Response(JSON.stringify(INDEX_JSON), { status: 200 })],
      ['raw.githubusercontent.com', new Response(MARKDOWN, { status: 200 })],
    ]);

    const doc = await fetchMdnDoc('Web/CSS/text-wrap-style');

    expect(doc?.body).not.toContain('text-wrap-style: auto;');
  });

  it('makes MDN links absolute', async () => {
    stubFetch([
      ['index.json', new Response(JSON.stringify(INDEX_JSON), { status: 200 })],
      ['raw.githubusercontent.com', new Response(MARKDOWN, { status: 200 })],
    ]);

    const doc = await fetchMdnDoc('Web/CSS/text-wrap-style');

    expect(doc?.body).toContain('(https://developer.mozilla.org/en-US/docs/Web/CSS)');
    expect(doc?.body).not.toMatch(/\]\(\/en-US/);
  });

  it('falls back to the summary when the source file is unavailable', async () => {
    stubFetch([
      ['index.json', new Response(JSON.stringify(INDEX_JSON), { status: 200 })],
      ['raw.githubusercontent.com', new Response('missing', { status: 404 })],
    ]);

    const doc = await fetchMdnDoc('Web/CSS/text-wrap-style');

    expect(doc?.body).toBeUndefined();
    expect(doc?.summary).toBe(INDEX_JSON.doc.summary);
  });

  it('returns undefined when the page does not exist', async () => {
    stubFetch([['index.json', new Response('nope', { status: 404 })]]);

    expect(await fetchMdnDoc('Web/CSS/not-a-page')).toBeUndefined();
  });

  it('returns undefined rather than throwing when MDN is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    expect(await fetchMdnDoc('Web/CSS/text-wrap-style')).toBeUndefined();
  });

  it('accepts a slug, a docs path or a full URL alike', async () => {
    const fetchMock = stubFetch([
      ['index.json', new Response(JSON.stringify(INDEX_JSON), { status: 200 })],
      ['raw.githubusercontent.com', new Response(MARKDOWN, { status: 200 })],
    ]);

    for (const reference of [
      'Web/CSS/text-wrap-style',
      'docs/Web/CSS/text-wrap-style',
      'https://developer.mozilla.org/docs/Web/CSS/text-wrap-style',
      '/en-US/docs/Web/CSS/text-wrap-style',
    ]) {
      fetchMock.mockClear();
      await fetchMdnDoc(reference);
      expect(String(fetchMock.mock.calls[0]![0])).toBe(
        'https://developer.mozilla.org/en-US/docs/Web/CSS/text-wrap-style/index.json',
      );
    }
  });
});
