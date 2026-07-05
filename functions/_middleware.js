import { authenticate } from './_auth.js';

export async function onRequest(context) {
  const { request, next, env } = context;

  // Cloudflare Access statt Basic Auth (Login per E-Mail-Code, sauberer für
  // die iPhone-PWA): In Cloudflare Zero Trust eine Access-Application für die
  // Domain anlegen, dann Env-Var AUTH_MODE=access setzen. Access authentifiziert
  // VOR dieser Function und setzt das JWT-Header — Anleitung siehe README.
  if (env.AUTH_MODE === "access") {
    if (request.headers.get("Cf-Access-Jwt-Assertion")) {
      return await next();
    }
    return new Response("Zugriff nur über Cloudflare Access (AUTH_MODE=access gesetzt, aber kein Access-JWT vorhanden — Access-Application prüfen).", { status: 403 });
  }

  // Mehrbenutzer-Login: gültige Zugangsdaten = Admin-Konto (AUTH_USER/AUTH_PASS)
  // ODER ein Eintrag in AUTH_USERS. Jeder Name ist ein eigenes Profil.
  if (authenticate(request, env)) {
    return await next();
  }

  // Falls nicht autorisiert, zeige den nativen Browser-Login-Dialog
  return new Response("Zugriff verweigert. Bitte melde dich an.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="SmartHome Climate Dashboard"',
    },
  });
}
