/**
 * X answers errors in two shapes depending on the endpoint: a problem-details
 * object (`{ title, detail, status, type }`) on v2, and a legacy
 * `{ errors: [{ message, code }] }` on a few others. Both are modelled here so
 * the client can quote whichever it got.
 */
export type XApiError = {
  title?: string;
  detail?: string;
  type?: string;
  status?: number;
  message?: string;
  code?: number;
  /** Present on partial responses, e.g. one deleted post in a batch lookup. */
  resource_type?: string;
  parameter?: string;
  value?: string;
};

export class XApiRequestError extends Error {
  override readonly name = "XApiRequestError";
  readonly status: number;
  readonly errors: XApiError[] | unknown;

  constructor(message: string, opts: { status: number; errors?: XApiError[] | unknown }) {
    super(message);
    this.status = opts.status;
    this.errors = opts.errors;
  }
}

/**
 * Thrown when a tool needs a logged-in user and only an app-only Bearer token
 * is available. The message carries the fix, because "401 Unauthorized" tells
 * you nothing about which of two credentials was missing.
 */
export class UserContextRequiredError extends Error {
  override readonly name = "UserContextRequiredError";

  constructor(what: string, reason?: string) {
    super(
      `${what} needs an OAuth2 user context — an app-only Bearer token cannot reach it. ` +
        `Set X_API_CLIENT_ID and run \`x-api-mcp login\` once (it opens a browser and stores a ` +
        `refresh token in your config directory with mode 600), then retry.` +
        (reason ? ` (${reason})` : ""),
    );
  }
}

/** Thrown when a write tool is reached while X_API_ALLOW_WRITES is off. */
export class WritesDisabledError extends Error {
  override readonly name = "WritesDisabledError";

  constructor(what: string) {
    super(
      `${what} is a write operation, but writes are disabled. Set X_API_ALLOW_WRITES=1 to enable ` +
        `mutating tools. Note that x_compose_post posts for free via a web intent and needs no ` +
        `flag at all.`,
    );
  }
}

/**
 * A local guard that fires *before* the request goes out, so an agent in a loop
 * cannot spend past the ceiling. Carries the arithmetic so the number is
 * auditable rather than mysterious.
 */
export class BudgetExceededError extends Error {
  override readonly name = "BudgetExceededError";
  readonly details: Record<string, unknown>;

  constructor(opts: { estimateUsd: number; spentUsd: number; limitUsd: number; what: string }) {
    super(
      `${opts.what} would cost about $${opts.estimateUsd.toFixed(3)}, which takes this session ` +
        `past the $${opts.limitUsd.toFixed(2)} budget (about $${opts.spentUsd.toFixed(3)} spent ` +
        `so far). Raise or unset X_API_MONTHLY_BUDGET_USD, or ask for fewer results.`,
    );
    this.details = { ...opts };
  }
}

/**
 * A local check that failed before we sent anything to X. Carries the state it
 * read, so the caller sees why rather than just that something was wrong.
 */
export class PreconditionError extends Error {
  override readonly name = "PreconditionError";
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.details = details;
  }
}
