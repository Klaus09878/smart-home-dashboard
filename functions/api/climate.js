// Langzeit-Archiv für Klimadaten in Cloudflare D1 (Binding "DB", siehe gpx.js).
// ThingSpeak hält nur die letzten 8000 Einträge — das Dashboard schickt deshalb
// nach jedem Laden tägliche Aggregate hierher (idempotentes Upsert pro loc+Tag).

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

async function ensureSchema(db) {
  await db.exec("CREATE TABLE IF NOT EXISTS climate_daily (loc TEXT NOT NULL, day TEXT NOT NULL, t_min REAL, t_max REAL, t_avg REAL, h_min REAL, h_max REAL, h_avg REAL, samples INTEGER, PRIMARY KEY (loc, day))");
  // CO₂-Spalten nachruesten (P8) — Fehler = Spalte existiert bereits
  try { await db.exec("ALTER TABLE climate_daily ADD COLUMN co2_avg REAL"); } catch (e) { /* existiert */ }
  try { await db.exec("ALTER TABLE climate_daily ADD COLUMN co2_max REAL"); } catch (e) { /* existiert */ }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB) {
    return json({ error: 'D1-Datenbank nicht konfiguriert (Binding "DB" in den Pages-Einstellungen anlegen)' }, 503);
  }
  await ensureSchema(env.DB);
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const loc = url.searchParams.get('loc');
    const stmt = loc
      ? env.DB.prepare('SELECT * FROM climate_daily WHERE loc = ? ORDER BY day').bind(loc)
      : env.DB.prepare('SELECT * FROM climate_daily ORDER BY loc, day');
    const { results } = await stmt.all();
    return json(results);
  }

  if (request.method === 'POST') {
    const body = await request.json();
    if (!body.loc || !Array.isArray(body.days) || body.days.length === 0) {
      return json({ error: 'loc und days[] erforderlich' }, 400);
    }
    const stmt = env.DB.prepare('INSERT OR REPLACE INTO climate_daily (loc, day, t_min, t_max, t_avg, h_min, h_max, h_avg, samples, co2_avg, co2_max) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const batch = body.days.map(d =>
      stmt.bind(body.loc, d.day, d.tMin ?? null, d.tMax ?? null, d.tAvg ?? null, d.hMin ?? null, d.hMax ?? null, d.hAvg ?? null, d.samples ?? null, d.co2Avg ?? null, d.co2Max ?? null)
    );
    await env.DB.batch(batch);
    return json({ ok: true, upserted: body.days.length });
  }

  return json({ error: 'Methode nicht erlaubt' }, 405);
}
