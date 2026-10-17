import { describe, expect, it } from 'vitest';
import { faceOf, hasBackImage, imageUrl } from '../src/card.ts';
import { compareCards, isIncluded, toRecord, type ScryfallCard } from '../scripts/transform.ts';

const ID = '0dbaef61-fa39-4ea7-bc21-445401c373e7';
const base = { id: ID, set_type: 'expansion', image_status: 'highres_scan' };

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
    expect(toRecord(card)).toEqual(['Sol Ring', '{1}', 'Artifact', ID.replaceAll('-', '')]);
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

describe('filtering and sorting', () => {
  it('drops tokens, emblems, art cards and memorabilia', () => {
    const c = (layout: string, set_type = 'expansion') => ({ ...base, name: 'x', layout, set_type });
    expect(isIncluded(c('normal'))).toBe(true);
    expect(isIncluded(c('modal_dfc'))).toBe(true);
    expect(isIncluded(c('token'))).toBe(false);
    expect(isIncluded(c('emblem'))).toBe(false);
    expect(isIncluded(c('art_series'))).toBe(false);
    expect(isIncluded(c('normal', 'memorabilia'))).toBe(false);
  });

  it('sorts by EDHREC rank with unranked cards last', () => {
    const c = (name: string, edhrec_rank?: number | null) => ({ ...base, name, layout: 'normal', edhrec_rank });
    const sorted = [c('B', null), c('C', 5), c('A'), c('D', 1)].sort(compareCards).map((x) => x.name);
    expect(sorted).toEqual(['D', 'C', 'A', 'B']);
  });
});
