import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { isRecord, shapePostsResponse } from "#/client/shape";
import type { XApiClient } from "#/client/x";
import type { ToolContext } from "#/tools/index";
import {
  assertWithinBudget,
  compact,
  maxResultsArg,
  paginationTokenArg,
  POST_QUERY,
  recordResultCost,
  stripAt,
  wrap,
} from "#/tools/util";

const queryArg = z
  .string()
  .min(1)
  .max(1024)
  .describe(
    'An X search query, e.g. "rust -is:retweet lang:en". Build one with x_build_search_query if ' +
      "you are unsure of the operators.",
  );

const timeArgs = {
  startTime: z
    .string()
    .optional()
    .describe('Only posts at or after this ISO-8601 UTC time, e.g. "2026-07-01T00:00:00Z".'),
  endTime: z.string().optional().describe("Only posts before this ISO-8601 UTC time."),
};

/**
 * Full-archive search is capped at one request per second on top of its 15-minute
 * window. Enforced with a real gate rather than hoped for: a paginated call
 * issues several requests back to back and would trip the limit on its own.
 */
const createRateGate = (minIntervalMs: number) => {
  let last = 0;
  return async (): Promise<void> => {
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    last = Date.now();
  };
};

/**
 * Registered separately from the rest of search because it runs entirely
 * locally — no API call, no credentials, no cost. It stays available on an
 * unconfigured server, where getting a query right for free is the most useful
 * thing left to do.
 */
export const registerQueryBuilderTool = (server: McpServer): void => {
  server.registerTool(
    "x_build_search_query",
    {
      title: "X: Build Search Query",
      description:
        "Build an X search query from structured parts and explain each operator it used. Runs " +
        "entirely locally: no API call, no cost, no credentials. Use this to get the query right " +
        "for free, then pass the result to x_count_recent and only then to x_search_recent.",
      inputSchema: {
        allWords: z.string().optional().describe('Words that must all appear, e.g. "rust async".'),
        exactPhrase: z.string().optional().describe("A phrase that must appear verbatim."),
        anyWords: z.array(z.string()).optional().describe("At least one of these must appear."),
        noneWords: z.array(z.string()).optional().describe("None of these may appear."),
        hashtags: z.array(z.string()).optional().describe('Hashtags, with or without "#".'),
        from: z.array(usernameLike()).optional().describe("Only posts by these handles."),
        to: z.array(usernameLike()).optional().describe("Only replies to these handles."),
        mentioning: z.array(usernameLike()).optional().describe("Only posts mentioning these."),
        lang: z.string().optional().describe('BCP-47 language code, e.g. "en", "fr", "ja".'),
        hasMedia: z.boolean().optional().describe("Only posts with a photo or video."),
        hasLinks: z.boolean().optional().describe("Only posts containing a link."),
        isReply: z.boolean().optional().describe("true to require replies, false to exclude them."),
        isRetweet: z
          .boolean()
          .optional()
          .describe("true to require reposts, false to exclude them. False is the usual choice."),
        isQuote: z.boolean().optional().describe("true to require quote posts, false to exclude."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => wrap(async () => buildSearchQuery(args)),
  );
};

export const registerSearchTools = (
  server: McpServer,
  client: XApiClient,
  ctx: ToolContext,
): void => {
  const runSearch = async (
    path: string,
    args: {
      query: string;
      maxResults: number;
      sortOrder?: string | undefined;
      startTime?: string | undefined;
      endTime?: string | undefined;
      sinceId?: string | undefined;
      untilId?: string | undefined;
      paginationToken?: string | undefined;
    },
    label: string,
    gate?: () => Promise<void>,
  ) => {
    // Estimated by count, not by id: a search cannot know what it will return
    // until it returns it, so the guard uses the worst case it asked for.
    assertWithinBudget(ctx, label, ctx.ledger.estimateCount("post", args.maxResults));
    if (gate) await gate();

    const res = await client.paginate(
      path,
      compact({
        query: args.query,
        // X requires max_results between 10 and 100 on search, so a request for
        // 3 becomes a request for 10 that we then truncate. Billing follows what
        // came back, so this is honest about what it costs.
        max_results: Math.min(Math.max(args.maxResults, 10), 100),
        sort_order: args.sortOrder,
        start_time: args.startTime,
        end_time: args.endTime,
        since_id: args.sinceId,
        until_id: args.untilId,
        pagination_token: args.paginationToken,
        ...POST_QUERY,
      }),
      { maxItems: args.maxResults, maxPages: 5 },
    );

    const shaped = shapePostsResponse({ data: res.data, includes: res.includes[0] ?? {} });
    return {
      query: args.query,
      posts: shaped.posts,
      result_count: shaped.posts.length,
      ...(res.nextToken ? { next_token: res.nextToken } : {}),
      cost: recordResultCost(
        ctx,
        "post",
        shaped.posts.map((p) => p.id),
      ),
    };
  };

  server.registerTool(
    "x_search_recent",
    {
      title: "X: Search Recent",
      description:
        "Search posts from the last 7 days. Supports X's full query syntax: `from:handle`, " +
        '`to:handle`, `#tag`, `"exact phrase"`, `lang:en`, `has:media`, `has:links`, ' +
        "`url:example.com`, `conversation_id:`, and negation with `-is:retweet` or `-is:reply`. " +
        "Run x_count_recent first to see how big a query is before paying to read it.",
      inputSchema: {
        query: queryArg,
        maxResults: maxResultsArg,
        sortOrder: z
          .enum(["recency", "relevancy"])
          .optional()
          .describe("`recency` (newest first, the default) or `relevancy`."),
        ...timeArgs,
        sinceId: z.string().regex(/^\d+$/).optional().describe("Only posts newer than this id."),
        untilId: z.string().regex(/^\d+$/).optional().describe("Only posts older than this id."),
        paginationToken: paginationTokenArg,
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => wrap(() => runSearch("/2/tweets/search/recent", args, "x_search_recent")),
  );

  server.registerTool(
    "x_count_recent",
    {
      title: "X: Count Recent",
      description:
        "Count how many posts match a query over the last 7 days WITHOUT reading any of them. " +
        "This endpoint returns only totals, so it costs nothing per post — always run it before " +
        "a broad x_search_recent to find out whether you are about to read 10 posts or 10,000.",
      inputSchema: {
        query: queryArg,
        granularity: z
          .enum(["minute", "hour", "day"])
          .default("day")
          .describe("Bucket size for the time series. Defaults to day."),
        ...timeArgs,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, granularity, startTime, endTime }) =>
      wrap(async () => {
        const raw = await client.get(
          "/2/tweets/counts/recent",
          compact({ query, granularity, start_time: startTime, end_time: endTime }),
        );
        const meta = isRecord(raw) && isRecord(raw.meta) ? raw.meta : {};
        const total = typeof meta.total_tweet_count === "number" ? meta.total_tweet_count : 0;
        const estimated = ctx.ledger.estimateCount("post", total);
        return {
          query,
          total_posts: total,
          buckets: isRecord(raw) && Array.isArray(raw.data) ? raw.data : [],
          cost: { estimated_usd: 0, note: "Counts are not billed per post." },
          reading_all_would_cost_usd: Math.round(estimated * 100) / 100,
          ...(total > 100
            ? {
                advice:
                  `Reading all ${total} matches would cost about ` +
                  `$${(Math.round(estimated * 100) / 100).toFixed(2)}. Narrow the query with ` +
                  `-is:retweet, lang:, or a tighter time window before searching.`,
              }
            : {}),
        };
      }),
  );

  // Full-archive search is a paid-tier endpoint; registering it when it cannot
  // work would just hand the model a tool that always 403s.
  if (!ctx.enableFullArchive) return;

  const archiveGate = createRateGate(1000);

  server.registerTool(
    "x_search_all",
    {
      title: "X: Search All",
      description:
        "Search the FULL archive, back to X's first post in March 2006 — not just the last 7 " +
        "days. Requires a paid access tier and is limited to one request per second, so it is " +
        "slower than x_search_recent. Same query syntax. Costs the same per post read.",
      inputSchema: {
        query: queryArg,
        maxResults: maxResultsArg,
        sortOrder: z.enum(["recency", "relevancy"]).optional(),
        ...timeArgs,
        sinceId: z.string().regex(/^\d+$/).optional(),
        untilId: z.string().regex(/^\d+$/).optional(),
        paginationToken: paginationTokenArg,
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      wrap(() => runSearch("/2/tweets/search/all", args, "x_search_all", archiveGate)),
  );
};

function usernameLike() {
  return z.string().regex(/^@?[A-Za-z0-9_]{1,15}$/);
}

type QueryParts = {
  allWords?: string | undefined;
  exactPhrase?: string | undefined;
  anyWords?: string[] | undefined;
  noneWords?: string[] | undefined;
  hashtags?: string[] | undefined;
  from?: string[] | undefined;
  to?: string[] | undefined;
  mentioning?: string[] | undefined;
  lang?: string | undefined;
  hasMedia?: boolean | undefined;
  hasLinks?: boolean | undefined;
  isReply?: boolean | undefined;
  isRetweet?: boolean | undefined;
  isQuote?: boolean | undefined;
};

/** Grouped with OR and parenthesised, which is what X's `from:a OR from:b` needs. */
const orGroup = (operator: string, values: string[]): string =>
  values.length === 1
    ? `${operator}:${values[0]}`
    : `(${values.map((v) => `${operator}:${v}`).join(" OR ")})`;

export const buildSearchQuery = (
  parts: QueryParts,
): { query: string; explanation: string[]; length: number; valid: boolean; warning?: string } => {
  const clauses: string[] = [];
  const explanation: string[] = [];

  if (parts.allWords?.trim()) {
    clauses.push(parts.allWords.trim());
    explanation.push(`\`${parts.allWords.trim()}\` — all of these words must appear.`);
  }
  if (parts.exactPhrase?.trim()) {
    clauses.push(`"${parts.exactPhrase.trim()}"`);
    explanation.push(`\`"${parts.exactPhrase.trim()}"\` — this exact phrase must appear.`);
  }
  if (parts.anyWords?.length) {
    clauses.push(`(${parts.anyWords.join(" OR ")})`);
    explanation.push(`\`(${parts.anyWords.join(" OR ")})\` — at least one of these must appear.`);
  }
  for (const word of parts.noneWords ?? []) {
    clauses.push(`-${word}`);
    explanation.push(`\`-${word}\` — excludes posts containing "${word}".`);
  }
  for (const tag of parts.hashtags ?? []) {
    const clean = tag.startsWith("#") ? tag : `#${tag}`;
    clauses.push(clean);
    explanation.push(`\`${clean}\` — must carry this hashtag.`);
  }
  if (parts.from?.length) {
    const handles = parts.from.map(stripAt);
    clauses.push(orGroup("from", handles));
    explanation.push(
      `\`from:\` — only posts authored by ${handles.map((h) => `@${h}`).join(" or ")}.`,
    );
  }
  if (parts.to?.length) {
    const handles = parts.to.map(stripAt);
    clauses.push(orGroup("to", handles));
    explanation.push(
      `\`to:\` — only replies addressed to ${handles.map((h) => `@${h}`).join(" or ")}.`,
    );
  }
  for (const handle of (parts.mentioning ?? []).map(stripAt)) {
    clauses.push(`@${handle}`);
    explanation.push(`\`@${handle}\` — must mention this account.`);
  }
  if (parts.lang) {
    clauses.push(`lang:${parts.lang}`);
    explanation.push(`\`lang:${parts.lang}\` — only posts X detected as this language.`);
  }
  if (parts.hasMedia !== undefined) {
    clauses.push(`${parts.hasMedia ? "" : "-"}has:media`);
    explanation.push(
      `\`${parts.hasMedia ? "" : "-"}has:media\` — ${parts.hasMedia ? "requires" : "excludes"} posts with a photo or video.`,
    );
  }
  if (parts.hasLinks !== undefined) {
    clauses.push(`${parts.hasLinks ? "" : "-"}has:links`);
    explanation.push(
      `\`${parts.hasLinks ? "" : "-"}has:links\` — ${parts.hasLinks ? "requires" : "excludes"} posts containing a link.`,
    );
  }
  for (const [flag, name] of [
    [parts.isReply, "reply"],
    [parts.isRetweet, "retweet"],
    [parts.isQuote, "quote"],
  ] as const) {
    if (flag === undefined) continue;
    clauses.push(`${flag ? "" : "-"}is:${name}`);
    explanation.push(
      `\`${flag ? "" : "-"}is:${name}\` — ${flag ? "only" : "never"} ${name} posts.` +
        (name === "retweet" && !flag
          ? " This is the single most useful filter: it removes the duplicate noise of reposts."
          : ""),
    );
  }

  const query = clauses.join(" ");
  return {
    query,
    explanation,
    length: query.length,
    valid: query.length > 0 && query.length <= 1024,
    ...(query.length === 0 ? { warning: "No criteria given — the query is empty." } : {}),
    ...(query.length > 1024
      ? { warning: `Query is ${query.length} characters; X's limit is 1024.` }
      : {}),
  };
};
