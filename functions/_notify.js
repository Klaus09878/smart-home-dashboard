// Gemeinsamer Benachrichtigungs-Verteiler für die Cron-Endpunkte
// (check-alerts, weekly-report, monthly-report). Dateiname mit _ → keine Route.
//
// Idee: Jedes Profil hinterlegt in D1 (user_settings) sein ntfy-Topic und seine
// Benachrichtigungsregeln (notify_rules). Der Server schickt jede Warnung nur an
// die Profile, die den betreffenden Typ aktiviert haben, respektiert Ruhezeiten
// und entprellt pro Profil+Typ. Ohne Profil-Konfiguration greift das globale
// NTFY_TOPIC (Rückwärtskompatibilität).

export const DEFAULT_RULES = {
  types: {
    sensor:  { on: true, dedupeH: 6 },
    mold:    { on: true, dedupeH: 12, threshold: 80 },
    frost:   { on: true, dedupeH: 18, threshold: 0 },
    heat:    { on: true, dedupeH: 18, threshold: 30 },
    co2:     { on: false, dedupeH: 6, threshold: 1200 }, // opt-in (braucht CO₂-Sensor)
    dwd:     { on: true, dedupeH: 12 }, // amtliche Unwetterwarnungen (DWD/BrightSky)
    vent:    { on: false, dedupeH: 20 }, // Lüftungsfenster-Morgen-Push (opt-in)
    errors:  { on: true, dedupeH: 6 },
    weekly:  { on: true, dedupeH: 120 },  // max. 1 Wochenbericht / 5 Tage
    monthly: { on: true, dedupeH: 480 },  // max. 1 Monatsbericht / 20 Tage
    todo:    { on: true, dedupeH: 24 }
  },
  quiet: { on: false, from: 22, to: 7 }
};

// Typen, die auch während der Ruhezeit zugestellt werden (Sicherheit).
const SAFETY_TYPES = new Set(['sensor', 'mold', 'frost']);

export function typeCfg(rules, type) {
  const base = DEFAULT_RULES.types[type] || { on: true };
  const custom = (rules && rules.types && rules.types[type]) || {};
  return { ...base, ...custom };
}

// Ist gerade Ruhezeit (Europe/Berlin)? Behandelt den Über-Mitternacht-Fall.
export function isQuietNow(rules, now = new Date()) {
  const quiet = (rules && rules.quiet) || DEFAULT_RULES.quiet;
  if (!quiet || !quiet.on) return false;
  const berlinHour = Number(new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric', hour12: false, timeZone: 'Europe/Berlin'
  }).format(now));
  const from = quiet.from ?? 22, to = quiet.to ?? 7;
  return from <= to ? (berlinHour >= from && berlinHour < to)
                    : (berlinHour >= from || berlinHour < to);
}

// Empfänger aus D1 laden: [{ profile, topic, rules, subs }]. Ein Profil kann per
// ntfy-Topic UND/ODER per Web-Push (subs) benachrichtigt werden. Fallback ohne
// Profile: globales Topic.
export async function loadRecipients(env) {
  const byProfile = {};
  const db = env.DB;
  if (db) {
    try {
      await db.exec("CREATE TABLE IF NOT EXISTS user_settings (profile TEXT, key TEXT, value TEXT, updated_at INTEGER, PRIMARY KEY (profile, key))");
      const { results } = await db
        .prepare("SELECT profile, key, value FROM user_settings WHERE key IN ('ntfy_topic','notify_rules')")
        .all();
      const settings = {};
      for (const r of results) {
        (settings[r.profile] = settings[r.profile] || {})[r.key] = r.value;
      }
      for (const [profile, s] of Object.entries(settings)) {
        let rules = {};
        try { rules = s.notify_rules ? JSON.parse(s.notify_rules) : {}; } catch (e) { /* Defaults */ }
        byProfile[profile] = { profile, topic: (s.ntfy_topic || '').trim(), rules, subs: [] };
      }

      // Web-Push-Subscriptions je Profil (Tabelle ggf. erst anlegen)
      await db.exec("CREATE TABLE IF NOT EXISTS push_subscriptions (profile TEXT, endpoint TEXT PRIMARY KEY, p256dh TEXT, auth TEXT, created_at INTEGER)");
      const subsRes = await db.prepare("SELECT profile, endpoint, p256dh, auth FROM push_subscriptions").all();
      for (const row of (subsRes.results || [])) {
        const rec = byProfile[row.profile] || (byProfile[row.profile] = { profile: row.profile, topic: '', rules: {}, subs: [] });
        rec.subs.push({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } });
      }
    } catch (e) { /* D1-Fehler → Fallback unten */ }
  }

  const recipients = Object.values(byProfile).filter(r => r.topic || (r.subs && r.subs.length));
  if (recipients.length === 0 && env.NTFY_TOPIC) {
    recipients.push({ profile: '_global', topic: env.NTFY_TOPIC, rules: {}, subs: [] });
  }
  return recipients;
}

// Entprell-Status in D1 (alert_state). Ohne DB immer senden.
export async function shouldSend(db, key, dedupeMs) {
  if (!db) return true;
  await db.exec("CREATE TABLE IF NOT EXISTS alert_state (key TEXT PRIMARY KEY, last_sent INTEGER)");
  const row = await db.prepare('SELECT last_sent FROM alert_state WHERE key = ?').bind(key).first();
  if (row && Date.now() - row.last_sent < dedupeMs) return false;
  await db.prepare('INSERT OR REPLACE INTO alert_state (key, last_sent) VALUES (?, ?)').bind(key, Date.now()).run();
  return true;
}

export async function pushTo(topic, { title, body, tags = 'warning', priority = 'high' }) {
  await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: 'POST', body,
    headers: { 'Title': title, 'Tags': tags, 'Priority': priority }
  });
}

// VAPID-Konfiguration aus den Env-Vars lesen (oder null, wenn nicht eingerichtet).
export function vapidFromEnv(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || 'mailto:admin@smarthub' };
}

// Web-Push an alle Subscriptions eines Profils. Abgelaufene (404/410) werden aus
// D1 entfernt. Braucht die VAPID-Konfiguration; ohne sie passiert nichts.
export async function pushToSubs(db, subs, msg, vapid) {
  if (!vapid || !subs || !subs.length) return;
  const wp = await import('./_webpush.js');
  const sendWebPush = wp.sendWebPush || (wp.default && wp.default.sendWebPush);
  if (!sendWebPush) return;
  const payload = { title: msg.title, body: msg.body, tag: msg.tag || msg.title, url: msg.url || '/' };
  for (const sub of subs) {
    try {
      const res = await sendWebPush(sub, payload, vapid);
      if ((res.status === 404 || res.status === 410) && db) {
        await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(sub.endpoint).run();
      }
    } catch (e) { /* einzelnen Push-Fehler ignorieren */ }
  }
}

// Eine Warnung an alle passenden Profile verteilen.
//   type       – Regel-Typ (sensor/mold/frost/heat/weekly/…)
//   dedupeSlug – zusätzlicher Schlüsselteil (z. B. Standort) für die Entprellung
//   build      – (recipient) => { title, body, tags } oder null (nicht senden)
// Rückgabe: Liste der tatsächlich benachrichtigten "profil:typ:slug".
export async function dispatch(env, recipients, type, dedupeSlug, build) {
  const notified = [];
  const vapid = vapidFromEnv(env);
  for (const rec of recipients) {
    const cfg = typeCfg(rec.rules, type);
    if (!cfg.on) continue;
    if (isQuietNow(rec.rules) && !SAFETY_TYPES.has(type)) continue;
    const msg = build(rec);
    if (!msg) continue;
    const dedupeMs = (cfg.dedupeH ?? 6) * 60 * 60 * 1000;
    const key = `${rec.profile}:${type}:${dedupeSlug}`;
    if (!(await shouldSend(env.DB, key, dedupeMs))) continue;
    let sent = false;
    if (rec.topic) {
      try { await pushTo(rec.topic, msg); sent = true; } catch (e) { /* ntfy-Fehler ignorieren */ }
    }
    if (rec.subs && rec.subs.length) {
      try { await pushToSubs(env.DB, rec.subs, msg, vapid); sent = true; } catch (e) { /* Web-Push-Fehler ignorieren */ }
    }
    if (sent) {
      notified.push(key);
      // Protokoll (Plan3-2): jeden tatsaechlichen Versand loggen. Best effort —
      // env.DB kann fehlen, dann bleibt es beim ntfy-/Push-Versand.
      try {
        await env.DB.exec('CREATE TABLE IF NOT EXISTS alert_log (ts INTEGER, profile TEXT, type TEXT, slug TEXT, title TEXT)');
        await env.DB.prepare('INSERT INTO alert_log (ts, profile, type, slug, title) VALUES (?,?,?,?,?)')
          .bind(Date.now(), rec.profile, type, String(dedupeSlug), (msg.title || '').slice(0, 120)).run();
      } catch (e) { /* Protokoll ist optional */ }
    }
  }
  return notified;
}
