import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { fileMode } from "#/client/tokens";
import type { ToolContext } from "#/tools/index";
import { wrap } from "#/tools/util";

export const registerAuthTools = (server: McpServer, ctx: ToolContext): void => {
  server.registerTool(
    "x_auth_status",
    {
      title: "X: Auth Status",
      description:
        "Which credentials this server is holding: an app-only Bearer token (enough for public " +
        "reads and search), an OAuth2 user session (needed for bookmarks and the home timeline), " +
        "or neither. Shows the logged-in handle, granted scopes and token expiry, and whether " +
        "the Ads API tools are registered and against which environment. Call this first if the " +
        "X API tools seem to be missing — it explains exactly what to configure.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        const status = ctx.tokenProvider.describe();
        const mode = ctx.tokenFile ? fileMode(ctx.tokenFile) : undefined;

        // The state a first-time user lands in. Answer it as a setup guide
        // rather than a status dump, since the server can no longer signal this
        // by refusing to start.
        if (!ctx.hasCredentials) {
          return {
            configured: false,
            app_only_bearer: false,
            user: { authenticated: false, reason: "no credentials configured" },
            can_read_public: false,
            can_read_bookmarks: false,
            available_without_credentials: [
              "x_compose_post",
              "x_validate_post",
              "x_build_search_query",
              "x_auth_status",
            ],
            setup: ctx.setup ?? [],
          };
        }

        return {
          configured: true,
          app_only_bearer: status.app,
          user: status.user.authenticated
            ? {
                ...status.user,
                expires_at: new Date(status.user.expiresAt).toISOString(),
                expires_in_seconds: Math.max(
                  0,
                  Math.round((status.user.expiresAt - Date.now()) / 1000),
                ),
              }
            : status.user,
          ...(ctx.tokenFile
            ? {
                token_file: {
                  path: ctx.tokenFile,
                  mode: mode === undefined ? "absent" : `0${mode.toString(8)}`,
                  ...(mode !== undefined && (mode & 0o077) !== 0
                    ? { warning: `Readable by other users. Run: chmod 600 ${ctx.tokenFile}` }
                    : {}),
                },
              }
            : {}),
          can_read_public: status.app || status.user.authenticated,
          can_read_bookmarks: status.user.authenticated,
          ads: ctx.ads
            ? {
                enabled: true,
                environment: ctx.ads.sandbox ? "sandbox" : "production",
                base_url: ctx.ads.baseUrl,
                writes_enabled: ctx.ads.allowWrites,
                default_account_id: ctx.ads.accountId ?? null,
                note: ctx.ads.sandbox
                  ? "Sandbox — campaigns here spend nothing."
                  : "PRODUCTION — these tools read and can change campaigns that spend real money.",
              }
            : {
                enabled: false,
                reason: ctx.adsSetup
                  ? "X_ADS_ENABLED is not set."
                  : "no OAuth2 client id configured",
                ...(ctx.adsSetup ? { setup: ctx.adsSetup } : {}),
              },
        };
      }),
  );

  if (!ctx.login) return;

  const login = ctx.login;

  server.registerTool(
    "x_auth_login",
    {
      title: "X: Auth Login",
      description:
        "Start the OAuth2 login. Prints a URL (and opens your browser) for you to authorize the " +
        "app, waits up to two minutes for the callback, then stores a refresh token in the token " +
        "file with mode 600. Only needed for bookmarks, the home timeline and API writes — " +
        "public reads and search work with the Bearer token alone.",
      inputSchema: {
        open: z.boolean().default(true).describe("Open the authorize URL in your browser."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ open }) =>
      wrap(async () => {
        const result = await login(open);
        return {
          authenticated: true,
          username: result.username,
          userId: result.userId,
          scopes: result.scopes,
          token_file: result.tokenFile,
          note: "The refresh token is stored with mode 600 and rotates on every refresh.",
        };
      }),
  );

  server.registerTool(
    "x_auth_logout",
    {
      title: "X: Auth Logout",
      description:
        "Delete the stored OAuth2 tokens. The app-only Bearer token is unaffected, so public " +
        "reads and search keep working.",
      inputSchema: {
        confirm: z
          .literal(true)
          .describe("Must be true. You will need to run the login flow again to undo this."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async () =>
      wrap(async () => {
        ctx.logout?.();
        return {
          logged_out: true,
          note: "Public reads and search continue to work if a Bearer token is configured.",
        };
      }),
  );
};
