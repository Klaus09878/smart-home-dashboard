// Über die Oberfläche anlegbare Zusatz-Standorte in D1 (P8). Der ThingSpeak-
// Read-Key wird serverseitig gespeichert und NIE an den Client ausgeliefert —
// der Feeds-Proxy löst ihn intern auf.
//
//   GET    /api/locations                 → { locations: [{id,name,lat,lon,fields}] }  (ohne Key)
//   POST   /api/locations  {id,name,channel,readKey,lat,lon,fields}  (nur Admin)
//   DELETE /api/locations?id=…            (nur Admin)
import { identify } from '../_auth.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const ID_RE = /^[a-z0-9_-]{2,32}$/;
// Reservierte IDs der fest verdrahteten Standorte
const RESERVED = new Set(['gillian', 'sean']);

async function ensureSchema(db) {
  await db.exec("CREATE TABLE IF NOT EXISTS locations (id TEXT PRIMARY KEY, name TEXT, channel TEXT, read_key TEXT, lat REAL, lon REAL, fields TEXT, created_by TEXT, created_at INTEGER)");
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB) return json({ error: 'D1-Datenbank nicht konfiguriert (Binding "DB")' }, 503);
  await ensureSchema(env.DB);

  if (request.method === 'GET') {
    const { results } = await env.DB
      .prepare('SELECT id, name, lat, lon, fields FROM locations ORDER BY created_at').all();
    const locations = (results || []).map(r => ({
      id: r.id, name: r.name, lat: r.lat, lon: r.lon,
      fields: r.fields ? JSON.parse(r.fields) : { temp: 'field1', humidity: 'field2', extra: [] }
    }));
    return json({ locations });
  }

  // Schreibzugriff nur für Admin
  const id = identify(request, env);
  if (!id || !id.isAdmin) return json({ error: 'nur für Admin' }, 403);

  if (request.method === 'POST') {
    const b = await request.json();
    if (!b.id || !ID_RE.test(b.id)) return json({ error: 'id ungültig (a–z, 0–9, _-, 2–32 Zeichen)' }, 400);
    if (RESERVED.has(b.id)) return json({ error: 'id ist reserviert' }, 400);
    if (!b.channel || !b.readKey) return json({ error: 'channel und readKey erforderlich' }, 400);
    const fields = b.fields && typeof b.fields === 'object' ? b.fields : { temp: 'field1', humidity: 'field2', extra: [] };
    await env.DB.prepare(
      'INSERT OR REPLACE INTO locations (id, name, channel, read_key, lat, lon, fields, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(
      b.id, (b.name || b.id).toString().substring(0, 60), b.channel.toString(), b.readKey.toString(),
      Number(b.lat) || 0, Number(b.lon) || 0, JSON.stringify(fields), id.user, Date.now()
    ).run();
    return json({ ok: true });
  }

  if (request.method === 'DELETE') {
    const locId = new URL(request.url).searchParams.get('id');
    if (!locId) return json({ error: 'id erforderlich' }, 400);
    await env.DB.prepare('DELETE FROM locations WHERE id = ?').bind(locId).run();
    return json({ ok: true });
  }

  return json({ error: 'Methode nicht erlaubt' }, 405);
}
