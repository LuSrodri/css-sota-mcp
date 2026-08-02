/**
 * Client for the Web Platform Dashboard HTTP API (`api.webstatus.dev`).
 *
 * This is the live half of the server's data: Baseline status, per-browser
 * shipping versions, WPT scores and usage move over time, so they are fetched
 * per request rather than baked into the bundle like the BCD index.
 *
 * Responses are cached at Cloudflare's edge for an hour. Baseline status
 * changes on the order of weeks, so an hour of staleness is invisible to
 * callers while removing almost all upstream traffic.
 */

const API_BASE = 'https://api.webstatus.dev/v1';

/** How long edge-cached responses stay fresh, in seconds. */
const CACHE_TTL_SECONDS = 3600;

/** Upstream request timeout, in milliseconds. */
const REQUEST_TIMEOUT_MS = 10_000;

/** The API caps `page_size` at 100. */
const MAX_PAGE_SIZE = 100;

/** Baseline status values used by both the API and `web-features`. */
export type BaselineStatus = 'limited' | 'newly' | 'widely';

/** Browsers the dashboard reports implementation status for. */
export type WebStatusBrowser =
  | 'chrome'
  | 'chrome_android'
  | 'edge'
  | 'firefox'
  | 'firefox_android'
  | 'safari'
  | 'safari_ios';

export interface BrowserImplementation {
  /** `YYYY-MM-DD` the version shipped. */
  date?: string;
  status?: 'available' | 'unavailable';
  version?: string;
}

/** One feature as returned by the dashboard API. */
export interface WebStatusFeature {
  feature_id: string;
  name: string;
  baseline?: {
    status?: BaselineStatus;
    /** Date the feature became Baseline Newly available. */
    low_date?: string;
    /** Date the feature became Baseline Widely available. */
    high_date?: string;
  };
  browser_implementations?: Partial<Record<WebStatusBrowser, BrowserImplementation>>;
  spec?: { links?: Array<{ link?: string }> };
  usage?: Partial<Record<'chrome', { daily?: number }>>;
  wpt?: {
    stable?: Partial<Record<WebStatusBrowser, { score?: number }>>;
    experimental?: Partial<Record<WebStatusBrowser, { score?: number }>>;
  };
  vendor_positions?: Array<{ vendor?: string; position?: string; url?: string }>;
}

interface FeaturesResponse {
  data?: WebStatusFeature[];
  metadata?: { next_page_token?: string; total?: number };
}

/** Raised when the dashboard API is unreachable or answers with an error. */
export class WebStatusError extends Error {
  override readonly name = 'WebStatusError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * Performs one GET against the API, with an edge cache hint and a timeout.
 *
 * The `cf` option is ignored outside Workers, so the same code path runs under
 * tests in Node.
 */
async function request<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
    } as RequestInit);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new WebStatusError(`Could not reach api.webstatus.dev: ${reason}`);
  }

  if (!response.ok) {
    // The API returns a JSON problem document on error; its body is far more
    // useful to the caller than the bare status, especially for query syntax
    // errors, so it is surfaced verbatim.
    const body = await response.text().catch(() => '');
    throw new WebStatusError(
      `api.webstatus.dev returned ${response.status}${body ? `: ${body.slice(0, 400)}` : ''}`,
      response.status,
    );
  }

  return (await response.json()) as T;
}

/** A page of search results. */
export interface FeaturePage {
  features: WebStatusFeature[];
  /** Total matches for the query, across all pages. */
  total?: number;
  /** Token for the next page, absent on the last one. */
  nextPageToken?: string;
}

/** Runs one query against `/v1/features`. */
export async function searchFeatures(options: {
  query: string;
  pageSize?: number;
  pageToken?: string;
}): Promise<FeaturePage> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 25, 1), MAX_PAGE_SIZE);

  const response = await request<FeaturesResponse>('/features', {
    q: options.query,
    page_size: String(pageSize),
    page_token: options.pageToken,
  });

  return {
    features: response.data ?? [],
    total: response.metadata?.total,
    nextPageToken: response.metadata?.next_page_token,
  };
}

/**
 * Runs a query and follows pagination until `limit` features are collected or
 * the result set is exhausted.
 *
 * `limit` is capped by the caller; the page budget is a second guard so a
 * pathological query cannot fan out into unbounded upstream requests.
 */
export async function searchAllFeatures(options: {
  query: string;
  limit: number;
  maxPages?: number;
}): Promise<{ features: WebStatusFeature[]; total?: number; truncated: boolean }> {
  const maxPages = options.maxPages ?? 5;
  const collected: WebStatusFeature[] = [];
  let pageToken: string | undefined;
  let total: number | undefined;

  for (let page = 0; page < maxPages; page++) {
    const remaining = options.limit - collected.length;
    if (remaining <= 0) break;

    const result = await searchFeatures({
      query: options.query,
      pageSize: Math.min(remaining, MAX_PAGE_SIZE),
      pageToken,
    });

    total ??= result.total;
    collected.push(...result.features);

    if (!result.nextPageToken || result.features.length === 0) {
      return { features: collected, total, truncated: false };
    }
    pageToken = result.nextPageToken;
  }

  return {
    features: collected.slice(0, options.limit),
    total,
    truncated: total !== undefined && collected.length < total,
  };
}

/** Fetches a single feature by id, or `undefined` when it does not exist. */
export async function getFeatureById(featureId: string): Promise<WebStatusFeature | undefined> {
  try {
    return await request<WebStatusFeature>(`/features/${encodeURIComponent(featureId)}`, {});
  } catch (error) {
    if (error instanceof WebStatusError && error.status === 404) return undefined;
    throw error;
  }
}

/**
 * Quotes a value for the dashboard's query grammar.
 *
 * Bare values may only contain `[a-zA-Z0-9_-]`; anything else (spaces,
 * `@`, `:`) has to be double-quoted. Embedded double quotes are dropped rather
 * than escaped, because the grammar has no escape sequence for them.
 */
export function quoteQueryValue(value: string): string {
  const trimmed = value.trim();
  if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/"/g, '')}"`;
}

/**
 * Builds a `q` expression, dropping empty terms and joining with `AND`.
 */
export function buildQuery(terms: Array<string | undefined>): string {
  return terms.filter((term): term is string => Boolean(term && term.trim())).join(' AND ');
}
