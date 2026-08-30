import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { UserContextRequiredError } from "#/client/errors";
import { isRecord, shapePostsResponse } from "#/client/shape";
import type { XApiClient } from "#/client/x";
import type { ToolContext } from "#/tools/index";
import {
  compact,
  maxResultsArg,
  paginationTokenArg,
  POST_QUERY,
  recordResultCost,
  wrap,
} from "#/tools/util";

/**
 * Both endpoints here are self-only: X permits reading *your* home timeline and
 * *your* bookmarks and nobody else's. So the user id comes from the stored
 * token rather than from an argument — accepting one would imply a capability
 * that does not exist.
 */
const resolveOwnUserId = async (client: XApiClient, ctx: ToolContext): Promise<string> => {
  const status = ctx.tokenProvider.describe().user;
  if (!status.authenticated) {
    throw new UserContextRequiredError("This tool", status.reason);
  }
  if (status.userId) return status.userId;

  // Login records the id from `/2/users/me`, but that endpoint is documented as
  // unreliable and the login flow tolerates it failing. Telling the user to log
  // in again would be a dead end — the retry hits the same endpoint — so ask
  // for the id now instead, and cache it so this happens at most once.
  const raw = await client.get("/2/users/me", {}, "user");
  const id = isRecord(raw) && isRecord(raw.data) ? raw.data.id : undefined;
  const username = isRecord(raw) && isRecord(raw.data) ? raw.data.username : undefined;
  if (typeof id !== "string" || !id) {
    throw new UserContextRequiredError(
      "This tool",
      "X did not return your account id from /2/users/me, so there is no way to identify whose " +
        "timeline to read. Re-run `x-api-mcp login`, and check the app is enrolled in the " +
        "Pay-per-use package and Production environment at console.x.com",
    );
  }

  ctx.ledger.record("owned", [id]);

  const stored = ctx.tokenStore?.read();
  if (stored) {
    ctx.tokenStore?.write({
      ...stored,
      userId: id,
      ...(typeof username === "string" && username ? { username } : {}),
    });
  }
  return id;
};

export const registerTimelineTools = (
  server: McpServer,
  client: XApiClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "x_get_home_timeline",
    {
      title: "X: Get Home Timeline",
      description:
        "Your own reverse-chronological home timeline — the posts from accounts you follow. " +
        "Requires `x-api-mcp login`; X only ever serves this for the authenticated account, so " +
        "there is no way to read someone else's. Billed at the cheaper owned-read rate.",
      inputSchema: z.object({
        maxResults: maxResultsArg,
        excludeReplies: z.boolean().default(false).describe("Leave out replies."),
        excludeReposts: z.boolean().default(false).describe("Leave out reposts (retweets)."),
        sinceId: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .describe("Only posts newer than this id — useful for polling."),
        paginationToken: paginationTokenArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ maxResults, excludeReplies, excludeReposts, sinceId, paginationToken }) =>
      wrap(async () => {
        const userId = await resolveOwnUserId(client, ctx);
        const exclude = [
          ...(excludeReplies ? ["replies"] : []),
          ...(excludeReposts ? ["retweets"] : []),
        ];
        const res = await client.paginate(
          `/2/users/${userId}/timelines/reverse_chronological`,
          compact({
            max_results: Math.min(Math.max(maxResults, 5), 100),
            exclude: exclude.length > 0 ? exclude : undefined,
            since_id: sinceId,
            pagination_token: paginationToken,
            ...POST_QUERY,
          }),
          { maxItems: maxResults, auth: "user" },
        );
        const shaped = shapePostsResponse({ data: res.data, includes: res.includes[0] ?? {} });
        return {
          posts: shaped.posts,
          result_count: shaped.posts.length,
          ...(res.nextToken ? { next_token: res.nextToken } : {}),
          cost: recordResultCost(
            ctx,
            "owned",
            shaped.posts.map((p) => p.id),
          ),
        };
      }),
  );

  server.registerTool(
    "x_get_bookmarks",
    {
      title: "X: Get Bookmarks",
      description:
        "Your saved bookmarks, newest first. Requires `x-api-mcp login` with the " +
        "`bookmark.read` scope — an app-only Bearer token cannot reach bookmarks at all.",
      inputSchema: z.object({
        maxResults: maxResultsArg,
        paginationToken: paginationTokenArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ maxResults, paginationToken }) =>
      wrap(async () => {
        const userId = await resolveOwnUserId(client, ctx);
        const res = await client.paginate(
          `/2/users/${userId}/bookmarks`,
          compact({
            max_results: Math.min(Math.max(maxResults, 1), 100),
            pagination_token: paginationToken,
            ...POST_QUERY,
          }),
          { maxItems: maxResults, auth: "user" },
        );
        const shaped = shapePostsResponse({ data: res.data, includes: res.includes[0] ?? {} });
        return {
          posts: shaped.posts,
          result_count: shaped.posts.length,
          ...(res.nextToken ? { next_token: res.nextToken } : {}),
          cost: recordResultCost(
            ctx,
            "owned",
            shaped.posts.map((p) => p.id),
          ),
        };
      }),
  );
};
