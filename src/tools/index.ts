import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { TokenProvider } from "../client/auth.js";
import type { DayCache } from "../client/cache.js";
import type { Ledger } from "../client/cost.js";
import type { XApiClient } from "../client/x.js";
import type { Pricing } from "../config.js";
import { registerAuthTools } from "./auth.js";
import { registerComposeTools } from "./compose.js";
import { registerPostTools } from "./posts.js";
import { registerSearchTools } from "./search.js";
import { registerTimelineTools } from "./timelines.js";
import { registerUsageTools } from "./usage.js";
import { registerUserTools } from "./users.js";

/**
 * Threaded through every tool rather than a bare `allowWrites` boolean: the
 * cache and ledger are needed by every read tool, so a boolean would have been
 * widened on the first commit anyway.
 */
export type ToolContext = {
  /** Register the paid write tools too. Off by default — see X_API_ALLOW_WRITES. */
  allowWrites: boolean;
  /** "intent" (free web-intent URLs, the default) or "api" (paid POST /2/tweets). */
  writeBackend: "intent" | "api";
  autoOpenBrowser: boolean;
  /** Register x_search_all. Off by default — full-archive search needs a paid tier. */
  enableFullArchive: boolean;
  defaultMaxResults: number;
  pricing: Pricing;
  budgetUsd?: number | undefined;
  cache: DayCache;
  ledger: Ledger;
  tokenProvider: TokenProvider;
  /** Where the OAuth tokens live, for x_auth_status. Absent when OAuth is unconfigured. */
  tokenFile?: string | undefined;
  /** Present only when a client id is configured; its presence registers the login tools. */
  login?: ((open: boolean) => Promise<LoginSummary>) | undefined;
  logout?: (() => void) | undefined;
};

export type LoginSummary = {
  username?: string | undefined;
  userId?: string | undefined;
  scopes: string[];
  tokenFile: string;
};

/**
 * Register the X API tools.
 *
 * Read tools and the free compose tools are always registered. The paid write
 * tools appear only when `allowWrites` *and* `writeBackend === "api"`;
 * `x_search_all` only when full-archive access is enabled; and the login tools
 * and user-context timelines only when an OAuth client id is configured — so
 * with the defaults those tools are not merely refused, they are invisible and
 * cannot be called at all.
 */
export const registerTools = (server: McpServer, client: XApiClient, ctx: ToolContext): void => {
  registerPostTools(server, client, ctx);
  registerUserTools(server, client, ctx);
  registerSearchTools(server, client, ctx);
  registerComposeTools(server, client, ctx);
  registerAuthTools(server, ctx);
  registerUsageTools(server, client, ctx);
  // Bookmarks and the home timeline are unreachable without a user session, so
  // registering them Bearer-only would just hand the model two tools that
  // always fail with the same message.
  if (ctx.login) registerTimelineTools(server, client, ctx);
};
