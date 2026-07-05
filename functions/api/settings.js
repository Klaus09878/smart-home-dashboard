// Profilbezogener Einstellungs-Speicher in D1 (Binding "DB"). Spiegelt die
// clientseitigen Einstellungen (Schwellwerte, ntfy-Topic, Widget-Layout, Ziele,
// Kalender-URL, Benachrichtigungsregeln …), damit sie geräteübergreifend und
// über gelöschte Browser-Daten hinweg erhalten bleiben.
//
//   GET  /api/settings           → { profile, settings: { key: {value, updatedAt} } }
//   POST /api/settings           → { items: [{key, value, updatedAt}] }  (Batch-Upsert)
//
// Das Profil wird IMMER aus dem Login abgeleitet (identify), nie aus dem Body —
// so kann kein Profil fremde Einstellungen lesen/überschreiben. Konfliktlösung:
// neuerer updatedAt gewinnt (Last-Write-Wins, wie beim GPX-Sync).
import { identify } from '../_auth.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const KEY_RE = /^[\w:-]{1,80}$/;

async function ensureSchema(db) {
  await db.exec("CREATE TABLE IF NOT EXISTS user_settings (profile TEXT, key TEXT, value TEXT, updated_at INTEGER, PRIMARY KEY (profile, key))");
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB) return json({ error: 'D1-Datenbank nicht konfiguriert (Binding "DB")' }, 503);

  const id = identify(request, env);
  if (!id) return json({ error: 'nicht authentifiziert' }, 401);
  const profile = id.user;

  await ensureSchema(env.DB);

  if (request.method === 'GET') {
    const { results } = await env.DB
      .prepare('SELECT key, value, updated_at FROM user_settings WHERE profile = ?')
      .bind(profile).all();
    const settings = {};
    for (const row of results) {
      try { settings[row.key] = { value: JSON.parse(row.value), updatedAt: row.updated_at }; }
      catch (e) { /* defekten Eintrag überspringen */ }
    }
    return json({ profile, settings });
  }

  if (request.method === 'POST') {
    const body = await request.json();
    const items = Array.isArray(body.items) ? body.items
      : (body.key !== undefined ? [body] : []);
    if (items.length === 0) return json({ error: 'items erforderlich' }, 400);
    if (items.length > 200) return json({ error: 'zu viele Einträge (max. 200)' }, 400);

    let written = 0;
    for (const item of items) {
      if (!item.key || !KEY_RE.test(item.key)) continue;
      const value = JSON.stringify(item.value ?? null);
      if (value.length > 100_000) continue; // Schutz gegen Riesen-Werte
      const updatedAt = Number(item.updatedAt) || Date.now();
      // Nur überschreiben, wenn der eingehende Stand neuer ist (LWW).
      const existing = await env.DB
        .prepare('SELECT updated_at FROM user_settings WHERE profile = ? AND key = ?')
        .bind(profile, item.key).first();
      if (existing && existing.updated_at >= updatedAt) continue;
      await env.DB
        .prepare('INSERT OR REPLACE INTO user_settings (profile, key, value, updated_at) VALUES (?, ?, ?, ?)')
        .bind(profile, item.key, value, updatedAt).run();
      written++;
    }
    return json({ ok: true, written });
  }

  return json({ error: 'Methode nicht erlaubt' }, 405);
}
