import './style.css';
import sprite from './generated/symbols.svg?raw';
import { faceOf, hasBackImage, imageUrl, scryfallSearchUrl } from './card.ts';
import { startData } from './data.ts';
import { FACE_SEP, symbolId, type CardRecord } from './format.ts';
import { SearchIndex, type Match } from './search.ts';

const RESULT_LIMIT = 20;
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = $<HTMLInputElement>('q');
const statusEl = $('status');
const list = $<HTMLOListElement>('results');
const dialog = $<HTMLDialogElement>('card');
const img = $<HTMLImageElement>('card-img');
const imgMsg = $('card-msg');
const flipBtn = $<HTMLButtonElement>('card-flip');
const cardLink = $<HTMLAnchorElement>('card-link');
const updateBtn = $<HTMLButtonElement>('update');

document.body.insertAdjacentHTML('afterbegin', sprite);
const knownSymbols = new Set([...document.querySelectorAll('.sprite symbol')].map((s) => s.id));

let cards: CardRecord[] = [];
let index: SearchIndex | null = null;
let results: Match[] = [];
let active = 0;
let baseStatus = 'Loading cards…';

function setStatus(text: string) {
  statusEl.textContent = text;
}

function renderMana(cost: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  // Faces without a cost (most DFC backs) are dropped rather than shown as a dangling "//".
  cost.split(FACE_SEP).filter(Boolean).forEach((segment, i) => {
    if (i > 0) frag.append(Object.assign(document.createElement('span'), { className: 'sep', textContent: '//' }));
    for (const token of segment.match(/\{[^}]+\}/g) ?? []) frag.append(renderSymbol(token));
  });
  return frag;
}

function renderSymbol(token: string): Element {
  const id = symbolId(token);
  if (knownSymbols.has(id)) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ms');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', token);
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#${id}`);
    svg.append(use);
    return svg;
  }
  return Object.assign(document.createElement('span'), { className: 'ms-text', textContent: token });
}

function render() {
  const query = input.value;
  results = index ? index.search(query, RESULT_LIMIT) : [];
  active = 0;
  list.replaceChildren(
    ...results.map((match, i) => {
      const record = cards[match.card];
      const face = faceOf(record, match.face);
      const li = document.createElement('li');
      li.id = `r${i}`;
      li.setAttribute('role', 'option');
      li.dataset.i = String(i);
      const name = Object.assign(document.createElement('span'), { className: 'name', textContent: face.name });
      const type = Object.assign(document.createElement('span'), { className: 'type', textContent: face.type });
      if (match.face >= 0) type.textContent += ` · ${record[0]}`;
      const mana = Object.assign(document.createElement('span'), { className: 'mana' });
      mana.append(renderMana(face.mana));
      li.append(name, mana, type);
      return li;
    }),
  );
  input.setAttribute('aria-expanded', String(results.length > 0));
  highlight();
  if (!index) return;
  if (!query.trim()) setStatus(baseStatus);
  else if (!results.length) setStatus(`No cards match “${query.trim()}”`);
  else setStatus('');
}

function highlight() {
  list.querySelectorAll('[aria-selected]').forEach((el) => el.removeAttribute('aria-selected'));
  const el = results.length ? $(`r${active}`) : null;
  el?.setAttribute('aria-selected', 'true');
  el?.scrollIntoView({ block: 'nearest' });
  if (el) input.setAttribute('aria-activedescendant', el.id);
  else input.removeAttribute('aria-activedescendant');
}

// --- Card dialog ---------------------------------------------------------

let shown: { record: CardRecord; back: boolean } | null = null;

function showImage() {
  if (!shown) return;
  imgMsg.hidden = true;
  img.hidden = false;
  img.classList.add('loading');
  img.alt = faceOf(shown.record, shown.back ? 1 : 0).name;
  img.src = imageUrl(shown.record, shown.back);
}

function openCard(match: Match) {
  const record = cards[match.card];
  const back = hasBackImage(record);
  shown = { record, back: back && match.face === 1 };
  flipBtn.hidden = !back;
  cardLink.href = scryfallSearchUrl(record);
  showImage();
  if (!dialog.open) {
    dialog.showModal();
    // Let the Android back button / back gesture close the dialog.
    history.pushState({ card: true }, '');
  }
}

img.addEventListener('load', () => img.classList.remove('loading'));
img.addEventListener('error', () => {
  img.hidden = true;
  imgMsg.hidden = false;
});
flipBtn.addEventListener('click', () => {
  if (!shown) return;
  shown.back = !shown.back;
  showImage();
});
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close();
});
dialog.addEventListener('close', () => {
  shown = null;
  img.removeAttribute('src');
  if (history.state?.card) history.back();
});
window.addEventListener('popstate', () => {
  if (dialog.open) dialog.close();
});

// --- Search input --------------------------------------------------------

input.addEventListener('input', render);
input.addEventListener('focus', () => input.select());
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!results.length) return;
    e.preventDefault();
    active = (active + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length;
    highlight();
  } else if (e.key === 'Enter' && results[active]) {
    e.preventDefault();
    openCard(results[active]);
  }
});
list.addEventListener('click', (e) => {
  const li = (e.target as Element).closest<HTMLElement>('li[data-i]');
  if (li) openCard(results[Number(li.dataset.i)]);
});

// --- Data and service worker ---------------------------------------------

startData({
  onData(data, update) {
    cards = data.cards;
    index = new SearchIndex(cards);
    const date = data.version.updated.slice(0, 10);
    baseStatus = `${data.version.count.toLocaleString()} cards · data from ${date}${update ? ' · just updated' : ''}`;
    render();
  },
  onError(message) {
    baseStatus = message;
    setStatus(message);
  },
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const hadController = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) updateBtn.hidden = false;
  });
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker registration failed', err));
}
updateBtn.addEventListener('click', () => location.reload());
