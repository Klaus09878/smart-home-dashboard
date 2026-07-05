// Serverseitige Warn-Checks mit Push via ntfy.sh — läuft auch ohne offenes
// Dashboard, gedacht für einen externen Cron (z. B. cron-job.org):
//   GET https://<deine-domain>/api/check-alerts
//
// Warnungen: Sensor-Ausfall, Schimmel-/Kondensatrisiko, Frost, Hitze.
// Verteilung: an jedes Profil aus D1 (Topic + Regeln aus user_settings) mit
// dessen eigenen Schwellen, Ruhezeiten und Dedupe-Intervallen; Fallback auf das
// globale NTFY_TOPIC. Siehe _notify.js.
//
// Env (Pages → Settings → Environment variables):
//   NTFY_TOPIC                    – Fallback-Topic (wenn keine Profile in D1)
//   TS_KEY_GILLIAN / TS_KEY_SEAN  – ThingSpeak Read-Keys (wie beim feeds-Proxy)
import { loadRecipients, dispatch, typeCfg, isQuietNow, shouldSend, pushTo } from '../_notify.js';

const CHANNELS = {
  gillian: { channel: '3417815', envKey: 'TS_KEY_GILLIAN', label: 'Gillian', lat: 48.7758, lon: 9.1829, tempField: 'field1', humField: 'field2' },
  sean:    { channel: '3417935', envKey: 'TS_KEY_SEAN',    label: 'Sean',    lat: 52.5200, lon: 13.4050, tempField: 'field1', humField: 'field2' }
};

const STALE_MS = 2 * 60 * 60 * 1000;
const FRESH_MS = 2 * 60 * 60 * 1000; // Innenwert zu alt für die Schimmelprüfung

// Fest verdrahtete + über die Oberfläche angelegte Standorte (D1) zusammenführen.
async function loadChannels(env) {
  const out = {};
  for (const [id, loc] of Object.entries(CHANNELS)) {
    out[id] = { channel: loc.channel, apiKey: env[loc.envKey], label: loc.label, lat: loc.lat, lon: loc.lon, tempField: loc.tempField, humField: loc.humField };
  }
  if (env.DB) {
    try {
      await env.DB.exec("CREATE TABLE IF NOT EXISTS locations (id TEXT PRIMARY KEY, name TEXT, channel TEXT, read_key TEXT, lat REAL, lon REAL, fields TEXT, created_by TEXT, created_at INTEGER)");
      const { results } = await env.DB.prepare('SELECT id, name, channel, read_key, lat, lon, fields FROM locations').all();
      (results || []).forEach(r => {
        let f = {}; try { f = r.fields ? JSON.parse(r.fields) : {}; } catch (e) { /* Defaults */ }
        out[r.id] = { channel: r.channel, apiKey: r.read_key, label: r.name || r.id, lat: r.lat, lon: r.lon, tempField: f.temp || 'field1', humField: f.humidity || 'field2' };
      });
    } catch (e) { /* nur fest verdrahtete Standorte */ }
  }
  return out;
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

// Magnus/Wandoberfläche — Quelle der Wahrheit ist lib/core.js (dort getestet);
// hier bewusst inline, weil die Pages-Function eigenständig gebündelt wird.
function satVaporPressure(t) { return 6.112 * Math.exp((17.67 * t) / (t + 243.5)); }
function surfaceRhRaw(inTemp, inRh, outTemp, fRsi = 0.7) {
  const surfaceTemp = outTemp + fRsi * (inTemp - outTemp);
  const vaporPressure = (inRh / 100) * satVaporPressure(inTemp);
  return { surfaceTemp, rh: (vaporPressure / satVaporPressure(surfaceTemp)) * 100 };
}

function lastRealValue(feeds, field) {
  for (let i = feeds.length - 1; i >= 0; i--) {
    const v = feeds[i][field];
    if (v !== null && v !== undefined && v.toString().trim() !== '') {
      const num = parseFloat(v.toString().replace(',', '.'));
      if (!isNaN(num)) return { value: num, ms: new Date(feeds[i].created_at).getTime() };
    }
  }
  return null;
}

// Vom Dashboard gewählte Wetter-Koordinaten (app_config), sonst Defaults.
async function getCoordOverride(db, locId) {
  if (!db) return null;
  try {
    await db.exec("CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)");
    const row = await db.prepare('SELECT value FROM app_config WHERE key = ?').bind(`weather_${locId}`).first();
    const v = row ? JSON.parse(row.value) : null;
    return (v && typeof v.lat === 'number' && typeof v.lon === 'number') ? v : null;
  } catch (e) { return null; }
}

export async function onRequestGet(context) {
  const { env } = context;

  const recipients = await loadRecipients(env);
  if (recipients.length === 0) {
    return json({ error: 'Kein ntfy-Empfänger konfiguriert (weder Profil-Topic in D1 noch NTFY_TOPIC)' }, 503);
  }

  // Heartbeat für die System-Diagnose (/api/health): belegt, dass der Cron läuft
  if (env.DB) {
    try {
      await env.DB.exec("CREATE TABLE IF NOT EXISTS alert_state (key TEXT PRIMARY KEY, last_sent INTEGER)");
      await env.DB.prepare('INSERT OR REPLACE INTO alert_state (key, last_sent) VALUES (?, ?)').bind('cron_heartbeat', Date.now()).run();
      // D1-Hygiene (Punkt 9): verwaiste Dedupe-Zeilen (> 30 Tage, außer Heartbeat)
      // und alte To-do-Tombstones (> 30 Tage gelöscht) entfernen.
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      await env.DB.prepare("DELETE FROM alert_state WHERE key != 'cron_heartbeat' AND last_sent < ?").bind(cutoff).run();
      try { await env.DB.prepare('DELETE FROM todos WHERE deleted = 1 AND updated_at < ?').bind(cutoff).run(); } catch (e) { /* todos evtl. nicht vorhanden */ }
    } catch (e) { /* Heartbeat/Cleanup ist best effort */ }
  }

  const report = { checkedAt: new Date().toISOString(), recipients: recipients.map(r => r.profile), locations: {}, notified: [] };
  const now = Date.now();
  const channels = await loadChannels(env);

  for (const [locId, loc] of Object.entries(channels)) {
    const apiKey = loc.apiKey;
    if (!apiKey) { report.locations[locId] = { error: `Read-Key für ${locId} nicht konfiguriert` }; continue; }
    const R = report.locations[locId] = {};

    try {
      // ---- Innenwerte (ThingSpeak) ----
      const res = await fetch(`https://api.thingspeak.com/channels/${loc.channel}/feeds.json?api_key=${apiKey}&results=400`);
      if (!res.ok) throw new Error(`ThingSpeak ${res.status}`);
      const feeds = ((await res.json()) || {}).feeds || [];

      const t = lastRealValue(feeds, loc.tempField);
      const h = lastRealValue(feeds, loc.humField);
      const fmt = ms => ms ? `${Math.round((now - ms) / 3600000)} h` : 'nie';
      const problems = [];
      if (!t || now - t.ms > STALE_MS) problems.push(`Temperatur (letzter Wert vor ${fmt(t && t.ms)})`);
      if (!h || now - h.ms > STALE_MS) problems.push(`Luftfeuchtigkeit (letzter Wert vor ${fmt(h && h.ms)})`);
      R.problems = problems;

      // ---- Außenwetter (Open-Meteo): Frost, Hitze, Schimmel-Grundlage ----
      const coords = (await getCoordOverride(env.DB, locId)) || loc;
      R.weatherCoords = { lat: coords.lat, lon: coords.lon, source: coords === loc ? 'default' : 'dashboard' };
      let frostMin = null, heatMax = null, moldRh = null, moldTemp = null, outTemp = null;
      try {
        const wres = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m&daily=temperature_2m_min,temperature_2m_max&forecast_days=2&timezone=auto&timeformat=unixtime`);
        if (wres.ok) {
          const w = await wres.json();
          const mins = ((w.daily || {}).temperature_2m_min || []).filter(v => v != null && !isNaN(v));
          const maxs = ((w.daily || {}).temperature_2m_max || []).filter(v => v != null && !isNaN(v));
          frostMin = mins.length ? Math.min(...mins) : null;
          heatMax = maxs.length ? Math.max(...maxs) : null;
          outTemp = w.current ? w.current.temperature_2m : null;

          if (t && h && now - t.ms <= FRESH_MS && now - h.ms <= FRESH_MS && outTemp != null && !isNaN(outTemp)) {
            const s = surfaceRhRaw(t.value, h.value, outTemp);
            moldRh = Math.min(100, s.rh);
            moldTemp = s.surfaceTemp;
          }
        }
      } catch (e) { R.weatherError = e.message; }
      R.frostMin = frostMin; R.heatMax = heatMax;
      if (moldRh != null) R.mold = { surfaceRh: Math.round(moldRh), surfaceTemp: Math.round(moldTemp * 10) / 10, outTemp };

      // ---- Verteilung an die Profile ----
      if (problems.length > 0) {
        report.notified.push(...await dispatch(env, recipients, 'sensor', locId, () => ({
          title: 'ClimateFlow Sensor-Warnung',
          body: `Sensor-Ausfall bei ${loc.label}: ${problems.join(' und ')}. Bitte iPhone-Kurzbefehl prüfen.`,
          tags: 'warning,thermometer'
        })));
      }

      if (frostMin != null) {
        report.notified.push(...await dispatch(env, recipients, 'frost', locId, rec => {
          const th = typeCfg(rec.rules, 'frost').threshold ?? 0;
          if (frostMin > th) return null;
          return {
            title: 'ClimateFlow Frost-Warnung',
            body: `Frost bei ${loc.label}: Tiefstwert ${frostMin.toFixed(1)} °C in den nächsten 2 Tagen (Grenze ${th} °C). Fenster schließen, Pflanzen schützen.`,
            tags: 'snowflake'
          };
        }));
      }

      if (heatMax != null) {
        report.notified.push(...await dispatch(env, recipients, 'heat', locId, rec => {
          const th = typeCfg(rec.rules, 'heat').threshold ?? 30;
          if (heatMax < th) return null;
          return {
            title: 'ClimateFlow Hitze-Warnung',
            body: `Hitze bei ${loc.label}: Höchstwert ${heatMax.toFixed(1)} °C in den nächsten 2 Tagen (Grenze ${th} °C). Tagsüber Fenster/Rollos schließen.`,
            tags: 'fire'
          };
        }));
      }

      if (moldRh != null) {
        report.notified.push(...await dispatch(env, recipients, 'mold', locId, rec => {
          const th = typeCfg(rec.rules, 'mold').threshold ?? 80;
          if (moldRh < th) return null;
          if (moldRh >= 100) return {
            title: 'ClimateFlow Kondensat-Warnung',
            body: `Kondensatgefahr bei ${loc.label}: Wandoberfläche nur ~${moldTemp.toFixed(1)} °C bei ${t.value.toFixed(1)} °C / ${h.value.toFixed(0)} % innen. Dringend lüften und heizen!`,
            tags: 'rotating_light,droplet'
          };
          return {
            title: 'ClimateFlow Schimmel-Warnung',
            body: `Erhöhtes Schimmelrisiko bei ${loc.label}: ca. ${Math.round(moldRh)} % Feuchte an kalten Wandstellen (innen ${t.value.toFixed(1)} °C / ${h.value.toFixed(0)} %, außen ${outTemp.toFixed(1)} °C, Grenze ${th} %). Lüften/heizen empfohlen.`,
            tags: 'warning,droplet'
          };
        }));
      }
    } catch (err) {
      R.error = err.message;
    }
  }

  // ---- Überfällige To-dos je Profil erinnern (P12) ----
  if (env.DB) {
    try {
      await env.DB.exec("CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, profile TEXT, text TEXT, done INTEGER DEFAULT 0, due_ms INTEGER, repeat_days INTEGER, shared INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER, deleted INTEGER DEFAULT 0)");
      for (const rec of recipients) {
        if (rec.profile === '_global') continue; // globales Fallback-Topic hat keine To-dos
        const cfg = typeCfg(rec.rules, 'todo');
        if (!cfg.on || isQuietNow(rec.rules)) continue;
        const { results } = await env.DB.prepare(
          "SELECT text FROM todos WHERE (profile = ? OR shared = 1) AND done = 0 AND deleted = 0 AND due_ms IS NOT NULL AND due_ms < ? ORDER BY due_ms LIMIT 5"
        ).bind(rec.profile, Date.now()).all();
        const overdue = results || [];
        if (!overdue.length) continue;
        const dedupeMs = (cfg.dedupeH ?? 24) * 60 * 60 * 1000;
        if (!(await shouldSend(env.DB, `${rec.profile}:todo:overdue`, dedupeMs))) continue;
        await pushTo(rec.topic, {
          title: 'Offene To-dos',
          body: `Überfällig:\n${overdue.map(t => `• ${t.text}`).join('\n')}`,
          tags: 'check', priority: 'default'
        });
        report.notified.push(`${rec.profile}:todo:overdue`);
      }
    } catch (e) { report.todoError = e.message; }
  }

  return json(report);
}
