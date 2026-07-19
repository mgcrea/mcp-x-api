import { describe, expect, it } from "vitest";

import { assembleComposerText, buildIntentUrl, validateIntent } from "../src/compose/intent.js";
import { TCO_URL_LENGTH, weightedLength } from "../src/compose/weighted.js";

const w = (text: string) => weightedLength(text).weighted;

describe("weightedLength — the anchors that pin twitter-text v3", () => {
  it("counts 280 Latin characters as exactly full", () => {
    const res = weightedLength("a".repeat(280));
    expect(res.weighted).toBe(280);
    expect(res.valid).toBe(true);
    expect(res.remaining).toBe(0);
  });

  it("counts 281 Latin characters as over", () => {
    expect(weightedLength("a".repeat(281)).valid).toBe(false);
  });

  it("counts 140 Japanese characters as exactly full — CJK weighs double", () => {
    const res = weightedLength("あ".repeat(140));
    expect(res.weighted).toBe(280);
    expect(res.valid).toBe(true);
  });

  it("counts 141 Japanese characters as 282, over the limit", () => {
    const res = weightedLength("あ".repeat(141));
    expect(res.weighted).toBe(282);
    expect(res.valid).toBe(false);
    expect(res.remaining).toBe(-2);
  });

  it("counts any URL as 23, however long it really is", () => {
    expect(w("https://a.co")).toBe(TCO_URL_LENGTH);
    expect(w(`https://${"x".repeat(300)}.com/y`)).toBe(TCO_URL_LENGTH);
    expect(w("http://a.co")).toBe(TCO_URL_LENGTH);
  });

  it("counts a bare domain as a URL", () => {
    expect(w("example.com/path")).toBe(TCO_URL_LENGTH);
  });

  it("counts a ZWJ family emoji as 2, not as its component code points", () => {
    expect(w("👨‍👩‍👧‍👦")).toBe(2);
  });

  it("counts a skin-tone modified emoji as 2", () => {
    expect(w("🙋🏽")).toBe(2);
  });

  it("counts a plain emoji as 2", () => {
    expect(w("👾")).toBe(2);
  });

  it("counts NFC and NFD spellings of the same word identically", () => {
    expect(w("café")).toBe(4); // NFC: e-acute as one code point
    expect(w("café")).toBe(4); // NFD: e + combining acute
  });

  it("treats an empty string as invalid rather than as a valid empty post", () => {
    const res = weightedLength("");
    expect(res.weighted).toBe(0);
    expect(res.valid).toBe(false);
  });

  it("mixes weights correctly", () => {
    // 5 Latin (5) + 2 CJK (4) = 9
    expect(w("hello日本")).toBe(9);
  });

  it("counts text around a URL as well as the URL", () => {
    // "see " = 4, URL = 23, " end" = 4
    expect(w("see https://a.co end")).toBe(31);
  });

  it("counts two URLs separately", () => {
    expect(w("https://a.co https://b.co")).toBe(23 + 1 + 23);
  });

  it("reports which URLs it found and what it charged for them", () => {
    const res = weightedLength("go to https://example.com/very/long/path now");
    expect(res.urls).toEqual([{ url: "https://example.com/very/long/path", countedAs: 23 }]);
  });
});

describe("assembleComposerText", () => {
  it("assembles in X's documented order: text, url, hashtags, via", () => {
    expect(
      assembleComposerText({
        text: "Shipping v2",
        url: "https://acme.dev",
        hashtags: ["release", "ts"],
        via: "mgcrea",
      }),
    ).toBe("Shipping v2 https://acme.dev #release #ts via @mgcrea");
  });

  it("strips a leading # from hashtags and @ from via", () => {
    expect(assembleComposerText({ text: "hi", hashtags: ["#tag"], via: "@me" })).toBe(
      "hi #tag via @me",
    );
  });
});

describe("validateIntent", () => {
  it("counts the assembled post, not just the text", () => {
    // 270 chars of text is fine alone, but not once a 23-char URL and a space
    // are appended. Validating `text` alone would hand back a URL X rejects.
    const text = "a".repeat(270);
    expect(weightedLength(text).valid).toBe(true);
    const res = validateIntent({ text, url: "https://acme.dev" });
    expect(res.weighted).toBe(270 + 1 + 23);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/14 over/);
  });

  it("counts hashtags and via toward the limit too", () => {
    const res = validateIntent({ text: "a".repeat(270), hashtags: ["release"], via: "mgcrea" });
    expect(res.valid).toBe(false);
  });

  it("accepts a post that fits", () => {
    const res = validateIntent({ text: "Shipping v2 today", url: "https://acme.dev/v2" });
    expect(res.valid).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.remaining).toBeGreaterThan(200);
  });

  it("explains an empty post rather than reporting a length problem", () => {
    expect(validateIntent({ text: "" }).error).toBe("The post is empty.");
  });

  it("warns about a URL being counted as 23", () => {
    const res = validateIntent({ text: "see", url: "https://a.co" });
    expect(res.warnings.join(" ")).toMatch(/t\.co/);
  });

  it("warns about hashtag spam", () => {
    const res = validateIntent({ text: "hi", hashtags: ["a", "b", "c", "d", "e"] });
    expect(res.warnings.join(" ")).toMatch(/spam/);
  });

  it("warns when inReplyTo is not a post id", () => {
    const res = validateIntent({ text: "hi", inReplyTo: "https://x.com/a/status/123" });
    expect(res.warnings.join(" ")).toMatch(/not a post id/);
  });
});

describe("buildIntentUrl", () => {
  it("uses the documented /intent/tweet path, not the undocumented /intent/post", () => {
    expect(buildIntentUrl({ text: "hi" }).startsWith("https://x.com/intent/tweet?")).toBe(true);
  });

  it("percent-encodes text with reserved characters, newlines and emoji", () => {
    const url = buildIntentUrl({ text: "a&b #tag +1\nnew 👋" });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("text")).toBe("a&b #tag +1\nnew 👋");
  });

  it("comma-joins hashtags without the # character", () => {
    const url = new URL(buildIntentUrl({ text: "hi", hashtags: ["#a", "b"] }));
    expect(url.searchParams.get("hashtags")).toBe("a,b");
  });

  it("maps inReplyTo to in_reply_to", () => {
    const url = new URL(buildIntentUrl({ text: "hi", inReplyTo: "1799000000000000001" }));
    expect(url.searchParams.get("in_reply_to")).toBe("1799000000000000001");
  });

  it("strips the @ from via", () => {
    const url = new URL(buildIntentUrl({ text: "hi", via: "@mgcrea" }));
    expect(url.searchParams.get("via")).toBe("mgcrea");
  });

  it("omits parameters that were not supplied", () => {
    const url = new URL(buildIntentUrl({ text: "hi" }));
    expect([...url.searchParams.keys()]).toEqual(["text"]);
  });

  it("round-trips through the URL parser", () => {
    const input = { text: "Shipping v2", url: "https://acme.dev/v2?a=1&b=2", via: "mgcrea" };
    const parsed = new URL(buildIntentUrl(input));
    expect(parsed.searchParams.get("url")).toBe("https://acme.dev/v2?a=1&b=2");
    expect(parsed.searchParams.get("text")).toBe("Shipping v2");
  });
});
