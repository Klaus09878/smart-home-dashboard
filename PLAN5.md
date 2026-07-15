# Umsetzungsplan Runde 5 — aus Nutzer-Feedback

> **Status: ✅ umgesetzt** (Commits `Plan5-1` … `Plan5-5` und `Plan5-7`;
> Punkt 6 war bereits vorhanden, nur Doku). Grundlage: Test-Feedback eines
> externen Nutzers (Juli 2026, Text + 5 Screenshots) plus Code-Recherche.
> Verifiziert: `npm run lint` (0 Fehler), `npm test` (80 Core + 3 Web-Push +
> 16 API + 10 Smoke), `npm run test:e2e` (9/9) — alles grün; Light-/Dark-
> Screenshots aller Views per Playwright geprüft. Service-Worker v73.
>
> **Abweichungen gegenüber der Planung (ehrlich dokumentiert):**
> - **Punkt 2:** Hinweis „Zoom: Strg + Mausrad · Ziehen schwenkt." steht als
>   Untertitel-Zusatz (ab sm sichtbar), nicht als Tooltip.
> - **Punkt 4:** Über die Farb-Politur hinaus behoben: `hover:text-white`
>   machte Icon-Buttons im hellen Modus beim Hover unsichtbar; weiße Schrift
>   auf Farbverlaufs-Chips wird nicht mehr dunkel ummappt.
> - **Im Zuge von Punkt 5:** Die Tailwind-`content`-Liste war seit dem
>   Plan2-9-Split defekt (`./app.js` verwaist, `gpx.js`/`settings-sync.js`
>   fehlten) — repariert; `login.html`/`login.js` aufgenommen.
> - **Punkt 7:** Passwortwechsel invalidiert zusätzlich den Isolate-Login-
>   Cache; Profil-Löschung beendet auch laufende Cookie-Sessions.
>
> **Bewertungsskalen hinter jedem Titel:**
> - `Aufwand 1–5` — 1 = Einzeiler/Kleinstfix, 3 = ein Nachmittag, 5 = mehrere Tage.
> - `Idee 1–5` — 5 = klarer Gewinn bzw. Muss-Fix, 1 = kaum Nutzen fürs Projekt.
>
> Die Datei-Anker (Datei + Zeilennummer) gelten für den Stand beim Schreiben dieses
> Plans — immer über den Funktionsnamen suchen, die Zeilennummer ist nur Startpunkt.

## Vorab-Erkenntnisse aus der Code-Recherche

- **Die gewünschte Accountverwaltung existiert bereits** (Punkt 6): `functions/api/users.js`
  (Plan2-16) + Admin-UI in den Einstellungen. Sie ist nur für das Admin-Konto sichtbar —
  deshalb hat der Tester sie nie gesehen.
- **Passwörter sind nicht „hard im Code"** (Vermutung des Testers): Env-Variablen
  (`AUTH_USER`/`AUTH_PASS`/`AUTH_USERS`) plus D1-Nutzer mit PBKDF2-Hashes; Hashes
  werden nie an den Client ausgeliefert.
- **Ein Screenshot des Testers zeigt einen von ihm nicht gemeldeten, echten Bug**
  (Punkt 3): Die OpenStreetMap-Kacheln im GPX-Viewer werden vom Tile-Server geblockt.

---

## A — Bugs & Unschönheiten (aus dem Feedback + Screenshots)

### 1. Hub-Widgets nur noch im Bearbeiten-Modus verschiebbar `[Aufwand 1/5 · Idee 5/5]`

**Gemeldet:** Der obere Dashboard-Bereich lässt sich „wild verschieben", das Ziehen ist
friemelig und passiert auf dem Handy leicht aus Versehen (Screenshot: zerschossenes Layout).

**Ursache:** `createLayout.initDrag()` (app-hub.js:110) armiert `el.draggable` bei jedem
`mousedown`/`touchstart` auf dem Griff-Symbol — dauerhaft, unabhängig davon, ob das Panel
„Widgets anpassen" offen ist.

**Fix-Skizze:** Edit-Modus-Flag einführen: Griffe (`.widget-grip`) nur sichtbar und
Drag-Listener nur aktiv, solange das Panel „Widgets anpassen" (`widget-settings`) offen ist.
Die Pfeil-Buttons im Panel (iOS-Fallback, HTML5-Drag geht dort nicht) bleiben unverändert.
Betrifft Hub und ClimateFlow (beide nutzen `createLayout`).

**Fallstricke:** Griff-Sichtbarkeit per Klasse togglen → `npm run build:css` (Projektregel 1);
`CACHE_NAME` in sw.js hochzählen (Projektregel 2).

### 2. Chart-Zoom entschärfen `[Aufwand 1/5 · Idee 4/5]`

**Gemeldet:** Im „Klimaverlauf im Detail" zoomt man aus Versehen (Screenshot: stark
gezoomter Ausschnitt). Der Zoom ist ein bewusstes Feature (Plan-Punkt „Zoomen/Schwenken"),
nur die Auslösung ist zu leichtgängig: Mausrad-Scrollen über dem Chart zoomt sofort.

**Fix-Skizze:** In der Zoom-Konfiguration (app-analysis.js:433) `wheel: { enabled: true,
modifierKey: 'ctrl' }` setzen — Zoomen am Desktop nur noch mit gedrückter Strg-Taste
(Pinch auf Touch bleibt, das ist eine bewusste Zwei-Finger-Geste). Dazu ein kurzer
Hinweis (Tooltip/Untertitel) „Zoom: Strg + Mausrad bzw. Pinch". Der Reset-Button
(`resetChartZoom`, app-analysis.js:576) existiert schon.

**Fallstricke:** Prüfen, ob das Schwenken (Drag/Pan) ebenfalls versehentlich auslöst —
falls ja, gleiches Muster.

### 3. GPX-Karte reparieren: OSM blockt die Kacheln `[Aufwand 1/5 · Idee 5/5 — Muss-Fix]`

**Beobachtet (Screenshot, vom Tester nicht gemeldet):** Die Karte im GPX-Viewer zeigt
statt Kacheln „Access blocked — Referer is required by tile usage policy of OpenStreetMap".

**Ursache:** `_headers` setzt global `Referrer-Policy: no-referrer`; die OSM-Tile-Server
verlangen inzwischen einen Referer und liefern sonst Sperr-Kacheln.

**Fix-Skizze:** In `L.tileLayer(...)` (gpx.js:1251) die Option
`referrerPolicy: 'strict-origin-when-cross-origin'` ergänzen — das gebündelte Leaflet 1.9.4
unterstützt sie; damit bekommt NUR der Tile-Request einen (origin-)Referer, die strenge
globale Header-Policy bleibt unangetastet. `CACHE_NAME` in sw.js hochzählen.

**Fallstricke:** Nach dem Deploy mit hartem Reload testen (Service Worker cached gpx.js);
CSP `img-src` erlaubt die OSM-Hosts bereits, dort ist nichts zu tun.

### 4. Hellen Modus polieren `[Aufwand 3/5 · Idee 3/5]`

**Gemeldet:** „Manche Sachen sehen im Hellen Modus plötzlich nicht mehr schön aus"
(2 Screenshots: Kopfbereich mit Profil-Chip, Einstellungs-Header).

**Fix-Skizze:** Systematischer Durchgang aller Views (Hub, ClimateFlow, Einstellungen,
GPX-Viewer) im Light-Theme; Kontrast-/Farbkorrekturen an den auffälligen Stellen
(Chips, Panels, Icons, Chart-Farben). Kein einzelner Bug, sondern iterative Politur.

**Fallstricke:** Nach jeder Klassen-Änderung `npm run build:css` + `tailwind.css`
mitcommitten (Projektregel 1); Nutzen hängt davon ab, wie wichtig der helle Modus
überhaupt ist — sonst bewusst streichen.

---

## B — Login & Accounts

### 5. Echter Login-Screen mit „Angemeldet bleiben" `[Aufwand 4/5 · Idee 4/5]`

**Gewünscht:** Schöner Login-Screen statt des nativen Browser-Basic-Auth-Dialogs,
mit Option „angemeldet bleiben".

**Fix-Skizze:** Formular-Login + HMAC-signiertes Session-Cookie: `functions/_middleware.js`
prüft zuerst das Cookie, dann Basic Auth (bleibt als API-/Übergangs-Fallback); neue
Login-Route validiert Zugangsdaten über die bestehende `authenticateAsync`-Logik
(inkl. Brute-Force-Schutz) und setzt das Cookie („angemeldet bleiben" = lange vs.
Session-Laufzeit). Login-Seite im Dark-Design; `functions/api/logout.js` löscht künftig
das Cookie (sauberes Logout wird damit erstmals wirklich möglich).

**Fallstricke:** PWA/Service-Worker-Verhalten bei 401→Redirect prüfen; Cookie `HttpOnly;
Secure; SameSite=Lax`; Secret als Env-Var. **Alternative ohne Eigenbau:** `AUTH_MODE=access`
(Cloudflare Access, Login per E-Mail-Code) ist bereits eingebaut und liefert einen
gehosteten Login-Screen gratis.

### 6. Accountverwaltung (Admin) `[Aufwand 0 — EXISTIERT BEREITS]`

**Gewünscht:** Admin-Bereich zum Accounts erstellen/löschen und Passwörter zurücksetzen.

**Befund:** Gibt es schon — Einstellungen → Profile, nur für das Admin-Konto sichtbar
(`/api/users`: GET/POST/PUT/DELETE; UI in app-settings.js ab `loadProfiles`). Anlegen,
Löschen und Passwort-Zurücksetzen funktionieren ohne Redeploy; Passwörter liegen als
PBKDF2-Hashes in D1. Kein Handlungsbedarf — höchstens Doku/Onboarding-Hinweis.

**Optionaler Rest: Zugriffe pro Account beschränken** `[Aufwand 4/5 · Idee 2/5]` —
Rollen-/Rechtemodell (wer sieht welches Projekt/Widget). Bei aktuell zwei aktiven
Nutzern kaum Nutzen; die Einschätzung des Testers („sehr großer Aufwand") ist korrekt.

### 7. Eigenes Passwort selbst ändern (Self-Service) `[Aufwand 2/5 · Idee 4/5]`

**Gewünscht:** Eine Stelle, an der man das eigene Passwort wechseln kann (heute darf
das nur der Admin über die Profilverwaltung).

**Fix-Skizze:** `PUT /api/users` erlaubt zusätzlich den Wechsel des EIGENEN Passworts
(Identität aus `identify()`, Altpasswort-Prüfung als Schutz; nur für D1-Nutzer —
Env-Nutzer sind per Definition nur über Env-Vars änderbar). UI: Button „Passwort ändern"
in Einstellungen → Profil über `modalPrompt` (Projektregel: nie `prompt()`).

**Fallstricke:** Nach dem Wechsel ist die laufende Basic-Auth-Session ungültig →
Nutzerhinweis + Re-Login; API-Tests in `tests/` ergänzen.

---

## Gestrichen (Entscheidung Juli 2026)

- ~~**Mail-Flows** (Initialpasswort per Mail, Passwort-Reset-Mail, Mail-Verifizierung)~~ —
  gestrichen: braucht Mail-Versand + Token-Verwaltung, bei 2–3 bekannten Nutzern Overkill;
  Admin-Reset (Punkt 6) deckt den Fall ab.
- ~~**2-Faktor-Authentifizierung (TOTP)**~~ — gestrichen: setzt Punkt 5 zwingend voraus;
  Cloudflare Access (bereits vorbereitet) liefert vergleichbare Sicherheit ohne Eigenbau.
- ~~**Apple-Watch-/Gesundheitsdaten (Runalyze-Inspo)**~~ — gestrichen für dieses Repo:
  wird später als **eigenes Repo** mit eigener Entwicklung aufgebaut und in Zukunft
  wieder an den Hub angebunden.
- ~~**Eigener Homeserver + Mailserver + Domain**~~ — gestrichen: Infrastruktur-Thema,
  kein Code in diesem Repo. (Notiz: selbst gehosteter Mailserver = Deliverability-Risiko
  wegen IP-Reputation/SPF/DKIM/DMARC; Hosting auf Cloudflare Pages bleibt gratis und
  wartungsfrei.)
