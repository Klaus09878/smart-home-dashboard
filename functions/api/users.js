// Nutzerverwaltung in D1 (Plan2-16) — nur fuer das Admin-Konto. Legt zusaetzliche
// Login-Profile ohne Redeploy an; Env-Nutzer (AUTH_USER/AUTH_USERS) bleiben der
// Fallback und sind hier nicht aenderbar. Passwoerter werden NIE zurueckgegeben.
//
//   GET    /api/users               → { users: [{ name, source }] }
//   POST   /api/users {name,password}→ Nutzer anlegen
//   PUT    /api/users {name,password}→ Passwort aendern
//   DELETE /api/users?name=...       → Nutzer entfernen
import { identify, hashPassword, ensureUsersTable, parseUsers, verifyDbPassword, invalidateAuthCache } from '../_auth.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const NAME_RE = /^[\w.-]{2,32}$/;

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB) return json({ error: 'D1-Datenbank nicht konfiguriert (Binding "DB")' }, 503);

  const id = identify(request, env);
  if (!id) return json({ error: 'nicht authentifiziert' }, 401);
  // Self-Service (Plan5-7): das EIGENE Passwort darf jeder D1-Nutzer per PUT
  // mit Altpasswort-Nachweis aendern; alles andere bleibt dem Admin vorbehalten.
  const selfService = request.method === 'PUT' && !id.isAdmin;
  if (!id.isAdmin && !selfService) return json({ error: 'nur das Admin-Konto darf Profile verwalten' }, 403);

  await ensureUsersTable(env.DB);
  const envNames = new Set([...parseUsers(env).users.keys()]);

  if (request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT name FROM users ORDER BY name').all();
    const d1 = (results || []).map(r => ({ name: r.name, source: 'd1' }));
    const env_ = [...envNames].map(n => ({ name: n, source: 'env' }));
    return json({ users: [...env_, ...d1] });
  }

  if (request.method === 'POST' || request.method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    const name = (body.name || (selfService ? id.user : '')).trim();
    const password = String(body.password || '');
    if (selfService) {
      // Nur das eigene Passwort, nur fuer D1-Profile, nur mit Altpasswort.
      if (name !== id.user) return json({ error: 'nur das eigene Passwort kann geaendert werden' }, 403);
      if (envNames.has(name)) return json({ error: 'Dieses Profil wird ueber Umgebungsvariablen verwaltet — Passwortwechsel dort' }, 400);
      if (!(await verifyDbPassword(env, id.user, String(body.oldPassword || '')))) {
        return json({ error: 'Aktuelles Passwort ist falsch' }, 403);
      }
    }
    if (!NAME_RE.test(name)) return json({ error: 'Ungueltiger Name (2–32 Zeichen: Buchstaben, Ziffern, . _ -)' }, 400);
    if (envNames.has(name)) return json({ error: 'Name kollidiert mit einem Env-Nutzer' }, 409);
    if (password.length < 6) return json({ error: 'Passwort zu kurz (min. 6 Zeichen)' }, 400);

    const existing = await env.DB.prepare('SELECT name FROM users WHERE name = ?').bind(name).first();
    if (request.method === 'POST' && existing) return json({ error: 'Nutzer existiert bereits' }, 409);
    if (request.method === 'PUT' && !existing) return json({ error: 'Nutzer nicht gefunden' }, 404);

    const { salt, hash, iters } = await hashPassword(password);
    await env.DB.prepare('INSERT OR REPLACE INTO users (name, pass_hash, salt, iters, is_admin, created_at) VALUES (?,?,?,?,0,?)')
      .bind(name, hash, salt, iters, Date.now()).run();
    invalidateAuthCache(name); // altes Passwort sofort ungueltig (Isolate-Cache)
    return json({ ok: true, name });
  }

  if (request.method === 'DELETE') {
    const name = new URL(request.url).searchParams.get('name');
    if (!name) return json({ error: 'name erforderlich' }, 400);
    if (envNames.has(name)) return json({ error: 'Env-Nutzer koennen nicht geloescht werden' }, 400);
    await env.DB.prepare('DELETE FROM users WHERE name = ?').bind(name).run();
    return json({ ok: true });
  }

  return json({ error: 'Methode nicht erlaubt' }, 405);
}
