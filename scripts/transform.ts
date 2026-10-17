// Turns Scryfall card objects into compact records. Kept free of I/O so it can be tested.
import { FACE_SEP, FLAG_BACK_IMAGE, type CardRecord } from '../src/format.ts';

export interface ScryfallFace {
  name: string;
  mana_cost?: string;
  type_line?: string;
  image_uris?: Record<string, string>;
}

export interface ScryfallCard {
  id: string;
  name: string;
  layout: string;
  set_type: string;
  mana_cost?: string;
  type_line?: string;
  edhrec_rank?: number | null;
  image_status?: string;
  image_uris?: Record<string, string>;
  card_faces?: ScryfallFace[];
}

// Not cards anyone looks up by name: art cards, oversized "front cards",
// World Championship decklist/bio cards (all set_type "memorabilia"), tokens
// and emblems.
const EXCLUDED_LAYOUTS = new Set(['token', 'double_faced_token', 'emblem', 'art_series']);
const EXCLUDED_SET_TYPES = new Set(['memorabilia']);

export function isIncluded(card: ScryfallCard): boolean {
  return !EXCLUDED_LAYOUTS.has(card.layout) && !EXCLUDED_SET_TYPES.has(card.set_type);
}

export function toRecord(card: ScryfallCard): CardRecord {
  const faces = card.card_faces;
  // Build multi-face fields from the faces: Scryfall's top-level mana_cost is
  // not always one segment per face (flip and some adventure cards).
  const mana = faces ? faces.map((f) => f.mana_cost ?? '').join(FACE_SEP) : (card.mana_cost ?? '');
  const type = faces ? faces.map((f) => f.type_line ?? '').join(FACE_SEP) : (card.type_line ?? '');
  const record: CardRecord = [card.name, mana, type, card.id.replaceAll('-', '')];

  const flags = !card.image_uris && faces?.[1]?.image_uris ? FLAG_BACK_IMAGE : 0;
  let imageVersion = '';
  if (card.image_status !== 'highres_scan') {
    const url = card.image_uris?.large ?? faces?.[0]?.image_uris?.large ?? '';
    imageVersion = url.split('?')[1] ?? '';
  }
  if (flags || imageVersion) record.push(flags);
  if (imageVersion) record.push(imageVersion);
  return record;
}

/** EDHREC rank ascending, unranked last, then by name so output is deterministic. */
export function compareCards(a: ScryfallCard, b: ScryfallCard): number {
  const ra = a.edhrec_rank ?? Infinity;
  const rb = b.edhrec_rank ?? Infinity;
  if (ra !== rb) return ra < rb ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
