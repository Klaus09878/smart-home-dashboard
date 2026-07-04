// Serverseitiger Sensor- UND Schimmelrisiko-Check mit Push via ntfy.sh.
// Funktioniert auch, wenn niemand das Dashboard offen hat — gedacht für einen
// externen Cron-Dienst (z. B. cron-job.org), der regelmäßig aufruft:
//   GET https://<deine-domain>/api/check-alerts
//
// Drei Warnungen:
//   1. Sensor-Ausfall  — ein Feld liefert seit > 2 h keine echten Werte (max. 1×/6h)
//   2. Schimmelrisiko  — Wandoberflächen-Feuchte >= 80 % (bzw. >= 100 % Kondensat),
//      berechnet aus frischen Innenwerten + Open-Meteo-Außentemperatur (max. 1×/12h)
//   3. Frost           — Tages-Tiefstwert der nächsten 2 Tage <= 0 °C (max. 1×/18h)
//
// Einrichtung (Pages → Settings → Environment variables):
//   NTFY_TOPIC     = <dein geheimer ntfy-Topic-Name, z. B. smarthub-sean-x7k2>
//   TS_KEY_GILLIAN / TS_KEY_SEAN = ThingSpeak Read-Keys (wie beim feeds-Proxy)
// Auf dem Handy: ntfy-App installieren und dasselbe Topic abonnieren.
//
// Dedupe: Ist die D1-Datenbank (Binding "DB") vorhanden, wird pro Warnung
// höchstens alle 6 h (Sensor) bzw. 12 h (Schimmel) eine Push-Nachricht verschickt.
// Ohne D1 kein Dedupe — dann pro Cron-Aufruf max. eine Nachricht je Warnung.

// Koordinaten je Standort für den Außenwetter-Abruf (Open-Meteo) — nötig für
// die serverseitige Schimmelrisiko-Prüfung. Entsprechen den Defaults in app.js.
// tempField/humField: Feld-Zuordnung des ThingSpeak-Kanals (Schema wie LOCATIONS[].fields).
const CHANNELS = {
  gillian: { channel: '3417815', envKey: 'TS_KEY_GILLIAN', label: 'Gillian', lat: 48.7758, lon: 9.1829, tempField: 'field1', humField: 'field2' },
  sean:    { channel: '3417935', envKey: 'TS_KEY_SEAN',    label: 'Sean',    lat: 52.5200, lon: 13.4050, tempField: 'field1', humField: 'field2' }
};

const STALE_MS = 2 * 60 * 60 * 1000;
const DEDUPE_MS = 6 * 60 * 60 * 1000;
const MOLD_DEDUPE_MS = 12 * 60 * 60 * 1000;
const FROST_DEDUPE_MS = 18 * 60 * 60 * 1000;
// Wert gilt als zu alt für die Schimmelprüfung, wenn älter als:
const FRESH_MS = 2 * 60 * 60 * 1000;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

// Magnus/Wandoberflächen-Formeln — Quelle der Wahrheit ist lib/core.js
// (dort getestet via npm test); hier bewusst inline, da die Pages-Function
// eigenständig gebündelt wird und das UMD-Modul nicht sauber importieren kann.
function satVaporPressure(t) {
  return 6.112 * Math.exp((17.67 * t) / (t + 243.5));
}
function surfaceRhRaw(inTemp, inRh, outTemp, fRsi = 0.7) {
  const surfaceTemp = outTemp + fRsi * (inTemp - outTemp);
  const vaporPressure = (inRh / 100) * satVaporPressure(inTemp);
  return { surfaceTemp, rh: (vaporPressure / satVaporPressure(surfaceTemp)) * 100 };
}

// Letzter echter (nicht-leerer) Messwert eines Feldes: { value, ms } oder null.
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

function lastRealValueTime(feeds, field) {
  const r = lastRealValue(feeds, field);
  return r ? r.ms : null;
}

async function shouldSend(db, key, dedupeMs = DEDUPE_MS) {
  if (!db) return true;
  await db.exec("CREATE TABLE IF NOT EXISTS alert_state (key TEXT PRIMARY KEY, last_sent INTEGER)");
  const row = await db.prepare('SELECT last_sent FROM alert_state WHERE key = ?').bind(key).first();
  if (row && Date.now() - row.last_sent < dedupeMs) return false;
  await db.prepare('INSERT OR REPLACE INTO alert_state (key, last_sent) VALUES (?, ?)').bind(key, Date.now()).run();
  return true;
}

// Serverseitige Wetter-Prüfungen (ein Open-Meteo-Fetch pro Standort):
//   Frost — Tages-Tiefstwert der nächsten 2 Tage <= 0 °C (unabhängig von Innenwerten)
//   Schimmelrisiko — nur mit frischen Innen-Messwerten: Wandoberflächen-Feuchte
//   >= 80 % (Warnung) bzw. >= 100 % (Kondensat).
// Best effort — Fehler hier dürfen die Sensor-Ausfall-Prüfung nicht beeinträchtigen.
// Vom Dashboard gewählte Wetter-Koordinaten aus D1 lesen (app_config,
// geschrieben über /api/config bei jeder Standort-Änderung im Frontend).
// Fallback: Default-Koordinaten aus CHANNELS.
async function getCoordOverride(db, locId) {
  if (!db) return null;
  try {
    await db.exec("CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)");
    const row = await db.prepare('SELECT value FROM app_config WHERE key = ?').bind(`weather_${locId}`).first();
    const v = row ? JSON.parse(row.value) : null;
    return (v && typeof v.lat === 'number' && typeof v.lon === 'number') ? v : null;
  } catch (e) {
    return null;
  }
}

async function checkWeatherRisks(env, loc, feeds, report, locId) {
  const coords = (await getCoordOverride(env.DB, locId)) || loc;
  report.locations[locId].weatherCoords = { lat: coords.lat, lon: coords.lon, source: coords === loc ? 'default' : 'dashboard' };
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m&daily=temperature_2m_min&forecast_days=2&timezone=auto&timeformat=unixtime`);
  if (!res.ok) return;
  const data = await res.json();

  // ---- Frost-Warnung (auch ohne Innenwerte sinnvoll) ----
  const mins = (data && data.daily && data.daily.temperature_2m_min) || [];
  const validMins = mins.filter(v => v !== null && v !== undefined && !isNaN(v));
  const frostMin = validMins.length ? Math.min(...validMins) : null;
  report.locations[locId].frostMin = frostMin;
  if (frostMin !== null && frostMin <= 0 && await shouldSend(env.DB, `frost_${locId}`, FROST_DEDUPE_MS)) {
    await fetch(`https://ntfy.sh/${encodeURIComponent(env.NTFY_TOPIC)}`, {
      method: 'POST',
      body: `Frost bei ${loc.label}: Tiefstwert ${frostMin.toFixed(1)} °C in den nächsten 2 Tagen. Fenster schließen, empfindliche Pflanzen schützen.`,
      headers: { 'Title': 'ClimateFlow Frost-Warnung', 'Tags': 'snowflake', 'Priority': 'high' }
    });
    report.notified.push(`${locId}:frost`);
  }

  // ---- Schimmelrisiko: nur mit frischen, vollständigen Innenwerten ----
  const temp = lastRealValue(feeds, loc.tempField || 'field1');
  const hum = lastRealValue(feeds, loc.humField || 'field2');
  const now = Date.now();
  if (!temp || !hum || now - temp.ms > FRESH_MS || now - hum.ms > FRESH_MS) return;

  const outTemp = data && data.current ? data.current.temperature_2m : null;
  if (outTemp === null || outTemp === undefined || isNaN(outTemp)) return;

  const { surfaceTemp, rh } = surfaceRhRaw(temp.value, hum.value, outTemp);
  report.locations[locId].mold = { surfaceRh: Math.round(Math.min(100, rh)), surfaceTemp: Math.round(surfaceTemp * 10) / 10, outTemp };

  let title = null, body = null, tags = null;
  if (rh >= 100) {
    title = 'ClimateFlow Kondensat-Warnung';
    body = `Kondensatgefahr bei ${loc.label}: Wandoberfläche nur ~${surfaceTemp.toFixed(1)} °C bei ${temp.value.toFixed(1)} °C / ${hum.value.toFixed(0)} % innen. Dringend lüften und heizen!`;
    tags = 'rotating_light,droplet';
  } else if (rh >= 80) {
    title = 'ClimateFlow Schimmel-Warnung';
    body = `Erhöhtes Schimmelrisiko bei ${loc.label}: ca. ${Math.round(rh)} % Feuchte an kalten Wandstellen (innen ${temp.value.toFixed(1)} °C / ${hum.value.toFixed(0)} %, außen ${outTemp.toFixed(1)} °C). Lüften/heizen empfohlen.`;
    tags = 'warning,droplet';
  }

  if (title && await shouldSend(env.DB, `mold_${locId}`, MOLD_DEDUPE_MS)) {
    await fetch(`https://ntfy.sh/${encodeURIComponent(env.NTFY_TOPIC)}`, {
      method: 'POST',
      body,
      headers: { 'Title': title, 'Tags': tags, 'Priority': 'high' }
    });
    report.notified.push(`${locId}:mold`);
  }
}

export async function onRequestGet(context) {
  const { env } = context;

  if (!env.NTFY_TOPIC) {
    return json({ error: 'Env-Variable NTFY_TOPIC nicht konfiguriert' }, 503);
  }

  const report = { checkedAt: new Date().toISOString(), locations: {}, notified: [] };

  for (const [locId, loc] of Object.entries(CHANNELS)) {
    const apiKey = env[loc.envKey];
    if (!apiKey) {
      report.locations[locId] = { error: `${loc.envKey} nicht konfiguriert` };
      continue;
    }

    try {
      const res = await fetch(`https://api.thingspeak.com/channels/${loc.channel}/feeds.json?api_key=${apiKey}&results=400`);
      if (!res.ok) throw new Error(`ThingSpeak ${res.status}`);
      const data = await res.json();
      const feeds = (data && data.feeds) || [];

      const lastTemp = lastRealValueTime(feeds, loc.tempField || 'field1');
      const lastHum = lastRealValueTime(feeds, loc.humField || 'field2');
      const problems = [];
      const fmt = ms => ms ? `${Math.round((Date.now() - ms) / 3600000)} h` : 'nie';

      if (!lastTemp || Date.now() - lastTemp > STALE_MS) problems.push(`Temperatur (letzter Wert vor ${fmt(lastTemp)})`);
      if (!lastHum || Date.now() - lastHum > STALE_MS) problems.push(`Luftfeuchtigkeit (letzter Wert vor ${fmt(lastHum)})`);

      report.locations[locId] = { lastTemp, lastHum, problems };

      if (problems.length > 0 && await shouldSend(env.DB, `stale_${locId}`)) {
        await fetch(`https://ntfy.sh/${encodeURIComponent(env.NTFY_TOPIC)}`, {
          method: 'POST',
          body: `Sensor-Ausfall bei ${loc.label}: ${problems.join(' und ')}. Bitte iPhone-Kurzbefehl prüfen.`,
          headers: { 'Title': 'ClimateFlow Sensor-Warnung', 'Tags': 'warning,thermometer', 'Priority': 'high' }
        });
        report.notified.push(locId);
      }

      // Wetter-Risiken zusätzlich prüfen (Frost immer; Schimmel bei frischen Innenwerten)
      try {
        await checkWeatherRisks(env, loc, feeds, report, locId);
      } catch (weatherErr) {
        report.locations[locId].weatherError = weatherErr.message;
      }
    } catch (err) {
      report.locations[locId] = { error: err.message };
    }
  }

  return json(report);
}
