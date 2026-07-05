// Verrät dem Client das aktive Profil (aus dem Basic-Auth-Login bzw. Cloudflare
// Access). Der Client präfixt damit alle profilbezogenen Einstellungen und lädt
// den passenden D1-Datensatz. Läuft hinter der Auth-Middleware.
import { identify, parseUsers } from '../_auth.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const id = identify(request, env);
  if (!id) {
    // Sollte nicht passieren (Middleware schützt bereits) — defensiv 401.
    return new Response(JSON.stringify({ error: 'nicht authentifiziert' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Admin bekommt die Liste aller Profilnamen (für die Benutzerverwaltung-Anzeige).
  let profiles = null;
  if (id.isAdmin && id.mode === 'basic') {
    profiles = [...parseUsers(env).users.keys()];
  }

  return new Response(JSON.stringify({
    user: id.user,
    isAdmin: id.isAdmin,
    mode: id.mode,
    profiles
  }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
