// one-time (long-running) bulk ingestion of nasa's apod archive into the
// pokepod-proxy worker's KV namespace. resumable — safe to kill and re-run.
//
// usage: ADMIN_TOKEN=... node scripts/build-apod-archive.mjs
//
// fetches each date via the worker's nocache passthrough (still NASA-key-backed
// retry logic server-side, just skips KV) and batches a whole month's worth of
// entries into ONE admin bulk-write call — KV free tier caps writes at 1,000/day
// (separate from nasa's own 1,000/hour key cap), and one-write-per-date would
// blow through that almost immediately for an ~11,300-date archive. batching by
// month brings the total down to ~370 writes, comfortably under the daily cap.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORK_DIR = path.join(__dirname, 'apod-archive');
const PROGRESS_FILE = path.join(WORK_DIR, 'progress.json'); // dates with real cached data
const GAPS_FILE = path.join(WORK_DIR, 'gaps.json');         // dates nasa confirms have no entry (permanent)
const FAILED_FILE = path.join(WORK_DIR, 'failed.json');     // transient failures, eligible for retry

const WORKER_URL = 'https://pokepod-proxy.prachidpatel1.workers.dev';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const START_DATE = '1995-06-16';
// gentler pace (~450/hr) — month-batching already solved the real bottleneck
// (KV's 1,000 writes/day cap), so there's no need to race NASA's hourly cap
// anymore. this leaves real headroom for live site traffic + the daily cron
// backfill to share the same key without contention, so dev/live use doesn't
// need to pause for this to run.
const PACE_MS = 8000;
const BACKOFF_MS = 30000;    // extra wait after an ordinary failure (5xx/network)
const RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000; // longer cool-down specifically for 429 — we're at the ceiling
const OUTAGE_THRESHOLD = 8;                   // consecutive failures before we assume a real outage, not a blip
const OUTAGE_BACKOFF_MS = 5 * 60 * 1000;      // pause to let nasa's infra recover instead of hammering a dead patch

if (!ADMIN_TOKEN) {
  console.error('set ADMIN_TOKEN env var (the worker secret) before running this script');
  process.exit(1);
}

fs.mkdirSync(WORK_DIR, { recursive: true });

function dateRange(start, endInclusive) {
  const dates = [];
  let d = new Date(start + 'T00:00:00Z');
  const end = new Date(endInclusive + 'T00:00:00Z');
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

function loadSet(file) {
  try { return new Set(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch { return new Set(); }
}

function saveSet(file, set) {
  fs.writeFileSync(file, JSON.stringify([...set]));
}

function loadFailed() {
  try { return JSON.parse(fs.readFileSync(FAILED_FILE, 'utf8')); }
  catch { return {}; }
}

function saveFailed(failedMap) {
  fs.writeFileSync(FAILED_FILE, JSON.stringify(failedMap, null, 2));
}

async function fetchDateNoCache(date) {
  const res = await fetch(`${WORKER_URL}/?date=${date}&nocache=1`, {
    headers: { Origin: 'http://localhost:8080' },
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`status ${res.status}: ${text.slice(0, 100)}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

async function flushMonth(month, entries) {
  if (!Object.keys(entries).length) return;
  const res = await fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
    body: JSON.stringify({ month, entries }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`flush failed for ${month}: ${res.status} ${text}`);
  }
  const { count } = await res.json();
  console.log(`  -> flushed ${Object.keys(entries).length} entries for ${month} (month now has ${count} total)`);
}

async function main() {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const allDates = dateRange(START_DATE, yesterday);
  const done = loadSet(PROGRESS_FILE);
  const gaps = loadSet(GAPS_FILE);
  const failed = loadFailed();
  const remaining = allDates.filter(d => !done.has(d) && !gaps.has(d));

  console.log(`${allDates.length} total dates, ${done.size} cached, ${gaps.size} confirmed gaps, ${remaining.length} remaining`);

  let consecutiveFailures = 0;
  let bufferMonth = null;
  let buffer = {};
  let bufferDates = [];

  async function flushBuffer() {
    if (!bufferMonth) return;
    await flushMonth(bufferMonth, buffer);
    for (const d of bufferDates) done.add(d);
    saveSet(PROGRESS_FILE, done);
    buffer = {};
    bufferDates = [];
  }

  for (const date of remaining) {
    const month = date.slice(0, 7);
    if (bufferMonth && month !== bufferMonth) {
      await flushBuffer();
    }
    bufferMonth = month;

    try {
      const data = await fetchDateNoCache(date);
      buffer[date] = data;
      bufferDates.push(date);
      delete failed[date];
      consecutiveFailures = 0;
      console.log(`${date} ok (${done.size + bufferDates.length}/${allDates.length})`);
      await new Promise(r => setTimeout(r, PACE_MS));
    } catch (err) {
      if (err.status === 404) {
        gaps.add(date);
        saveSet(GAPS_FILE, gaps);
        delete failed[date];
        console.log(`${date} GAP — nasa has no entry for this date (permanent, won't retry)`);
        await new Promise(r => setTimeout(r, PACE_MS));
        continue;
      }
      failed[date] = String(err.message || err);
      saveFailed(failed);
      if (err.status === 429) {
        consecutiveFailures = 0;
        console.log(`${date} RATE LIMITED — cooling down ${RATE_LIMIT_BACKOFF_MS / 1000}s before continuing`);
        await new Promise(r => setTimeout(r, RATE_LIMIT_BACKOFF_MS));
      } else {
        consecutiveFailures++;
        console.log(`${date} FAILED: ${err.message} — will retry on next run`);
        if (consecutiveFailures >= OUTAGE_THRESHOLD) {
          console.log(`${consecutiveFailures} failures in a row — looks like a real nasa outage, not a blip. pausing ${OUTAGE_BACKOFF_MS / 1000}s.`);
          await new Promise(r => setTimeout(r, OUTAGE_BACKOFF_MS));
          consecutiveFailures = 0;
        } else {
          await new Promise(r => setTimeout(r, PACE_MS + BACKOFF_MS));
        }
      }
    }
  }

  await flushBuffer();

  console.log(`pass complete. ${done.size} cached, ${gaps.size} confirmed gaps, ${Object.keys(failed).length} still failing — re-run to retry those.`);
}

main();
