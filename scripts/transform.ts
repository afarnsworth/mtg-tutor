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
  oracle_id: string;
  name: string;
  layout: string;
  set_type: string;
  mana_cost?: string;
  type_line?: string;
  edhrec_rank?: number | null;
  rarity?: string;
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

/** One printing from Scryfall's Default Cards bulk file (fields we use). */
export interface ScryfallPrinting {
  oracle_id?: string;
  card_faces?: { oracle_id?: string }[];
  set: string;
  set_type: string;
  released_at: string;
  games: string[];
  promo?: boolean;
  oversized?: boolean;
  prices: { usd?: string | null; usd_foil?: string | null; usd_etched?: string | null };
}

/** Per-card facts gathered across all printings. */
export interface PrintStats {
  sets: Set<string>;
  /** Highest non-foil price among regular printings. */
  regularMax: number;
  /** Lowest price among any paper printings. */
  anyMin: number;
  /** Earliest release date of any printing (YYYY-MM-DD). */
  firstReleased: string;
}

export function addPrinting(stats: Map<string, PrintStats>, p: ScryfallPrinting): void {
  // Reversible cards keep their oracle id on the faces.
  const oracleId = p.oracle_id ?? p.card_faces?.[0]?.oracle_id;
  if (!oracleId) return;
  let s = stats.get(oracleId);
  if (!s) stats.set(oracleId, (s = { sets: new Set(), regularMax: 0, anyMin: Infinity, firstReleased: p.released_at }));
  if (p.released_at < s.firstReleased) s.firstReleased = p.released_at;

  if (!p.games.includes('paper') || p.set_type === 'token') return;
  // Collectors' Edition and similar don't count as reprints, but their prices
  // are often the only ones Scryfall has for the oldest cards (Black Lotus).
  if (p.set_type !== 'memorabilia') s.sets.add(p.set);

  const usd = Number(p.prices.usd) || 0;
  const any = usd || Number(p.prices.usd_foil) || Number(p.prices.usd_etched) || 0;
  if (any) s.anyMin = Math.min(s.anyMin, any);
  // Foil, serialized and promo variants are priced as collectibles, not as cards.
  if (usd && !p.promo && !p.oversized && p.set_type !== 'funny' && p.set_type !== 'memorabilia') s.regularMax = Math.max(s.regularMax, usd);
}

/**
 * How expensive a card is as a card. Usually its priciest regular printing;
 * the cheapest-printing fallback covers cards like Black Lotus whose regular
 * printings have no market price.
 */
export function priceOf(s: PrintStats | undefined): number {
  if (!s) return 0;
  return Math.max(s.regularMax, s.anyMin === Infinity ? 0 : s.anyMin);
}
