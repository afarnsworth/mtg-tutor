// Runs after `vite build`: writes dist/sw.js with the precache list and a
// build hash, then gzips text assets for nginx's gzip_static.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');

const files = (await readdir(DIST, { recursive: true, withFileTypes: true }))
  .filter((d) => d.isFile())
  .map((d) => relative(DIST, join(d.parentPath, d.name)))
  .sort();

// Card data and version.json are managed by the app, not the precache.
const precache = files.filter((f) => !/^(sw\.js|version\.json|data\/.*|.*\.(gz|map))$/.test(f));

const hash = createHash('sha256');
for (const file of precache) hash.update(file).update('\0').update(await readFile(join(DIST, file)));
const build = hash.digest('hex').slice(0, 12);

const template = await readFile(join(ROOT, 'src', 'sw.js'), 'utf8');
const sw = template
  .replace("'__BUILD__'", JSON.stringify(build))
  .replace('/*__PRECACHE__*/ []', JSON.stringify(precache.map((f) => (f === 'index.html' ? './index.html' : `./${f}`))));
if (sw.includes('__BUILD__') || sw.includes('__PRECACHE__')) throw new Error('sw.js placeholders not replaced');
await writeFile(join(DIST, 'sw.js'), sw);

let gzipped = 0;
for (const file of [...files, 'sw.js']) {
  if (!/\.(html|js|css|json|svg|webmanifest)$/.test(file)) continue;
  const content = await readFile(join(DIST, file));
  if (content.length < 1024) continue;
  // Fixed gzip header (no mtime), so identical input gives identical output.
  await writeFile(join(DIST, `${file}.gz`), gzipSync(content, { level: 9 }));
  gzipped++;
}

console.log(`sw.js: build ${build}, ${precache.length} precached files; gzipped ${gzipped} files`);
