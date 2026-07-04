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
    // Ohne Access-JWT ist die Anfrage an Access vorbeigelaufen (Fehlkonfiguration)
    return new Response("Zugriff nur über Cloudflare Access (AUTH_MODE=access gesetzt, aber kein Access-JWT vorhanden — Access-Application prüfen).", { status: 403 });
  }

  // Nutze Umgebungsvariablen von Cloudflare (oder Fallback 'admin'/'admin' für den ersten Start)
  const authUser = env.AUTH_USER || "admin";
  const authPass = env.AUTH_PASS || "admin";

  const authHeader = request.headers.get("Authorization");
  if (authHeader) {
    try {
      // Decode Basic Auth credentials
      const base64 = authHeader.split(" ")[1];
      const decoded = atob(base64);
      const [user, pass] = decoded.split(":");

      // Credentials valid?
      if (user === authUser && pass === authPass) {
        return await next();
      }
    } catch (e) {
      console.error("Fehler beim Dekodieren der Anmeldedaten", e);
    }
  }

  // Falls nicht autorisiert, zeige den nativen Browser-Login-Dialog
  return new Response("Zugriff verweigert. Bitte melde dich an.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="SmartHome Climate Dashboard"',
    },
  });
}
