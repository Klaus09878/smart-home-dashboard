// Monatlicher GPX-Rückblick per ntfy (P11) — für einen externen Cron, der 1×/
// Monat (z. B. am 1. um 18:00) aufruft:
//   GET https://<deine-domain>/api/monthly-report
//
// Aggregiert den Vormonat aus dem D1-GPX-Archiv (gpx_activities): Distanz,
// Touren, längste Tour, Höhenmeter, längste Serie, Vergleich zum Vor-Vormonat.
// Verteilung an alle Profile mit aktiviertem Monatsbericht (Typ 'monthly'),
// Fallback globales NTFY_TOPIC — siehe _notify.js.
import { loadRecipients, dispatch } from '../_notify.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

// Grenzen eines Kalendermonats (monthsBack=1 → Vormonat), als ms.
function monthRange(monthsBack) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack + 1, 1));
  return { startMs: start.getTime(), endMs: end.getTime(), label: start.toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
}

function aggregate(rows) {
  const acts = (rows || []).filter(r => r.start_time && !r.deleted);
  if (acts.length === 0) return null;
  const km = acts.reduce((s, a) => s + (a.dist_m || 0), 0) / 1000;
  const longest = Math.max(...acts.map(a => a.dist_m || 0)) / 1000;
  const elev = acts.reduce((s, a) => s + (a.elev_gain || 0), 0);

  // Längste Serie zusammenhängender Aktivitätstage
  const dayMs = 86400000;
  const dayKey = ms => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  };
  const toMs = k => new Date(`${k}T12:00:00Z`).getTime();
  const days = [...new Set(acts.map(a => dayKey(a.start_time)))].sort();
  let longestStreak = 0, run = 0, prev = null;
  days.forEach(k => {
    run = (prev !== null && Math.round((toMs(k) - toMs(prev)) / dayMs) === 1) ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
    prev = k;
  });

  return { count: acts.length, km, longest, elev, longestStreak };
}

async function loadMonth(db, range) {
  await db.exec("CREATE TABLE IF NOT EXISTS gpx_activities (uid TEXT PRIMARY KEY, name TEXT, type TEXT, start_time INTEGER, dist_m REAL, total_sec REAL, moving_sec REAL, avg_speed REAL, max_speed REAL, elev_gain REAL, ele_min REAL, ele_max REAL, added_at INTEGER, updated_at INTEGER, deleted INTEGER DEFAULT 0)");
  const { results } = await db
    .prepare('SELECT start_time, dist_m, elev_gain, deleted FROM gpx_activities WHERE start_time >= ? AND start_time < ?')
    .bind(range.startMs, range.endMs).all();
  return results || [];
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.DB) return json({ error: 'D1-Datenbank nicht konfiguriert (Binding "DB")' }, 503);

  const recipients = await loadRecipients(env);
  if (recipients.length === 0) {
    return json({ error: 'Kein ntfy-Empfänger konfiguriert (weder Profil-Topic in D1 noch NTFY_TOPIC)' }, 503);
  }

  const cur = monthRange(1), prev = monthRange(2);
  const agg = aggregate(await loadMonth(env.DB, cur));
  const prevAgg = aggregate(await loadMonth(env.DB, prev));
  const report = { generatedAt: new Date().toISOString(), month: cur.label, agg, sent: false };

  if (!agg) {
    // Nichts aufgezeichnet → kein Push (kein Rauschen)
    report.skipped = 'keine Touren im Vormonat';
    return json(report);
  }

  const fmt = (v, d = 0) => v.toFixed(d).replace('.', ',');
  let trend = '';
  if (prevAgg) {
    const dKm = agg.km - prevAgg.km;
    trend = ` (${dKm >= 0 ? '+' : ''}${fmt(dKm, 1)} km vs. Vormonat)`;
  }
  const body = `GPX-Rückblick ${cur.label}:\n\n` +
    `🏁 ${fmt(agg.km, 1)} km${trend}\n` +
    `🚴 ${agg.count} Tour${agg.count === 1 ? '' : 'en'} · längste ${fmt(agg.longest, 1)} km\n` +
    `⛰ ${fmt(agg.elev)} Höhenmeter\n` +
    `🔥 Längste Serie: ${agg.longestStreak} Tag${agg.longestStreak === 1 ? '' : 'e'}`;

  report.notified = await dispatch(env, recipients, 'monthly', 'gpx', () => ({
    title: 'GPX-Monatsrückblick', body, tags: 'runner', priority: 'default'
  }));
  report.sent = report.notified.length > 0;
  return json(report);
}
