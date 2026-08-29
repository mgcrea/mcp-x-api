import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AdsApiClient } from "../../client/ads.js";
import type { ToolContext } from "../index.js";
import { registerAdsAccountTools } from "./accounts.js";
import { registerAdsAnalyticsTools } from "./analytics.js";
import { registerAdsAudienceTools } from "./audiences.js";
import { registerAdsCampaignTools } from "./campaigns.js";
import { registerAdsTargetingTools } from "./targeting.js";
import { createAccountResolver } from "./util.js";

/**
 * Register the X Ads API tools.
 *
 * Reads and the analytics-job tools are registered whenever ads is enabled.
 * The campaign-mutating tools appear only when `X_ADS_ALLOW_WRITES` is on, so
 * with the defaults they are not merely refused — they do not exist and cannot
 * be called. Sandbox-only tools appear only when pointed at the sandbox.
 *
 * The analytics-job tools sit with the reads rather than behind the write gate
 * on purpose: queuing a job changes nothing an advertiser can see and spends
 * nothing, so gating it would make long-range analytics unreachable in exactly
 * the configuration most people should be running.
 */
export const registerAdsTools = (
  server: McpServer,
  client: AdsApiClient,
  ctx: ToolContext,
): void => {
  const ads = ctx.ads;
  if (!ads) return;

  // One resolver shared by every tool, so the "which account?" lookup happens
  // at most once per process rather than once per call.
  const resolveAccount = createAccountResolver(client, ads);

  registerAdsAccountTools(server, client, ads, resolveAccount);
  registerAdsCampaignTools(server, client, ads, resolveAccount);
  registerAdsTargetingTools(server, client, ads, resolveAccount);
  registerAdsAudienceTools(server, client, resolveAccount);
  registerAdsAnalyticsTools(server, client, resolveAccount);
};
