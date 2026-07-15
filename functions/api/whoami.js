// Verrät dem Client das aktive Profil (aus dem Basic-Auth-Login bzw. Cloudflare
// Access). Der Client präfixt damit alle profilbezogenen Einstellungen und lädt
// den passenden D1-Datensatz. Läuft hinter der Auth-Middleware.
import { identify, parseUsers, dbUserNames } from '../_auth.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const id = identify(request, env);
  if (!id) {
    // Sollte nicht passieren (Middleware schützt bereits) — defensiv 401.
    return new Response(JSON.stringify({ error: 'nicht authentifiziert' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  const envNames = [...parseUsers(env).users.keys()];

  // Admin bekommt die Liste aller Profilnamen (Env + D1) fuer die Anzeige.
  let profiles = null;
  if (id.isAdmin && id.mode === 'basic') {
    const d1Names = await dbUserNames(env);
    profiles = [...new Set([...envNames, ...d1Names])];
  }

  return new Response(JSON.stringify({
    user: id.user,
    isAdmin: id.isAdmin,
    mode: id.mode,
    // 'env' = Passwort liegt in Umgebungsvariablen, 'd1' = Nutzertabelle.
    // Nur D1-Profile koennen ihr Passwort selbst aendern (Plan5-7).
    source: id.mode === 'basic' ? (envNames.includes(id.user) ? 'env' : 'd1') : id.mode,
    profiles
  }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
