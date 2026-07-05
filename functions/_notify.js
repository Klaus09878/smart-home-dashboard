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

// Empfänger aus D1 laden: [{ profile, topic, rules }]. Fallback: globales Topic.
export async function loadRecipients(env) {
  const recipients = [];
  const db = env.DB;
  if (db) {
    try {
      await db.exec("CREATE TABLE IF NOT EXISTS user_settings (profile TEXT, key TEXT, value TEXT, updated_at INTEGER, PRIMARY KEY (profile, key))");
      const { results } = await db
        .prepare("SELECT profile, key, value FROM user_settings WHERE key IN ('ntfy_topic','notify_rules')")
        .all();
      const byProfile = {};
      for (const r of results) {
        (byProfile[r.profile] = byProfile[r.profile] || {})[r.key] = r.value;
      }
      for (const [profile, s] of Object.entries(byProfile)) {
        const topic = (s.ntfy_topic || '').trim();
        if (!topic) continue;
        let rules = {};
        try { rules = s.notify_rules ? JSON.parse(s.notify_rules) : {}; } catch (e) { /* Defaults */ }
        recipients.push({ profile, topic, rules });
      }
    } catch (e) { /* D1-Fehler → Fallback unten */ }
  }
  if (recipients.length === 0 && env.NTFY_TOPIC) {
    recipients.push({ profile: '_global', topic: env.NTFY_TOPIC, rules: {} });
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

// Eine Warnung an alle passenden Profile verteilen.
//   type       – Regel-Typ (sensor/mold/frost/heat/weekly/…)
//   dedupeSlug – zusätzlicher Schlüsselteil (z. B. Standort) für die Entprellung
//   build      – (recipient) => { title, body, tags } oder null (nicht senden)
// Rückgabe: Liste der tatsächlich benachrichtigten "profil:typ:slug".
export async function dispatch(env, recipients, type, dedupeSlug, build) {
  const notified = [];
  for (const rec of recipients) {
    const cfg = typeCfg(rec.rules, type);
    if (!cfg.on) continue;
    if (isQuietNow(rec.rules) && !SAFETY_TYPES.has(type)) continue;
    const msg = build(rec);
    if (!msg) continue;
    const dedupeMs = (cfg.dedupeH ?? 6) * 60 * 60 * 1000;
    const key = `${rec.profile}:${type}:${dedupeSlug}`;
    if (!(await shouldSend(env.DB, key, dedupeMs))) continue;
    try {
      await pushTo(rec.topic, msg);
      notified.push(key);
    } catch (e) { /* einzelnen Push-Fehler ignorieren */ }
  }
  return notified;
}
