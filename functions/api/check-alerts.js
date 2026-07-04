// Serverseitiger Sensor- UND Schimmelrisiko-Check mit Push via ntfy.sh.
// Funktioniert auch, wenn niemand das Dashboard offen hat — gedacht für einen
// externen Cron-Dienst (z. B. cron-job.org), der regelmäßig aufruft:
//   GET https://<deine-domain>/api/check-alerts
//
// Zwei Warnungen:
//   1. Sensor-Ausfall  — ein Feld liefert seit > 2 h keine echten Werte (max. 1×/6h)
//   2. Schimmelrisiko  — Wandoberflächen-Feuchte >= 80 % (bzw. >= 100 % Kondensat),
//      berechnet aus frischen Innenwerten + Open-Meteo-Außentemperatur (max. 1×/12h)
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
const CHANNELS = {
  gillian: { channel: '3417815', envKey: 'TS_KEY_GILLIAN', label: 'Gillian', lat: 48.7758, lon: 9.1829 },
  sean:    { channel: '3417935', envKey: 'TS_KEY_SEAN',    label: 'Sean',    lat: 52.5200, lon: 13.4050 }
};

const STALE_MS = 2 * 60 * 60 * 1000;
const DEDUPE_MS = 6 * 60 * 60 * 1000;
const MOLD_DEDUPE_MS = 12 * 60 * 60 * 1000;
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

// Serverseitige Schimmelrisiko-Prüfung: holt das Außenwetter (Open-Meteo) und
// vergleicht mit den letzten echten Innen-Messwerten. Pusht bei Kondensat (>=100 %)
// bzw. erhöhtem Risiko (>=80 %) an kalten Wandstellen. Best effort — Fehler hier
// dürfen die Sensor-Ausfall-Prüfung nicht beeinträchtigen.
async function checkMoldRisk(env, loc, feeds, report, locId) {
  const temp = lastRealValue(feeds, 'field1');
  const hum = lastRealValue(feeds, 'field2');
  const now = Date.now();
  // Nur mit frischen, vollständigen Innenwerten rechnen
  if (!temp || !hum || now - temp.ms > FRESH_MS || now - hum.ms > FRESH_MS) return;

  const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m&timeformat=unixtime`);
  if (!res.ok) return;
  const data = await res.json();
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

      const lastTemp = lastRealValueTime(feeds, 'field1');
      const lastHum = lastRealValueTime(feeds, 'field2');
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

      // Schimmelrisiko zusätzlich prüfen (nur bei frischen Innenwerten wirksam)
      try {
        await checkMoldRisk(env, loc, feeds, report, locId);
      } catch (moldErr) {
        report.locations[locId].moldError = moldErr.message;
      }
    } catch (err) {
      report.locations[locId] = { error: err.message };
    }
  }

  return json(report);
}
