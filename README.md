# @mgcrea/mcp-x-api

[![npm version](https://img.shields.io/npm/v/@mgcrea/mcp-x-api.svg)](https://www.npmjs.com/package/@mgcrea/mcp-x-api)
[![ci](https://github.com/mgcrea/mcp-x-api/actions/workflows/ci.yml/badge.svg)](https://github.com/mgcrea/mcp-x-api/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@mgcrea/mcp-x-api.svg)](./LICENSE)

Model Context Protocol server for the **X (Twitter) API v2** — built for reading and searching posts.

> **Unofficial.** Not affiliated with, endorsed by, or supported by X Corp.

## Features

- **A serious reader.** Post lookup, recent and full-archive search, profiles, user timelines, thread reconstruction, bookmarks and your home timeline — with X's query syntax exposed properly.
- **Readable output.** X returns posts whose author, quoted post and real URLs live in a separate `includes` sidecar. Every tool here resolves that first, so posts arrive with the handle inline, t.co links expanded, and retweets showing the original text.
- **Free posting.** `x_compose_post` returns an [`x.com/intent/tweet`](https://docs.x.com/x-for-websites/post-button/guides/web-intent) URL you click. No credentials, no API quota, no cost — and nothing publishes without a human click.
- **Cost-aware by design.** X is pay-per-use. Every read reports what it cost, repeat reads inside a UTC day are free, and a budget ceiling stops a runaway loop before the request goes out.
- **Official API only.** No cookie scraping, no password automation, nothing that risks your account.

## Cost — read this first

**X removed its tiered pricing on 2026-02-06. There is no free tier for new developers**, and much of the ecosystem's documentation still says otherwise. Current list prices:

| Action                                            | Price     |
| ------------------------------------------------- | --------- |
| Read a post                                       | ~$0.005   |
| Read a user profile                               | ~$0.010   |
| Read **your own** data (bookmarks, home timeline) | ~$0.001   |
| Create a post                                     | ~$0.015   |
| Create a post **containing a URL**                | ~$0.200   |
| Monthly read cap                                  | 2,000,000 |

Credits are prepurchased in the developer console; at zero credits, requests are blocked. Three things follow, and they shape the whole server:

1. **`maxResults` defaults to 10, not 50.** A 100-result search is about $0.50.
2. **Repeat reads are free.** X deduplicates per resource id within a UTC calendar day, so the built-in cache mirrors that exactly — a cache hit is genuinely free, not merely fast.
3. **Posting should not cost anything.** `x_compose_post` is the default write path and uses a web intent. The paid `x_create_post` stays unregistered unless you opt in twice (`X_API_ALLOW_WRITES=1` **and** `X_API_WRITE_BACKEND=api`).

Run `x_count_recent` before a broad search — it returns totals without reading any posts, so it costs nothing and tells you what the search would cost. `x_build_search_query` is likewise free and local.

> Prices are X's published list rates, transcribed 2026-07-19. Override them via the config file's `pricing` key if they change. `x_usage_report` estimates locally and is not authoritative — the developer portal is.

## Security

- **Supply chain.** Two runtime dependencies: the MCP SDK and zod. The HTTP client is ~250 lines of `fetch`.
- **Verified builds.** npm releases carry [provenance](https://docs.npmjs.com/generating-provenance-statements) via OIDC trusted publishing; container images are multi-arch, ship an SBOM, and are signed with [cosign](https://docs.sigstore.dev/cosign/signing/overview/).
- **Your credentials.** Read from the environment or a config file you control, sent only to `api.x.com`, never logged. The **one** file this server writes is `tokens.json` (mode 600), and only if you use OAuth — it has to persist a rotating refresh token. Everything else is read-only.
- **Blast radius.** Paid writes are off by default and _unregistered_ rather than refused, so an agent cannot call what does not exist. The free compose path never publishes without a human clicking Post.
- **No scraping.** This server never touches session cookies or your password. Tools that do are a ban risk regardless of how they are marketed.

## Configure

Only one variable is required:

```bash
export X_API_BEARER_TOKEN="..."   # X developer portal → your app → Keys and tokens
```

That covers every public read: lookup, search, profiles, timelines. See [.env.example](./.env.example) for the rest.

**OAuth 2.0** is needed only for bookmarks, your home timeline, and API writes:

```bash
export X_API_CLIENT_ID="..."      # an OAuth 2.0 app with PKCE enabled
npx @mgcrea/mcp-x-api login       # opens a browser, stores a refresh token (mode 600)
```

> The callback URL must match the X portal **byte for byte**. The default is `http://127.0.0.1:8723/callback` — register exactly that. The port is fixed rather than ephemeral for this reason.

### Config file

Instead of environment variables, use `~/.config/x-api/config.json` (camelCase keys, the env names minus the `X_API_` prefix). Environment wins **per field**, so a one-off `X_API_ALLOW_WRITES=0` still overrides a file that says `true`. Unknown keys are an error rather than silently ignored.

```json
{
  "bearerToken": "...",
  "defaultMaxResults": 10,
  "monthlyBudgetUsd": 25
}
```

## Quick start

**A. npx**

```json
{
  "mcpServers": {
    "x-api": {
      "command": "npx",
      "args": ["-y", "@mgcrea/mcp-x-api"],
      "env": { "X_API_BEARER_TOKEN": "..." }
    }
  }
}
```

**B. Docker (stdio)**

```json
{
  "mcpServers": {
    "x-api": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-e", "X_API_BEARER_TOKEN", "ghcr.io/mgcrea/mcp-x-api"],
      "env": { "X_API_BEARER_TOKEN": "..." }
    }
  }
}
```

**C. From source**

```bash
pnpm install && pnpm build
X_API_BEARER_TOKEN=... node dist/cli.js
```

**Inspect the tools**

```bash
X_API_BEARER_TOKEN=... npx @modelcontextprotocol/inspector node dist/cli.js
```

## Tools

Writes are marked `*`, and `†` means a `confirm: true` argument is required. Tools that do not apply to your configuration are not registered at all.

**Posts** — `x_get_post` · `x_get_posts` (batch up to 100 in one request) · `x_get_thread` · `x_get_quotes`

**Users** — `x_get_user` · `x_get_users` · `x_get_user_posts` · `x_get_user_mentions`

**Search** — `x_search_recent` · `x_count_recent` (free — totals only) · `x_build_search_query` (free — local) · `x_search_all` _(needs `X_API_ENABLE_FULL_ARCHIVE`)_

**Compose** — `x_validate_post` (free, local) · `x_compose_post` (free, web intent) · `x_create_post` \*† · `x_delete_post` \*† _(the last two need `X_API_ALLOW_WRITES=1` **and** `X_API_WRITE_BACKEND=api`)_

**Timelines** — `x_get_home_timeline` · `x_get_bookmarks` _(need OAuth login; X serves these for your own account only)_

**Auth** — `x_auth_status` · `x_auth_login` \* · `x_auth_logout` \*† _(the last two need `X_API_CLIENT_ID`)_

**Usage** — `x_usage_report` · `x_rate_limit_status`

### Reading posts

Ask for a post and you get it resolved, not raw:

```json
{
  "post": {
    "id": "1799000000000000001",
    "url": "https://x.com/mgcrea/status/1799000000000000001",
    "author": "@mgcrea (Olivier)",
    "text": "Shipping v2 today https://acme.dev/v2",
    "metrics": { "likes": 88, "reposts": 12, "replies": 3, "quotes": 1, "views": 10400 },
    "quotes": { "id": "1798…", "author": "@acme (Acme Inc)", "text": "v1 was great." },
    "media": ["photo: https://pbs.twimg.com/media/x.jpg (alt: release notes screenshot)"]
  },
  "cost": { "billable_post_reads": 1, "free_from_cache": 0, "estimated_usd": 0.005 }
}
```

The `includes` sidecar, `entities`, `edit_history_tweet_ids` and `author_id` never appear — the join is already done, so the model cannot get it wrong.

### Searching without overspending

The cheapest workflow is free until the last step:

1. `x_build_search_query` — turn a description into `rust (from:a OR from:b) lang:en -is:retweet`, with each operator explained. Local, $0.
2. `x_count_recent` — how many posts match, and what reading them all would cost. Totals only, $0.
3. `x_search_recent` — actually read them, at ~$0.005 each.

### Posting for free

`x_compose_post` validates the draft against X's **weighted** 280-character limit (every URL counts 23 whatever its length; CJK characters and emoji count 2, so 140 Japanese characters is already full) and hands back a URL:

```json
{
  "intent_url": "https://x.com/intent/tweet?text=Shipping+v2+today&url=https%3A%2F%2Facme.dev%2Fv2",
  "opened": true,
  "weighted_length": 41,
  "remaining": 239,
  "cost": { "estimated_usd": 0, "note": "Web intent — no API call, no quota consumed." }
}
```

The URL comes back whether or not a browser could be opened, so Docker and SSH behave identically.

**Web intents cannot** attach media, create polls, make native quote posts, or build threads — those need the paid API. Replying to a post _does_ work (`inReplyTo`).

## Notes

- **Recent search reaches back 7 days.** `x_get_thread` inherits that limit: an older conversation returns only its root post. Full-archive search (back to March 2006) needs a paid tier and `X_API_ENABLE_FULL_ARCHIVE=1`, and is capped at one request per second.
- **Bookmarks and the home timeline are self-only.** X does not serve anyone else's, so those tools take no user argument — the id comes from your token.
- **Rate limits are per endpoint and per credential**, not per plan: recent search allows 450 requests / 15 min app-only vs 300 with a user token. `x_rate_limit_status` shows the headroom X last reported.
- **Search asks for at least 10 results.** X's minimum for `max_results` is 10, so a request for 3 fetches 10 and returns 3. Billing follows what X actually returned.
- **`x_usage_report` counts this process only.** It is not persisted across restarts and does not know about spend from other clients.

## Develop

```bash
pnpm install
pnpm test          # vitest, fully offline — every test injects fetch
pnpm typecheck
pnpm lint && pnpm format:check
pnpm build
```

Tests never touch the network: `createServer` accepts an injectable `fetch`, `logger` and `tokenProvider`, and `test/tools.test.ts` drives the real server through the MCP SDK's in-memory transport.

### Publish

```bash
pnpm dlx release-it          # tags vX.Y.Z; CI publishes to npm and GHCR
```

### Verify a release

```bash
npm view @mgcrea/mcp-x-api --json | jq .dist.attestations
cosign verify ghcr.io/mgcrea/mcp-x-api:latest \
  --certificate-identity-regexp 'https://github.com/mgcrea/mcp-x-api/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## License

MIT © [Olivier Louvignes](https://github.com/mgcrea)
