import { FACE_SEP, type CardRecord } from './format.ts';

/** Lowercase, strip diacritics and punctuation: "Lim-Dûl's Vault" -> "lim duls vault". */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/['‘’"“”]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Lower is better. */
export const Tier = {
  Exact: 0,
  Prefix: 1,
  WordStart: 2,
  Substring: 3,
  /** Every query word starts a word of the name, in any order: "jace mind". */
  AllWords: 4,
  /** Within a small edit distance of a prefix of the name. */
  Fuzzy: 5,
} as const;
export type Tier = (typeof Tier)[keyof typeof Tier];

export interface Match {
  /** Index into the card array. */
  card: number;
  /** Matched face of a multi-face card, or -1 for the whole card. */
  face: number;
  tier: Tier;
}

const FUZZY_MIN_LENGTH = 4;

/**
 * Starting the name beats starting a later word, but not absolutely: a
 * word-start match competes as if it were this many times less popular. So
 * "scarab" lists The Scarab God (#1,222) before Scarab Feast (#19,776), and
 * "ring" lists Sol Ring before Ring of Ma'rûf. Tuned with `npm run eval`.
 */
export const WORD_START_PENALTY = 5;
// Very short queries word-start-match too many names for popularity to help.
const WORD_START_PENALTY_MIN_LENGTH = 3;
// Typo matching only kicks in when the query found (almost) nothing: padding a
// list of real matches with near-misses is just noise.
const FUZZY_BELOW_RESULTS = 3;

/** Bitset of the characters in s[0, end), folded into 32 bits. */
function charMask(s: string, end = s.length): number {
  let mask = 0;
  for (let i = 0; i < end; i++) mask |= 1 << (s.charCodeAt(i) & 31);
  return mask;
}

function popcount(n: number): number {
  let count = 0;
  for (; n; n &= n - 1) count++;
  return count;
}

interface PreparedQuery {
  q: string;
  /** q without spaces, so "limdul" finds "Lim-Dûl". */
  qc: string;
  spaced: string;
  words: string[];
}

function prepare(query: string): PreparedQuery | null {
  const q = normalize(query);
  if (!q) return null;
  return { q, qc: q.replaceAll(' ', ''), spaced: ' ' + q, words: q.split(' ') };
}

function tierOf(name: string, compact: string, { q, qc, spaced, words }: PreparedQuery): Tier | -1 {
  if (name === q || compact === qc) return Tier.Exact;
  if (name.startsWith(q) || compact.startsWith(qc)) return Tier.Prefix;
  if (name.includes(spaced)) return Tier.WordStart;
  if (compact.includes(qc)) return Tier.Substring;
  if (words.length > 1 && words.every((w) => name.startsWith(w) || name.includes(' ' + w))) return Tier.AllWords;
  return -1;
}

/**
 * In-memory name index. Cards must be passed in rank order: ties within a tier
 * are broken by position, so the first card wins.
 */
export class SearchIndex {
  // Parallel arrays, one entry per searchable name. Each card has an entry for
  // its full name followed by one per face (multi-face cards only).
  private readonly names: string[] = [];
  private readonly compacts: string[] = [];
  private readonly cardOf: Int32Array;
  private readonly faceOf: Int8Array;

  constructor(cards: readonly CardRecord[]) {
    const cardOf: number[] = [];
    const faceOf: number[] = [];
    const add = (name: string, card: number, face: number) => {
      const norm = normalize(name);
      this.names.push(norm);
      this.compacts.push(norm.replaceAll(' ', ''));
      cardOf.push(card);
      faceOf.push(face);
    };
    cards.forEach((record, card) => {
      add(record[0], card, -1);
      const faces = record[0].split(FACE_SEP);
      if (faces.length > 1) faces.forEach((face, i) => add(face, card, i));
    });
    this.cardOf = Int32Array.from(cardOf);
    this.faceOf = Int8Array.from(faceOf);
  }

  search(query: string, limit = 20): Match[] {
    const prepared = prepare(query);
    if (!prepared) return [];
    const { q, qc } = prepared;

    // Cards are visited in rank order, so the first `limit` hits in each tier
    // are the best ones and later hits in a full tier can be dropped.
    const buckets: Match[][] = [[], [], [], [], []];
    const { names, compacts, cardOf, faceOf } = this;
    let i = 0;
    while (i < names.length) {
      const card = cardOf[i];
      let best: Match | null = null;
      // Visit all entries of this card and keep its best tier (the full name wins ties).
      for (; i < names.length && cardOf[i] === card; i++) {
        const tier = tierOf(names[i], compacts[i], prepared);
        if (tier !== -1 && (!best || tier < best.tier)) best = { card, face: faceOf[i], tier };
      }
      if (best) {
        const bucket = buckets[best.tier];
        if (bucket.length < limit) bucket.push(best);
      }
    }

    // Both buckets are in rank order (card index), so merging them by weighted
    // index gives the best `limit` of the two combined.
    const penalty = q.length >= WORD_START_PENALTY_MIN_LENGTH ? WORD_START_PENALTY : Infinity;
    const prefix = buckets[Tier.Prefix];
    const wordStart = buckets[Tier.WordStart];
    const merged: Match[] = [];
    for (let p = 0, w = 0; p < prefix.length || w < wordStart.length; ) {
      const takePrefix = w >= wordStart.length || (p < prefix.length && prefix[p].card + 1 <= (wordStart[w].card + 1) * penalty);
      merged.push(takePrefix ? prefix[p++] : wordStart[w++]);
    }
    const results = [...buckets[Tier.Exact], ...merged, ...buckets.slice(Tier.Substring).flat()].slice(0, limit);
    if (results.length < Math.min(limit, FUZZY_BELOW_RESULTS) && qc.length >= FUZZY_MIN_LENGTH) {
      // No bucket was full, so `results` holds every card that matched.
      results.push(...this.fuzzy(q, limit - results.length, new Set(results.map((m) => m.card))));
    }
    return results;
  }

  /** Typo tolerance: prefix edit distance against each name, for cards not already matched. */
  private fuzzy(q: string, limit: number, exclude: Set<number>): Match[] {
    const maxDistance = q.length < 8 ? 1 : 2;
    const buckets: Match[][] = Array.from({ length: maxDistance + 1 }, () => []);
    const seen = new Set<number>();
    const qMask = charMask(q);
    const { names, cardOf, faceOf } = this;
    for (let i = 0; i < names.length; i++) {
      const card = cardOf[i];
      if (exclude.has(card) || seen.has(card)) continue;
      const name = names[i];
      // Cheap necessary condition: each edit adds at most one character of q
      // that the name's prefix is missing.
      if (popcount(qMask & ~charMask(name, Math.min(name.length, q.length + maxDistance))) > maxDistance) continue;
      const d = prefixDistance(q, name, maxDistance);
      if (d <= maxDistance) {
        seen.add(card);
        if (buckets[d].length < limit) buckets[d].push({ card, face: faceOf[i], tier: Tier.Fuzzy });
      }
    }
    return buckets.flat().slice(0, limit);
  }
}

// Reused DP rows for prefixDistance.
let rows = [new Int32Array(64), new Int32Array(64), new Int32Array(64)];

/**
 * Smallest edit distance (Levenshtein plus adjacent transpositions) between
 * `q` and any prefix of `s`. Returns max + 1 as soon as it must exceed `max`.
 */
export function prefixDistance(q: string, s: string, max: number): number {
  const m = q.length;
  // A prefix longer than m + max can never be within max edits.
  const n = Math.min(s.length, m + max);
  if (rows[0].length <= n) rows = rows.map(() => new Int32Array(n * 2));
  let [prev2, prev, cur] = rows;
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let rowMin = i;
    const qi = q.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const sj = s.charCodeAt(j - 1);
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (qi === sj ? 0 : 1));
      if (i > 1 && j > 1 && qi === s.charCodeAt(j - 2) && q.charCodeAt(i - 2) === sj) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  let best = max + 1;
  for (let j = 0; j <= n; j++) if (prev[j] < best) best = prev[j];
  return best;
}
