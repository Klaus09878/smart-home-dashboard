// Serverseitiger Sensor-Check mit Push-Benachrichtigung via ntfy.sh.
// Funktioniert auch, wenn niemand das Dashboard offen hat — gedacht für einen
// externen Cron-Dienst (z. B. cron-job.org), der regelmäßig aufruft:
//   GET https://<deine-domain>/api/check-alerts
//
// Einrichtung (Pages → Settings → Environment variables):
//   NTFY_TOPIC     = <dein geheimer ntfy-Topic-Name, z. B. smarthub-sean-x7k2>
//   TS_KEY_GILLIAN / TS_KEY_SEAN = ThingSpeak Read-Keys (wie beim feeds-Proxy)
// Auf dem Handy: ntfy-App installieren und dasselbe Topic abonnieren.
//
// Dedupe: Ist die D1-Datenbank (Binding "DB") vorhanden, wird pro Warnung
// höchstens alle 6 h eine Push-Nachricht verschickt.

const CHANNELS = {
  gillian: { channel: '3417815', envKey: 'TS_KEY_GILLIAN', label: 'Gillian' },
  sean:    { channel: '3417935', envKey: 'TS_KEY_SEAN',    label: 'Sean' }
};

const STALE_MS = 2 * 60 * 60 * 1000;
const DEDUPE_MS = 6 * 60 * 60 * 1000;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

function lastRealValueTime(feeds, field) {
  for (let i = feeds.length - 1; i >= 0; i--) {
    const v = feeds[i][field];
    if (v !== null && v !== undefined && v.toString().trim() !== '') {
      return new Date(feeds[i].created_at).getTime();
    }
  }
  return null;
}

async function shouldSend(db, key) {
  if (!db) return true;
  await db.exec("CREATE TABLE IF NOT EXISTS alert_state (key TEXT PRIMARY KEY, last_sent INTEGER)");
  const row = await db.prepare('SELECT last_sent FROM alert_state WHERE key = ?').bind(key).first();
  if (row && Date.now() - row.last_sent < DEDUPE_MS) return false;
  await db.prepare('INSERT OR REPLACE INTO alert_state (key, last_sent) VALUES (?, ?)').bind(key, Date.now()).run();
  return true;
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
    } catch (err) {
      report.locations[locId] = { error: err.message };
    }
  }

  return json(report);
}
