# mtg-tutor

A small PWA for fast, offline Magic: The Gathering card lookup. Type part of a
card name and get matches as you type, ranked by relevance and popularity. Tap
a card to see its image.

After the first visit it works with no network at all. Card images are cached
as you view them.

## How it works

**Data.** `npm run data` downloads Scryfall's
[bulk data](https://scryfall.com/docs/api/bulk-data) through its bulk-data
API: Oracle Cards (one object per card) and Default Cards (every printing).
It also downloads Cube Cobra's public card metadata. It then writes:

- `public/data/cards.<hash>.json`: one compact record per card,
  `[name, mana_cost, type_line, scryfall_id, flags?, image_version?]`, sorted
  by popularity (see below). Rank order is implicit, so the rank itself isn't
  stored. See `src/format.ts` for the details.
- `public/version.json`: a small manifest pointing at the current data file.
- `src/generated/symbols.svg`: an SVG sprite of every mana symbol, built from
  Scryfall's `/symbology` endpoint and bundled into the app.

Tokens, emblems, art cards and other memorabilia are left out (about 3,700 of
about 38,700 objects). The result is about 3.1 MB raw, 1.2 MB gzip, or 970 KB
brotli. Most of the compressed size is the Scryfall ids, which are random and
don't compress.

**Popularity** is a "best of" rank: each signal ranks every card, and a
card's rank is its best weighted rank across them. Weights and the reasons
for them are in `scripts/ranking.ts`.

| signal | source | weight |
|---|---|---|
| EDHREC rank | Scryfall | 1 |
| Cube inclusion count | Cube Cobra public S3 snapshot | 1 |
| Distinct paper sets printed in (reprints) | Scryfall Default Cards | 3 |
| Price of the priciest regular (non-foil, non-promo) printing | Scryfall Default Cards | 3 |

A weight of 3 means #100 on that list counts like #300 on EDHREC. Without it, old expensive cards (*Forcefield*) and
starter-deck reprints (*Goblin Balloon Brigade*) crowd out better matches.

Cards first printed in the last 90 days, including previewed cards not yet
released, have no data in any source yet. They get a floor rank of 2,000,
with ties ordered by rarity.

`npm run eval` checks a list of everyday queries (`scripts/eval-queries.json`)
against the current data and reports where the expected card lands. Use it
when changing weights.

**Search** runs in memory over every card. Names are normalized: lowercased,
with diacritics and punctuation removed, so `lim duls` finds *Lim-Dûl's Vault*.
Each face of a multi-face card is indexed on its own. Matches are ranked in
this order:

1. exact
2. prefix or word start
3. substring
4. all words in any order (`jace mind`)

Ties within a tier go to the more popular card. In tier 2, starting the name
counts for more than starting a later word: a word-start match has to be 5×
more popular to come first. That way `scarab` finds *The Scarab God* before
*Scarab Feast*. Queries under 3 characters list start-of-name matches first. If a query finds
fewer than three cards, a typo-tolerant pass is added: edit distance against
name prefixes, with a bitmask prefilter. A keystroke takes a few milliseconds.

**Offline.** The service worker (`src/sw.js`) precaches the app shell. The app
stores the data file in Cache Storage itself, so the first visit is enough to
work offline. On launch the app shows the cached data immediately, then checks
`version.json` and swaps in new data if the hash changed. Card images come
unaltered from Scryfall's CDN (`large` size) and the service worker caches them,
evicting the oldest past 500 images (about 70 MB). The app asks for persistent
storage so the browser is less likely to evict any of this.

## Development

Requires Node 22.18+ (the scripts are TypeScript run directly by Node).

```sh
npm ci
npm run data       # fetch card data and symbols (needed before dev/build)
npm run dev        # dev server (service worker disabled)
npm test
npm run typecheck
npm run build      # dist/: app, sw.js, precompressed .gz files
```

`npm run data -- --oracle <file> --printings <file> --cubes <file>` uses local
copies of the Oracle Cards and Default Cards bulk files and Cube Cobra's
`metadatadict.json` instead of downloading them. Each option is independent.
If the Cube Cobra download fails, the build continues without that signal.

```sh
npm run eval       # where everyday queries land with the current data
```

## Deployment

`.github/workflows/build.yml` runs on every push, on pull requests, nightly,
and on demand. It tests, fetches fresh data and builds the app. On the default
branch it then publishes the app in two ways:

- **GitHub Pages**, at `https://<owner>.github.io/mtg-tutor/`. This needs
  **Settings → Pages → Source: GitHub Actions**. The app uses relative paths,
  so the sub-path works without configuration. Pages sets its own cache
  headers (10 minutes on everything), so a new build can take that long to
  reach phones.
- **A container image**: a multi-arch `nginx:alpine` image at
  `ghcr.io/<owner>/mtg-tutor`, for self-hosting. It is tagged `:latest` and
  `:content-<hash>`. If an image with identical content already exists,
  nothing is pushed, so anything watching `:latest` only sees real changes.

In the container, nginx serves the precompressed `.gz` files and sends these cache headers:

- Hashed `assets/` and `data/` files are cached for a year as `immutable`.
- `index.html`, `sw.js` and `version.json` are `no-cache`.

TLS, hostnames and the compose/update setup live outside this repo. The
container listens on port 80. The service worker and offline storage only work
over HTTPS, so self-hosting needs a trusted certificate even on a home
network.

Things to know:

- GHCR packages are created private. Make the package public, or give the
  machine pulling the image credentials for ghcr.io.
- GitHub disables scheduled workflows in public repos after 60 days without
  repository activity. If the nightly refresh stops, re-enable it from the
  Actions tab.
- nginx's official image has no brotli module, so it serves gzip. A CDN or
  proxy in front can re-compress with brotli.

## License

The code is MIT licensed (see `LICENSE`). That covers this repository's code
only: card data, card images and mana symbols belong to their owners and are
fetched from Scryfall at build or view time, not distributed here.

## Credits

Card data and images are provided by [Scryfall](https://scryfall.com). Cube
inclusion counts come from [Cube Cobra](https://cubecobra.com)'s public data
export. This app
downloads bulk data rather than calling the API per search, and shows images
without modification, per Scryfall's
[API guidelines](https://scryfall.com/docs/api).

MTG Tutor is unofficial Fan Content permitted under the Fan Content Policy. Not
approved/endorsed by Wizards. Portions of the materials used are property of
Wizards of the Coast. ©Wizards of the Coast LLC.
