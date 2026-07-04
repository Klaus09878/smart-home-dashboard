// Kleiner Key-Value-Speicher in D1 (Binding "DB") für App-Konfiguration, die
// Client und Server teilen müssen — z. B. die im Dashboard gewählten
// Wetter-Koordinaten (weather_<locId>), damit check-alerts/weekly-report mit
// denselben Koordinaten rechnen statt mit den Defaults.
//
//   GET  /api/config?key=weather_gillian   → { key, value }
//   POST /api/config  { key, value }       → upsert (value beliebiges JSON)

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const KEY_RE = /^[\w-]{1,64}$/;

async function ensureSchema(db) {
  await db.exec("CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)");
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB) {
    return json({ error: 'D1-Datenbank nicht konfiguriert (Binding "DB" in den Pages-Einstellungen anlegen)' }, 503);
  }
  await ensureSchema(env.DB);
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const key = url.searchParams.get('key');
    if (!key || !KEY_RE.test(key)) return json({ error: 'Parameter key erforderlich' }, 400);
    const row = await env.DB.prepare('SELECT value, updated_at FROM app_config WHERE key = ?').bind(key).first();
    if (!row) return json({ key, value: null });
    return json({ key, value: JSON.parse(row.value), updatedAt: row.updated_at });
  }

  if (request.method === 'POST') {
    const body = await request.json();
    if (!body.key || !KEY_RE.test(body.key)) return json({ error: 'key erforderlich (max. 64 Zeichen, [A-Za-z0-9_-])' }, 400);
    const value = JSON.stringify(body.value ?? null);
    if (value.length > 4096) return json({ error: 'value zu groß (max. 4 KB)' }, 400);
    await env.DB
      .prepare('INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)')
      .bind(body.key, value, Date.now())
      .run();
    return json({ ok: true });
  }

  return json({ error: 'Methode nicht erlaubt' }, 405);
}
