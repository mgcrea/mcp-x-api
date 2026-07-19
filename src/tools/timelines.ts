import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { UserContextRequiredError } from "../client/errors.js";
import { shapePostsResponse } from "../client/shape.js";
import type { XApiClient } from "../client/x.js";
import type { ToolContext } from "./index.js";
import {
  compact,
  maxResultsArg,
  paginationTokenArg,
  POST_QUERY,
  recordResultCost,
  wrap,
} from "./util.js";

/**
 * Both endpoints here are self-only: X permits reading *your* home timeline and
 * *your* bookmarks and nobody else's. So the user id comes from the stored
 * token rather than from an argument — accepting one would imply a capability
 * that does not exist.
 */
const requireOwnUserId = (ctx: ToolContext): string => {
  const status = ctx.tokenProvider.describe().user;
  if (!status.authenticated) {
    throw new UserContextRequiredError("This tool", status.reason);
  }
  if (!status.userId) {
    throw new UserContextRequiredError(
      "This tool",
      "the stored token has no recorded user id — run `x-api-mcp login` again",
    );
  }
  return status.userId;
};

export const registerTimelineTools = (
  server: McpServer,
  client: XApiClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "x_get_home_timeline",
    {
      description:
        "Your own reverse-chronological home timeline — the posts from accounts you follow. " +
        "Requires `x-api-mcp login`; X only ever serves this for the authenticated account, so " +
        "there is no way to read someone else's. Billed at the cheaper owned-read rate.",
      inputSchema: {
        maxResults: maxResultsArg,
        excludeReplies: z.boolean().default(false).describe("Leave out replies."),
        excludeReposts: z.boolean().default(false).describe("Leave out reposts (retweets)."),
        sinceId: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .describe("Only posts newer than this id — useful for polling."),
        paginationToken: paginationTokenArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ maxResults, excludeReplies, excludeReposts, sinceId, paginationToken }) =>
      wrap(async () => {
        const userId = requireOwnUserId(ctx);
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
      description:
        "Your saved bookmarks, newest first. Requires `x-api-mcp login` with the " +
        "`bookmark.read` scope — an app-only Bearer token cannot reach bookmarks at all.",
      inputSchema: {
        maxResults: maxResultsArg,
        paginationToken: paginationTokenArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ maxResults, paginationToken }) =>
      wrap(async () => {
        const userId = requireOwnUserId(ctx);
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
