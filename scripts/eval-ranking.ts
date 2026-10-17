// Runs the queries in eval-queries.json against the current data file and
// reports where each expected card lands. A tuning aid for scripts/ranking.ts,
// not a test: the data changes nightly.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DataFile, VersionManifest } from '../src/format.ts';
import { SearchIndex } from '../src/search.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(await readFile(join(ROOT, 'public', 'version.json'), 'utf8')) as VersionManifest;
const { cards } = JSON.parse(await readFile(join(ROOT, 'public', version.data), 'utf8')) as DataFile;
const queries = JSON.parse(await readFile(join(ROOT, 'scripts', 'eval-queries.json'), 'utf8')) as [string, string, number][];
const index = new SearchIndex(cards);

let passed = 0;
let total = 0;
for (const [query, expected, within] of queries) {
  if (within === 0) continue; // comment row
  total++;
  const names = index.search(query).map((m) => cards[m.card][0]);
  const position = names.indexOf(expected) + 1;
  const ok = position > 0 && position <= within;
  if (ok) passed++;
  const where = position ? `#${position}` : 'not in top 20';
  console.log(`${ok ? 'ok  ' : 'MISS'} ${query.padEnd(12)} ${expected} ${where}${ok ? '' : `  (got: ${names.slice(0, 3).join(' | ')})`}`);
}
console.log(`\n${passed}/${total} expected cards within their top N`);
