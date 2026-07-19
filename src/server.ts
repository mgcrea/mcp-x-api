import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILD_INFO } from "./build-info.js";
import {
  bearerTokenProvider,
  compositeTokenProvider,
  userTokenProvider,
  type Logger,
  type TokenProvider,
} from "./client/auth.js";
import { createDayCache, type DayCache } from "./client/cache.js";
import { createLedger, type Ledger } from "./client/cost.js";
import { createOAuthClient, startLoginFlow } from "./client/oauth.js";
import { createTokenStore, type TokenStore } from "./client/tokens.js";
import { XApiClient } from "./client/x.js";
import { openInBrowser } from "./compose/open.js";
import { effectiveScopes, hasApiCredentials, setupInstructions, type Config } from "./config.js";
import { registerTools } from "./tools/index.js";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;
export const USER_AGENT = `mcp-x-api-js/${BUILD_INFO.version}`;

export type CreateServerOptions = {
  config: Config;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Override the token provider (tests, and the OAuth user flow). */
  tokenProvider?: TokenProvider;
  now?: () => number;
};

export type CreatedServer = {
  server: McpServer;
  client: XApiClient;
  tokenProvider: TokenProvider;
  cache: DayCache;
  ledger: Ledger;
  store: TokenStore;
};

export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const scopes = effectiveScopes(config);
  const store = createTokenStore(config.tokenFile);

  const tokenProvider =
    opts.tokenProvider ??
    compositeTokenProvider({
      ...(config.bearerToken ? { app: bearerTokenProvider(config.bearerToken) } : {}),
      ...(config.clientId
        ? {
            user: userTokenProvider({
              store,
              oauth: createOAuthClient(config, opts.fetch ?? fetch),
              clientId: config.clientId,
              requiredScopes: scopes,
              ...(opts.logger ? { logger: opts.logger } : {}),
              ...(opts.now ? { now: opts.now } : {}),
            }),
          }
        : {}),
    });

  const client = new XApiClient({
    baseUrl: config.baseUrl,
    tokenProvider,
    maxRetries: config.maxRetries,
    userAgent: USER_AGENT,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  const cache = createDayCache({
    maxEntries: config.cacheMaxEntries,
    enabled: config.cacheEnabled,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const ledger = createLedger({
    pricing: config.pricing,
    budgetUsd: config.monthlyBudgetUsd,
    ...(opts.now ? { now: opts.now } : {}),
  });

  registerTools(server, client, {
    allowWrites: config.allowWrites,
    writeBackend: config.writeBackend,
    autoOpenBrowser: config.autoOpenBrowser,
    enableFullArchive: config.enableFullArchive,
    defaultMaxResults: config.defaultMaxResults,
    pricing: config.pricing,
    budgetUsd: config.monthlyBudgetUsd,
    cache,
    ledger,
    tokenProvider,
    hasCredentials: hasApiCredentials(config),
    ...(hasApiCredentials(config) ? {} : { setup: setupInstructions(config) }),
    ...(config.clientId
      ? {
          tokenFile: config.tokenFile,
          tokenStore: store,
          login: async (open: boolean) => {
            const { tokens } = await startLoginFlow({
              config,
              store,
              ...(opts.fetch ? { fetch: opts.fetch } : {}),
              ...(open ? { openBrowser: openInBrowser } : {}),
              ...(opts.logger ? { logger: opts.logger } : {}),
              ...(opts.now ? { now: opts.now } : {}),
            });
            return {
              username: tokens.username,
              userId: tokens.userId,
              scopes: tokens.scopes,
              tokenFile: config.tokenFile,
            };
          },
          logout: () => store.clear(),
        }
      : {}),
  });

  return { server, client, tokenProvider, cache, ledger, store };
};
