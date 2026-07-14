// Perf-Audit fuer den mobilen Erststart (PLAN4 Phase A, Punkt 1).
//
// Misst unter simulierten Mobilbedingungen (Fast-3G-Drossel + 4x CPU-Throttle),
// wie schnell das Hub-Geruest sichtbar und das Status-Briefing gefuellt ist,
// plus Anzahl Requests und transferierte Bytes. Jeder Lauf nutzt einen frischen
// Browser-Kontext (= Erstbesuch, kein Service-Worker/Cache).
//
// Lokal gibt es keine Cloudflare Functions → /api/* und die Wetter-APIs werden
// mit realistischer Latenz gemockt (page.route), damit die Zahlen die
// Startsequenz der App messen und nicht das Fehlen der APIs.
//
// Ausfuehren:  npm run perf
// Ergebnis: Markdown-Tabelle auf stdout; die Zahlen von Hand in docs/PERF.md
// unter dem passenden Abschnitt eintragen (Baseline / nach Phase A / final).

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_SERVER = path.join(__dirname, '..', 'tests', 'static-server.js');
const PORT = 4780;
const BASE = `http://localhost:${PORT}`;

// Fast-3G-aehnliche Drossel (Bytes/s) + CPU-Verlangsamung.
const NET = { offline: false, latency: 150, downloadThroughput: 200 * 1024, uploadThroughput: 96 * 1024 };
const CPU_RATE = 4;
const API_DELAY_MS = 400;   // simulierte Function-Latenz
const WEATHER_DELAY_MS = 300;
const RUNS = 3;

function median(nums) {
  const xs = nums.filter(n => typeof n === 'number' && !Number.isNaN(n)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

// Startet tests/static-server.js als Kindprozess auf PORT und wartet, bis er lauscht.
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STATIC_SERVER], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'inherit']
    });
    let ready = false;
    child.stdout.on('data', d => {
      if (!ready && /Test-Server auf/.test(d.toString())) { ready = true; resolve(child); }
    });
    child.on('error', reject);
    setTimeout(() => { if (!ready) reject(new Error('Static-Server startet nicht')); }, 8000);
  });
}

// Erzeugt eine ThingSpeak-aehnliche Feed-Antwort mit n Eintraegen (Komma-Dezimal,
// created_at relativ zu jetzt im 5-Minuten-Takt), damit die App echte Werte sieht.
function feedResponse(n) {
  const feeds = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i--) {
    const ts = new Date(now - i * 5 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
    const temp = (21 + Math.sin(i / 20)).toFixed(1).replace('.', ',');
    const hum = (55 + Math.cos(i / 15) * 5).toFixed(1).replace('.', ',');
    feeds.push({ created_at: ts, entry_id: n - i, field1: temp, field2: hum });
  }
  return { channel: { name: 'perf' }, feeds };
}

function weatherResponse() {
  const now = Math.floor(Date.now() / 1000);
  const time = [], temperature_2m = [], relative_humidity_2m = [], precipitation_probability = [], weather_code = [];
  for (let i = 24 * 9; i >= -48; i--) {
    time.push(now - i * 3600); temperature_2m.push(9); relative_humidity_2m.push(72);
    precipitation_probability.push(10); weather_code.push(1);
  }
  return {
    current: { time: now, temperature_2m: 9, relative_humidity_2m: 72, weather_code: 1 },
    hourly: { time, temperature_2m, relative_humidity_2m, precipitation_probability, weather_code },
    daily: { time: [now, now + 86400, now + 2 * 86400], temperature_2m_min: [4, 5, 6], temperature_2m_max: [12, 13, 14], weather_code: [1, 2, 3] }
  };
}

async function installRoutes(page) {
  // Wetter-/Geo-APIs (mehrere Open-Meteo-Subdomains, BrightSky, Nominatim)
  await page.route(/(open-meteo\.com|brightsky\.dev|openstreetmap\.org)/, async route => {
    await new Promise(r => setTimeout(r, WEATHER_DELAY_MS));
    const url = route.request().url();
    let body;
    if (url.includes('brightsky')) body = { alerts: [] };
    else if (url.includes('air-quality')) body = { current: { european_aqi: 30, pm2_5: 5, pm10: 8 } };
    else if (url.includes('nominatim')) body = { address: { city: 'Teststadt', country_code: 'de' } };
    else if (url.includes('geocoding')) body = { results: [] };
    else body = weatherResponse();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });

  // Cloudflare-Functions-Endpunkte
  await page.route('**/api/**', async route => {
    await new Promise(r => setTimeout(r, API_DELAY_MS));
    const url = route.request().url();
    let body = {};
    if (url.includes('/api/whoami')) body = { user: 'sean', isAdmin: false, mode: 'basic' };
    else if (url.includes('/api/settings')) body = { settings: {} };
    else if (url.includes('/api/locations')) body = { locations: [] };
    else if (url.includes('/api/config')) body = { value: null };
    else if (url.includes('/api/health')) body = { cronLastSeen: null };
    else if (url.includes('/api/events')) body = { events: [] };
    else if (url.includes('/api/todos')) body = { todos: [] };
    else if (url.includes('/api/feeds/')) {
      const u = new URL(url);
      const results = Math.min(parseInt(u.searchParams.get('results') || '100', 10) || 100, 8000);
      body = feedResponse(results);
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function measurePage(browser, url, opts = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Network.emulateNetworkConditions', NET);
  await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });

  let bytes = 0, requests = 0;
  client.on('Network.requestWillBeSent', () => { requests++; });
  client.on('Network.loadingFinished', e => { bytes += e.encodedDataLength || 0; });

  await installRoutes(page);

  // Reveal-Zeitpunkte per MutationObserver erfassen (VOR der Navigation
  // injiziert). Ein rAF-Poll wuerde unter CPU-Drossel erst feuern, wenn der
  // Main-Thread nach der gesamten init-Arbeit frei ist, und damit „Geruest
  // sichtbar" massiv ueberschaetzen. Der Observer haelt den Moment fest, in dem
  // #view-home die hidden-Klasse verliert bzw. das Briefing-Badge sich fuellt.
  if (opts.hub) {
    await page.addInitScript(() => {
      window.__perf = { geruest: null, briefing: null };
      const check = () => {
        const v = document.getElementById('view-home');
        if (v && !v.classList.contains('hidden') && window.__perf.geruest == null) window.__perf.geruest = performance.now();
        const b = document.getElementById('briefing-badge');
        if (b && !/gepr/i.test(b.textContent || '') && window.__perf.briefing == null) window.__perf.briefing = performance.now();
        return window.__perf.geruest != null && window.__perf.briefing != null;
      };
      const mo = new MutationObserver(() => { if (check()) mo.disconnect(); });
      // document (nicht documentElement): in addInitScript existiert <html> evtl.
      // noch nicht → observe(null) wuerde werfen. document existiert immer.
      mo.observe(document, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true, characterData: true });
    });
  }

  await page.goto(url, { waitUntil: 'commit' });

  const result = { requests: 0, bytes: 0 };

  if (opts.hub) {
    // Warten, bis der Observer beide Werte hat (oder Timeout), dann auslesen.
    await page.waitForFunction(() => window.__perf && window.__perf.geruest != null, null, { timeout: 25000 }).catch(() => {});
    await page.waitForFunction(() => window.__perf && window.__perf.briefing != null, null, { timeout: 25000 }).catch(() => {});
    const perf = await page.evaluate(() => window.__perf || {}).catch(() => ({}));
    result.tGeruest = perf.geruest ?? null;
    result.tBriefing = perf.briefing ?? null;
  } else {
    await page.waitForLoadState('load', { timeout: 25000 }).catch(() => {});
  }

  // Navigation-Timing abwarten (loadEventEnd gesetzt) und auslesen
  const timing = await page.evaluate(() => new Promise(resolve => {
    const read = () => {
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav && nav.loadEventEnd > 0) resolve({ dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd });
      else setTimeout(read, 100);
    };
    read();
  })).catch(() => ({ dcl: null, load: null }));

  // kurzer Puffer, damit late Requests noch in die Byte-Summe fallen
  await page.waitForTimeout(500);

  result.tDcl = timing.dcl;
  result.tLoad = timing.load;
  result.requests = requests;
  result.bytes = bytes;

  await context.close();
  return result;
}

function fmtMs(v) { return v == null ? 'n/a' : `${Math.round(v)} ms`; }
function fmtKb(v) { return v == null ? 'n/a' : `${(v / 1024).toFixed(0)} KB`; }

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  try {
    const hubRuns = [];
    for (let i = 0; i < RUNS; i++) {
      process.stderr.write(`Hub-Lauf ${i + 1}/${RUNS} …\n`);
      hubRuns.push(await measurePage(browser, `${BASE}/index.html#home`, { hub: true }));
    }
    process.stderr.write('GPX-Lauf …\n');
    const gpx = await measurePage(browser, `${BASE}/gpx.html`, { hub: false });

    const pick = k => median(hubRuns.map(r => r[k]));
    const now = new Date().toISOString().substring(0, 16).replace('T', ' ');

    const lines = [];
    lines.push('');
    lines.push(`### Messung ${now} (Fast-3G, CPU 4x, ${RUNS} Laeufe, Median)`);
    lines.push('');
    lines.push('| Metrik | Hub (index.html) | GPX (gpx.html) |');
    lines.push('|---|---|---|');
    lines.push(`| Geruest sichtbar (#view-home) | ${fmtMs(pick('tGeruest'))} | – |`);
    lines.push(`| Briefing gefuellt | ${fmtMs(pick('tBriefing'))} | – |`);
    lines.push(`| DOMContentLoaded | ${fmtMs(pick('tDcl'))} | ${fmtMs(gpx.tDcl)} |`);
    lines.push(`| load-Event | ${fmtMs(pick('tLoad'))} | ${fmtMs(gpx.tLoad)} |`);
    lines.push(`| Requests | ${pick('requests')} | ${gpx.requests} |`);
    lines.push(`| Transfer | ${fmtKb(pick('bytes'))} | ${fmtKb(gpx.bytes)} |`);
    lines.push('');
    console.log(lines.join('\n'));
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
