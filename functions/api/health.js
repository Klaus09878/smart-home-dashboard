// System-Diagnose für die Einstellungsseite (P15). Läuft hinter der Auth.
// Prüft D1-Erreichbarkeit, Vorhandensein der Env-Vars (nur ja/nein, keine
// Werte!), den letzten Cron-Lauf, die letzte Messwert-Zeit je Kanal, ein paar
// Tabellenzahlen und die jüngsten Fehler-Reports.
//
//   GET /api/health → { d1, env, lastCron, channels, counts, errors }

const CHANNELS = {
  gillian: { channel: '3417815', envKey: 'TS_KEY_GILLIAN' },
  sean:    { channel: '3417935', envKey: 'TS_KEY_SEAN' }
};

const json = obj => new Response(JSON.stringify(obj), {
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

async function tableCount(db, table) {
  try {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first();
    return row ? row.n : 0;
  } catch (e) { return null; }
}

export async function onRequestGet(context) {
  const { env, request } = context;

  // Schneller Puls-Check (P2-1): nur der letzte Cron-Lauf aus D1, ohne die
  // teuren ThingSpeak-/Wetter-Abrufe. Fuer den Cron-Totmannschalter im Briefing.
  if (new URL(request.url).searchParams.get('quick')) {
    let cronLastSeen = null;
    if (env.DB) {
      try {
        const hb = await env.DB.prepare("SELECT last_sent FROM alert_state WHERE key = 'cron_heartbeat'").first();
        if (hb) cronLastSeen = hb.last_sent;
      } catch (e) { /* Tabelle evtl. noch nicht angelegt */ }
    }
    return json({ cronLastSeen });
  }

  const out = {
    d1: !!env.DB,
    env: {
      NTFY_TOPIC: !!env.NTFY_TOPIC,
      TS_KEY_GILLIAN: !!env.TS_KEY_GILLIAN,
      TS_KEY_SEAN: !!env.TS_KEY_SEAN
    },
    lastCron: null,
    channels: {},
    counts: {},
    errors: [],
    alerts: []
  };

  // D1-abhängige Werte
  if (env.DB) {
    try {
      const hb = await env.DB.prepare("SELECT last_sent FROM alert_state WHERE key = 'cron_heartbeat'").first();
      if (hb) out.lastCron = hb.last_sent;
    } catch (e) { /* Tabelle evtl. noch nicht angelegt */ }

    // To-dos ohne Tombstones zählen (deleted=0)
    let todoCount = null;
    try {
      const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM todos WHERE deleted = 0').first();
      todoCount = r ? r.n : 0;
    } catch (e) { /* Tabelle evtl. noch nicht da */ }
    out.counts = {
      climate_daily: await tableCount(env.DB, 'climate_daily'),
      gpx: await tableCount(env.DB, 'gpx_activities'),
      todos: todoCount
    };

    try {
      const { results } = await env.DB
        .prepare('SELECT ts, page, message FROM error_log ORDER BY ts DESC LIMIT 10')
        .all();
      out.errors = results || [];
    } catch (e) { /* error_log evtl. noch nicht angelegt */ }

    // Letzte versendete Warnungen (Plan3-2)
    try {
      const { results } = await env.DB
        .prepare('SELECT ts, profile, type, title FROM alert_log ORDER BY ts DESC LIMIT 15')
        .all();
      out.alerts = results || [];
    } catch (e) { /* alert_log evtl. noch nicht angelegt */ }
  }

  // Letzte Messwert-Zeit je Kanal (kleiner ThingSpeak-Abruf)
  await Promise.all(Object.entries(CHANNELS).map(async ([locId, loc]) => {
    const apiKey = env[loc.envKey];
    if (!apiKey) { out.channels[locId] = { lastMs: null, error: 'Key fehlt' }; return; }
    try {
      const res = await fetch(`https://api.thingspeak.com/channels/${loc.channel}/feeds.json?api_key=${apiKey}&results=1`);
      if (!res.ok) throw new Error(`ThingSpeak ${res.status}`);
      const data = await res.json();
      const feeds = (data && data.feeds) || [];
      const last = feeds.length ? new Date(feeds[feeds.length - 1].created_at).getTime() : null;
      out.channels[locId] = { lastMs: last };
    } catch (e) {
      out.channels[locId] = { lastMs: null, error: e.message };
    }
  }));

  return json(out);
}
