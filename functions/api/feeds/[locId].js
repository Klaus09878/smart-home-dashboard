// ThingSpeak-Proxy: versteckt die Read-API-Keys hinter Env-Variablen und
// cached Antworten 60 s am Cloudflare-Edge.
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

  const res = await fetch(upstream);
  if (!res.ok) return json({ error: `ThingSpeak-Fehler ${res.status}` }, 502);

  const body = await res.text();
  const response = new Response(body, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' }
  });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
