import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { staticTokenProvider } from "#/client/auth";
import { effectiveScopes, loadConfig, type Config } from "#/config";
import { createServer } from "#/server";

const jsonResponse = (body: unknown, init: { status?: number } = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });

const ABSENT = "/nonexistent/config.json";

type Harness = {
  client: Client;
  fetchMock: ReturnType<typeof vi.fn>;
  toolNames: () => Promise<string[]>;
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  urls: () => string[];
};

const connect = async (
  env: Record<string, string> = { X_API_BEARER_TOKEN: "test-bearer" },
  fetchImpl?: ReturnType<typeof vi.fn>,
  /**
   * Most tests inject a token provider that satisfies both contexts, so they
   * never have to stage an OAuth session. Auth-shaped tests set this to build
   * the real provider chain from the config instead.
   */
  opts: { realAuth?: boolean } = {},
): Promise<Harness> => {
  const config: Config = loadConfig(env, ABSENT);
  const fetchMock = fetchImpl ?? vi.fn(async () => jsonResponse({ data: [] }));
  const { server } = createServer({
    config,
    fetch: fetchMock as unknown as typeof fetch,
    ...(opts.realAuth ? {} : { tokenProvider: staticTokenProvider("test-token") }),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    fetchMock,
    toolNames: async () => (await client.listTools()).tools.map((t) => t.name).sort(),
    call: async (name, args = {}) => {
      // A schema violation is rejected by the SDK at the protocol layer and
      // never reaches the tool body — which is the behaviour we want, so the
      // harness reports it as an error rather than failing to parse it.
      let res;
      try {
        res = await client.callTool({ name, arguments: args });
      } catch (err) {
        return { isToolError: true, rejected: true, error: String(err) };
      }
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
      try {
        return { ...JSON.parse(text), isToolError: res.isError === true };
      } catch {
        return { isToolError: res.isError === true, error: text };
      }
    },
    urls: () => fetchMock.mock.calls.map((c) => String(c[0])),
  };
};

describe("with no credentials configured", () => {
  // The regression that produced "MCP error -32000: Connection closed": the
  // server used to exit on startup, taking the credential-free tools with it
  // and leaving no way to discover what to configure.
  it("still connects, and serves the tools that need no credentials", async () => {
    const names = await (await connect({}, undefined, { realAuth: true })).toolNames();
    expect(names).toEqual([
      "x_auth_status",
      "x_build_search_query",
      "x_compose_post",
      "x_validate_post",
    ]);
  });

  it("does not register the tools that would call the X API", async () => {
    const names = await (await connect({}, undefined, { realAuth: true })).toolNames();
    for (const tool of ["x_get_post", "x_search_recent", "x_get_user", "x_usage_report"]) {
      expect(names).not.toContain(tool);
    }
  });

  it("composes a post for free, which is the whole point of still being up", async () => {
    const h = await connect({}, undefined, { realAuth: true });
    const res = await h.call("x_compose_post", {
      text: "works with zero credentials",
      open: false,
    });
    expect(res.valid).toBe(true);
    expect(res.intent_url).toMatch(/^https:\/\/x\.com\/intent\/tweet\?/);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("answers x_auth_status as a setup guide", async () => {
    const res = await (await connect({}, undefined, { realAuth: true })).call("x_auth_status");
    expect(res.configured).toBe(false);
    expect(res.available_without_credentials).toContain("x_compose_post");
    const setup = (res.setup as string[]).join(" ");
    expect(setup).toContain("X_API_BEARER_TOKEN");
    expect(setup).toContain("X_API_CLIENT_ID");
    expect(setup).toContain("x-api-mcp login");
  });
});

describe("tool registration matrix", () => {
  it("registers the read and free-compose tools with only a bearer token", async () => {
    const names = await (await connect()).toolNames();
    expect(names).toEqual([
      "x_auth_status",
      "x_build_search_query",
      "x_compose_post",
      "x_count_recent",
      "x_get_post",
      "x_get_posts",
      "x_get_quotes",
      "x_get_thread",
      "x_get_user",
      "x_get_user_mentions",
      "x_get_user_posts",
      "x_get_users",
      "x_rate_limit_status",
      "x_search_recent",
      "x_usage_report",
      "x_validate_post",
    ]);
  });

  it("does not register the paid write tools by default", async () => {
    const names = await (await connect()).toolNames();
    expect(names).not.toContain("x_create_post");
    expect(names).not.toContain("x_delete_post");
  });

  it("still hides the paid write tools when allowWrites is on but the backend is intent", async () => {
    const names = await (
      await connect({ X_API_BEARER_TOKEN: "t", X_API_ALLOW_WRITES: "1" })
    ).toolNames();
    expect(names).not.toContain("x_create_post");
  });

  it("registers the paid write tools only when both flags are set", async () => {
    const names = await (
      await connect({
        X_API_BEARER_TOKEN: "t",
        X_API_CLIENT_ID: "cid",
        X_API_ALLOW_WRITES: "1",
        X_API_WRITE_BACKEND: "api",
      })
    ).toolNames();
    expect(names).toContain("x_create_post");
    expect(names).toContain("x_delete_post");
  });

  // The inversion that is the point of the design: the free path is never gated.
  it("registers x_compose_post in every mode, including the most locked-down one", async () => {
    const modes: Record<string, string>[] = [
      { X_API_BEARER_TOKEN: "t" },
      { X_API_BEARER_TOKEN: "t", X_API_ALLOW_WRITES: "0" },
      {
        X_API_BEARER_TOKEN: "t",
        X_API_CLIENT_ID: "c",
        X_API_ALLOW_WRITES: "1",
        X_API_WRITE_BACKEND: "api",
      },
    ];
    for (const env of modes) {
      expect(await (await connect(env)).toolNames()).toContain("x_compose_post");
    }
  });

  it("hides the login and user-context tools without an OAuth client id", async () => {
    const names = await (await connect()).toolNames();
    for (const tool of [
      "x_auth_login",
      "x_auth_logout",
      "x_get_bookmarks",
      "x_get_home_timeline",
    ]) {
      expect(names).not.toContain(tool);
    }
    // Status is always available, so you can find out *why* the rest are missing.
    expect(names).toContain("x_auth_status");
  });

  it("registers the login and user-context tools once a client id is configured", async () => {
    const names = await (
      await connect({ X_API_BEARER_TOKEN: "t", X_API_CLIENT_ID: "cid" })
    ).toolNames();
    for (const tool of [
      "x_auth_login",
      "x_auth_logout",
      "x_get_bookmarks",
      "x_get_home_timeline",
    ]) {
      expect(names).toContain(tool);
    }
  });

  it("hides x_search_all unless full-archive access is enabled", async () => {
    expect(await (await connect()).toolNames()).not.toContain("x_search_all");
    const enabled = await connect({ X_API_BEARER_TOKEN: "t", X_API_ENABLE_FULL_ARCHIVE: "1" });
    expect(await enabled.toolNames()).toContain("x_search_all");
  });
});

describe("tool annotations", () => {
  it("marks reads read-only and deletes destructive", async () => {
    const h = await connect({
      X_API_BEARER_TOKEN: "t",
      X_API_CLIENT_ID: "c",
      X_API_ALLOW_WRITES: "1",
      X_API_WRITE_BACKEND: "api",
    });
    const tools = (await h.client.listTools()).tools;
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    expect(byName.get("x_get_post")?.readOnlyHint).toBe(true);
    expect(byName.get("x_search_recent")?.readOnlyHint).toBe(true);
    expect(byName.get("x_delete_post")?.destructiveHint).toBe(true);
    expect(byName.get("x_create_post")?.destructiveHint).toBe(false);
    // Not read-only (it may open a browser), but not destructive either.
    expect(byName.get("x_compose_post")?.readOnlyHint).toBe(false);
    expect(byName.get("x_compose_post")?.destructiveHint).toBe(false);
  });
});

describe("x_get_post", () => {
  const POST_RESPONSE = {
    data: [
      {
        id: "1799000000000000001",
        text: "hello world",
        author_id: "44196397",
        public_metrics: { like_count: 5, retweet_count: 1, reply_count: 0, quote_count: 0 },
      },
    ],
    includes: { users: [{ id: "44196397", username: "mgcrea", name: "Olivier" }] },
  };

  it("returns a shaped post with an inlined author and a cost note", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () => jsonResponse(POST_RESPONSE)),
    );
    const res = await h.call("x_get_post", { postId: "1799000000000000001" });
    expect(res.post.author).toBe("@mgcrea (Olivier)");
    expect(res.post.url).toBe("https://x.com/mgcrea/status/1799000000000000001");
    expect(res.cost).toMatchObject({ billable_post_reads: 1, estimated_usd: 0.005 });
    expect(res.post).not.toHaveProperty("author_id");
  });

  it("serves a repeat read from cache, issuing no second request", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(POST_RESPONSE));
    const h = await connect(undefined, fetchMock);
    await h.call("x_get_post", { postId: "1799000000000000001" });
    const second = await h.call("x_get_post", { postId: "1799000000000000001" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.post.id).toBe("1799000000000000001");
    expect(second.cost).toMatchObject({ billable_post_reads: 0, free_from_cache: 1 });
    expect(second.cost.estimated_usd).toBe(0);
    expect(second.cost.note).toMatch(/UTC midnight/);
  });

  it("explains a post X would not serve", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () => jsonResponse({ errors: [{ value: "1", title: "Not Found Error" }] })),
    );
    const res = await h.call("x_get_post", { postId: "1" });
    expect(res.error).toMatch(/deleted, protected, or from a suspended account/);
  });

  it("rejects a non-numeric post id at the schema, before any request", async () => {
    const h = await connect();
    const res = await h.call("x_get_post", { postId: "not-an-id" });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/digits only/);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe("x_get_posts", () => {
  it("batches every id into one request rather than N", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: "1", text: "a", author_id: "u" },
          { id: "2", text: "b", author_id: "u" },
          { id: "3", text: "c", author_id: "u" },
        ],
        includes: { users: [{ id: "u", username: "someone" }] },
      }),
    );
    const h = await connect(undefined, fetchMock);
    const res = await h.call("x_get_posts", { postIds: ["1", "2", "3"] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.urls()[0]).toContain("ids=1%2C2%2C3");
    expect(res.posts).toHaveLength(3);
    expect(res.cost.billable_post_reads).toBe(3);
  });

  it("reports ids X could not serve without failing the call", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () =>
        jsonResponse({
          data: [{ id: "1", text: "a" }],
          errors: [{ value: "2", title: "Not Found Error" }],
        }),
      ),
    );
    const res = await h.call("x_get_posts", { postIds: ["1", "2"] });
    expect(res.posts).toHaveLength(1);
    expect(res.not_found).toEqual(["2"]);
    // Billed for what came back, not for what was asked.
    expect(res.cost.billable_post_reads).toBe(1);
  });

  it("only fetches the ids not already cached", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "1", text: "a" }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "2", text: "b" }] }));
    const h = await connect(undefined, fetchMock);
    await h.call("x_get_post", { postId: "1" });
    const res = await h.call("x_get_posts", { postIds: ["1", "2"] });

    expect(h.urls()[1]).toContain("ids=2");
    expect(h.urls()[1]).not.toContain("ids=1");
    expect(res.cost).toMatchObject({ billable_post_reads: 1, free_from_cache: 1 });
  });
});

describe("x_search_recent", () => {
  it("requests the expansions the shaping layer depends on", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () => jsonResponse({ data: [], meta: { result_count: 0 } })),
    );
    await h.call("x_search_recent", { query: "rust -is:retweet" });
    const url = h.urls()[0] ?? "";
    expect(url).toContain("/2/tweets/search/recent");
    expect(url).toContain("query=rust+-is%3Aretweet");
    expect(decodeURIComponent(url)).toContain("expansions=author_id");
    expect(decodeURIComponent(url)).toContain("tweet.fields=created_at");
  });

  it("raises max_results to X's minimum of 10 while returning only what was asked", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () =>
        jsonResponse({
          data: Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), text: `p${i}` })),
          meta: { result_count: 10 },
        }),
      ),
    );
    const res = await h.call("x_search_recent", { query: "rust", maxResults: 3 });
    expect(h.urls()[0]).toContain("max_results=10");
    expect(res.posts).toHaveLength(3);
  });
});

describe("x_count_recent", () => {
  it("costs nothing and warns what reading the matches would cost", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () => jsonResponse({ data: [], meta: { total_tweet_count: 5000 } })),
    );
    const res = await h.call("x_count_recent", { query: "rust" });
    expect(res.total_posts).toBe(5000);
    expect(res.cost.estimated_usd).toBe(0);
    expect(res.reading_all_would_cost_usd).toBe(25);
    expect(res.advice).toMatch(/\$25\.00/);
  });

  it("omits the advice when the result set is small", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () => jsonResponse({ data: [], meta: { total_tweet_count: 12 } })),
    );
    const res = await h.call("x_count_recent", { query: "rust" });
    expect(res.advice).toBeUndefined();
  });
});

describe("x_build_search_query", () => {
  it("builds a query and explains it without touching the network", async () => {
    const h = await connect();
    const res = await h.call("x_build_search_query", {
      allWords: "rust async",
      from: ["mgcrea", "@acme"],
      lang: "en",
      isRetweet: false,
    });
    expect(res.query).toBe("rust async (from:mgcrea OR from:acme) lang:en -is:retweet");
    expect(res.valid).toBe(true);
    expect(res.explanation.join(" ")).toMatch(/removes the duplicate noise of reposts/);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("flags an empty query rather than returning a blank string as valid", async () => {
    const res = await (await connect()).call("x_build_search_query", {});
    expect(res.valid).toBe(false);
    expect(res.warning).toMatch(/No criteria/);
  });
});

describe("x_compose_post", () => {
  it("returns an intent URL and never calls the API", async () => {
    const h = await connect();
    const res = await h.call("x_compose_post", {
      text: "Shipping v2 today",
      url: "https://acme.dev/v2",
      open: false,
    });
    expect(res.intent_url).toMatch(/^https:\/\/x\.com\/intent\/tweet\?/);
    expect(new URL(res.intent_url).searchParams.get("text")).toBe("Shipping v2 today");
    expect(res.valid).toBe(true);
    expect(res.cost.estimated_usd).toBe(0);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("still returns the URL when the browser could not be opened", async () => {
    const h = await connect();
    const res = await h.call("x_compose_post", { text: "hi", open: false });
    expect(res.opened).toBe(false);
    expect(res.open_note).toBeDefined();
    expect(res.intent_url).toBeDefined();
    expect(res.next_step).toMatch(/Open the intent_url/);
  });

  it("refuses to hand back a URL for a draft X would reject", async () => {
    const res = await (
      await connect()
    ).call("x_compose_post", {
      text: "a".repeat(270),
      url: "https://acme.dev",
      open: false,
    });
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/over X's 280/);
  });

  it("maps inReplyTo into the intent URL", async () => {
    const res = await (
      await connect()
    ).call("x_compose_post", {
      text: "replying",
      inReplyTo: "1799000000000000001",
      open: false,
    });
    expect(new URL(res.intent_url).searchParams.get("in_reply_to")).toBe("1799000000000000001");
  });
});

describe("x_usage_report", () => {
  it("accumulates spend across calls and labels itself an estimate", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () =>
        jsonResponse({
          data: [
            { id: "1", text: "a" },
            { id: "2", text: "b" },
          ],
        }),
      ),
    );
    await h.call("x_get_posts", { postIds: ["1", "2"] });
    const report = await h.call("x_usage_report");

    expect(report.since_process_start.billable_post_reads).toBe(2);
    expect(report.since_process_start.estimated_usd).toBe(0.01);
    expect(report.disclaimer).toMatch(/authoritative/);
    expect(report.pricing.postRead).toBe(0.005);
  });

  it("reports budget headroom when one is configured", async () => {
    const h = await connect({ X_API_BEARER_TOKEN: "t", X_API_MONTHLY_BUDGET_USD: "1" });
    const report = await h.call("x_usage_report");
    expect(report.budget).toEqual({ limit_usd: 1, remaining_usd: 1 });
  });
});

describe("budget guard", () => {
  it("refuses a search that would cross the ceiling, before spending anything", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
    const h = await connect(
      { X_API_BEARER_TOKEN: "t", X_API_MONTHLY_BUDGET_USD: "0.01" },
      fetchMock,
    );
    const res = await h.call("x_search_recent", { query: "rust", maxResults: 100 });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/X_API_MONTHLY_BUDGET_USD/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("x_rate_limit_status", () => {
  it("is empty before any request has been made", async () => {
    const res = await (await connect()).call("x_rate_limit_status");
    expect(res.endpoints).toEqual([]);
    expect(res.note).toMatch(/No requests issued yet/);
  });
});

describe("x_auth_status", () => {
  it("reports a bearer-only install as able to read publicly but not bookmarks", async () => {
    const h = await connect({ X_API_BEARER_TOKEN: "t" }, undefined, { realAuth: true });
    const res = await h.call("x_auth_status");
    expect(res.app_only_bearer).toBe(true);
    expect(res.user.authenticated).toBe(false);
    expect(res.can_read_public).toBe(true);
    expect(res.can_read_bookmarks).toBe(false);
  });
});

describe("resolving your own user id", () => {
  /** Stage a logged-in OAuth session on disk, optionally without a recorded id. */
  const stageSession = (over: Record<string, unknown> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "x-api-tools-"));
    const tokenFile = join(dir, "tokens.json");
    writeFileSync(
      tokenFile,
      JSON.stringify({
        version: 1,
        clientId: "cid",
        scopes: ["tweet.read", "users.read", "bookmark.read", "offline.access"],
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: Date.now() + 3_600_000,
        obtainedAt: Date.now(),
        username: "mgcrea",
        ...over,
      }),
      { mode: 0o600 },
    );
    return { dir, tokenFile };
  };

  const env = (tokenFile: string) => ({
    X_API_BEARER_TOKEN: "t",
    X_API_CLIENT_ID: "cid",
    X_API_TOKEN_FILE: tokenFile,
  });

  // The dead end this replaced: login tolerates /2/users/me failing, so the id
  // can legitimately be absent — and telling the user to log in again would
  // just hit the same flaky endpoint.
  it("fetches the id from /2/users/me when the token file has none", async () => {
    const { dir, tokenFile } = stageSession();
    try {
      const fetchMock = vi.fn(async (url: string) =>
        String(url).includes("/2/users/me")
          ? jsonResponse({ data: { id: "44196397", username: "mgcrea" } })
          : jsonResponse({ data: [{ id: "1", text: "a bookmark" }] }),
      );
      const h = await connect(env(tokenFile), fetchMock, { realAuth: true });
      const res = await h.call("x_get_bookmarks", {});

      expect(res.isToolError).toBeFalsy();
      expect(h.urls()[0]).toContain("/2/users/me");
      expect(h.urls()[1]).toContain("/2/users/44196397/bookmarks");
      expect(res.posts).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the id back, so the next call does not pay for it again", async () => {
    const { dir, tokenFile } = stageSession();
    try {
      const fetchMock = vi.fn(async (url: string) =>
        String(url).includes("/2/users/me")
          ? jsonResponse({ data: { id: "44196397", username: "mgcrea" } })
          : jsonResponse({ data: [] }),
      );
      const h = await connect(env(tokenFile), fetchMock, { realAuth: true });
      await h.call("x_get_bookmarks", {});
      await h.call("x_get_bookmarks", {});

      expect(JSON.parse(readFileSync(tokenFile, "utf8")).userId).toBe("44196397");
      expect(h.urls().filter((u) => u.includes("/2/users/me"))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips the lookup entirely when the id is already recorded", async () => {
    const { dir, tokenFile } = stageSession({ userId: "44196397" });
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
      const h = await connect(env(tokenFile), fetchMock, { realAuth: true });
      await h.call("x_get_home_timeline", {});
      expect(h.urls().some((u) => u.includes("/2/users/me"))).toBe(false);
      expect(h.urls()[0]).toContain("/2/users/44196397/timelines/reverse_chronological");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("points at the enrollment trap when X will not identify the account", async () => {
    const { dir, tokenFile } = stageSession();
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ data: {} }));
      const h = await connect(env(tokenFile), fetchMock, { realAuth: true });
      const res = await h.call("x_get_bookmarks", {});
      expect(res.isToolError).toBe(true);
      expect(res.error).toMatch(/Pay-per-use.*Production|console\.x\.com/s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("user-context tools", () => {
  it("refuses bookmarks with the login hint rather than issuing a doomed request", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
    const h = await connect(
      {
        X_API_BEARER_TOKEN: "t",
        X_API_CLIENT_ID: "cid",
        // Point at a token file that does not exist: nobody has logged in.
        X_API_TOKEN_FILE: "/nonexistent/x-api-tokens.json",
      },
      fetchMock,
      { realAuth: true },
    );
    const res = await h.call("x_get_bookmarks", {});
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/x-api-mcp login/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("x_get_user", () => {
  it("looks a handle up by username and strips a leading @", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () => jsonResponse({ data: { id: "44196397", username: "mgcrea" } })),
    );
    const res = await h.call("x_get_user", { username: "@mgcrea" });
    expect(h.urls()[0]).toContain("/2/users/by/username/mgcrea");
    expect(res.user.url).toBe("https://x.com/mgcrea");
    // A user read is billed at twice a post read.
    expect(res.cost.estimated_usd).toBe(0.01);
  });

  it("refuses when both username and userId are given", async () => {
    const res = await (await connect()).call("x_get_user", { username: "a", userId: "1" });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/only one/);
  });

  it("refuses when neither is given", async () => {
    const res = await (await connect()).call("x_get_user", {});
    expect(res.isToolError).toBe(true);
  });
});

/**
 * Ads rides the OAuth 2.0 session, so it needs a client id — but it is off
 * unless asked for. The two exact-array assertions above are deliberately left
 * untouched: neither of their environments enables ads, so a correct
 * implementation cannot change them.
 */
const ADS_READ = { X_API_CLIENT_ID: "cid", X_ADS_ENABLED: "1" };
const ADS_WRITE = { ...ADS_READ, X_ADS_ALLOW_WRITES: "1" };
const ADS_SANDBOX = { ...ADS_WRITE, X_ADS_BASE_URL: "https://ads-api-sandbox.twitter.com" };

const adsNames = async (env: Record<string, string>): Promise<string[]> =>
  (await (await connect(env)).toolNames()).filter((n) => n.startsWith("x_ads_"));

describe("ads tool registration", () => {
  // Cheap, and it keeps holding as ads tools are added later.
  it("registers no ads tools at all unless X_ADS_ENABLED is set", async () => {
    expect(await adsNames({ X_API_BEARER_TOKEN: "t" })).toEqual([]);
    expect(await adsNames({ X_API_BEARER_TOKEN: "t", X_API_CLIENT_ID: "cid" })).toEqual([]);
  });

  it("registers the ads reads, and none of the writes, when only enabled", async () => {
    expect(await adsNames(ADS_READ)).toEqual([
      "x_ads_create_stats_job",
      "x_ads_download_stats_job",
      "x_ads_get_accounts",
      "x_ads_get_audiences",
      "x_ads_get_campaigns",
      "x_ads_get_funding_instruments",
      "x_ads_get_line_items",
      "x_ads_get_promoted_tweets",
      "x_ads_get_stats",
      "x_ads_get_stats_jobs",
      "x_ads_get_targeting_criteria",
      "x_ads_search_targeting_options",
    ]);
  });

  it("registers the campaign-mutating tools only when X_ADS_ALLOW_WRITES is on", async () => {
    const names = await adsNames(ADS_WRITE);
    for (const tool of [
      "x_ads_create_campaign",
      "x_ads_update_campaign",
      "x_ads_delete_campaign",
      "x_ads_create_line_item",
      "x_ads_delete_line_item",
      "x_ads_create_targeting_criterion",
      "x_ads_create_promoted_tweet",
      "x_ads_set_entity_status",
    ]) {
      expect(names).toContain(tool);
    }
  });

  // Queuing an analytics job spends nothing, so gating it behind the money
  // switch would make long-range analytics unreachable in the safe config.
  it("keeps the analytics job tools available without enabling writes", async () => {
    const names = await adsNames(ADS_READ);
    expect(names).toContain("x_ads_create_stats_job");
    expect(names).toContain("x_ads_download_stats_job");
  });

  it("registers the sandbox account tool only against the sandbox", async () => {
    expect(await adsNames(ADS_WRITE)).not.toContain("x_ads_create_sandbox_account");
    expect(await adsNames(ADS_SANDBOX)).toContain("x_ads_create_sandbox_account");
  });

  it("refuses to start when ads is enabled without a user context", () => {
    // A Bearer token cannot reach /12/accounts at all, so this is a
    // configuration error rather than something to discover per call.
    expect(() => loadConfig({ X_API_BEARER_TOKEN: "t", X_ADS_ENABLED: "1" }, ABSENT)).toThrow(
      /X_API_CLIENT_ID/,
    );
  });

  it("refuses ads writes that are switched on without ads itself", () => {
    expect(() => loadConfig({ X_API_CLIENT_ID: "c", X_ADS_ALLOW_WRITES: "1" }, ABSENT)).toThrow(
      /X_ADS_ENABLED/,
    );
  });

  it("asks for the ads scopes only when the matching tools exist", () => {
    expect(effectiveScopes(loadConfig({ X_API_CLIENT_ID: "c" }, ABSENT))).not.toContain("ads.read");
    const read = effectiveScopes(loadConfig(ADS_READ, ABSENT));
    expect(read).toContain("ads.read");
    expect(read).not.toContain("ads.write");
    expect(effectiveScopes(loadConfig(ADS_WRITE, ABSENT))).toContain("ads.write");
  });

  it("marks ads deletes destructive and ads reads read-only", async () => {
    const h = await connect(ADS_WRITE);
    const tools = (await h.client.listTools()).tools;
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    expect(byName.get("x_ads_get_campaigns")?.readOnlyHint).toBe(true);
    expect(byName.get("x_ads_delete_campaign")?.destructiveHint).toBe(true);
    expect(byName.get("x_ads_create_campaign")?.destructiveHint).toBe(false);
    expect(byName.get("x_ads_set_entity_status")?.idempotentHint).toBe(true);
  });
});

describe("ads money handling", () => {
  const adsResponse = (data: unknown) => jsonResponse({ data, request: { params: {} } });

  it("multiplies a major-unit budget into X's micros, and creates PAUSED", async () => {
    const fetchMock = vi.fn(async () => adsResponse({ id: "8v7jo", name: "Q3" }));
    const h = await connect(ADS_WRITE, fetchMock);
    const res = await h.call("x_ads_create_campaign", {
      accountId: "18ce54d4x5t",
      fundingInstrumentId: "lygyi",
      name: "Q3 launch",
      dailyBudget: 50,
      confirm: true,
    });

    const created = h.urls().find((u) => u.includes("/campaigns")) ?? "";
    expect(created).toContain("daily_budget_amount_local_micro=50000000");
    // The whole point of the default: a campaign that exists but spends nothing.
    expect(created).toContain("entity_status=PAUSED");
    expect(res.entity_status).toBe("PAUSED");
    expect(res.budget_sent).toMatchObject({
      daily_budget: 50,
      daily_budget_amount_local_micro: 50_000_000,
    });
    expect(res.cost.estimated_usd).toBe(0);
  });

  it("creates ACTIVE only when explicitly asked to", async () => {
    const fetchMock = vi.fn(async () => adsResponse({ id: "8v7jo" }));
    const h = await connect(ADS_WRITE, fetchMock);
    const res = await h.call("x_ads_create_campaign", {
      accountId: "18ce54d4x5t",
      fundingInstrumentId: "lygyi",
      name: "Q3 launch",
      dailyBudget: 50,
      activateImmediately: true,
      confirm: true,
    });
    expect(h.urls().find((u) => u.includes("/campaigns"))).toContain("entity_status=ACTIVE");
    expect(res.entity_status).toBe("ACTIVE");
  });

  it("cannot be called without confirm, so a stray call cannot spend", async () => {
    const h = await connect(ADS_WRITE);
    const res = await h.call("x_ads_create_campaign", {
      fundingInstrumentId: "lygyi",
      name: "Q3",
      dailyBudget: 50,
    });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/confirm/);
  });

  // A model reading a bare 50000000 concludes the budget is fifty million.
  it("pairs every micro field it reads back with a human-readable value", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [{ id: "8v7jo", daily_budget_amount_local_micro: 50_000_000 }],
        next_cursor: null,
      }),
    );
    const h = await connect(ADS_READ, fetchMock);
    const res = await h.call("x_ads_get_campaigns", { accountId: "18ce54d4x5t" });
    expect(res.campaigns[0]).toMatchObject({
      daily_budget: 50,
      daily_budget_amount_local_micro: 50_000_000,
    });
  });

  it("rejects a budget that was pre-multiplied into micros", async () => {
    const h = await connect(ADS_WRITE);
    const res = await h.call("x_ads_create_campaign", {
      accountId: "18ce54d4x5t",
      fundingInstrumentId: "lygyi",
      name: "Q3",
      dailyBudget: 50_000_000,
      confirm: true,
    });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/dailyBudget/);
  });
});

describe("ads account resolution", () => {
  it("resolves the only reachable account and asks X just once", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("/campaigns")
        ? jsonResponse({ data: [], next_cursor: null })
        : jsonResponse({ data: [{ id: "18ce54d4x5t", name: "Acme" }], next_cursor: null }),
    );
    const h = await connect(ADS_READ, fetchMock);
    await h.call("x_ads_get_campaigns", {});
    await h.call("x_ads_get_campaigns", {});
    const lookups = h.urls().filter((u) => u.endsWith("count=50"));
    expect(lookups).toHaveLength(1);
    expect(h.urls().some((u) => u.includes("/12/accounts/18ce54d4x5t/campaigns"))).toBe(true);
  });

  // Silently picking the first would create campaigns in the wrong client's
  // account, which spends real money and is invisible in the response.
  it("refuses to guess between several accounts, and lists them", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: "aaa", name: "Acme" },
          { id: "bbb", name: "Globex" },
        ],
        next_cursor: null,
      }),
    );
    const res = await (await connect(ADS_READ, fetchMock)).call("x_ads_get_campaigns", {});
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/2 ads accounts/);
    expect(res.details.accounts).toHaveLength(2);
  });

  it("explains an empty account list as an access problem, not an empty result", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [], next_cursor: null }));
    const res = await (await connect(ADS_READ, fetchMock)).call("x_ads_get_campaigns", {});
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/no ads accounts/);
  });
});

describe("ads analytics guards", () => {
  it("refuses a synchronous window wider than X's 7 days, naming the async tool", async () => {
    const h = await connect(ADS_READ);
    const res = await h.call("x_ads_get_stats", {
      accountId: "18ce54d4x5t",
      entity: "CAMPAIGN",
      entityIds: ["8v7jo"],
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-20T00:00:00Z",
    });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/x_ads_create_stats_job/);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects times that are not on a whole hour", async () => {
    const res = await (
      await connect(ADS_READ)
    ).call("x_ads_get_stats", {
      accountId: "18ce54d4x5t",
      entity: "CAMPAIGN",
      entityIds: ["8v7jo"],
      startTime: "2026-08-01T00:30:00Z",
      endTime: "2026-08-02T00:00:00Z",
    });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/startTime/);
  });

  it("rejects more than the 20 entities X allows per synchronous call", async () => {
    const res = await (
      await connect(ADS_READ)
    ).call("x_ads_get_stats", {
      accountId: "18ce54d4x5t",
      entity: "CAMPAIGN",
      entityIds: Array.from({ length: 21 }, (_, i) => `id${i}`),
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-02T00:00:00Z",
    });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/entityIds/);
  });

  it("requires a country when segmenting an async job by metro", async () => {
    const h = await connect(ADS_READ);
    const res = await h.call("x_ads_create_stats_job", {
      accountId: "18ce54d4x5t",
      entity: "CAMPAIGN",
      entityIds: ["8v7jo"],
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-02T00:00:00Z",
      segmentation: "METROS",
    });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/country/);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  // PUBLISHER_NETWORK is a valid line-item placement but not a valid analytics
  // one, which is the kind of thing worth catching in the schema.
  it("rejects a placement the analytics endpoint does not accept", async () => {
    const res = await (
      await connect(ADS_READ)
    ).call("x_ads_get_stats", {
      accountId: "18ce54d4x5t",
      entity: "CAMPAIGN",
      entityIds: ["8v7jo"],
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-02T00:00:00Z",
      placement: "PUBLISHER_NETWORK",
    });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/placement/);
  });
});
