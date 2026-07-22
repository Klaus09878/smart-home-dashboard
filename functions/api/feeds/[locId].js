// ThingSpeak-Proxy: versteckt die Read-API-Keys hinter Env-Variablen und
// cached Antworten 60 s am Cloudflare-Edge. Zusaetzlich Last-Known-Good in D1
// (Plan7-4): faellt ThingSpeak aus, werden die letzten erfolgreichen Werte
// ausgeliefert statt eines Fehlers — die Werte tragen ihre echten (alten)
// Zeitstempel, die Stale-Erkennung im Frontend markiert sie ohnehin als veraltet.
//
// Einrichtung (Pages → Settings → Environment variables):
//   TS_KEY_GILLIAN = <Read API Key Kanal 3417815>
//   TS_KEY_SEAN    = <Read API Key Kanal 3417935>
// Solange die Variablen fehlen, antwortet der Endpoint mit 503 und das
// Frontend fällt automatisch auf den Direktzugriff zurück.

const CHANNELS = {
  gillian: { channel: '3417815', envKey: 'TS_KEY_GILLIAN' },
  sean:    { channel: '3417935', envKey: 'TS_KEY_SEAN' }
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

// Über die Oberfläche angelegte Standorte liegen in D1 (locations) — Kanal +
// Read-Key werden dort gespeichert, nie an den Client ausgeliefert.
async function resolveDynamic(db, locId) {
  if (!db) return null;
  try {
    const row = await db.prepare('SELECT channel, read_key FROM locations WHERE id = ?').bind(locId).first();
    return row ? { channel: row.channel, apiKey: row.read_key } : null;
  } catch (e) { return null; }
}

// ---- Last-Known-Good-Cache in D1 (Plan7-4) ----
async function readFeedCache(db, key) {
  if (!db) return null;
  try {
    await db.exec('CREATE TABLE IF NOT EXISTS feed_cache (cache_key TEXT PRIMARY KEY, body TEXT, updated_at INTEGER)');
    return await db.prepare('SELECT body, updated_at FROM feed_cache WHERE cache_key = ?').bind(key).first();
  } catch (e) { return null; }
}
async function writeFeedCache(db, key, body) {
  if (!db) return;
  try {
    await db.exec('CREATE TABLE IF NOT EXISTS feed_cache (cache_key TEXT PRIMARY KEY, body TEXT, updated_at INTEGER)');
    await db.prepare('INSERT OR REPLACE INTO feed_cache (cache_key, body, updated_at) VALUES (?, ?, ?)')
      .bind(key, body, Date.now()).run();
  } catch (e) { /* Cache ist best effort — Ausfall darf den Proxy nicht brechen */ }
}

export async function onRequestGet(context) {
  const { params, env, request } = context;

  let channel, apiKey;
  const loc = CHANNELS[params.locId];
  if (loc) {
    channel = loc.channel;
    apiKey = env[loc.envKey];
    if (!apiKey) return json({ error: `Env-Variable ${loc.envKey} nicht konfiguriert` }, 503);
  } else {
    const dyn = await resolveDynamic(env.DB, params.locId);
    if (!dyn) return json({ error: 'Unbekannter Standort' }, 404);
    channel = dyn.channel;
    apiKey = dyn.apiKey;
  }

  const url = new URL(request.url);
  const results = url.searchParams.get('results') || '8000';
  const start = url.searchParams.get('start');

  let upstream = `https://api.thingspeak.com/channels/${channel}/feeds.json?api_key=${apiKey}&results=${encodeURIComponent(results)}`;
  if (start) upstream += `&start=${encodeURIComponent(start)}`;

  // Edge-Cache: identische Abfragen innerhalb von 60 s treffen ThingSpeak nur einmal
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Rate-Limit (429) einmal mit kurzer Pause erneut versuchen (Punkt 25).
  let res = null;
  try {
    res = await fetch(upstream);
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 1200));
      res = await fetch(upstream);
    }
  } catch (e) { res = null; } // Netzfehler → wie Ausfall behandeln (LKG)

  // Nur die laufende Abfrage (ohne start) hat einen sinnvollen Last-Known-Good.
  const lkgKey = start ? null : `${channel}:${results}`;

  if (!res || res.status === 429 || !res.ok) {
    // ThingSpeak nicht erreichbar/ueberlastet → letzte bekannte Werte ausliefern.
    if (lkgKey) {
      const row = await readFeedCache(env.DB, lkgKey);
      if (row && row.body) {
        let out = row.body;
        try { const o = JSON.parse(row.body); o._stale = true; o._cachedAt = row.updated_at; out = JSON.stringify(o); } catch (e) { /* Body roh ausliefern */ }
        return new Response(out, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Data-Source': 'last-known-good', 'Cache-Control': 'no-store' }
        });
      }
    }
    if (res && res.status === 429) return json({ error: 'ThingSpeak-Ratenlimit erreicht – bitte kurz warten.' }, 429);
    return json({ error: res ? `ThingSpeak-Fehler ${res.status}` : 'ThingSpeak nicht erreichbar' }, 502);
  }

  const body = await res.text();
  const response = new Response(body, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' }
  });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  if (lkgKey) context.waitUntil(writeFeedCache(env.DB, lkgKey, body));
  return response;
}
