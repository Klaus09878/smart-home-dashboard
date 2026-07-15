// Abmeldung: loescht das Session-Cookie (Plan5-5). Der Client leitet danach
// auf login.html um. Im Browser gemerkte Basic-Auth-Zugangsdaten lassen sich
// technisch nicht zuverlaessig verwerfen — der Login-Screen ist jetzt aber der
// Normalweg, der native Dialog erscheint nicht mehr (Middleware sendet kein
// WWW-Authenticate). Bei Cloudflare Access uebernimmt /cdn-cgi/access/logout.
import { clearSessionCookieHeader } from '../_auth.js';

export function onRequestGet() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': clearSessionCookieHeader(),
    },
  });
}
