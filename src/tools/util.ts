import { z } from "zod";

import type { DayCache, ResourceKind } from "#/client/cache";
import type { CostNote, Ledger } from "#/client/cost";
import {
  BudgetExceededError,
  PreconditionError,
  UserContextRequiredError,
  WritesDisabledError,
  XApiRequestError,
} from "#/client/errors";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Compact, not pretty-printed. `null, 2` adds 19-41% to every response — worst
 * on wide lists of short-keyed objects, which are exactly the replies already
 * big enough to hurt. No model needs the indentation, and every tool returns
 * through here. Files written to disk for humans stay pretty.
 */
export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }) }],
});

export const fail = (message: string, extra?: unknown): ToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ error: message, ...(extra ? { details: extra } : {}) }),
    },
  ],
  isError: true,
});

/** Render a thrown value as a tool error, preserving X's own detail. */
export const toFailure = (err: unknown): ToolResult => {
  if (err instanceof XApiRequestError) {
    return fail(err.message, { status: err.status, errors: err.errors });
  }
  if (err instanceof BudgetExceededError || err instanceof PreconditionError) {
    return fail(err.message, err.details);
  }
  if (err instanceof UserContextRequiredError || err instanceof WritesDisabledError) {
    return fail(err.message);
  }
  if (err instanceof Error) {
    const details = (err as Error & { details?: unknown }).details;
    return fail(err.message, details);
  }
  return fail("Unknown error", err);
};

/** Run a tool body, JSON-formatting the result and turning errors into a tool error. */
export const wrap = async <T>(fn: () => Promise<T>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    return toFailure(err);
  }
};

/**
 * Every read tool takes this. `maxResults` defaults low and says why in its
 * own description — an agent that reads the schema learns the cost model
 * without anyone having to document it elsewhere.
 */
export const maxResultsArg = z
  .number()
  .int()
  .min(1)
  .max(100)
  .default(10)
  .describe(
    "How many results to return (1-100). Defaults to 10 because X bills about $0.005 per post " +
      "read, so 100 results costs roughly $0.50. Raise it deliberately.",
  );

export const postIdArg = z
  .string()
  .regex(/^\d+$/, "A post id is digits only — the number at the end of a post's URL.")
  .describe('A post (tweet) id: the digits ending its URL, e.g. "1799000000000000001".');

export const usernameArg = z
  .string()
  .regex(/^@?[A-Za-z0-9_]{1,15}$/, "An X handle is 1-15 characters of letters, digits or _.")
  .describe('An X handle, with or without the leading @, e.g. "mgcrea".');

export const userIdArg = z
  .string()
  .regex(/^\d+$/)
  .describe('A numeric X user id, e.g. "44196397". Prefer `username` unless you already have one.');

export const paginationTokenArg = z
  .string()
  .min(1)
  .optional()
  .describe("The `next_token` from a previous call, to fetch the following page.");

export const confirmArg = z
  .literal(true)
  .describe("Must be true. Explicit acknowledgement that this posts to X and costs money.");

/** Drop undefined values so we never send `{"tweet.fields": undefined}` upstream. */
export const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

export const stripAt = (handle: string): string =>
  handle.startsWith("@") ? handle.slice(1) : handle;

/**
 * The expansions and field sets every post read asks for. Kept in one place
 * because the shaping layer's output is only as good as what was requested —
 * omitting `author_id` here silently degrades every post to "@unknown".
 */
export const POST_QUERY = {
  expansions: [
    "author_id",
    "referenced_tweets.id",
    "referenced_tweets.id.author_id",
    "attachments.media_keys",
  ],
  "tweet.fields": [
    "created_at",
    "public_metrics",
    "entities",
    "conversation_id",
    "lang",
    "referenced_tweets",
  ],
  "user.fields": ["username", "name", "verified"],
  "media.fields": ["type", "url", "preview_image_url", "alt_text"],
};

export const USER_QUERY = {
  "user.fields": [
    "description",
    "public_metrics",
    "verified",
    "created_at",
    "location",
    "protected",
  ],
};

export type ToolDeps = {
  cache: DayCache;
  ledger: Ledger;
  budgetUsd?: number | undefined;
};

/**
 * Guard a read against the configured budget *before* issuing it, so a runaway
 * agent cannot discover the ceiling by crossing it.
 */
export const assertWithinBudget = (deps: ToolDeps, what: string, estimateUsd: number): void => {
  if (deps.budgetUsd === undefined) return;
  const spent = deps.ledger.spentUsd();
  if (spent + estimateUsd > deps.budgetUsd) {
    throw new BudgetExceededError({
      estimateUsd,
      spentUsd: spent,
      limitUsd: deps.budgetUsd,
      what,
    });
  }
};

/**
 * Serve whatever today's cache already holds and fetch only the rest.
 *
 * This mirrors X's own billing rule rather than merely optimizing: within one
 * UTC day the cached ids would not have been billed again anyway, so a hit is
 * genuinely free rather than just fast.
 */
export const cachedByIds = async <T>(
  deps: ToolDeps,
  kind: ResourceKind,
  ids: string[],
  fetchMissing: (missing: string[]) => Promise<Map<string, T>>,
  label: string,
): Promise<{ items: T[]; cost: CostNote; notFound: string[] }> => {
  const cached = new Map<string, T>();
  const missing: string[] = [];
  for (const id of ids) {
    const hit = deps.cache.get(kind, id) as T | undefined;
    if (hit !== undefined) cached.set(id, hit);
    else missing.push(id);
  }

  if (missing.length > 0) {
    assertWithinBudget(deps, label, deps.ledger.estimate(kind, missing));
    const fetched = await fetchMissing(missing);
    for (const [id, item] of fetched) {
      deps.cache.set(kind, id, item);
      cached.set(id, item);
    }
    // Bill only what came back: X does not charge for an id it could not serve.
    deps.ledger.record(kind, [...fetched.keys()]);
  }

  const items: T[] = [];
  const notFound: string[] = [];
  for (const id of ids) {
    const item = cached.get(id);
    if (item !== undefined) items.push(item);
    else notFound.push(id);
  }

  const billable = missing.filter((id) => cached.has(id)).length;
  const free = ids.length - missing.length;
  return {
    items,
    cost: buildCostNote(kind, billable, free, deps),
    notFound,
  };
};

const buildCostNote = (
  kind: ResourceKind,
  billable: number,
  free: number,
  deps: ToolDeps,
): CostNote => {
  const usd = deps.ledger.estimateCount(kind, billable);
  const field =
    kind === "post"
      ? "billable_post_reads"
      : kind === "user"
        ? "billable_user_reads"
        : "owned_reads";
  return {
    [field]: billable,
    free_from_cache: free,
    estimated_usd: Math.round(usd * 1000) / 1000,
    ...(free > 0
      ? { note: `${free} already read today — X does not bill those again until UTC midnight.` }
      : {}),
  } as CostNote;
};

/** Record the cost of a read whose ids were only known after the fact (searches). */
export const recordResultCost = (deps: ToolDeps, kind: ResourceKind, ids: string[]): CostNote => {
  const { billable, free } = deps.ledger.record(kind, ids);
  return buildCostNote(kind, billable.length, free.length, deps);
};
