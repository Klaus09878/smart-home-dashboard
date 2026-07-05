// Abmeldung (Punkt 28). Basic Auth kennt technisch kein „Logout" — der Browser
// merkt sich die Zugangsdaten bis zum Schließen. Dieser Endpunkt antwortet mit
// 401, was viele Browser dazu bringt, die gespeicherten Basic-Auth-Daten zu
// verwerfen bzw. neu abzufragen. Bei Cloudflare Access übernimmt stattdessen
// /cdn-cgi/access/logout die Abmeldung (der Client leitet dorthin um).
export function onRequestGet() {
  return new Response('Abgemeldet. Bitte Fenster schließen oder Zugangsdaten neu eingeben.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="SmartHome — abgemeldet"' }
  });
}
