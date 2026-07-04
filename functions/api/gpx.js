// GPX-Aktivitäten in Cloudflare D1 (gleiche Datenbank wie das Klima-Archiv).
//
// Einrichtung:
//   1. D1-Datenbank anlegen:  wrangler d1 create smarthub  (oder im Dashboard)
//   2. In Pages → Settings → Functions → D1 database bindings:
//      Variable name "DB" → Datenbank auswählen
// Solange das Binding fehlt, antwortet der Endpoint mit 503 und der
// GPX-Viewer arbeitet rein lokal (IndexedDB).

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

async function ensureSchema(db) {
  await db.exec("CREATE TABLE IF NOT EXISTS gpx_activities (uid TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, start_time INTEGER, dist_m REAL, total_sec REAL, moving_sec REAL, avg_speed REAL, max_speed REAL, elev_gain REAL, ele_min REAL, ele_max REAL, added_at INTEGER, points TEXT)");
}

function rowToActivity(row, withPoints) {
  const activity = {
    uid: row.uid,
    name: row.name,
    type: row.type,
    startTime: row.start_time,
    distM: row.dist_m,
    totalSec: row.total_sec,
    movingSec: row.moving_sec,
    avgSpeed: row.avg_speed,
    maxSpeed: row.max_speed,
    elevGain: row.elev_gain,
    eleMin: row.ele_min,
    eleMax: row.ele_max,
    addedAt: row.added_at
  };
  if (withPoints && row.points) activity.points = JSON.parse(row.points);
  return activity;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB) {
    return json({ error: 'D1-Datenbank nicht konfiguriert (Binding "DB" in den Pages-Einstellungen anlegen)' }, 503);
  }
  await ensureSchema(env.DB);
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const uid = url.searchParams.get('uid');
    if (uid) {
      const row = await env.DB.prepare('SELECT * FROM gpx_activities WHERE uid = ?').bind(uid).first();
      if (!row) return json({ error: 'Nicht gefunden' }, 404);
      return json(rowToActivity(row, true));
    }
    // Liste ohne Punkte (leichtgewichtig für den Sync-Abgleich)
    const { results } = await env.DB
      .prepare('SELECT uid, name, type, start_time, dist_m, total_sec, moving_sec, avg_speed, max_speed, elev_gain, ele_min, ele_max, added_at FROM gpx_activities ORDER BY start_time DESC')
      .all();
    return json(results.map(r => rowToActivity(r, false)));
  }

  if (request.method === 'POST') {
    const a = await request.json();
    if (!a.uid || !Array.isArray(a.points)) return json({ error: 'uid und points erforderlich' }, 400);
    await env.DB
      .prepare('INSERT OR REPLACE INTO gpx_activities (uid, name, type, start_time, dist_m, total_sec, moving_sec, avg_speed, max_speed, elev_gain, ele_min, ele_max, added_at, points) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(
        a.uid,
        a.name || 'Aktivität',
        a.type || 'ride',
        a.startTime ?? null,
        a.distM ?? null,
        a.totalSec ?? null,
        a.movingSec ?? null,
        a.avgSpeed ?? null,
        a.maxSpeed ?? null,
        a.elevGain ?? null,
        a.eleMin ?? null,
        a.eleMax ?? null,
        a.addedAt ?? Date.now(),
        JSON.stringify(a.points)
      )
      .run();
    return json({ ok: true });
  }

  if (request.method === 'PUT') {
    const a = await request.json();
    if (!a.uid) return json({ error: 'uid erforderlich' }, 400);
    await env.DB
      .prepare('UPDATE gpx_activities SET name = COALESCE(?, name), type = COALESCE(?, type) WHERE uid = ?')
      .bind(a.name ?? null, a.type ?? null, a.uid)
      .run();
    return json({ ok: true });
  }

  if (request.method === 'DELETE') {
    const uid = url.searchParams.get('uid');
    if (!uid) return json({ error: 'uid erforderlich' }, 400);
    await env.DB.prepare('DELETE FROM gpx_activities WHERE uid = ?').bind(uid).run();
    return json({ ok: true });
  }

  return json({ error: 'Methode nicht erlaubt' }, 405);
}
