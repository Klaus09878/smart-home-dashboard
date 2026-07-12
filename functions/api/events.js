// Eigene Termine in D1 (Plan3-8) — lokaler Kalender ohne externen Anbieter.
// Profilbezogen, Last-Write-Wins ueber updated_at, Loeschung als Tombstone.
//
//   GET  /api/events            → { events: [...] }  (eigene, nicht geloescht)
//   POST /api/events { items }  → Batch-Upsert (LWW)
//
// Ohne D1: 503 → der Client blendet die Funktion aus.
import { identify } from '../_auth.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const REPEATS = new Set(['none', 'daily', 'weekly', 'monthly', 'yearly']);

async function ensureSchema(db) {
  await db.exec("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, profile TEXT, title TEXT, start_ms INTEGER, end_ms INTEGER, all_day INTEGER DEFAULT 0, repeat TEXT DEFAULT 'none', created_at INTEGER, updated_at INTEGER, deleted INTEGER DEFAULT 0)");
}

const rowToEvent = r => ({
  id: r.id, title: r.title, startMs: r.start_ms, endMs: r.end_ms,
  allDay: !!r.all_day, repeat: r.repeat || 'none',
  createdAt: r.created_at, updatedAt: r.updated_at, deleted: !!r.deleted
});

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB) return json({ error: 'D1-Datenbank nicht konfiguriert (Binding "DB")' }, 503);
  const id = identify(request, env);
  if (!id) return json({ error: 'nicht authentifiziert' }, 401);
  const me = id.user;
  await ensureSchema(env.DB);

  if (request.method === 'GET') {
    const { results } = await env.DB
      .prepare('SELECT * FROM events WHERE profile = ? AND deleted = 0 ORDER BY start_ms').bind(me).all();
    return json({ events: (results || []).map(rowToEvent) });
  }

  if (request.method === 'POST') {
    const body = await request.json();
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length > 500) return json({ error: 'zu viele Eintraege' }, 400);
    let written = 0;
    for (const e of items) {
      if (!e.id || typeof e.id !== 'string') continue;
      const updatedAt = Number(e.updatedAt) || Date.now();
      const existing = await env.DB.prepare('SELECT updated_at, profile FROM events WHERE id = ?').bind(e.id).first();
      if (existing && existing.updated_at >= updatedAt) continue;
      if (existing && existing.profile !== me) continue; // fremdes Profil nicht ueberschreiben
      const repeat = REPEATS.has(e.repeat) ? e.repeat : 'none';
      await env.DB.prepare(
        'INSERT OR REPLACE INTO events (id, profile, title, start_ms, end_ms, all_day, repeat, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,?)'
      ).bind(
        e.id, me, (e.title || '').toString().substring(0, 120),
        Number(e.startMs) || 0, e.endMs != null ? Number(e.endMs) : null,
        e.allDay ? 1 : 0, repeat,
        Number(e.createdAt) || Date.now(), updatedAt, e.deleted ? 1 : 0
      ).run();
      written++;
    }
    return json({ ok: true, written });
  }

  return json({ error: 'Methode nicht erlaubt' }, 405);
}
