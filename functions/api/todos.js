// To-do-Liste in D1 (P12) mit geräteübergreifendem Sync und optional
// gemeinsamen Einträgen (shared=1 → für alle Profile sichtbar). Der Client
// hält lokal eine Kopie und gleicht per updatedAt ab (Last-Write-Wins), inkl.
// Tombstones (deleted=1) für Löschungen.
//
//   GET  /api/todos            → { todos: [...] }  (eigene + geteilte)
//   POST /api/todos { items }  → Batch-Upsert (LWW)
//
// Ohne D1 antwortet der Endpunkt 503 → der Client bleibt rein lokal.
import { identify } from '../_auth.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

async function ensureSchema(db) {
  await db.exec("CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, profile TEXT, text TEXT, done INTEGER DEFAULT 0, due_ms INTEGER, repeat_days INTEGER, shared INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER, deleted INTEGER DEFAULT 0)");
  // Nachrüsten (Kategorie/Position, Punkt 19) — Fehler = Spalte existiert schon
  try { await db.exec("ALTER TABLE todos ADD COLUMN category TEXT"); } catch (e) { /* existiert */ }
  try { await db.exec("ALTER TABLE todos ADD COLUMN pos INTEGER"); } catch (e) { /* existiert */ }
}

const rowToTodo = r => ({
  id: r.id, owner: r.profile, text: r.text, done: !!r.done,
  dueMs: r.due_ms, repeatDays: r.repeat_days, shared: !!r.shared,
  category: r.category || null, pos: r.pos || null,
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
      .prepare('SELECT * FROM todos WHERE profile = ? OR shared = 1 ORDER BY created_at')
      .bind(me).all();
    return json({ todos: (results || []).map(rowToTodo) });
  }

  if (request.method === 'POST') {
    const body = await request.json();
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length > 500) return json({ error: 'zu viele Einträge' }, 400);
    let written = 0;
    for (const t of items) {
      if (!t.id || typeof t.id !== 'string') continue;
      const updatedAt = Number(t.updatedAt) || Date.now();
      const existing = await env.DB.prepare('SELECT updated_at, profile FROM todos WHERE id = ?').bind(t.id).first();
      if (existing && existing.updated_at >= updatedAt) continue;
      // Besitzer bleibt beim ersten Anleger; neue Einträge gehören dem Aufrufer
      const owner = existing ? existing.profile : (t.owner || me);
      await env.DB.prepare(
        'INSERT OR REPLACE INTO todos (id, profile, text, done, due_ms, repeat_days, shared, created_at, updated_at, deleted, category, pos) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(
        t.id, owner, (t.text || '').toString().substring(0, 500),
        t.done ? 1 : 0, t.dueMs ?? null, t.repeatDays ?? null, t.shared ? 1 : 0,
        Number(t.createdAt) || Date.now(), updatedAt, t.deleted ? 1 : 0,
        t.category ? t.category.toString().substring(0, 40) : null, t.pos ?? null
      ).run();
      written++;
    }
    return json({ ok: true, written });
  }

  return json({ error: 'Methode nicht erlaubt' }, 405);
}
