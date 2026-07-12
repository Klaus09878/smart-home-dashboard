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
import { loadRecipients, dispatch, typeCfg, isQuietNow, shouldSend, pushTo, pushToSubs, vapidFromEnv } from '../_notify.js';

// ICS-Host-Allowlist (Kopie aus functions/api/ical.js) fuer den Morgen-Digest.
const DIGEST_ICAL_HOSTS = ['google.com', 'googleusercontent.com', 'icloud.com', 'me.com', 'outlook.com', 'outlook.office365.com', 'office365.com', 'live.com', 'yahoo.com', 'fastmail.com', 'posteo.de', 'mailbox.org', 'gmx.net', 'web.de'];
function digestIcalAllowed(url) {
  try { const h = new URL(url).hostname.toLowerCase(); return DIGEST_ICAL_HOSTS.some(s => h === s || h.endsWith('.' + s)); }
  catch (e) { return false; }
}
// Titel heutiger Termine grob aus dem ICS ziehen (kein RRULE-Support — bewusst
// simpel: nur VEVENTs, deren DTSTART das heutige Datum enthaelt).
async function fetchTodayIcs(url, ymd) {
  try {
    const res = await fetch(url, { cf: { cacheTtl: 300 } });
    if (!res.ok) return [];
    const text = (await res.text()).slice(0, 512 * 1024);
    const out = [];
    for (const block of text.split('BEGIN:VEVENT').slice(1)) {
      const dt = (block.match(/DTSTART[^:]*:([0-9T]+)/) || [])[1] || '';
      if (dt.indexOf(ymd) !== 0) continue;
      const sum = (block.match(/SUMMARY[^:]*:(.+)/) || [])[1];
      if (sum) out.push(sum.trim().replace(/\\,/g, ',').slice(0, 60));
      if (out.length >= 3) break;
    }
    return out;
  } catch (e) { return []; }
}

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
        const co2Extra = (Array.isArray(f.extra) ? f.extra : []).find(e => e && e.key === 'co2');
        out[r.id] = { channel: r.channel, apiKey: r.read_key, label: r.name || r.id, lat: r.lat, lon: r.lon, tempField: f.temp || 'field1', humField: f.humidity || 'field2', co2Field: co2Extra ? co2Extra.field : null };
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
function absHumidity(t, rh) { return (216.74 * ((rh / 100) * satVaporPressure(t))) / (t + 273.15); }

// Bestes Lüftungsfenster der nächsten 12 h: die Stunde mit der geringsten
// Außen-Absolutfeuchte, sofern sie deutlich unter der Innenfeuchte liegt.
function bestVentWindow(inAH, hourly, nowMs) {
  if (!hourly || !hourly.time) return null;
  let best = null;
  for (let i = 0; i < hourly.time.length; i++) {
    const ms = hourly.time[i] * 1000;
    if (ms < nowMs || ms > nowMs + 12 * 3600000) continue;
    const ot = hourly.temperature_2m[i], orh = hourly.relative_humidity_2m[i];
    if (ot == null || orh == null) continue;
    const outAH = absHumidity(ot, orh);
    if (outAH < inAH - 1.0 && (!best || outAH < best.outAH)) best = { ms, outAH, ot };
  }
  return best;
}

// Fenster-offen-Erkennung — Quelle der Wahrheit: detectOpenWindow in lib/core.js
// (dort getestet); hier bewusst inline, weil die Pages-Function eigenstaendig
// gebuendelt wird.
function detectOpenWindowRaw(feeds, tempField, now) {
  const pts = [];
  for (const f of feeds) {
    const v = f[tempField];
    if (v == null || v.toString().trim() === '') continue;
    const t = parseFloat(v.toString().replace(',', '.'));
    if (!isNaN(t)) pts.push({ ms: new Date(f.created_at).getTime(), temp: t });
  }
  if (pts.length < 2) return { open: false };
  const last = pts[pts.length - 1];
  if (now - last.ms > 20 * 60 * 1000) return { open: false };
  const span = pts.filter(p => p.ms >= last.ms - 45 * 60 * 1000);
  if (span.length < 2) return { open: false };
  const temps = span.map(p => p.temp);
  const drop = Math.max(...temps) - last.temp;
  if (drop < 2.5) return { open: false };
  if (last.temp > Math.min(...temps) + 0.3) return { open: false };
  return { open: true, dropC: Math.round(drop * 10) / 10 };
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
      // Login-Fehlversuchszaehler (P2-5): Zeilen aelter als 1 h entfernen
      try { await env.DB.prepare('DELETE FROM auth_fails WHERE first_ms < ?').bind(Date.now() - 60 * 60 * 1000).run(); } catch (e) { /* auth_fails evtl. noch nicht vorhanden */ }
      // Warnungs-Protokoll (P3-2): Eintraege aelter als 60 Tage entfernen
      try { await env.DB.prepare('DELETE FROM alert_log WHERE ts < ?').bind(Date.now() - 60 * 24 * 60 * 60 * 1000).run(); } catch (e) { /* alert_log evtl. noch nicht vorhanden */ }
    } catch (e) { /* Heartbeat/Cleanup ist best effort */ }
  }

  const report = { checkedAt: new Date().toISOString(), recipients: recipients.map(r => r.profile), locations: {}, notified: [] };
  const now = Date.now();
  const channels = await loadChannels(env);

  // Fuer den Morgen-Digest (P3-5) waehrend der Schleife eingesammelt
  const digestClimate = [];
  let digestWeather = null;

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
      let frostMin = null, heatMax = null, moldRh = null, moldTemp = null, outTemp = null, ventWindow = null;
      try {
        const wres = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m&daily=temperature_2m_min,temperature_2m_max&hourly=temperature_2m,relative_humidity_2m&forecast_days=2&timezone=auto&timeformat=unixtime`);
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
            // Bestes Lüftungsfenster (Punkt 16) — nur mit frischen Innenwerten sinnvoll
            ventWindow = bestVentWindow(absHumidity(t.value, h.value), w.hourly, now);
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

      // ---- Fenster offen vergessen (P3-4) ----
      const ow = detectOpenWindowRaw(feeds, loc.tempField, now);
      if (ow.open) {
        R.openWindow = ow.dropC;
        report.notified.push(...await dispatch(env, recipients, 'window', locId, () => ({
          title: 'ClimateFlow: Fenster offen?',
          body: `Bei ${loc.label} ist die Temperatur in ~45 min um ${ow.dropC} °C gefallen und erholt sich nicht — Fenster offen vergessen?`,
          tags: 'window'
        })));
      }

      // ---- Amtliche Unwetterwarnungen (DWD via BrightSky, P2-11) ----
      // Nur schwere/extreme Lagen pushen; Dedupe pro Alert-ID, damit neue
      // Warnungen trotz Entprellung durchkommen. Ausserhalb DE liefert die API [].
      try {
        const ares = await fetch(`https://api.brightsky.dev/alerts?lat=${coords.lat}&lon=${coords.lon}`);
        if (ares.ok) {
          const alerts = ((await ares.json()) || {}).alerts || [];
          const severe = alerts.filter(a => a && (a.severity === 'severe' || a.severity === 'extreme'));
          if (severe.length) R.dwd = severe.map(a => a.event_de || a.headline_de);
          for (const a of severe) {
            report.notified.push(...await dispatch(env, recipients, 'dwd', `${locId}:${a.id}`, () => ({
              title: `DWD-Warnung: ${a.event_de || 'Unwetter'}`,
              body: `${a.headline_de || a.event_de} (${loc.label}).${a.instruction_de ? ' ' + a.instruction_de : ''}`,
              tags: 'cloud_with_lightning'
            })));
          }
        }
      } catch (e) { R.dwdError = e.message; }

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

      // ---- CO₂ (P8): nur wenn der Standort einen co2-Sensor konfiguriert hat ----
      if (loc.co2Field) {
        const c = lastRealValue(feeds, loc.co2Field);
        if (c && now - c.ms <= FRESH_MS) {
          R.co2 = Math.round(c.value);
          report.notified.push(...await dispatch(env, recipients, 'co2', locId, rec => {
            const th = typeCfg(rec.rules, 'co2').threshold ?? 1200;
            if (c.value < th) return null;
            return {
              title: 'ClimateFlow CO₂-Warnung',
              body: `Hohe CO₂-Konzentration bei ${loc.label}: ${Math.round(c.value)} ppm (Grenze ${th} ppm). Stoßlüften für frische Luft.`,
              tags: 'wind'
            };
          }));
        }
      }

      // Fuer den Morgen-Digest einsammeln (P3-5)
      if (t && h) digestClimate.push({ label: loc.label, temp: t.value, hum: h.value });
      if (!digestWeather && (frostMin != null || heatMax != null)) digestWeather = { min: frostMin, max: heatMax };

      // Lüftungsfenster-Push (Punkt 16): nur morgens (Berlin 6–10 Uhr) und wenn
      // es ein gutes Fenster gibt. Typ 'vent' ist per Voreinstellung aus (opt-in).
      const berlinHour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/Berlin' }).format(new Date()));
      if (ventWindow && berlinHour >= 6 && berlinHour <= 10) {
        const when = new Date(ventWindow.ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
        report.notified.push(...await dispatch(env, recipients, 'vent', locId, () => ({
          title: 'ClimateFlow Lüftungstipp',
          body: `Gutes Lüftungsfenster bei ${loc.label} gegen ${when} Uhr (außen ${ventWindow.ot.toFixed(0)} °C, trockener als drinnen). Kurz stoßlüften senkt die Feuchte.`,
          tags: 'wind', priority: 'default'
        })));
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
        // fällig heute oder überfällig (bis in ~12 h, damit die Erinnerung am
        // Fälligkeitstag kommt, nicht erst danach — Punkt 19)
        const horizon = Date.now() + 12 * 60 * 60 * 1000;
        const { results } = await env.DB.prepare(
          "SELECT text, due_ms FROM todos WHERE (profile = ? OR shared = 1) AND done = 0 AND deleted = 0 AND due_ms IS NOT NULL AND due_ms < ? ORDER BY due_ms LIMIT 5"
        ).bind(rec.profile, horizon).all();
        const due = results || [];
        if (!due.length) continue;
        const dedupeMs = (cfg.dedupeH ?? 24) * 60 * 60 * 1000;
        if (!(await shouldSend(env.DB, `${rec.profile}:todo:overdue`, dedupeMs))) continue;
        await pushTo(rec.topic, {
          title: 'Offene To-dos',
          body: `Fällig/überfällig:\n${due.map(t => `• ${t.text}${t.due_ms < Date.now() ? ' (überfällig)' : ''}`).join('\n')}`,
          tags: 'check', priority: 'default'
        });
        report.notified.push(`${rec.profile}:todo:overdue`);
      }
    } catch (e) { report.todoError = e.message; }
  }

  // ---- Morgen-Digest (P3-5): ein Push mit dem Tagesueberblick, opt-in ----
  if (env.DB) {
    try {
      const berlinHour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/Berlin' }).format(new Date()));
      if (berlinHour >= 6 && berlinHour <= 9) {
        const berlinYmd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/-/g, '');
        const vapid = vapidFromEnv(env);
        for (const rec of recipients) {
          if (rec.profile === '_global') continue;
          const cfg = typeCfg(rec.rules, 'digest');
          if (!cfg.on || isQuietNow(rec.rules)) continue;
          if (!(await shouldSend(env.DB, `${rec.profile}:digest`, (cfg.dedupeH ?? 20) * 60 * 60 * 1000))) continue;

          const parts = [];
          if (digestWeather) {
            const w = [];
            if (digestWeather.min != null) w.push(`min ${digestWeather.min.toFixed(0)} °C`);
            if (digestWeather.max != null) w.push(`max ${digestWeather.max.toFixed(0)} °C`);
            if (w.length) parts.push(`Wetter: ${w.join(' / ')}`);
          }
          if (digestClimate.length) parts.push('Innen: ' + digestClimate.map(c => `${c.label} ${c.temp.toFixed(1)} °C/${c.hum.toFixed(0)} %`).join(' · '));
          try {
            const { results } = await env.DB.prepare("SELECT text FROM todos WHERE (profile = ? OR shared = 1) AND done = 0 AND deleted = 0 AND due_ms IS NOT NULL AND due_ms < ? ORDER BY due_ms LIMIT 5")
              .bind(rec.profile, Date.now() + 24 * 60 * 60 * 1000).all();
            const todos = (results || []).map(r => r.text);
            if (todos.length) parts.push(`To-dos: ${todos.join(', ')}`);
          } catch (e) { /* optional */ }
          try {
            const s = await env.DB.prepare("SELECT value FROM user_settings WHERE profile = ? AND key = 'ical_url'").bind(rec.profile).first();
            if (s && s.value && digestIcalAllowed(s.value)) {
              const evs = await fetchTodayIcs(s.value, berlinYmd);
              if (evs.length) parts.push(`Termine: ${evs.join(', ')}`);
            }
          } catch (e) { /* optional */ }

          if (!parts.length) continue;
          const msg = { title: 'Guten Morgen – Tagesüberblick', body: parts.join('\n'), tags: 'sun_with_face', priority: 'default' };
          if (rec.topic) { try { await pushTo(rec.topic, msg); } catch (e) { /* ntfy */ } }
          if (rec.subs && rec.subs.length) { try { await pushToSubs(env.DB, rec.subs, msg, vapid); } catch (e) { /* web-push */ } }
          report.notified.push(`${rec.profile}:digest`);
        }
      }
    } catch (e) { report.digestError = e.message; }
  }

  return json(report);
}
