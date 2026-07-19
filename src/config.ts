import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

export const DEFAULT_BASE_URL = "https://api.x.com";

/**
 * A fixed loopback port, deliberately not an ephemeral one. Unlike most OAuth
 * providers, X matches the callback URL against the value registered in the
 * developer portal byte-for-byte, so a random port can never be authorized.
 */
export const DEFAULT_REDIRECT_URI = "http://127.0.0.1:8723/callback";

/**
 * `offline.access` is what makes a refresh token come back at all — without it
 * the user has to re-login every two hours. `tweet.write` is appended at
 * startup when the paid write backend is enabled, so a read-only install never
 * asks for a permission it cannot use.
 */
export const DEFAULT_SCOPES = ["tweet.read", "users.read", "bookmark.read", "offline.access"];

/**
 * X moved to pay-per-use on 2026-02-06; there is no free tier for new
 * developers. These are list prices in USD, overridable via the config file's
 * `pricing` key because a table baked into a schema with no escape hatch is
 * wrong the day X changes it.
 *
 * The 24h dedup window is the load-bearing rule: within one UTC day, re-reading
 * a resource id you already paid for is free. That is why the ledger keys on
 * (kind, id, utcDay) rather than counting requests.
 */
export const DEFAULT_PRICING = {
  postRead: 0.005,
  userRead: 0.01,
  /** Your own posts and profile — five times cheaper than reading someone else's. */
  ownedRead: 0.001,
  postCreate: 0.015,
  /** A post containing a URL costs 40x a post read. Not a typo. */
  postCreateWithUrl: 0.2,
  monthlyReadCap: 2_000_000,
  effectiveFrom: "2026-02-06",
};

const PricingSchema = z
  .object({
    postRead: z.number().nonnegative().default(DEFAULT_PRICING.postRead),
    userRead: z.number().nonnegative().default(DEFAULT_PRICING.userRead),
    ownedRead: z.number().nonnegative().default(DEFAULT_PRICING.ownedRead),
    postCreate: z.number().nonnegative().default(DEFAULT_PRICING.postCreate),
    postCreateWithUrl: z.number().nonnegative().default(DEFAULT_PRICING.postCreateWithUrl),
    monthlyReadCap: z.number().int().positive().default(DEFAULT_PRICING.monthlyReadCap),
    effectiveFrom: z.string().default(DEFAULT_PRICING.effectiveFrom),
  })
  .strict();

export type Pricing = z.infer<typeof PricingSchema>;

const ConfigSchema = z
  .object({
    bearerToken: z.string().min(1).optional(),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    redirectUri: z.string().min(1).default(DEFAULT_REDIRECT_URI),
    scopes: z.array(z.string().min(1)).min(1).default(DEFAULT_SCOPES),
    tokenFile: z.string().min(1),
    allowWrites: z.boolean().default(false),
    writeBackend: z.enum(["intent", "api"]).default("intent"),
    autoOpenBrowser: z.boolean().default(true),
    enableFullArchive: z.boolean().default(false),
    defaultMaxResults: z.number().int().min(1).max(100).default(10),
    monthlyBudgetUsd: z.number().nonnegative().optional(),
    cacheEnabled: z.boolean().default(true),
    cacheMaxEntries: z.number().int().min(0).max(100_000).default(5000),
    maxRetries: z.number().int().nonnegative().max(10).default(3),
    baseUrl: z.string().min(1).default(DEFAULT_BASE_URL),
    pricing: PricingSchema.default(DEFAULT_PRICING),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // Deliberately NOT an error when no credentials are set. An MCP server that
    // exits on startup shows up in the client as a bare "Connection closed",
    // with stderr swallowed — so the one message that would have explained the
    // problem never reaches anyone. Worse, it makes the free tools
    // (x_compose_post, x_validate_post, x_build_search_query) unreachable even
    // though they need no credentials at all, and leaves no way to discover
    // that OAuth needs X_API_CLIENT_ID. The server starts; `x_auth_status`
    // and the startup banner report what is missing.
    if (cfg.writeBackend === "api" && !cfg.clientId) {
      ctx.addIssue({
        code: "custom",
        message:
          "X_API_WRITE_BACKEND=api needs a user context: set X_API_CLIENT_ID and run " +
          "`x-api-mcp login`. The default backend (intent) needs no credentials at all — it " +
          "returns an x.com/intent/tweet URL you click, which costs nothing.",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

/**
 * The on-disk config document. Keys are camelCase to mirror `Config` rather than
 * the env var names: this is a typed JSON file, not a shell.
 *
 * `.strict()` on purpose — a typo'd `clientID` must be an error. Silently
 * ignoring an unknown key looks exactly like "that setting had no effect",
 * which is the worst way to learn your credentials came from somewhere else.
 */
const FileConfigSchema = z
  .object({
    bearerToken: z.string().min(1).optional(),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    redirectUri: z.string().min(1).optional(),
    scopes: z.array(z.string().min(1)).min(1).optional(),
    tokenFile: z.string().min(1).optional(),
    allowWrites: z.boolean().optional(),
    writeBackend: z.enum(["intent", "api"]).optional(),
    autoOpenBrowser: z.boolean().optional(),
    enableFullArchive: z.boolean().optional(),
    defaultMaxResults: z.number().int().min(1).max(100).optional(),
    monthlyBudgetUsd: z.number().nonnegative().optional(),
    cacheEnabled: z.boolean().optional(),
    cacheMaxEntries: z.number().int().min(0).max(100_000).optional(),
    maxRetries: z.number().int().nonnegative().max(10).optional(),
    baseUrl: z.string().min(1).optional(),
    pricing: PricingSchema.optional(),
  })
  .strict();

export type FileConfig = z.infer<typeof FileConfigSchema>;

const parseBool = (value: string | undefined): boolean | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(t.toLowerCase());
};

const parseIntOpt = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
};

const parseFloatOpt = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

/** Scopes are space-separated in OAuth but commas are what people actually type. */
const parseList = (value: string | undefined): string[] | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  const items = t
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
};

const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** `readFileSync` does not expand `~`, but it is the natural thing to write in a config file. */
export const expandTilde = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

/**
 * Where the config file lives, most specific first: an explicit override, then
 * the XDG location, then the conventional `~/.config`.
 */
export const resolveConfigPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicit = trimmed(env.X_API_CONFIG);
  if (explicit) return expandTilde(explicit);
  const base = trimmed(env.XDG_CONFIG_HOME) ?? join(homedir(), ".config");
  return join(expandTilde(base), "x-api", "config.json");
};

/** The OAuth token file sits beside the config file unless told otherwise. */
export const resolveTokenPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(dirname(resolveConfigPath(env)), "tokens.json");

/**
 * These files hold a bearer token or a refresh token, so being readable by
 * other users is worth saying out loud. It is a warning and not an error:
 * refusing to start would be a worse trade for someone on a single-user machine.
 */
export const warnIfGroupReadable = (path: string): void => {
  if (process.platform === "win32") return; // mode bits mean nothing here
  try {
    if (statSync(path).mode & 0o077) {
      process.stderr.write(`[x-api] ${path} is readable by other users. Run: chmod 600 ${path}\n`);
    }
  } catch {
    // Not worth failing startup over; the read below reports anything that matters.
  }
};

/**
 * Read the config file, treating "absent" as "contributes nothing". Every other
 * failure throws and names the path, so a malformed file is never mistaken for
 * a missing one — that confusion would send you hunting for credentials that
 * were sitting right there.
 */
const readConfigFile = (path: string): FileConfig => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read the config file (${path}): ${message(err)}`, { cause: err });
  }

  warnIfGroupReadable(path);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`The config file (${path}) is not valid JSON: ${message(err)}`, { cause: err });
  }

  const result = FileConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`The config file (${path}) is not valid: ${issues}`);
  }
  return result.data;
};

/**
 * Environment first, config file second, **per field** — not whole-source.
 * Docker and CI inject the environment and must keep working untouched, while a
 * one-off `X_API_ALLOW_WRITES=0` still has to override a file that says `true`.
 * Merging field by field is the only rule that gives both.
 */
export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = resolveConfigPath(env),
): Config => {
  const file = readConfigFile(configPath);
  const tokenFile = trimmed(env.X_API_TOKEN_FILE) ?? file.tokenFile ?? resolveTokenPath(env);
  return ConfigSchema.parse({
    bearerToken: trimmed(env.X_API_BEARER_TOKEN) ?? file.bearerToken,
    clientId: trimmed(env.X_API_CLIENT_ID) ?? file.clientId,
    clientSecret: trimmed(env.X_API_CLIENT_SECRET) ?? file.clientSecret,
    redirectUri: trimmed(env.X_API_REDIRECT_URI) ?? file.redirectUri,
    scopes: parseList(env.X_API_SCOPES) ?? file.scopes,
    tokenFile: expandTilde(tokenFile),
    allowWrites: parseBool(env.X_API_ALLOW_WRITES) ?? file.allowWrites,
    writeBackend: trimmed(env.X_API_WRITE_BACKEND) ?? file.writeBackend,
    autoOpenBrowser: parseBool(env.X_API_AUTO_OPEN_BROWSER) ?? file.autoOpenBrowser,
    enableFullArchive: parseBool(env.X_API_ENABLE_FULL_ARCHIVE) ?? file.enableFullArchive,
    defaultMaxResults: parseIntOpt(env.X_API_DEFAULT_MAX_RESULTS) ?? file.defaultMaxResults,
    monthlyBudgetUsd: parseFloatOpt(env.X_API_MONTHLY_BUDGET_USD) ?? file.monthlyBudgetUsd,
    cacheEnabled: parseBool(env.X_API_CACHE_ENABLED) ?? file.cacheEnabled,
    cacheMaxEntries: parseIntOpt(env.X_API_CACHE_MAX_ENTRIES) ?? file.cacheMaxEntries,
    maxRetries: parseIntOpt(env.X_API_MAX_RETRIES) ?? file.maxRetries,
    baseUrl: trimmed(env.X_API_BASE_URL) ?? file.baseUrl,
    pricing: file.pricing,
  });
};

/** Whether anything at all is configured that can reach the X API. */
export const hasApiCredentials = (config: Config): boolean =>
  Boolean(config.bearerToken ?? config.clientId);

/**
 * What to do when nothing is configured. Returned by `x_auth_status` and
 * printed at startup, because this is the state a first-time user lands in and
 * the server can no longer signal it by refusing to start.
 */
export const setupInstructions = (config: Config): string[] => [
  "No X credentials are configured, so the tools that call the X API are not registered.",
  "The free local tools still work: x_compose_post (posts via a browser click, no credentials, " +
    "no cost), x_validate_post, and x_build_search_query.",
  // The portal moved with the February 2026 pricing change; developer.x.com is
  // legacy, and sending people there is the fastest way to lose them.
  "Create an app at https://console.x.com (this replaced the old developer.x.com portal). Both " +
    "credentials below are on the app's Keys and Tokens screen.",
  "To enable reading and search, set X_API_BEARER_TOKEN to the app's Bearer Token. That alone " +
    "covers post lookup, search, profiles and timelines — OAuth is not needed for any of it.",
  "To enable bookmarks, your home timeline and API writes, also set X_API_CLIENT_ID. When " +
    "creating the app choose Type of App = Native App: that makes it a public PKCE client with " +
    `no client secret, which is what this server expects. Register the callback URL ` +
    `${config.redirectUri} byte for byte (X's docs say to use 127.0.0.1 rather than localhost), ` +
    "then run `x-api-mcp login` or call x_auth_login.",
  "Enroll the app in the Pay-per-use package and the Production environment. An app left in the " +
    "legacy Free/Development state logs in successfully and then fails every call with 403 " +
    "client-not-enrolled.",
  "Note that X removed its free tier on 2026-02-06: creating an app is free, but reads are " +
    "pay-per-use and need prepurchased credits in the console.",
];

/**
 * The scopes actually requested at login. `tweet.write` is only asked for when
 * the paid write backend is on, so a reader never holds a permission it cannot
 * use — and the consent screen stays honest about what the server will do.
 */
export const effectiveScopes = (config: Config): string[] => {
  const scopes = [...config.scopes];
  if (config.allowWrites && config.writeBackend === "api" && !scopes.includes("tweet.write")) {
    scopes.push("tweet.write");
  }
  return scopes;
};
