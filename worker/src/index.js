const ALLOWED_ORIGINS = [
  'https://prachidpatel.github.io',
  'http://localhost:8080',
];

// nasa's gateway is genuinely unreliable — same date can succeed in 0.5s, time out,
// or come back with a fast 503, in any order. retry on both thrown errors (timeout/
// network) and 5xx responses; only stop early on a real answer (2xx/4xx).
async function fetchNasaWithRetry(nasaUrl, maxAttempts = 3) {
  let lastRes = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(nasaUrl, { signal: AbortSignal.timeout(6000) });
      if (res.status < 500) return res;
      lastRes = res;
    } catch {
      lastRes = null;
    }
  }
  return lastRes;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS, POST',
    Vary: 'Origin',
  };
}

function monthKeyFor(date) {
  return `month:${date.slice(0, 7)}`;
}

async function getMonth(env, monthKey) {
  try {
    const raw = await env.APOD_CACHE.get(monthKey);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error('KV get failed:', err);
    return {};
  }
}

// kv-first, month-batched: each KV key holds a whole month's worth of dates, so
// the daily archive backfill costs ~1 write per month (~370 total) instead of
// ~1 write per day (~11,300 total) — free-tier KV caps writes at 1,000/day,
// separate from nasa's own hourly limit, and that cap is what this avoids.
// writes are wrapped in try/catch: a quota error here must never break the
// actual response to a visitor — caching is a nice-to-have, not load-bearing.
// dates with a confirmed permanent gap (nasa has no apod for them) are stored
// as `null` within the month blob — `date in month` correctly treats that as a
// cache hit (unlike a plain truthiness check, which would skip null and live-
// fetch nasa pointlessly on every single request for that date, forever).
async function fetchApod(env, date) {
  const monthKey = monthKeyFor(date);
  const month = await getMonth(env, monthKey);
  if (date in month) {
    if (month[date] === null) {
      return { body: JSON.stringify({ gap: true, date }), status: 404 };
    }
    return { body: JSON.stringify(month[date]), status: 200 };
  }

  const nasaUrl = `https://api.nasa.gov/planetary/apod?api_key=${env.NASA_API_KEY}&date=${date}&hd=false`;
  const nasaRes = await fetchNasaWithRetry(nasaUrl);
  if (!nasaRes) {
    return { body: JSON.stringify({ error: 'nasa upstream unavailable' }), status: 504 };
  }

  if (nasaRes.status === 404) {
    try {
      month[date] = null;
      await env.APOD_CACHE.put(monthKey, JSON.stringify(month));
    } catch (err) {
      console.error('KV put failed (likely daily write quota):', err);
    }
    return { body: JSON.stringify({ gap: true, date }), status: 404 };
  }

  const body = await nasaRes.text();
  if (nasaRes.status === 200) {
    try {
      month[date] = JSON.parse(body);
      await env.APOD_CACHE.put(monthKey, JSON.stringify(month));
    } catch (err) {
      console.error('KV put failed (likely daily write quota):', err);
    }
  }
  return { body, status: nasaRes.status };
}

// ingestion-only: fetch straight from nasa (still via the retry logic, key stays
// server-side), but skip KV entirely. used by the bulk backfill script so it can
// gather many dates without spending the daily write quota one date at a time —
// it batches results itself and commits a whole month per write via /admin below.
async function fetchApodNoCache(env, date) {
  const nasaUrl = `https://api.nasa.gov/planetary/apod?api_key=${env.NASA_API_KEY}&date=${date}&hd=false`;
  const nasaRes = await fetchNasaWithRetry(nasaUrl);
  if (!nasaRes) {
    return { body: JSON.stringify({ error: 'nasa upstream unavailable' }), status: 504 };
  }
  return { body: await nasaRes.text(), status: nasaRes.status };
}

// admin-only bulk write: merges a whole month's worth of freshly-fetched entries
// into the existing month blob (if any) in a single KV write. auth'd by a shared
// secret the ingestion script holds — never exposed to the browser/live site.
async function handleAdminBulkPut(request, env) {
  if (request.headers.get('X-Admin-Token') !== env.ADMIN_TOKEN) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }
  const { month, entries } = await request.json();
  if (!month || !entries) {
    return new Response(JSON.stringify({ error: 'missing month or entries' }), { status: 400 });
  }
  const monthKey = `month:${month}`;
  const existing = await getMonth(env, monthKey);
  const merged = { ...existing, ...entries };
  try {
    await env.APOD_CACHE.put(monthKey, JSON.stringify(merged));
  } catch (err) {
    console.error('admin bulk put failed (likely daily write quota):', err);
    return new Response(JSON.stringify({ error: 'kv write failed', detail: String(err) }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: true, count: Object.keys(merged).length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const BACKFILL_START = '1995-06-16';
const BACKFILL_BATCH_SIZE = 40;       // dates attempted per cron firing, under good conditions
const BACKFILL_TIME_BUDGET_MS = 4 * 60 * 1000; // bail out early if a bad NASA patch eats time, well under
                                                // both the 5min cron interval and the 15min hard wall cap
const BACKFILL_OUTAGE_THRESHOLD = 8;  // consecutive failures within one batch before bailing for this round

function daysInMonth(year, month) { // month is 1-12
  return new Date(year, month, 0).getDate();
}

function datesInMonth(monthStr, earliestDate) {
  const [y, m] = monthStr.split('-').map(Number);
  const dates = [];
  for (let d = 1; d <= daysInMonth(y, m); d++) {
    const date = `${monthStr}-${String(d).padStart(2, '0')}`;
    if (earliestDate && date < earliestDate) continue;
    dates.push(date);
  }
  return dates;
}

function nextMonthOf(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const month = m === 12 ? 1 : m + 1;
  const year = m === 12 ? y + 1 : y;
  return `${year}-${String(month).padStart(2, '0')}`;
}

// cron-driven backfill: processes a small batch of historical dates per firing,
// fully cloud-native (no local script/laptop dependency). progress is tracked as
// a single "which month are we on" cursor in KV rather than a per-date list, and
// confirmed permanent gaps (nasa has no entry for that date) are stored as `null`
// within the month's own blob — both choices avoid needing extra KV keys/writes.
// each invocation does at most one KV write, so even at the minimum 1-minute cron
// granularity this stays an order of magnitude under the 1,000 writes/day cap;
// running every 5 minutes (see wrangler.toml) leaves generous headroom for live
// traffic + the daily "yesterday" cron sharing the same budget.
async function runBackfillBatch(env) {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const lastMonth = yesterday.slice(0, 7);

  let currentMonth = await env.APOD_CACHE.get('backfill:current_month');
  if (!currentMonth) currentMonth = BACKFILL_START.slice(0, 7);
  if (currentMonth > lastMonth) return; // backfill fully complete, nothing to do

  const monthKey = `month:${currentMonth}`;
  const month = await getMonth(env, monthKey);

  const allDates = datesInMonth(currentMonth, currentMonth === BACKFILL_START.slice(0, 7) ? BACKFILL_START : null)
    .filter(d => d <= yesterday);
  const missing = allDates.filter(d => !(d in month));

  if (!missing.length) {
    try {
      await env.APOD_CACHE.put('backfill:current_month', nextMonthOf(currentMonth));
    } catch (err) {
      console.error('backfill cursor write failed:', err);
    }
    return;
  }

  const batch = missing.slice(0, BACKFILL_BATCH_SIZE);
  const batchStart = Date.now();
  let consecutiveFailures = 0;
  let changed = false;

  for (const date of batch) {
    if (Date.now() - batchStart > BACKFILL_TIME_BUDGET_MS) break;

    const nasaUrl = `https://api.nasa.gov/planetary/apod?api_key=${env.NASA_API_KEY}&date=${date}&hd=false`;
    const res = await fetchNasaWithRetry(nasaUrl);

    if (!res) {
      consecutiveFailures++;
      if (consecutiveFailures >= BACKFILL_OUTAGE_THRESHOLD) break;
      continue;
    }
    if (res.status === 429) break; // rate-limited — back off until the next firing
    if (res.status === 404) {
      month[date] = null; // confirmed permanent gap
      changed = true;
      consecutiveFailures = 0;
      continue;
    }
    if (res.status >= 500) {
      consecutiveFailures++;
      if (consecutiveFailures >= BACKFILL_OUTAGE_THRESHOLD) break;
      continue;
    }
    if (res.status === 200) {
      try {
        month[date] = JSON.parse(await res.text());
        changed = true;
        consecutiveFailures = 0;
      } catch (err) {
        console.error(`backfill: failed to parse nasa response for ${date}:`, err);
      }
    }
  }

  if (changed) {
    try {
      await env.APOD_CACHE.put(monthKey, JSON.stringify(month));
    } catch (err) {
      console.error('backfill month write failed (likely daily write quota):', err);
    }
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(allowed ? origin : ALLOWED_ORIGINS[0]) });
    }

    if (request.method === 'POST') {
      return handleAdminBulkPut(request, env);
    }

    if (!allowed) {
      return new Response(JSON.stringify({ error: 'origin not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(request.url);
    const date = url.searchParams.get('date');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return new Response(JSON.stringify({ error: 'invalid date' }), {
        status: 400,
        headers: corsHeaders(origin),
      });
    }

    const { body, status } = url.searchParams.get('nocache') === '1'
      ? await fetchApodNoCache(env, date)
      : await fetchApod(env, date);

    return new Response(body, {
      status,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  },

  async scheduled(event, env, ctx) {
    if (event.cron === '0 6 * * *') {
      // daily: nasa usually publishes "today's" apod throughout the day, so
      // grabbing yesterday's (now-stable) entry once a day keeps the archive
      // current with zero manual upkeep.
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      await fetchApod(env, yesterday);
    } else {
      // every 5 minutes: historical backfill batch — see runBackfillBatch.
      await runBackfillBatch(env);
    }
  },
};
