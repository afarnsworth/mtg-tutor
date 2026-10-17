// Data format shared by the build scripts and the client.

/** Bump when the record layout changes. The client ignores data in a format it can't read. */
export const DATA_FORMAT = 1;

/**
 * One card, positionally encoded to keep the file small:
 *   [name, manaCost, typeLine, scryfallIdHex, flags?, imageVersion?]
 *
 * Multi-face cards keep Scryfall's "A // B" convention in name, manaCost and
 * typeLine, and the segments are always aligned (one per face).
 * scryfallIdHex is the card's Scryfall id without dashes.
 * imageVersion is only present for cards whose image is not yet a high-res
 * scan; it busts the image cache once Scryfall replaces the preview.
 * Trailing optional fields are omitted when empty.
 */
export type CardRecord = [string, string, string, string, number?, string?];

/** The second face has its own image (transform / modal DFC). */
export const FLAG_BACK_IMAGE = 1;

/**
 * Flags bits 1-4 hold an index into COLOR_CATEGORIES, used to tint result
 * rows. Data without these bits reads as colorless, so old and new data and
 * clients stay compatible.
 */
export const COLOR_CATEGORIES = ['colorless', 'W', 'U', 'B', 'R', 'G', 'gold', 'artifact', 'land'] as const;
export type ColorCategory = (typeof COLOR_CATEGORIES)[number];
export const COLOR_SHIFT = 1;

export const FACE_SEP = ' // ';

export interface DataFile {
  format: number;
  /** Sorted by EDHREC rank; unranked cards last. */
  cards: CardRecord[];
}

/** Contents of version.json. */
export interface VersionManifest {
  format: number;
  hash: string;
  /** Path of the data file, relative to version.json. */
  data: string;
  count: number;
  /** When Scryfall generated the bulk file. */
  updated: string;
}

/** Sprite element id for a mana symbol, e.g. "{2/W}" -> "ms-2-W". */
export function symbolId(symbol: string): string {
  const inner = symbol.replace(/^\{|\}$/g, '');
  return 'ms-' + [...inner].map((ch) => (/[A-Za-z0-9]/.test(ch) ? ch : ch === '/' ? '-' : `_${ch.codePointAt(0)!.toString(16)}`)).join('');
}
