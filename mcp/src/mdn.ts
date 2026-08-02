/**
 * Fetches reference prose for a CSS feature from `mdn/content`.
 *
 * Getting from a BCD key to the right source file is not a matter of string
 * concatenation. BCD's `mdn_url` records the slug that was current when the
 * entry was written, and MDN reorganises: CSS reference pages now live under
 * `Web/CSS/Reference/Properties/…` rather than `Web/CSS/…`. Guessing a raw
 * GitHub path from a stale slug 404s.
 *
 * So the slug is resolved through MDN itself first — `<page>/index.json` follows
 * redirects and reports the page's canonical location — and only then is the
 * matching Markdown source read from `mdn/content`. When the source cannot be
 * read, the summary from that same lookup is still returned, so a caller always
 * gets prose even if it is only a paragraph.
 */

const MDN_ORIGIN = 'https://developer.mozilla.org';
const CONTENT_RAW = 'https://raw.githubusercontent.com/mdn/content/main/files';

const CACHE_TTL_SECONDS = 86_400;
const REQUEST_TIMEOUT_MS = 8_000;

/** Characters of Markdown body to keep; enough for the prose, not the examples. */
const MAX_BODY_CHARS = 4_000;

/** Reference prose for one MDN page. */
export interface MdnDoc {
  title: string;
  /** Canonical MDN URL. */
  url: string;
  /** One-paragraph summary, as MDN renders it. */
  summary?: string;
  /**
   * Lead prose from the page's Markdown source, macros stripped. Absent when
   * `mdn/content` could not be read.
   */
  body?: string;
}

interface MdnIndexJson {
  doc?: {
    title?: string;
    mdn_url?: string;
    summary?: string;
  };
}

function timeout(): RequestInit {
  return {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
  } as RequestInit;
}

/**
 * Normalises whatever form of MDN reference we hold into a `/en-US/docs/...`
 * path.
 *
 * Accepts a full URL, a `docs/...` path as stored in BCD, or a bare slug.
 */
function toDocsPath(reference: string): string {
  let value = reference.trim();
  if (value.startsWith('http')) {
    try {
      value = new URL(value).pathname;
    } catch {
      return '';
    }
  }
  value = value.replace(/^\/+/, '');
  if (value.startsWith('en-US/docs/')) return `/${value}`;
  if (value.startsWith('docs/')) return `/en-US/${value}`;
  return `/en-US/docs/${value}`;
}

/**
 * Converts a canonical MDN slug into its `mdn/content` source path.
 *
 * Source paths are the lowercased slug under `files/en-us/`.
 */
function toContentPath(mdnUrl: string): string | undefined {
  const slug = mdnUrl.replace(/^\/?(en-US|en-us)\/docs\//i, '').replace(/^\/+|\/+$/g, '');
  if (!slug) return undefined;
  return `${CONTENT_RAW}/en-us/${slug.toLowerCase()}/index.md`;
}

/**
 * Strips the YAML frontmatter and KumaScript macros from an MDN Markdown
 * source, then keeps the prose down to the first example-bearing section.
 *
 * Macro calls like `{{CSSxRef("length")}}` are replaced with their first
 * argument so sentences still read correctly.
 */
function extractProse(markdown: string): string {
  let text = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

  // Drop the reference sections; the lead prose is what is useful in a tool
  // result, and examples blow past any sensible size budget.
  const cut = text.search(/^##\s+(Examples|Syntax|Formal|Specifications|Browser compatibility)/im);
  if (cut > 0) text = text.slice(0, cut);

  text = text
    .replace(/\{\{\s*[A-Za-z_]+\s*\(\s*"([^"]*)"[^}]*\)\s*\}\}/g, '$1')
    .replace(/\{\{\s*[A-Za-z_]+\s*\([^}]*\)\s*\}\}/g, '')
    .replace(/\{\{\s*[A-Za-z_]+\s*\}\}/g, '')
    // MDN sources link site-relatively. Left as-is those links are dead
    // everywhere this text is actually read, so make them absolute.
    .replace(/\]\(\/(?!\/)/g, `](${MDN_ORIGIN}/`)
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…` : text;
}

/**
 * Looks up MDN reference prose for a page.
 *
 * @param reference An MDN URL, `docs/...` path, or slug — BCD's `mdn_url` in
 *   any of the forms it appears in.
 * @returns The document, or `undefined` when MDN has no such page.
 */
export async function fetchMdnDoc(reference: string): Promise<MdnDoc | undefined> {
  const path = toDocsPath(reference);
  if (!path) return undefined;

  let index: MdnIndexJson;
  try {
    const response = await fetch(`${MDN_ORIGIN}${path}/index.json`, timeout());
    if (!response.ok) return undefined;
    index = (await response.json()) as MdnIndexJson;
  } catch {
    // MDN being unreachable must not fail the whole tool call; the caller
    // still has Baseline and compat data to report.
    return undefined;
  }

  const doc = index.doc;
  if (!doc?.mdn_url) return undefined;

  const result: MdnDoc = {
    title: doc.title ?? reference,
    url: `${MDN_ORIGIN}${doc.mdn_url}`,
  };
  if (doc.summary) result.summary = doc.summary;

  const contentUrl = toContentPath(doc.mdn_url);
  if (!contentUrl) return result;

  try {
    const response = await fetch(contentUrl, timeout());
    if (response.ok) {
      const prose = extractProse(await response.text());
      if (prose) result.body = prose;
    }
  } catch {
    // Fall through to the summary-only result.
  }

  return result;
}
