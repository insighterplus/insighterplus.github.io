#!/usr/bin/env node
/**
 * Insighter+ push notification sender (FCM HTTP v1 API, zero dependencies).
 *
 * Usage:
 *   node scripts/send-notification.mjs --kind morning [--dry-run]
 *   node scripts/send-notification.mjs --kind announcement \
 *     --title-ar "..." --body-ar "..." --title-en "..." --body-en "..." \
 *     [--link https://...] [--dry-run]
 *
 * Morning mode fetches https://insighterplus.github.io/data/live.json
 * (cache-busted) and composes bilingual messages from REAL figures only:
 * parallel USD buy/sell + official (Central Bank) USD rate + gold 21k
 * buy/sell + a fuel line from the repo's data/fuel.json, with the
 * change vs yesterday when the data carries it. The fuel line is
 * optional: if fuel.json is missing or unreadable it is omitted and
 * the send still goes ahead.
 * If the feed is unreachable, a figure is
 * missing, or the data is stale (> 6 hours old), the script FAILS
 * WITHOUT SENDING — it never sends wrong or stale numbers.
 *
 * Announcement mode sends the given texts verbatim (both languages
 * required; link optional, http(s) only).
 *
 * Auth: the Firebase service-account key JSON is read from the
 * FIREBASE_SERVICE_ACCOUNT environment variable (a GitHub secret).
 * It is NEVER printed or logged. --dry-run does not need it: it prints
 * the exact messages and exits without sending.
 *
 * Messages are DATA-ONLY (no notification block) so the app renders
 * them itself with its custom sound and deep links:
 *   morning      -> {type: morning, page: syria}   (opens Syria)
 *   announcement -> {type: announcement, link?}    (opens URL or Home)
 */
import https from 'node:https';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const LIVE_JSON_URL = 'https://insighterplus.github.io/data/live.json';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MAX_DATA_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { kind: 'morning', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--kind') args.kind = argv[++i] ?? '';
    else if (a === '--title-ar') args.titleAr = argv[++i] ?? '';
    else if (a === '--body-ar') args.bodyAr = argv[++i] ?? '';
    else if (a === '--title-en') args.titleEn = argv[++i] ?? '';
    else if (a === '--body-en') args.bodyEn = argv[++i] ?? '';
    else if (a === '--link') args.link = argv[++i] ?? '';
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

// --- Morning message composition (real figures only) ---

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

/** " (↓ 0.25 vs yesterday)" — empty when there is no change to show. */
function changePart(change, decimals, vsWord) {
  if (!isNumber(change) || change === 0) return '';
  const arrow = change > 0 ? '↑' : '↓';
  const text = decimals === 0 ? fmtInt(Math.abs(change)) : fmt2(Math.abs(change));
  return ` (${arrow} ${text} ${vsWord})`;
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
    return { p95, p90, diesel, gas };
  } catch {
    return null;
  }
}

function composeMorning(live) {
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
  // USD change vs yesterday: last history sell minus the one before it
  // (same rule the app uses for its "vs yesterday" change).
  const hist = Array.isArray(syria?.history) ? syria.history : [];
  const sells = hist
    .map((h) => h?.usd_parallel_sell)
    .filter((v) => isNumber(v));
  const usdChange =
    sells.length >= 2 ? sells[sells.length - 1] - sells[sells.length - 2] : null;
  // Gold change: the updater's own field, else the history series.
  let goldChange = isNumber(gold?.change_vs_yesterday)
    ? gold.change_vs_yesterday
    : null;
  if (goldChange === null) {
    const gSells = hist.map((h) => h?.gold21k_sell).filter((v) => isNumber(v));
    goldChange =
      gSells.length >= 2
        ? gSells[gSells.length - 1] - gSells[gSells.length - 2]
        : null;
  }

  // Fuel line (optional — omitted when fuel.json is unavailable).
  const fuel = loadFuel();
  const fuelAr = fuel
    ? `\nمحروقات: بنزين 95: ${fmtInt(fuel.p95)} · 90: ${fmtInt(fuel.p90)} · مازوت: ${fmtInt(fuel.diesel)} · غاز: ${fmtInt(fuel.gas)}`
    : '';
  const fuelEn = fuel
    ? `\nFuel: petrol 95: ${fmtInt(fuel.p95)} · 90: ${fmtInt(fuel.p90)} · diesel: ${fmtInt(fuel.diesel)} · gas: ${fmtInt(fuel.gas)}`
    : '';

  const ar = {
    title: 'أسعار الصباح — سوريا',
    body:
      `دولار موازي ${fmt2(buy)} / ${fmt2(sell)}` +
      changePart(usdChange, 2, 'عن أمس') +
      ` · مركزي ${fmt2(central)}` +
      `\nذهب 21: ${fmtInt(gBuy)} / ${fmtInt(gSell)}` +
      changePart(goldChange, 0, 'عن أمس') +
      fuelAr,
  };
  const en = {
    title: 'Morning prices — Syria',
    body:
      `USD parallel ${fmt2(buy)} / ${fmt2(sell)}` +
      changePart(usdChange, 2, 'vs yesterday') +
      ` · official ${fmt2(central)}` +
      `\nGold 21k: ${fmtInt(gBuy)} / ${fmtInt(gSell)}` +
      changePart(goldChange, 0, 'vs yesterday') +
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
  if (args.kind !== 'morning' && args.kind !== 'announcement') {
    fail(`--kind must be "morning" or "announcement", got "${args.kind}"`);
  }

  let ar;
  let en;
  let dataAr;
  let dataEn;
  if (args.kind === 'morning') {
    const live = await fetchLiveJson();
    ({ ar, en } = composeMorning(live));
    dataAr = { type: 'morning', title: ar.title, body: ar.body, page: 'syria' };
    dataEn = { type: 'morning', title: en.title, body: en.body, page: 'syria' };
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
    ar = { title: args.titleAr.trim(), body: args.bodyAr.trim() };
    en = { title: args.titleEn.trim(), body: args.bodyEn.trim() };
    dataAr = { type: 'announcement', title: ar.title, body: ar.body };
    dataEn = { type: 'announcement', title: en.title, body: en.body };
    if (link) {
      dataAr.link = link;
      dataEn.link = link;
    }
  }

  console.log('--- Arabic (topic morning-prices-ar / announcements-ar) ---');
  console.log(`Title: ${ar.title}`);
  console.log(`Body:\n${ar.body}`);
  console.log('--- English (topic morning-prices-en / announcements-en) ---');
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
  const morning = args.kind === 'morning';
  const okAr = await sendToTopic(
    serviceAccount.project_id,
    token,
    morning ? 'morning-prices-ar' : 'announcements-ar',
    dataAr
  );
  const okEn = await sendToTopic(
    serviceAccount.project_id,
    token,
    morning ? 'morning-prices-en' : 'announcements-en',
    dataEn
  );
  if (!okAr || !okEn) {
    fail('one or more sends failed (see above)');
  }
  console.log('Done: both languages sent.');
}

main().catch((e) => fail(e.message ?? String(e)));
