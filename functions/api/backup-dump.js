// Serverseitiges Voll-Backup der D1-Datenbank nach R2 (Plan-Punkt 2). Gedacht
// fuer einen woechentlichen externen Cron (wie check-alerts):
//   GET https://<domain>/api/backup-dump
//
// Schreibt alle Datentabellen als eine JSON-Datei nach R2 (Binding "MEDIA"),
// Key backup/d1-YYYY-MM-DD.json, und behaelt die neuesten 8 Sicherungen.
// Ohne R2- oder D1-Binding: 503. Laeuft hinter der Auth-Middleware — der Cron
// muss dieselben Basic-Auth-Header senden wie fuer check-alerts.

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// Kleine Tabellen am Stueck lesen.
async function dumpTable(db, table) {
  try {
    const { results } = await db.prepare(`SELECT * FROM ${table}`).all();
    return results || [];
  } catch (e) {
    return null; // Tabelle existiert (noch) nicht
  }
}

// gpx_activities hat die grosse points-Spalte → seitenweise lesen, um den
// Workers-Speicher zu schonen.
async function dumpPaged(db, table, pageSize = 50) {
  const out = [];
  try {
    for (let offset = 0; ; offset += pageSize) {
      const { results } = await db.prepare(`SELECT * FROM ${table} LIMIT ? OFFSET ?`).bind(pageSize, offset).all();
      const rows = results || [];
      out.push(...rows);
      if (rows.length < pageSize) break;
    }
    return out;
  } catch (e) {
    return null;
  }
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.MEDIA) return json({ error: 'R2-Speicher nicht konfiguriert (Binding "MEDIA")' }, 503);
  if (!env.DB) return json({ error: 'D1-Datenbank nicht konfiguriert (Binding "DB")' }, 503);

  const SIMPLE = ['user_settings', 'todos', 'climate_daily', 'locations', 'push_subscriptions', 'app_config'];
  const tables = {};
  for (const t of SIMPLE) tables[t] = await dumpTable(env.DB, t);
  tables.gpx_activities = await dumpPaged(env.DB, 'gpx_activities');

  const backup = { format: 'smarthub-d1-dump', version: 1, createdAt: new Date().toISOString(), tables };
  const key = `backup/d1-${new Date().toISOString().substring(0, 10)}.json`;
  await env.MEDIA.put(key, JSON.stringify(backup), { httpMetadata: { contentType: 'application/json' } });

  // Retention: nur die neuesten 8 Sicherungen behalten.
  let deleted = 0;
  try {
    const list = await env.MEDIA.list({ prefix: 'backup/d1-' });
    const keys = (list.objects || []).map(o => o.key).sort(); // Datum im Namen → lexikografisch = chronologisch
    const toDelete = keys.slice(0, Math.max(0, keys.length - 8));
    await Promise.all(toDelete.map(k => env.MEDIA.delete(k)));
    deleted = toDelete.length;
  } catch (e) { /* Retention ist best effort */ }

  const counts = {};
  for (const [name, rows] of Object.entries(tables)) counts[name] = rows === null ? null : rows.length;
  return json({ ok: true, key, tables: counts, deleted });
}
