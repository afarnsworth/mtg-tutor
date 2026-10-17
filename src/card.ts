import { FACE_SEP, FLAG_BACK_IMAGE, type CardRecord } from './format.ts';

export interface Face {
  name: string;
  mana: string;
  type: string;
}

/** The given face of a card, or the whole card for face -1. */
export function faceOf(record: CardRecord, face: number): Face {
  const [name, mana, type] = record;
  if (face < 0) return { name, mana, type };
  return {
    name: name.split(FACE_SEP)[face] ?? name,
    mana: mana.split(FACE_SEP)[face] ?? '',
    type: type.split(FACE_SEP)[face] ?? '',
  };
}

export function hasBackImage(record: CardRecord): boolean {
  return ((record[4] ?? 0) & FLAG_BACK_IMAGE) !== 0;
}

/** Scryfall CDN image URL. Images are served unaltered. */
export function imageUrl(record: CardRecord, back = false): string {
  const hex = record[3];
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const version = record[5] ? `?${record[5]}` : '';
  return `https://cards.scryfall.io/large/${back ? 'back' : 'front'}/${id[0]}/${id[1]}/${id}.jpg${version}`;
}

export function scryfallSearchUrl(record: CardRecord): string {
  return `https://scryfall.com/search?q=${encodeURIComponent(`!"${record[0]}"`)}`;
}
