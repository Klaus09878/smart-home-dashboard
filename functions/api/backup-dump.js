// Serverseitiges Voll-Backup der D1-Datenbank nach R2 (Plan2-2) + Wiederher-
// stellung (Plan3-1). Alles nur fuers Admin-Konto — ein Dump enthaelt die Daten
// ALLER Profile.
//
//   GET  /api/backup-dump           → neuen Dump schreiben (fuer den Cron)
//   GET  /api/backup-dump?list=1    → { dumps: [{ key, date, size }] }
//   POST /api/backup-dump {key, confirm[, tables]} → Dump aus R2 zurueckspielen
//
// Ohne R2- (MEDIA) oder D1- (DB) Binding: 503. Laeuft hinter der Auth-Middleware;
// der Cron muss die Basic-Auth-Zugangsdaten des Admin-Kontos senden.
import { identify } from '../_auth.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// Basis-Schema (mit PRIMARY KEY) je Tabelle. Fehlende Zusatzspalten werden beim
// Restore dynamisch per ALTER ergaenzt, damit Schema-Erweiterungen (co2_*, note,
// category/pos …) ohne Pflege hier funktionieren.
const SCHEMAS = {
  user_settings: 'CREATE TABLE IF NOT EXISTS user_settings (profile TEXT, key TEXT, value TEXT, updated_at INTEGER, PRIMARY KEY (profile, key))',
  todos: 'CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, profile TEXT, text TEXT, done INTEGER DEFAULT 0, due_ms INTEGER, repeat_days INTEGER, shared INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER, deleted INTEGER DEFAULT 0)',
  climate_daily: 'CREATE TABLE IF NOT EXISTS climate_daily (loc TEXT NOT NULL, day TEXT NOT NULL, t_min REAL, t_max REAL, t_avg REAL, h_min REAL, h_max REAL, h_avg REAL, samples INTEGER, PRIMARY KEY (loc, day))',
  gpx_activities: 'CREATE TABLE IF NOT EXISTS gpx_activities (uid TEXT PRIMARY KEY, name TEXT, type TEXT, start_time INTEGER, dist_m REAL, total_sec REAL, moving_sec REAL, avg_speed REAL, max_speed REAL, elev_gain REAL, ele_min REAL, ele_max REAL, added_at INTEGER, updated_at INTEGER, deleted INTEGER DEFAULT 0, points TEXT)',
  locations: 'CREATE TABLE IF NOT EXISTS locations (id TEXT PRIMARY KEY, name TEXT, channel TEXT, read_key TEXT, lat REAL, lon REAL, fields TEXT, created_by TEXT, created_at INTEGER)',
  push_subscriptions: 'CREATE TABLE IF NOT EXISTS push_subscriptions (profile TEXT, endpoint TEXT PRIMARY KEY, p256dh TEXT, auth TEXT, created_at INTEGER)',
  app_config: 'CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)'
};
const COL_RE = /^[a-z_][a-z_0-9]*$/i;

async function dumpTable(db, table) {
  try { const { results } = await db.prepare(`SELECT * FROM ${table}`).all(); return results || []; }
  catch (e) { return null; }
}
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
  } catch (e) { return null; }
}

// Eine Tabelle aus Dump-Zeilen wiederherstellen (INSERT OR REPLACE). Fehlende
// Spalten werden vorab per ALTER ergaenzt. Spaltennamen werden validiert.
async function restoreTable(db, table, rows) {
  const schema = SCHEMAS[table];
  if (!schema || !Array.isArray(rows) || !rows.length) return 0;
  await db.exec(schema);
  const cols = new Set();
  rows.forEach(r => Object.keys(r).forEach(c => cols.add(c)));
  for (const c of cols) {
    if (!COL_RE.test(c)) continue;
    try { await db.exec(`ALTER TABLE ${table} ADD COLUMN ${c}`); } catch (e) { /* Spalte existiert */ }
  }
  let n = 0;
  for (const row of rows) {
    const keys = Object.keys(row).filter(c => COL_RE.test(c));
    if (!keys.length) continue;
    const sql = `INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    await db.prepare(sql).bind(...keys.map(k => row[k])).run();
    n++;
  }
  return n;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.MEDIA) return json({ error: 'R2-Speicher nicht konfiguriert (Binding "MEDIA")' }, 503);
  if (!env.DB) return json({ error: 'D1-Datenbank nicht konfiguriert (Binding "DB")' }, 503);
  const id = identify(request, env);
  if (!id || !id.isAdmin) return json({ error: 'nur das Admin-Konto' }, 403);

  // Vorhandene Dumps auflisten (fuer die Restore-Oberflaeche)
  if (new URL(request.url).searchParams.get('list')) {
    const list = await env.MEDIA.list({ prefix: 'backup/d1-' });
    const dumps = (list.objects || [])
      .map(o => ({ key: o.key, date: o.key.replace(/^backup\/d1-|\.json$/g, ''), size: o.size || 0 }))
      .sort((a, b) => (a.key < b.key ? 1 : -1)); // neueste zuerst
    return json({ dumps });
  }

  // Neuen Dump schreiben
  const SIMPLE = ['user_settings', 'todos', 'climate_daily', 'locations', 'push_subscriptions', 'app_config'];
  const tables = {};
  for (const t of SIMPLE) tables[t] = await dumpTable(env.DB, t);
  tables.gpx_activities = await dumpPaged(env.DB, 'gpx_activities');

  const backup = { format: 'smarthub-d1-dump', version: 1, createdAt: new Date().toISOString(), tables };
  const key = `backup/d1-${new Date().toISOString().substring(0, 10)}.json`;
  await env.MEDIA.put(key, JSON.stringify(backup), { httpMetadata: { contentType: 'application/json' } });

  // Verifikation (Plan7-6): den Dump sofort zuruecklesen, parsen und Tabellen +
  // Zeilenzahlen gegenpruefen. Ein still korrupter/leerer Dump ist gefaehrlicher
  // als gar keiner — deshalb wird der Heartbeat NUR bei verifiziertem Backup
  // gesetzt (die Diagnose zeigt so die Zeit des letzten GUTEN Backups).
  let verified = false;
  try {
    const back = await env.MEDIA.get(key);
    const parsed = back ? JSON.parse(await back.text()) : null;
    verified = !!(parsed && parsed.tables
      && Object.keys(parsed.tables).length === Object.keys(tables).length
      && Object.entries(tables).every(([n, rows]) => rows === null
        ? parsed.tables[n] === null
        : Array.isArray(parsed.tables[n]) && parsed.tables[n].length === rows.length));
  } catch (e) { verified = false; }
  if (verified) {
    try {
      await env.DB.exec('CREATE TABLE IF NOT EXISTS alert_state (key TEXT PRIMARY KEY, last_sent INTEGER)');
      await env.DB.prepare('INSERT OR REPLACE INTO alert_state (key, last_sent) VALUES (?, ?)').bind('backup_heartbeat', Date.now()).run();
    } catch (e) { /* Heartbeat best effort */ }
  }

  let deleted = 0;
  try {
    const list = await env.MEDIA.list({ prefix: 'backup/d1-' });
    const keys = (list.objects || []).map(o => o.key).sort();
    const toDelete = keys.slice(0, Math.max(0, keys.length - 8));
    await Promise.all(toDelete.map(k => env.MEDIA.delete(k)));
    deleted = toDelete.length;
  } catch (e) { /* Retention ist best effort */ }

  const counts = {};
  for (const [name, rows] of Object.entries(tables)) counts[name] = rows === null ? null : rows.length;
  return json({ ok: true, key, verified, tables: counts, deleted });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.MEDIA) return json({ error: 'R2-Speicher nicht konfiguriert (Binding "MEDIA")' }, 503);
  if (!env.DB) return json({ error: 'D1-Datenbank nicht konfiguriert (Binding "DB")' }, 503);
  const id = identify(request, env);
  if (!id || !id.isAdmin) return json({ error: 'nur das Admin-Konto' }, 403);

  const body = await request.json().catch(() => ({}));
  const key = body.key;
  if (!key || typeof key !== 'string' || key.indexOf('backup/d1-') !== 0) return json({ error: 'gueltiger Dump-key erforderlich' }, 400);
  // Doppelte Bestaetigung: confirm MUSS exakt dem key entsprechen
  if (body.confirm !== key) return json({ error: 'Bestaetigung stimmt nicht mit dem key ueberein' }, 400);

  const obj = await env.MEDIA.get(key);
  if (!obj) return json({ error: 'Dump nicht gefunden' }, 404);
  let dump;
  try { dump = JSON.parse(await obj.text()); } catch (e) { return json({ error: 'Dump ist kein gueltiges JSON' }, 400); }
  if (!dump || !dump.tables) return json({ error: 'kein gueltiger D1-Dump' }, 400);

  const filter = Array.isArray(body.tables) && body.tables.length ? new Set(body.tables) : null;
  const restored = {};
  for (const [table, rows] of Object.entries(dump.tables)) {
    if (!SCHEMAS[table]) continue;
    if (filter && !filter.has(table)) continue;
    restored[table] = await restoreTable(env.DB, table, rows);
  }
  return json({ ok: true, restored });
}
