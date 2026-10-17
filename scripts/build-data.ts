// Downloads card data and mana symbols, and writes:
//   public/data/cards.<hash>.json   compact card records, in popularity order
//   public/version.json             manifest pointing at the current data file
//   src/generated/symbols.svg       mana symbol sprite (bundled into the app)
//
// Sources: Scryfall's Oracle Cards (one object per card) and Default Cards
// (every printing, for reprint counts and prices) bulk files, and Cube
// Cobra's public card metadata (cube counts; optional).
//
// Usage: node scripts/build-data.ts [--oracle oracle-cards.jsonl.gz]
//          [--printings default-cards.jsonl.gz] [--cubes metadatadict.json]
// Each option uses a local file instead of downloading it.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { brotliCompressSync, constants, createGunzip, gzipSync } from 'node:zlib';
import { DATA_FORMAT, symbolId, type CardRecord, type VersionManifest } from '../src/format.ts';
import { combinedRanks, NEW_CARD_DAYS, type Signals } from './ranking.ts';
import {
  addPrinting,
  isIncluded,
  priceOf,
  toRecord,
  type PrintStats,
  type ScryfallCard,
  type ScryfallPrinting,
} from './transform.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_DIR = join(PUBLIC_DIR, 'data');
const GENERATED_DIR = join(ROOT, 'src', 'generated');

// Refuse to publish a suspiciously small file (truncated download, API change).
const MIN_CARDS = 20000;

// Offered by Cube Cobra for tool development (https://cubecobra.com/tool/exports).
// It is a periodic snapshot, which is fine for a slow-moving signal.
const CUBE_COBRA_METADATA = 'https://cubecobra-public.s3.us-east-2.amazonaws.com/cards/metadatadict.json';

// Scryfall asks every client to send a descriptive User-Agent and an Accept header.
const repo = process.env.GITHUB_REPOSITORY;
const HEADERS = {
  'User-Agent': `mtg-tutor/1.0${repo ? ` (+https://github.com/${repo})` : ''}`,
  Accept: 'application/json;q=0.9,*/*;q=0.8',
};

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
  return res;
}

// Unknown rarities (indexOf -1) sort last via >>> 0.
const RARITY_ORDER = ['mythic', 'rare', 'uncommon', 'common'];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface BulkData {
  updated_at: string;
  download_uri?: string;
  jsonl_download_uri?: string;
}

/** Yields objects from either JSON Lines or a JSON array, gzipped or not. */
async function* readObjects<T>(buf: Buffer): AsyncGenerator<T> {
  const gzipped = buf[0] === 0x1f && buf[1] === 0x8b;
  const input = gzipped ? Readable.from([buf]).pipe(createGunzip()) : Readable.from([buf]);
  let first = true;
  let array: string[] | null = null;
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (first && line.trimStart().startsWith('[')) array = [];
    first = false;
    if (array) array.push(line);
    else if (line.trim()) yield JSON.parse(line);
  }
  if (array) yield* JSON.parse(array.join('\n')) as T[];
}

/** A Scryfall bulk file, from a local path or the bulk-data API. */
async function bulkFile(type: string, input: string | undefined): Promise<{ buf: Buffer; updated: string }> {
  if (input) return { buf: await readFile(input), updated: (await stat(input)).mtime.toISOString() };
  const bulk = (await (await get(`https://api.scryfall.com/bulk-data/${type}`)).json()) as BulkData;
  const uri = bulk.jsonl_download_uri ?? bulk.download_uri;
  if (!uri) throw new Error(`bulk-data ${type} has no download URI`);
  console.log(`Downloading ${uri}`);
  return { buf: Buffer.from(await (await get(uri)).arrayBuffer()), updated: bulk.updated_at };
}

async function loadCards(input: string | undefined): Promise<{ cards: ScryfallCard[]; updated: string }> {
  const { buf, updated } = await bulkFile('oracle-cards', input);
  const cards: ScryfallCard[] = [];
  for await (const card of readObjects<ScryfallCard>(buf)) cards.push(card);
  return { cards, updated };
}

/** Reprint counts and prices per oracle id, folded over every printing. */
async function loadPrintStats(input: string | undefined): Promise<Map<string, PrintStats>> {
  const { buf } = await bulkFile('default-cards', input);
  const stats = new Map<string, PrintStats>();
  for await (const printing of readObjects<ScryfallPrinting>(buf)) addPrinting(stats, printing);
  return stats;
}

/** Cube counts per oracle id. Optional: ranking falls back to the other signals. */
async function loadCubeCounts(input: string | undefined): Promise<Map<string, number>> {
  try {
    const text = input ? await readFile(input, 'utf8') : await (await get(CUBE_COBRA_METADATA)).text();
    const data = JSON.parse(text) as Record<string, { cubes?: number }>;
    return new Map(Object.entries(data).map(([oracleId, m]) => [oracleId, m.cubes ?? 0]));
  } catch (err) {
    console.warn(`Cube Cobra data unavailable, ranking without it: ${(err as Error).message}`);
    return new Map();
  }
}

interface SymbologyEntry {
  symbol: string;
  svg_uri: string;
  appears_in_mana_costs: boolean;
}

async function buildSprite(): Promise<string> {
  const res = await get('https://api.scryfall.com/symbology');
  const symbols = ((await res.json()) as { data: SymbologyEntry[] }).data.filter((s) => s.appears_in_mana_costs);
  const parts: string[] = [];
  for (const { symbol, svg_uri } of symbols) {
    await sleep(75); // stay well inside Scryfall's request-rate guidance
    const svg = await (await get(svg_uri)).text();
    const match = svg.match(/<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/);
    const viewBox = match?.[1].match(/viewBox=["']([^"']+)["']/)?.[1];
    if (!match || !viewBox) throw new Error(`Unexpected SVG for ${symbol}`);
    const id = symbolId(symbol);
    // All symbols share one document, so namespace any internal ids.
    const body = match[2]
      .replace(/\bid=(["'])([^"']+)\1/g, `id="${id}-$2"`)
      .replace(/url\(#([^)]+)\)/g, `url(#${id}-$1)`)
      .replace(/href=(["'])#([^"']+)\1/g, `href="#${id}-$2"`);
    parts.push(`<symbol id="${id}" viewBox="${viewBox}">${body}</symbol>`);
  }
  console.log(`Sprite: ${symbols.length} mana symbols`);
  return `<svg xmlns="http://www.w3.org/2000/svg" class="sprite" aria-hidden="true">${parts.join('')}</svg>\n`;
}

async function main() {
  const { values } = parseArgs({
    options: { oracle: { type: 'string' }, printings: { type: 'string' }, cubes: { type: 'string' } },
  });

  const [{ cards, updated }, printStats, cubeCounts, sprite] = await Promise.all([
    loadCards(values.oracle),
    loadPrintStats(values.printings),
    loadCubeCounts(values.cubes),
    buildSprite(),
  ]);
  const included = cards.filter(isIncluded);
  if (included.length < MIN_CARDS) {
    throw new Error(`Only ${included.length} cards after filtering (expected >= ${MIN_CARDS}); refusing to publish`);
  }

  // Measured from the bulk file's date rather than today, so a given input always builds the same output.
  const newSince = new Date(Date.parse(updated) - NEW_CARD_DAYS * 86_400_000).toISOString().slice(0, 10);
  const signals: Signals[] = included.map((card) => {
    const stats = printStats.get(card.oracle_id);
    return {
      edhrec: card.edhrec_rank ?? null,
      prints: stats?.sets.size ?? 0,
      price: priceOf(stats),
      cubes: cubeCounts.get(card.oracle_id) ?? 0,
      isNew: (stats?.firstReleased ?? '') >= newSince,
    };
  });
  const rank = combinedRanks(signals);
  // Ties (mostly new cards sharing the floor rank, and cards no signal ranks)
  // fall back to rarity, EDHREC and name, so output is deterministic.
  const rarity = (card: ScryfallCard) => RARITY_ORDER.indexOf(card.rarity ?? '') >>> 0;
  const order = included
    .map((card, i) => ({ card, rank: rank[i], rarity: rarity(card), edhrec: card.edhrec_rank ?? Infinity }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.rarity - b.rarity ||
        a.edhrec - b.edhrec ||
        (a.card.name < b.card.name ? -1 : a.card.name > b.card.name ? 1 : 0),
    );
  const records: CardRecord[] = order.map((o) => toRecord(o.card));

  // One record per line: barely affects compressed size and keeps the file inspectable.
  const json = `{"format":${DATA_FORMAT},"cards":[\n${records.map((r) => JSON.stringify(r)).join(',\n')}\n]}\n`;
  const hash = createHash('sha256').update(json).digest('hex').slice(0, 12);
  const dataFile = `cards.${hash}.json`;

  await mkdir(DATA_DIR, { recursive: true });
  for (const old of await readdir(DATA_DIR)) {
    if (/^cards\..*\.json$/.test(old) && old !== dataFile) await rm(join(DATA_DIR, old));
  }
  await writeFile(join(DATA_DIR, dataFile), json);

  const manifest: VersionManifest = { format: DATA_FORMAT, hash, data: `data/${dataFile}`, count: records.length, updated };
  await writeFile(join(PUBLIC_DIR, 'version.json'), JSON.stringify(manifest, null, 2) + '\n');

  await mkdir(GENERATED_DIR, { recursive: true });
  await writeFile(join(GENERATED_DIR, 'symbols.svg'), sprite);

  const raw = Buffer.byteLength(json);
  const gz = gzipSync(json, { level: 9 }).length;
  const br = brotliCompressSync(json, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  const kb = (n: number) => `${Math.round(n / 1024)} KB`;
  console.log(`${records.length} of ${cards.length} cards -> ${dataFile}: ${kb(raw)} raw, ${kb(gz)} gzip, ${kb(br)} brotli`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
