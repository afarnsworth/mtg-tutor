import { describe, expect, it } from 'vitest';
import type { CardRecord } from '../src/format.ts';
import { normalize, prefixDistance, SearchIndex, Tier, WORD_START_PENALTY } from '../src/search.ts';

const card = (name: string): CardRecord => [name, '', '', '0'.repeat(32)];

// In rank order, as in the data file.
const cards = [
  'Sol Ring',
  'Lightning Bolt',
  'Boltwave',
  'Bolt',
  'Thunderbolt',
  'Fire // Ice',
  'Delver of Secrets // Insectile Aberration',
  'Jace, the Mind Sculptor',
  "Lim-Dûl's Vault",
  'Bolt Bend',
].map(card);
const index = new SearchIndex(cards);
const names = (query: string, limit?: number) => index.search(query, limit).map((m) => cards[m.card][0]);

describe('normalize', () => {
  it.each([
    ["Lim-Dûl's Vault", 'lim duls vault'],
    ['Æther Vial', 'aether vial'],
    ['Jötun Owl Keeper', 'jotun owl keeper'],
    ['Ach! Hans, Run!', 'ach hans run'],
    ['Circle of Protection꞉ Red', 'circle of protection red'],
    ['  FIRE // ice ', 'fire ice'],
  ])('%s -> %s', (input, expected) => expect(normalize(input)).toBe(expected));
});

describe('SearchIndex', () => {
  it('ranks exact > prefix > word start > substring, ties by rank', () => {
    expect(names('bolt')).toEqual(['Bolt', 'Boltwave', 'Bolt Bend', 'Lightning Bolt', 'Thunderbolt']);
    expect(names('bol')).toEqual(['Boltwave', 'Bolt', 'Bolt Bend', 'Lightning Bolt', 'Thunderbolt']);
  });

  it('lets a much more popular word-start match beat a start-of-name match', () => {
    const filler = Array.from({ length: WORD_START_PENALTY * 2 }, (_, i) => card(`Filler ${i}`));
    const popular = [card('The Scarab God'), ...filler, card('Scarab Feast')];
    const close = [card('Filler'), card('Filler Two'), card('The Scarab God'), card('Scarab Feast')];
    const top = (list: CardRecord[], q: string) => list[new SearchIndex(list).search(q)[0].card][0];
    expect(top(popular, 'scarab')).toBe('The Scarab God');
    expect(top(close, 'scarab')).toBe('Scarab Feast');
    // Queries shorter than 3 characters keep strict tiers.
    expect(top(popular, 'sc')).toBe('Scarab Feast');
  });

  it('ignores case, diacritics and punctuation', () => {
    expect(names('LIM DULS')).toEqual(["Lim-Dûl's Vault"]);
    expect(names('limdul')).toEqual(["Lim-Dûl's Vault"]);
  });

  it('matches each face of multi-face cards separately', () => {
    expect(index.search('ice')[0]).toMatchObject({ card: 5, face: 1, tier: Tier.Exact });
    expect(index.search('insectile')).toEqual([{ card: 6, face: 1, tier: Tier.Prefix }]);
    expect(index.search('fire ice')[0]).toMatchObject({ card: 5, face: -1, tier: Tier.Exact });
  });

  it('prefers the full name when a face ties with it', () => {
    expect(index.search('fir')[0]).toMatchObject({ card: 5, face: -1, tier: Tier.Prefix });
  });

  it('matches words in any order', () => {
    expect(index.search('jace mind')).toEqual([{ card: 7, face: -1, tier: Tier.AllWords }]);
    expect(names('vault lim')).toEqual(["Lim-Dûl's Vault"]);
  });

  it('falls back to typo-tolerant matching', () => {
    expect(index.search('ligthning')).toEqual([{ card: 1, face: -1, tier: Tier.Fuzzy }]);
    expect(names('sol rnig')).toEqual(['Sol Ring']);
    // Short queries don't fuzzy-match.
    expect(names('blt')).toEqual([]);
  });

  it('returns at most `limit` results and nothing for blank queries', () => {
    expect(names('bol', 2)).toEqual(['Boltwave', 'Bolt']);
    expect(names('  ')).toEqual([]);
  });
});

describe('prefixDistance', () => {
  it('measures distance to the closest prefix', () => {
    expect(prefixDistance('lightning', 'lightning bolt', 2)).toBe(0);
    expect(prefixDistance('ligthning', 'lightning bolt', 2)).toBe(1);
    expect(prefixDistance('lightnin bolt', 'lightning bolt', 2)).toBe(1);
    expect(prefixDistance('bolt', 'lightning bolt', 1)).toBe(2);
  });
});
