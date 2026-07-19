import { DEFAULT_BASE_URL } from "../config.js";
import type { AuthContext, Logger, TokenProvider } from "./auth.js";
import { type XApiError, XApiRequestError } from "./errors.js";

export type QueryValue = string | number | boolean | string[] | undefined;
export type Query = Record<string, QueryValue>;

export type RequestOptions = {
  query?: Query;
  body?: unknown;
  /** Which credential to send. Defaults to the app-only Bearer token. */
  auth?: AuthContext;
};

export type XApiClientOptions = {
  baseUrl?: string;
  tokenProvider: TokenProvider;
  maxRetries?: number;
  fetch?: typeof fetch;
  logger?: Logger;
  userAgent?: string;
};

/** What the last response told us about how much of an endpoint's budget is left. */
export type RateLimitSnapshot = {
  endpoint: string;
  limit?: number;
  remaining?: number;
  /** Unix seconds, as X reports it. */
  reset?: number;
  resetAt?: string;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, 8000);

const retryAfterMs = (res: Response): number | undefined => {
  const header = res.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(seconds, 0) * 1000 : undefined;
};

const safeJsonParse = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
};

const numberOrUndefined = (value: string | null): number | undefined => {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * X takes comma-separated lists for both field selection
 * (`tweet.fields=id,text,created_at`) and batch lookups (`ids=1,2,3`) — not
 * repeated keys. Same join as JSON:API happens to need, different reason.
 */
const buildQuery = (query: Query | undefined): string => {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      params.append(key, value.join(","));
      continue;
    }
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
};

/**
 * Collapse a concrete path to the shape X documents its rate limits against, so
 * `/2/tweets/1799…` and `/2/tweets/1798…` share one bucket instead of leaking a
 * new entry per post.
 */
const endpointKey = (method: string, path: string): string =>
  `${method} ${path.replace(/\/\d{5,}/g, "/:id").replace(/\?.*$/, "")}`;

type RetryPolicy = {
  maxRetries: number;
  label: string;
  logger?: Logger | undefined;
  onUnauthorized?: (() => void) | undefined;
};

/** Run `perform` until it yields a non-retryable response or the budget runs out. */
const withRetry = async (
  perform: () => Promise<Response>,
  policy: RetryPolicy,
): Promise<Response> => {
  let attempt = 0;

  for (;;) {
    policy.logger?.debug?.(`[x-api] ${policy.label} (attempt ${attempt + 1})`);
    const res = await perform();

    if (res.status === 401 && policy.onUnauthorized && attempt < policy.maxRetries) {
      policy.logger?.warn?.(`[x-api] HTTP 401 — refreshing token and retrying`);
      policy.onUnauthorized();
      attempt += 1;
      continue;
    }

    if ((res.status === 429 || res.status >= 500) && attempt < policy.maxRetries) {
      const delay = retryAfterMs(res) ?? backoffMs(attempt);
      policy.logger?.warn?.(`[x-api] HTTP ${res.status} — retrying in ${delay}ms`);
      await sleep(delay);
      attempt += 1;
      continue;
    }

    return res;
  }
};

/**
 * Minimal fetch-based client for the X API v2. Paths are absolute (`/2/tweets`).
 * Retries a 401 (invalidating the token first) and 429/5xx with exponential
 * backoff honoring `Retry-After`, and records every response's rate-limit
 * headers so a 429 can say what it is waiting for.
 */
export class XApiClient {
  private readonly baseUrl: string;
  private readonly tokenProvider: TokenProvider;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly userAgent: string;
  private readonly rateLimits = new Map<string, RateLimitSnapshot>();

  constructor(opts: XApiClientOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.tokenProvider = opts.tokenProvider;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
    this.userAgent = opts.userAgent ?? "mcp-x-api-js";
  }

  /** Everything the last response said about each endpoint's remaining budget. */
  rateLimitStatus(): RateLimitSnapshot[] {
    return [...this.rateLimits.values()];
  }

  private recordRateLimit(method: string, path: string, res: Response): void {
    const limit = numberOrUndefined(res.headers.get("x-rate-limit-limit"));
    const remaining = numberOrUndefined(res.headers.get("x-rate-limit-remaining"));
    const reset = numberOrUndefined(res.headers.get("x-rate-limit-reset"));
    if (limit === undefined && remaining === undefined && reset === undefined) return;
    const endpoint = endpointKey(method, path);
    this.rateLimits.set(endpoint, {
      endpoint,
      ...(limit !== undefined ? { limit } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
      ...(reset !== undefined ? { reset, resetAt: new Date(reset * 1000).toISOString() } : {}),
    });
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}${buildQuery(opts.query)}`;
    const hasBody = opts.body !== undefined;
    const auth: AuthContext = opts.auth ?? "app";

    const res = await withRetry(
      async () => {
        const token = await this.tokenProvider.getToken(auth);
        return this.fetchImpl(url, {
          method,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "User-Agent": this.userAgent,
            ...(hasBody ? { "Content-Type": "application/json" } : {}),
          },
          ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
        });
      },
      {
        maxRetries: this.maxRetries,
        label: `${method} ${url}`,
        logger: this.logger,
        onUnauthorized: () => this.tokenProvider.invalidate(auth),
      },
    );

    this.recordRateLimit(method, path, res);
    const text = await res.text();

    if (!res.ok) {
      throw new XApiRequestError(this.errorMessage(res, method, path, text), {
        status: res.status,
        errors: this.parseErrors(text),
      });
    }

    if (res.status === 204 || text.trim() === "") return null as T;
    return safeJsonParse(text) as T;
  }

  get<T = unknown>(path: string, query?: Query, auth: AuthContext = "app"): Promise<T> {
    return this.request<T>("GET", path, { query, auth });
  }

  post<T = unknown>(path: string, body?: unknown, auth: AuthContext = "user"): Promise<T> {
    return this.request<T>("POST", path, { body, auth });
  }

  del<T = unknown>(path: string, auth: AuthContext = "user"): Promise<T> {
    return this.request<T>("DELETE", path, { auth });
  }

  /**
   * GET a collection, following `meta.next_token` until the pages run out or a
   * bound is hit.
   *
   * Both bounds exist because unbounded pagination here spends real money: at
   * $0.005 a post, walking a busy hashtag to the end is a three-figure mistake
   * an agent can make in one call. `maxItems` is the one callers actually set.
   *
   * X carries the cursor in `meta.next_token` and expects it back as
   * `pagination_token`, so — unlike a `links.next` API — the original query has
   * to be re-sent on every page rather than replaced.
   */
  async paginate<T = unknown>(
    path: string,
    query: Query,
    opts: { maxItems: number; maxPages?: number; auth?: AuthContext },
  ): Promise<{ data: T[]; pages: number; nextToken?: string; includes: Rec[] }> {
    type Envelope = {
      data?: T[];
      includes?: Rec;
      meta?: { next_token?: unknown };
    };
    const maxPages = opts.maxPages ?? 10;
    const collected: T[] = [];
    const includes: Rec[] = [];
    let token: string | undefined;
    let pages = 0;
    let nextToken: string | undefined;

    for (;;) {
      const res: Envelope = await this.request<Envelope>("GET", path, {
        query: { ...query, ...(token ? { pagination_token: token } : {}) },
        ...(opts.auth ? { auth: opts.auth } : {}),
      });
      pages += 1;
      if (Array.isArray(res?.data)) collected.push(...res.data);
      if (res?.includes) includes.push(res.includes);

      const next = res?.meta?.next_token;
      token = typeof next === "string" && next ? next : undefined;
      nextToken = token;

      if (!token || collected.length >= opts.maxItems || pages >= maxPages) break;
    }

    return {
      data: collected.slice(0, opts.maxItems),
      pages,
      ...(nextToken ? { nextToken } : {}),
      includes,
    };
  }

  private parseErrors(text: string): XApiError[] | unknown {
    const parsed = safeJsonParse(text);
    if (parsed && typeof parsed === "object" && "errors" in parsed) {
      return (parsed as { errors: XApiError[] }).errors;
    }
    return parsed;
  }

  /**
   * The three statuses that actually happen get a sentence naming the fix. A
   * bare "HTTP 403" sends people to the wrong place — usually to re-check a
   * token that was fine, when the real answer is that their access tier does
   * not include the endpoint.
   */
  private errorMessage(res: Response, method: string, path: string, text: string): string {
    const base = `X API ${method} ${path} failed: HTTP ${res.status} ${res.statusText}`.trim();
    const parsed = this.parseErrors(text);
    const detail = Array.isArray(parsed)
      ? parsed
          .map((e: XApiError) => [e.title, e.detail ?? e.message].filter(Boolean).join(" — "))
          .filter(Boolean)
          .join("; ")
      : this.problemDetail(parsed);

    if (res.status === 401) {
      return (
        `${base} — the token was rejected. Check X_API_BEARER_TOKEN, or re-run ` +
        `\`x-api-mcp login\` if this call needed a user context` +
        (detail ? ` (${detail})` : "")
      );
    }
    if (res.status === 403) {
      return (
        `${base} — authenticated, but your access tier or this token's scopes do not cover ` +
        `this endpoint (full-archive search needs a paid tier; bookmarks need the ` +
        `bookmark.read scope)` +
        (detail ? ` (${detail})` : "")
      );
    }
    if (res.status === 429) {
      const snapshot = this.rateLimits.get(endpointKey(method, path));
      const window = snapshot
        ? ` (${snapshot.remaining ?? 0}/${snapshot.limit ?? "?"} remaining` +
          (snapshot.resetAt ? `, resets ${snapshot.resetAt}` : "") +
          `)`
        : "";
      return `${base} — rate limited${window}. Wait for the window to reset, or lower maxResults.`;
    }
    return base + (detail ? ` — ${detail}` : "");
  }

  private problemDetail(parsed: unknown): string {
    if (!parsed || typeof parsed !== "object") return "";
    const p = parsed as XApiError;
    return [p.title, p.detail].filter(Boolean).join(" — ");
  }
}

type Rec = Record<string, unknown>;
