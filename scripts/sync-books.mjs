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

// --- 3. Cover + Readwise link lookup via Open Library ------------------------
// Books imported from Goodreads often aren't attached to Readwise's catalog, so the
// feed gives no link. Readwise resolves readwise.io/books/<ISBN>/ though, so we
// find ISBNs on Open Library and keep the first one Readwise recognises.
async function lookup(title, author, cache) {
  const key = `${title}|${author}`.toLowerCase();
  if (cache[key] && typeof cache[key] === 'object' && cache[key].url) return cache[key];
  const short = title.split(/[:(–—]/)[0].trim();
  let hit = await olSearch(title, author);
  if (!hit.cover && short !== title && short.length > 3) hit = merge(hit, await olSearch(short, author));
  if (!hit.cover && author) hit = merge(hit, await olSearch(short, ''));
  const url = await readwiseUrl(hit.isbns, title, author);
  const result = { cover: hit.cover, url };
  cache[key] = result;
  return result;
}
function merge(a, b) { return { cover: a.cover || b.cover, isbns: [...new Set([...a.isbns, ...b.isbns])] }; }
async function olSearch(title, author) {
  const u = new URL('https://openlibrary.org/search.json');
  u.searchParams.set('title', title);
  if (author) u.searchParams.set('author', author.split(/[,&]| and /)[0]);
  u.searchParams.set('limit', '6');
  u.searchParams.set('fields', 'cover_i,title,isbn');
  const out = { cover: '', isbns: [] };
  try {
    const res = await fetch(u, { headers: { 'User-Agent': 'romanalcocer.com books sync' } });
    if (res.ok) {
      const d = await res.json();
      const docs = d.docs || [];
      const withCover = docs.find((x) => x.cover_i);
      if (withCover) out.cover = `https://covers.openlibrary.org/b/id/${withCover.cover_i}-M.jpg`;
      for (const doc of docs) for (const i of doc.isbn || []) out.isbns.push(i);
    }
  } catch (e) { console.warn('Open Library lookup failed for', title, e.message); }
  return out;
}
async function readwiseUrl(isbns, title, author) {
  // Prefer ISBN-13s; cap attempts so one book can't eat the whole run.
  const sorted = [...new Set(isbns)].sort((a, b) => b.length - a.length).slice(0, 40);
  const want = slugWords(`${author} ${title}`);
  for (const isbn of sorted) {
    try {
      const res = await fetch(`https://readwise.io/books/${isbn}/`, { method: 'HEAD', redirect: 'manual' });
      if (res.status !== 301 && res.status !== 302) continue;
      // Sanity check: the redirect slug should share words with the title/author.
      const got = slugWords(res.headers.get('location') || '');
      const overlap = want.filter((w) => got.includes(w)).length;
      if (overlap >= Math.min(2, want.length)) return `https://readwise.io/books/${isbn}/`;
    } catch {}
  }
  return null;
}
function slugWords(s) {
  return s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 2 && !['the','and','for','with','your'].includes(w));
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
  out.push({
    id: b.id,
    title,
    author,
    cover,
    finished: b.finished_reading_at ? b.finished_reading_at.slice(0, 10) : null,
    rating: b.rating ? Math.round(b.rating) : null,
    review: b.review || null,
    url,
    ...(overrides[b.id] || {}),
  });
}

out.sort((a, b) => (b.finished || '').localeCompare(a.finished || ''));
await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
await writeFile(CACHE, JSON.stringify(cache, null, 2) + '\n');

const withCover = out.filter((b) => b.cover).length;
console.log(`${out.length} books written; ${withCover} with covers (${olHits} via Open Library); ${out.filter((b) => b.url).length} linked to Readwise (${urlHits} via ISBN); ${out.filter((b) => !b.finished).length} undated.`);
