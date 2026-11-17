#!/usr/bin/env node
/**
 * Insighter+ push notification sender (FCM HTTP v1 API, zero dependencies).
 *
 * Usage:
 *   node scripts/send-notification.mjs --kind morning [--dry-run]
 *   node scripts/send-notification.mjs --kind evening [--dry-run]
 *   node scripts/send-notification.mjs --kind now [--dry-run]
 *   node scripts/send-notification.mjs --kind announcement \
 *     --title-ar "..." --body-ar "..." --title-en "..." --body-en "..." \
 *     [--page <page>] [--link https://...] [--dry-run]
 *   Any kind accepts --test: the message goes ONLY to the
 *   test-notifications topics (subscribed by Badr's admin app alone),
 *   never to the public topics.
 *
 * Morning (10:00 Damascus), evening (20:00 Damascus) and now (instant,
 * on-demand from Badr's admin app) modes fetch
 * https://insighterplus.github.io/data/live.json (cache-busted) and
 * compose the SAME bilingual prices message from REAL figures only:
 * parallel USD buy/sell + official (Central Bank) USD rate + gold 21k
 * buy/sell + a fuel line from the repo's data/fuel.json. Only the
 * TITLE differs (morning vs evening vs now). Change vs yesterday shows ONLY
 * on the fuel line (Badr's rule, 16 Nov 2026) — never on the USD or
 * gold lines — and NO status line is shown at all when fuel prices
 * are unchanged (Badr's rule, 16 Nov 2026 evening: the "no change"
 * phrase was removed). The fuel line is optional: if fuel.json is
 * missing or unreadable it is omitted and the send still goes ahead.
 * If the feed is unreachable, a figure is missing, or the data is
 * stale (> 6 hours old), the script FAILS WITHOUT SENDING — it never
 * sends wrong or stale numbers.
 *
 * Prices modes and their topics (migrated 17 Nov 2026 for app v2.1.0,
 * which subscribes to the evening and decisions topics and parses the
 * "evening" and "decisions" kinds):
 *   morning -> type "morning", morning-prices topics (page: syria)
 *   evening -> type "evening", evening-prices topics (page: syria)
 *   now     -> type "morning", morning-prices topics (page: syria) —
 *              the app has no "now" kind, so the instant bulletin rides
 *              the morning type; the title carries the distinction.
 * Announcements with --page decisions send type "decisions" to the
 * decisions topics; all other announcements send type "announcement"
 * to the announcements topics.
 *
 * Announcement mode sends the given texts verbatim (both languages
 * required; link optional, http(s) only; --page optional — one of the
 * known app pages, deep-links the tap to that section).
 *
 * Auth: the Firebase service-account key JSON is read from the
 * FIREBASE_SERVICE_ACCOUNT environment variable (a GitHub secret).
 * It is NEVER printed or logged. --dry-run does not need it: it prints
 * the exact messages and exits without sending.
 *
 * Messages are DATA-ONLY (no notification block) so the app renders
 * them itself with its custom sound and deep links:
 *   morning, now -> {type: morning, page: syria} (opens Syria)
 *   evening      -> {type: evening, page: syria} (opens Syria)
 *   announcement (page=decisions) -> {type: decisions, page: decisions}
 *   announcement -> {type: announcement, link?, page?}
 *     (opens the link when given, else the page's section, else Home)
 */
import https from 'node:https';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const LIVE_JSON_URL = 'https://insighterplus.github.io/data/live.json';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MAX_DATA_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

// Thin rule separating the three blocks of the morning body (20
// box-drawing characters — short enough never to wrap in a notification).
const BODY_RULE = '────────────────────';

// Known app pages a notification tap may deep-link to (--page values).
// Validated for announcement mode: an unknown page fails loudly instead
// of silently opening Home. (The app maps "assets" to its Markets
// section and "pulse"/"analysis"/"about" to their merged equivalents.)
const KNOWN_PAGES = new Set([
  'home', 'syria', 'decisions', 'pulse', 'assets', 'mideast', 'world',
  'analysis', 'measure', 'trust', 'about', 'contact',
]);

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { kind: 'morning', dryRun: false, test: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--test') args.test = true;
    else if (a === '--kind') args.kind = argv[++i] ?? '';
    else if (a === '--title-ar') args.titleAr = argv[++i] ?? '';
    else if (a === '--body-ar') args.bodyAr = argv[++i] ?? '';
    else if (a === '--title-en') args.titleEn = argv[++i] ?? '';
    else if (a === '--body-en') args.bodyEn = argv[++i] ?? '';
    else if (a === '--link') args.link = argv[++i] ?? '';
    else if (a === '--page') args.page = argv[++i] ?? '';
    else fail(`unknown argument: ${a}`);
  }
  return args;
}

// --- Minimal HTTPS helpers (no dependencies) ---

function httpsRequest(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // Non-JSON response — leave json null.
        }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('request timed out')));
    if (body) req.write(body);
    req.end();
  });
}

function httpsPostForm(url, params) {
  const body = new URLSearchParams(params).toString();
  return httpsRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

// --- Firebase auth (service-account JWT -> OAuth2 access token) ---

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      sub: serviceAccount.client_email,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
      scope: FCM_SCOPE,
    })
  );
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(unsigned),
    serviceAccount.private_key
  );
  const jwt = `${unsigned}.${signature.toString('base64url')}`;
  const { status, json } = await httpsPostForm(TOKEN_URL, {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });
  if (status !== 200 || !json?.access_token) {
    fail(`Firebase token exchange failed (HTTP ${status})`);
  }
  return json.access_token;
}

async function sendToTopic(projectId, token, topic, data) {
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  const { status, json, text } = await httpsRequest(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: { topic, data } }),
  });
  if (status !== 200) {
    console.error(
      `FCM send to ${topic} failed (HTTP ${status}): ${text.slice(0, 500)}`
    );
    return false;
  }
  console.log(`Sent to ${topic} (message ${json?.name ?? '?'})`);
  return true;
}

// --- Prices message composition (real figures only) ---

function fmt2(n) {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtInt(n) {
  return Math.round(n).toLocaleString('en-US');
}

function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// --- Fuel prices (optional) ---
// Read from the repo checkout (data/fuel.json, committed alongside this
// script). Returns the 4 main prices or null — any problem means the fuel
// line is simply omitted, never a failed send.
function loadFuel() {
  try {
    const raw = readFileSync(
      new URL('../data/fuel.json', import.meta.url),
      'utf8'
    );
    const data = JSON.parse(raw);
    const byId = {};
    for (const item of data?.items ?? []) {
      if (item?.id && isNumber(item.price)) byId[item.id] = item.price;
    }
    const p95 = byId.petrol95;
    const p90 = byId.petrol90;
    const diesel = byId.diesel1;
    const gas = byId.gas_home;
    if (![p95, p90, diesel, gas].every(isNumber)) return null;
    // bulletin_date drives the fuel status line: a bulletin from an
    // earlier day means the same prices were in effect yesterday.
    // `previous` (optional) holds the previous bulletin's prices by
    // item id — when fuel.json is updated with a new bulletin, the old
    // prices are preserved there so the message can say what changed.
    const prev = data?.previous;
    const previous = {};
    if (prev && typeof prev === 'object') {
      for (const [id, v] of Object.entries(prev)) {
        if (isNumber(v)) previous[id] = v;
      }
    }
    return {
      p95,
      p90,
      diesel,
      gas,
      bulletinDate:
        typeof data?.bulletin_date === 'string' ? data.bulletin_date : null,
      previous,
    };
  } catch {
    return null;
  }
}

// Fuel status line for the prices message, shown on its own line under
// the fuel prices (bare text, no parentheses — the layout puts it on a
// line of its own). It appears ONLY when something actually changed:
// - bulletin from an earlier day: prices unchanged — NO status line
//   (Badr's rule, 16 Nov 2026 evening: the "no change" phrase was
//   removed; silence means no change).
// - bulletin issued today: new bulletin; per-item changes when the
//   previous prices are recorded in fuel.json ("previous" by item id).
//   When the new bulletin carries identical prices, again NO status.
// - no/invalid bulletin date: no status (prices shown without a claim).
function fuelStatusText(fuel) {
  const today = new Date().toLocaleDateString('en-CA', {
    timeZone: 'Asia/Damascus',
  });
  const bulletin = fuel?.bulletinDate;
  if (typeof bulletin !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(bulletin)) {
    return { ar: '', en: '' };
  }
  if (bulletin < today) {
    // Unchanged prices — no status line at all (Badr's rule).
    return { ar: '', en: '' };
  }
  if (bulletin > today) {
    return { ar: '', en: '' };
  }
  // New bulletin today.
  const prev = fuel.previous ?? {};
  const items = [
    ['petrol95', fuel.p95, 'بنزين 95', 'petrol 95'],
    ['petrol90', fuel.p90, 'بنزين 90', 'petrol 90'],
    ['diesel1', fuel.diesel, 'مازوت', 'diesel'],
    ['gas_home', fuel.gas, 'غاز منزلي', 'household gas'],
  ];
  const changedAr = [];
  const changedEn = [];
  let havePrev = false;
  for (const [id, cur, labelAr, labelEn] of items) {
    const old = prev[id];
    if (!isNumber(old)) continue;
    havePrev = true;
    const delta = cur - old;
    if (delta === 0) continue;
    const arrow = delta > 0 ? '↑' : '↓';
    changedAr.push(`${labelAr}: ${arrow} ${fmtInt(Math.abs(delta))}`);
    changedEn.push(`${labelEn}: ${arrow} ${fmtInt(Math.abs(delta))}`);
  }
  if (!havePrev) {
    return { ar: 'نشرة جديدة اليوم', en: 'new bulletin today' };
  }
  if (changedAr.length === 0) {
    // New bulletin, identical prices — no status line (Badr's rule).
    return { ar: '', en: '' };
  }
  return {
    ar: `نشرة جديدة: ${changedAr.join(' · ')}`,
    en: `new bulletin: ${changedEn.join(' · ')}`,
  };
}

function composePrices(live, kind) {
  const syria = live?.syria;
  const usd = syria?.usd;
  const gold = syria?.gold21k;
  const buy = usd?.parallel_buy;
  const sell = usd?.parallel_sell;
  const central = usd?.central_sell; // the single official CB rate
  const gBuy = gold?.buy;
  const gSell = gold?.sell;
  if (![buy, sell, central, gBuy, gSell].every(isNumber)) {
    fail(
      'live.json is missing a required figure (parallel USD buy/sell, ' +
        'official USD rate or gold 21k buy/sell) — not sending'
    );
  }
  const fetchedAt = Date.parse(live?.fetched_at ?? '');
  if (!Number.isFinite(fetchedAt)) {
    fail('live.json has no fetched_at timestamp — not sending');
  }
  if (Date.now() - fetchedAt > MAX_DATA_AGE_MS) {
    fail(
      `live.json is stale (fetched_at ${live.fetched_at}, older than 6h) — not sending`
    );
  }
  // Fuel block (optional — omitted when fuel.json is unavailable): a
  // header line and two item lines, plus a status line ONLY when a new
  // bulletin actually changed a price. Unchanged prices show no status
  // at all (Badr's rule, 16 Nov 2026 evening).
  const fuel = loadFuel();
  const fuelStatus = fuel ? fuelStatusText(fuel) : { ar: '', en: '' };
  const fuelAr = fuel
    ? `\nمحروقات\nبنزين نوع 95: ${fmtInt(fuel.p95)} · بنزين نوع 90: ${fmtInt(fuel.p90)}\nمازوت: ${fmtInt(fuel.diesel)} · غاز منزلي: ${fmtInt(fuel.gas)}` +
      (fuelStatus.ar ? `\n${fuelStatus.ar}` : '')
    : '';
  const fuelEn = fuel
    ? `\nFuel\npetrol 95: ${fmtInt(fuel.p95)} · petrol 90: ${fmtInt(fuel.p90)}\ndiesel: ${fmtInt(fuel.diesel)} · household gas: ${fmtInt(fuel.gas)}` +
      (fuelStatus.en ? `\n${fuelStatus.en}` : '')
    : '';

  // Body layout: three tidy blocks separated by a thin rule — USD
  // (parallel buy/sell, then the official rate), gold 21k (buy/sell),
  // and fuel (header, two item lines, and a status line ONLY when a
  // new bulletin changed a price — the ONLY place a change vs
  // yesterday appears). Line 1 always carries the parallel USD
  // figures, so the collapsed notification already shows the headline
  // number. Only the title differs between morning, evening and now.
  const titles = {
    morning: { ar: 'أسعار الصباح — سوريا', en: 'Morning prices — Syria' },
    evening: { ar: 'أسعار المساء — سوريا', en: 'Evening prices — Syria' },
    now: { ar: 'أسعار الصرف الآن', en: 'Exchange rates now' },
  };
  const t = titles[kind] ?? titles.morning;
  const ar = {
    title: t.ar,
    body:
      `دولار موازي: شراء ${fmt2(buy)} · بيع ${fmt2(sell)}` +
      `\nدولار مركزي: ${fmt2(central)}` +
      `\n${BODY_RULE}` +
      `\nذهب عيار 21: شراء ${fmtInt(gBuy)} · بيع ${fmtInt(gSell)}` +
      (fuel ? `\n${BODY_RULE}` : '') +
      fuelAr,
  };
  const en = {
    title: t.en,
    body:
      `USD parallel: buy ${fmt2(buy)} · sell ${fmt2(sell)}` +
      `\nUSD official: ${fmt2(central)}` +
      `\n${BODY_RULE}` +
      `\nGold 21k: buy ${fmtInt(gBuy)} · sell ${fmtInt(gSell)}` +
      (fuel ? `\n${BODY_RULE}` : '') +
      fuelEn,
  };
  return { ar, en };
}

async function fetchLiveJson() {
  const url = `${LIVE_JSON_URL}?_t=${Date.now()}`;
  let res;
  try {
    res = await httpsRequest(url);
  } catch (e) {
    fail(`could not fetch live.json: ${e.message} — not sending`);
  }
  if (res.status !== 200 || !res.json) {
    fail(`live.json fetch failed (HTTP ${res.status}) — not sending`);
  }
  return res.json;
}

// --- Main ---

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (
    args.kind !== 'morning' &&
    args.kind !== 'evening' &&
    args.kind !== 'now' &&
    args.kind !== 'announcement'
  ) {
    fail(
      `--kind must be "morning", "evening", "now" or "announcement", got "${args.kind}"`
    );
  }

  let ar;
  let en;
  let dataAr;
  let dataEn;
  // Decisions announcements (page=decisions) go to the decisions
  // topics with type "decisions" (app v2.1.0); set in the branch below.
  let isDecisions = false;
  if (args.kind === 'morning' || args.kind === 'evening' || args.kind === 'now') {
    const live = await fetchLiveJson();
    ({ ar, en } = composePrices(live, args.kind));
    // Evening has its own type + topics (app v2.1.0); morning and now
    // share the morning type (the app has no "now" kind — the title
    // carries the distinction). See the header comment.
    const pricesType = args.kind === 'evening' ? 'evening' : 'morning';
    dataAr = { type: pricesType, title: ar.title, body: ar.body, page: 'syria' };
    dataEn = { type: pricesType, title: en.title, body: en.body, page: 'syria' };
  } else {
    if (!args.titleAr?.trim() || !args.bodyAr?.trim()) {
      fail('announcement mode requires --title-ar and --body-ar');
    }
    if (!args.titleEn?.trim() || !args.bodyEn?.trim()) {
      fail('announcement mode requires --title-en and --body-en');
    }
    const link = args.link?.trim() || '';
    if (link && !/^https?:\/\//i.test(link)) {
      fail(`--link must be an http(s) URL, got "${link}"`);
    }
    // --page: deep-link target for the tap. Validated against the known
    // app pages — a typo'd page fails here instead of being passed as
    // --link (which rejected it) or silently opening Home.
    const page = (args.page ?? '').trim().toLowerCase();
    if (page && !KNOWN_PAGES.has(page)) {
      fail(
        `--page must be one of: ${[...KNOWN_PAGES].join(', ')}, ` +
          `got "${args.page}"`
      );
    }
    ar = { title: args.titleAr.trim(), body: args.bodyAr.trim() };
    en = { title: args.titleEn.trim(), body: args.bodyEn.trim() };
    isDecisions = page === 'decisions';
    const annType = isDecisions ? 'decisions' : 'announcement';
    dataAr = { type: annType, title: ar.title, body: ar.body };
    dataEn = { type: annType, title: en.title, body: en.body };
    if (page) {
      dataAr.page = page;
      dataEn.page = page;
    }
    if (link) {
      dataAr.link = link;
      dataEn.link = link;
    }
  }

  const prices =
    args.kind === 'morning' || args.kind === 'evening' || args.kind === 'now';
  // --test: the message goes ONLY to the test topics (Badr's admin app
  // subscribes to them), never to the public topics.
  const topicAr = args.test
    ? 'test-notifications-ar'
    : args.kind === 'evening'
      ? 'evening-prices-ar'
      : prices
        ? 'morning-prices-ar'
        : isDecisions
          ? 'decisions-ar'
          : 'announcements-ar';
  const topicEn = args.test
    ? 'test-notifications-en'
    : args.kind === 'evening'
      ? 'evening-prices-en'
      : prices
        ? 'morning-prices-en'
        : isDecisions
          ? 'decisions-en'
          : 'announcements-en';
  console.log(`--- Arabic (topic ${topicAr}) ---`);
  console.log(`Title: ${ar.title}`);
  console.log(`Body:\n${ar.body}`);
  console.log(`--- English (topic ${topicEn}) ---`);
  console.log(`Title: ${en.title}`);
  console.log(`Body:\n${en.body}`);
  console.log(`Data: ${JSON.stringify(dataAr)}`);

  if (args.dryRun) {
    console.log('\n[DRY RUN] Nothing sent.');
    return;
  }

  const keyJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!keyJson) {
    fail('FIREBASE_SERVICE_ACCOUNT secret is not set');
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(keyJson);
  } catch {
    fail('FIREBASE_SERVICE_ACCOUNT is not valid JSON');
  }
  if (
    !serviceAccount.project_id ||
    !serviceAccount.client_email ||
    !serviceAccount.private_key
  ) {
    fail('FIREBASE_SERVICE_ACCOUNT is missing project_id, client_email or private_key');
  }
  const token = await getAccessToken(serviceAccount);
  const okAr = await sendToTopic(
    serviceAccount.project_id,
    token,
    topicAr,
    dataAr
  );
  const okEn = await sendToTopic(
    serviceAccount.project_id,
    token,
    topicEn,
    dataEn
  );
  if (!okAr || !okEn) {
    fail('one or more sends failed (see above)');
  }
  console.log('Done: both languages sent.');
}

main().catch((e) => fail(e.message ?? String(e)));
