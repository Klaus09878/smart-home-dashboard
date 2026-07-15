// Formular-Login (Plan5-5): prueft Zugangsdaten (Env + D1) und setzt ein
// HMAC-signiertes Session-Cookie. In _middleware.js als oeffentlicher Pfad
// freigeschaltet — der Brute-Force-Schutz zaehlt deshalb HIER (wie in der
// Middleware: nur der Fehlerpfad kostet, D1-Ausfall blockiert nie).
import { checkCredentialsAsync, createSessionCookie, registerAuthFail } from '../_auth.js';

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

export async function onRequestPost(context) {
  const { request, env } = context;
  if (env.AUTH_MODE === 'access') {
    return json({ error: 'Der Login laeuft ueber Cloudflare Access' }, 400);
  }

  const body = await request.json().catch(() => ({}));
  const user = String(body.user || '').trim();
  const pass = String(body.pass || '');
  if (!user || !pass) return json({ error: 'Name und Passwort erforderlich' }, 400);

  const ok = await checkCredentialsAsync(user, pass, env);
  if (!ok) {
    const count = await registerAuthFail(env, request.headers.get('CF-Connecting-IP') || 'unknown');
    if (count > 10) {
      return json({ error: 'Zu viele Fehlversuche. Bitte 15 Minuten warten.' }, 429, { 'Retry-After': '900' });
    }
    return json({ error: 'Name oder Passwort falsch' }, 401);
  }

  return json({ ok: true, user: ok.user }, 200, {
    'Set-Cookie': await createSessionCookie(env, ok.user, !!body.remember),
  });
}
