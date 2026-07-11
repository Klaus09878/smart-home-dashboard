import { authenticateAsync } from './_auth.js';

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

  // Mehrbenutzer-Login: gültige Zugangsdaten = Admin-Konto (AUTH_USER/AUTH_PASS),
  // ein Eintrag in AUTH_USERS ODER ein D1-Nutzer (Plan2-16, PBKDF2).
  if (await authenticateAsync(request, env)) {
    return await next();
  }

  // Brute-Force-Schutz (P2-5): NUR der Fehlerpfad zaehlt in D1 — der Erfolgsfall
  // oben kostet nichts. Gezaehlt wird pro IP und nur, wenn ueberhaupt (falsche)
  // Zugangsdaten geschickt wurden; der Erstbesuch ohne Header loest nur den
  // Login-Dialog aus. D1-Fehler duerfen den Login NIE blockieren.
  const hadCreds = (request.headers.get("Authorization") || "").startsWith("Basic ");
  if (hadCreds && env.DB) {
    try {
      await env.DB.exec("CREATE TABLE IF NOT EXISTS auth_fails (ip TEXT PRIMARY KEY, count INTEGER, first_ms INTEGER)");
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const now = Date.now();
      const windowMs = 15 * 60 * 1000;
      const row = await env.DB.prepare("SELECT count, first_ms FROM auth_fails WHERE ip = ?").bind(ip).first();
      let count = 1, firstMs = now;
      if (row && (now - row.first_ms) < windowMs) { count = row.count + 1; firstMs = row.first_ms; }
      await env.DB.prepare("INSERT OR REPLACE INTO auth_fails (ip, count, first_ms) VALUES (?, ?, ?)").bind(ip, count, firstMs).run();
      if (count > 10) {
        return new Response("Zu viele Fehlversuche. Bitte 15 Minuten warten.", {
          status: 429,
          headers: { "Retry-After": "900" },
        });
      }
    } catch (e) { /* D1-Ausfall darf den Login nie blockieren */ }
  }

  // Falls nicht autorisiert, zeige den nativen Browser-Login-Dialog
  return new Response("Zugriff verweigert. Bitte melde dich an.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="SmartHome Climate Dashboard"',
    },
  });
}
