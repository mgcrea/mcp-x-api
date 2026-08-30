import { gunzipSync } from "node:zlib";

import type { Logger, TokenProvider } from "#/client/auth";
import { PreconditionError, type XApiError, XApiRequestError } from "#/client/errors";
import {
  buildQuery,
  endpointKey,
  numberOrUndefined,
  safeJsonParse,
  withRetry,
  type Query,
  type RateLimitSnapshot,
} from "#/client/http";
import { DEFAULT_ADS_BASE_URL } from "#/config";

export type AdsApiClientOptions = {
  baseUrl?: string;
  /**
   * The same provider the v2 client uses. The Ads API is always asked for the
   * `"user"` context: there is no app-only path to `/12/accounts`.
   */
  tokenProvider: TokenProvider;
  maxRetries?: number;
  maxDownloadBytes?: number;
  fetch?: typeof fetch;
  logger?: Logger;
  userAgent?: string;
};

export type CursorPage<T> = {
  data: T[];
  pages: number;
  nextCursor?: string;
  totalCount?: number;
};

/** The default page size X uses. Its maximum is 1000. */
const DEFAULT_COUNT = 200;

/**
 * Hosts the async-analytics download is allowed to reach. The URL comes out of
 * an X response rather than from us, and following a server-supplied URL
 * unchecked is an SSRF primitive — not something to leave open in a project
 * whose pitch is a small attack surface.
 */
const DOWNLOAD_HOSTS = [".x.com", ".twimg.com", ".twitter.com", ".amazonaws.com"];

/**
 * `endpointKey` collapses long digit runs, which is right for v2 post ids and
 * useless here: ads ids are alphanumeric (`18ce54d4x5t`). Collapse the resource
 * segments by name instead, so one bucket per endpoint rather than per entity.
 */
const adsEndpointKey = (method: string, path: string): string =>
  endpointKey(
    method,
    path.replace(
      /\/(accounts|campaigns|line_items|promoted_tweets|targeting_criteria|custom_audiences|funding_instruments)\/[A-Za-z0-9_-]+/g,
      "/$1/:id",
    ),
  );

const isRec = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Fetch-based client for the X Ads API v12. Deliberately not an `XApiClient`
 * subclass: the two share transport concerns and nothing else. Ads paginates by
 * cursor rather than `next_token`, answers errors in two envelopes neither of
 * which is v2's problem-details, reports three families of rate-limit headers,
 * and needs its own diagnostics — the v2 prose about the Pay-per-use package is
 * actively misleading here. What genuinely is shared lives in `./http.js`.
 *
 * Writes send their parameters in the query string, never a JSON body: that is
 * what the Ads API takes on POST and PUT, and what X's own SDKs send.
 */
export class AdsApiClient {
  readonly sandbox: boolean;
  readonly baseUrl: string;
  private readonly tokenProvider: TokenProvider;
  private readonly maxRetries: number;
  private readonly maxDownloadBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly userAgent: string;
  private readonly rateLimits = new Map<string, RateLimitSnapshot>();

  constructor(opts: AdsApiClientOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_ADS_BASE_URL).replace(/\/+$/, "");
    this.sandbox = /ads-api-sandbox\./.test(this.baseUrl);
    this.tokenProvider = opts.tokenProvider;
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxDownloadBytes = opts.maxDownloadBytes ?? 25_000_000;
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
    this.userAgent = opts.userAgent ?? "mcp-x-api-js";
  }

  rateLimitStatus(): RateLimitSnapshot[] {
    return [...this.rateLimits.values()];
  }

  /**
   * Ads reports three independent budgets, and a 429 can come from any of them.
   * Recording only the endpoint family would leave the account-level limit —
   * the one that actually bites during a bulk read — invisible.
   */
  private recordRateLimit(method: string, path: string, res: Response): void {
    const families = [
      { scope: "endpoint" as const, prefix: "x-rate-limit" },
      { scope: "account" as const, prefix: "x-account-rate-limit" },
      { scope: "cost" as const, prefix: "x-cost-rate-limit" },
    ];
    for (const { scope, prefix } of families) {
      const limit = numberOrUndefined(res.headers.get(`${prefix}-limit`));
      const remaining = numberOrUndefined(res.headers.get(`${prefix}-remaining`));
      const reset = numberOrUndefined(res.headers.get(`${prefix}-reset`));
      if (limit === undefined && remaining === undefined && reset === undefined) continue;
      const endpoint = adsEndpointKey(method, path);
      this.rateLimits.set(`${scope} ${endpoint}`, {
        endpoint,
        api: "ads",
        scope,
        ...(limit !== undefined ? { limit } : {}),
        ...(remaining !== undefined ? { remaining } : {}),
        ...(reset !== undefined ? { reset, resetAt: new Date(reset * 1000).toISOString() } : {}),
      });
    }
  }

  async request<T = unknown>(method: string, path: string, query?: Query): Promise<T> {
    const url = `${this.baseUrl}${path}${buildQuery(query)}`;

    const res = await withRetry(
      async () => {
        const token = await this.tokenProvider.getToken("user");
        return this.fetchImpl(url, {
          method,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "User-Agent": this.userAgent,
          },
        });
      },
      {
        maxRetries: this.maxRetries,
        label: `${method} ${url}`,
        logger: this.logger,
        onUnauthorized: () => this.tokenProvider.invalidate("user"),
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

  get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, query);
  }

  post<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("POST", path, query);
  }

  put<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("PUT", path, query);
  }

  del<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("DELETE", path, query);
  }

  /**
   * GET a collection, following `next_cursor` until the pages run out or a
   * bound is hit.
   *
   * Unlike v2, the cursor is a top-level field rather than nested under `meta`,
   * it is `null` (not absent) on the last page, and it goes back out as
   * `cursor`. Everything else about the loop matches `XApiClient.paginate`,
   * which is why this is a separate method rather than a shared one — the
   * differences are exactly the parts that matter.
   */
  async paginateCursor<T = unknown>(
    path: string,
    query: Query,
    opts: { maxItems: number; maxPages?: number },
  ): Promise<CursorPage<T>> {
    type Envelope = { data?: T[]; next_cursor?: unknown; total_count?: unknown };
    const maxPages = opts.maxPages ?? 5;
    const collected: T[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let nextCursor: string | undefined;
    let totalCount: number | undefined;

    for (;;) {
      const res: Envelope = await this.request<Envelope>("GET", path, {
        count: DEFAULT_COUNT,
        ...query,
        ...(cursor ? { cursor } : {}),
      });
      pages += 1;
      if (Array.isArray(res?.data)) collected.push(...res.data);
      if (typeof res?.total_count === "number") totalCount = res.total_count;

      const next = res?.next_cursor;
      cursor = typeof next === "string" && next ? next : undefined;
      nextCursor = cursor;

      if (!cursor || collected.length >= opts.maxItems || pages >= maxPages) break;
    }

    return {
      data: collected.slice(0, opts.maxItems),
      pages,
      ...(nextCursor ? { nextCursor } : {}),
      ...(totalCount !== undefined ? { totalCount } : {}),
    };
  }

  /**
   * Fetch a finished analytics job's result file and decompress it.
   *
   * Three things here are load-bearing. The URL is a presigned object-store
   * link on a different host, so it must go out with **no** Authorization
   * header — signing it makes the store reject it. The host is checked first,
   * because the URL came from a remote response. And both the compressed and
   * decompressed sizes are capped: a 25 MB gzip of repetitive JSON expands to
   * hundreds of megabytes, so an uncapped gunzip here is an OOM waiting for a
   * big enough report.
   */
  async downloadGzipped(url: string): Promise<{ text: string; bytes: number }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new PreconditionError(`The analytics result URL is not a valid URL: ${url}`, { url });
    }
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" || !DOWNLOAD_HOSTS.some((d) => host.endsWith(d))) {
      throw new PreconditionError(
        `Refusing to download the analytics result from ${host}: it is not an X-owned host. ` +
          `This URL came from an API response, so an unexpected host is worth stopping on.`,
        { host, allowed: DOWNLOAD_HOSTS },
      );
    }

    const res = await this.fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": this.userAgent },
    });
    if (!res.ok) {
      throw new XApiRequestError(
        `Downloading the analytics result failed: HTTP ${res.status} ${res.statusText}. These ` +
          `URLs expire — re-read the job with x_ads_get_stats_jobs for a fresh one.`,
        { status: res.status },
      );
    }

    const declared = numberOrUndefined(res.headers.get("content-length"));
    if (declared !== undefined && declared > this.maxDownloadBytes) {
      throw new PreconditionError(
        `The analytics result is ${declared} bytes, over the ${this.maxDownloadBytes}-byte limit. ` +
          `Re-run the job over fewer entity_ids, a shorter date range, or a coarser granularity, ` +
          `or raise X_ADS_MAX_DOWNLOAD_BYTES.`,
        { bytes: declared, limit: this.maxDownloadBytes },
      );
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > this.maxDownloadBytes) {
      throw new PreconditionError(
        `The analytics result is ${buf.byteLength} bytes, over the ${this.maxDownloadBytes}-byte ` +
          `limit. Narrow the job, or raise X_ADS_MAX_DOWNLOAD_BYTES.`,
        { bytes: buf.byteLength, limit: this.maxDownloadBytes },
      );
    }

    try {
      const out = gunzipSync(buf, { maxOutputLength: this.maxDownloadBytes * 20 });
      return { text: out.toString("utf8"), bytes: out.byteLength };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
        throw new PreconditionError(
          `The analytics result decompressed past ${this.maxDownloadBytes * 20} bytes and was ` +
            `discarded. Re-run the job over a narrower range.`,
          { limit: this.maxDownloadBytes * 20 },
        );
      }
      throw err;
    }
  }

  private parseErrors(text: string): XApiError[] | unknown {
    const parsed = safeJsonParse(text);
    if (isRec(parsed) && Array.isArray(parsed.errors)) return parsed.errors as XApiError[];
    return parsed;
  }

  /**
   * Ads answers in two envelopes. The gateway rejects bad auth with the legacy
   * v1.1 shape and a *numeric* code — and with HTTP 400, not 401. Past that,
   * application errors use CAPS_CASE string codes. Both are quoted here, and
   * each status gets the sentence that actually fixes it: a bare
   * "UNAUTHORIZED_ACCESS" sends people to re-check a token that is usually fine.
   */
  private errorMessage(res: Response, method: string, path: string, text: string): string {
    const base = `X Ads API ${method} ${path} failed: HTTP ${res.status} ${res.statusText}`.trim();
    const parsed = this.parseErrors(text);
    const detail = Array.isArray(parsed)
      ? parsed
          .map((e: XApiError) =>
            [e.code, e.message ?? e.detail, e.parameter].filter(Boolean).join(" — "),
          )
          .filter(Boolean)
          .join("; ")
      : "";
    const suffix = detail ? ` (${detail})` : "";

    // The gateway's own rejection, before any ads logic runs.
    if (res.status === 400 && /"code":\s*2\d\d/.test(text)) {
      return (
        `${base} — X's gateway rejected the credentials outright. The access token is missing or ` +
        `malformed; run \`x-api-mcp login\` again${suffix}`
      );
    }
    if (res.status === 401) {
      return (
        `${base} — authenticated request refused. Most often the stored token predates your Ads ` +
        `API approval, or was minted before ads.read was in scope: run \`x-api-mcp login\` again ` +
        `so the new token carries the ads scopes${suffix}`
      );
    }
    if (res.status === 403) {
      // Two separate gates, and passing the first does not pass the second.
      // Attaching the Ads Project in the console enables X's own hosted Ads MCP
      // (ads-api.x.com/mcp) immediately, which makes it look like access is
      // working — but these REST endpoints stay closed until the Ads API Access
      // Form is approved by a human. Verified: one token gets 200 from /mcp and
      // UNAUTHORIZED_CLIENT_APPLICATION from /12/accounts at the same moment.
      return (
        `${base} — the token is valid, but this app is not approved for the Ads REST API. ` +
        `Attaching the Ads Project at console.x.com is only half of it: that switch enables X's ` +
        `hosted Ads MCP, while these /12/ endpoints additionally need X's Ads API Access Form to ` +
        `be approved, which is a human review rather than a toggle. Once it is granted, run ` +
        `\`x-api-mcp login\` again — a token minted before approval does not carry it` +
        suffix
      );
    }
    if (res.status === 404) {
      // A sandbox account id 404s against production and vice versa, and
      // nothing in the response says which side you are on.
      return (
        `${base} — no such entity at ${this.baseUrl}. Check the account id, and check you are ` +
        `pointed at the right environment: X_ADS_BASE_URL is currently ` +
        `${this.sandbox ? "the SANDBOX" : "PRODUCTION"} (${this.baseUrl}), and ids do not carry ` +
        `across${suffix}`
      );
    }
    if (res.status === 429) {
      const snapshot = [...this.rateLimits.values()].find(
        (s) => s.endpoint === adsEndpointKey(method, path),
      );
      const window = snapshot
        ? ` (${snapshot.remaining ?? 0}/${snapshot.limit ?? "?"} remaining on the ` +
          `${snapshot.scope} budget${snapshot.resetAt ? `, resets ${snapshot.resetAt}` : ""})`
        : "";
      return `${base} — rate limited${window}. Wait for the window to reset, or ask for less.`;
    }
    return base + suffix;
  }
}
