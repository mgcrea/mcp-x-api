// X does not count characters; it counts *weighted* characters, per the
// twitter-text v3 config. Everything is weight 200 by default and only a few
// ranges are 100, which is why 140 Japanese characters exactly fills a post
// while 280 Latin ones do. Getting this wrong means handing the user a draft
// the composer then rejects, which is precisely the failure this module exists
// to prevent.
//
// Constants are transcribed from twitter-text's config/v3.json. That repo has
// been unmaintained since 2021, so its emoji regex only knows Unicode ~13; we
// use Intl.Segmenter instead, which tracks the runtime's Unicode version and
// counts newer ZWJ sequences correctly rather than over-charging them.

/** Code point ranges that weigh 100 (i.e. one character). Everything else is 200. */
const LIGHT_RANGES: readonly (readonly [number, number])[] = [
  [0, 4351], // Latin, Greek, Cyrillic, Hebrew, Arabic, Thai, Hangul Jamo
  [8192, 8205], // General punctuation spaces, ZWNJ/ZWJ
  [8208, 8223], // Dashes and quotation marks
  [8242, 8247], // Primes
];

const DEFAULT_WEIGHT = 200;
const SCALE = 100;
export const MAX_WEIGHTED_LENGTH = 280;

/**
 * Every URL costs the same whatever its real length: X rewrites it to t.co.
 * There is a single value now — the old http/https split was deprecated once
 * every t.co link became https.
 */
export const TCO_URL_LENGTH = 23;

/**
 * Conservative URL detection. Scheme-ful URLs plus bare `domain.tld/path` for
 * the TLDs people actually paste. Deliberately narrow: over-matching would
 * silently under-count a draft (charging 23 for something X treats as plain
 * text), and a draft rejected at the composer is worse than one that looks a
 * few characters longer than it is.
 */
const URL_PATTERN =
  /\bhttps?:\/\/[^\s<>"']+|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|org|net|io|dev|co|ai|app|xyz|me|gg|so|sh|to|tv|fr|uk|de|jp)\b(?:\/[^\s<>"']*)?/gi;

const isLight = (codePoint: number): boolean =>
  LIGHT_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);

const EMOJI = /\p{Extended_Pictographic}/u;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Weight one grapheme cluster in twitter-text's internal units. */
const clusterWeight = (cluster: string): number => {
  const first = cluster.codePointAt(0);
  if (first === undefined) return 0;
  // A multi-code-point cluster is a ZWJ sequence, a skin-tone modifier or a
  // combining sequence — X charges the whole thing as one 200-weight unit.
  // This is what makes 👨‍👩‍👧‍👦 count 2 rather than 22.
  if (EMOJI.test(cluster) || [...cluster].length > 1) return DEFAULT_WEIGHT;
  return isLight(first) ? SCALE : DEFAULT_WEIGHT;
};

export type WeightedLength = {
  /** 0-280+, in the units X shows the user. */
  weighted: number;
  remaining: number;
  valid: boolean;
  urls: { url: string; countedAs: number }[];
};

/**
 * Count a draft the way X will.
 *
 * NFC normalization comes first because twitter-text normalizes first: without
 * it a decomposed "café" counts 5 instead of 4, and the user is told they have
 * one character less than they do.
 */
export const weightedLength = (text: string): WeightedLength => {
  const normalized = text.normalize("NFC");

  const urls: { url: string; countedAs: number }[] = [];
  const spans: [number, number][] = [];
  for (const match of normalized.matchAll(URL_PATTERN)) {
    if (match.index === undefined) continue;
    urls.push({ url: match[0], countedAs: TCO_URL_LENGTH });
    spans.push([match.index, match.index + match[0].length]);
  }

  let total = urls.length * TCO_URL_LENGTH * SCALE;

  // Walk the text, skipping the spans already charged as t.co links.
  let index = 0;
  let spanIndex = 0;
  while (index < normalized.length) {
    const span = spans[spanIndex];
    if (span && index === span[0]) {
      index = span[1];
      spanIndex += 1;
      continue;
    }
    const nextStart = span ? span[0] : normalized.length;
    const chunk = normalized.slice(index, nextStart);
    for (const { segment } of segmenter.segment(chunk)) {
      total += clusterWeight(segment);
    }
    index = nextStart;
  }

  const weighted = Math.ceil(total / SCALE);
  return {
    weighted,
    remaining: MAX_WEIGHTED_LENGTH - weighted,
    valid: weighted > 0 && weighted <= MAX_WEIGHTED_LENGTH,
    urls,
  };
};
