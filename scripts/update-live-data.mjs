// Insighter+ live-data updater.
// Runs in GitHub Actions every 30 minutes. Fully automatic, zero-touch:
// every source is optional; on any failure the last good figure is kept,
// the file is only written after validation, and the next run retries.
// No Google services, no API keys, no accounts. All sources are free
// public endpoints. All lira figures are NEW Syrian pounds (SYP).
//
// Usage: node scripts/update-live-data.mjs
// Reads: data/live.json (previous state) or scripts/seed.json (first run).
// Writes: data/live.json (only if valid and changed).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_PATH = path.join(ROOT, 'data', 'live.json');
const SEED_PATH = path.join(ROOT, 'scripts', 'seed.json');
const TIMEOUT_MS = 15000;
const UA = 'Mozilla/5.0 (compatible; InsighterPlusBot/1.0; +https://insighterplus.github.io/)';

// ---------------------------------------------------------------- helpers

function log(...args) { console.log(new Date().toISOString(), ...args); }

async function fetchText(url, { retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal, redirect: 'follow' });
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

// ---------------------------------------------------------------- sources

const SOURCES = {}; // name -> { status: 'ok'|'stale'|'failed', fetched_at, error? }
function markSource(name, status, error) {
  SOURCES[name] = { status, fetched_at: new Date().toISOString(), ...(error ? { error: String(error).slice(0, 200) } : {}) };
}

// --- Syria: parallel rates + gold from sp-today.com (Lira Today) ---------
// Homepage: USD buy/sell, gold 21k/24k/18k buy/sell, gold + silver ounce.
// /currencies: buy/sell for all 30 currencies vs the new Syrian pound.

const PARALLEL_CODES = ['USD', 'EUR', 'TRY', 'SAR', 'AED', 'EGP', 'LYD', 'JOD', 'KWD', 'GBP', 'QAR', 'BHD', 'SEK', 'CAD', 'OMR', 'NOK', 'DKK', 'DZD', 'MAD', 'TND', 'RUB', 'MYR', 'BRL', 'NZD', 'CHF', 'AUD', 'ZAR', 'SGD'];

async function fetchSpToday() {
  const home = stripTags(await fetchText('https://sp-today.com/'));
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
  for (const [key, karat] of [['gold24k', '24K'], ['gold21k', '21K'], ['gold18k', '18K']]) {
    const m = home.match(new RegExp(`${karat}\\s+\\$([\\d,]+\\.?\\d*)\\s+([\\d,]+\\.?\\d*)\\s+([\\d,]+\\.?\\d*)`));
    if (m) gold[key] = { usd_per_gram: num(m[1]), buy: num(m[2]), sell: num(m[3]) };
  }
  if (!gold.gold21k) throw new Error('gold 21k not found on sp-today home');

  const ounce = home.match(/أونصة الذهب\s+\$([\d,]+\.?\d*)/);
  const silverOunce = home.match(/أونصة الفضة\s+\$\s*([\d,]+\.?\d*)/);

  return { parallelUSD, gold, goldOunceUSD: ounce ? num(ounce[1]) : null, silverOunceUSD: silverOunce ? num(silverOunce[1]) : null, parallel };
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

// --- Yahoo Finance chart (stocks, indices, metals, oil, ETF proxies) ------
async function fetchYahoo(symbol) {
  const data = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`);
  const result = data.chart && data.chart.result && data.chart.result[0];
  if (!result) throw new Error(`Yahoo: no data for ${symbol}`);
  const meta = result.meta;
  return {
    symbol: meta.symbol,
    price: num(meta.regularMarketPrice),
    change_pct: round(num(meta.regularMarketChangePercent), 2),
    previous_close: num(meta.chartPreviousClose || meta.previousClose),
    currency: meta.currency || 'USD',
  };
}

const YAHOO_SYMBOLS = {
  stocks: ['^GSPC', '^NDX', '^DJI', 'AAPL', 'MSFT', 'NVDA', 'DX-Y.NYB'],
  metals: ['GC=F', 'SI=F'],
  gulf: ['^TASI.SR', 'BZ=F', 'UAE', 'QAT'],
};

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
  metals: { source: 'Yahoo Finance', source_ar: 'ياهو فاينانس' },
  gulf: { source: 'Yahoo Finance', source_ar: 'ياهو فاينانس' },
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
  if (!Array.isArray(live.news) || live.news.length === 0) problems.push('missing news');
  if (!Array.isArray(live.events) || live.events.length === 0) problems.push('missing events');
  return problems;
}

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
  const groupOk = {}; // group key -> true when its fetch succeeded this run

  // --- Syria ---------------------------------------------------------------
  try {
    const sp = await fetchSpToday();
    markSource('sp_today', 'ok');
    groupOk.syria_parallel = true;
    groupOk.syria_gold = true;
    live.syria.usd.parallel_buy = sp.parallelUSD.buy;
    live.syria.usd.parallel_sell = sp.parallelUSD.sell;
    // Change vs yesterday: compare against the last history entry dated
    // BEFORE today (not the last run, which may already be today's value).
    const historyBefore = (Array.isArray(live.syria.history) ? live.syria.history : []).filter((h) => h.date < today);
    const yesterdayGold = historyBefore.length ? historyBefore[historyBefore.length - 1].gold21k_sell : null;
    live.syria.gold21k = { buy: sp.gold.gold21k.buy, sell: sp.gold.gold21k.sell, change_vs_yesterday: yesterdayGold ? round(sp.gold.gold21k.sell - yesterdayGold) : null };
    if (sp.gold.gold24k) live.syria.gold24k = { buy: sp.gold.gold24k.buy, sell: sp.gold.gold24k.sell, usd_per_gram: sp.gold.gold24k.usd_per_gram };
    if (sp.gold.gold18k) live.syria.gold18k = { buy: sp.gold.gold18k.buy, sell: sp.gold.gold18k.sell, usd_per_gram: sp.gold.gold18k.usd_per_gram };
    if (sp.goldOunceUSD) live.syria.gold_ounce_usd = sp.goldOunceUSD;
    if (sp.silverOunceUSD) live.syria.silver_ounce_usd = sp.silverOunceUSD;
    // Parallel rates for the 28-currency table. IQD is skipped: sp-today
    // rounds it to 0.10/0.10, losing the precision of the last verified value.
    for (const row of live.syria.currencies) {
      if (row.code === 'IQD') continue;
      const p = sp.parallel[row.code];
      if (p && p.buy !== p.sell) { row.parallel_buy = p.buy; row.parallel_sell = p.sell; }
    }
    // History: one entry per day for the 30-day trend.
    const history = Array.isArray(live.syria.history) ? live.syria.history : [];
    const lastEntry = history[history.length - 1];
    if (!lastEntry || lastEntry.date !== today) {
      history.push({ date: today, usd_parallel_sell: sp.parallelUSD.sell, gold21k_sell: sp.gold.gold21k.sell });
      live.syria.history = history.slice(-30);
    } else {
      lastEntry.usd_parallel_sell = sp.parallelUSD.sell;
      lastEntry.gold21k_sell = sp.gold.gold21k.sell;
    }
    live.syria.last_updated = today;
  } catch (e) {
    markSource('sp_today', 'stale', e);
    log(`WARN: sp-today failed (${e.message}) — keeping last good Syria figures`);
  }

  // --- Central Bank bulletin ------------------------------------------------
  try {
    const cb = await fetchCentralBank();
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
    const fx = await fetchFX();
    markSource('frankfurter', 'ok');
    groupOk.fx = true;
    // Fixed Gulf pegs (Frankfurter/ECB does not publish SAR/AED/QAR).
    const rates = { ...fx.rates, SAR: 0.26667, AED: 0.27226, QAR: 0.27473 };
    live.fx = { date: fx.date, base: 'USD', rates, pegs: { SAR: 3.75, AED: 3.6725, QAR: 3.64 } };
  } catch (e) {
    markSource('frankfurter', 'stale', e);
    log(`WARN: Frankfurter failed (${e.message}) — keeping last good FX`);
  }

  // --- Yahoo: stocks / metals / Gulf ----------------------------------------
  for (const [section, symbols] of Object.entries(YAHOO_SYMBOLS)) {
    if (!live[section]) live[section] = {};
    for (const symbol of symbols) {
      try {
        live[section][symbol] = await fetchYahoo(symbol);
        markSource(`yahoo:${symbol}`, 'ok');
        groupOk[section] = true;
      } catch (e) {
        markSource(`yahoo:${symbol}`, 'stale', e);
        log(`WARN: Yahoo ${symbol} failed (${e.message}) — keeping last good value`);
      }
    }
  }
  // Gulf labels: TASI + Brent are the real benchmarks; UAE/QAT are
  // NYSE-listed ETFs used as market proxies (the DFM/ADX/QE indices are
  // not published on any free keyless feed). Labels only attach to entries
  // that actually carry a price, so a failed first fetch never writes a
  // label-only (broken) entry.
  if (live.gulf) {
    const gulfLabels = { '^TASI.SR': 'Saudi Tadawul (TASI)', 'BZ=F': 'Brent crude', UAE: 'UAE markets (ETF proxy)', QAT: 'Qatar market (ETF proxy)' };
    for (const [symbol, label] of Object.entries(gulfLabels)) {
      if (live.gulf[symbol] && num(live.gulf[symbol].price)) live.gulf[symbol].label = label;
      else delete live.gulf[symbol];
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
  }

  // --- Per-group source + last-update metadata -------------------------------
  // A refreshed group gets fetched_at = now with status 'live'; a group whose
  // fetch failed keeps its previous entry (original fetched_at) with status
  // 'stale', so the site shows an honest per-group "last updated".
  const prevMeta = (prev.meta && prev.meta.groups) || {};
  const groups = {};
  for (const [key, names] of Object.entries(GROUP_SOURCES)) {
    if (groupOk[key]) {
      groups[key] = { ...names, fetched_at: now, status: 'live' };
    } else if (prevMeta[key]) {
      groups[key] = { ...prevMeta[key], status: 'stale' };
    }
  }
  live.meta = { fetched_at: now, groups };

  // --- Notes + sources ---------------------------------------------------------
  live.sources = SOURCES;
  live.notes = `Parallel rates + gold: sp-today.com (Lira Today), fetched ${now}. Official USD: Central Bank of Syria bulletin (cb.gov.sy/fx/4), latest ${live.bulletin_date || 'n/a'}. Crypto: CoinGecko (Kraken fallback). FX: Frankfurter/ECB; SAR/AED/QAR are fixed pegs. Stocks/metals/oil/Gulf: Yahoo Finance. Fear & Greed: alternative.me. News: BBC Business RSS (headlines + links only). Events: Forex Factory. All lira figures are new Syrian pounds. Analysis texts are editorial and update separately.`;

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
}

main().catch((e) => {
  log(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
