import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { isRecord, shapePostsResponse, type ShapedPost } from "#/client/shape";
import type { XApiClient } from "#/client/x";
import type { ToolContext } from "#/tools/index";
import {
  cachedByIds,
  compact,
  maxResultsArg,
  paginationTokenArg,
  POST_QUERY,
  postIdArg,
  recordResultCost,
  wrap,
} from "#/tools/util";

export const registerPostTools = (
  server: McpServer,
  client: XApiClient,
  ctx: ToolContext,
): void => {
  /** One batched lookup, shared by the single- and multi-id tools. */
  const fetchPosts = async (ids: string[]): Promise<Map<string, ShapedPost>> => {
    const raw = await client.get("/2/tweets", compact({ ids, ...POST_QUERY }));
    const shaped = shapePostsResponse(raw);
    return new Map(shaped.posts.map((post) => [post.id, post]));
  };

  server.registerTool(
    "x_get_post",
    {
      title: "X: Get Post",
      description:
        "Get one post by id, with its author, metrics, media and any quoted or replied-to post " +
        "already inlined. Reading the same post twice in one UTC day is free — X does not bill " +
        "a repeat read.",
      inputSchema: z.object({ postId: postIdArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ postId }) =>
      wrap(async () => {
        const { items, cost, notFound } = await cachedByIds(
          ctx,
          "post",
          [postId],
          fetchPosts,
          "x_get_post",
        );
        if (items.length === 0) {
          return {
            error:
              `X returned no post for id ${notFound[0]}. It is deleted, protected, or from a ` +
              `suspended account.`,
            cost,
          };
        }
        return { post: items[0], cost };
      }),
  );

  server.registerTool(
    "x_get_posts",
    {
      title: "X: Get Posts",
      description:
        "Get up to 100 posts by id in a single request. Always prefer this over calling " +
        "x_get_post repeatedly — X bills per post either way, but one request is far faster and " +
        "spends only one unit of rate limit. Ids that cannot be served come back under " +
        "`not_found` rather than failing the call.",
      inputSchema: z.object({
        postIds: z
          .array(postIdArg)
          .min(1)
          .max(100)
          .describe("Post ids to look up, up to 100 in one call."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ postIds }) =>
      wrap(async () => {
        // De-duplicate up front: asking for the same id twice in one call would
        // otherwise look like two reads to the caller reading the cost note.
        const unique = [...new Set(postIds)];
        const { items, cost, notFound } = await cachedByIds(
          ctx,
          "post",
          unique,
          fetchPosts,
          "x_get_posts",
        );
        return {
          posts: items,
          ...(notFound.length > 0 ? { not_found: notFound } : {}),
          cost,
        };
      }),
  );

  server.registerTool(
    "x_get_thread",
    {
      title: "X: Get Thread",
      description:
        "Reconstruct a conversation: every reply sharing the post's conversation_id, oldest " +
        "first. Note that this searches the last 7 days only, so an older thread returns just " +
        "the root post. Costs one post read per reply returned.",
      inputSchema: z.object({
        postId: postIdArg,
        maxResults: maxResultsArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ postId, maxResults }) =>
      wrap(async () => {
        // The root post carries the conversation_id, which may differ from its
        // own id when the post is itself a reply.
        const rootRaw = await client.get(`/2/tweets/${postId}`, compact({ ...POST_QUERY }));
        const rootShaped = shapePostsResponse({
          ...(isRecord(rootRaw) ? rootRaw : {}),
          data: isRecord(rootRaw) && isRecord(rootRaw.data) ? [rootRaw.data] : [],
        });
        const root = rootShaped.posts[0];
        if (!root) {
          return {
            error: `X returned no post for id ${postId}.`,
            cost: recordResultCost(ctx, "post", []),
          };
        }

        const conversationId = root.conversation_id ?? root.id;
        const replies = await client.paginate(
          "/2/tweets/search/recent",
          compact({
            query: `conversation_id:${conversationId}`,
            max_results: Math.min(Math.max(maxResults, 10), 100),
            sort_order: "recency",
            ...POST_QUERY,
          }),
          { maxItems: maxResults },
        );

        const shapedReplies = shapePostsResponse({
          data: replies.data,
          includes: replies.includes[0] ?? {},
        });
        // Oldest first: a thread reads top-down, but search returns newest first.
        const ordered = shapedReplies.posts.toReversed();
        const ids = [root.id, ...ordered.map((p) => p.id)];

        return {
          conversation_id: conversationId,
          posts: [root, ...ordered.filter((p) => p.id !== root.id)],
          ...(replies.nextToken ? { next_token: replies.nextToken } : {}),
          note:
            "Recent search reaches back 7 days. Replies older than that are not returned even " +
            "if the thread has more.",
          cost: recordResultCost(ctx, "post", ids),
        };
      }),
  );

  server.registerTool(
    "x_get_quotes",
    {
      title: "X: Get Quotes",
      description: "List posts quoting a given post, newest first.",
      inputSchema: z.object({
        postId: postIdArg,
        maxResults: maxResultsArg,
        paginationToken: paginationTokenArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ postId, maxResults, paginationToken }) =>
      wrap(async () => {
        const res = await client.paginate(
          `/2/tweets/${postId}/quote_tweets`,
          compact({
            max_results: Math.min(Math.max(maxResults, 10), 100),
            pagination_token: paginationToken,
            ...POST_QUERY,
          }),
          { maxItems: maxResults },
        );
        const shaped = shapePostsResponse({ data: res.data, includes: res.includes[0] ?? {} });
        return {
          posts: shaped.posts,
          result_count: shaped.posts.length,
          ...(res.nextToken ? { next_token: res.nextToken } : {}),
          cost: recordResultCost(
            ctx,
            "post",
            shaped.posts.map((p) => p.id),
          ),
        };
      }),
  );
};
