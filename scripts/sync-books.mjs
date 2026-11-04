// Pulls finished books from the Readwise Books public feed into src/data/books.json.
// Run: BOOKS_PUBLIC_TOKEN=... node scripts/sync-books.mjs
// Missing covers are filled from Open Library (cached in src/data/lookup-cache.json).

import { readFile, writeFile } from 'node:fs/promises';

const PROFILE = '344457';
const API = `https://readwise.io/books/api/v1/public/${PROFILE}`;
const TOKEN = process.env.BOOKS_PUBLIC_TOKEN;
if (!TOKEN) { console.error('BOOKS_PUBLIC_TOKEN is not set'); process.exit(1); }

const OUT = new URL('../src/data/books.json', import.meta.url);
const CACHE = new URL('../src/data/lookup-cache.json', import.meta.url);
const EXCLUDE = new URL('../src/data/books-exclude.json', import.meta.url);
const OVERRIDES = new URL('../src/data/books-overrides.json', import.meta.url); // { "<id>": { url?, cover?, title?, author? } }

async function readJson(url, fallback) {
  try { return JSON.parse(await readFile(url, 'utf8')); } catch { return fallback; }
}

// --- 1. Fetch every finished book -------------------------------------------
async function fetchAll() {
  const books = [];
  let cursor = null;
  do {
    const u = new URL(`${API}/books`);
    u.searchParams.set('status', 'finished');
    u.searchParams.set('order', '-finished_reading_at');
    u.searchParams.set('limit', '1000');
    if (cursor) u.searchParams.set('cursor', cursor);
    const res = await fetch(u, { headers: { 'Books-Public-Token': TOKEN } });
    if (!res.ok) throw new Error(`Readwise ${res.status}: ${await res.text()}`);
    const data = await res.json();
    books.push(...data.results);
    cursor = data.next_cursor;
  } while (cursor);
  return books;
}

// --- 2. Clean up Goodreads-style metadata ----------------------------------
function cleanTitle(t) {
  return t
    .replace(/\s*\n\s*/g, ' ')                    // "Red Rising\n  (Saga, #1)"
    .replace(/\s*\((?:[^()]*(?:#\d+|Book \d+|Series|Trilogy|Saga|Edition)[^()]*)\)\s*$/i, '')
    .replace(/\s*\((?:Very Short Introductions|[^()]*Book \d+)\)\s*$/i, '')
    .replace(/:\s*A Novel$/i, '')
    .trim();
}
function cleanAuthor(a) {
  if (!a) return '';
  // "Brown, Pierce" -> "Pierce Brown" (only when a single comma and no "and")
  const m = a.match(/^([^,]+),\s*([^,]+)$/);
  if (m && !/ and |&/.test(a)) return `${m[2].trim()} ${m[1].trim()}`;
  return a.trim();
}

// --- 3. Readwise link + cover lookup --------------------------------------
// Books imported from Goodreads often aren't attached to Readwise's catalog, so the
// feed gives no link or cover. Readwise resolves readwise.io/books/<ISBN>/, so we:
//   1. ask Open Library for ISBNs of editions whose title matches ours,
//   2. try each against Readwise and accept only a redirect whose slug matches the title,
//   3. take the cover from that Readwise page (authoritative), falling back to
//      Open Library's cover for the matching edition, verified to actually download.
const UA = { 'User-Agent': 'romanalcocer.com books sync (+https://romanalcocer.com)' };

async function lookup(title, author, cache) {
  const key = `${title}|${author}`.toLowerCase();
  if (cache[key] && cache[key].v === 4) return cache[key];
  const short = shortTitle(title);
  const full = titleWords(title);
  const authorWords = titleWords(author);

  let docs = await olSearch(title, author);
  if (!docs.length && short !== title) docs = await olSearch(short, author);
  if (!docs.length && author) docs = await olSearch(short, '');
  // ISBNs from every result (the Readwise slug check below guards against wrong books);
  // covers only from editions whose title matches ours.
  const isbns = [...new Set(docs.flatMap((d) => d.isbn || []))].sort((a, b) => b.length - a.length).slice(0, 60);
  docs = docs.filter((d) => matches(full, titleWords(d.title || '')));
  const rw = await readwiseMatch(isbns, full, authorWords);
  let cover = rw?.cover || '';
  if (!cover) {
    const ol = docs.find((d) => d.cover_i);
    if (ol) cover = await verifyImage(`https://covers.openlibrary.org/b/id/${ol.cover_i}-M.jpg`);
  }
  const result = { v: 4, cover, url: rw?.url || null };
  cache[key] = result;
  return result;
}
function shortTitle(t) { return t.split(/[:(–—]/)[0].trim(); }
function titleWords(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ')
    .split(' ').filter((w) => w && !['the','a','an','and','of','for','with','your','to','in','on'].includes(w));
}
// want = our full title's words; got = candidate's words.
// Accept when the candidate covers most of our title, or is wholly contained in it
// (catalog titles often drop subtitles: "Becoming a Supple Leopard" vs our 12-word version).
function matches(want, got) {
  if (!want.length || !got.length) return false;
  const hits = want.filter((w) => got.includes(w)).length;
  const back = got.filter((w) => want.includes(w)).length;
  if (hits / want.length >= 0.6 && back / got.length >= 0.5) return true;
  return back === got.length && (got.length >= 2 || want.length <= 2);
}
async function olSearch(title, author) {
  const u = new URL('https://openlibrary.org/search.json');
  u.searchParams.set('title', title);
  if (author) u.searchParams.set('author', author.split(/[,&]| and /)[0]);
  u.searchParams.set('limit', '8');
  u.searchParams.set('fields', 'cover_i,title,isbn,language');
  try {
    const res = await fetch(u, { headers: UA });
    if (res.ok) {
      const d = await res.json();
      // Prefer English editions so we don't get a German cover for a Murakami.
      const docs = d.docs || [];
      return [...docs.filter((x) => (x.language || []).includes('eng')), ...docs.filter((x) => !(x.language || []).includes('eng'))];
    }
  } catch (e) { console.warn('Open Library lookup failed for', title, e.message); }
  return [];
}
async function readwiseMatch(isbns, want, authorWords) {
  for (const isbn of isbns) {
    try {
      const res = await fetch(`https://readwise.io/books/${isbn}/`, { method: 'HEAD', redirect: 'manual' });
      if (res.status !== 301 && res.status !== 302) continue;
      const loc = res.headers.get('location') || '';
      const slug = loc.split('/').filter(Boolean).slice(-2, -1)[0] || ''; // .../<id>/<author-title-slug>/<isbn>
      const got = titleWords(slug.replace(/-/g, ' ')).filter((w) => !authorWords.includes(w));
      if (!matches(want, got)) continue;
      const cover = await readwiseCover(new URL(loc, 'https://readwise.io/').href);
      return { url: `https://readwise.io/books/${isbn}/`, cover };
    } catch {}
  }
  return null;
}
async function readwiseCover(pageUrl) {
  try {
    const res = await fetch(pageUrl, { headers: UA });
    if (!res.ok) return '';
    const html = await res.text();
    const m = html.match(/product\/cover\/\d+\/[a-z0-9-]+/i);
    return m ? `https://readwise.io/books/${m[0]}?w=320` : '';
  } catch { return ''; }
}
async function resolve(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual' });
    const loc = res.headers.get('location');
    return loc ? new URL(loc, url).href : url;
  } catch { return url; }
}
async function verifyImage(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: UA });
    const len = Number(res.headers.get('content-length') || 0);
    return res.ok && len > 1500 ? url : '';
  } catch { return ''; }
}

// --- main ---------------------------------------------------------------------
const raw = await fetchAll();
const cache = await readJson(CACHE, {});
const exclude = new Set(await readJson(EXCLUDE, []));
const overrides = await readJson(OVERRIDES, {});
const out = [];
let olHits = 0, urlHits = 0;

for (const b of raw) {
  if (exclude.has(b.id)) continue;
  const title = cleanTitle(b.product?.title || b.title);
  const author = cleanAuthor(b.product?.author || b.author);
  let cover = b.product?.cover_url ? `${b.product.cover_url}?w=320` : '';
  let url = b.product?.store_url || null;
  if (!cover || !url) {
    const found = await lookup(title, author, cache);
    if (!cover && found.cover) { cover = found.cover; olHits++; }
    if (!url && found.url) { url = found.url; urlHits++; }
  }
  const ov = overrides[b.id] || {};
  if (ov.url && !ov.cover && !cover) {
    const key = `override:${ov.url}`;
    if (!cache[key]) cache[key] = { v: 4, cover: await readwiseCover(await resolve(ov.url)) };
    cover = cache[key].cover || cover;
  }
  out.push({
    id: b.id,
    title,
    author,
    cover,
    finished: b.finished_reading_at ? b.finished_reading_at.slice(0, 10) : null,
    rating: b.rating ? Math.round(b.rating) : null,
    review: b.review || null,
    url,
    ...ov,
  });
}

out.sort((a, b) => (b.finished || '').localeCompare(a.finished || ''));
await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
await writeFile(CACHE, JSON.stringify(cache, null, 2) + '\n');

const withCover = out.filter((b) => b.cover).length;
console.log(`${out.length} books written; ${withCover} with covers (${olHits} via Open Library); ${out.filter((b) => b.url).length} linked to Readwise (${urlHits} via ISBN); ${out.filter((b) => !b.finished).length} undated.`);
