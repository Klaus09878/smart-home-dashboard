---
name: cloudflare-security-sync
description: "Sicherheits-, Auth- und Sync-Regeln fuer die Cloudflare-Schicht. Anwenden bei jeder Aenderung an functions/ (Pages Functions, Middleware, Auth, Notify), an D1/R2-Zugriff, am ThingSpeak-Proxy oder an settings-sync.js/Store. Schuetzt gegen Secret-Leaks, kaputte Autorisierung, gebrochene Profiltrennung und Abstuerze bei fehlendem D1/R2."
---

# Cloudflare — Security & Sync

Pages Functions laufen in der **workerd**-Runtime (nicht Node). D1 und R2
koennen fehlen. Auth hat mehrere Modi. Diese Regeln halten die Schicht sicher
und robust.

## Regeln

1. **Keine sensiblen Werte nach aussen.** Secrets, API-/ThingSpeak-Read-Keys,
   Passwoerter, Session-Cookies, private ICS-URLs, ntfy-Topics und PII gehoeren
   nie ins Frontend, in Logs, in die `error-log`-D1, in Tests oder in
   Push-Nachrichten. ThingSpeak nur serverseitig ueber
   `functions/api/feeds/[locId].js`. Fehlermeldungen/Ringpuffer/Client-Responses
   ohne sensible Werte.

2. **Definiert degradieren, nicht abstuerzen.** D1/R2 koennen fehlen — Features
   muessen dann wie vorgesehen zurueckfallen (z. B. lokaler Modus), nicht werfen.
   Kein stiller Fallback, der einen echten Fehler verschleiert.

3. **Auth respektiert alle Modi.** Login-Session-Cookie (HMAC, `_auth.js`
   `createSessionCookie`/`sessionUserFromCookie`), Basic-Auth-/Cron-Kompatibilitaet
   (`AUTH_USER`/`AUTH_PASS`/`AUTH_USERS`, PBKDF2 in D1) **und** optionaler
   Cloudflare-Access-Modus. Oeffentliche Pfade nur ueber `PUBLIC_PATHS`/
   `PUBLIC_PREFIXES` in `_middleware.js`. APIs ohne Cookie → 401 JSON **ohne**
   `WWW-Authenticate` (kein Browser-Dialog).

4. **API-Handler pruefen Autorisierung, Eingaben, Profiltrennung.** Profildaten
   sind pro Profil getrennt (`p_<profil>_<key>`, D1 `user_settings`); ein Profil
   darf nie fremde Daten sehen/schreiben. Eingaben validieren, Fehler klar aber
   ohne interne Details.

5. **Profilbezogene Einstellungen nur ueber `Store`** (`settings-sync.js`), nie
   roh ueber `localStorage`. `init()` wartet auf `await Store.init()` vor dem
   Lesen. Geraetelokale Ausnahmen (`push_sent_*`, `gpx_pending_deletes`) sind
   bewusst roh.

## Validierung
Bei betroffenen Functions/Middleware/Auth: `npm run test:functions`
(`wrangler pages dev` gegen echte workerd-Runtime) und `npm test`
(`api.test.js`, `webpush.test.js`). Vorbehalt: der Runtime-Smoke reproduziert
**nicht** Cloudflares Pretty-URL-308 (`/login.html` → `/login`) — Redirect-/
Middleware-Pfade separat mitdenken (siehe `docs/knowledge.md`).
