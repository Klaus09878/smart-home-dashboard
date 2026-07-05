// Fehler-Protokoll in D1 (P15/P23). Der Client meldet unbehandelte Fehler auch
// hierher (zusätzlich zum ntfy-Push), damit sie auf der System-Seite sichtbar
// bleiben — gerade Fehler auf anderen Geräten (z. B. bei Gillian).
//
//   POST /api/error-log  { page, message }   → protokolliert (Ringpuffer 200)
//   GET  /api/error-log                       → letzte 50 Einträge
//
// Ohne D1 ein No-Op (204), damit der Client-Aufruf nie stört.
import { identify } from '../_auth.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

async function ensureSchema(db) {
  await db.exec("CREATE TABLE IF NOT EXISTS error_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, profile TEXT, page TEXT, message TEXT)");
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.DB) return new Response(null, { status: 204 });
  await ensureSchema(env.DB);

  const id = identify(request, env);
  let body = {};
  try { body = await request.json(); } catch (e) { /* leer */ }
  const page = (body.page || '').toString().substring(0, 200);
  const message = (body.message || '').toString().substring(0, 500);
  if (!message) return json({ ok: false, error: 'message fehlt' }, 400);

  await env.DB
    .prepare('INSERT INTO error_log (ts, profile, page, message) VALUES (?, ?, ?, ?)')
    .bind(Date.now(), id ? id.user : '?', page, message).run();

  // Ringpuffer: nur die jüngsten 200 behalten
  await env.DB.prepare(
    'DELETE FROM error_log WHERE id NOT IN (SELECT id FROM error_log ORDER BY ts DESC LIMIT 200)'
  ).run();

  return json({ ok: true });
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.DB) return json({ errors: [] });
  await ensureSchema(env.DB);
  const { results } = await env.DB
    .prepare('SELECT ts, profile, page, message FROM error_log ORDER BY ts DESC LIMIT 50')
    .all();
  return json({ errors: results || [] });
}
