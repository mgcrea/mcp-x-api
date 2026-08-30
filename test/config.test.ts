import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PRICING,
  DEFAULT_REDIRECT_URI,
  effectiveScopes,
  hasApiCredentials,
  loadConfig,
  resolveConfigPath,
  setupInstructions,
  adsSetupInstructions,
  hasAdsAccess,
  DEFAULT_ADS_BASE_URL,
  SANDBOX_ADS_BASE_URL,
} from "#/config";

let dir: string;
/** A path that does not exist, so "no config file" is the default in most tests. */
let absent: string;

const write = (name: string, body: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "x-api-config-"));
  absent = join(dir, "nope.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("accepts a bearer token alone and fills in the defaults", () => {
    const config = loadConfig({ X_API_BEARER_TOKEN: "bearer-abc" }, absent);
    expect(config.bearerToken).toBe("bearer-abc");
    expect(config.redirectUri).toBe(DEFAULT_REDIRECT_URI);
    expect(config.allowWrites).toBe(false);
    expect(config.writeBackend).toBe("intent");
    expect(config.enableFullArchive).toBe(false);
    expect(config.cacheEnabled).toBe(true);
    expect(config.pricing).toEqual(DEFAULT_PRICING);
  });

  it("defaults maxResults to 10, not 50 — a 100-result search costs $0.50", () => {
    expect(loadConfig({ X_API_BEARER_TOKEN: "t" }, absent).defaultMaxResults).toBe(10);
  });

  // An MCP server that exits on startup surfaces as a bare "Connection closed"
  // with stderr swallowed, and takes the credential-free tools down with it.
  it("loads with no credentials at all rather than throwing", () => {
    const config = loadConfig({}, absent);
    expect(config.bearerToken).toBeUndefined();
    expect(config.clientId).toBeUndefined();
    expect(hasApiCredentials(config)).toBe(false);
  });

  it("reports credentials once either one is set", () => {
    expect(hasApiCredentials(loadConfig({ X_API_BEARER_TOKEN: "t" }, absent))).toBe(true);
    expect(hasApiCredentials(loadConfig({ X_API_CLIENT_ID: "c" }, absent))).toBe(true);
  });

  it("rejects the paid write backend without a client id, pointing at the free one", () => {
    expect(() =>
      loadConfig({ X_API_BEARER_TOKEN: "t", X_API_WRITE_BACKEND: "api" }, absent),
    ).toThrow(/x-api-mcp login[\s\S]*intent/);
  });

  it("accepts the paid write backend once a client id is present", () => {
    const config = loadConfig(
      { X_API_CLIENT_ID: "cid", X_API_WRITE_BACKEND: "api", X_API_ALLOW_WRITES: "1" },
      absent,
    );
    expect(config.writeBackend).toBe("api");
    expect(config.allowWrites).toBe(true);
  });

  it("reads a file-only config", () => {
    const path = write("config.json", { bearerToken: "from-file", defaultMaxResults: 25 });
    const config = loadConfig({}, path);
    expect(config.bearerToken).toBe("from-file");
    expect(config.defaultMaxResults).toBe(25);
  });

  it("merges env over file per field, not whole-source", () => {
    const path = write("config.json", {
      bearerToken: "from-file",
      clientId: "cid-from-file",
      defaultMaxResults: 25,
    });
    const config = loadConfig({ X_API_BEARER_TOKEN: "from-env" }, path);
    expect(config.bearerToken).toBe("from-env");
    // Untouched by the env, so the file still wins for these.
    expect(config.clientId).toBe("cid-from-file");
    expect(config.defaultMaxResults).toBe(25);
  });

  it("lets X_API_ALLOW_WRITES=0 override a file that says true", () => {
    const path = write("config.json", { bearerToken: "t", allowWrites: true });
    expect(loadConfig({ X_API_ALLOW_WRITES: "0" }, path).allowWrites).toBe(false);
  });

  it("treats an empty env var as unset rather than as an empty value", () => {
    const path = write("config.json", { bearerToken: "from-file" });
    expect(loadConfig({ X_API_BEARER_TOKEN: "   " }, path).bearerToken).toBe("from-file");
  });

  it("errors on an unknown file key instead of silently ignoring it", () => {
    const path = write("config.json", { bearerToken: "t", bearerTokn: "typo" });
    expect(() => loadConfig({}, path)).toThrow(/bearerTokn|Unrecognized/);
  });

  it("reports malformed JSON with the path, so it is not mistaken for a missing file", () => {
    const path = write("config.json", "{ not json");
    expect(() => loadConfig({ X_API_BEARER_TOKEN: "t" }, path)).toThrow(
      new RegExp(`not valid JSON[\\s\\S]*|${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  });

  it("is silent when the config file is simply absent", () => {
    expect(() => loadConfig({ X_API_BEARER_TOKEN: "t" }, absent)).not.toThrow();
  });

  it("still rejects the one combination that is a genuine misconfiguration", () => {
    // Missing credentials is a state to guide out of; asking for the paid write
    // backend without the credential it requires is a contradiction.
    expect(() => loadConfig({ X_API_WRITE_BACKEND: "api" }, absent)).toThrow(/x-api-mcp login/);
  });

  it("parses scopes from a comma- or space-separated env var", () => {
    const comma = loadConfig({ X_API_CLIENT_ID: "c", X_API_SCOPES: "a,b , c" }, absent);
    expect(comma.scopes).toEqual(["a", "b", "c"]);
    const space = loadConfig({ X_API_CLIENT_ID: "c", X_API_SCOPES: "a b c" }, absent);
    expect(space.scopes).toEqual(["a", "b", "c"]);
  });

  it("expands ~ in the token file path", () => {
    const config = loadConfig(
      { X_API_BEARER_TOKEN: "t", X_API_TOKEN_FILE: "~/x-tokens.json" },
      absent,
    );
    expect(config.tokenFile).not.toContain("~");
    expect(config.tokenFile.endsWith("/x-tokens.json")).toBe(true);
  });

  it("lets the config file override individual prices without restating the table", () => {
    const path = write("config.json", { bearerToken: "t", pricing: { postRead: 0.009 } });
    const config = loadConfig({}, path);
    expect(config.pricing.postRead).toBe(0.009);
    expect(config.pricing.userRead).toBe(DEFAULT_PRICING.userRead);
  });

  it("parses a monthly budget as a float, not an integer", () => {
    expect(
      loadConfig({ X_API_BEARER_TOKEN: "t", X_API_MONTHLY_BUDGET_USD: "12.50" }, absent)
        .monthlyBudgetUsd,
    ).toBe(12.5);
  });
});

describe("resolveConfigPath", () => {
  it("prefers an explicit override", () => {
    expect(resolveConfigPath({ X_API_CONFIG: "/tmp/x.json" })).toBe("/tmp/x.json");
  });

  it("falls back to XDG_CONFIG_HOME", () => {
    expect(resolveConfigPath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/x-api/config.json");
  });

  it("defaults the token file next to the config file", () => {
    const config = loadConfig({ X_API_BEARER_TOKEN: "t", XDG_CONFIG_HOME: "/xdg" }, absent);
    expect(config.tokenFile).toBe("/xdg/x-api/tokens.json");
  });
});

describe("setupInstructions", () => {
  it("names both credentials, the free tools, and the exact callback URL to register", () => {
    const text = setupInstructions(loadConfig({}, absent)).join(" ");
    expect(text).toContain("X_API_BEARER_TOKEN");
    expect(text).toContain("X_API_CLIENT_ID");
    expect(text).toContain("x_compose_post");
    expect(text).toContain(DEFAULT_REDIRECT_URI);
    // The stale-docs trap: people still expect a free tier.
    expect(text).toMatch(/free tier on 2026-02-06/);
  });

  it("sends people to the current console, not the legacy developer portal", () => {
    const text = setupInstructions(loadConfig({}, absent)).join(" ");
    expect(text).toContain("console.x.com");
    expect(text).not.toMatch(/developer\.x\.com\/en\/portal/);
  });

  it("names the two settings that are easy to get wrong", () => {
    const text = setupInstructions(loadConfig({}, absent)).join(" ");
    // Native App is what yields a public PKCE client with no secret.
    expect(text).toContain("Native App");
    // And the enrollment state that otherwise 403s every call after login.
    expect(text).toMatch(/Pay-per-use/);
    expect(text).toMatch(/client-not-enrolled/);
  });
});

describe("effectiveScopes", () => {
  it("does not request tweet.write for a reader", () => {
    const config = loadConfig({ X_API_CLIENT_ID: "c" }, absent);
    expect(effectiveScopes(config)).not.toContain("tweet.write");
  });

  it("adds tweet.write only when the paid write backend is enabled", () => {
    const config = loadConfig(
      { X_API_CLIENT_ID: "c", X_API_ALLOW_WRITES: "1", X_API_WRITE_BACKEND: "api" },
      absent,
    );
    expect(effectiveScopes(config)).toContain("tweet.write");
  });

  it("does not add tweet.write when writes are allowed but the backend is intent", () => {
    const config = loadConfig({ X_API_CLIENT_ID: "c", X_API_ALLOW_WRITES: "1" }, absent);
    expect(effectiveScopes(config)).not.toContain("tweet.write");
  });
});

describe("ads configuration", () => {
  it("is off by default, so nothing ads-related is registered unasked", () => {
    const config = loadConfig({ X_API_CLIENT_ID: "c" }, absent);
    expect(config.adsEnabled).toBe(false);
    expect(config.adsAllowWrites).toBe(false);
    expect(hasAdsAccess(config)).toBe(false);
  });

  it("needs a user context, because a Bearer token cannot reach the Ads API", () => {
    expect(() => loadConfig({ X_API_BEARER_TOKEN: "t", X_ADS_ENABLED: "1" }, absent)).toThrow(
      /X_API_CLIENT_ID/,
    );
    expect(hasAdsAccess(loadConfig({ X_API_CLIENT_ID: "c", X_ADS_ENABLED: "1" }, absent))).toBe(
      true,
    );
  });

  it("refuses ads writes switched on without ads itself, rather than ignoring them", () => {
    expect(() => loadConfig({ X_API_CLIENT_ID: "c", X_ADS_ALLOW_WRITES: "1" }, absent)).toThrow(
      /X_ADS_ENABLED/,
    );
  });

  it("defaults to production, and detects the sandbox by host", () => {
    expect(loadConfig({}, absent).adsBaseUrl).toBe(DEFAULT_ADS_BASE_URL);
    // X's docs name a sandbox host with no DNS record at all; this is the one
    // that resolves, so the constant is not a typo waiting to be corrected.
    expect(SANDBOX_ADS_BASE_URL).toBe("https://ads-api-sandbox.twitter.com");
  });

  it("reads ads settings from the config file, and rejects a misspelled key", () => {
    const path = write("ads.json", {
      clientId: "c",
      adsEnabled: true,
      adsAccountId: "18ce54d4x5t",
    });
    const config = loadConfig({}, path);
    expect(config.adsEnabled).toBe(true);
    expect(config.adsAccountId).toBe("18ce54d4x5t");

    const typo = write("typo.json", { clientId: "c", adsEnable: true });
    expect(() => loadConfig({}, typo)).toThrow(/not valid/);
  });

  it("lets the environment override the file per field, as everywhere else", () => {
    const path = write("both.json", { clientId: "c", adsEnabled: true, adsAllowWrites: true });
    expect(loadConfig({ X_ADS_ALLOW_WRITES: "0" }, path).adsAllowWrites).toBe(false);
  });

  it("names the two steps people miss in the ads setup guidance", () => {
    const guidance = adsSetupInstructions(loadConfig({ X_API_CLIENT_ID: "c" }, absent)).join(" ");
    expect(guidance).toContain("Ads Project");
    // A token minted before approval authenticates fine and then fails every
    // call, which reads as a scope problem and is not one.
    expect(guidance).toMatch(/before approval/);
    expect(guidance).toContain(SANDBOX_ADS_BASE_URL);
  });
});
