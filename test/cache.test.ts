import { describe, expect, it } from "vitest";

import { createDayCache, utcDay } from "../src/client/cache.js";
import { createLedger } from "../src/client/cost.js";
import { DEFAULT_PRICING } from "../src/config.js";

/** A clock we can walk forward, so UTC-midnight behaviour is testable. */
const clock = (start: string) => {
  let t = Date.parse(start);
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

const DAY_MS = 24 * 60 * 60 * 1000;

describe("utcDay", () => {
  it("is the UTC calendar day, not a local one", () => {
    // 23:30 in UTC-negative local time is still the next day in UTC.
    expect(utcDay(Date.parse("2026-07-19T23:30:00.000Z"))).toBe("2026-07-19");
    expect(utcDay(Date.parse("2026-07-20T00:00:01.000Z"))).toBe("2026-07-20");
  });
});

describe("createDayCache", () => {
  it("returns a stored value on the same day", () => {
    const cache = createDayCache({ maxEntries: 10 });
    cache.set("post", "1", { text: "hi" });
    expect(cache.get("post", "1")).toEqual({ text: "hi" });
    expect(cache.stats().hits).toBe(1);
  });

  it("keys by kind as well as id, so a post and a user cannot collide", () => {
    const cache = createDayCache({ maxEntries: 10 });
    cache.set("post", "1", "a post");
    expect(cache.get("user", "1")).toBeUndefined();
  });

  it("clears wholesale at UTC midnight, matching X's dedup window", () => {
    const c = clock("2026-07-19T23:59:00.000Z");
    const cache = createDayCache({ maxEntries: 10, now: c.now });
    cache.set("post", "1", "cached");
    expect(cache.get("post", "1")).toBe("cached");
    c.advance(2 * 60 * 1000); // 00:01 the next day
    expect(cache.get("post", "1")).toBeUndefined();
    expect(cache.stats().day).toBe("2026-07-20");
  });

  it("does not expire an entry that is 23 hours old but same-day", () => {
    const c = clock("2026-07-19T00:30:00.000Z");
    const cache = createDayCache({ maxEntries: 10, now: c.now });
    cache.set("post", "1", "cached");
    c.advance(22 * 60 * 60 * 1000);
    expect(cache.get("post", "1")).toBe("cached");
  });

  it("evicts the least recently used entry at capacity", () => {
    const cache = createDayCache({ maxEntries: 2 });
    cache.set("post", "a", 1);
    cache.set("post", "b", 2);
    cache.get("post", "a"); // 'a' becomes most recent, so 'b' is next out
    cache.set("post", "c", 3);
    expect(cache.get("post", "b")).toBeUndefined();
    expect(cache.get("post", "a")).toBe(1);
    expect(cache.get("post", "c")).toBe(3);
  });

  it("stores nothing when disabled", () => {
    const cache = createDayCache({ maxEntries: 10, enabled: false });
    cache.set("post", "1", "x");
    expect(cache.get("post", "1")).toBeUndefined();
  });

  it("stores nothing when maxEntries is zero", () => {
    const cache = createDayCache({ maxEntries: 0 });
    cache.set("post", "1", "x");
    expect(cache.get("post", "1")).toBeUndefined();
  });

  it("reports a hit rate", () => {
    const cache = createDayCache({ maxEntries: 10 });
    cache.set("post", "1", "x");
    cache.get("post", "1");
    cache.get("post", "2");
    cache.get("post", "3");
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 2, hit_rate: 0.33, entries: 1 });
  });
});

describe("createLedger", () => {
  const pricing = { ...DEFAULT_PRICING };

  it("bills the same id once per UTC day", () => {
    const ledger = createLedger({ pricing });
    expect(ledger.record("post", ["1", "2"])).toEqual({ billable: ["1", "2"], free: [] });
    expect(ledger.record("post", ["1", "3"])).toEqual({ billable: ["3"], free: ["1"] });
    expect(ledger.spentUsd()).toBe(0.015); // three distinct posts at $0.005
  });

  it("bills the same id again on the next UTC day", () => {
    const c = clock("2026-07-19T12:00:00.000Z");
    const ledger = createLedger({ pricing, now: c.now });
    ledger.record("post", ["1"]);
    c.advance(DAY_MS);
    expect(ledger.record("post", ["1"])).toEqual({ billable: ["1"], free: [] });
    expect(ledger.spentUsd()).toBe(0.01);
  });

  // The case that justifies keeping the ledger separate from the LRU cache.
  it("keeps an id billed even after the payload cache has evicted it", () => {
    const cache = createDayCache({ maxEntries: 1 });
    const ledger = createLedger({ pricing });

    ledger.record("post", ["1"]);
    cache.set("post", "1", "payload");
    // Memory pressure evicts the payload...
    cache.set("post", "2", "payload");
    expect(cache.get("post", "1")).toBeUndefined();
    // ...but X still will not bill us for it again today.
    expect(ledger.record("post", ["1"])).toEqual({ billable: [], free: ["1"] });
    expect(ledger.spentUsd()).toBe(0.005);
  });

  it("charges owned reads five times less than reading someone else's posts", () => {
    const ledger = createLedger({ pricing });
    ledger.record("post", ["1"]);
    ledger.record("owned", ["2"]);
    expect(ledger.spentUsd()).toBe(0.006);
  });

  it("charges a user read at twice a post read", () => {
    const ledger = createLedger({ pricing });
    ledger.record("user", ["1"]);
    expect(ledger.spentUsd()).toBe(0.01);
  });

  it("charges 40x for a post containing a URL", () => {
    const ledger = createLedger({ pricing });
    ledger.recordCreate(false);
    expect(ledger.spentUsd()).toBe(0.015);
    ledger.recordCreate(true);
    expect(ledger.spentUsd()).toBe(0.215);
  });

  it("estimates only the ids not already paid for", () => {
    const ledger = createLedger({ pricing });
    ledger.record("post", ["1"]);
    expect(ledger.estimate("post", ["1", "2", "3"])).toBe(0.01);
  });

  it("estimates by count for searches, whose result ids are unknowable up front", () => {
    const ledger = createLedger({ pricing });
    expect(ledger.estimateCount("post", 100)).toBe(0.5);
  });

  it("honours a price override from the config file", () => {
    const ledger = createLedger({ pricing: { ...pricing, postRead: 0.05 } });
    ledger.record("post", ["1"]);
    expect(ledger.spentUsd()).toBe(0.05);
  });

  it("reports budget headroom when a limit is set", () => {
    const ledger = createLedger({ pricing, budgetUsd: 1 });
    ledger.record("post", ["1", "2"]);
    const report = ledger.report(createDayCache({ maxEntries: 1 }).stats());
    expect(report.budget).toEqual({ limit_usd: 1, remaining_usd: 0.99 });
  });

  it("omits the budget block entirely when no limit is set", () => {
    const report = createLedger({ pricing }).report(createDayCache({ maxEntries: 1 }).stats());
    expect(report.budget).toBeUndefined();
  });

  it("says out loud that the numbers are estimates from this process only", () => {
    const report = createLedger({ pricing }).report(createDayCache({ maxEntries: 1 }).stats());
    expect(report.disclaimer).toMatch(/not persisted|authoritative/);
    expect(report.pricing).toEqual(pricing);
  });
});
