# Umsetzungsplan Runde 2 — 19 Punkte

> **Status: ✅ vollständig umgesetzt** (alle 19 Punkte, Commits `Plan2-1` … `Plan2-19`).
> Verifiziert: `npm run lint` (0 Fehler), `npm test` (56 Core + 3 Web-Push + 8 API
> + 9 Smoke), `npm run test:e2e` (7 Browser-Tests) — alles grün; Service-Worker v34.
> Bewusste Abweichung: Punkt 9 **ohne** esbuild (ein Bundler haette die fuer die
> data-on*-Delegation noetigen `window`-Globals gebrochen); stattdessen ein
> sequenzieller Multi-Script-Split (Verkettung byte-identisch zum Original).
> Punkt 18 (Archiv-CSV) war bereits vorhanden und wurde nur um CO₂-Spalten ergaenzt.

Dieser Plan ist für die schrittweise Umsetzung durch ein KI-Modell (oder einen Menschen)
geschrieben: pro Punkt Ziel, Dateien, konkrete Schritte, Abnahme und Fallstricke.
**Ein Punkt = ein Commit** (Prefix `Plan2-N:`), direkt auf `main` (Auto-Deploy, Projektregel 8).

## Arbeitsregeln (gelten für JEDEN Punkt)

1. Vor jedem Commit: `npm test` (Core + WebPush + Smoke) muss grün sein.
2. Nach Klassen-Änderungen in HTML/app.js/gpx.js/shared.js: `npm run build:css`, `tailwind.css` mitcommitten.
3. Bei Änderungen an Dateien aus `APP_SHELL` (sw.js): `CACHE_NAME` in `sw.js` hochzählen (aktuell `smarthub-v19`).
4. Profilbezogene Einstellungen NUR über `Store.get/set/getJSON/setJSON/remove` — nie roh `localStorage`. Gerätelokales (Dedupe-Zeitstempel, Aufnahme-Puffer) bewusst roh.
5. Commit-Messages ohne Umlaute, via `git commit -F <datei>`.
6. Neue Warntypen IMMER an 3 Stellen: `DEFAULT_RULES` (functions/_notify.js), `NOTIFY_TYPES` + `NOTIFY_DEFAULTS` (app.js), auslösender Endpunkt. Danach E2E-Regelanzahl in tests/e2e.spec.js anpassen (aktuell 10).
7. Neue externe Fetch-Ziele des CLIENTS in `_headers` unter `connect-src` eintragen (serverseitige Fetches brauchen das nicht).
8. Magnus-/Komfort-Formeln sind bewusst dupliziert (lib/core.js + functions/) — bei Formeländerung beide Stellen.
9. Nach jedem Punkt, der UI oder Endpunkte ändert: `npm run test:e2e` lokal laufen lassen.
10. DOM-freie Logik gehört nach `lib/core.js` (UMD-Muster dort kopieren) mit Tests in `tests/core.test.js`.

---

## Phase A — Datensicherheit & Verlustrisiken (zuerst, Reihenfolge einhalten)

### Punkt 1: Cron-Totmannschalter (Warnung, wenn check-alerts nicht mehr läuft)

**Ziel:** Fällt der externe Cron aus, erscheint eine rote Briefing-Warnung — sonst ist das gesamte Warnsystem unbemerkt tot.

**Dateien:** `functions/api/health.js`, `app.js` (loadHubPreviews + Briefing-Signale), evtl. `tests/core.test.js`.

**Schritte:**
1. `functions/api/health.js`: Query-Parameter `?quick=1` ergänzen. Bei `quick`: NUR aus D1 `alert_state` den Wert `cron_heartbeat` lesen und `{ cronLastSeen: <ms|null> }` zurückgeben — KEINE ThingSpeak-/Wetter-Checks (die machen den vollen Health-Check teuer). Ohne D1: `{ cronLastSeen: null }`.
2. `app.js`, in `loadHubPreviews()` (dort werden die Briefing-Signale gesammelt): `apiFetch('/api/health?quick=1')` best effort. Wenn `cronLastSeen` vorhanden und älter als 3 h: Signal `{ level: 'warn', text: 'Warn-Cron meldet sich nicht mehr (letzter Lauf vor X h)', href: '#settings' }` zum Briefing hinzufügen. Wenn `cronLastSeen === null` (D1 nie gelaufen): KEIN Signal (Erstinstallation nicht zuspammen).
3. Fehler von apiFetch (`err.unavailable`) still schlucken — Feature bleibt dann unsichtbar.

**Abnahme:** Manuell in D1 `cron_heartbeat` auf alten Wert setzen → Briefing zeigt Warnung. `npm test` grün.

**Fallstricke:** Der Push-Weg kann hier NICHT warnen (der tote Cron kann nicht über sich selbst berichten) — Client-Anzeige ist die Lösung. `health.js` liegt hinter der Auth-Middleware, `apiFetch` sendet Credentials automatisch mit.

**Commit:** `Plan2-1: Cron-Totmannschalter im Briefing (health?quick=1)`

---

### Punkt 2: Automatisches D1-Backup nach R2

**Ziel:** Wöchentlicher Dump aller D1-Tabellen als JSON nach R2 — bisher gibt es KEINE serverseitige Sicherung.

**Dateien:** neu `functions/api/backup-dump.js`, `README.md` (Cron-Doku).

**Schritte:**
1. Neuer Endpunkt `GET /api/backup-dump` (Muster: `check-alerts.js` für Cron-Aufrufbarkeit, `photos.js` für R2-Zugriff). Ohne `env.MEDIA` → 503, ohne `env.DB` → 503.
2. Tabellen dumpen: `user_settings`, `todos`, `climate_daily`, `gpx_activities`, `locations`, `push_subscriptions`. Je Tabelle `SELECT *` — bei `gpx_activities` in Schleifen mit `LIMIT 50 OFFSET n` paginieren (points-Spalte ist groß; Workers-Memory schonen). Fehlende Tabellen per try/catch überspringen.
3. Ergebnis `{ createdAt, tables: { name: rows[] } }` als JSON nach R2: Key `backup/d1-YYYY-MM-DD.json` (`env.MEDIA.put`).
4. Retention: `env.MEDIA.list({ prefix: 'backup/' })`, sortieren, alles außer den neuesten 8 löschen.
5. Antwort: `{ ok, key, tables: {name: rowCount}, deleted }`.
6. README: beim Cron-Abschnitt ergänzen: zweiten Cron-Job (wöchentlich, z. B. So 03:00) auf `/api/backup-dump` einrichten (gleiche Basic-Auth-Header wie check-alerts).

**Abnahme:** Endpunkt mit `curl -u user:pass` aufrufen → 200 mit Zeilenzahlen; Objekt liegt in R2. Ohne MEDIA-Binding → 503. `npm test` grün.

**Fallstricke:** Endpunkt liegt hinter der Middleware — Cron-Dienst muss Basic-Auth mitsenden (macht er für check-alerts schon). Kein `JSON.stringify` pro Zeile streamen — einfach ein Objekt bauen, private Nutzung bleibt unter den Limits.

**Commit:** `Plan2-2: Woechentlicher D1-Dump nach R2 (backup-dump)`

---

### Punkt 3: ThingSpeak-Historie einmalig ins Archiv backfüllen (CSV-Import)

**Ziel:** ThingSpeak hält nur ~8000 Einträge; ältere Messwerte verschwinden endgültig. Ein CSV-Import füllt `climate_daily` rückwirkend.

**Dateien:** `lib/core.js` (+ Export), `tests/core.test.js`, `app.js`, `index.html` (Archiv-Karte), `sw.js` (Bump).

**Schritte:**
1. `lib/core.js`: zwei neue DOM-freie Funktionen (UMD-Export ergänzen):
   - `parseThingSpeakCsv(text, fieldMap)` — parst ThingSpeak-Feed-CSV (Kopfzeile `created_at,entry_id,field1,...`), liefert Array `{ created_at, field1, field2, ... }` (Strings roh lassen — Komma-Dezimal behandelt `processRawFeeds`). Anführungszeichen-Felder berücksichtigen, leere Zeilen überspringen.
   - `aggregateDailyClimate(aligned, todayKey)` — extrahiert die bestehende Tagesaggregation aus `app.js` (Block um `const byDay = {}` in der Archiv-Upload-Funktion, ca. Zeile 1845): Gruppierung nach Tag, min/max/avg für temp/humidity, `co2Avg`/`co2Max` nur wenn CO2-Werte vorhanden, Tage `>= todayKey` auslassen. Rückgabeformat exakt wie der bestehende `days`-Array (POST-Format von `/api/climate`).
2. `app.js`: Archiv-Upload-Funktion auf `aggregateDailyClimate` umstellen (Duplikat entfernen).
3. `app.js` + `index.html`: In der Archiv-Karte Button „Historie importieren (CSV)" + verstecktes `<input type=file accept=.csv>`. Handler: Datei lesen → `parseThingSpeakCsv` → `processRawFeeds(rows, getLocationFields(appState.activeLocId))` → `aggregateDailyClimate` → in Blöcken von max. 300 Tagen `POST /api/climate` (`{ loc, days }`). Fortschritts-Toast, Abschluss-Toast mit Tageszahl, danach `loadArchiveView()` neu laden.
4. Tests: `parseThingSpeakCsv` (Normalfall, Anführungszeichen, leere Felder) und `aggregateDailyClimate` (Aggregation, CO2 nur bei Werten, heutiger Tag ausgelassen) in `tests/core.test.js`.
5. README kurz: ThingSpeak → Channel → „Export recent data" → CSV, dann im Archiv importieren.

**Abnahme:** Neue Core-Tests grün; CSV-Import einer Beispieldatei erzeugt Archivzeilen. `npm run build:css` + sw-Bump nicht vergessen (HTML geändert).

**Fallstricke:** ThingSpeak-CSV nutzt Punkt ODER Komma je nach Kanal — deshalb Rohstrings an `processRawFeeds` geben, das behandelt Komma-Dezimal bereits. Upsert in `/api/climate` ist idempotent (INSERT OR REPLACE) — Mehrfach-Import ist harmlos, aber vorhandene Tage werden überschrieben (bei vollständigerem CSV gewollt).

**Commit:** `Plan2-3: ThingSpeak-CSV-Backfill fuer das Klima-Archiv`

---

### Punkt 4: GPX-Fotos ins GPX-Backup einbeziehen

**Ziel:** Die R2-Fotos (Plan-10b) tauchen im GPX-Backup (`exportBackup`/`importBackup` in gpx.js, ab ca. Zeile 311) nicht auf.

**Dateien:** `gpx.js`, `sw.js` (Bump falls gpx.html angefasst wird — hier nicht nötig).

**Schritte:**
1. `exportBackup()` in gpx.js: Wenn `_photosSupported` (Flag existiert seit Plan-10b): pro Aktivität mit `uid` die Fotoliste `GET /api/photos?uid=...` holen, jedes Bild via `fetch(url)` laden und als base64 (`FileReader.readAsDataURL` auf den Blob) unter `backup.photos = { [uid]: [{ n, dataUrl }] }` ablegen. Vorher `modalConfirm`: „Fotos mitsichern? (macht die Datei deutlich groesser)" — bei Nein Feld weglassen.
2. `importBackup()`: Nach dem Wiederherstellen der Aktivitäten: falls `backup.photos` vorhanden und `_photosSupported`, je Foto dataUrl → Blob (`fetch(dataUrl).then(r=>r.blob())`) → `PUT /api/photos?uid=..&n=..` mit `Content-Type: image/webp`. Fehler einzeln schlucken (best effort), Abschluss-Toast mit Zähler.
3. Format-Version im Backup-Objekt auf 2 erhöhen; Import muss Version 1 (ohne photos) weiterhin akzeptieren.

**Abnahme:** Tour mit Foto exportieren → Foto löschen → Backup importieren → Foto wieder da. `npm test` grün (Smoke prüft Handler).

**Fallstricke:** Base64 bläht ~33 % auf — bei 5 Fotos × 500 KB × vielen Touren ok für privaten Gebrauch. `_photosSupported` ist erst nach dem ersten `renderPhotos`-Aufruf gesetzt — im Export vorab einmal `GET /api/photos?uid=<erste uid>` probieren, wenn Flag noch `null`.

**Commit:** `Plan2-4: GPX-Fotos im Backup (Export/Import mit base64)`

---

### Punkt 5: Brute-Force-Schutz für den Basic-Auth-Login

**Ziel:** Der Feeds-Proxy hat Rate-Limiting, der Login selbst nicht — Passwörter sind unbegrenzt ratbar.

**Dateien:** `functions/_middleware.js`, `functions/api/check-alerts.js` (Hygiene).

**Schritte:**
1. `_middleware.js`: Wenn ein `Authorization`-Header vorhanden ist, aber `authenticate()` fehlschlägt UND `env.DB` existiert:
   - Tabelle `CREATE TABLE IF NOT EXISTS auth_fails (ip TEXT PRIMARY KEY, count INTEGER, first_ms INTEGER)` (try/catch).
   - IP aus `request.headers.get('CF-Connecting-IP') || 'unknown'`.
   - Zeile lesen; wenn `first_ms` älter als 15 min → Zähler zurücksetzen. Zähler +1 schreiben.
   - Bei `count > 10`: sofort `429` mit Text „Zu viele Fehlversuche, bitte 15 Minuten warten." zurückgeben (VOR dem 401).
2. Erfolgsfall: NICHTS in D1 tun (kein Overhead pro Request). Kein Header vorhanden (Erstbesuch): ebenfalls nichts zählen, direkt 401.
3. Aufräumen: im D1-Hygiene-Block von `check-alerts.js` (dort werden schon alte `alert_state`-Zeilen gelöscht): `DELETE FROM auth_fails WHERE first_ms < ?` (älter als 1 h).
4. Alle D1-Zugriffe in try/catch — D1-Ausfall darf den Login NIE blockieren.

**Abnahme:** 11× mit falschem Passwort curl'en → 429; mit korrektem Passwort weiterhin sofort 200. `npm test` grün.

**Fallstricke:** `AUTH_MODE=access`-Zweig nicht anfassen (Cloudflare Access übernimmt dort). Die Middleware läuft bei JEDEM Request — der Fehlversuchspfad ist selten, darf also D1 kosten; der Erfolgspfad nicht.

**Commit:** `Plan2-5: Rate-Limit gegen Login-Brute-Force (auth_fails in D1)`

---

## Phase B — Qualität & Wartbarkeit (Reihenfolge: 6, 7, 8, 9, 10)

### Punkt 6: Server-API-Tests (D1-Endpunkte)

**Ziel:** Außer `_webpush.js` ist kein Endpunkt getestet — insbesondere die Merge-/Tombstone-Logik (settings LWW, todos, gpx-Konflikte) ist riskant ungetestet.

**Dateien:** neu `tests/api.test.js`, neu `tests/helpers/d1-node.js`, `package.json` (test-Script), `.github/workflows/ci.yml` (Node 22).

**Schritte:**
1. CI auf `node-version: 22` heben (alle 3 Jobs) — benötigt für `node:sqlite`.
2. `tests/helpers/d1-node.js` (CommonJS): D1-Adapter über `require('node:sqlite').DatabaseSync` (in-memory). Nachbauen: `prepare(sql)` → Objekt mit `bind(...args)` (Werte merken, `this` zurück), `first()`, `all()` → `{ results }`, `run()`; außerdem `exec(sql)` und `batch(stmts)` (sequenziell ausführen). D1 nutzt `?`-Platzhalter wie SQLite — kompatibel.
3. Functions sind ESM mit `.js`-Endung (Repo ist CJS) — direkter Import scheitert. Deshalb im Test-Setup: `functions/` rekursiv in ein Temp-Verzeichnis kopieren, Endungen auf `.mjs` umschreiben und in den Dateien Import-Pfade `from '../_auth.js'` → `'../_auth.mjs'` etc. ersetzen (einfaches `replace(/\.js'/g, ".mjs'")`). Dann `await import(tempPfad)`.
4. Tests (Muster `tests/core.test.js`: eigenes Mini-`test()`/`assert`):
   - `settings.js`: POST zwei Items → GET liefert beide; POST mit älterem `updatedAt` überschreibt NICHT (LWW); `value:null` löscht.
   - `todos.js`: Upsert, Tombstone (`deleted=1`) gewinnt nach `updatedAt`, GET filtert.
   - `climate.js`: POST-Upsert idempotent, CO2-Spalten (ensureSchema-ALTER greift), GET mit/ohne `loc`.
   - `gpx.js`: PUT neu, PUT mit älterem `updatedAt` ändert nichts, DELETE setzt Tombstone.
   - Auth: Request ohne/mit falschem Basic-Header → 401 (env `AUTH_USER=test`, `AUTH_PASS=test`; Header `Authorization: Basic dGVzdDp0ZXN0`).
   - Context-Attrappe: `{ request: new Request(url, {...}), env: { DB: adapter, AUTH_USER, AUTH_PASS } }`. `Request`/`Response` sind in Node 22 global.
5. `package.json` test-Script erweitern: `&& node tests/api.test.js`.

**Abnahme:** `npm test` lokal (Node >= 22) und in CI grün.

**Fallstricke:** `node:sqlite` ist ab Node 22.5 stabil genug; lokal Node-Version prüfen. `env.DB.exec` bei D1 nimmt EINEN Befehl pro Aufruf entgegen — der Adapter kann `exec` direkt durchreichen. `identify()` liest nur den Header (kein D1) — funktioniert ungemockt.

**Commit:** `Plan2-6: Server-API-Tests mit node:sqlite-D1-Adapter`

---

### Punkt 7: E2E-Tests für ClimateFlow

**Ziel:** Chart, Lüftungsberater, Briefing und Archiv-Heatmap haben keinerlei E2E-Abdeckung.

**Dateien:** `tests/e2e.spec.js`, neu `tests/fixtures/` (JSON-Fixtures).

**Schritte:**
1. Fixtures anlegen: `tests/fixtures/thingspeak.json` (Feed-Antwort: `{ channel: {...}, feeds: [ { created_at, field1: '21,5', field2: '55' }, ... ]` — ~30 Einträge über 24 h, Komma-Dezimal!) und `tests/fixtures/openmeteo.json` (`{ current: {...}, hourly: { time: [unix...], temperature_2m: [...], relative_humidity_2m: [...] }, daily: {...} }`, `timeformat=unixtime` beachten: Zeiten als Unix-Sekunden).
2. Neuer Test `ClimateFlow: Chart, Berater, Briefing`:
   - `page.route('**/api.thingspeak.com/**', fixture)` und `page.route('**/api.open-meteo.com/**', fixture)` (JSON aus Datei, dynamisch `created_at`/`time` auf „jetzt minus n Stunden" verschieben, sonst greift die Stale-Erkennung).
   - `page.goto('/index.html#climate')`, `waitReady`.
   - Erwartungen: `#climateChart` sichtbar; `#ventilation-verdict` hat Text aus {`LÜFTEN`,`SCHLIESSEN`,`EGAL`}; KPI `#kpi-temp-out` nicht leer; keine pageerrors.
3. Neuer Test `Briefing-Widget zeigt Status`: auf `#home`, `#briefing-list` existiert und hat mindestens ein Kind (bei Fixture-Daten „Alles im gruenen Bereich" oder Signale).
4. Neuer Test `ClimateFlow: Karten klappen`: Chevron der Chart-Karte klicken → Body versteckt; erneut klicken → sichtbar (IDs: `chart-collapse-body`, Toggle über die Karte `data-widget="cf-chart"`).

**Abnahme:** `npm run test:e2e` → 7 Tests grün.

**Fallstricke:** Fixture-Zeitstempel MÜSSEN relativ zu `Date.now()` generiert werden (im Test-Code verschieben), sonst meldet die App „Sensor stale" und der Berater rechnet nicht. Route-Pattern mit `**` vor der Domain, Playwright matcht sonst nicht.

**Commit:** `Plan2-7: E2E-Abdeckung fuer ClimateFlow, Briefing und Klapp-Karten`

---

### Punkt 8: Inline-Handler entfernen → CSP ohne `unsafe-inline` (2 Commits erlaubt)

**Ziel:** `script-src 'unsafe-inline'` entwertet die CSP gegen XSS. Voraussetzung für Punkt 9.

**Dateien:** `index.html`, `gpx.html`, `app.js`, `gpx.js`, `shared.js`, `tests/smoke.test.js`, `_headers`, `sw.js` (Bump), `tailwind.css` (Rebuild).

**Schritte (Commit 8a — Umbau):**
1. `shared.js`: zentrale Event-Delegation ergänzen:
   ```js
   ['click','change','input','submit'].forEach(evt =>
     document.addEventListener(evt, e => {
       const el = e.target.closest(`[data-on${evt}]`);
       if (!el) return;
       const [name, ...args] = el.getAttribute(`data-on${evt}`).split('|');
       const fn = window[name];
       if (typeof fn === 'function') { if (evt === 'submit') e.preventDefault(); fn(...args.map(a => a === '$value' ? (el.value ?? '') : a), e); }
     })
   );
   ```
   Konvention: `onclick="foo(24)"` → `data-onclick="foo|24"`; `onchange="saveNote(this.value)"` → `data-onchange="saveNote|$value"`; `onsubmit` analog. (Argumente kommen als Strings an — Funktionen wie `setChartTimeframe` müssen `parseInt`/`parseFloat` tolerant sein; prüfen und ggf. am Funktionsanfang `Number(...)` ergänzen.)
2. ALLE `onclick=`/`onchange=`/`oninput=`/`onsubmit=`-Attribute in `index.html`, `gpx.html` UND in per Template-String erzeugtem HTML in `app.js`/`gpx.js`/`shared.js` (Modals!) auf `data-on…` umstellen. Systematisch mit grep arbeiten: `grep -n "on\(click\|change\|input\|submit\)=" index.html gpx.html app.js gpx.js shared.js`.
3. Sonderfall `onclick="if (event.target === this) …"` (Modal-Overlays): auf `data-onclick` mit eigener kleiner Handler-Funktion umstellen, die `e.target === e.currentTarget` prüft — Achtung: bei Delegation ist `currentTarget` das document; stattdessen `e.target.closest('[data-onclick]') === el` reicht, weil das Overlay selbst das Attribut trägt und der Panel-Inhalt darüber liegt — konkret: Handler prüft `e.target === el`.
4. `tests/smoke.test.js`: die Handler-Prüfung von `onclick=` auf `data-on*=` umstellen (Funktionsname = Teil vor `|`), Prüfung „Funktion in app.js/shared.js definiert" beibehalten.
5. Funktionen, die jetzt über `window[name]` gefunden werden müssen, sind bereits global (Top-Level in klassischen Skripten) — nichts zu tun; NUR falls eine in einem Block/Closure steckt, explizit `window.foo = foo` setzen.

**Schritte (Commit 8b — CSP scharfstellen):**
6. Inline-Theme-Snippet (Zeile ~6 beider HTMLs, FOUC-Schutz) bleibt inline: SHA-256-Hash berechnen (`echo -n "<snippetinhalt>" | openssl dgst -sha256 -binary | openssl base64`) und in `_headers` als `'sha256-…'` in `script-src` aufnehmen. Beide HTMLs müssen exakt dasselbe Snippet nutzen (einmal vereinheitlichen).
7. `_headers`: `script-src 'self' 'sha256-…'` (das `'unsafe-inline'` entfernen). `style-src` unverändert lassen.
8. Manuell im Browser gegen einen lokalen Server mit Headern testen (oder nach Deploy): Konsole darf keine CSP-Verletzungen zeigen; alle Buttons/Modals/Selects durchklicken. E2E komplett laufen lassen.

**Abnahme:** `npm test` + `npm run test:e2e` grün; keine `onclick=`-Treffer mehr (`grep -c` = 0 außer ggf. in vendor/); CSP ohne `unsafe-inline` in script-src.

**Fallstricke:** Der größte Punkt der Runde — NICHT mit anderen mischen. Playwright-E2E fängt die meisten Regressionen; zusätzlich jede Seite einmal manuell durchklicken. `updateIcons()`-aria-Logik bleibt unberührt.

**Commits:** `Plan2-8a: Inline-Handler durch data-on*-Delegation ersetzt` / `Plan2-8b: CSP ohne unsafe-inline (Theme-Snippet per Hash)`

---

### Punkt 9: app.js modularisieren (esbuild-Bundle)

**Ziel:** 3810 Zeilen in einer Datei. Ein Kommentar in app.js (Zeile ~18) erklärt: Split scheitert ohne Bundler am Top-Level-Scope → also Bundler.

**Dateien:** neu `src/` (Module), `package.json`, `.github/workflows/ci.yml`, `app.js` (wird Build-Artefakt), `tests/smoke.test.js`, `README.md`.

**Schritte:**
1. `esbuild` als devDependency (`npm i -D esbuild`). Script: `"build:js": "esbuild src/app/main.js --bundle --format=iife --outfile=app.js"`. `app.js` bleibt committet (wie `tailwind.css`) — kein Deploy-Build nötig.
2. app.js entlang der vorhandenen Abschnitts-Kommentare (Modul-Übersicht am Dateikopf) in `src/app/` zerlegen: `config.js` (LOCATIONS, appState, Thresholds), `data.js` (fetch/reload/offline), `climate.js` (Chart, Berater, Schimmel/Komfort), `archive.js` (Archiv, Heatmap, Rekorde), `hub.js` (Widgets, To-dos, Kalender, Briefing), `settings.js` (Einstellungen, Notify-UI, Backup), `main.js` (init, Verkabelung). Gemeinsamer Zustand via `export`/`import` (appState aus config.js exportieren).
3. Alle über `data-on*` (Punkt 8) aufgerufenen Funktionen in `main.js` explizit registrieren: `Object.assign(window, { setChartTimeframe, exportFullBackup, ... })` — Liste aus dem Smoke-Test ableiten.
4. Smoke-Test: prüft weiterhin gegen das GEBAUTE `app.js` — keine Änderung nötig, aber verifizieren.
5. CI: Job `css-check` um JS erweitern (bauen, `git diff --exit-code app.js`); dazu muss der Build deterministisch sein (esbuild-Version pinnen, exakte Version in package.json ohne `^`).
6. README: Abschnitt Entwicklung um `npm run build:js` ergänzen. CLAUDE.md: Regel ergänzen „app.js ist GEBAUT (aus src/app/), nie direkt editieren".
7. `gpx.js` NICHT anfassen (1234 Zeilen, noch vertretbar).

**Abnahme:** Gebautes app.js verhält sich identisch: alle Unit-/Smoke-/E2E-Tests grün, Bundle-Diff in CI stabil.

**Fallstricke:** Reihenfolgeabhängigkeiten beim Zerlegen (Hoisting verdeckt bisher Zyklen) — bei zirkulären Imports Funktionen statt Konstanten exportieren. `--format=iife` verhindert Scope-Leck; Registrierung über window (Schritt 3) ist deshalb Pflicht.

**Commit:** `Plan2-9: app.js in ES-Module zerlegt (esbuild-Bundle, committet)`

---

### Punkt 10: ESLint in der CI

**Ziel:** Ungenutzte Variablen, versehentliche Globals und Tippfehler vor der Laufzeit fangen.

**Dateien:** neu `eslint.config.js`, `package.json`, `.github/workflows/ci.yml`.

**Schritte:**
1. `npm i -D eslint` (v9, flat config). `eslint.config.js`: drei Blöcke —
   - Browser-Dateien (`src/**`, `gpx.js`, `shared.js`, `settings-sync.js`, `lib/core.js`): `languageOptions.globals` = Browser + gemeinsame Globals (`Store`, `apiFetch`, `showToast`, `modalPrompt`, `modalConfirm`, `updateIcons`, `Chart`, `L`, `lucide`, projektweit per grep ermitteln), `sourceType: 'module'` für src/, sonst `script`.
   - `functions/**`: `sourceType: 'module'`, Worker-Globals (`Response`, `Request`, `fetch`, `crypto`, `caches`).
   - `tests/**`, `sw.js`: Node- bzw. ServiceWorker-Globals.
2. Regeln bewusst minimal: `no-undef: error`, `no-unused-vars: [warn, { args: 'none' }]` — KEINE Stilregeln (kein Format-Krieg mit Bestandscode).
3. Script `"lint": "eslint ."` + `ignores` für `vendor/`, `tailwind.css`, `app.js` (Build-Artefakt, nach Punkt 9).
4. CI: `lint`-Job (Node 22, `npm ci`, `npm run lint`).
5. Gefundene ECHTE Fehler fixen; Fehlalarme über gezielte globals lösen, nicht über Regel-Abschaltung.

**Abnahme:** `npm run lint` lokal 0 Errors; CI-Job grün.

**Commit:** `Plan2-10: ESLint (flat config) als CI-Job`

---

## Phase C — Funktionserweiterungen (Reihenfolge: 11 vor 12; Rest frei)

### Punkt 11: Amtliche Unwetterwarnungen (DWD via BrightSky)

**Ziel:** Sturm/Starkregen/Gewitter-Warnungen für die Standorte — Frost/Hitze sind bisher nur selbst gerechnet.

**Dateien:** `functions/api/check-alerts.js`, `functions/_notify.js`, `app.js`, `_headers`, `tests/e2e.spec.js` (Regelanzahl), `sw.js` (Bump).

**Schritte:**
1. Server (`check-alerts.js`): pro Standort `https://api.brightsky.dev/alerts?lat=..&lon=..` fetchen (kostenlos, DWD-Daten, JSON). Relevante Felder je Alert: `severity` (`minor|moderate|severe|extreme`), `headline_de`, `event_de`, `onset`, `expires`, `id`.
2. Neue Warnregel `dwd` an den 3 Pflichtstellen (Arbeitsregel 6): `DEFAULT_RULES.dwd = { on: true, dedupeH: 12 }`; `NOTIFY_TYPES` → `{ key: 'dwd', label: 'Unwetterwarnung (DWD)', icon: 'cloud-lightning' }` (kein Threshold-Feld). Versand nur bei `severity` in {`severe`,`extreme`}; Dedupe-Key um die Alert-`id` ergänzen (`dispatch`-locId-Parameter: `` `${locId}:${alert.id}` ``), damit neue Warnlagen trotz Dedupe durchkommen.
3. Client: im 3-Tage-Wetter-Widget (Hub) und in der ClimateFlow-Wetterkarte einen Warn-Banner rendern, wenn `alerts.length > 0` (Client fetcht BrightSky direkt, best effort, gleiche Koordinaten wie Open-Meteo). Farbcode: moderate=amber, severe/extreme=rot.
4. `_headers`: `https://api.brightsky.dev` in `connect-src` aufnehmen (Arbeitsregel 7).
5. E2E: Regelanzahl 10 → 11.

**Abnahme:** `npm test` + E2E grün; bei aktiver DWD-Warnlage (oder gemocktem Fetch) erscheint der Banner.

**Fallstricke:** BrightSky liefert `[]` außerhalb Deutschlands — Code muss leere Antworten still behandeln. Client-Fetch in try/catch, Widget funktioniert ohne.

**Commit:** `Plan2-11: DWD-Unwetterwarnungen (BrightSky) als Regel + Banner`

---

### Punkt 12: Briefing-Widget ausbauen

**Ziel:** Das Briefing kennt bisher Sensor-Stille, Schimmel, Feuchte, To-dos — es soll das EINE vollständige Statusbild werden.

**Dateien:** `app.js` (loadHubPreviews-Signalsammlung), ggf. `lib/core.js` (nur falls neue Rechenlogik nötig — `forecastExtremes` existiert schon).

**Schritte (je Signal try/catch, Ausfall = Signal fehlt):**
1. Frost/Hitze: `forecastExtremes` (lib/core.js) auf die geladenen Open-Meteo-Daten anwenden; unter/über den Schwellen aus `getNotifyRules()` (frost/heat-Thresholds) → `warn`-Signal „Frost heute Nacht: −2 °C erwartet" mit `href: '#climate'`.
2. CO2: wenn der aktive Standort ein co2-Extra-Feld hat und `latest.co2 > getThresholds().co2Max` → `warn`-Signal.
3. Kalender: heutige Termine aus dem bereits geladenen Kalender-Widget-Datenbestand (expandRecurring-Ergebnis wiederverwenden, NICHT neu fetchen) → `info`-Signal „2 Termine heute", `href: '#home'`.
4. DWD (nach Punkt 11): aktive Warnung → `warn`-Signal mit `headline_de`.
5. Cron-Signal aus Punkt 1 einreihen.
6. `buildBriefing`-Aufruf: `max` auf 5 erhöhen (Overflow-Zeile „+n weitere" existiert schon in der Core-Funktion).

**Abnahme:** Bestehende buildBriefing-Core-Tests bleiben grün (Funktion selbst unverändert); manuell: Signale erscheinen priorisiert (warn vor info).

**Fallstricke:** KEINE neuen Fetches einführen — nur bereits geladene Daten der anderen Widgets wiederverwenden, sonst wird der Hub-Load langsam.

**Commit:** `Plan2-12: Briefing um Frost/Hitze, CO2, Termine, DWD, Cron erweitert`

---

### Punkt 13: GPX-Live-Aufzeichnung in der PWA

**Ziel:** Touren direkt im Browser aufzeichnen statt nur fertige Dateien zu importieren.

**Dateien:** `gpx.html`, `gpx.js`, `sw.js` (Bump), `tailwind.css` (Rebuild), ggf. `tests/core.test.js`.

**Schritte:**
1. `gpx.html`: Aufnahme-Button in der Kopfzeile (`data-onclick="toggleRecording"`, roter Punkt-Icon `circle-dot`), nur sichtbar wenn `'geolocation' in navigator`. Status-Leiste (Dauer, Distanz, Punktzahl) während der Aufnahme.
2. `gpx.js` neues Modul „Recording":
   - `startRecording()`: `navigator.geolocation.watchPosition(onFix, onErr, { enableHighAccuracy: true, maximumAge: 0 })`; Wake Lock `navigator.wakeLock?.request('screen')` + Re-Acquire auf `visibilitychange`; Punkte `{ lat, lon, ele, time }` in `state.rec.points`.
   - Alle 30 s Puffer roh nach `localStorage['gpx_rec_buffer']` (gerätelokal — Arbeitsregel 4 erlaubt das ausdrücklich).
   - Fixes filtern: `accuracy > 50` m verwerfen; Punkte < 2 m Abstand zum letzten verwerfen (Stillstand-Rauschen).
   - `stopRecording()`: `clearWatch`, Wake Lock release; bei < 10 Punkten verwerfen (Toast). Sonst: `computeStats(points)` (lib/core.js), Aktivität wie beim Datei-Import anlegen (`uid` generieren wie dort, `dbPut`, `pushActivityToCloud`, Auto-Typ via `gpx_type_hints`-Logik), Puffer löschen, Tour öffnen.
   - Crash-Recovery: in `init()` — wenn `gpx_rec_buffer` existiert → `modalConfirm` „Unterbrochene Aufzeichnung wiederherstellen?" → als Tour speichern oder verwerfen.
3. Live-Karte: während der Aufnahme Polyline auf der Leaflet-Karte fortschreiben (throttled, max. 1×/5 s).
4. UI-Hinweis (einmaliger Toast beim Start): iOS pausiert GPS bei gesperrtem Bildschirm — Display anlassen (Wake Lock hilft nur bei offener App).

**Abnahme:** Desktop-Test mit Chrome DevTools Sensors (Location überschreiben) → Aufnahme erzeugt gültige Tour mit Stats; Reload während Aufnahme → Recovery-Dialog. `npm test` grün, build:css + sw-Bump.

**Fallstricke:** `downsamplePoints` (max 5000, Projektregel 6) vor dem Cloud-Push anwenden — passiert im bestehenden Push-Pfad, verifizieren. Zeitstempel als ISO-Strings speichern wie beim Import (Format der `points`-Struktur in gpx.js VOR dem Bauen exakt nachschlagen).

**Commit:** `Plan2-13: GPX-Live-Aufzeichnung (watchPosition, Wake Lock, Recovery)`

---

### Punkt 14: PWA Share-Target + File-Handler für GPX-Dateien

**Ziel:** GPX-Datei aus einer anderen App „teilen mit Smart Home Hub" bzw. .gpx-Doppelklick öffnet direkt den Import (Android/Desktop-Chromium; iOS unterstützt das nicht — Dropzone bleibt der iOS-Weg).

**Dateien:** `manifest.webmanifest`, `sw.js` (Handler + Bump), `gpx.js`.

**Schritte:**
1. Manifest: `"share_target": { "action": "/share-import", "method": "POST", "enctype": "multipart/form-data", "params": { "files": [{ "name": "file", "accept": [".gpx", "application/gpx+xml"] }] } }` und `"file_handlers": [{ "action": "/gpx.html", "accept": { "application/gpx+xml": [".gpx"] } }]`.
2. `sw.js` fetch-Handler: VOR der bestehenden GET-Weiche — wenn `request.method === 'POST' && url.pathname === '/share-import'`: `formData()` lesen, Datei-Text in den Cache legen (`caches.open(CACHE_NAME)` → `cache.put('/shared-gpx', new Response(text))`), dann `Response.redirect('/gpx.html#shared', 303)`.
3. `gpx.js` `init()`: bei `location.hash === '#shared'` → `caches.match('/shared-gpx')` lesen, löschen, durch den bestehenden Datei-Import-Pfad schicken (dieselbe Funktion wie die Dropzone), Hash entfernen.
4. `gpx.js`: `if ('launchQueue' in window) launchQueue.setConsumer(...)` → FileHandle lesen → Import-Pfad.

**Abnahme:** Desktop-Chrome: PWA installieren, .gpx via „Öffnen mit" → Import läuft. Smoke/E2E grün, sw-Bump.

**Fallstricke:** Der SW-POST-Handler MUSS vor `if (event.request.method !== 'GET') return;` greifen — Reihenfolge im fetch-Listener beachten. Manifest-Änderungen brauchen Re-Install der PWA zum Testen.

**Commit:** `Plan2-14: Share-Target + File-Handler fuer GPX-Import`

---

### Punkt 15: Foto-Geotags auf der Tourkarte

**Ziel:** EXIF-GPS der Tour-Fotos als Marker auf der Leaflet-Karte (der WebP-Resize aus Plan-10b verwirft EXIF — Koordinaten müssen VOR dem Resize extrahiert werden).

**Dateien:** `vendor/exifr.lite.umd.js` (neu, gepinnt), `gpx.html`, `gpx.js`, `functions/api/photos.js`, `sw.js` (APP_SHELL + Bump).

**Schritte:**
1. exifr lite als Vendor pinnen: `https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/lite.umd.js` herunterladen nach `vendor/exifr.lite.umd.js`, in `gpx.html` als `<script defer>` einbinden, in `APP_SHELL` aufnehmen.
2. `uploadTourPhoto` (gpx.js): vor `resizeImageToWebp` → `const gps = await exifr.gps(file).catch(() => null)` → bei Treffer `lat`/`lon` als Query-Parameter an den PUT hängen: `/api/photos?uid=..&n=..&lat=..&lon=..`.
3. `photos.js` (PUT): `lat`/`lon` validieren (parseFloat, Bereich ±90/±180) und als `customMetadata: { lat, lon }` im `MEDIA.put` speichern. GET-Liste: `env.MEDIA.list({ prefix, include: ['customMetadata'] })` und `lat`/`lon` je Foto mit ausgeben.
4. `drawMap` (gpx.js): nach dem Zeichnen der Route für jedes Foto mit Koordinaten einen Marker setzen (Leaflet `L.marker` mit `L.divIcon` Kamera-Symbol); Popup mit `<img src="${p.url}" style="max-width:200px">`, Klick auf das Bild öffnet die bestehende Lightbox.

**Abnahme:** Foto MIT GPS-EXIF hochladen → Marker an der richtigen Stelle; Foto ohne GPS → kein Marker, kein Fehler. Tests + sw-Bump.

**Fallstricke:** `exifr.gps` auf dem ORIGINAL-`file` aufrufen, nie auf dem WebP-Blob. HEIC-Fotos vom iPhone: exifr-lite liest HEIC-EXIF — aber `resizeImageToWebp` (Canvas) kann HEIC in vielen Browsern nicht dekodieren; wenn `img.onerror`, sauberen Toast zeigen (bestehendes Verhalten prüfen).

**Commit:** `Plan2-15: Foto-Geotags als Karten-Marker (exifr, R2 customMetadata)`

---

### Punkt 16: Nutzerverwaltung in D1 (ohne Redeploy)

**Ziel:** Neue Profile ohne Env-Var-Änderung + Deploy anlegen. Env-Nutzer (`AUTH_USER`/`AUTH_USERS`) bleiben als Fallback IMMER gültig (Lockout-Schutz).

**Dateien:** `functions/_auth.js`, `functions/_middleware.js`, neu `functions/api/users.js`, `app.js` + `index.html` (Admin-Bereich Einstellungen), `tests/api.test.js`, `sw.js` (Bump).

**Schritte:**
1. `_auth.js`: neue async Funktion `authenticateAsync(request, env)` — prüft ZUERST die bestehende synchrone Env-Logik (unverändert); bei Nichttreffer und vorhandenem `env.DB`: Tabelle `users (name TEXT PRIMARY KEY, pass_hash TEXT, salt TEXT, iters INTEGER, is_admin INTEGER, created_at INTEGER)`, PBKDF2-SHA256-Vergleich via `crypto.subtle` (`deriveBits`, 1000 Iterationen — bewusst niedrig wegen Workers-CPU-Limit; der Brute-Force-Schutz aus Punkt 5 kompensiert). In-Memory-Cache pro Isolate: `Map<name, {hashHex, okUntilMs}>` (TTL 5 min), damit nicht jeder Request PBKDF2 rechnet.
2. `_middleware.js`: `authenticate(...)` durch `await authenticateAsync(...)` ersetzen. `identify()` (nur Header-Decode) bleibt synchron und unverändert.
3. `functions/api/users.js`: Admin-only (`identify` → `isAdmin`-Prüfung wie in `locations.js` nachschlagen). GET (Liste ohne Hashes), POST `{name, password}` (Hash+Salt erzeugen, `crypto.getRandomValues`), PUT (Passwort ändern), DELETE (Nutzer entfernen; Env-Nutzer nicht löschbar → 400).
4. Einstellungen (app.js/index.html): Admin-Karte „Profile" — Liste, Anlegen/Passwort/Löschen über `modalPrompt`/`modalConfirm`.
5. `whoami`/`_notify.js`: prüfen, wo Profillisten aus Env gelesen werden (`_auth.js`-Nutzerliste) — D1-Nutzer dort ergänzen, damit Push-Empfänger und Profil-Erkennung sie kennen.
6. Tests (api.test.js): User anlegen → Auth mit dessen Credentials → 200; falsches Passwort → 401; Hash-Roundtrip.

**Abnahme:** Neuer D1-Nutzer kann sich einloggen und hat eigenes Profil (Store-Keys `p_<name>_…`); Admin aus Env funktioniert weiterhin, auch wenn D1 leer/kaputt.

**Fallstricke:** Passwörter NIE loggen oder in GET-Antworten liefern. `authenticateAsync` muss bei D1-Fehlern auf „nicht authentifiziert" fallen, NIE auf „durchlassen". Latenz: Cache (Schritt 1) ist Pflicht, sonst wird jede API-Antwort spürbar langsamer.

**Commit:** `Plan2-16: Nutzerverwaltung in D1 (PBKDF2, Admin-UI, Env-Fallback)`

---

### Punkt 17: Heizkosten-/Gradtag-Schätzung im Archiv

**Ziel:** Aus AUSSEN-Tagesmitteln (Open-Meteo Archive API) Gradtagzahlen + grobe Kostenschätzung; Vergleich zur Vorsaison via `periodCompare`-Muster.

**Dateien:** `lib/core.js` + `tests/core.test.js`, `app.js`, `index.html` (Archiv-Karte), `_headers`, `sw.js` (Bump).

**Schritte:**
1. `lib/core.js`: `degreeDays(outDailyMeans, { base = 20, heatLimit = 15 } = {})` — Array `{ day, tOut }`; Gradtagzahl nach VDI: nur Tage mit `tOut < heatLimit` zählen, Beitrag `base - tOut`. Rückgabe `{ total, days, byMonth: { 'YYYY-MM': n } }`. Tests: Normalfall, warmer Sommer (0), Grenzwerte.
2. `app.js` (Archiv-Ansicht): Außen-Tagesmittel für den Archiv-Zeitraum von `https://archive-api.open-meteo.com/v1/archive?latitude=..&longitude=..&start_date=..&end_date=..&daily=temperature_2m_mean&timezone=auto` holen (einmal je Ansicht, best effort, `timeformat` hier egal weil `daily.time` ISO-Daten liefert).
3. Neue Karte „Heizperiode" unter dem Jahres-Block: Gradtage der laufenden Heizperiode (Okt–Mär, Logik aus `renderArchiveYear` übernehmen), Vergleich Vorjahresperiode (Delta in %), darunter Kostenschätzung: `total × kwhPerDegreeDay × pricePerKwh`. Beide Faktoren aus `Store.getJSON('energy_config', { kwhPerDegreeDay: 0, pricePerKwh: 0 })`; bei 0 nur Gradtage ohne Euro anzeigen. Zahnrad-Button öffnet `modalPrompt` mit beiden Feldern (Komma-Dezimal tolerieren: `replace(',', '.')`).
4. `_headers`: `https://archive-api.open-meteo.com` in `connect-src`.

**Abnahme:** Neue Core-Tests grün; Karte zeigt Gradtage + Vorjahres-Delta; ohne `energy_config` keine Euro-Zeile.

**Fallstricke:** Archive-API hat ~5 Tage Verzögerung — Zeitraum bis `heute − 6 Tage` anfragen, sonst 400er. Ergebnisse pro Standort+Zeitraum in `sessionStorage` cachen (roh ok, gerätelokal, session-flüchtig), um API-Spam beim Tab-Wechsel zu vermeiden.

**Commit:** `Plan2-17: Gradtagzahlen + Heizkosten-Schaetzung im Archiv`

---

### Punkt 18: Archiv-CSV-Export

**Ziel:** `climate_daily` als CSV herunterladen — `downloadCsv(filename, lines)` existiert bereits in shared.js.

**Dateien:** `app.js`, `index.html` (Archiv-Kopfzeile), `sw.js` (Bump), `tailwind.css` (Rebuild).

**Schritte:**
1. Export-Button (Icon `download`) in der Archiv-Kopfzeile neben dem CSV-Import aus Punkt 3.
2. Handler: `appState.archiveRows` (liegt nach `loadArchiveView` vor) → Kopfzeile `Tag;T-Min;T-Max;T-Mittel;F-Min;F-Max;F-Mittel;Messwerte;CO2-Mittel;CO2-Max` → Zeilen mit Semikolon-Trennung und Komma-Dezimal (deutsches Excel: `String(v).replace('.', ',')`), leere Werte als leerer String → `downloadCsv('klima-archiv-<loc>-<datum>.csv', lines)`.
3. Button deaktivieren/ausblenden, solange keine Zeilen geladen sind.

**Abnahme:** Download öffnet sauber in Excel/Numbers (BOM setzt downloadCsv bereits). Smoke-Test grün (neuer Handler).

**Commit:** `Plan2-18: CSV-Export des Klima-Archivs`

---

### Punkt 19: Vendor-Lazy-Loading (Chart-Stack erst bei Bedarf)

**Ziel:** index.html lädt Chart.js+Hammer+Zoom (~300 KB) sofort — auch für Nutzer, die nur To-dos abhaken. Erst beim ersten Chart-Bedarf nachladen.

**Dateien:** `index.html`, `shared.js`, `app.js` (bzw. `src/app/` nach Punkt 9), `sw.js` (Bump).

**Schritte:**
1. `shared.js`: Helfer `loadScript(src)` — injiziert `<script src>` einmalig, Promise-Cache in Map (mehrfacher Aufruf = dieselbe Promise).
2. `index.html`: die drei `<script>`-Tags `vendor/chart.umd.js`, `vendor/hammer.min.js`, `vendor/chartjs-plugin-zoom.min.js` ENTFERNEN. (`lucide` bleibt — braucht jede Ansicht sofort. gpx.html unverändert — der Viewer IST die Karte.)
3. `app.js`: `async function ensureChartJs()` — lädt die drei Skripte SEQUENZIELL (zoom-Plugin braucht Chart+Hammer als Globals). Vor JEDEM `new Chart(...)` (`drawChart`, `drawArchiveChart`, Vergleichs-/Trend-Charts per grep `new Chart` finden) `await ensureChartJs()`; aufrufende Funktionen dazu async machen und Aufrufer prüfen (try/catch-Blöcke bleiben wirksam, `await` ergänzen).
4. Dateien bleiben in `APP_SHELL` (Offline-Fähigkeit unverändert).
5. E2E aus Punkt 7 (Chart sichtbar) ist der Regressionstest; zusätzlich Hub-Test darf keine Chart-Requests zeigen (optional via `page.on('request')`).

**Abnahme:** Hub lädt ohne die drei Vendor-Requests (Netzwerk-Tab); ClimateFlow-Chart erscheint unverändert; alle Tests grün.

**Fallstricke:** `Chart` wird evtl. an Modul-Toplevel referenziert (Plugin-Registrierung o. ä.) — solche Stellen in `ensureChartJs` verschieben. Reihenfolge chart → hammer → zoom zwingend.

**Commit:** `Plan2-19: Chart-Vendor-Stack lazy laden`

---

## Abschluss (nach Punkt 19)

- README-Roadmap aktualisieren (erledigte Punkte streichen).
- `npm test` + `npm run test:e2e` final; Lighthouse-Lauf als Vergleich (Punkt 19 sollte den Hub-Start messbar verbessern).
- Diese Datei (PLAN2.md): erledigte Punkte mit `[x]`-Vermerk im Titel markieren statt löschen (Nachvollziehbarkeit).
