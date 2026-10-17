// Downloads Scryfall's Oracle Cards bulk file and mana symbols, and writes:
//   public/data/cards.<hash>.json   compact card records
//   public/version.json             manifest pointing at the current data file
//   src/generated/symbols.svg       mana symbol sprite (bundled into the app)
//
// Usage: node scripts/build-data.ts [--input oracle-cards.jsonl[.gz]]
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { brotliCompressSync, constants, createGunzip, gzipSync } from 'node:zlib';
import { DATA_FORMAT, symbolId, type CardRecord, type VersionManifest } from '../src/format.ts';
import { compareCards, isIncluded, toRecord, type ScryfallCard } from './transform.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_DIR = join(PUBLIC_DIR, 'data');
const GENERATED_DIR = join(ROOT, 'src', 'generated');

// Refuse to publish a suspiciously small file (truncated download, API change).
const MIN_CARDS = 20000;

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface BulkData {
  updated_at: string;
  download_uri?: string;
  jsonl_download_uri?: string;
}

/** Yields card objects from either JSON Lines or a JSON array, gzipped or not. */
async function* readCards(buf: Buffer): AsyncGenerator<ScryfallCard> {
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
  if (array) yield* JSON.parse(array.join('\n')) as ScryfallCard[];
}

async function loadCards(input: string | undefined): Promise<{ cards: ScryfallCard[]; updated: string }> {
  let buf: Buffer;
  let updated: string;
  if (input) {
    buf = await readFile(input);
    updated = (await stat(input)).mtime.toISOString();
  } else {
    const bulk = (await (await get('https://api.scryfall.com/bulk-data/oracle-cards')).json()) as BulkData;
    const uri = bulk.jsonl_download_uri ?? bulk.download_uri;
    if (!uri) throw new Error('bulk-data response has no download URI');
    console.log(`Downloading ${uri}`);
    buf = Buffer.from(await (await get(uri)).arrayBuffer());
    updated = bulk.updated_at;
  }
  const cards: ScryfallCard[] = [];
  for await (const card of readCards(buf)) cards.push(card);
  return { cards, updated };
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
  const { values } = parseArgs({ options: { input: { type: 'string' } } });

  const [{ cards, updated }, sprite] = await Promise.all([loadCards(values.input), buildSprite()]);
  const included = cards.filter(isIncluded).sort(compareCards);
  if (included.length < MIN_CARDS) {
    throw new Error(`Only ${included.length} cards after filtering (expected >= ${MIN_CARDS}); refusing to publish`);
  }
  const records: CardRecord[] = included.map(toRecord);

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
