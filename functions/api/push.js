// Web-Push-Subscriptions je Profil (Plan-Punkt 7). Ergaenzt ntfy um native
// System-Benachrichtigungen (Push API), auch auf dem iPhone in der installierten
// PWA (ab iOS 16.4).
//
//   GET    /api/push                     → { configured, vapidPublicKey }
//   POST   /api/push { subscription }     → Subscription des Geraets speichern
//   DELETE /api/push { endpoint }         → Subscription entfernen
//
// Ohne D1 antwortet der Endpunkt 503; ohne VAPID-Env-Vars meldet GET
// configured:false → der Client bietet Web-Push gar nicht erst an.
import { identify } from '../_auth.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

async function ensureSchema(db) {
  await db.exec("CREATE TABLE IF NOT EXISTS push_subscriptions (profile TEXT, endpoint TEXT PRIMARY KEY, p256dh TEXT, auth TEXT, created_at INTEGER)");
}

export async function onRequest(context) {
  const { request, env } = context;
  const configured = !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

  if (request.method === 'GET') {
    return json({ configured, vapidPublicKey: env.VAPID_PUBLIC_KEY || null });
  }

  if (!env.DB) return json({ error: 'D1-Datenbank nicht konfiguriert (Binding "DB")' }, 503);
  const id = identify(request, env);
  if (!id) return json({ error: 'nicht authentifiziert' }, 401);
  const me = id.user;
  await ensureSchema(env.DB);

  if (request.method === 'POST') {
    if (!configured) return json({ error: 'Web-Push serverseitig nicht eingerichtet (VAPID-Schluessel fehlen)' }, 503);
    const body = await request.json().catch(() => ({}));
    const sub = body.subscription;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return json({ error: 'ungueltige Subscription' }, 400);
    }
    await env.DB.prepare(
      'INSERT OR REPLACE INTO push_subscriptions (profile, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?)'
    ).bind(me, sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now()).run();
    return json({ ok: true });
  }

  if (request.method === 'DELETE') {
    const body = await request.json().catch(() => ({}));
    if (!body.endpoint) return json({ error: 'endpoint fehlt' }, 400);
    // Nur eigene Subscriptions loeschbar
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND profile = ?')
      .bind(body.endpoint, me).run();
    return json({ ok: true });
  }

  return json({ error: 'Methode nicht erlaubt' }, 405);
}
