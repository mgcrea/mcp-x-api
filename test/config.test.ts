import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PRICING,
  DEFAULT_REDIRECT_URI,
  effectiveScopes,
  loadConfig,
  resolveConfigPath,
} from "../src/config.js";

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

  it("names both credentials when neither is set", () => {
    expect(() => loadConfig({}, absent)).toThrow(/X_API_BEARER_TOKEN.*X_API_CLIENT_ID/s);
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
