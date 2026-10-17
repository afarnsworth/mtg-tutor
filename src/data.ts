// Loads card data, keeps it in Cache Storage for offline use, and picks up new
// data when version.json changes.
import { DATA_FORMAT, type CardRecord, type DataFile, type VersionManifest } from './format.ts';

const CACHE_NAME = 'mtg-data';
const VERSION_KEY = 'mtg-tutor:version';
/** How stale the version check may get while the app stays open in the background. */
const RECHECK_MS = 6 * 60 * 60 * 1000;

export interface Dataset {
  version: VersionManifest;
  cards: CardRecord[];
}

export interface DataEvents {
  /** New data is ready. `update` is true when it replaces data already shown. */
  onData(data: Dataset, update: boolean): void;
  onError(message: string): void;
}

// Cache Storage is missing outside secure contexts; everything still works, just not offline.
async function openCache(): Promise<Cache | undefined> {
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return undefined;
  }
}

function readStoredVersion(): VersionManifest | null {
  try {
    const v = JSON.parse(localStorage.getItem(VERSION_KEY) ?? 'null') as VersionManifest | null;
    return v?.format === DATA_FORMAT ? v : null;
  } catch {
    return null;
  }
}

function storeVersion(version: VersionManifest) {
  try {
    localStorage.setItem(VERSION_KEY, JSON.stringify(version));
  } catch {
    // Without it we re-check the network on every launch, which is fine.
  }
}

async function fetchVersion(): Promise<VersionManifest> {
  const res = await fetch('version.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`version.json: ${res.status}`);
  return res.json();
}

async function loadDataset(version: VersionManifest, cacheOnly: boolean): Promise<Dataset> {
  const cache = await openCache();
  let res = await cache?.match(version.data);
  if (!res) {
    if (cacheOnly) throw new Error('not cached');
    res = await fetch(version.data);
    if (!res.ok) throw new Error(`${version.data}: ${res.status}`);
    await cache?.put(version.data, res.clone());
  }
  const file = (await res.json()) as DataFile;
  if (file.format !== DATA_FORMAT) throw new Error(`Unsupported data format ${file.format}`);
  return { version, cards: file.cards };
}

async function pruneCache(keep: string) {
  const cache = await openCache();
  if (!cache) return;
  const keepUrl = new URL(keep, location.href).href;
  for (const req of await cache.keys()) {
    if (req.url !== keepUrl) await cache.delete(req);
  }
}

export function startData(events: DataEvents) {
  let current: VersionManifest | null = null;
  let lastCheck = 0;

  async function check() {
    lastCheck = Date.now();
    let latest: VersionManifest;
    try {
      latest = await fetchVersion();
    } catch {
      if (!current) events.onError('Offline, and no card data has been downloaded yet.');
      return;
    }
    if (latest.format !== DATA_FORMAT) {
      // Newer data than this app understands; the updated app will arrive via the service worker.
      if (!current) events.onError('This app version is out of date. Reload to update.');
      return;
    }
    if (current?.hash === latest.hash) return;
    try {
      const data = await loadDataset(latest, false);
      const update = current !== null;
      current = latest;
      storeVersion(latest);
      events.onData(data, update);
      await pruneCache(latest.data);
      void navigator.storage?.persist?.();
    } catch (err) {
      if (!current) events.onError(`Couldn't load card data: ${(err as Error).message}`);
    }
  }

  async function start() {
    // Show cached data immediately, then look for newer data in the background.
    const stored = readStoredVersion();
    if (stored) {
      try {
        events.onData(await loadDataset(stored, true), false);
        current = stored;
      } catch {
        // Cache was evicted; fall through to the network.
      }
    }
    await check();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastCheck > RECHECK_MS) void check();
  });
  void start();
}
