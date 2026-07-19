import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";

import type { Config } from "../config.js";
import { effectiveScopes } from "../config.js";
import type { Logger } from "./auth.js";
import { PreconditionError } from "./errors.js";
import type { StoredTokens, TokenStore } from "./tokens.js";
import { TOKEN_FILE_VERSION } from "./tokens.js";

export const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_PATH = "/2/oauth2/token";
const CALLBACK_TIMEOUT_MS = 120_000;

const base64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export type PkcePair = { verifier: string; challenge: string };

/**
 * PKCE S256. 32 random bytes base64url-encode to exactly 43 characters, the
 * minimum the spec allows for a verifier.
 */
export const createPkcePair = (random: (n: number) => Buffer = randomBytes): PkcePair => {
  const verifier = base64url(random(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
};

export const buildAuthorizeUrl = (opts: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  challenge: string;
}): string => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    // Scopes are space-separated in OAuth 2.0, unlike almost everything else
    // in the X API, which uses commas.
    scope: opts.scopes.join(" "),
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
};

/** Constant-time compare, so a mismatched state cannot be probed byte by byte. */
const statesMatch = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

export type OAuthClient = {
  exchangeCode(code: string, verifier: string): Promise<TokenResponse>;
  refresh(refreshToken: string): Promise<TokenResponse>;
};

const formPost = async (
  fetchImpl: typeof fetch,
  config: Config,
  body: URLSearchParams,
): Promise<TokenResponse> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  // Confidential clients authenticate with Basic; public PKCE clients send only
  // client_id in the body. X accepts either depending on how the app is set up.
  if (config.clientSecret) {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    headers.Authorization = `Basic ${basic}`;
  }

  const res = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}${TOKEN_PATH}`, {
    method: "POST",
    headers,
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `X rejected the OAuth token request: HTTP ${res.status} — ${text.slice(0, 400)}`,
    );
  }
  return JSON.parse(text) as TokenResponse;
};

export const createOAuthClient = (config: Config, fetchImpl: typeof fetch = fetch): OAuthClient => {
  if (!config.clientId) {
    throw new PreconditionError("X_API_CLIENT_ID is required for the OAuth2 flow.");
  }
  const clientId = config.clientId;

  return {
    exchangeCode: (code, verifier) =>
      formPost(
        fetchImpl,
        config,
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: config.redirectUri,
          code_verifier: verifier,
          client_id: clientId,
        }),
      ),
    refresh: (refreshToken) =>
      formPost(
        fetchImpl,
        config,
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
        }),
      ),
  };
};

export const toStoredTokens = (
  res: TokenResponse,
  opts: {
    clientId: string;
    requestedScopes: string[];
    now: number;
    previousRefreshToken?: string | undefined;
    userId?: string | undefined;
    username?: string | undefined;
  },
): StoredTokens => ({
  version: TOKEN_FILE_VERSION,
  clientId: opts.clientId,
  scopes: res.scope ? res.scope.split(/\s+/).filter(Boolean) : opts.requestedScopes,
  accessToken: res.access_token,
  ...(res.refresh_token ? { refreshToken: res.refresh_token } : {}),
  ...(opts.previousRefreshToken ? { previousRefreshToken: opts.previousRefreshToken } : {}),
  // X access tokens last about two hours; default conservatively if unstated.
  expiresAt: opts.now + (res.expires_in ?? 7200) * 1000,
  obtainedAt: opts.now,
  ...(opts.userId ? { userId: opts.userId } : {}),
  ...(opts.username ? { username: opts.username } : {}),
});

const SUCCESS_PAGE = `<!doctype html><meta charset="utf-8"><title>x-api-mcp</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5">
<h1>Signed in</h1><p>x-api-mcp stored your token. You can close this tab and return to your terminal.</p>
</body>`;

const FAILURE_PAGE = `<!doctype html><meta charset="utf-8"><title>x-api-mcp</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5">
<h1>Sign-in failed</h1><p>Check the terminal running x-api-mcp for the reason.</p>
</body>`;

/**
 * Run the browser half of the flow: open the authorize URL, listen on the
 * loopback port for exactly one callback, and hand back the code.
 *
 * The port is fixed rather than ephemeral because X matches the redirect URI
 * against the value registered in the developer portal byte for byte — an
 * ephemeral port could never be authorized.
 */
export const awaitCallback = (opts: {
  redirectUri: string;
  state: string;
  timeoutMs?: number;
  logger?: Logger | undefined;
}): { url: Promise<never> | undefined; code: Promise<string>; close: () => void } => {
  const url = new URL(opts.redirectUri);
  const port = Number(url.port);
  const expectedPath = url.pathname;

  let settle: { resolve: (code: string) => void; reject: (err: Error) => void };
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });

  const server = createHttpServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (requestUrl.pathname !== expectedPath) {
      res.writeHead(404).end("Not found");
      return;
    }

    const returnedState = requestUrl.searchParams.get("state") ?? "";
    const returnedCode = requestUrl.searchParams.get("code");
    const error = requestUrl.searchParams.get("error");

    if (error) {
      res.writeHead(400, { "content-type": "text/html" }).end(FAILURE_PAGE);
      settle.reject(new Error(`X denied the authorization: ${error}`));
      return;
    }
    if (!statesMatch(returnedState, opts.state)) {
      res.writeHead(400, { "content-type": "text/html" }).end(FAILURE_PAGE);
      settle.reject(
        new Error("The callback did not come from the login that was started (state mismatch)."),
      );
      return;
    }
    if (!returnedCode) {
      res.writeHead(400, { "content-type": "text/html" }).end(FAILURE_PAGE);
      settle.reject(new Error("The callback carried no authorization code."));
      return;
    }

    res.writeHead(200, { "content-type": "text/html" }).end(SUCCESS_PAGE);
    settle.resolve(returnedCode);
  });

  const timer = setTimeout(() => {
    settle.reject(
      new Error(
        `No callback arrived within ${(opts.timeoutMs ?? CALLBACK_TIMEOUT_MS) / 1000}s. ` +
          `Re-run the login and complete it in the browser.`,
      ),
    );
  }, opts.timeoutMs ?? CALLBACK_TIMEOUT_MS);
  timer.unref?.();

  server.on("error", (err: NodeJS.ErrnoException) => {
    settle.reject(
      err.code === "EADDRINUSE"
        ? new Error(
            `Port ${port} is already in use, so the OAuth callback cannot be received. Free it, ` +
              `or set X_API_REDIRECT_URI to another loopback URL — and register that exact URL ` +
              `in the X developer console at console.x.com, which must match byte for byte.`,
          )
        : err,
    );
  });
  server.listen(port, "127.0.0.1");

  const close = (): void => {
    clearTimeout(timer);
    server.close();
  };
  void code.finally(close).catch(() => {});

  return { url: undefined, code, close };
};

export type LoginResult = { tokens: StoredTokens; authorizeUrl: string };

/** The whole login: PKCE, browser, callback, exchange, identify, persist. */
export const startLoginFlow = async (opts: {
  config: Config;
  store: TokenStore;
  fetch?: typeof fetch;
  openBrowser?: (url: string) => Promise<{ opened: boolean; reason?: string }>;
  logger?: Logger;
  now?: () => number;
  timeoutMs?: number;
}): Promise<LoginResult> => {
  const { config, store } = opts;
  if (!config.clientId) {
    throw new PreconditionError(
      "X_API_CLIENT_ID is required to log in. Create an OAuth 2.0 app in the X developer " +
        "portal, enable PKCE, and add this exact callback URL: " +
        config.redirectUri,
    );
  }

  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const scopes = effectiveScopes(config);
  const { verifier, challenge } = createPkcePair();
  const state = base64url(randomBytes(16));
  const authorizeUrl = buildAuthorizeUrl({
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scopes,
    state,
    challenge,
  });

  const listener = awaitCallback({
    redirectUri: config.redirectUri,
    state,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  // Print before opening: on a headless box the printed URL is the whole flow.
  opts.logger?.warn?.(`Open this URL to authorize x-api-mcp:\n${authorizeUrl}`);
  if (opts.openBrowser) await opts.openBrowser(authorizeUrl);

  const code = await listener.code;
  const oauth = createOAuthClient(config, fetchImpl);
  const res = await oauth.exchangeCode(code, verifier);

  // One owned read ($0.001) to learn who just logged in, so x_auth_status and
  // the timeline tools do not have to ask again.
  let userId: string | undefined;
  let username: string | undefined;
  try {
    const me = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/2/users/me`, {
      headers: { Authorization: `Bearer ${res.access_token}`, Accept: "application/json" },
    });
    const body = (await me.json()) as { data?: { id?: string; username?: string } };
    userId = body.data?.id;
    username = body.data?.username;
  } catch {
    // Identity is a convenience, not a requirement — the token works regardless.
  }

  const tokens = toStoredTokens(res, {
    clientId: config.clientId,
    requestedScopes: scopes,
    now: now(),
    ...(userId ? { userId } : {}),
    ...(username ? { username } : {}),
  });
  store.write(tokens);
  return { tokens, authorizeUrl };
};
