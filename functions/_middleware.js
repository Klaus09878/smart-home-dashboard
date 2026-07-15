import { authenticateAsync, sessionUserFromCookie, syntheticBasicHeader, registerAuthFail } from './_auth.js';

// Oeffentliche Pfade (Plan5-5): die Login-Seite und ihre rein statischen
// Assets (Styles, Fonts, Icons) — keine Daten, kein API-Zugriff.
const PUBLIC_PATHS = ['/login.html', '/login.js', '/api/login', '/tailwind.css', '/manifest.webmanifest', '/favicon.ico'];
const PUBLIC_PREFIXES = ['/vendor/', '/icons/'];
function isPublic(pathname) {
  return PUBLIC_PATHS.includes(pathname) || PUBLIC_PREFIXES.some(p => pathname.startsWith(p));
}

export async function onRequest(context) {
  const { request, next, env } = context;

  // Cloudflare Access statt eigenem Login (Login per E-Mail-Code, sauberer für
  // die iPhone-PWA): In Cloudflare Zero Trust eine Access-Application für die
  // Domain anlegen, dann Env-Var AUTH_MODE=access setzen. Access authentifiziert
  // VOR dieser Function und setzt das JWT-Header — Anleitung siehe README.
  if (env.AUTH_MODE === "access") {
    if (request.headers.get("Cf-Access-Jwt-Assertion")) {
      return await next();
    }
    return new Response("Zugriff nur über Cloudflare Access (AUTH_MODE=access gesetzt, aber kein Access-JWT vorhanden — Access-Application prüfen).", { status: 403 });
  }

  const url = new URL(request.url);
  if (isPublic(url.pathname)) {
    return await next();
  }

  // 1) Session-Cookie vom Login-Formular (Plan5-5): gueltig → Identitaet als
  //    synthetischer Basic-Header stromabwaerts, damit identify() in allen
  //    API-Endpunkten unveraendert funktioniert.
  const sessionUser = await sessionUserFromCookie(request, env);
  if (sessionUser) {
    const headers = new Headers(request.headers);
    headers.set('Authorization', syntheticBasicHeader(sessionUser));
    return await next(new Request(request, { headers }));
  }

  // 2) Basic Auth wie bisher — fuer API-Clients (curl, Cron-Dienste) und als
  //    Uebergang fuer Browser mit gemerkten Zugangsdaten. Gueltige Zugangs-
  //    daten = Admin-Konto (AUTH_USER/AUTH_PASS), AUTH_USERS oder D1 (PBKDF2).
  if (await authenticateAsync(request, env)) {
    return await next();
  }

  // Brute-Force-Schutz (P2-5): NUR der Fehlerpfad zaehlt in D1 — der Erfolgsfall
  // oben kostet nichts. Gezaehlt wird pro IP und nur, wenn ueberhaupt (falsche)
  // Zugangsdaten geschickt wurden. D1-Fehler duerfen den Login NIE blockieren.
  const hadCreds = (request.headers.get("Authorization") || "").startsWith("Basic ");
  if (hadCreds) {
    const count = await registerAuthFail(env, request.headers.get("CF-Connecting-IP") || "unknown");
    if (count > 10) {
      return new Response("Zu viele Fehlversuche. Bitte 15 Minuten warten.", {
        status: 429,
        headers: { "Retry-After": "900" },
      });
    }
  }

  // 3) Nicht angemeldet (Plan5-5): Browser-Navigationen auf die Login-Seite
  //    umleiten (mit Ruecksprungziel), alles andere bekommt 401 als JSON —
  //    bewusst OHNE WWW-Authenticate, damit der native Browser-Dialog nicht
  //    mehr erscheint. API-Clients schicken ihre Basic-Daten proaktiv mit.
  const wantsHtml = request.method === 'GET' && (request.headers.get('Accept') || '').includes('text/html');
  if (wantsHtml) {
    const path = url.pathname + url.search;
    const target = path === '/' ? '/login.html' : '/login.html?next=' + encodeURIComponent(path);
    return Response.redirect(url.origin + target, 302);
  }
  return new Response(JSON.stringify({ error: 'nicht angemeldet' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
