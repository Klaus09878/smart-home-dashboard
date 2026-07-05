// Wöchentlicher Klima-Report per ntfy.sh — gedacht für einen externen
// Cron-Dienst (z. B. cron-job.org), der 1×/Woche (z. B. sonntags 19:00) aufruft:
//   GET https://<deine-domain>/api/weekly-report
//
// Inhalt pro Standort: Ø/Min/Max-Temperatur, Ø-Feuchte, Komfort-Score
// (Ø + bester/schwächster Tag) und Trend zur Vorwoche.
// Datenquelle: D1-Langzeit-Archiv (climate_daily). Ohne D1 bzw. ohne Archiv-
// zeilen wird direkt aus ThingSpeak aggregiert (dann ohne Vorwochen-Trend).
//
// Verteilung an alle Profile mit aktiviertem Wochenbericht (Topic + Regeln aus
// D1), Fallback globales NTFY_TOPIC — siehe _notify.js. Doppelversand-Schutz
// (5 Tage) steckt in der Dedupe des Verteilers.
import { loadRecipients, dispatch } from '../_notify.js';

const CHANNELS = {
  gillian: { channel: '3417815', envKey: 'TS_KEY_GILLIAN', label: 'Gillian' },
  sean:    { channel: '3417935', envKey: 'TS_KEY_SEAN',    label: 'Sean' }
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

// Komfort-Score (Server-Variante von lib/core.js, ohne Schimmel-Abzug).
// Schwellwerte (th) kommen jetzt aus den Nutzer-Einstellungen in D1 (Punkt 7),
// Defaults 19–24 °C / 40–60 % wie im Frontend.
function comfortScore(temp, rh, th = {}) {
  if ([temp, rh].some(v => v === null || v === undefined || isNaN(v))) return null;
  const tempMin = th.tempMin ?? 19, tempMax = th.tempMax ?? 24;
  const humMin = th.humMin ?? 40, humMax = th.humMax ?? 60;
  let score = 100;
  const tDev = temp < tempMin ? tempMin - temp : temp > tempMax ? temp - tempMax : 0;
  score -= Math.min(40, tDev * 8);
  const hDev = rh < humMin ? humMin - rh : rh > humMax ? rh - humMax : 0;
  score -= Math.min(30, hDev * 1.5);
  return Math.max(0, Math.round(score));
}

// Nutzer-Schwellwerte eines Standorts aus D1 (user_settings). Nimmt den ersten
// Treffer über alle Profile (typischerweise nur eines/Paar setzt sie).
async function loadThresholds(db, locId) {
  if (!db) return {};
  try {
    const row = await db.prepare("SELECT value FROM user_settings WHERE key = ? LIMIT 1").bind(`loc_thresholds_${locId}`).first();
    if (!row) return {};
    const v = JSON.parse(row.value);
    return (v && typeof v === 'object') ? v : {};
  } catch (e) { return {}; }
}

// Fest verdrahtete + D1-Standorte zusammenführen (Punkt 4).
async function loadChannels(env) {
  const out = {};
  for (const [id, loc] of Object.entries(CHANNELS)) {
    out[id] = { channel: loc.channel, apiKey: env[loc.envKey], label: loc.label };
  }
  if (env.DB) {
    try {
      await env.DB.exec("CREATE TABLE IF NOT EXISTS locations (id TEXT PRIMARY KEY, name TEXT, channel TEXT, read_key TEXT, lat REAL, lon REAL, fields TEXT, created_by TEXT, created_at INTEGER)");
      const { results } = await env.DB.prepare('SELECT id, name, channel, read_key FROM locations').all();
      (results || []).forEach(r => { out[r.id] = { channel: r.channel, apiKey: r.read_key, label: r.name || r.id }; });
    } catch (e) { /* nur fest verdrahtete */ }
  }
  return out;
}

const fmt = (v, d = 1) =>
  (v === null || v === undefined || isNaN(v)) ? '–' : v.toFixed(d).replace('.', ',');

// 'YYYY-MM-DD' → 'Mo 29.06.'
function fmtDay(day) {
  const d = new Date(`${day}T12:00:00Z`);
  if (isNaN(d.getTime())) return day;
  const wd = d.toLocaleDateString('de-DE', { weekday: 'short', timeZone: 'UTC' });
  return `${wd} ${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.`;
}

// Tageszeilen ({day, t_min, t_max, t_avg, h_avg}) zu einer Wochenstatistik verdichten
function aggregateRows(rows, th = {}) {
  const valid = (rows || []).filter(r => r.t_avg !== null && r.t_avg !== undefined);
  if (valid.length === 0) return null;

  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const tAvg = mean(valid.map(r => r.t_avg));
  const hVals = valid.map(r => r.h_avg).filter(v => v !== null && v !== undefined);
  const hAvg = hVals.length ? mean(hVals) : null;
  const tMinVals = valid.map(r => r.t_min).filter(v => v !== null && v !== undefined);
  const tMaxVals = valid.map(r => r.t_max).filter(v => v !== null && v !== undefined);

  let best = null, worst = null;
  const scores = [];
  valid.forEach(r => {
    const s = comfortScore(r.t_avg, r.h_avg, th);
    if (s === null) return;
    scores.push(s);
    if (!best || s > best.score) best = { day: r.day, score: s };
    if (!worst || s < worst.score) worst = { day: r.day, score: s };
  });

  return {
    days: valid.length,
    tAvg,
    tMin: tMinVals.length ? Math.min(...tMinVals) : null,
    tMax: tMaxVals.length ? Math.max(...tMaxVals) : null,
    hAvg,
    scoreAvg: scores.length ? Math.round(mean(scores)) : null,
    best, worst
  };
}

async function loadWeekFromD1(db, locId) {
  await db.exec("CREATE TABLE IF NOT EXISTS climate_daily (loc TEXT NOT NULL, day TEXT NOT NULL, t_min REAL, t_max REAL, t_avg REAL, h_min REAL, h_max REAL, h_avg REAL, samples INTEGER, PRIMARY KEY (loc, day))");
  const week = await db.prepare(
    "SELECT * FROM climate_daily WHERE loc = ? AND day >= date('now','-7 day') ORDER BY day"
  ).bind(locId).all();
  const prev = await db.prepare(
    "SELECT * FROM climate_daily WHERE loc = ? AND day >= date('now','-14 day') AND day < date('now','-7 day') ORDER BY day"
  ).bind(locId).all();
  return { rows: week.results || [], prevRows: prev.results || [] };
}

// Fallback ohne D1: Roh-Feeds von ThingSpeak zu Tageszeilen aggregieren
async function loadWeekFromThingSpeak(apiKey, channel) {
  const res = await fetch(`https://api.thingspeak.com/channels/${channel}/feeds.json?api_key=${apiKey}&results=8000`);
  if (!res.ok) throw new Error(`ThingSpeak ${res.status}`);
  const data = await res.json();
  const feeds = (data && data.feeds) || [];

  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const byDay = {};
  feeds.forEach(f => {
    const ms = new Date(f.created_at).getTime();
    if (isNaN(ms) || ms < cutoff) return;
    const day = f.created_at.substring(0, 10);
    const bucket = (byDay[day] = byDay[day] || { temps: [], hums: [] });
    const parse = v => {
      if (v === null || v === undefined || v.toString().trim() === '') return null;
      const n = parseFloat(v.toString().replace(',', '.'));
      return isNaN(n) ? null : n;
    };
    const t = parse(f.field1), h = parse(f.field2);
    if (t !== null) bucket.temps.push(t);
    if (h !== null) bucket.hums.push(h);
  });

  const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  return Object.entries(byDay)
    .filter(([, b]) => b.temps.length > 0)
    .map(([day, b]) => ({
      day,
      t_min: Math.min(...b.temps),
      t_max: Math.max(...b.temps),
      t_avg: mean(b.temps),
      h_avg: mean(b.hums)
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

export async function onRequestGet(context) {
  const { env } = context;

  const recipients = await loadRecipients(env);
  if (recipients.length === 0) {
    return json({ error: 'Kein ntfy-Empfänger konfiguriert (weder Profil-Topic in D1 noch NTFY_TOPIC)' }, 503);
  }

  const report = { generatedAt: new Date().toISOString(), recipients: recipients.map(r => r.profile), locations: {}, sent: false };
  const lines = [];
  const channels = await loadChannels(env);

  for (const [locId, loc] of Object.entries(channels)) {
    let agg = null, prevAgg = null, source = null;
    const th = await loadThresholds(env.DB, locId);

    // Bevorzugt: D1-Archiv (inkl. Vorwochen-Trend)
    if (env.DB) {
      try {
        const { rows, prevRows } = await loadWeekFromD1(env.DB, locId);
        agg = aggregateRows(rows, th);
        prevAgg = aggregateRows(prevRows, th);
        if (agg) source = 'd1';
      } catch (err) {
        report.locations[locId] = { d1Error: err.message };
      }
    }

    // Fallback: direkt aus ThingSpeak aggregieren
    if (!agg && loc.apiKey) {
      try {
        agg = aggregateRows(await loadWeekFromThingSpeak(loc.apiKey, loc.channel), th);
        if (agg) source = 'thingspeak';
      } catch (err) {
        report.locations[locId] = { ...(report.locations[locId] || {}), tsError: err.message };
      }
    }

    if (!agg) {
      report.locations[locId] = { ...(report.locations[locId] || {}), error: 'keine Daten' };
      lines.push(`🏠 ${loc.label}: diese Woche keine Daten.`);
      continue;
    }

    let trend = '';
    if (prevAgg && prevAgg.tAvg !== null) {
      const dT = agg.tAvg - prevAgg.tAvg;
      trend = ` Trend: ${dT >= 0 ? '+' : ''}${fmt(dT)} °C vs. Vorwoche.`;
    }
    const comfort = agg.scoreAvg === null ? '' :
      ` Komfort Ø ${agg.scoreAvg}/100` +
      (agg.best && agg.worst && agg.best.day !== agg.worst.day
        ? ` (bester Tag ${fmtDay(agg.best.day)} mit ${agg.best.score}, schwächster ${fmtDay(agg.worst.day)} mit ${agg.worst.score}).`
        : '.');

    lines.push(
      `🏠 ${loc.label} (${agg.days} Tage): Ø ${fmt(agg.tAvg)} °C (${fmt(agg.tMin)}–${fmt(agg.tMax)} °C), ` +
      `Feuchte Ø ${fmt(agg.hAvg, 0)} %.${comfort}${trend}`
    );
    report.locations[locId] = { ...agg, source };
  }

  const body = `Klima-Wochenbericht:\n\n${lines.join('\n\n')}`;
  report.notified = await dispatch(env, recipients, 'weekly', 'report', () => ({
    title: 'ClimateFlow Wochenbericht', body, tags: 'bar_chart', priority: 'default'
  }));
  report.sent = report.notified.length > 0;

  return json(report);
}
