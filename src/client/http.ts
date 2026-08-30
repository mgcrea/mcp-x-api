import type { Logger } from "#/client/auth";

export type QueryValue = string | number | boolean | string[] | undefined;
export type Query = Record<string, QueryValue>;

/**
 * What the last response told us about how much of an endpoint's budget is left.
 *
 * `scope` and `api` are optional because the v2 API reports exactly one family
 * of rate-limit headers and has no need to distinguish them. The Ads API
 * reports three (endpoint, account and cost), so it fills them in.
 */
export type RateLimitSnapshot = {
  endpoint: string;
  limit?: number;
  remaining?: number;
  /** Unix seconds, as X reports it. */
  reset?: number;
  resetAt?: string;
  scope?: "endpoint" | "account" | "cost";
  api?: "v2" | "ads";
};

/** Anything that can report rate limits, so a tool can merge several clients. */
export type RateLimitReporter = {
  rateLimitStatus(): RateLimitSnapshot[];
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, 8000);

export const retryAfterMs = (res: Response): number | undefined => {
  const header = res.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(seconds, 0) * 1000 : undefined;
};

export const safeJsonParse = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
};

export const numberOrUndefined = (value: string | null): number | undefined => {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * X takes comma-separated lists for both field selection
 * (`tweet.fields=id,text,created_at`) and batch lookups (`ids=1,2,3`) — not
 * repeated keys. Same join as JSON:API happens to need, different reason.
 */
export const buildQuery = (query: Query | undefined): string => {
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
export const endpointKey = (method: string, path: string): string =>
  `${method} ${path.replace(/\/\d{5,}/g, "/:id").replace(/\?.*$/, "")}`;

export type RetryPolicy = {
  maxRetries: number;
  label: string;
  logger?: Logger | undefined;
  onUnauthorized?: (() => void) | undefined;
};

/** Run `perform` until it yields a non-retryable response or the budget runs out. */
export const withRetry = async (
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
