// Popularity ranking: each signal ranks the cards on its own, and a card's
// overall rank is its best (lowest) weighted rank across signals. Being near
// the top of any one list is enough: Black Lotus has no EDHREC rank but is
// near the top by price; Lightning Bolt is near the top by reprints.
//
// Weights > 1 demote a signal so that only its strongest entries compete with
// EDHREC. They were tuned by eye with `npm run eval`.

export interface Signals {
  /** Scryfall's edhrec_rank (1 = most popular). */
  edhrec: number | null;
  /** Distinct paper sets the card was printed in. */
  prints: number;
  /** Price in USD; see priceOf in transform.ts. */
  price: number;
  /** Cube Cobra cubes containing the card. */
  cubes: number;
  /** First printed recently (or not yet released). */
  isNew: boolean;
}

export const WEIGHTS = {
  edhrec: 1,
  // Starter-deck staples (Goblin Balloon Brigade) otherwise crowd out better cards.
  prints: 3,
  // Old, expensive, unplayed cards (Forcefield) otherwise beat Force of Will.
  price: 3,
  cubes: 1,
} as const;

// New cards have no data in any source yet, so give them a floor: ahead of
// obscure old cards, behind established staples.
export const NEW_CARD_RANK = 2000;
export const NEW_CARD_DAYS = 90;

/** 1-based rank by descending value; ties share the better rank; 0 is unranked (Infinity). */
export function rankDescending(values: readonly number[]): number[] {
  const sorted = values.filter((v) => v > 0).sort((a, b) => b - a);
  const firstIndex = new Map<number, number>();
  sorted.forEach((v, i) => {
    if (!firstIndex.has(v)) firstIndex.set(v, i + 1);
  });
  return values.map((v) => (v > 0 ? firstIndex.get(v)! : Infinity));
}

/** Overall rank score per card (lower is better; Infinity if no signal ranks it). */
export function combinedRanks(signals: readonly Signals[]): number[] {
  const prints = rankDescending(signals.map((s) => s.prints));
  const price = rankDescending(signals.map((s) => s.price));
  const cubes = rankDescending(signals.map((s) => s.cubes));
  return signals.map((s, i) =>
    Math.min(
      (s.edhrec ?? Infinity) * WEIGHTS.edhrec,
      prints[i] * WEIGHTS.prints,
      price[i] * WEIGHTS.price,
      cubes[i] * WEIGHTS.cubes,
      s.isNew ? NEW_CARD_RANK : Infinity,
    ),
  );
}
