import { describe, expect, it } from 'vitest';
import { colorCategory as recordColor, faceOf, hasBackImage, imageUrl } from '../src/card.ts';
import { addPrinting, colorCategory, isIncluded, priceOf, toRecord, type PrintStats, type ScryfallCard, type ScryfallPrinting } from '../scripts/transform.ts';

const ID = '0dbaef61-fa39-4ea7-bc21-445401c373e7';
const base = { id: ID, oracle_id: 'o1', set_type: 'expansion', image_status: 'highres_scan' };

describe('toRecord', () => {
  it('encodes a normal card', () => {
    const card: ScryfallCard = {
      ...base,
      name: 'Sol Ring',
      layout: 'normal',
      mana_cost: '{1}',
      type_line: 'Artifact',
      image_uris: { large: 'https://cards.scryfall.io/large/front/x.jpg?123' },
    };
    const record = toRecord(card);
    expect(record.slice(0, 4)).toEqual(['Sol Ring', '{1}', 'Artifact', ID.replaceAll('-', '')]);
    expect(record.length).toBe(5); // flags (color category), no image version
    expect(hasBackImage(record)).toBe(false);
  });

  it('builds aligned face fields and flags a back image for DFCs', () => {
    const card: ScryfallCard = {
      ...base,
      name: 'Ulvenwald Captive // Ulvenwald Abomination',
      layout: 'transform',
      type_line: 'Creature — Plant Werewolf Horror // Creature — Eldrazi Werewolf',
      card_faces: [
        { name: 'Ulvenwald Captive', mana_cost: '{1}{G}', type_line: 'Creature — Plant Werewolf Horror', image_uris: {} },
        { name: 'Ulvenwald Abomination', mana_cost: '', type_line: 'Creature — Eldrazi Werewolf', image_uris: {} },
      ],
    };
    const record = toRecord(card);
    expect(record.slice(1, 3)).toEqual(['{1}{G} // ', card.type_line]);
    expect(hasBackImage(record)).toBe(true);
    expect(faceOf(record, 1)).toEqual({ name: 'Ulvenwald Abomination', mana: '', type: 'Creature — Eldrazi Werewolf' });
    expect(imageUrl(record, true)).toBe(`https://cards.scryfall.io/large/back/0/d/${ID}.jpg`);
  });

  it('uses face mana costs even when the top-level cost is not split per face', () => {
    // Scryfall gives flip cards a top-level mana_cost without " // ".
    const card: ScryfallCard = {
      ...base,
      name: 'Bushi Tenderfoot // Kenzo the Hardhearted',
      layout: 'flip',
      mana_cost: '{W}',
      card_faces: [
        { name: 'Bushi Tenderfoot', mana_cost: '{W}', type_line: 'Creature — Human Soldier' },
        { name: 'Kenzo the Hardhearted', mana_cost: '', type_line: 'Legendary Creature — Human Samurai' },
      ],
      image_uris: { large: 'x' },
    };
    const record = toRecord(card);
    expect(record[1]).toBe('{W} // ');
    expect(hasBackImage(record)).toBe(false);
  });

  it('keeps the image version only for cards without a high-res scan', () => {
    const card: ScryfallCard = {
      ...base,
      name: 'New Card',
      layout: 'normal',
      image_status: 'lowres',
      image_uris: { large: `https://cards.scryfall.io/large/front/0/d/${ID}.jpg?1790212038` },
    };
    const record = toRecord(card);
    expect(record.slice(4)).toEqual([0, '1790212038']);
    expect(imageUrl(record)).toBe(`https://cards.scryfall.io/large/front/0/d/${ID}.jpg?1790212038`);
  });
});

describe('colorCategory', () => {
  const c = (over: Partial<ScryfallCard>): ScryfallCard => ({ ...base, name: 'x', layout: 'normal', ...over });
  it.each([
    ['two colors', c({ colors: ['W', 'U'], type_line: 'Creature' }), 'gold'],
    ['one color', c({ colors: ['G'], type_line: 'Creature' }), 'G'],
    ['colored land (Dryad Arbor)', c({ colors: ['G'], type_line: 'Land Creature — Forest Dryad' }), 'G'],
    ['colorless land', c({ colors: [], type_line: 'Land' }), 'land'],
    ['artifact land', c({ colors: [], type_line: 'Artifact Land' }), 'land'],
    ['artifact', c({ colors: [], type_line: 'Artifact — Equipment' }), 'artifact'],
    ['colorless non-artifact', c({ colors: [], type_line: 'Creature — Eldrazi' }), 'colorless'],
    [
      'DFC uses the front face',
      c({
        layout: 'transform',
        card_faces: [
          { name: 'a', colors: ['U'], type_line: 'Creature' },
          { name: 'b', colors: ['U', 'B'], type_line: 'Creature' },
        ],
      }),
      'U',
    ],
  ])('%s', (_, card, expected) => {
    expect(colorCategory(card)).toBe(expected);
    // Round-trips through the record's flags without disturbing the back-image flag.
    expect(recordColor(toRecord(card))).toBe(expected);
  });

  it('reads records without color bits as colorless', () => {
    expect(recordColor(['x', '', '', '0'.repeat(32)])).toBe('colorless');
    expect(recordColor(['x', '', '', '0'.repeat(32), 1])).toBe('colorless');
  });
});

describe('filtering', () => {
  it('drops tokens, emblems, art cards and memorabilia', () => {
    const c = (layout: string, set_type = 'expansion') => ({ ...base, name: 'x', layout, set_type });
    expect(isIncluded(c('normal'))).toBe(true);
    expect(isIncluded(c('modal_dfc'))).toBe(true);
    expect(isIncluded(c('token'))).toBe(false);
    expect(isIncluded(c('emblem'))).toBe(false);
    expect(isIncluded(c('art_series'))).toBe(false);
    expect(isIncluded(c('normal', 'memorabilia'))).toBe(false);
  });
});

describe('printing stats', () => {
  const printing = (over: Partial<ScryfallPrinting>): ScryfallPrinting => ({
    oracle_id: 'o1',
    set: 'lea',
    set_type: 'core',
    released_at: '1993-08-05',
    games: ['paper'],
    prices: {},
    ...over,
  });
  const collect = (...printings: ScryfallPrinting[]) => {
    const stats = new Map<string, PrintStats>();
    printings.forEach((p) => addPrinting(stats, p));
    return stats.get('o1');
  };

  it('counts distinct paper sets, ignoring digital and memorabilia printings', () => {
    const s = collect(
      printing({ set: 'lea' }),
      printing({ set: 'lea' }),
      printing({ set: 'm10' }),
      printing({ set: 'ced', set_type: 'memorabilia' }),
      printing({ set: 'ymid', games: ['arena'] }),
    );
    expect([...s!.sets]).toEqual(['lea', 'm10']);
  });

  it('prices regular printings, not foil or promo collectibles', () => {
    const s = collect(
      printing({ prices: { usd: '2.00' } }),
      printing({ prices: { usd: '1.00', usd_foil: '900' } }),
      printing({ promo: true, prices: { usd: '500' } }),
    );
    expect(priceOf(s)).toBe(2);
  });

  it('falls back to the cheapest printing when no regular printing has a price', () => {
    const s = collect(printing({ prices: { usd_foil: '30' } }), printing({ set_type: 'memorabilia', prices: { usd: '40' } }));
    expect(priceOf(s)).toBe(30);
    expect(priceOf(collect(printing({ set: 'ced', set_type: 'memorabilia', prices: { usd: '1800' } })))).toBe(1800);
    expect(priceOf(undefined)).toBe(0);
  });

  it('tracks the earliest release date across all printings, digital included', () => {
    const s = collect(printing({ released_at: '2010-07-16' }), printing({ released_at: '2009-01-01', games: ['mtgo'] }));
    expect(s!.firstReleased).toBe('2009-01-01');
  });

  it('finds the oracle id of reversible cards on their faces', () => {
    const stats = new Map<string, PrintStats>();
    addPrinting(stats, printing({ oracle_id: undefined, card_faces: [{ oracle_id: 'o2' }, { oracle_id: 'o2' }] }));
    expect(stats.has('o2')).toBe(true);
  });
});
