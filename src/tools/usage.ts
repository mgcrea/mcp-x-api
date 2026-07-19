import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { XApiClient } from "../client/x.js";
import type { ToolContext } from "./index.js";
import { wrap } from "./util.js";

export const registerUsageTools = (
  server: McpServer,
  client: XApiClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "x_usage_report",
    {
      description:
        "What this session has spent against X's pay-per-use rates, how much the dedup cache " +
        "saved, and the pricing table used to compute it. Estimates only, counted since this " +
        "process started — the X developer console (console.x.com) is the authoritative record.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => ctx.ledger.report(ctx.cache.stats())),
  );

  server.registerTool(
    "x_rate_limit_status",
    {
      description:
        "Rate-limit headroom per endpoint, as of the last response from each. Empty until at " +
        "least one request has been made. Useful when a call has just been rate-limited and you " +
        "need to know how long to wait.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        const limits = client.rateLimitStatus();
        return {
          endpoints: limits,
          ...(limits.length === 0
            ? { note: "No requests issued yet this session, so X has not reported any limits." }
            : {}),
        };
      }),
  );
};
