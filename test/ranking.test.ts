import { describe, expect, it } from 'vitest';
import { combinedRanks, NEW_CARD_RANK, rankDescending, WEIGHTS, type Signals } from '../scripts/ranking.ts';

const none: Signals = { edhrec: null, prints: 0, price: 0, cubes: 0, isNew: false };

describe('rankDescending', () => {
  it('ranks high values first, shares ties, and leaves zeros unranked', () => {
    expect(rankDescending([5, 0, 9, 5, 1])).toEqual([2, Infinity, 1, 2, 4]);
  });
});

describe('combinedRanks', () => {
  it("takes each card's best weighted rank across signals", () => {
    const ranks = combinedRanks([
      { ...none, edhrec: 10 },
      { ...none, edhrec: 50, cubes: 1000 }, // #1 by cubes
      { ...none, price: 6400 }, // #1 by price, no EDHREC rank
      none,
    ]);
    expect(ranks).toEqual([10, 1 * WEIGHTS.cubes, 1 * WEIGHTS.price, Infinity]);
  });

  it('gives new cards a floor rank without demoting ones that already rank better', () => {
    expect(combinedRanks([{ ...none, isNew: true }, { ...none, isNew: true, edhrec: 5 }])).toEqual([NEW_CARD_RANK, 5]);
  });

  it('demotes weighted signals relative to EDHREC', () => {
    const [byPrints, byEdhrec] = combinedRanks([
      { ...none, prints: 200 },
      { ...none, edhrec: 2, prints: 100 },
    ]);
    expect(byPrints).toBe(WEIGHTS.prints);
    expect(byEdhrec).toBe(Math.min(2, 2 * WEIGHTS.prints));
  });
});
