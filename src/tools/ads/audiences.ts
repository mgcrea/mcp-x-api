import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AdsApiClient } from "../../client/ads.js";
import { wrap } from "../util.js";
import { accountIdArg, adsCostNote, adsCountArg, shapeAds } from "./util.js";

export const registerAdsAudienceTools = (
  server: McpServer,
  client: AdsApiClient,
  resolveAccount: (explicit?: string) => Promise<string>,
): void => {
  server.registerTool(
    "x_ads_get_audiences",
    {
      description:
        "List an account's custom audiences with their size and targetability. Use an audience's " +
        "id as the targetingValue of a CUSTOM_AUDIENCE criterion. Read-only: uploading audience " +
        "members means handling personal data and is deliberately not exposed here. Note that " +
        '"tailored audiences" is the old name for these and its endpoints are long gone.',
      inputSchema: { accountId: accountIdArg, count: adsCountArg },
      annotations: { readOnlyHint: true },
    },
    async ({ accountId, count }) =>
      wrap(async () => {
        const id = await resolveAccount(accountId);
        const page = await client.paginateCursor(
          `/12/accounts/${id}/custom_audiences`,
          { count },
          { maxItems: count },
        );
        return {
          account_id: id,
          audiences: shapeAds({ data: page.data }),
          ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
          cost: adsCostNote(),
        };
      }),
  );
};
