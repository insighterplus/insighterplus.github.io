// Insighter+ live-data updater — Node 20, zero dependencies.
// Runs on a GitHub Actions schedule, fetches public data, writes data/live.json.
// No API keys, no Google services, no accounts.
//
// SOURCES (all optional — any failure keeps the last good value, never crashes):
//   Syria parallel USD + gold: sp-today.com (Lira Today, PRIMARY) — cross-checked
//     against Lirascope (lirascope.syria-cloud.sy, NEW domain) + SYPNow (sypnow.com).
//     If the primary disagrees with a cross-check by >0.5%, the primary value is kept
//     but the group is flagged stale and the divergence is recorded in notes.
//     NEVER liratoday.net (stale/wrong figures: 139.50/140.20 on 15 Nov 2026).
//   Official USD: Central Bank of Syria bulletin (cb.gov.sy/fx/4) + homepage ticker.
//     Weekend rule: the Syrian weekend is Fri-Sat — no new bulletin is expected,
//     so a missing bulletin on Fri/Sat is NOT a failure and is NOT flagged stale;
//     the last working-day bulletin stays current. (Verified: bulletins 209 Sun 8 Nov,
//     210 Mon 9 Nov, 211 Tue 10 Nov, 213 Thu 12 Nov; none Fri 13 / Sat 14 Nov.)
//     Full 21-currency table: the CB's official Telegram channel @SyCBOS
//     (t.me/s/SyCBOS — server-rendered HTML, no login, no JS) posts the bulletin
//     daily as an image (~12:30 Damascus on working days). The updater downloads
//     the photo, preprocesses it (grayscale + 3x upscale + threshold, two
//     passes at 55% and 65%), OCRs it with tesseract (eng, --psm 11, TSV
//     word positions), parses the 21 rows by table geometry, repairs
//     single-digit OCR errors against the mid == (buy+sell)/2 identity, and
//     validates them before writing: bulletin number >= stored, OCR date ==
//     message date, USD buy/sell == cb.gov.sy /fx/4 USD row, EUR mid / USD
//     mid == Frankfurter EUR/USD within ~1%, all 21 currencies present,
//     each mid between buy and sell. On ANY failure the last good central
//     table stays untouched. The 10 cross-rate derived rows are never
//     replaced by OCR (the bulletin publishes 21 currencies; the other 10
//     rows keep their crossed central values). JPY + CNY are full table
//     rows: central from the bulletin OCR, parallel crossed from the
//     parallel USD through Frankfurter (JPY quoted per 100 yen).
//     NOTE: tesseract eng+ara --psm 6 was tested and REJECTED — it misreads
//     this image badly (codes garbled, decimal points dropped). Threshold +
//     --psm 11 + TSV positions + two-pass cross-check is what actually works
//     (verified on Bulletin 213: 21/21 rows correct after repair).
//     Facebook route investigated 15 Nov 2026 and REJECTED (login wall +
//     scanned images only, no public text). NEVER liratoday.net or
//     syria-online.net (both proven wrong).
//   Crypto: CoinGecko (Kraken fallback). FX: Frankfurter (ECB) + fixed Gulf pegs.
//   Stocks: Yahoo Finance. Gulf indices: TradingView scanner (DFM:DFMGI, ADX:FADGI),
//     cross-checked against Nukoud (DFM) + Trading Economics (ADX); QSE from Trading
//     Economics ONLY (single source — flagged verified:false); TASI + Brent on Yahoo;
//     the QAT ETF proxy survives only as a nested fallback reference inside the QAT
//     entry. The old UAE ETF proxy key is dropped (it fed both DFM and ADX cards
//     with the same ETF price — a bug).
//   Metals spot: goldprice.dev (PRIMARY; computed_at is the last-update time),
//     xaus.com spot (backup/cross-check, 1% tolerance), Yahoo futures (tertiary only).
//     GC=F / SI=F keys keep their names (the site reads them) but now carry SPOT
//     prices, with `basis` + `source` documenting provenance; full detail under
//     XAU / XAG; 30-day gold candles from xaus history.
//   Fear & Greed: alternative.me. News: BBC Business RSS (headlines + links only).
//   Events: Forex Factory calendar feed (no better free feed exists).
// All lira figures are NEW Syrian pounds (SYP).
//
// Usage: node scripts/update-live-data.mjs
// Reads: data/live.json (previous state) or scripts/seed.json (first run).
// Writes: data/live.json (only if valid and changed) + data/usd-history.json
//   (30-day USD closes, derived from the daily history in live.json).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_PATH = path.join(ROOT, 'data', 'live.json');
const HISTORY_PATH = path.join(ROOT, 'data', 'usd-history.json');
const SEED_PATH = path.join(ROOT, 'scripts', 'seed.json');
const TIMEOUT_MS = 15000;
const UA = 'Mozilla/5.0 (compatible; InsighterPlusBot/1.0; +https://insighterplus.github.io/)';
// HTML scrapers (Lirascope, SYPNow, Trading Economics, Nukoud) get a plain
// browser UA — some of them filter bot user-agents; the JSON APIs use the bot UA.
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ---------------------------------------------------------------- helpers

function log(...args) { console.log(new Date().toISOString(), ...args); }

async function fetchText(url, { retries = 2, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function fetchJSON(url, opts) {
  const text = await fetchText(url, opts);
  return JSON.parse(text);
}

// Binary fetch with the same retry/timeout behaviour (bulletin photos).
async function fetchBinary(url, { retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error(`download too small (${buf.length} bytes)`);
      return buf;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ');
}

function num(value) {
  if (value === null || value === undefined) return null;
  const n = parseFloat(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  if (value === null || value === undefined) return null;
  const p = 10 ** decimals;
  return Math.round(value * p) / p;
}

// Damascus date (Asia/Damascus, UTC+3, no DST in 2026) as YYYY-MM-DD.
function damascusToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Damascus' });
}

// Damascus weekday: 0=Sun .. 6=Sat (Fri=5, Sat=6 is the Syrian weekend).
function damascusWeekday(date = new Date()) {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Damascus', weekday: 'short' }).format(date);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(day);
}

// Relative difference between two values, or null if either is missing.
function relDiff(a, b) {
  if (a === null || a === undefined || b === null || b === undefined || (a + b) === 0) return null;
  return Math.abs(a - b) / ((a + b) / 2);
}

// 9667.38 -> "9,667.38" (for matching Trading Economics display rows).
function fmt2(v) {
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------- sources

const SOURCES = {}; // name -> { status: 'ok'|'stale'|'failed', fetched_at, error?, note? }
function markSource(name, status, error, note) {
  SOURCES[name] = {
    status,
    fetched_at: new Date().toISOString(),
    ...(error ? { error: String(error).slice(0, 200) } : {}),
    ...(note ? { note: String(note).slice(0, 300) } : {}),
  };
}

// --- Syria: parallel rates + gold from sp-today.com (Lira Today) ---------
// Homepage: USD buy/sell, gold 21k/24k/18k buy/sell, gold + silver ounce.
// /currencies: buy/sell for all 30 currencies vs the new Syrian pound.

const PARALLEL_CODES = ['USD', 'EUR', 'TRY', 'SAR', 'AED', 'EGP', 'LYD', 'JOD', 'KWD', 'GBP', 'QAR', 'BHD', 'SEK', 'CAD', 'OMR', 'NOK', 'DKK', 'DZD', 'MAD', 'TND', 'RUB', 'MYR', 'BRL', 'NZD', 'CHF', 'AUD', 'ZAR', 'SGD'];

// Parse the USD city series out of sp-today's embedded Next.js Flight payload.
// Returns { damascus: {buy, sell, change, prev_close, day_high, day_low,
// change_week, change_month, change_year}, alhasakah: {...} } in NEW SYP,
// or null when the payload is absent/unparseable. Throws only on structural
// surprises inside a payload that was found (caller treats as soft failure).
function parseSpTodayCities(html) {
  const chunkRe = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let m;
  while ((m = chunkRe.exec(html)) !== null) {
    let inner;
    try { inner = JSON.parse('"' + m[1] + '"'); } catch { continue; }
    if (!inner.includes('damascus') || !inner.includes('"rates"')) continue;
    const start = inner.indexOf('{"lang"');
    if (start < 0) continue;
    let depth = 0;
    for (let k = start; k < inner.length; k++) {
      if (inner[k] === '{') depth++;
      else if (inner[k] === '}') {
        depth--;
        if (depth === 0) {
          const obj = JSON.parse(inner.slice(start, k + 1));
          const rates = obj && obj.data && obj.data.rates;
          if (!Array.isArray(rates)) return null;
          const usd = rates.find((r) => r && r.code === 'USD');
          if (!usd || !usd.cities) return null;
          const out = {};
          for (const [slug, c] of Object.entries(usd.cities)) {
            if (!c || typeof c.buy !== 'number' || typeof c.sell !== 'number') continue;
            out[slug] = {
              buy: round(c.buy / 100, 2),
              sell: round(c.sell / 100, 2),
              change: typeof c.change === 'number' ? c.change : null,
              prev_close: typeof c.prev_close === 'number' ? round(c.prev_close / 100, 2) : null,
              day_high: typeof c.day_high === 'number' ? round(c.day_high / 100, 2) : null,
              day_low: typeof c.day_low === 'number' ? round(c.day_low / 100, 2) : null,
              change_week: typeof c.change_week === 'number' ? c.change_week : null,
              change_month: typeof c.change_month === 'number' ? c.change_month : null,
              change_year: typeof c.change_year === 'number' ? c.change_year : null,
            };
          }
          return Object.keys(out).length ? out : null;
        }
      }
    }
    return null;
  }
  return null;
}

async function fetchSpToday() {
  const homeHtml = await fetchText('https://sp-today.com/');
  const home = stripTags(homeHtml);
  const all = stripTags(await fetchText('https://sp-today.com/currencies'));

  // Parallel rates (incl. USD) come from /currencies, where every row has the
  // same clean shape: "USD USD دولار أمريكي 148.75 14,875 قديمة 149.50 ...".
  // (The homepage hero inserts extra words between the name and the numbers.)
  const parallel = {};
  for (const code of PARALLEL_CODES) {
    const m = all.match(new RegExp(`${code} ${code} [^0-9]+?([\\d,]+\\.?\\d*)\\s+[\\d,]+\\s*قديمة\\s+([\\d,]+\\.?\\d*)`));
    if (!m) continue;
    const buy = num(m[1]);
    const sell = num(m[2]);
    if (buy && sell) parallel[code] = { buy, sell };
  }
  if (Object.keys(parallel).length < 20) throw new Error(`only ${Object.keys(parallel).length} parallel rates parsed`);
  if (!parallel.USD) throw new Error('USD row not found on sp-today /currencies');
  const parallelUSD = parallel.USD;

  const gold = {};
  for (const [key, karat] of [['gold24k', '24K'], ['gold21k', '21K'], ['gold18k', '18K'], ['gold14k', '14K']]) {
    const m = home.match(new RegExp(`${karat}\\s+\\$([\\d,]+\\.?\\d*)\\s+([\\d,]+\\.?\\d*)\\s+([\\d,]+\\.?\\d*)`));
    if (m) gold[key] = { usd_per_gram: num(m[1]), buy: num(m[2]), sell: num(m[3]) };
  }
  if (!gold.gold21k) throw new Error('gold 21k not found on sp-today home');

  const ounce = home.match(/أونصة الذهب\s+\$([\d,]+\.?\d*)/);
  const silverOunce = home.match(/أونصة الفضة\s+\$\s*([\d,]+\.?\d*)/);

  // USD by city (Damascus + Hasakah): sp-today embeds a Next.js Flight payload
  // (self.__next_f) carrying a `rates` array; each currency has per-city
  // buy/sell in OLD SYP (÷100 -> new SYP) plus change/week/month/year stats.
  // Soft failure: cities are extra data — a parse failure must never fail
  // the whole sp-today fetch (the primary USD + gold above still stand).
  let cities = null;
  try { cities = parseSpTodayCities(homeHtml); }
  catch (e) { log(`WARN: sp-today cities parse failed (${e.message}) — keeping last good cities`); }

  return { parallelUSD, gold, goldOunceUSD: ounce ? num(ounce[1]) : null, silverOunceUSD: silverOunce ? num(silverOunce[1]) : null, parallel, cities };
}

// --- Syria: Lirascope (NEW domain) — co-primary + cross-check ------------------
// https://lirascope.syria-cloud.sy/en embeds a structured `marketRates` JSON array
// (29 currencies, buy/sell/mid + timestampUtc). Bound the slice at the
// `effectiveRates` marker so the same currencies are not matched twice.
// Fallback for USD: the visible hero Buy/Sell cards. Gold page gives a single
// 21k MID price (no buy/sell spread), used for cross-checking only.
async function fetchLirascope() {
  const html = await fetchText('https://lirascope.syria-cloud.sy/en', { headers: { 'User-Agent': BROWSER_UA } });
  let usd = null;
  let table = {};
  const marker = '\\"marketRates\\":[';
  const start = html.indexOf(marker);
  if (start >= 0) {
    const endMarker = html.indexOf('\\"effectiveRates\\":', start);
    const slice = html.slice(start, endMarker > start ? endMarker : start + 15000);
    const usdMatch = slice.match(/\\"currency\\":\\"USD\\",\\"buy\\":([\d.]+),\\"sell\\":([\d.]+),\\"mid\\":([\d.]+),\\"timestampUtc\\":\\"([^\\]+)\\"/);
    if (usdMatch) {
      usd = { buy: num(usdMatch[1]), sell: num(usdMatch[2]), mid: num(usdMatch[3]), asOf: usdMatch[4] };
    }
    for (const m of slice.matchAll(/\\"currency\\":\\"([A-Z]{3})\\",\\"buy\\":([\d.]+),\\"sell\\":([\d.]+)/g)) {
      const buy = num(m[2]); const sell = num(m[3]);
      if (buy && sell) table[m[1]] = { buy, sell };
    }
  }
  if (!usd || !usd.buy || !usd.sell) {
    const buyM = html.match(/>Buy<\/div><div class="nums[^>]*>([\d,.]+)<\/div>/);
    const sellM = html.match(/>Sell<\/div><div class="nums[^>]*>([\d,.]+)<\/div>/);
    if (buyM && sellM) usd = { buy: num(buyM[1]), sell: num(sellM[1]) };
  }
  if (!usd || !usd.buy || !usd.sell) throw new Error('Lirascope USD not found');
  if (Object.keys(table).length < 20) table = null; // table is a bonus; USD is the requirement
  const goldHtml = await fetchText('https://lirascope.syria-cloud.sy/en/gold', { headers: { 'User-Agent': BROWSER_UA } });
  let gold21kMid = null;
  const big = goldHtml.match(/scope-big nums">([\d,]+)<\/span>/);
  if (big) gold21kMid = num(big[1]);
  if (!gold21kMid) {
    const title = goldHtml.match(/21k Gram ([\d,]+) SYP/);
    if (title) gold21kMid = num(title[1]);
  }
  return { usd, table, gold21kMid };
}

// --- Syria: SYPNow — second backup + cross-check -------------------------------
// https://sypnow.com/en/currency/usd has labeled Buy/Sell Price cards; the gold
// page gives a single 21k mid price (cross-check only).
async function fetchSYPNow() {
  const html = await fetchText('https://sypnow.com/en/currency/usd', { headers: { 'User-Agent': BROWSER_UA } });
  const buyM = html.match(/Buy Price<\/div><div[^>]*>([\d,.]+)/);
  const sellM = html.match(/Sell Price<\/div><div[^>]*>([\d,.]+)/);
  if (!buyM || !sellM) throw new Error('SYPNow USD buy/sell not found');
  const usd = { buy: num(buyM[1]), sell: num(sellM[1]) };
  if (!usd.buy || !usd.sell) throw new Error('SYPNow USD values invalid');
  const goldHtml = await fetchText('https://sypnow.com/en/gold', { headers: { 'User-Agent': BROWSER_UA } });
  let gold21kMid = null;
  const g = goldHtml.match(/one gram of 21K gold<\/h2><p[^>]*>([\d,.]+)/);
  if (g) gold21kMid = num(g[1]);
  return { usd, gold21kMid };
}

// --- Central Bank of Syria: official bulletin USD + ticker mids -----------
async function fetchCentralBank() {
  const fxPage = stripTags(await fetchText('https://cb.gov.sy/fx/4'));
  const row = fxPage.match(/(\d{4}-\d{2}-\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+عرض الملف/);
  if (!row) throw new Error('bulletin table row not found');
  const bulletin = { date: row[1], usd_sell: num(row[2]), usd_buy: num(row[3]) };

  const home = stripTags(await fetchText('https://cb.gov.sy/'));
  const ticker = home.match(/الأسعار حسب النشرة الرسمية \(الليرة الجديدة\)\s+(\d{4}-\d{2}-\d{2})\s+((?:[A-Z]{3}\s+[\d,]+\.?\d*\s*)+)/);
  const mids = {};
  let tickerDate = null;
  if (ticker) {
    tickerDate = ticker[1];
    for (const [, code, value] of ticker[2].matchAll(/([A-Z]{3})\s+([\d,]+\.?\d*)/g)) {
      const v = num(value);
      if (v) mids[code] = v;
    }
  }
  return { bulletin, tickerDate, mids };
}

// --- Central Bank bulletin: FULL 21-currency table via Telegram OCR --------
// The CB's official Telegram channel @SyCBOS (t.me/s/SyCBOS) posts the daily
// bulletin as an image. The public channel page is server-rendered HTML — no
// login, no JS. Pipeline: find the latest message containing the bulletin
// phrase -> extract its date + photo URL -> download -> preprocess
// (grayscale + 3x upscale + threshold) -> OCR (tesseract eng, --psm 11, TSV
// output for word positions) -> parse rows by table geometry -> repair
// single-digit OCR errors -> validate -> merge.
// WHY THIS SHAPE (verified by direct testing 15 Nov 2026, Bulletin 213):
// tesseract eng+ara --psm 6 FAILS badly on this image (codes misread,
// decimal points dropped, digits wrong) — the table grid lines destroy its
// line segmentation. Threshold + --psm 11 (sparse text) reads it nearly
// perfectly, and TSV positions let the parser assign words to table cells
// (name | code | mid | sell | buy) instead of trusting text order. Two
// threshold passes (55% + 65%) cross-check each other: each fixes digit
// errors the other makes (e.g. GBP sell 162.63 at 55% vs correct 162.69
// at 65%). English currency NAMES identify rows (codes misread: CAD once
// read as "CAO", DKK as "OKK"). Decimal points sometimes split ("316 88")
// — adjacent number fragments in one cell are joined with a dot.
// REPAIR: every bulletin row satisfies mid == (buy + sell) / 2 within 0.01
// (verified on all 21 rows of Bulletin 213 — max deviation 0.005). A row
// failing that identity is repaired by single-digit edits (substitute /
// delete / insert); candidates must satisfy the identity, and the winner is
// nearest to the stored row (bulletins move slowly), tie-broken by repairing
// the least-confident word. An unrepairable row rejects the whole bulletin.
// Bulletin column order: mid, sell, buy (الوسطي، المبيع، الشراء). JPY is per
// 100 yen. Verified end-to-end 15 Nov 2026 (Bulletin 213, 12/11/2026).
const TG_CHANNEL = 'https://t.me/s/SyCBOS';
const BULLETIN_CODES = ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'TRY', 'SAR', 'QAR', 'AED', 'KWD', 'OMR', 'JOD', 'EGP', 'CHF', 'CAD', 'DKK', 'SEK', 'NOK', 'AUD', 'RUB', 'BHD'];
const BULLETIN_PHRASE = 'النشرة الرسمية لأسعار الصرف';
// English currency names (left table column) -> code. Names OCR far more
// reliably than the 3-letter codes, so the name is the primary row
// identifier and the code only a fallback.
const BULLETIN_NAMES = {
  USDOLLAR: 'USD', EURO: 'EUR', STERLINGPOUND: 'GBP', JAPANESEYEN: 'JPY',
  CHINESEYUAN: 'CNY', TURKISHLIRA: 'TRY', SAUDIRIYAL: 'SAR', QATARIRIYAL: 'QAR',
  UAEDIRHAM: 'AED', KUWAITIDINAR: 'KWD', BAHRAINIDINAR: 'BHD', OMANIRIYAL: 'OMR',
  JORDANIANDINAR: 'JOD', EGYPTIANPOUND: 'EGP', SWISSFRANC: 'CHF', CANADIANDOLLAR: 'CAD',
  DANISHKRONE: 'DKK', SWEDISHKRONA: 'SEK', NORWEGIANKRONE: 'NOK', AUSTRALIANDOLLAR: 'AUD',
  RUSSIANRUBLE: 'RUB',
};
// Number-column x-ranges as fractions of the page width (the bulletin
// template is fixed: name | code | mid | sell | buy | Arabic name).
const NUM_COLS = [
  { key: 'mid', lo: 0.365, hi: 0.52 },
  { key: 'sell', lo: 0.52, hi: 0.677 },
  { key: 'buy', lo: 0.677, hi: 0.8125 },
];
const NAME_HI = 0.26; // name column ends here (fraction of page width)
const CODE_LO = 0.26, CODE_HI = 0.365; // code column

async function fetchTelegramBulletin() {
  let before = null;
  for (let page = 0; page < 3; page++) {
    const url = before ? `${TG_CHANNEL}?before=${before}` : TG_CHANNEL;
    const html = await fetchText(url, { headers: { 'User-Agent': BROWSER_UA } });
    // Slice the page at each message marker; messages run oldest-first, so
    // walk the slices newest-first (reverse) and take the first bulletin.
    const markers = [...html.matchAll(/data-post="SyCBOS\/(\d+)"/g)];
    if (markers.length === 0) throw new Error('no Telegram messages found on channel page');
    let oldestId = null;
    for (let i = markers.length - 1; i >= 0; i--) {
      const id = markers[i][1];
      if (oldestId === null || Number(id) < Number(oldestId)) oldestId = id;
      const start = markers[i].index;
      const end = i + 1 < markers.length ? markers[i + 1].index : html.length;
      const slice = html.slice(start, end);
      if (!slice.includes(BULLETIN_PHRASE)) continue;
      const photo = slice.match(/tgme_widget_message_photo_wrap[^>]*style="[^"]*background-image:url\('([^']+)'\)/);
      if (!photo) continue; // bulletin text without a photo is useless for OCR
      const dateM = slice.match(/التاريخ:(?:\s|&nbsp;|&#160;)*(\d{2})\/(\d{2})\/(\d{4})/);
      let bulletinDate = null;
      if (dateM) bulletinDate = `${dateM[3]}-${dateM[2]}-${dateM[1]}`;
      if (!bulletinDate) {
        // Fallback: the message's own post date (Damascus day).
        const timeM = slice.match(/<time datetime="([^"]+)"/);
        if (timeM) bulletinDate = new Date(timeM[1]).toLocaleDateString('en-CA', { timeZone: 'Asia/Damascus' });
      }
      if (!bulletinDate) throw new Error(`bulletin message ${id} has no usable date`);
      return { messageId: id, bulletinDate, photoUrl: photo[1].replace(/&amp;/g, '&') };
    }
    // No bulletin with a photo on this page — page back to older messages.
    before = oldestId;
  }
  throw new Error('no bulletin message with a photo found on the Telegram channel (3 pages)');
}

// OCR the bulletin photo with TWO threshold passes (55% + 65%) and merge
// them. Each pass: ImageMagick grayscale + 3x upscale + threshold, then
// tesseract (eng, --psm 11, TSV output for word positions). The two passes
// cross-check each other — each fixes digit errors the other makes.
// `storedRows` (code -> {mid, sell, buy} from the last good table) guides
// the repair of misread rows; may be null. Returns
// { bulletinNo, date, rows, repaired } where rows maps code -> {mid,sell,buy}
// and repaired lists the codes that needed a repair. Throws if no pass
// produces usable output. Temp files live in a throwaway dir that is always
// cleaned up.
async function ocrTelegramBulletin(photoUrl, storedRows) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-bulletin-'));
  try {
    const rawPath = path.join(tmpDir, 'bulletin.jpg');
    fs.writeFileSync(rawPath, await fetchBinary(photoUrl));
    const passes = [];
    for (const threshold of [55, 65]) {
      const prepPath = path.join(tmpDir, `bulletin-t${threshold}.png`);
      try {
        await execFileAsync('convert', [rawPath, '-colorspace', 'Gray', '-resize', '300%', '-threshold', `${threshold}%`, prepPath], { timeout: 60000 });
      } catch (e) {
        log(`WARN: bulletin preprocessing (${threshold}%) failed (${e.message}) — skipping this pass`);
        continue;
      }
      let tsv;
      try {
        ({ stdout: tsv } = await execFileAsync('tesseract', [prepPath, 'stdout', '-l', 'eng', '--psm', '11', 'tsv'], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }));
      } catch (e) {
        log(`WARN: bulletin OCR (${threshold}%) failed (${e.message}) — skipping this pass`);
        continue;
      }
      if (!tsv || tsv.trim().length < 100) {
        log(`WARN: bulletin OCR (${threshold}%) returned too little text — skipping this pass`);
        continue;
      }
      try {
        passes.push(parseBulletinTsv(tsv));
      } catch (e) {
        log(`WARN: bulletin TSV parse (${threshold}%) failed (${e.message}) — skipping this pass`);
      }
    }
    if (passes.length === 0) throw new Error('both OCR passes failed');
    return mergeBulletinPasses(passes, storedRows);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Parse one tesseract TSV pass into { bulletinNo, date, rows }. Rows are
// found by table geometry: words are clustered into rows by y-centre, the
// currency is identified by its English name (code as fallback), and the
// three numbers are assigned to the mid/sell/buy columns by x-position.
// A decimal point OCR'd as a space ("316 88") appears as two adjacent
// number words in one cell — they are joined with a dot.
function parseBulletinTsv(tsv) {
  const words = [];
  let pageW = 0, pageH = 0;
  for (const line of tsv.split('\n')) {
    if (!line || line.startsWith('level\t')) continue;
    const c = line.split('\t');
    if (c.length < 12) continue;
    if (Number(c[0]) === 1) { pageW = Number(c[8]); pageH = Number(c[9]); continue; }
    if (Number(c[0]) !== 5) continue;
    const text = (c[11] || '').trim();
    if (!text) continue;
    words.push({ x: Number(c[6]), y: Number(c[7]), w: Number(c[8]), h: Number(c[9]), conf: Number(c[10]), text });
  }
  if (!pageW || words.length === 0) throw new Error('empty TSV output');
  // Bulletin number + date from the header words.
  let bulletinNo = null;
  let date = null;
  for (let i = 0; i < words.length; i++) {
    if (words[i].text.toUpperCase().startsWith('BULLETIN') && bulletinNo === null) {
      for (let j = i; j < Math.min(i + 6, words.length); j++) {
        const m = words[j].text.match(/(\d{2,4})/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n >= 100 && n <= 9999) { bulletinNo = n; break; }
        }
      }
    }
    if (!date) {
      const dm = words[i].text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (dm) date = `${dm[3]}-${dm[2]}-${dm[1]}`;
    }
  }
  // Cluster words into rows by y-centre (row height is ~1/32 of page height).
  const tol = Math.max(12, pageH * 0.0125);
  const sorted = [...words].sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
  const clusters = [];
  for (const w of sorted) {
    const yc = w.y + w.h / 2;
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(yc - last.yc) <= tol) {
      last.words.push(w);
      last.yc = (last.yc * (last.words.length - 1) + yc) / last.words.length;
    } else {
      clusters.push({ yc, words: [w] });
    }
  }
  const rows = {};
  for (const cl of clusters) {
    const ws = [...cl.words].sort((a, b) => a.x - b.x);
    const nameText = ws.filter(w => w.x / pageW < NAME_HI).map(w => w.text).join('').replace(/[^A-Za-z]/g, '').toUpperCase();
    let code = BULLETIN_NAMES[nameText] || null;
    if (!code) {
      const cw = ws.find(w => w.x / pageW >= CODE_LO && w.x / pageW < CODE_HI && BULLETIN_CODES.includes(w.text.toUpperCase()));
      if (cw) code = cw.text.toUpperCase();
    }
    if (!code) continue;
    const vals = {};
    const confs = {};
    let complete = true;
    for (const col of NUM_COLS) {
      const nums = ws.filter(w => w.x / pageW >= col.lo && w.x / pageW < col.hi && /^\d+(\.\d+)?$/.test(w.text));
      if (nums.length === 0) { complete = false; break; }
      nums.sort((a, b) => a.x - b.x);
      const joined = nums.length === 1 ? nums[0].text : nums[0].text + '.' + nums.slice(1).map(n => n.text).join('');
      const v = num(joined);
      if (v === null || v <= 0) { complete = false; break; }
      vals[col.key] = v;
      confs[col.key] = Math.min(...nums.map(n => n.conf));
    }
    if (!complete) continue;
    rows[code] = { ...vals, _conf: confs };
  }
  return { bulletinNo, date, rows };
}

// Every bulletin row satisfies mid == (buy + sell) / 2 within 0.01 (verified
// on all 21 rows of Bulletin 213 — max deviation 0.005). This identity is
// the repair oracle: a misread row fails it, and a correct repair restores it.
function midConsistent(v) {
  return Math.abs(v.mid - (v.buy + v.sell) / 2) <= 0.01;
}

function rowDistanceToStored(v, stored) {
  if (!stored) return 0;
  return Math.abs(v.mid - stored.mid) + Math.abs(v.sell - stored.sell) + Math.abs(v.buy - stored.buy);
}

// Repair a row that fails the mid-average identity by single-digit edits
// (substitute / delete / insert one digit in one of the three numbers).
// A candidate must satisfy the identity; the winner is nearest to the stored
// row (bulletins move slowly), tie-broken by repairing the least-confident
// word. Returns the repaired row or null.
function repairBulletinRow(v, stored) {
  const fields = ['mid', 'sell', 'buy'];
  const candidates = [];
  for (const f of fields) {
    const s = v[f].toFixed(2);
    const digitIdx = [...s].map((ch, i) => (/\d/.test(ch) ? i : -1)).filter(i => i >= 0);
    const edits = [];
    for (const i of digitIdx) {
      for (const d of '0123456789') {
        if (s[i] === d) continue;
        edits.push(s.slice(0, i) + d + s.slice(i + 1));
      }
      edits.push(s.slice(0, i) + s.slice(i + 1)); // deletion
    }
    for (let i = 0; i <= s.length; i++) {
      if (i > 0 && s[i - 1] === '.') continue;
      for (const d of '0123456789') edits.push(s.slice(0, i) + d + s.slice(i)); // insertion
    }
    for (const cand of edits) {
      if (!/^\d+\.\d{2}$/.test(cand)) continue;
      const nv = { ...v, [f]: parseFloat(cand) };
      if (nv[f] <= 0) continue;
      if (!midConsistent(nv)) continue;
      candidates.push({ row: nv, dist: rowDistanceToStored(nv, stored), conf: (v._conf && v._conf[f]) ?? 100 });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.dist - b.dist) || (a.conf - b.conf));
  return candidates[0].row;
}

// Merge the two threshold passes. A row both passes agree on is accepted; a
// row they disagree on takes the clean (unrepaired) reading if there is one,
// else the reading nearest to the stored row; a row only one pass read is
// accepted if it passes the mid-average identity (after repair). Bulletin
// number/date come from the first pass that found them.
function mergeBulletinPasses(passes, storedRows) {
  const bulletinNo = passes.map(p => p.bulletinNo).find(n => n !== null && n !== undefined) ?? null;
  const date = passes.map(p => p.date).find(d => d) ?? null;
  const rows = {};
  const repaired = [];
  for (const code of BULLETIN_CODES) {
    const stored = storedRows ? storedRows[code] : null;
    const readings = passes.map(p => p.rows[code]).filter(Boolean);
    if (readings.length === 0) continue;
    const fixed = [];
    for (const r of readings) {
      if (midConsistent(r)) { fixed.push({ row: r, repaired: false }); continue; }
      const rep = repairBulletinRow(r, stored);
      if (rep) { fixed.push({ row: rep, repaired: true }); repaired.push(code); }
    }
    if (fixed.length === 0) continue; // unrepairable in both passes
    if (fixed.length === 1) { rows[code] = stripConf(fixed[0].row); continue; }
    const [a, b] = fixed;
    const agree = ['mid', 'sell', 'buy'].every(k => Math.abs(a.row[k] - b.row[k]) <= 0.005);
    if (agree) { rows[code] = stripConf(a.row); continue; }
    if (a.repaired !== b.repaired) {
      rows[code] = stripConf(a.repaired ? b.row : a.row);
      log(`CB bulletin OCR: ${code} disagrees between passes — took the clean (unrepaired) reading`);
    } else {
      const pick = rowDistanceToStored(a.row, stored) <= rowDistanceToStored(b.row, stored) ? a : b;
      rows[code] = stripConf(pick.row);
      log(`CB bulletin OCR: ${code} disagrees between passes — took the reading nearest to stored`);
    }
  }
  return { bulletinNo, date, rows, repaired: [...new Set(repaired)] };
}

function stripConf(row) {
  const { _conf, ...rest } = row;
  return rest;
}

// Zero-errors validation for an OCR'd bulletin. Returns a list of problems
// (empty = valid). The USD row is checked against cb.gov.sy /fx/4 and the
// EUR/USD cross against Frankfurter; if BOTH independent cross-checks are
// unavailable, the bulletin is rejected — an OCR result must never be written
// without at least one outside confirmation.
function validateBulletinOCR(parsed, { storedNo, messageDate, cbUsd, eurUsd }) {
  const problems = [];
  if (!parsed.bulletinNo) problems.push('no bulletin number in OCR');
  else if (storedNo && parsed.bulletinNo < storedNo) problems.push(`bulletin ${parsed.bulletinNo} older than stored ${storedNo}`);
  if (!parsed.date) problems.push('no date in OCR');
  else if (messageDate && parsed.date !== messageDate) problems.push(`OCR date ${parsed.date} != message date ${messageDate}`);
  const missing = BULLETIN_CODES.filter((c) => !parsed.rows[c]);
  if (missing.length > 0) problems.push(`missing currencies: ${missing.join(', ')}`);
  for (const [code, r] of Object.entries(parsed.rows)) {
    if (!(r.buy - 0.02 <= r.mid && r.mid <= r.sell + 0.02)) {
      problems.push(`${code} mid ${r.mid} not between buy ${r.buy} and sell ${r.sell}`);
    }
    // Defense in depth: the repair stage guarantees this, but a row that
    // somehow fails the mid-average identity must never be written.
    if (!midConsistent(r)) {
      problems.push(`${code} mid ${r.mid} != average of buy ${r.buy} and sell ${r.sell}`);
    }
  }
  let crossChecked = false;
  if (cbUsd && parsed.rows.USD) {
    crossChecked = true;
    const dBuy = relDiff(parsed.rows.USD.buy, cbUsd.usd_buy);
    const dSell = relDiff(parsed.rows.USD.sell, cbUsd.usd_sell);
    if (dBuy === null || dBuy > 0.001 || dSell === null || dSell > 0.001) {
      problems.push(`USD mismatch vs cb.gov.sy: OCR ${parsed.rows.USD.buy}/${parsed.rows.USD.sell} vs site ${cbUsd.usd_buy}/${cbUsd.usd_sell}`);
    }
  }
  if (eurUsd && parsed.rows.EUR && parsed.rows.USD) {
    crossChecked = true;
    const cross = parsed.rows.EUR.mid / parsed.rows.USD.mid;
    const d = relDiff(cross, eurUsd);
    if (d === null || d > 0.01) {
      problems.push(`EUR/USD cross ${round(cross, 4)} vs Frankfurter ${round(eurUsd, 4)} (diff ${d !== null ? `${(d * 100).toFixed(2)}%` : 'n/a'})`);
    }
  }
  if (!crossChecked) problems.push('no independent cross-check available (cb.gov.sy + Frankfurter both down)');
  return problems;
}

// --- Crypto: CoinGecko (primary), Kraken fallback for BTC/ETH ------------
const COINS = [
  ['bitcoin', 'BTC', 'Bitcoin'],
  ['ethereum', 'ETH', 'Ethereum'],
  ['solana', 'SOL', 'Solana'],
  ['ripple', 'XRP', 'XRP'],
  ['binancecoin', 'BNB', 'BNB'],
  ['dogecoin', 'DOGE', 'Dogecoin'],
  ['cardano', 'ADA', 'Cardano'],
];

async function fetchCrypto() {
  const ids = COINS.map(([id]) => id).join(',');
  const data = await fetchJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
  const out = {};
  for (const [id, symbol, name] of COINS) {
    const row = data[id];
    if (row && num(row.usd)) out[symbol] = { name, price: num(row.usd), change_24h: round(num(row.usd_24h_change), 2) };
  }
  if (!out.BTC || !out.ETH) throw new Error('CoinGecko missing BTC/ETH');
  return out;
}

async function fetchCryptoKrakenFallback() {
  const data = await fetchJSON('https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD');
  const out = {};
  const map = { XXBTZUSD: ['BTC', 'Bitcoin'], XETHZUSD: ['ETH', 'Ethereum'] };
  for (const [pair, [symbol, name]] of Object.entries(map)) {
    const row = data.result && data.result[pair];
    if (!row) continue;
    const price = num(row.c && row.c[0]);
    const open = num(row.o);
    out[symbol] = { name, price, change_24h: price && open ? round(((price - open) / open) * 100, 2) : null };
  }
  if (!out.BTC) throw new Error('Kraken fallback failed');
  return out;
}

// --- FX: Frankfurter (ECB) + fixed Gulf pegs ------------------------------
async function fetchFX() {
  const data = await fetchJSON('https://api.frankfurter.app/latest?from=USD');
  if (!data.rates || !data.rates.EUR) throw new Error('Frankfurter rates missing');
  return { date: data.date, rates: data.rates };
}

// Cached Frankfurter fetch: the CB OCR validation needs EUR/USD before the
// FX section runs; the FX section then reuses the same response instead of
// fetching twice. A failed fetch is never cached (the FX section retries).
let fxCache = null;
async function fetchFXCached() {
  if (!fxCache) fxCache = await fetchFX();
  return fxCache;
}

// Run timestamp (same value main() uses for live.fetched_at, evaluated at
// script start) — fallback for provider timestamps that are missing.
const RUN_STARTED_AT = new Date().toISOString();

// --- Yahoo Finance chart (stocks, indices, oil, ETF proxy) ----------------
// Normalise a history date to ISO (old entries are "12 Nov 2026", new ones
// are already "2026-11-15"). Returns null when unparseable.
function toISODate(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = String(s).match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return null;
  const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const mm = months[m[2]];
  if (!mm) return null;
  return `${m[3]}-${mm}-${String(m[1]).padStart(2, '0')}`;
}

// --- Yahoo Finance chart history (1 month, for sparklines) ------------------
// Same quote fields as fetchYahoo, plus a `spark` array of daily closes
// (null when fewer than 2 closes exist — the site then renders no sparkline).
async function fetchYahooHistory(symbol) {
  const data = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`);
  const result = data.chart && data.chart.result && data.chart.result[0];
  if (!result) throw new Error(`Yahoo: no data for ${symbol}`);
  const meta = result.meta;
  const closes = ((result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || []).filter((v) => typeof v === 'number' && isFinite(v));
  const price = num(meta.regularMarketPrice);
  const previousClose = num(meta.chartPreviousClose || meta.previousClose);
  const lastClose = closes.length ? closes[closes.length - 1] : null;
  const prevClose = closes.length > 1 ? closes[closes.length - 2] : previousClose;
  const pct = num(meta.regularMarketChangePercent);
  return {
    symbol: meta.symbol,
    price: price !== null ? price : lastClose,
    change: (price !== null && previousClose !== null) ? round(price - previousClose, 2) : ((lastClose !== null && prevClose !== null) ? round(lastClose - prevClose, 2) : null),
    change_pct: pct !== null ? round(pct, 2) : ((lastClose !== null && prevClose) ? round((lastClose - prevClose) / prevClose * 100, 2) : null),
    previous_close: previousClose !== null ? previousClose : prevClose,
    currency: meta.currency || 'USD',
    asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : RUN_STARTED_AT,
    spark: closes.length >= 2 ? closes.map((v) => round(v, 2)) : null,
  };
}

async function fetchYahoo(symbol) {
  const data = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`);
  const result = data.chart && data.chart.result && data.chart.result[0];
  if (!result) throw new Error(`Yahoo: no data for ${symbol}`);
  const meta = result.meta;
  const price = num(meta.regularMarketPrice);
  const previousClose = num(meta.chartPreviousClose || meta.previousClose);
  return {
    symbol: meta.symbol,
    price,
    change: (price === null || previousClose === null) ? null : round(price - previousClose, 2),
    change_pct: round(num(meta.regularMarketChangePercent), 2),
    previous_close: previousClose,
    currency: meta.currency || 'USD',
    asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : RUN_STARTED_AT,
  };
}

const YAHOO_STOCKS = ['^GSPC', '^NDX', '^DJI', 'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'TSLA', 'META', 'AMD', 'AVGO', 'DX-Y.NYB', '^FTSE', '^GDAXI', '^N225', '^FCHI', '000001.SS', '^HSI', '000300.SS'];

// --- Gulf: TradingView scanner (keyless JSON) — REAL DFM/ADX indices ------
// GET /symbol?symbol=DFM:DFMGI&fields=close,change,change_abs,description
// Verified 15 Nov 2026: DFM 6,197.88 (= Nukoud), ADX 9,667.38 (= Trading Economics).
async function fetchTradingView(symbol) {
  const data = await fetchJSON(`https://scanner.tradingview.com/symbol?symbol=${encodeURIComponent(symbol)}&fields=close,change,change_abs,description`);
  const price = num(data.close);
  if (!price) throw new Error(`TradingView: no close for ${symbol}`);
  const changePct = round(num(data.change), 2);
  const changeAbs = round(num(data.change_abs), 2); // rounded: TV returns raw floats (e.g. -36.970000000000255)
  return {
    price,
    change_pct: changePct,
    change_abs: changeAbs,
    previous_close: changeAbs !== null ? round(price - changeAbs, 2) : null,
    description: data.description || null,
  };
}

// --- Gulf: Trading Economics country pages — ADX cross-check/backup + QSE --
// The price comes from the embedded TEChartsMeta JSON ("symbol":"ADSMI:IND",
// "last":9667.38); the day change comes from the visible table row, found by
// searching the stripped text for the formatted value ("9,667.38 -58.34 -0.60%").
async function fetchTradingEconomics(url, teSymbol) {
  const html = await fetchText(url, { headers: { 'User-Agent': BROWSER_UA } });
  const m = html.match(new RegExp(`"symbol":"${teSymbol}"[^}]{0,400}"last":([\\d.]+)`));
  if (!m) throw new Error(`Trading Economics: ${teSymbol} not found`);
  const price = round(num(m[1]), 2); // rounded: TE's JSON last is a raw float (e.g. 10028.37988); the displayed row is 2dp
  if (!price) throw new Error(`Trading Economics: bad price for ${teSymbol}`);
  const text = stripTags(html);
  const escaped = fmt2(price).replace(/\./g, '\\.');
  const row = text.match(new RegExp(`${escaped}\\s+(-?[\\d,]+\\.[\\d]{2})\\s+(-?[\\d.]+)%`));
  const changeAbs = row ? round(num(row[1]), 2) : null;
  const changePct = row ? round(num(row[2]), 2) : null;
  return {
    price,
    change_abs: changeAbs,
    change_pct: changePct,
    previous_close: changeAbs !== null ? round(price - changeAbs, 2) : null,
  };
}

// --- Gulf: Nukoud — DFM cross-check/backup --------------------------------
// https://www.nukoud.com/markets/DFM-AE-INDEX — price in a `price-lg` span,
// change in the line right after it: "-36.97 (-0.59%) today".
async function fetchNukoudDFM() {
  const html = await fetchText('https://www.nukoud.com/markets/DFM-AE-INDEX', { headers: { 'User-Agent': BROWSER_UA } });
  const m = html.match(/price-lg[^>]*>([\d,.]+)<\/span>/);
  if (!m) throw new Error('Nukoud DFM price not found');
  const price = num(m[1]);
  if (!price) throw new Error('Nukoud DFM price invalid');
  const tail = html.slice(m.index, m.index + 400);
  const ch = tail.match(/(-?[\d,.]+)\s*<!-- -->\(<!-- -->(-?[\d.]+)%/);
  const changeAbs = ch ? round(num(ch[1]), 2) : null;
  const changePct = ch ? round(num(ch[2]), 2) : null;
  return {
    price,
    change_abs: changeAbs,
    change_pct: changePct,
    previous_close: changeAbs !== null ? round(price - changeAbs, 2) : null,
  };
}

// --- Metals spot: goldprice.dev (PRIMARY) ----------------------------------
// GET /v1/prices — symbols array, XAU/XAG per troy ounce in USD, with
// computed_at (used as the group's last-update time) + is_stale. If the
// provider flags its own data stale, the metal falls through to xaus.
async function fetchGoldPriceDev() {
  const data = await fetchJSON('https://api.goldprice.dev/v1/prices');
  if (!data.symbols || !Array.isArray(data.symbols)) throw new Error('goldprice.dev: bad response');
  const find = (sym) => data.symbols.find((s) => s.symbol === sym && s.quote_currency === 'USD' && s.unit === 'troy_ounce');
  const xau = find('XAU');
  const xag = find('XAG');
  if (!xau || !num(xau.price)) throw new Error('goldprice.dev: XAU/USD missing');
  return {
    xau: { price: num(xau.price), computed_at: xau.computed_at || null, is_stale: !!xau.is_stale },
    xag: xag && num(xag.price) ? { price: num(xag.price), computed_at: xag.computed_at || null, is_stale: !!xag.is_stale } : null,
  };
}

// --- Metals spot: xaus.com (backup/cross-check + 30-day history) -----------
// GET /api/v1/spot — spot_usd_oz + silver_usd_oz + updated_at.
// GET /api/v1/history?days=30 — 30 daily candles {d, c, h, l}.
async function fetchXausSpot() {
  const data = await fetchJSON('https://xaus.com/api/v1/spot');
  const xau = num(data.spot_usd_oz ?? (data.xau && data.xau.price));
  const xag = num(data.silver_usd_oz);
  if (!xau) throw new Error('xaus: spot price missing');
  return { xau, xag, updated_at: data.updated_at || data.price_as_of || null, stale: !!data.stale };
}

async function fetchXausHistory() {
  const data = await fetchJSON('https://xaus.com/api/v1/history?days=30');
  if (!data.points || !Array.isArray(data.points) || data.points.length < 2) throw new Error('xaus history: too few points');
  return data.points
    .map((p) => ({ date: p.d, close: num(p.c), high: num(p.h), low: num(p.l) }))
    .filter((p) => p.date && p.close);
}

// --- Fear & Greed ----------------------------------------------------------
async function fetchFearGreed() {
  const data = await fetchJSON('https://api.alternative.me/fng/?limit=1');
  const row = data.data && data.data[0];
  if (!row) throw new Error('Fear & Greed data missing');
  return { value: parseInt(row.value, 10), classification: row.value_classification };
}

// --- News: BBC Business RSS (headlines + outbound links only) -------------
async function fetchNews() {
  const xml = await fetchText('https://feeds.bbci.co.uk/news/business/rss.xml');
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const title = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const link = block.match(/<link>([\s\S]*?)<\/link>/);
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    if (title && link) {
      items.push({ title: title[1].trim(), link: link[1].trim(), pub_date: pubDate ? pubDate[1].trim() : null, source: 'BBC Business' });
    }
    if (items.length >= 8) break;
  }
  if (items.length === 0) throw new Error('no BBC items parsed');
  return items;
}

// --- Economic calendar: Forex Factory this-week feed -----------------------
const FF_COUNTRIES = { USD: 'United States', EUR: 'Eurozone', GBP: 'United Kingdom', JPY: 'Japan', CNY: 'China', AUD: 'Australia', CAD: 'Canada', CHF: 'Switzerland', NZD: 'New Zealand' };

async function fetchEvents() {
  const data = await fetchJSON('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
  if (!Array.isArray(data) || data.length === 0) throw new Error('Forex Factory feed empty');
  const today = damascusToday();
  const events = [];
  for (const e of data) {
    if (!e.date || !e.title) continue;
    const date = String(e.date).slice(0, 10);
    if (date < today) continue; // past events dropped
    if (!FF_COUNTRIES[e.country]) continue; // US + European + major economies only
    if (e.impact !== 'High' && e.impact !== 'Medium') continue;
    events.push({
      date,
      title: e.title,
      place: FF_COUNTRIES[e.country],
      importance: e.impact === 'High' ? 'high' : 'medium',
      ...(e.forecast ? { forecast: e.forecast } : {}),
      ...(e.previous ? { previous: e.previous } : {}),
    });
    if (events.length >= 14) break;
  }
  if (events.length === 0) throw new Error('no upcoming events in feed');
  return events;
}

// ---------------------------------------------------------------- merge

// --- Per-group source attribution (shown next to every figure on the site).
// Each group carries its real source name (EN + AR) and the time its value
// was actually fetched; a stale group keeps its original fetched_at, so the
// site always shows an honest "last updated" per figure group.
const GROUP_SOURCES = {
  syria_parallel: { source: 'Lira Today (sp-today.com)', source_ar: 'الليرة اليوم' },
  syria_central: { source: 'Central Bank of Syria — official bulletin', source_ar: 'مصرف سورية المركزي — النشرة الرسمية' },
  syria_gold: { source: 'Lira Today (sp-today.com)', source_ar: 'الليرة اليوم' },
  crypto: { source: 'CoinGecko', source_ar: 'كوين غيكو' },
  fx: { source: 'Frankfurter / ECB', source_ar: 'فرانكفورتر / البنك المركزي الأوروبي' },
  stocks: { source: 'Yahoo Finance', source_ar: 'ياهو فاينانس' },
  metals: { source: 'goldprice.dev — gold & silver spot', source_ar: 'غولد برايس — الذهب والفضة الفوري' },
  gulf: { source: 'TradingView · Yahoo Finance · Trading Economics', source_ar: 'تريدينغ فيو · ياهو فاينانس · تريدينغ إيكونوميكس' },
  fear_greed: { source: 'alternative.me — Fear & Greed Index', source_ar: 'مؤشر الخوف والطمع' },
  news: { source: 'BBC Business', source_ar: 'بي بي سي للأعمال' },
  events: { source: 'Forex Factory', source_ar: 'فوريكس فاكتوري' },
};

function loadPrevious() {
  for (const p of [LIVE_PATH, SEED_PATH]) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) {
      log(`WARN: could not read ${p}: ${e.message}`);
    }
  }
  return null;
}

function validate(live) {
  const problems = [];
  if (!live || typeof live !== 'object') problems.push('not an object');
  if (!live.fetched_at) problems.push('missing fetched_at');
  if (!live.syria || !live.syria.usd || !num(live.syria.usd.parallel_sell)) problems.push('missing parallel USD');
  if (!live.syria.gold21k || !num(live.syria.gold21k.sell)) problems.push('missing gold 21k');
  if (!Array.isArray(live.syria.currencies) || live.syria.currencies.length < 20) problems.push('currency table too short');
  if (!live.crypto || !live.crypto.BTC || !num(live.crypto.BTC.price)) problems.push('missing BTC');
  if (!live.stocks || !live.stocks['^GSPC'] || !num(live.stocks['^GSPC'].price)) problems.push('missing S&P 500');
  if (!live.fx || !live.fx.rates || !num(live.fx.rates.EUR)) problems.push('missing FX rates');
  // News + events are display-only sections: an empty array is a valid state
  // (no headlines fetched, or no upcoming events — e.g. weekends), and must
  // NEVER block the price update. Only a non-array shape is a real problem.
  // (21 Nov 2026: 'missing events' blocked every run for hours because the
  // Forex Factory feed had no upcoming events on a Friday night.)
  if (!Array.isArray(live.news)) problems.push('missing news');
  if (!Array.isArray(live.events)) problems.push('missing events');
  return problems;
}

// --- Currency table shape: 31 rows ---------------------------------------
// The table holds all 21 bulletin currencies (USD first) plus 10 extra
// rows whose central values are crossed from the USD bulletin rate
// (IQD, BRL, DZD, LYD, MAD, MYR, NZD, SGD, TND, ZAR). USD lives in the
// array as a row AND in syria.usd (the hero figures read syria.usd);
// the row is synced from syria.usd every run so the two never disagree.
// JPY is quoted PER 100 YEN in both tables (the bulletin convention);
// CNY + JPY have no rows in the market sources, so their parallel rates
// are crossed from the parallel USD through Frankfurter (ECB) rates.
const TABLE_ORDER = [...BULLETIN_CODES]; // bulletin order; the rest keep their order after it

function ensureCurrencyRows(live) {
  if (!live.syria) live.syria = {};
  if (!Array.isArray(live.syria.currencies)) live.syria.currencies = [];
  const rows = live.syria.currencies;
  const byCode = {};
  for (const r of rows) if (r && r.code) byCode[r.code] = r;
  const usd = live.syria.usd || {};
  // USD row: exact figures from syria.usd (hero source of truth).
  if (!byCode.USD && usd.central_buy && usd.central_sell && usd.parallel_buy && usd.parallel_sell) {
    const row = {
      code: 'USD', name: 'US dollar',
      central_buy: usd.central_buy, central_sell: usd.central_sell,
      central_mid: round((usd.central_buy + usd.central_sell) / 2, 2),
      parallel_buy: usd.parallel_buy, parallel_sell: usd.parallel_sell,
      central_derived: false,
    };
    rows.unshift(row);
    byCode.USD = row;
  }
  // CNY + JPY rows: seed from the USD rates crossed through the stored
  // Frankfurter rates (the OCR merge replaces the central values with the
  // exact bulletin figures whenever it runs; the Syria section refreshes
  // the parallel values from the fresh USD every run). If no FX rates are
  // stored yet the rows are still created and filled by the derivation
  // step / OCR later in the run — never left blank on purpose.
  const rates = (live.fx && live.fx.rates) || {};
  for (const [code, name, scale] of [['CNY', 'Chinese yuan', 1], ['JPY', 'Japanese yen', 100]]) {
    if (byCode[code]) continue;
    const perUsd = num(rates[code]);
    const row = { code, name, central_derived: true, parallel_derived: true };
    if (perUsd && usd.central_buy && usd.central_sell) {
      row.central_buy = round(usd.central_buy / perUsd * scale, 2);
      row.central_sell = round(usd.central_sell / perUsd * scale, 2);
      row.central_mid = round((row.central_buy + row.central_sell) / 2, 2);
    }
    if (perUsd && usd.parallel_buy && usd.parallel_sell) {
      row.parallel_buy = round(usd.parallel_buy / perUsd * scale, 2);
      row.parallel_sell = round(usd.parallel_sell / perUsd * scale, 2);
    }
    rows.push(row);
    byCode[code] = row;
  }
  // Canonical order: the 21 bulletin currencies in bulletin order (USD
  // first), then the 10 derived rows in their previous relative order.
  const orderIndex = {};
  TABLE_ORDER.forEach((c, i) => { orderIndex[c] = i; });
  const prevIndex = new Map(rows.map((r, i) => [r.code, i]));
  rows.sort((a, b) => {
    const ia = orderIndex[a.code] !== undefined ? orderIndex[a.code] : 100 + (prevIndex.get(a.code) || 0);
    const ib = orderIndex[b.code] !== undefined ? orderIndex[b.code] : 100 + (prevIndex.get(b.code) || 0);
    return ia - ib;
  });
}

// Keep the USD table row in lock-step with syria.usd (the hero figures).
function syncUsdRow(live) {
  const row = (live.syria.currencies || []).find((r) => r.code === 'USD');
  const usd = live.syria.usd || {};
  if (!row) return;
  if (usd.central_buy && usd.central_sell) {
    row.central_buy = usd.central_buy;
    row.central_sell = usd.central_sell;
    row.central_mid = round((usd.central_buy + usd.central_sell) / 2, 2);
    row.central_derived = false;
  }
  if (usd.parallel_buy && usd.parallel_sell) {
    row.parallel_buy = usd.parallel_buy;
    row.parallel_sell = usd.parallel_sell;
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const prev = loadPrevious();
  if (!prev) {
    log('FATAL: no previous live.json and no seed.json — refusing to write an empty file');
    process.exit(1);
  }
  const now = new Date().toISOString();
  const today = damascusToday();

  // Deep-copy previous state as the base: anything that fails to refresh
  // simply stays at its last good value.
  const live = JSON.parse(JSON.stringify(prev));
  live.fetched_at = now;
  // Currency table shape: all 21 bulletin currencies (USD first) + the 10
  // derived rows. Missing rows are created (seeded from syria.usd / stored
  // FX) and the array is put in canonical bulletin order.
  ensureCurrencyRows(live);
  const groupOk = {}; // group key -> true when its fetch succeeded this run
  const groupSource = {}; // group key -> {source, source_ar} override for this run
  const groupFetchedAt = {}; // group key -> ISO timestamp override (provider's own time)
  const groupNotes = {}; // group key -> note attached to the group meta entry
  const divergenceNotes = []; // cross-check divergences, appended to live.notes

  // --- Syria: parallel USD + gold -------------------------------------------
  // Three sources, priority order: sp-today.com (Lira Today, PRIMARY) ->
  // Lirascope (co-primary) -> SYPNow (second backup). Lirascope + SYPNow also
  // cross-validate the primary: if they disagree with it by more than 0.5% on
  // USD buy/sell or the 21k gold mid, the primary value is kept but the group
  // is flagged stale and the divergence is recorded in notes — a disputed
  // figure is never written silently. NEVER liratoday.net (stale/wrong).
  const DIVERGE_PCT = 0.005;
  let sp = null;
  let ls = null;
  let sn = null;
  try { sp = await fetchSpToday(); markSource('sp_today', 'ok'); }
  catch (e) { markSource('sp_today', 'stale', e); log(`WARN: sp-today failed (${e.message})`); }
  try { ls = await fetchLirascope(); markSource('lirascope', 'ok'); }
  catch (e) { markSource('lirascope', 'stale', e); log(`WARN: Lirascope failed (${e.message})`); }
  try { sn = await fetchSYPNow(); markSource('sypnow', 'ok'); }
  catch (e) { markSource('sypnow', 'stale', e); log(`WARN: SYPNow failed (${e.message})`); }

  const usdSources = [];
  if (sp) usdSources.push({ name: 'sp-today', key: 'sp_today', usd: sp.parallelUSD });
  if (ls) usdSources.push({ name: 'lirascope', key: 'lirascope', usd: ls.usd });
  if (sn) usdSources.push({ name: 'sypnow', key: 'sypnow', usd: sn.usd });

  if (usdSources.length > 0) {
    const primary = usdSources[0];
    // Cross-validation against every other available source.
    let usdDiverged = false;
    const usdDivergenceDetails = [];
    for (const other of usdSources.slice(1)) {
      const dBuy = relDiff(primary.usd.buy, other.usd.buy);
      const dSell = relDiff(primary.usd.sell, other.usd.sell);
      if ((dBuy !== null && dBuy > DIVERGE_PCT) || (dSell !== null && dSell > DIVERGE_PCT)) {
        usdDiverged = true;
        usdDivergenceDetails.push(`${other.name} USD ${other.usd.buy}/${other.usd.sell} vs ${primary.name} ${primary.usd.buy}/${primary.usd.sell}`);
      }
    }
    live.syria.usd.parallel_buy = primary.usd.buy;
    live.syria.usd.parallel_sell = primary.usd.sell;
    // Gold (buy/sell) comes ONLY from sp-today — Lirascope/SYPNow publish a
    // single mid price, which cross-checks the sp-today mid but cannot
    // substitute for the buy/sell spread.
    const spMid = sp ? (sp.gold.gold21k.buy + sp.gold.gold21k.sell) / 2 : null;
    let goldDiverged = false;
    const goldDivergenceDetails = [];
    for (const [name, mid] of [['lirascope', ls ? ls.gold21kMid : null], ['sypnow', sn ? sn.gold21kMid : null]]) {
      if (spMid !== null && mid !== null) {
        const d = relDiff(spMid, mid);
        if (d !== null && d > DIVERGE_PCT) {
          goldDiverged = true;
          goldDivergenceDetails.push(`${name} 21k mid ${mid} vs sp-today mid ${round(spMid, 2)}`);
        }
      }
    }
    if (sp) {
      // Change vs yesterday: compare against the last history entry dated
      // BEFORE today (not the last run, which may already be today's value).
      const historyBefore = (Array.isArray(live.syria.history) ? live.syria.history : []).filter((h) => h.date < today);
      const yesterdayGold = historyBefore.length ? historyBefore[historyBefore.length - 1].gold21k_sell : null;
      live.syria.gold21k = { buy: sp.gold.gold21k.buy, sell: sp.gold.gold21k.sell, change_vs_yesterday: yesterdayGold ? round(sp.gold.gold21k.sell - yesterdayGold) : null };
      if (sp.gold.gold24k) live.syria.gold24k = { buy: sp.gold.gold24k.buy, sell: sp.gold.gold24k.sell, usd_per_gram: sp.gold.gold24k.usd_per_gram };
      if (sp.gold.gold18k) live.syria.gold18k = { buy: sp.gold.gold18k.buy, sell: sp.gold.gold18k.sell, usd_per_gram: sp.gold.gold18k.usd_per_gram };
      if (sp.goldOunceUSD) live.syria.gold_ounce_usd = sp.goldOunceUSD;
      if (sp.silverOunceUSD) live.syria.silver_ounce_usd = sp.silverOunceUSD;
      // Structured karat table (incl. 14K) for the full gold section — the
      // legacy gold21k/24k/18k fields above stay untouched (site + app read them).
      const karats = {};
      for (const [k, key] of [[24, 'gold24k'], [21, 'gold21k'], [18, 'gold18k'], [14, 'gold14k']]) {
        if (sp.gold[key]) karats[k] = { buy: sp.gold[key].buy, sell: sp.gold[key].sell, usd_per_gram: sp.gold[key].usd_per_gram };
      }
      if (Object.keys(karats).length) live.syria.gold = { karats, ounce_usd: sp.goldOunceUSD || live.syria.gold_ounce_usd || null };
      if (sp.silverOunceUSD) live.syria.silver = { ounce_usd: sp.silverOunceUSD };
    }
    // USD by city (Damascus + Hasakah) — drives the Syria page's city block
    // and the market-range note. Only sp-today publishes city series, so when
    // it is down the last good cities stay live (never blanked).
    if (sp && sp.cities) live.syria.parallel = { cities: sp.cities, source: 'Lira Today (sp-today.com)', fetched_at: now };
    // Parallel rates for the 31-currency table: sp-today primary; Lirascope
    // when sp-today is down. IQD is skipped from sp-today (it rounds it to
    // 0.10/0.10, losing precision) — instead IQD is always filled from
    // Lirascope when available, since it publishes IQD properly (0.0977/0.0992).
    const tableSource = sp ? sp.parallel : (ls && ls.table ? ls.table : null);
    const tableIsLirascope = !sp && !!tableSource;
    if (tableSource) {
      for (const row of live.syria.currencies) {
        if (row.code === 'IQD' && !tableIsLirascope) continue;
        const p = tableSource[row.code];
        if (p && p.buy !== p.sell) { row.parallel_buy = p.buy; row.parallel_sell = p.sell; }
      }
    }
    if (ls && ls.table && ls.table.IQD) {
      const iqdRow = live.syria.currencies.find((r) => r.code === 'IQD');
      if (iqdRow) { iqdRow.parallel_buy = ls.table.IQD.buy; iqdRow.parallel_sell = ls.table.IQD.sell; }
    }
    // CNY + JPY have no rows in the market sources — their parallel rates
    // are crossed from the fresh cross-validated parallel USD through
    // Frankfurter (ECB): SYP per CNY = USD/SYP ÷ CNY-per-USD. JPY is
    // quoted per 100 yen (the bulletin convention), so its crossed rate
    // is scaled ×100. Stored FX rates are the fallback if Frankfurter is
    // unreachable this run; on total failure the last good values stay.
    {
      let fxRates = (live.fx && live.fx.rates) || null;
      try {
        const fxFresh = await fetchFXCached();
        if (fxFresh && fxFresh.rates) fxRates = fxFresh.rates;
      } catch (e) { log(`WARN: Frankfurter unavailable for CNY/JPY cross (${e.message}) — using stored rates`); }
      if (fxRates && num(fxRates.CNY) && num(fxRates.JPY)) {
        const cnyRow = live.syria.currencies.find((r) => r.code === 'CNY');
        if (cnyRow) {
          cnyRow.parallel_buy = round(primary.usd.buy / fxRates.CNY, 2);
          cnyRow.parallel_sell = round(primary.usd.sell / fxRates.CNY, 2);
          cnyRow.parallel_derived = true;
        }
        const jpyRow = live.syria.currencies.find((r) => r.code === 'JPY');
        if (jpyRow) {
          jpyRow.parallel_buy = round(primary.usd.buy / fxRates.JPY * 100, 2);
          jpyRow.parallel_sell = round(primary.usd.sell / fxRates.JPY * 100, 2);
          jpyRow.parallel_derived = true;
        }
      }
    }
    // History: one entry per day for the 30-day trend. The USD part updates
    // whenever a fresh USD is available; the gold part only when sp-today
    // gold refreshed (a mid price is not a sell price).
    const history = Array.isArray(live.syria.history) ? live.syria.history : [];
    const lastEntry = history[history.length - 1];
    const freshGoldSell = sp ? sp.gold.gold21k.sell : null;
    if (!lastEntry || lastEntry.date !== today) {
      history.push({ date: today, usd_parallel_sell: primary.usd.sell, gold21k_sell: freshGoldSell !== null ? freshGoldSell : (lastEntry ? lastEntry.gold21k_sell : null) });
      live.syria.history = history.slice(-30);
    } else {
      lastEntry.usd_parallel_sell = primary.usd.sell;
      if (freshGoldSell !== null) lastEntry.gold21k_sell = freshGoldSell;
    }
    live.syria.last_updated = today;
    // Cross-check record: what each source said, and whether they agreed.
    live.syria.cross_check = {
      usd: {
        primary: primary.key,
        sp_today: sp ? { buy: sp.parallelUSD.buy, sell: sp.parallelUSD.sell } : null,
        lirascope: ls ? { buy: ls.usd.buy, sell: ls.usd.sell } : null,
        sypnow: sn ? { buy: sn.usd.buy, sell: sn.usd.sell } : null,
        diverged: usdDiverged,
      },
      gold21k_mid: {
        sp_today: spMid !== null ? round(spMid, 2) : null,
        lirascope: ls ? ls.gold21kMid : null,
        sypnow: sn ? sn.gold21kMid : null,
        diverged: goldDiverged,
      },
      checked_at: now,
    };
    // Group status: a divergence keeps the primary value but flags the group
    // stale (with the original fetched_at) so the site never shows a disputed
    // figure as freshly verified.
    if (usdDiverged) {
      groupNotes.syria_parallel = `Cross-check divergence: ${usdDivergenceDetails.join('; ')}`;
      divergenceNotes.push(`Parallel USD: ${usdDivergenceDetails.join('; ')}`);
    } else {
      groupOk.syria_parallel = true;
    }
    if (goldDiverged) {
      groupNotes.syria_gold = `Cross-check divergence: ${goldDivergenceDetails.join('; ')}`;
      divergenceNotes.push(`Gold 21k: ${goldDivergenceDetails.join('; ')}`);
    } else if (sp) {
      groupOk.syria_gold = true;
    }
    // Attribution: when the primary is down, the group is honestly attributed
    // to the source that actually supplied the value.
    if (primary.key === 'lirascope') groupSource.syria_parallel = { source: 'Lirascope (lirascope.syria-cloud.sy)', source_ar: 'ليراسكوب' };
    else if (primary.key === 'sypnow') groupSource.syria_parallel = { source: 'SYPNow (sypnow.com)', source_ar: 'SYPNow' };
  } else {
    log('WARN: all three Syria sources failed — keeping last good Syria figures');
  }

  // --- Central Bank bulletin ------------------------------------------------
  // Weekend rule: the Syrian weekend is Fri-Sat — the Central Bank publishes
  // no bulletin, so a missing bulletin on those days is NOT a failure and is
  // NOT flagged stale; the last working-day bulletin stays current.
  const weekday = damascusWeekday();
  const isWeekend = weekday === 5 || weekday === 6;
  let cbOcrApplied = false; // true when the Telegram-OCR table replaced the central rows
  if (isWeekend) {
    const weekendNote = 'Weekend (Fri–Sat) — no new bulletin expected; last working-day bulletin is current';
    markSource('central_bank', 'ok', null, weekendNote);
    groupOk.syria_central = true;
    groupNotes.syria_central = weekendNote;
    log('CB bulletin: weekend — no new bulletin expected, keeping last working-day bulletin');
  } else {
    let cb = null;
    try {
      cb = await fetchCentralBank();
      markSource('central_bank', 'ok');
      groupOk.syria_central = true;
      const storedDate = live.bulletin_date || '0000-00-00';
      live.syria.usd.central_buy = cb.bulletin.usd_buy;
      live.syria.usd.central_sell = cb.bulletin.usd_sell;
      if (cb.bulletin.date > storedDate) live.bulletin_date = cb.bulletin.date;
      // Ticker mids only apply when the ticker is at least as new as the
      // stored bulletin (the site ticker can lag the published bulletin).
      if (cb.tickerDate && cb.tickerDate >= storedDate) {
        for (const row of live.syria.currencies) {
          const mid = cb.mids[row.code];
          if (!mid || row.code === 'USD') continue;
          const prevMid = row.central_mid;
          if (prevMid && prevMid > 0) {
            const buyRatio = row.central_buy / prevMid;
            const sellRatio = row.central_sell / prevMid;
            row.central_buy = round(mid * buyRatio, 2);
            row.central_sell = round(mid * sellRatio, 2);
            row.central_mid = mid;
            row.central_derived = true;
          }
        }
        if (cb.tickerDate > storedDate) live.bulletin_date = cb.tickerDate;
      }
    } catch (e) {
      markSource('central_bank', 'stale', e);
      log(`WARN: central bank fetch failed (${e.message}) — keeping last good bulletin`);
    }

    // Full 21-currency bulletin table via the CB's official Telegram channel
    // (@SyCBOS): the bulletin posts there daily as an image (~12:30 Damascus
    // on working days). Download -> preprocess -> OCR (two threshold passes,
    // TSV positions) -> repair single-digit errors -> validate against
    // cb.gov.sy USD + Frankfurter EUR/USD -> merge into the 21 bulletin
    // rows of the 31-currency table. On ANY failure the last good central
    // table stays untouched.
    try {
      const tg = await fetchTelegramBulletin();
      // Stored rows guide the OCR repair (bulletins move slowly); USD's
      // stored mid is the average of its buy/sell.
      const storedRows = {};
      for (const row of live.syria.currencies) {
        if (row.central_mid && row.central_sell && row.central_buy) {
          storedRows[row.code] = { mid: row.central_mid, sell: row.central_sell, buy: row.central_buy };
        }
      }
      if (live.syria.usd && live.syria.usd.central_buy && live.syria.usd.central_sell) {
        storedRows.USD = { mid: (live.syria.usd.central_buy + live.syria.usd.central_sell) / 2, sell: live.syria.usd.central_sell, buy: live.syria.usd.central_buy };
      }
      const parsed = await ocrTelegramBulletin(tg.photoUrl, storedRows);
      let eurUsd = null;
      try {
        const fxCheck = await fetchFXCached();
        eurUsd = 1 / fxCheck.rates.EUR;
      } catch (e) {
        log(`WARN: Frankfurter unavailable for OCR cross-check (${e.message})`);
      }
      const storedNo = parseInt(live.bulletin, 10) || null;
      const problems = validateBulletinOCR(parsed, {
        storedNo,
        messageDate: tg.bulletinDate,
        cbUsd: cb ? cb.bulletin : null,
        eurUsd,
      });
      if (problems.length > 0) throw new Error(`OCR validation failed: ${problems.join('; ')}`);
      let updated = 0;
      for (const row of live.syria.currencies) {
        const o = parsed.rows[row.code];
        if (!o) continue;
        row.central_buy = o.buy;
        row.central_sell = o.sell;
        row.central_mid = o.mid;
        row.central_derived = false;
        updated++;
      }
      // JPY + CNY are full table rows now, so the merge above covers all
      // 21 bulletin currencies (USD included) — `updated` counts them.
      live.bulletin = String(parsed.bulletinNo);
      if (parsed.date > (live.bulletin_date || '0000-00-00')) live.bulletin_date = parsed.date;
      markSource('telegram_sycbos', 'ok');
      groupOk.syria_central = true;
      groupSource.syria_central = { source: 'Central Bank of Syria (Telegram @SyCBOS)', source_ar: 'مصرف سورية المركزي (تيليجرام @SyCBOS)' };
      groupNotes.syria_central = `Bulletin ${parsed.bulletinNo} (${parsed.date}) — full 21-currency table via Telegram OCR`
        + (parsed.repaired.length > 0 ? `; OCR cross-check repaired ${parsed.repaired.join(', ')}` : '');
      cbOcrApplied = true;
      log(`CB bulletin: Telegram OCR applied — bulletin ${parsed.bulletinNo} (${parsed.date}), ${updated} table rows updated${parsed.repaired.length > 0 ? `, repaired: ${parsed.repaired.join(', ')}` : ''}`);
    } catch (e) {
      markSource('telegram_sycbos', 'stale', e);
      log(`WARN: Telegram bulletin OCR failed (${e.message}) — keeping last good central table`);
    }
  }

  // --- Crypto ----------------------------------------------------------------
  try {
    live.crypto = await fetchCrypto();
    markSource('coingecko', 'ok');
    groupOk.crypto = true;
  } catch (e) {
    log(`WARN: CoinGecko failed (${e.message}) — trying Kraken fallback`);
    try {
      const kraken = await fetchCryptoKrakenFallback();
      live.crypto = { ...(live.crypto || {}), ...kraken };
      markSource('coingecko', 'stale', e);
      markSource('kraken', 'ok');
      groupOk.crypto = true;
    } catch (e2) {
      markSource('coingecko', 'stale', e);
      markSource('kraken', 'stale', e2);
      log(`WARN: Kraken fallback also failed (${e2.message}) — keeping last good crypto`);
    }
  }

  // --- FX --------------------------------------------------------------------
  try {
    const fx = await fetchFXCached();
    markSource('frankfurter', 'ok');
    groupOk.fx = true;
    // Fixed Gulf pegs (Frankfurter/ECB does not publish SAR/AED/QAR).
    const rates = { ...fx.rates, SAR: 0.26667, AED: 0.27226, QAR: 0.27473 };
    live.fx = { date: fx.date, base: 'USD', rates, pegs: { SAR: 3.75, AED: 3.6725, QAR: 3.64 } };
  } catch (e) {
    markSource('frankfurter', 'stale', e);
    log(`WARN: Frankfurter failed (${e.message}) — keeping last good FX`);
  }

  // --- Yahoo: stocks ----------------------------------------------------------
  if (!live.stocks) live.stocks = {};
  for (const symbol of YAHOO_STOCKS) {
    try {
      live.stocks[symbol] = await fetchYahooHistory(symbol);
      markSource(`yahoo:${symbol}`, 'ok');
      groupOk.stocks = true;
    } catch (e) {
      markSource(`yahoo:${symbol}`, 'stale', e);
      log(`WARN: Yahoo ${symbol} failed (${e.message}) — keeping last good value`);
    }
  }

  // --- Gulf: real indices -----------------------------------------------------
  if (!live.gulf) live.gulf = {};
  // The old UAE ETF proxy key is dropped: it fed both the DFM and ADX cards
  // with the same ETF price. DFM/ADX now have their own real index keys.
  delete live.gulf.UAE;
  // BAX (Baxter stock, briefly written here on 17 Nov before the symbol was
  // verified wrong) is dropped too — Yahoo has no Bahrain All Share index.
  delete live.gulf.BAX;

  // TASI + Brent + WTI stay on Yahoo (they are the real benchmarks there).
  for (const [symbol, label, withHistory] of [['^TASI.SR', 'Saudi Tadawul (TASI)', true], ['BZ=F', 'Brent crude', false], ['CL=F', 'WTI crude', false]]) {
    try {
      const row = withHistory ? await fetchYahooHistory(symbol) : await fetchYahoo(symbol);
      row.label = label;
      if (row.price && row.previous_close) row.change_abs = round(row.price - row.previous_close, 2);
      live.gulf[symbol] = row;
      markSource(`yahoo:${symbol}`, 'ok');
      groupOk.gulf = true;
    } catch (e) {
      markSource(`yahoo:${symbol}`, 'stale', e);
      log(`WARN: Yahoo ${symbol} failed (${e.message}) — keeping last good value`);
    }
  }

  // DFM: TradingView primary; Nukoud cross-checks (and backs up) it.
  let dfm = null;
  let dfmNote = null;
  try {
    const tv = await fetchTradingView('DFM:DFMGI');
    markSource('tradingview_dfm', 'ok');
    dfm = { symbol: 'DFMGI', price: tv.price, change_pct: tv.change_pct, change_abs: tv.change_abs, previous_close: tv.previous_close, currency: 'AED', label: 'Dubai Financial Market (DFM)', source: 'TradingView' };
    try {
      const nk = await fetchNukoudDFM();
      markSource('nukoud_dfm', 'ok');
      const d = relDiff(tv.price, nk.price);
      if (d !== null && d <= 0.005) {
        dfm.verified = true;
      } else {
        dfm.verified = false;
        dfmNote = `Nukoud cross-check disagrees: ${nk.price} vs TradingView ${tv.price}`;
        divergenceNotes.push(`DFM: ${dfmNote}`);
      }
    } catch (e2) {
      markSource('nukoud_dfm', 'stale', e2);
      dfm.verified = !!(live.gulf.DFMGI && live.gulf.DFMGI.verified); // carry forward
      dfmNote = 'Nukoud cross-check unavailable this run';
    }
  } catch (e) {
    markSource('tradingview_dfm', 'stale', e);
    try {
      const nk = await fetchNukoudDFM();
      markSource('nukoud_dfm', 'ok');
      dfm = { symbol: 'DFMGI', price: nk.price, change_pct: nk.change_pct, change_abs: nk.change_abs, previous_close: nk.previous_close, currency: 'AED', label: 'Dubai Financial Market (DFM)', source: 'Nukoud', verified: false };
      dfmNote = 'TradingView failed — Nukoud backup in use (unverified)';
    } catch (e2) {
      markSource('nukoud_dfm', 'stale', e2);
      log(`WARN: DFM failed on both sources (${e.message}; ${e2.message}) — keeping last good value`);
    }
  }
  if (dfm) {
    if (dfmNote) dfm.note = dfmNote;
    live.gulf.DFMGI = dfm;
    groupOk.gulf = true;
  }

  // ADX: TradingView primary; Trading Economics cross-checks (and backs up) it.
  let adx = null;
  let adxNote = null;
  try {
    const tv = await fetchTradingView('ADX:FADGI');
    markSource('tradingview_adx', 'ok');
    adx = { symbol: 'FADGI', price: tv.price, change_pct: tv.change_pct, change_abs: tv.change_abs, previous_close: tv.previous_close, currency: 'AED', label: 'Abu Dhabi Securities Exchange (ADX)', source: 'TradingView' };
    try {
      const te = await fetchTradingEconomics('https://tradingeconomics.com/united-arab-emirates/stock-market', 'ADSMI:IND');
      markSource('tradingeconomics_adx', 'ok');
      const d = relDiff(tv.price, te.price);
      if (d !== null && d <= 0.005) {
        adx.verified = true;
      } else {
        adx.verified = false;
        adxNote = `Trading Economics cross-check disagrees: ${te.price} vs TradingView ${tv.price}`;
        divergenceNotes.push(`ADX: ${adxNote}`);
      }
    } catch (e2) {
      markSource('tradingeconomics_adx', 'stale', e2);
      adx.verified = !!(live.gulf.FADGI && live.gulf.FADGI.verified); // carry forward
      adxNote = 'Trading Economics cross-check unavailable this run';
    }
  } catch (e) {
    markSource('tradingview_adx', 'stale', e);
    try {
      const te = await fetchTradingEconomics('https://tradingeconomics.com/united-arab-emirates/stock-market', 'ADSMI:IND');
      markSource('tradingeconomics_adx', 'ok');
      adx = { symbol: 'FADGI', price: te.price, change_pct: te.change_pct, change_abs: te.change_abs, previous_close: te.previous_close, currency: 'AED', label: 'Abu Dhabi Securities Exchange (ADX)', source: 'Trading Economics', verified: false };
      adxNote = 'TradingView failed — Trading Economics backup in use (unverified)';
    } catch (e2) {
      markSource('tradingeconomics_adx', 'stale', e2);
      log(`WARN: ADX failed on both sources (${e.message}; ${e2.message}) — keeping last good value`);
    }
  }
  if (adx) {
    if (adxNote) adx.note = adxNote;
    live.gulf.FADGI = adx;
    groupOk.gulf = true;
  }

  // QSE: Trading Economics ONLY — single source, always flagged unverified.
  // (Yahoo has NO QE Index symbol: 'QSI' returns an unrelated $1.06 security
  // and the Yahoo search API finds no QE Index — verified 17 Nov 2026. The
  // same check killed Bahrain 'BAX' — Baxter stock, not the All Share index —
  // plus Kuwait Main Market 50 and Oman MSX 30, which have no Yahoo symbol
  // at all. Those four indices are deliberately NOT in this file.)
  // The site's QAT card still reads the QAT key, so it gets the real index
  // too (with the QAT ETF proxy nested inside as a fallback reference only).
  try {
    const te = await fetchTradingEconomics('https://tradingeconomics.com/qatar/stock-market', 'DSM:IND');
    markSource('tradingeconomics_qse', 'ok');
    const qse = { symbol: 'QSE', price: te.price, change_pct: te.change_pct, change_abs: te.change_abs, previous_close: te.previous_close, currency: 'QAR', label: 'Qatar Stock Exchange (QSE)', source: 'Trading Economics', verified: false, note: 'Single source (Trading Economics) — unverified' };
    live.gulf.QSE = qse;
    live.gulf.QAT = { ...qse, symbol: 'QAT' };
    groupOk.gulf = true;
  } catch (e) {
    markSource('tradingeconomics_qse', 'stale', e);
    log(`WARN: Trading Economics QSE failed (${e.message}) — keeping last good value`);
  }
  // QAT ETF proxy (Yahoo) — fallback reference ONLY, nested in the QAT entry.
  try {
    const qat = await fetchYahoo('QAT');
    markSource('yahoo:QAT', 'ok');
    if (live.gulf.QAT && num(live.gulf.QAT.price)) {
      live.gulf.QAT.etf_proxy = { price: qat.price, change_pct: qat.change_pct, source: 'Yahoo Finance (iShares MSCI Qatar ETF)' };
    }
  } catch (e) {
    markSource('yahoo:QAT', 'stale', e);
  }
  if (live.gulf.QSE) groupNotes.gulf = 'QSE is single-source (Trading Economics) — unverified';

  // --- Metals: spot gold/silver ----------------------------------------------
  let gpd = null;
  try { gpd = await fetchGoldPriceDev(); markSource('goldprice_dev', 'ok'); }
  catch (e) { markSource('goldprice_dev', 'stale', e); log(`WARN: goldprice.dev failed (${e.message}) — trying xaus`); }
  let xaus = null;
  try { xaus = await fetchXausSpot(); markSource('xaus_spot', 'ok'); }
  catch (e) { markSource('xaus_spot', 'stale', e); log(`WARN: xaus spot failed (${e.message})`); }
  let goldHistory = null;
  let xauChange = null;
  let xauPrevClose = null;
  try {
    goldHistory = await fetchXausHistory();
    markSource('xaus_history', 'ok');
    if (goldHistory.length >= 2) {
      const last = goldHistory[goldHistory.length - 1];
      const prevPt = goldHistory[goldHistory.length - 2];
      if (prevPt.close) {
        xauChange = round(((last.close - prevPt.close) / prevPt.close) * 100, 2);
        xauPrevClose = prevPt.close;
      }
    }
  } catch (e) {
    markSource('xaus_history', 'stale', e);
    log(`WARN: xaus history failed (${e.message}) — keeping last 30-day trend`);
  }

  // Per-metal resolution: goldprice.dev (unless it flags its own data stale)
  // -> xaus -> Yahoo futures (tertiary, fetched below only if needed).
  function resolveMetal(kind) {
    if (gpd && gpd[kind] && !gpd[kind].is_stale) {
      return { price: gpd[kind].price, source: 'goldprice.dev', basis: 'spot', computed_at: gpd[kind].computed_at, change_pct: null, previous_close: null };
    }
    if (xaus && !xaus.stale) {
      const p = kind === 'xau' ? xaus.xau : xaus.xag;
      if (p) return { price: p, source: 'xaus.com', basis: 'spot', computed_at: xaus.updated_at, change_pct: null, previous_close: null };
    }
    return null;
  }
  let gold = resolveMetal('xau');
  let silver = resolveMetal('xag');
  // Spot cross-check (1% tolerance — the feeds update at different times).
  // A divergence is noted, never treated as a failure.
  if (gpd && gpd.xau && xaus && xaus.xau) {
    const d = relDiff(gpd.xau.price, xaus.xau);
    if (d !== null && d > 0.01) divergenceNotes.push(`Gold spot feeds disagree: goldprice.dev $${gpd.xau.price} vs xaus $${xaus.xau}`);
  }
  if (gpd && gpd.xag && xaus && xaus.xag) {
    const d = relDiff(gpd.xag.price, xaus.xag);
    if (d !== null && d > 0.01) divergenceNotes.push(`Silver spot feeds disagree: goldprice.dev $${gpd.xag.price} vs xaus $${xaus.xag}`);
  }
  if (!gold || !silver) {
    for (const [kind, symbol] of [['xau', 'GC=F'], ['xag', 'SI=F']]) {
      if ((kind === 'xau' && gold) || (kind === 'xag' && silver)) continue;
      try {
        const row = await fetchYahoo(symbol);
        markSource(`yahoo:${symbol}`, 'ok');
        const entry = { price: row.price, source: 'Yahoo Finance', basis: 'futures', computed_at: null, change_pct: row.change_pct, previous_close: row.previous_close };
        if (kind === 'xau') gold = entry; else silver = entry;
      } catch (e) {
        markSource(`yahoo:${symbol}`, 'stale', e);
        log(`WARN: Yahoo ${symbol} failed (${e.message}) — keeping last good value`);
      }
    }
  }
  if (!live.metals) live.metals = {};
  if (gold) {
    const changePct = gold.change_pct ?? xauChange;
    const prevClose = gold.previous_close ?? xauPrevClose;
    live.metals['GC=F'] = { symbol: 'GC=F', price: gold.price, change_pct: changePct, previous_close: prevClose, currency: 'USD', source: gold.source, basis: gold.basis, ...(gold.computed_at ? { computed_at: gold.computed_at } : {}) };
    live.metals.XAU = { symbol: 'XAU', price: gold.price, change_pct: changePct, previous_close: prevClose, currency: 'USD', unit: 'troy_ounce', label: 'Gold spot (XAU/USD)', source: gold.source, basis: gold.basis, ...(gold.computed_at ? { computed_at: gold.computed_at } : {}), cross_check: { goldprice_dev: gpd && gpd.xau ? gpd.xau.price : null, xaus: xaus ? xaus.xau : null } };
    groupOk.metals = true;
  }
  if (silver) {
    live.metals['SI=F'] = { symbol: 'SI=F', price: silver.price, change_pct: silver.change_pct, previous_close: silver.previous_close, currency: 'USD', source: silver.source, basis: silver.basis, ...(silver.computed_at ? { computed_at: silver.computed_at } : {}) };
    live.metals.XAG = { symbol: 'XAG', price: silver.price, change_pct: silver.change_pct, previous_close: silver.previous_close, currency: 'USD', unit: 'troy_ounce', label: 'Silver spot (XAG/USD)', source: silver.source, basis: silver.basis, ...(silver.computed_at ? { computed_at: silver.computed_at } : {}), cross_check: { goldprice_dev: gpd && gpd.xag ? gpd.xag.price : null, xaus: xaus ? xaus.xag : null } };
    groupOk.metals = true;
  }
  if (goldHistory) live.metals.gold_history_30d = goldHistory.slice(-30);
  // Group attribution: the primary spot source actually used this run;
  // last-update time = the provider's own computed_at when available.
  if (gold || silver) {
    const primarySource = (gold && gold.source) || (silver && silver.source);
    const computedAt = (gold && gold.computed_at) || (silver && silver.computed_at);
    if (primarySource === 'goldprice.dev') {
      groupSource.metals = { source: 'goldprice.dev — gold & silver spot', source_ar: 'غولد برايس — الذهب والفضة الفوري' };
      if (computedAt) groupFetchedAt.metals = computedAt;
    } else if (primarySource === 'xaus.com') {
      groupSource.metals = { source: 'xaus.com — gold & silver spot', source_ar: 'xaus.com — الذهب والفضة الفوري' };
      if (computedAt) groupFetchedAt.metals = computedAt;
    } else {
      groupSource.metals = { source: 'Yahoo Finance — gold & silver futures', source_ar: 'ياهو فاينانس — عقود الذهب والفضة الآجلة' };
    }
  }

  // --- Fear & Greed -----------------------------------------------------------
  try {
    live.fear_greed = await fetchFearGreed();
    markSource('fear_greed', 'ok');
    groupOk.fear_greed = true;
  } catch (e) {
    markSource('fear_greed', 'stale', e);
    log(`WARN: Fear & Greed failed (${e.message}) — keeping last good value`);
  }

  // --- News -------------------------------------------------------------------
  try {
    live.news = await fetchNews();
    markSource('bbc_news', 'ok');
    groupOk.news = true;
  } catch (e) {
    markSource('bbc_news', 'stale', e);
    log(`WARN: BBC RSS failed (${e.message}) — keeping last headlines`);
    if (!Array.isArray(live.news)) live.news = [];
  }

  // --- Events -----------------------------------------------------------------
  try {
    live.events = await fetchEvents();
    markSource('forex_factory', 'ok');
    groupOk.events = true;
  } catch (e) {
    markSource('forex_factory', 'stale', e);
    log(`WARN: Forex Factory failed (${e.message}) — keeping last events, dropping past ones`);
    if (Array.isArray(live.events)) live.events = live.events.filter((ev) => ev.date >= today);
    if (!Array.isArray(live.events)) live.events = [];
  }

  // --- Per-group source + last-update metadata -------------------------------
  // A refreshed group gets fetched_at = now (or the provider's own timestamp
  // when the group uses one, e.g. metals computed_at) with status 'live'; a
  // group whose fetch failed — or whose cross-check diverged — keeps its
  // previous entry (original fetched_at) with status 'stale', so the site
  // shows an honest per-group "last updated". Per-run source overrides and
  // notes (divergence, weekend, QSE) attach here.
  const prevMeta = (prev.meta && prev.meta.groups) || {};
  const groups = {};
  for (const [key, names] of Object.entries(GROUP_SOURCES)) {
    const entry = { ...(groupSource[key] || names), fetched_at: groupFetchedAt[key] || now, status: 'live' };
    if (groupNotes[key]) entry.note = groupNotes[key];
    if (groupOk[key]) {
      groups[key] = entry;
    } else if (prevMeta[key]) {
      groups[key] = { ...prevMeta[key], status: 'stale', ...(groupNotes[key] ? { note: groupNotes[key] } : {}) };
    }
  }
  live.meta = { fetched_at: now, groups };

  // --- Notes + sources ---------------------------------------------------------
  const noteParts = [
    `Parallel USD + gold: sp-today.com (Lira Today), cross-checked against Lirascope + SYPNow, fetched ${now}.`,
    `Official rates: Central Bank of Syria bulletin ${live.bulletin || 'n/a'} (${live.bulletin_date || 'n/a'})${cbOcrApplied ? ' — full 21-currency table via Telegram @SyCBOS OCR, cross-checked vs cb.gov.sy + Frankfurter' : ' — USD row from cb.gov.sy/fx/4'}${isWeekend ? ' (weekend — no new bulletin expected)' : ''}.`,
    'Crypto: CoinGecko (Kraken fallback).',
    'FX: Frankfurter/ECB; SAR/AED/QAR are fixed pegs.',
    'Stocks: Yahoo Finance. Gulf: TradingView (DFM/ADX) + Yahoo (TASI/Brent) + Trading Economics (QSE — single source, unverified).',
    'Metals spot: goldprice.dev (primary), xaus.com (backup), Yahoo futures (tertiary).',
    'Fear & Greed: alternative.me. News: BBC Business RSS (headlines + links only). Events: Forex Factory.',
    'All lira figures are new Syrian pounds. Analysis texts are editorial and update separately.',
  ];
  if (divergenceNotes.length > 0) noteParts.push(`Cross-check divergences this run: ${divergenceNotes.join(' | ')}`);
  live.notes = noteParts.join(' ');
  live.sources = SOURCES;

  // Keep the USD table row in lock-step with syria.usd (the hero figures),
  // so the tables and the hero can never disagree on the dollar.
  syncUsdRow(live);

  // --- Validate, then write ----------------------------------------------------
  // The file is written on every valid run (even when no figure moved), so
  // fetched_at always reflects the latest successful verification — the site
  // shows visitors an honest "last updated" time. The commit history is the
  // audit trail that the loop is alive. Invalid output is never written.
  const problems = validate(live);
  if (problems.length > 0) {
    log(`FATAL: validation failed (${problems.join('; ')}) — NOT writing live.json; old file stays live`);
    process.exit(1);
  }
  const output = JSON.stringify(live, null, 2) + '\n';
  fs.mkdirSync(path.dirname(LIVE_PATH), { recursive: true });
  fs.writeFileSync(LIVE_PATH, output);
  log(`Wrote ${LIVE_PATH} (${output.length} bytes)`);

  // --- USD 30-day history file (for the Syria page chart) --------------------
  // Derived from the same daily history live.json already publishes (one
  // entry per day, max 30, today's entry updated in place) — dates
  // normalised to ISO. A write failure here must never fail the run:
  // live.json above is the critical file; the chart falls back to its cache.
  try {
    const historyPoints = (Array.isArray(live.syria.history) ? live.syria.history : [])
      .map((hh) => ({ date: toISODate(hh.date), sell: num(hh.usd_parallel_sell) }))
      .filter((pp) => pp.date && pp.sell !== null)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const historyOut = JSON.stringify({ updated_at: now, points: historyPoints.slice(-30) }, null, 2) + '\n';
    fs.writeFileSync(HISTORY_PATH, historyOut);
    log(`Wrote ${HISTORY_PATH} (${historyPoints.length} points)`);
  } catch (e) {
    log(`WARN: usd-history.json write failed (${e.message}) — live.json is unaffected`);
  }
}

main().catch((e) => {
  log(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
