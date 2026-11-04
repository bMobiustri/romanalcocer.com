// Pulls finished books from the Readwise Books public feed into src/data/books.json.
// Run: BOOKS_PUBLIC_TOKEN=... node scripts/sync-books.mjs
// Missing covers are filled from Open Library (cached in src/data/covers-cache.json).

import { readFile, writeFile } from 'node:fs/promises';

const PROFILE = '344457';
const API = `https://readwise.io/books/api/v1/public/${PROFILE}`;
const TOKEN = process.env.BOOKS_PUBLIC_TOKEN;
if (!TOKEN) { console.error('BOOKS_PUBLIC_TOKEN is not set'); process.exit(1); }

const OUT = new URL('../src/data/books.json', import.meta.url);
const CACHE = new URL('../src/data/covers-cache.json', import.meta.url);
const EXCLUDE = new URL('../src/data/books-exclude.json', import.meta.url);

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

// --- 3. Cover lookup via Open Library ---------------------------------------
async function findCover(title, author, cache) {
  const key = `${title}|${author}`.toLowerCase();
  if (cache[key]) return cache[key];
  let cover = await olSearch(title, author);
  const short = title.split(/[:(–—]/)[0].trim();
  if (!cover && short !== title && short.length > 3) cover = await olSearch(short, author);
  if (!cover && author) cover = await olSearch(short, '');
  cache[key] = cover;
  return cover;
}
async function olSearch(title, author) {
  const u = new URL('https://openlibrary.org/search.json');
  u.searchParams.set('title', title);
  if (author) u.searchParams.set('author', author.split(/[,&]| and /)[0]);
  u.searchParams.set('limit', '3');
  u.searchParams.set('fields', 'cover_i,title');
  let cover = '';
  try {
    const res = await fetch(u, { headers: { 'User-Agent': 'romanalcocer.com books sync' } });
    if (res.ok) {
      const d = await res.json();
      const hit = (d.docs || []).find((x) => x.cover_i);
      if (hit) cover = `https://covers.openlibrary.org/b/id/${hit.cover_i}-M.jpg`;
    }
  } catch (e) { console.warn('Open Library lookup failed for', title, e.message); }
  return cover;
}

// --- main ---------------------------------------------------------------------
const raw = await fetchAll();
const cache = await readJson(CACHE, {});
const exclude = new Set(await readJson(EXCLUDE, []));
const out = [];
let olHits = 0;

for (const b of raw) {
  if (exclude.has(b.id)) continue;
  const title = cleanTitle(b.product?.title || b.title);
  const author = cleanAuthor(b.product?.author || b.author);
  let cover = b.product?.cover_url ? `${b.product.cover_url}?w=320` : '';
  if (!cover) {
    cover = await findCover(title, author, cache);
    if (cover) olHits++;
  }
  out.push({
    id: b.id,
    title,
    author,
    cover,
    finished: b.finished_reading_at ? b.finished_reading_at.slice(0, 10) : null,
    rating: b.rating ? Math.round(b.rating) : null,
    review: b.review || null,
    url: b.product?.store_url || null,
  });
}

out.sort((a, b) => (b.finished || '').localeCompare(a.finished || ''));
await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
await writeFile(CACHE, JSON.stringify(cache, null, 2) + '\n');

const withCover = out.filter((b) => b.cover).length;
console.log(`${out.length} books written; ${withCover} with covers (${olHits} new from Open Library); ${out.filter((b) => !b.finished).length} undated.`);
