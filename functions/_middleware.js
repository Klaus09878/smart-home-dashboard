export async function onRequest(context) {
  const { request, next, env } = context;

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
