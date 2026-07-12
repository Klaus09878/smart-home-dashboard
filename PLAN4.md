# Umsetzungsplan Runde 4 — 25 Punkte

> **Status: ⏳ offen** (kein Punkt umgesetzt).
> Schwerpunkt: **Phase A behebt den langsamen mobilen Erststart** (Nutzerproblem:
> beim Öffnen erscheint zuerst nur der Footer, das Dashboard braucht bis zu ~10 s).
> Danach: Einstellbarkeit (B), Tiefe/Insights (C), Robustheit & Mobile-UX (D).

Für die schrittweise Umsetzung durch ein KI-Modell (oder einen Menschen) geschrieben:
pro Punkt Ziel, Dateien mit Funktionsankern, konkrete Schritte, Abnahme und Fallstricke.
**Ein Punkt = ein Commit** (Prefix `Plan4-N:`), direkt auf `main` (Auto-Deploy, Projektregel 8).
Die Zeilennummern-Anker gelten für den Stand beim Schreiben dieses Plans — nach den
ersten Commits verschieben sie sich; **immer über den Funktionsnamen suchen**, die
Zeilennummer ist nur Startpunkt.

## Ausgangsanalyse Erststart (verifiziert am Code — Grundlage für Phase A)

1. **Alle drei Views starten `hidden`** (`index.html:58` `#view-home`, `:265` `#view-settings`,
   `:415` `#view-climate`); nur der Footer (`index.html:1063-1069`) ist immer sichtbar.
   Eingeblendet wird erst in `handleRoute()`, das `init()` (app-main.js:331) **nach**
   mehreren `await`s aufruft → der beschriebene „Footer-Blitzer".
2. **Sequenzielle Netz-Roundtrips vor dem ersten Render:** `await Store.init()`
   (whoami → danach settings-Pull, settings-sync.js:208-226) → `await loadDynamicLocations()`
   (app-core.js:217) → erst dann `handleRoute()`. Auf Mobilfunk: 3+ serielle RTTs à
   Hunderte ms, bevor überhaupt etwas erscheint.
3. **Render-Blocker im `<head>`:** Google-Fonts-CSS (index.html:25-27, gpx.html:17-19,
   extern = DNS+TLS+RTT vor dem ersten Paint) und **synchrones** `vendor/lucide.min.js`
   (index.html:32). gpx.html lädt zusätzlich `chart.umd.js` und `leaflet.js` synchron
   im head (gpx.html:21-28).
4. **Service Worker ist Network-first ohne Timeout** (sw.js:107-120): auch mit vollem
   Cache wartet jeder Wiederbesuch auf das Netz. Zusätzlich: **Erstbesuch lädt die Seite
   einmal komplett neu**, weil `clients.claim()` (sw.js:77) + der `controllerchange`-Listener
   (shared.js:312-317) beim allerersten SW-Install ein `location.reload()` auslösen.
5. **ThingSpeak-Erstladung `results=8000`** (fetchFeeds-Default app-core.js:78,
   loadIndoorData app-core.js:465) — großer JSON-Download + Parse auf dem Handy,
   obwohl Chart-Standard 24 h ist.
6. **Bis zu 4 Open-Meteo-Aufrufe + 2 DWD-Aufrufe beim Hub-Start:** Uhr-Widget
   (app-main.js:138), je Standort-Vorschau (app-main.js:193), Forecast-Widget
   (app-hub.js:421), DWD doppelt (app-hub.js:446 + app-core.js:561).

## Arbeitsregeln (gelten für JEDEN Punkt)

1. Vor jedem Commit: `npm run lint` (0 Fehler) und `npm test` (Core + WebPush + API + Smoke) grün; bei UI-/Endpunkt-Änderungen zusätzlich `npm run test:e2e` (aktuell 8 Tests).
2. App-Logik liegt in **sechs klassischen Skripten** `app-core/analysis/archive/hub/settings/main.js` (gemeinsamer globaler Scope, Ladereihenfolge = Reihenfolge in index.html, `app-main.js` zuletzt). Es gibt KEIN `app.js`. Neue Funktionen in die thematisch passende Datei; Top-Level-Aufrufe erst nach der Definition.
3. Event-Handler NIE inline (`onclick=` bricht die CSP) — immer `data-onclick="fn|arg"` / `data-onchange` / `data-onsubmit` / `data-onbackdrop` (Delegation in shared.js; `$value`, `$checked`, `$event` als Sonderargumente). Der Smoke-Test erzwingt das und verlangt, dass jede referenzierte Funktion in app-*.js/shared.js (bzw. gpx.js) als globale Funktion existiert.
4. Nach Klassen-Änderungen in HTML/app-*.js/gpx.js/shared.js: `npm run build:css`, `tailwind.css` mitcommitten. Bei Änderungen an APP_SHELL-Dateien: `CACHE_NAME` in sw.js hochzählen (aktuell `smarthub-v44`).
5. Profilbezogene Einstellungen NUR über `Store.*`. Neue Pref-Schlüssel dieser Runde: `app_prefs`, `chart_prefs`, `widget_prefs` (JSON, immer mit Defaults-Merge lesen). Gerätelokales (Dedupe, Offline-Snapshots, Aufnahme-Puffer) bewusst roh in localStorage.
6. Runde 4 führt KEINEN neuen Warntyp ein — die E2E-Regelanzahl (tests/e2e.spec.js:24) bleibt **13**. Punkt 12/13 erweitern nur bestehende Regeln um Felder.
7. Externe CLIENT-Fetch-Ziele stehen in `_headers` (`connect-src`); Runde 4 ENTFERNT dort die Google-Fonts-Hosts (Punkt 4). Das Inline-Theme-Snippet in beiden HTMLs NIE ändern (CSP-Hash `sha256-eLZhyzXdu32xZFF/i0jEbzBcH5z949HuC9z7s5q31EY=`; der Smoke-Test prüft das).
8. DOM-freie Logik nach `lib/core.js` (UMD-Muster; Export-Liste am Dateiende ~Zeile 926 ergänzen) mit Tests in tests/core.test.js. Server-Logik-Tests in tests/api.test.js (D1-Adapter tests/helpers/d1-node.js, Node ≥ 22).
9. Formeln sind bewusst dupliziert (lib/core.js ↔ functions/) — bei Änderungen beide Stellen.
10. Commit-Messages ohne Umlaute, via `git commit -F <datei>` (PowerShell-Quoting!).
11. **NEU (Phase A):** Performance-Punkte werden mit `npm run perf` (Punkt 1) unter IDENTISCHEN Bedingungen vorher/nachher gemessen; die Zahlen kommen in `docs/PERF.md` und sind Teil der Abnahme. **Messwerte niemals schätzen oder erfinden** — wenn eine Messung nicht läuft, das Problem beheben oder ehrlich dokumentieren.
12. Reihenfolge von Phase A strikt einhalten (Punkt 1 = Baseline VOR jeder Änderung).

---

## Phase A — Mobiler Erststart (Priorität 1, Reihenfolge einhalten)

### Punkt 1: Perf-Messgeschirr + Baseline-Messung

**Ziel:** Reproduzierbare Vorher-Zahlen (Zeit bis sichtbares Hub-Gerüst, Requests, Bytes) unter simulierten Mobilbedingungen — ohne Baseline ist keine Verbesserung nachweisbar.

**Dateien:** neu `scripts/perf-audit.mjs`, neu `docs/PERF.md`, `package.json` (Script `"perf": "node scripts/perf-audit.mjs"`).

**Schritte:**
1. `tests/static-server.js` ansehen (wird von Playwright genutzt) und im Skript wiederverwenden bzw. denselben Mechanismus starten (Port z. B. 4780, nicht der E2E-Port).
2. `scripts/perf-audit.mjs` (ESM, nutzt vorhandenes devDependency `@playwright/test` → `import { chromium } from '@playwright/test'`):
   - `chromium.launch()`, neuer Kontext pro Lauf (= Erstbesuch, kein SW, kein Cache).
   - CDP-Session: `Network.emulateNetworkConditions` (latency 150 ms, download ≈ 200 000 B/s, upload ≈ 98 000 B/s ≈ „Fast 3G") und `Emulation.setCPUThrottlingRate` (rate 4).
   - **API-Latenz simulieren** (lokal gibt es keine Functions): `page.route('**/api/**', …)` → 400 ms Verzögerung (`setTimeout`) und realistische JSON-Antworten: `/api/whoami` → `{ user: 'sean', isAdmin: false, mode: 'basic' }`; `/api/settings` → `{ settings: {} }`; `/api/locations` → `{ locations: [] }`; `/api/config*` → `{ value: null }`; `/api/health*` → `{ cronLastSeen: null }`; `/api/feeds/**` → generierte Feed-Antwort (30 Einträge, `field1: '21,5'`-Komma-Dezimal, `created_at` relativ zu jetzt); `/api/events`, `/api/todos` → leere Listen. Open-Meteo/BrightSky (`**/api.open-meteo.com/**` etc.) mit 300 ms Delay und Mini-JSON mocken (Muster aus tests/e2e.spec.js übernehmen).
   - Messwerte je Lauf: `t_domcontentloaded`, `t_load` (aus `PerformanceNavigationTiming`), `t_gerüst` = Zeit von Navigationsstart bis `#view-home` ohne Klasse `hidden` (Polling/`page.waitForFunction`), `t_briefing` = bis `#briefing-badge` nicht mehr „wird geprüft…", Anzahl Requests + Summe transferierter Bytes (`page.on('response')` + `sizes()` oder CDP `Network.loadingFinished`).
   - 3 Läufe, Median ausgeben; zusätzlich ein Lauf für `gpx.html` (nur t_domcontentloaded/t_load/Requests).
3. Ergebnis als Markdown-Tabelle auf stdout UND manuell in `docs/PERF.md` unter „Baseline (vor Runde 4)" eintragen (Datum, Bedingungen dokumentieren).
4. KEINE App-Dateien ändern in diesem Punkt.

**Abnahme:** `npm run perf` läuft lokal durch; docs/PERF.md enthält die echte Baseline-Tabelle.

**Fallstricke:** Der erste Lauf registriert den SW und löst den Erstbesuch-Reload aus (siehe Analyse Nr. 4) — genau deshalb frischen Kontext pro Lauf verwenden und `t_gerüst` ab Navigationsstart messen (der Reload zeigt sich dann ehrlich in der Zahl). Ports hart kodieren und Server im `finally` stoppen. Windows: Pfade mit `pathToFileURL`/`path.join` bauen.

**Commit:** `Plan4-1: Perf-Audit-Skript + Baseline-Messung (docs/PERF.md)`

---

### Punkt 2: Sofort sichtbares Render-Gerüst (Footer-Blitzer beheben)

**Ziel:** Beim Öffnen erscheint SOFORT das Hub-Gerüst mit den eingebauten Platzhaltern („--:--", „Lade Vorschau …", Skeleton-Pulse im Briefing) — nicht erst nach den Netz-Roundtrips.

**Dateien:** `app-main.js` (handleRoute:17, init:331), `tests/e2e.spec.js`, `sw.js` (Bump).

**Schritte:**
1. `handleRoute()` in zwei Funktionen aufspalten:
   - `renderRoute()`: NUR der synchrone View-Wechsel — hidden/flex-Klassen der drei Views, `document.title`, `updateIcons()`. **Kein Store-Zugriff, kein await, keine Datenlader.** (Auch `applyClimateLayout`/`applyCfCollapse` NICHT hierhin — die lesen den Store.)
   - `loadRouteData(view)`: der Rest des heutigen handleRoute (climate: applyClimateLayout, applyCfCollapse, reloadData/resize; home: updateHubClock, loadHubWeather, loadHubPreviews, loadGpxWidget, renderTodos, syncTodos, loadHubForecast, loadHubCalendar; settings: renderSettings).
   - `handleRoute()` bleibt als Wrapper: `const view = renderRoute(); if (appState.initDone) loadRouteData(view);` (renderRoute gibt den aufgelösten View-Namen zurück; die GPX-Umleitung `#gpx` bleibt in renderRoute).
2. `init()` umbauen: VOR dem ersten `await` → `window.addEventListener('hashchange', handleRoute); renderRoute(); updateHubClock();` — damit steht das Gerüst beim ersten Paint. Danach wie bisher `await Store.init()` etc.; am Ende `appState.initDone = true; loadRouteData(aktuellerView);` (View erneut aus dem Hash auflösen).
3. `appState.initDone = false` als neues Feld in app-core.js (appState-Objekt, Zeile ~49) deklarieren.
4. Der `store-updated`-Listener (app-main.js:362) ruft heute `handleRoute()` — das ist weiter korrekt (initDone ist dann true).
5. Neuer E2E-Test „Erststart zeigt Geruest ohne APIs": alle `**/api/**`-, ThingSpeak- und Open-Meteo-Routen per `route.abort()` blockieren → `page.goto('/')` → erwarten: `#view-home` ist innerhalb 2 s sichtbar UND `#hub-widgets` sichtbar (das schlägt vor diesem Punkt fehl und schützt künftig vor Regression).

**Abnahme:** Neuer E2E-Test grün (insgesamt 9), `npm test` grün, `npm run perf`: `t_gerüst` deutlich gesunken (Zahl in docs/PERF.md-Verlaufstabelle notieren).

**Fallstricke:** `updateHubClock`/Begrüßung ohne Store zeigt nur „Guten Tag 👋" ohne Namen — gewollt, `getProfileDisplayName` (app-main.js:92) hat den Guard bereits. `loadHubWeather` hat einen `!appState.weatherConfig`-Guard (app-main.js:135) — verifizieren, dass ALLE home-Loader vor initConfigs ungefährlich sind; sie laufen aber ohnehin erst in loadRouteData nach Store.init. Das kurze Umsortieren der Widgets durch `applyWidgetLayout` nach dem ersten Paint ist akzeptabel (besser als Footer-Blitzer).

**Commit:** `Plan4-2: Sofortiges Render-Geruest beim Start (renderRoute/loadRouteData-Split)`

---

### Punkt 3: Startsequenz parallelisieren (whoami + settings + locations gleichzeitig)

**Ziel:** Die 3+ seriellen Roundtrips vor dem ersten Datenrender auf ~1 Roundtrip-Zeit drücken.

**Dateien:** `settings-sync.js` (doInit:208, pullServer:173), `app-main.js` (init:331), `app-core.js` (loadCalibrations:237), `sw.js` (Bump).

**Schritte:**
1. `settings-sync.js`: `pullServer()` in Fetch- und Apply-Teil trennen — neue Funktion `applySettings(data)` (der Object.entries-Block aus pullServer); `pullServer` = `applySettings(await apiFetch('/api/settings'))` (für spätere Pulls unverändert).
2. `doInit()`: beide Fetches SOFORT parallel starten:
   ```js
   const whoP = apiFetch('/api/whoami');
   const setP = apiFetch('/api/settings').catch(err => ({ __err: err }));
   try { const who = await whoP; …profile/isAdmin/mode wie bisher… } catch { …local-Fallback wie bisher… }
   migrateLegacy();
   if (state.mode === 'server') {
     const data = await setP;
     if (!data.__err) applySettings(data); // erst NACH Setzen von state.profile!
     flushSync();
   }
   ```
3. `app-main.js` init: `await Promise.all([Store.init(), loadDynamicLocations()])` (loadDynamicLocations braucht den Store nicht — nur apiFetch). Danach `loadCalibrations()` OHNE await starten: `loadCalibrations().then(() => { if (appState.climateLoaded) reloadData(true); });` — Kalibrierung wirkt bei jedem `calibratedAligned`-Aufruf; falls die ersten Daten unkalibriert durchliefen, korrigiert der silente Reload das.
4. Kommentar an doInit: Reihenfolge whoami→profile→applySettings ist Pflicht (applySettings schreibt unter `p_<profil>_`-Präfix).

**Abnahme:** `npm run perf`: `t_briefing` sinkt messbar; Tests + E2E grün; Offline-Start (API blockiert) fällt weiter sauber auf local-Modus zurück (E2E-Test aus Punkt 2 deckt das ab).

**Fallstricke:** Das settings-Ergebnis darf im local-Modus NIE angewandt werden (Antwort wäre bei statischem Hosting HTML — apiFetch wirft dann ohnehin `unavailable`, der `.catch` fängt es). `loadCalibrations` iteriert über LOCATIONS — es läuft nach `loadDynamicLocations` (Promise.all abgeschlossen), sonst fehlen dynamische Standorte; Reihenfolge im Code so lassen.

**Commit:** `Plan4-3: Startsequenz parallelisiert (whoami, settings, locations gleichzeitig)`

---

### Punkt 4: Render-Blocker beseitigen — Outfit lokal, Vendor-Skripte defer

**Ziel:** Kein externer render-blockender Request mehr vor dem ersten Paint; Fonts offline-fähig.

**Dateien:** neu `vendor/fonts/outfit-{300,400,500,600,700}.woff2`, `tailwind.input.css`, `index.html`, `gpx.html`, `_headers`, `sw.js` (Shell + Bump), `tailwind.css` (Rebuild).

**Schritte:**
1. Die fünf woff2-Dateien herunterladen (stabile Fontsource-URLs):
   `https://cdn.jsdelivr.net/fontsource/fonts/outfit@latest/latin-<GEWICHT>-normal.woff2`
   für 300/400/500/600/700 → als `vendor/fonts/outfit-<GEWICHT>.woff2` committen. (Bei 404: Version pinnen, z. B. `outfit@5.2.8` — im Browser prüfen.)
2. `tailwind.input.css` (am Anfang): fünf `@font-face`-Blöcke — `font-family: 'Outfit'; font-style: normal; font-weight: <GEWICHT>; font-display: swap; src: url('vendor/fonts/outfit-<GEWICHT>.woff2') format('woff2');`. (Relative URL passt: tailwind.css liegt im Root.)
3. `index.html:24-27` und `gpx.html:17-19`: die Google-Fonts-`<link>`-Zeilen (preconnect ×2 + stylesheet) ersatzlos entfernen. Stattdessen in BEIDEN HTMLs: `<link rel="preload" href="vendor/fonts/outfit-400.woff2" as="font" type="font/woff2" crossorigin>` und dieselbe Zeile für 600.
4. `index.html:32`: `<script src="vendor/lucide.min.js">` → `<script defer src="vendor/lucide.min.js">`. `gpx.html:21-28`: `chart.umd.js`, `lucide.min.js`, `leaflet.js` alle auf `defer` (Reihenfolge der Tags beibehalten — defer erhält die Ausführungsreihenfolge).
5. VORHER verifizieren, dass kein klassisches Skript `lucide`/`Chart`/`L` auf Top-Level (außerhalb von Funktionen) anfasst: `grep -n "lucide\.\|new Chart\|L\.map\|L\.tileLayer" app-*.js gpx.js shared.js settings-sync.js` und jede Fundstelle prüfen — alle müssen in Funktionen liegen, die frühestens ab `DOMContentLoaded` laufen (init/updateIcons/drawMap …). Falls doch eine Top-Level-Nutzung existiert: in `init()` verschieben.
6. `_headers`: in der CSP `style-src` → `'self' 'unsafe-inline'` (googleapis raus) und `font-src` → `'self' data:` (gstatic raus).
7. `sw.js`: die fünf Font-Dateien in APP_SHELL aufnehmen; CACHE_NAME +1. `npm run build:css`.

**Abnahme:** `npm run perf`: keine Requests mehr an fonts.googleapis.com/fonts.gstatic.com; Schrift ist weiterhin Outfit (im Browser: DevTools → Rendered Fonts); Tests + E2E grün; Smoke-Test (APP_SHELL-Dateien existieren) grün.

**Fallstricke:** `crossorigin` am font-preload ist PFLICHT, sonst lädt der Browser die Datei doppelt. Das Theme-Inline-Snippet (Zeile ~5/6 beider HTMLs) NICHT anfassen (CSP-Hash!). gpx.js läuft als klassisches Skript am body-Ende VOR den defer-Skripten — deshalb Schritt 5 ernst nehmen; `init` hängt an `DOMContentLoaded` (gpx.js ~Ende) und ist sicher.

**Commit:** `Plan4-4: Outfit lokal (vendor/fonts) + defer fuer Vendor-Skripte`

---

### Punkt 5: apiFetch mit Timeout + GET-Retry; Timeout für Wetter-Fetches

**Ziel:** Hängende Mobilfunk-Verbindungen blockieren Start und Widgets nicht mehr minutenlang — nach 8 s greifen die vorhandenen Fallback-Pfade.

**Dateien:** `shared.js` (apiFetch:193), `app-main.js` (loadHubWeather:133), `app-core.js` (loadOutdoorWeather:538, fetchDwdAlerts:568, loadAirQuality:606), `app-hub.js` (loadHubForecast:415), `sw.js` (Bump).

**Schritte:**
1. `shared.js`: neuer Helfer `fetchWithTimeout(url, options = {}, timeoutMs = 10000)` — AbortController, `setTimeout(() => controller.abort(), timeoutMs)`, Timer in `finally` löschen; AbortError in `Error('Zeitueberschreitung')` mit `err.timeout = true` umwandeln.
2. `apiFetch`: intern `fetchWithTimeout(path, {...}, options.timeoutMs || 8000)` nutzen. WICHTIG: Timeout darf `err.unavailable` NICHT setzen (unavailable = „Feature dauerhaft nicht eingerichtet" und blendet UI aus, z. B. renderServerBackups) — Timeout ist ein normaler Fehler.
3. Retry: NUR wenn Methode GET/fehlend UND (Netzwerkfehler ODER Timeout): einmalig nach 500 ms wiederholen. POST/PUT/DELETE NIE wiederholen (Settings-Sync, To-dos: Doppel-Schreiben vermeiden).
4. Die direkten `fetch(`https://api.open-meteo…`)`-Aufrufe in loadHubWeather, loadOutdoorWeather, loadAirQuality, fetchDwdAlerts, loadHubForecast auf `fetchWithTimeout(url, {}, 10000)` umstellen (alle haben catch-Zweige mit Fallbacks — Verhalten sonst unverändert).

**Abnahme:** lint/test/E2E grün. Manuell: DevTools → Network → „Offline" nach Ladebeginn bzw. Drosselung → nach ≤ 10 s erscheinen die Fallbacks (Mock-Wetter, Offline-Snapshot) statt endlosem Spinner.

**Fallstricke:** `err.unavailable` wird an vielen Stellen als „Feature ausblenden" interpretiert (grep `unavailable` vor dem Umbau!) — Timeout-Fehler dürfen diese Pfade nicht triggern. gpx.js nutzt apiFetch ebenfalls (Cloud-Sync) — Timeout 8 s ist dort ok, aber der GPX-Upload großer Touren (POST) braucht evtl. länger: in `pushActivityToCloud` (gpx.js:227) `timeoutMs: 30000` mitgeben.

**Commit:** `Plan4-5: apiFetch mit Timeout und GET-Retry, fetchWithTimeout fuer Wetter-APIs`

---

### Punkt 6: ThingSpeak-Erstladung halbieren (14 Tage statt 8000 Einträge)

**Ziel:** Kleinerer Erst-Download/Parse auf dem Handy; volle Historie nur, wenn der Nutzer sie wirklich ansieht („Alle").

**Dateien:** `app-core.js` (fetchFeeds:78, loadIndoorData:452), `app-analysis.js` (setChartTimeframe:478), `index.html` (Overlay-Untertitel:45), `sw.js` (Bump).

**Schritte:**
1. `loadIndoorData`: Erst-Load (kein Cache) mit `results: 4032` (= 14 Tage à 5-min-Takt; deckt Lüftungs-Tagebuch 14 d, renderVentilationDiary, ab) statt 8000; im Cache-Eintrag `appState.feedCache[id] = { rawFeeds, full: false }` das Flag mitführen. Inkrementeller Refresh (start-Parameter) unverändert; die 8000er-Kappung (`slice(-8000)`, Zeile 472) bleibt.
2. Neue Funktion `async function ensureFullHistory()` (app-core.js, unter loadIndoorData): wenn `cache && !cache.full` → Toast „Lade volle Historie …", `fetchFeeds(activeLoc, { results: 8000 })` OHNE start, `rawFeeds` KOMPLETT ERSETZEN (die 8000er-Antwort enthält die jüngeren Einträge mit), `full: true`, danach processRawFeeds + calibratedAligned → `appState.insideData`, `saveOfflineSnapshot`.
3. `setChartTimeframe(hours)` (app-analysis.js:478): Funktion `async` machen; bei `hours === -1` (Button `btn-tf-all`, index.html:902) zuerst `await ensureFullHistory()`, dann wie bisher zeichnen. (Die data-on*-Delegation verkraftet async-Handler.)
4. Nach einem Voll-Load `full: true` auch beim regulären Refresh erhalten (beim Zusammenführen in loadIndoorData das bestehende Flag übernehmen).
5. `index.html:45`: Overlay-Untertitel „ThingSpeak Abfrage läuft (results=8000)" → „Messwerte werden geladen …".

**Abnahme:** `npm run perf`: transferierte Bytes des feeds-Requests deutlich kleiner (Fixture entsprechend results-Parameter variieren — der Mock aus Punkt 1 soll `results` aus der URL lesen und so viele Einträge liefern). „Alle" zeigt weiterhin die komplette Historie (manuell/DevTools). Tests + E2E grün.

**Fallstricke:** `archiveClimateDaily` (app-archive.js:9) aggregiert nur geladene Tage — 14 Tage reichen (ältere Tage stehen längst im Archiv); Kommentar dazu an loadIndoorData. `ensureFullHistory` muss `appState.lastSensorUpdate` NICHT neu setzen (gleiche jüngste Werte). Standortwechsel (`switchLocation`) nutzt denselben Cache pro Standort — Flag ist standortbezogen korrekt, weil es im feedCache-Eintrag liegt.

**Commit:** `Plan4-6: Erst-Load auf 14 Tage begrenzt, volle Historie lazy bei Alle`

---

### Punkt 7: Service Worker — Netzwerk-Timeout mit Cache-Fallback + kein Erstbesuch-Reload

**Ziel:** Wiederbesuche starten bei langsamem Netz nach ~2,5 s aus dem Cache statt aufs Netz zu warten; der Erstbesuch lädt nicht mehr mitten im Start einmal komplett neu.

**Dateien:** `sw.js` (fetch-Handler:81-121, Bump), `shared.js` (registerServiceWorker:295).

**Schritte:**
1. `sw.js`: Hilfsfunktion `networkFirstWithTimeout(request, ms)`:
   ```js
   const networkP = fetch(request).then(res => {
     if (res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then(c => c.put(request, copy)); }
     return res;
   });
   const timeoutP = new Promise(r => setTimeout(() => r('TIMEOUT'), ms));
   const winner = await Promise.race([networkP, timeoutP]);
   if (winner !== 'TIMEOUT') return winner;
   const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
   return cached || networkP; // kein Cache-Treffer → doch aufs Netz warten
   ```
   Wichtig: networkP läuft nach dem Timeout WEITER und aktualisiert den Cache im Hintergrund.
2. Den bestehenden GET-Zweig (sw.js:107-120) auf diese Funktion umstellen: `ms = 2500` bei `request.mode === 'navigate'`, sonst `3500`. Der Offline-catch (Cache → `'./'`-Fallback) bleibt als äußere `.catch`-Hülle erhalten.
3. `shared.js` registerServiceWorker: Erstbesuch-Reload unterbinden —
   ```js
   let hadController = !!navigator.serviceWorker.controller;
   navigator.serviceWorker.addEventListener('controllerchange', () => {
     if (!hadController) { hadController = true; return; } // erster Install: KEIN Reload
     if (refreshing) return; refreshing = true; location.reload();
   });
   ```
4. CACHE_NAME +1.

**Abnahme:** `npm run perf`: Zweitbesuch-Szenario ergänzen (im selben Kontext zweite Navigation) — `t_gerüst` beim Wiederbesuch ≈ Timeout-Grenze oder besser. Manuell: Update-Weg funktioniert weiter (CACHE_NAME-Bump deployen/simulieren → „Neue Version"-Toast → Neu laden). Tests grün.

**Fallstricke:** Die Timeout-Promise darf nie rejecten. `clone()` VOR dem Konsumieren. Der gpx-`#record`-Autostart verließ sich auf den Erstbesuch-Reload (Kommentar gpx.js:1514-1526) — der sessionStorage-Mechanismus funktioniert auch OHNE Reload (Flag wird direkt eingelöst); Kommentar dort aktualisieren.

**Commit:** `Plan4-7: SW-Timeout-Fallback auf Cache + kein Reload beim Erstinstall`

---

### Punkt 8: Hub-Wetterabrufe bündeln + Nachher-Messung Phase A

**Ziel:** Ein Open-Meteo-Aufruf pro Koordinate statt bis zu vier; DWD nur einmal je Koordinate; danach die Phase-A-Bilanz dokumentieren.

**Dateien:** `app-core.js` (neuer Helfer bei fetchDwdAlerts:568), `app-main.js` (loadHubWeather:133, loadHubPreviews:151), `app-hub.js` (loadHubForecast:415), `docs/PERF.md`, `README.md`, `sw.js` (Bump).

**Schritte:**
1. `app-core.js`: `async function getHubWeather(lat, lon, forecastDays = 3)` — EIN Fetch:
   `…/v1/forecast?latitude=&longitude=&current=temperature_2m,relative_humidity_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code&hourly=temperature_2m,precipitation_probability,weather_code&forecast_days=${forecastDays}&timezone=auto&timeformat=unixtime`.
   Promise-Cache in Map, Key `` `${lat.toFixed(3)},${lon.toFixed(3)},${forecastDays}` ``, TTL 10 min (Eintrag `{ p, ts }`; abgelaufen → neu). Fehler → Cache-Eintrag löschen (kein Fehler-Caching).
2. Gleiches Muster für DWD: `getDwdAlerts(lat, lon)` als TTL-Cache-Wrapper um fetchDwdAlerts; Aufrufer (app-hub.js:446, app-core.js:561) umstellen.
3. `loadHubWeather` (app-main.js): `const d = await getHubWeather(conf.lat, conf.lon)` → `d.current`. `loadHubForecast` (app-hub.js): dieselbe Funktion, nutzt `d.daily`/`d.hourly` (setzt weiterhin `appState.hourlyWeather` — das Briefing liest es, app-main.js:234). Schimmel-Außentemperatur in `loadHubPreviews` (app-main.js:193): `(await getHubWeather(loc.defaultWeather.lat, loc.defaultWeather.lon)).current.temperature_2m` statt eigenem fetch.
4. NICHT umstellen: `loadOutdoorWeather` (braucht `past_days=7`, eigenes Format) — Kommentar an getHubWeather.
5. `npm run perf` unter identischen Bedingungen; docs/PERF.md: Abschnitt „Nach Phase A" mit Tabelle Baseline↔Nachher (t_gerüst, t_briefing, Requests, Bytes) + 3-Zeilen-Fazit. README: kurzer Absatz „Performance" (Verweis auf docs/PERF.md und `npm run perf`).

**Abnahme:** PERF.md zeigt echte Vorher/Nachher-Zahlen; Requests im Audit gesunken; Tests + E2E grün (E2E-Wetter-Mocks matchen per Wildcard-Host — prüfen, dass die gebündelte URL abgedeckt ist, sonst Route-Pattern in tests/e2e.spec.js anpassen).

**Fallstricke:** weatherConfig-Koordinaten sind oft identisch mit einem defaultWeather — der Promise-Cache dedupliziert das automatisch (gleicher Key). `forecastDays` gehört in den Cache-Key (Punkt 11 macht ihn konfigurierbar). appState.dwdAlerts weiterhin setzen (Briefing liest es, app-main.js:249).

**Commit:** `Plan4-8: Hub-Wetterabrufe gebuendelt (1 Fetch je Koordinate) + Phase-A-Bilanz`

---

## Phase B — Einstellbarkeit & Feintuning

### Punkt 9: Einstellungs-Karte „Verhalten & Anzeige" + konfigurierbare Intervalle

**Ziel:** Auto-Refresh (bisher fix 5 min) und Hub-Vorschau-Drossel (fix 2 min) pro Profil einstellbar; Grundgerüst für die Punkte 10/11.

**Dateien:** `index.html` (Settings-View, nach der „Einrichtung"-Karte ~Zeile 298), `app-settings.js` (renderSettings:7), `app-main.js` (init:331, setInterval:373, loadHubPreviews:152), `tests/e2e.spec.js`, `tailwind.css` (Rebuild), `sw.js` (Bump).

**Schritte:**
1. index.html: neue `<section class="glass-panel …" id="settings-behavior">` mit Titel „Verhalten & Anzeige" (Icon `sliders-horizontal`) und leerem Container `<div id="behavior-list" class="grid grid-cols-1 sm:grid-cols-2 gap-3"></div>` (Muster der Nachbar-Karten kopieren).
2. `app-settings.js`: `const APP_PREFS_DEFAULTS = { refreshMin: 5, hubPreviewMin: 2 };` + `function getAppPrefs() { return { ...APP_PREFS_DEFAULTS, ...(Store.getJSON('app_prefs', {}) || {}) }; }` + `renderBehaviorSettings()` (zwei `<select data-onchange="saveBehaviorSetting|refreshMin|$value">`-Zeilen; Optionen refreshMin: 2/5/10/15, hubPreviewMin: 1/2/5) + `function saveBehaviorSetting(key, value)` (Number, in app_prefs mergen, Store.setJSON, ggf. `startAutoRefresh()` aufrufen). `renderSettings()` ruft `renderBehaviorSettings()` auf.
3. `app-main.js`: den 5-min-`setInterval`-Block (Zeile 373-383) in `function startAutoRefresh()` kapseln: `if (appState._refreshTimer) clearInterval(appState._refreshTimer); appState._refreshTimer = setInterval(…, getAppPrefs().refreshMin * 60 * 1000);` — Aufruf in init und im `store-updated`-Listener. Die Drossel in `loadHubPreviews` (Zeile 152) liest `getAppPrefs().hubPreviewMin`.
4. E2E-Settings-Test (tests/e2e.spec.js:21) um `await expect(page.locator('#settings-behavior')).toBeVisible();` ergänzen.

**Abnahme:** Auswahl ändern → `app_prefs` im Store (DevTools localStorage `p_<profil>_app_prefs`); Timer nutzt neues Intervall (Konsolen-Log des Interval-Blocks zeigt sich entsprechend). lint/test/E2E grün; build:css.

**Fallstricke:** `getAppPrefs` liegt in app-settings.js, wird aber von app-main.js benutzt — Ladereihenfolge passt (settings vor main), Aufruf erfolgt zudem erst in init. Handler `saveBehaviorSetting` muss globale Top-Level-Funktion sein (Smoke-Test). `$value` liefert Strings → `Number()`.

**Commit:** `Plan4-9: Einstellungs-Karte Verhalten & Anzeige + konfigurierbare Intervalle`

---

### Punkt 10: Chart-Voreinstellungen (Standard-Zeitraum, letzten Zeitraum merken)

**Ziel:** ClimateFlow startet mit dem bevorzugten Chart-Zeitraum statt immer 24 h.

**Dateien:** `app-analysis.js` (setChartTimeframe:478), `app-main.js` (loadRouteData, climate-Zweig), `app-settings.js` (Behavior-Karte), `sw.js` (Bump).

**Schritte:**
1. `chart_prefs` (Store-JSON): `{ defaultTf: 24, rememberLast: false, lastTf: null }`; Getter `getChartPrefs()` analog getAppPrefs (app-settings.js).
2. Aus `setChartTimeframe` die Button-Highlight-Logik in `function highlightTfButton(hours)` extrahieren (IDs `btn-tf-24/-72/-168/-all`, index.html:899-902); Verhalten identisch halten.
3. `setChartTimeframe`: am Ende `if (getChartPrefs().rememberLast) { const p = getChartPrefs(); p.lastTf = hours; Store.setJSON('chart_prefs', p); }`.
4. Beim ERSTEN Öffnen des Klima-Views (app-main.js, loadRouteData-climate-Zweig, `!appState.climateLoaded`): vor `reloadData()` → `const p = getChartPrefs(); appState.currentChartTimeframe = (p.rememberLast && p.lastTf) || p.defaultTf; highlightTfButton(appState.currentChartTimeframe);` — bei `-1` zusätzlich nach dem Laden `ensureFullHistory()` anstoßen (dann Chart neu zeichnen; Punkt 6).
5. UI in renderBehaviorSettings: select „Standard-Zeitraum" (24 h/3 Tage/7 Tage/Alle → Werte 24/72/168/-1) + checkbox „letzten Zeitraum merken" (`data-onchange="saveChartPref|rememberLast|$checked"` — Handler analog saveBehaviorSetting, aber für chart_prefs).

**Abnahme:** Einstellung „7 Tage" → ClimateFlow-Erstöffnung zeigt 7-Tage-Chart mit aktivem 168-Button; „merken" an → Zeitraumwechsel überlebt Reload. Tests + E2E grün.

**Fallstricke:** `filterForTimeframe` (app-analysis.js:255) interpretiert die Stundenwerte — `-1` = alles (verifizieren, wie -1 dort behandelt wird, bevor es als Default erlaubt wird). `$checked` liefert boolean, `$value` String — im Handler beides tolerieren.

**Commit:** `Plan4-10: Chart-Voreinstellungen (Standard-Zeitraum, letzten Zeitraum merken)`

---

### Punkt 11: Widget-Feinkonfiguration (Vorschau-Tage, Kalender-Fenster, To-do-Anzeige)

**Ziel:** Die Hub-Widgets an eigene Bedürfnisse anpassen — mehr Vorschautage, größeres/kleineres Kalenderfenster, erledigte To-dos automatisch ausblenden.

**Dateien:** `app-hub.js` (loadHubForecast:415, loadHubCalendar:533, renderTodos:248), `app-settings.js` (Behavior-Karte), `app-core.js` (getHubWeather aus P8), `tailwind.css`, `sw.js` (Bump).

**Schritte:**
1. `widget_prefs` (Store-JSON): `{ forecastDays: 3, calHorizonDays: 14, calMax: 6, todoHideDoneDays: 0 }` (0 = nie ausblenden); Getter `getWidgetPrefs()` in app-settings.js.
2. `loadHubForecast`: `getHubWeather(conf.lat, conf.lon, prefs.forecastDays)` (P8-Signatur nutzt forecastDays bereits im Cache-Key); Zellen-Grid dynamisch: `el.style.gridTemplateColumns = `repeat(${prefs.forecastDays}, minmax(0,1fr))`;` (style-src erlaubt inline). Fehltext-`col-span-3` ggf. generisch machen.
3. `loadHubCalendar`: `horizon = now + prefs.calHorizonDays * DAY_MS`; `.slice(0, prefs.calMax)` statt fix 6; Leertext „Keine Termine in den nächsten 14 Tagen" dynamisch formulieren.
4. `renderTodos`: erledigte Einträge mit `t.done && prefs.todoHideDoneDays > 0 && t.updatedAt < Date.now() - prefs.todoHideDoneDays*DAY_MS` aus der ANZEIGE filtern (Daten unangetastet — Sync/Backup unverändert).
5. UI in renderBehaviorSettings: drei selects (Vorschau 3/5/7 Tage; Kalender 7/14/30 Tage; Termin-Anzahl 6/10) + select „Erledigte To-dos ausblenden nach" (nie/1/7/30 Tage). Handler-Muster aus Punkt 9 wiederverwenden (`saveWidgetPref|key|$value`).

**Abnahme:** 5-Tage-Auswahl → Widget zeigt 5 Zellen (Open-Meteo liefert forecast_days=5); Kalender respektiert Fenster/Anzahl; erledigtes altes To-do verschwindet aus der Liste, bleibt aber in D1. lint/test/E2E grün; build:css.

**Fallstricke:** forecastDays verändert die Open-Meteo-URL → der TTL-Cache-Key aus P8 MUSS den Wert enthalten (dort bereits vorgesehen — verifizieren). `hub-rain-hint`/`showHourlyForecast` nutzen `appState.hourlyWeather` unabhängig von der Tageszahl — funktioniert weiter.

**Commit:** `Plan4-11: Widget-Feinkonfiguration (Vorschau-Tage, Kalenderfenster, To-do-Anzeige)`

---

### Punkt 12: Benachrichtigungs-Feintuning — Entprell-Intervall je Regel

**Ziel:** „Wie oft darf dieselbe Warnung kommen?" pro Regel einstellbar (heute serverseitig fix, z. B. sensor 6 h).

**Dateien:** `app-settings.js` (NOTIFY_TYPES:401, NOTIFY_DEFAULTS:416, renderNotifyRules:434, saveNotifyRulesFromUI:468), `sw.js` (Bump).

**Schritte:**
1. Client-Kopie der Server-Dedupe-Defaults: in NOTIFY_DEFAULTS (oder als eigene Map `DEDUPE_DEFAULTS`) je Typ die dedupeH-Werte aus `functions/_notify.js:12-24` eintragen (sensor 6, mold 12, frost 18, heat 18, co2 6, dwd 12, window 3, digest 20, vent 20, errors 6, weekly 120, monthly 480, todo 24) — Kommentar: „Kopie der Server-Defaults, s. functions/_notify.js DEFAULT_RULES".
2. `renderNotifyRules`: in jeder Regel-Zeile ein kleines `<input type="number" min="1" max="168">` mit Label „max. 1×/ h" (Muster der bestehenden threshold-Inputs in derselben Funktion kopieren, inkl. `data-onchange="saveNotifyRulesFromUI"`), vorbelegt mit `rules.types[key].dedupeH ?? Default`.
3. `saveNotifyRulesFromUI`: dedupeH je Typ parsen; gültig (1–168) → `types[key].dedupeH = n`; leer/ungültig → Property löschen (Server-Default greift). Serverseitig ist NICHTS zu tun — `typeCfg` (functions/_notify.js:32-36) merged Custom-Felder bereits über die Defaults, `dispatch` liest `cfg.dedupeH` (Zeile 144).
4. Für weekly/monthly (sehr große Werte) das Feld weglassen oder max=720 — Entscheidung: Feld nur für Typen mit dedupeH ≤ 24 anzeigen (sensor, mold, frost, heat, co2, dwd, window, digest, vent, errors, todo).

**Abnahme:** Wert ändern → `notify_rules` im Store enthält `dedupeH`; E2E-Settings-Test unverändert grün (`toHaveCount(13)` — Inputs liegen INNERHALB der 13 Zeilen, tests/e2e.spec.js:24). lint/test grün.

**Fallstricke:** saveNotifyRulesFromUI wird von JEDEM Feld getriggert und schreibt das Gesamtobjekt — bestehende Struktur (thresholds, quiet) nicht zerstören; vorher die Funktion GENAU lesen. Zahlen-Inputs liefern Strings.

**Commit:** `Plan4-12: Entprell-Intervall je Warnregel im UI einstellbar (dedupeH)`

---

### Punkt 13: Morgen-Digest konfigurierbar (Uhrzeit + Bausteine)

**Ziel:** Der Digest (P3-5) kommt zur Wunsch-Uhrzeit und enthält nur die gewünschten Abschnitte.

**Dateien:** `functions/api/check-alerts.js` (Digest-Block ~Zeile 376-417), `app-settings.js` (renderNotifyRules), `sw.js` (Bump).

**Schritte:**
1. Regel-Erweiterung (kein neuer Typ!): `notify_rules.types.digest` bekommt optional `hour` (5–10, Default 7 — Achtung: heutiges Serverfenster prüfen, Zeile ~378) und `parts: { weather, todos, climate, events }` (alle Default true).
2. UI: in `renderNotifyRules` NUR für `key === 'digest'` einen kleinen Button „Anpassen" (`data-onclick="configureDigest"`) → neue Funktion `configureDigest()` in app-settings.js: `modalPrompt` mit select Stunde (5/6/7/8/9/10) + 4 Checkboxen → in notify_rules mergen (Store.setJSON, wie saveNotifyRulesFromUI es tut).
3. `check-alerts.js`: das äußere Berlin-Zeitfenster des Digest-Blocks auf 5–12 Uhr weiten; IM Empfänger-Loop: `const fromH = cfg.hour ?? 7; if (berlinHour < fromH || berlinHour >= fromH + 2) continue;` (2-h-Fenster; der 20-h-Dedupe verhindert Doppelversand). Abschnitte nur anhängen, wenn `cfg.parts?.<name> !== false` (Wetter/To-dos/Klima/Termine — die vier bestehenden parts-Blöcke, Zeilen ~389-408).
4. Vorher lesen, wie `loadRecipients` in functions/_notify.js die `notify_rules` aus D1 parst (rec.rules) — Struktur ist dieselbe wie im Client-Store; nichts zu ändern, nur verifizieren.

**Abnahme:** Manueller Aufruf `/api/check-alerts` (mit Basic-Auth) im konfigurierten Fenster → Report-JSON enthält genau einen `profil:digest`-Eintrag; abgeschaltete Bausteine fehlen im Text (Report/ntfy-Sichtprüfung). E2E-Regelanzahl bleibt 13; lint/test grün.

**Fallstricke:** `cfg` stammt aus `typeCfg(rec.rules, 'digest')` — unbekannte Felder (hour, parts) laufen durch den Spread automatisch mit. UI-Validierung der Stunde (5–10), sonst feuert der Digest nie (außerhalb des äußeren Fensters). Cron läuft evtl. nur alle paar Stunden — README-Hinweis: Digest-Zeitfenster braucht einen Cron-Lauf im Fenster.

**Commit:** `Plan4-13: Morgen-Digest konfigurierbar (Uhrzeit und Bausteine je Profil)`

---

## Phase C — Bestehendes vertiefen (Insights aus vorhandenen Daten)

### Punkt 14: Lüftungs-Wirkungsanalyse (Was bringt mein Lüften?)

**Ziel:** Aus den erkannten Stoßlüft-Ereignissen der letzten 14 Tage konkrete Wirkung ableiten: Ø Feuchte-Senkung, typische Uhrzeit — direkt unter dem Lüftungs-Tagebuch.

**Dateien:** `lib/core.js` (+ Export ~926), `tests/core.test.js`, `app-analysis.js` (renderVentilationDiary:73), `index.html` (Tagebuch-Block ~717-724), `tailwind.css`, `sw.js` (Bump).

**Schritte:**
1. VORHER die Signatur/Rückgabe von `detectVentilationEvents` und `ventilationStats` in lib/core.js exakt nachschlagen (Felder der Event-Objekte!).
2. `lib/core.js`: `ventilationImpact(aligned, opts = {})` — nutzt detectVentilationEvents über den gesamten übergebenen Zeitraum; Rückgabe `null` bei 0 Events, sonst `{ count, avgDropRh, avgDurationMin, bestHourFrom, bestHourTo }` (bestes 3-h-Fenster = meiste Event-Starts; Stunden lokal aus `event.start`-Zeit). UMD-Export ergänzen.
3. Tests (tests/core.test.js, Muster vorhandener Tests): (a) zwei künstliche Events → count=2, avgDropRh korrekt gemittelt; (b) keine Events → null; (c) bestHour-Fenster deterministisch bei geballten Morgen-Events.
4. UI: index.html im Tagebuch-Block eine Zusatzzeile `<p id="vent-impact" class="hidden text-[11px] text-slate-400 mt-2"></p>`; in `renderVentilationDiary` nach der bestehenden Statistik `ventilationImpact(feeds)` aufrufen und z. B. rendern: „Ø −6 % Feuchte pro Stoßlüften · meist zwischen 7–10 Uhr" (Komma-Dezimal: `toFixed(1).replace('.', ',')`); bei null versteckt lassen.

**Abnahme:** Neue Core-Tests grün; Zeile erscheint mit Demo-/echten Daten (E2E-ClimateFlow-Test läuft unverändert). build:css falls Klassen neu.

**Fallstricke:** `renderVentilationDiary` erhält `feeds` = appState.insideData (nach P6: 14 Tage) — genau der gewünschte Zeitraum; NICHT erneut filtern. Uhrzeiten aus `Date`-Objekten der aligned-Einträge (lokale Zeit), nicht UTC.

**Commit:** `Plan4-14: Lueftungs-Wirkungsanalyse (ventilationImpact) im Tagebuch`

---

### Punkt 15: Monats-Insights im Klima-Archiv (Auto-Sätze)

**Ziel:** Das Archiv beantwortet „Wie war dieser Monat im Vergleich?" in 2–3 deutschen Sätzen (Vormonat + Vorjahresmonat), statt nur Rohtabellen/Heatmap.

**Dateien:** `lib/core.js` (+ Export), `tests/core.test.js`, `app-archive.js` (loadArchiveView:64), `index.html` (Archiv-Karte `data-widget="cf-archive"` ~940), `tailwind.css`, `sw.js` (Bump).

**Schritte:**
1. VORHER die exakten Feldnamen der Archivzeilen nachschlagen (GET-Antwort von functions/api/climate.js bzw. wie app-archive.js `rows` verwendet — z. B. `day`, `t_min`, `t_max`, `t_avg`, `h_avg`, `samples`; NICHT raten).
2. `lib/core.js`: `monthlyInsights(rows, now = new Date())` — Gruppierung nach Monat (`day.slice(0,7)`); Monate mit < 10 Datentagen überspringen; für den jüngsten vollständig vorhandenen Monat M: Ø-Temp/Ø-Feuchte, Delta zu M−1 und zum selben Monat im Vorjahr (falls vorhanden); Rückgabe `{ month: 'YYYY-MM', tAvg, hAvg, sentences: [ 'Der Juni war 1,2 °C wärmer und 4 % trockener als der Mai.', 'Gegenüber Juni 2025: +0,8 °C.' ] }` oder `null`. Monatsnamen deutsch (`Intl.DateTimeFormat('de-DE', { month: 'long' })`), Zahlen mit Komma.
3. Tests: 3-Monats-Fixture → Deltas + Satzinhalt (substring-Assertions); fehlender Vorjahresmonat → nur 1 Satz; leeres Array → null.
4. UI: index.html in der Archiv-Karte oberhalb des Rekord-Bereichs ein Block `<div id="archive-insights" class="hidden …"></div>` (Glass-Stil der Umgebung, lightbulb-Icon); `loadArchiveView` ruft nach dem Laden `renderArchiveInsights(rows)` (neue Funktion in app-archive.js: Sätze als `<p>`-Zeilen, escapeHtml).

**Abnahme:** Core-Tests grün; mit vorhandenen Archivdaten erscheinen die Sätze (Sichtprüfung); ohne Archiv bleibt der Block versteckt. lint/test/E2E grün.

**Fallstricke:** Der laufende Monat ist unvollständig — Insights auf den letzten Monat mit ≥ 10 Tagen beziehen (sonst schiefe „Juli war kälter"-Aussagen am Monatsanfang). Feldnamen exakt übernehmen (t_avg vs. tAvg entscheidet über NaN).

**Commit:** `Plan4-15: Monats-Insights aus dem Klima-Archiv (monthlyInsights)`

---

### Punkt 16: Wochen-Muster-Heatmap (Stunde × Wochentag) in ClimateFlow

**Ziel:** Sichtbar machen, WANN Feuchte/Temperatur typischerweise hoch sind (z. B. Duschzeiten, Schlafphasen) — aus den bereits geladenen 14-Tage-Rohdaten, ohne neue Requests.

**Dateien:** `lib/core.js` (+ Export), `tests/core.test.js`, `index.html` (neue Karte), `app-analysis.js` (Render + Umschalter), `app-hub.js` (CF_CARD_META:175), `app-core.js` (renderActiveView:767 — Aufruf einreihen), `tailwind.css`, `sw.js` (Bump).

**Schritte:**
1. `lib/core.js`: `hourlyPattern(aligned, field = 'humidity')` → `{ grid, min, max }`; `grid` = 7×24-Array von Mittelwerten (`null` ohne Daten), Zeile 0 = Montag (`(getDay()+6)%7`). Export + Tests: bekannte Werte → richtige Zelle/Mittel; leer → null; Feld 'temp' funktioniert.
2. index.html: neue Karte `<section data-widget="cf-pattern" …>` nach der cf-analytics-Section — Aufbau (Kopf mit Titel „Wochen-Muster", Einklapp-Chevron, Body-`id`) EXAKT vom Muster einer bestehenden Klapp-Karte kopieren (cf-chart ansehen; Klapp-Logik `toggleCfCard`, app-analysis.js:588).
3. `CF_CARD_META` (app-hub.js:175): Eintrag für `cf-pattern` ergänzen (Format der vorhandenen Einträge übernehmen) — sonst fehlt die Karte im „Karten anpassen"-Menü und in applyClimateLayout.
4. app-analysis.js: `renderHourlyPattern()` — 24-Spalten-CSS-Grid (`style.gridTemplateColumns`), je Zelle Hintergrundfarbe aus Wert (Farbskalen-Muster: `tempToColor`, app-archive.js:255; für Feuchte eine Blau-Skala analog); Achsenbeschriftung Mo–So + 0/6/12/18 h; `title`-Tooltip je Zelle. Umschalter Temp/Feuchte: zwei Mini-Buttons `data-onclick="setPatternField|temp"` / `|humidity"` (globale Funktion, merkt Auswahl in appState, rendert neu). Aufruf aus `renderActiveView` (app-core.js:767), damit jeder Refresh aktualisiert.
5. `npm run build:css` (viele neue Klassen), CACHE_NAME-Bump.

**Abnahme:** Core-Tests grün; Karte rendert mit Demo-Daten (E2E-ClimateFlow läuft), klappt ein/aus, lässt sich über „Karten anpassen" ausblenden; keine NaN-Zellen (null → neutrale Zelle).

**Fallstricke:** renderActiveView läuft bei JEDEM Refresh — innerHTML-Ersatz muss idempotent sein. Mit nur 24 h Daten sind viele Zellen null — neutral rendern. Inline-`style`-Farben sind ok (style-src 'unsafe-inline'), Inline-EVENT-Handler nicht.

**Commit:** `Plan4-16: Wochen-Muster-Heatmap (Stunde x Wochentag) in ClimateFlow`

---

### Punkt 17: Jahresvergleich im Archiv-Chart

**Ziel:** Zwei Jahre übereinanderlegen (Tages-Mitteltemperatur), um Saisonverläufe zu vergleichen — die Daten liegen längst in climate_daily.

**Dateien:** `app-archive.js` (loadArchiveView:64, drawArchiveChart:355), `index.html` (Archiv-Kopfzeile), `lib/core.js` + `tests/core.test.js` (Mapping-Helfer), `tailwind.css`, `sw.js` (Bump).

**Schritte:**
1. VORHER prüfen, welche Zeilen loadArchiveView lädt (alle Tage des Standorts oder nur Zeitraum? GET-Parameter von /api/climate ansehen) — falls begrenzt, alle Jahre laden (Antwortgröße ist klein: 1 Zeile/Tag).
2. `lib/core.js`: `alignYearSeries(rows, year)` → sortiertes Array `{ md: 'MM-TT', t_avg }` für das Jahr (29.02. auslassen); Export + 2 Tests (Mapping, Schaltjahr).
3. index.html Archiv-Kopf: `<select id="archive-compare-year" data-onchange="setArchiveCompareYear|$value">` mit „Vergleich: aus" + Jahren (Optionen dynamisch in app-archive.js befüllen aus vorhandenen rows).
4. `drawArchiveChart`: bei gesetztem Vergleichsjahr zweite Chart.js-Serie (gleiche `md`-Kategorie-Achse, gestrichelt `borderDash: [4,4]`, halbtransparent) aus `alignYearSeries`; Legende „2026" / „2025". `setArchiveCompareYear(value)` (global): merkt Auswahl in appState, ruft drawArchiveChart neu.
5. `ensureChartJs` wird im Archiv-Chart-Pfad bereits verwendet (verifizieren — drawArchiveChart ist async).

**Abnahme:** Mit Daten aus 2 Jahren erscheinen 2 Linien (manuell bzw. Test-Fixture per API-Mock); Auswahl „aus" zeigt wie bisher 1 Linie; Tests grün.

**Fallstricke:** Beide Serien brauchen IDENTISCHE Label-Achse — Basisjahr bestimmt die Labels, Vergleichsjahr wird auf `md` gemappt (fehlende Tage = `null`, `spanGaps: true`). Chart-Instanz (appState.archiveChart) vor Neuzeichnen `destroy()` (bestehendes Muster übernehmen).

**Commit:** `Plan4-17: Jahresvergleich im Archiv-Chart (zweites Jahr als Overlay)`

---

### Punkt 18: GPX-Zielprognose („Erreiche ich mein Jahresziel?")

**Ziel:** Aus dem bisherigen Jahres-km-Stand hochrechnen, ob das Jahresziel erreichbar ist, und was pro Woche nötig wäre — im Viewer und auf der Hub-Kachel.

**Dateien:** `lib/core.js` (+ Export), `tests/core.test.js`, `gpx.js` (getGoals:476, renderGoalBar:499, renderSummary:510), `app-hub.js` (loadGpxWidget:10), `sw.js` (Bump), `tailwind.css`.

**Schritte:**
1. `lib/core.js`: `goalForecast({ goalKm, doneKm, now = new Date() })` → `null` wenn `goalKm <= 0` oder Jahrestag < 7; sonst `{ projectedKm, onTrack, requiredPerWeekKm }` mit `elapsed = Tag-des-Jahres / 365.25`, `projectedKm = doneKm / elapsed`, `requiredPerWeekKm = max(0, (goalKm − doneKm) / verbleibendeWochen)`, `onTrack = projectedKm >= goalKm`. Export + Tests: Jahresmitte 50 % → projected ≈ goal, onTrack; Rückstand → requiredPerWeek > 0; goalKm 0 → null.
2. `gpx.js` renderSummary: dort, wo der Jahres-Zielbalken gerendert wird (renderGoalBar-Aufruf mit yearKm), zusätzlich Prognosezeile in ein neues Element unter dem Balken: „Prognose: ~1.870 km · auf Kurs ✅" bzw. „· ~14 km/Woche nötig" (de-DE-Zahlformat). Element im gpx.html-Markup neben dem bestehenden Ziel-Label ergänzen (IDs des Zielbereichs vorher nachschlagen).
3. Hub: `loadGpxWidget` erweitert das vorhandene `hub-gpx-goal-label` um den Kurz-Zusatz „(auf Kurs)" / „(+14 km/Wo)" wenn Jahresziel gesetzt — Achtung: das Widget zeigt aktuell den WOCHEN-Fortschritt (prüfen!); die Prognose bezieht sich aufs Jahresziel → nur anzeigen, wenn `goals.yearKm > 0`.
4. Jahres-km (`doneKm`) aus der bestehenden Summenlogik (renderSummary berechnet km dieses Jahr — wiederverwenden, nicht neu berechnen).

**Abnahme:** Core-Tests grün; mit gesetztem Jahresziel erscheint die Prognose im Viewer und (gekürzt) auf der Hub-Kachel; Smoke grün (keine neuen Handler nötig, sonst global definieren).

**Fallstricke:** Anfang Januar ist die Hochrechnung Unsinn → der 7-Tage-Guard in der Core-Funktion ist Pflicht (Test dafür). gpx.js und app-hub.js laufen auf VERSCHIEDENEN Seiten — beide nutzen lib/core.js (überall eingebunden), keine Querimporte.

**Commit:** `Plan4-18: GPX-Zielprognose (goalForecast) im Viewer und Hub-Widget`

---

### Punkt 19: Persönliche Rekorde im GPX-Viewer

**Ziel:** „Längste Tour, meiste Höhenmeter, schnellster Schnitt, stärkste Woche" — automatisch aus den vorhandenen Aktivitäten, klickbar zur jeweiligen Tour.

**Dateien:** `lib/core.js` (+ Export), `tests/core.test.js`, `gpx.html` (Statistik-/Summary-Bereich), `gpx.js` (renderSummary:510, selectActivity:602), `tailwind.css`, `sw.js` (Bump).

**Schritte:**
1. VORHER das Aktivitäts-Objekt nachschlagen (gpx.js `activityToPayload`:197 + wie `state.activities` befüllt wird): exakte Feldnamen für Distanz, Bewegungszeit, Anstieg, Startzeit, id/uid.
2. `lib/core.js`: `personalRecords(activities)` — erwartet Array mit `{ id, name, startMs, distanceKm, movingSec, ascent }` (Adapter im Client baut das aus den echten Feldern); Rückgabe `{ longest, mostAscent, fastest, biggestWeek }`, jedes `{ value, id?, name?, label }` oder null; `fastest` = km/h aus distanz/movingSec nur für Touren ≥ 5 km; `biggestWeek` = Mo–So-Bucket mit größter km-Summe (`label` z. B. „KW ab 06.07.2026"). Export + Tests (Gewinner korrekt, <5-km-Ausschluss, leeres Array → alle null).
3. gpx.html: kleine Karte „🏆 Rekorde" im Summary-Bereich (`id="gpx-records"`, Platzierung neben der Gesamt-Statistik; Markup-Stil der Nachbarkarten).
4. gpx.js: `renderRecords()` — Adapter über `state.activities`, 4 Zeilen (Wert fett + Tourname), Klick auf Zeile → `selectActivity(id)` (JS-`onclick`-Zuweisung am erzeugten Element wie in renderActivityList — das ist erlaubt; nur HTML-ATTRIBUT-Handler sind verboten). Aufruf am Ende von renderSummary.

**Abnahme:** Core-Tests grün; Karte zeigt mit ≥ 1 Tour Rekorde, Klick öffnet die Tour; mit 0 Touren versteckt. Smoke/E2E (GPX-Test) grün; build:css.

**Fallstricke:** `biggestWeek` hat keine Einzeltour-id → nicht klickbar machen. movingSec = 0 (defekte Tour) → Division abfangen. Rekord-Berechnung bei jedem renderSummary ist billig (< 1000 Touren) — kein Caching nötig.

**Commit:** `Plan4-19: Persoenliche Rekorde im GPX-Viewer (personalRecords)`

---

## Phase D — Robustheit & Mobile-UX

### Punkt 20: Offline-Status sichtbar + Auto-Sync bei Netz-Rückkehr

**Ziel:** Offline ist ein erkennbarer Zustand (Banner) statt stiller Fehler; bei Rückkehr des Netzes synchronisiert die App sofort.

**Dateien:** `index.html` + `gpx.html` (Banner nach `<body>`), `shared.js`, `app-main.js` (Auto-Refresh), `gpx.js` (Sync-Hook), `tests/e2e.spec.js`, `tailwind.css`, `sw.js` (Bump).

**Schritte:**
1. Beide HTMLs, direkt nach `<body …>`: `<div id="offline-banner" class="hidden sticky top-0 z-[900] bg-amber-500/15 border-b border-amber-500/30 text-amber-200 text-xs text-center px-3 py-1.5">Offline — Daten können veraltet sein; Änderungen werden nachsynchronisiert.</div>`.
2. `shared.js`: `function updateOfflineBanner() { const el = document.getElementById('offline-banner'); if (el) el.classList.toggle('hidden', navigator.onLine); }` + Listener `window.addEventListener('online'/'offline', …)`; bei `online` zusätzlich `window.Store && Store.flush()` und `window.dispatchEvent(new CustomEvent('net-online'))`; initial einmal aufrufen (am Dateiende, nach der Delegation).
3. `app-main.js`: im Auto-Refresh-Intervall (startAutoRefresh aus P9) zu Beginn `if (!navigator.onLine) return;`; Listener `window.addEventListener('net-online', () => refreshVisibleView(true))` — `refreshVisibleView(silent)` = die bestehende Weiche aus dem Intervall (climate → reloadData(true), home → loadHubPreviews(true)) als eigene Funktion extrahieren und vom Intervall UND hier nutzen.
4. `gpx.js`: `window.addEventListener('net-online', () => syncWithCloud().catch(() => {}))`.
5. E2E: neuer Test — `context.setOffline(true)` nach dem Laden → Banner sichtbar; `setOffline(false)` → Banner verschwindet.

**Abnahme:** E2E grün (10 Tests); build:css; Banner stört das Layout nicht (sticky, schmal).

**Fallstricke:** `navigator.onLine` ist heuristisch (false = sicher offline, true = vielleicht) — Banner nur als Hinweis, KEINE Features deaktivieren. Der `online`-Listener in shared.js läuft auf beiden Seiten — gpx-spezifisches über das CustomEvent, nicht in shared.js verdrahten.

**Commit:** `Plan4-20: Offline-Banner + automatischer Sync bei Netz-Rueckkehr`

---

### Punkt 21: Datenauffrischung bei App-Rückkehr (visibilitychange)

**Ziel:** Wer die installierte PWA nach Stunden wieder öffnet, sieht frische Daten sofort — nicht erst beim nächsten Intervall-Tick.

**Dateien:** `app-main.js` (visibilitychange-Listener:367, reloadData-Aufrufer), `sw.js` (Bump).

**Schritte:**
1. `appState.lastDataAt = 0` (app-core.js appState): in `reloadData` (Erfolgspfad, nach renderActiveView) und in `loadHubPreviews` (nach renderBriefing) auf `Date.now()` setzen.
2. Den bestehenden visibilitychange-Listener (heute nur `Store.pull()`) erweitern: `if (document.visibilityState === 'visible') { Store.pull(); const maxAgeMs = getAppPrefs().refreshMin * 60 * 1000; if (Date.now() - appState.lastDataAt > maxAgeMs) refreshVisibleView(true); }` (refreshVisibleView aus Punkt 20).
3. Kommentar: kein Overlay (silent), kein Doppellauf — lastDataAt schützt.

**Abnahme:** Manuell: Tab > Intervall verstecken, zurückkehren → Netzwerk-Requests laufen, Werte aktualisieren sich still. lint/test/E2E grün.

**Fallstricke:** iOS feuert visibilitychange beim PWA-Wechsel zuverlässig, `focus` nicht — deshalb visibilitychange verwenden (ist schon so). Punkt setzt P9 (getAppPrefs) und P20 (refreshVisibleView) voraus — Reihenfolge einhalten.

**Commit:** `Plan4-21: Datenauffrischung bei Rueckkehr in die App (visibilitychange)`

---

### Punkt 22: Einheitliche Leere-/Fehlerzustände mit „Erneut versuchen"

**Ziel:** Fehlgeschlagene Widget-Loads enden nicht in totem „Lade …"-Text, sondern in einem klaren Zustand mit Retry-Aktion; leere Listen bekommen freundliche Hinweise.

**Dateien:** `shared.js` (Helfer), `app-hub.js` (loadHubForecast-catch:447-450, loadHubCalendar, renderTodos), `gpx.js` (renderActivityList:576 — Leerzustand prüfen), `tailwind.css`, `sw.js` (Bump).

**Schritte:**
1. `shared.js`: `function emptyStateHtml({ icon = 'inbox', text, actionLabel, actionFn })` → HTML-String: zentriertes lucide-Icon (text-slate-600), Text (text-xs text-slate-500), optional `<button data-onclick="${actionFn}" …>${actionLabel}</button>`. actionFn ist ein FUNKTIONSNAME (Delegation), kein Code.
2. `app-hub.js`: catch von loadHubForecast → `el.innerHTML = emptyStateHtml({ icon: 'cloud-off', text: 'Vorschau nicht verfügbar.', actionLabel: 'Erneut versuchen', actionFn: 'retryHubForecast' }); updateIcons();` + globale Funktion `function retryHubForecast() { loadHubForecast(); }`. Analog für den Kalender-FEHLERFALL (die vorhandenen sinnvollen Hinweistexte für „kein Kalender verbunden"/„Proxy fehlt" NICHT ersetzen) mit `refreshHubCalendar` (existiert bereits, app-core.js:386).
3. To-do-Widget: leere Liste (alle erledigt/keine) → kleiner Hinweis „Alles erledigt ✅" statt leerer Fläche (in renderTodos, nur Anzeige).
4. `gpx.js`: renderActivityList-Leerzustand ansehen; falls nur leer → Hinweis „Noch keine Touren — GPX-Datei hierher ziehen oder Aufnahme starten." ergänzen.
5. `updateIcons()` nach jedem emptyStateHtml-Einsatz; `npm run build:css`.

**Abnahme:** Mit blockierten APIs (DevTools) zeigen Forecast/Kalender Retry-Zustände, Klick lädt neu; Smoke grün (retryHubForecast global definiert); E2E grün.

**Fallstricke:** Der Smoke-Test parst data-onclick auch aus JS-Template-Strings NICHT (nur HTML-Dateien) — trotzdem Konvention einhalten; die Funktion MUSS auf window-Ebene existieren, sonst tut der Button nichts. Tailwind scannt JS-Strings → build:css Pflicht.

**Commit:** `Plan4-22: Einheitliche Leere- und Fehlerzustaende mit Retry-Aktion`

---

### Punkt 23: Touch-Ziele vergrößern + Safe-Area für die installierte PWA

**Ziel:** Kleine Icon-Buttons (Widget-Zahnräder, To-do-Aktionen) sind am Handy schwer zu treffen; auf iPhones ohne Home-Button klebt der Inhalt an der Gesten-Leiste.

**Dateien:** `tailwind.input.css`, `index.html`, `gpx.html` (viewport-Meta), `app-hub.js` (renderTodos-Buttons), `tailwind.css` (Rebuild), `sw.js` (Bump).

**Schritte:**
1. Beide HTMLs: viewport-Meta um `, viewport-fit=cover` ergänzen; `tailwind.input.css`: `body { padding-bottom: env(safe-area-inset-bottom); }`.
2. `tailwind.input.css`: Utility-Klassen
   `.tap-target { position: relative; } .tap-target::after { content: ''; position: absolute; inset: -8px; }`
   und `.tap-target-sm::after { inset: -4px; }` (für dicht stehende Button-Leisten).
3. `tap-target` auf die kleinen Buttons anwenden: Kalender-Widget `+`/Zahnrad (index.html:164-169), Widget-Grips, `toggleWidgetSettings`-Umgebung, Chart-Hilfsbuttons; in `renderTodos` (app-hub.js:248) die Zeilen-Buttons (Erledigen/Löschen/Bearbeiten — Markup dort ansehen) mit tap-target-sm; gpx.html-Kopfzeilen-Buttons prüfen (p-2.5 ≈ 40 px ist grenzwertig ok — nur echte < 32-px-Ziele anfassen).
4. To-do-Checkbox: falls `w-4 h-4` → auf `w-5 h-5` (in renderTodos-Markup).
5. `npm run build:css`; alle geänderten Stellen einmal durchklicken (Popover-Schließlogik in init prüft `closest('button[data-onclick=…]')` — durch ::after unverändert).

**Abnahme:** E2E grün (Klicks treffen weiter); manuelle Stichprobe am schmalen Viewport (DevTools iPhone-Preset): Buttons gut treffbar, kein horizontales Scrollen; installierte PWA respektiert Safe-Area (Sichtprüfung/Screenshot).

**Fallstricke:** ::after-Flächen können Nachbarn überlappen → bei Leisten die -sm-Variante; NIEMALS auf Elemente mit eigenem Kind-data-onclick (Fläche fängt Klicks des Nachbarn). tailwind.css committen.

**Commit:** `Plan4-23: Groessere Touch-Ziele + Safe-Area fuer die installierte PWA`

---

### Punkt 24: GPX-Viewer-Start beschleunigen (lokale Liste zuerst)

**Ziel:** Der GPX-Viewer zeigt die Tourenliste aus IndexedDB, ohne auf whoami/settings zu warten — Phase-A-Prinzipien auf die zweite Seite übertragen.

**Dateien:** `gpx.js` (init:1490, renderSummary:510, renderNoteAndWeather:635), `gpx.html` (nur falls Marker nötig), `sw.js` (Bump).

**Schritte:**
1. VORHER per grep prüfen, welche der früh laufenden Funktionen Store lesen: `grep -n "Store\." gpx.js` — bekannte Kandidaten: getGoals (476), getTypeHints (1027), saveNote/Notizen, Theme.
2. init umbauen:
   ```js
   const storeP = Store.init();
   await refreshActivities();            // IndexedDB, kein Netz
   if (state.activities.length > 0) selectActivity(state.activities[0].id);
   await storeP;                          // ab hier Store-abhängiges
   applyTheme(getTheme()); updateIcons();
   renderSummary();                       // Ziele-Balken jetzt korrekt
   syncWithCloud().then(…);               // wie bisher
   ```
   Dabei sicherstellen: alles, was VOR `await storeP` läuft, liest keinen Store (falls refreshActivities → renderSummary → getGoals kettet: renderSummary-Aufruf aus refreshActivities für den Erstlauf tolerieren — getGoals liefert dann Defaults — und nach storeP ERNEUT rendern; Kommentar dazu).
3. Theme: `applyTheme(getTheme())` fällt vor Store-ready auf rohes localStorage zurück (getTheme hat den Guard, shared.js:287-290) — darf also auch früh laufen; Reihenfolge so wählen, dass kein Theme-Flackern entsteht (Inline-Snippet deckt dark/light schon ab).
4. Vendor-defer für gpx.html ist in Punkt 4 erledigt — hier nur verifizieren (keine Doppelarbeit).

**Abnahme:** DevTools „Slow 3G": Tourenliste erscheint deutlich vor Abschluss der API-Calls (Netzwerk-Tab); GPX-E2E-Test grün; Ziele/Notizen korrekt nach Store-Init (Sichtprüfung).

**Fallstricke:** `checkRecordingRecovery`/`#record`-Autostart (1509-1527) NICHT vor refreshActivities ziehen (unverändert lassen). Wenn sich herausstellt, dass refreshActivities hart am Store hängt, den Punkt ehrlich reduzieren (nur Theme/Sync-Umstellung) und das im Commit-Text dokumentieren — keine riskanten Verrenkungen.

**Commit:** `Plan4-24: GPX-Viewer-Start beschleunigt (lokale Liste vor Cloud/Store)`

---

### Punkt 25: Abschluss — Doku, Roadmap, finale Verifikation

**Ziel:** Runde 4 sauber abschließen: Doku konsistent, alle Checks grün, Messbilanz final.

**Dateien:** `README.md`, `CLAUDE.md`, `PLAN4.md` (Statusblock), `docs/PERF.md`, ggf. `sw.js`.

**Schritte:**
1. README: Roadmap-Abschnitt um Runde 4 ergänzen (Phase-Stichpunkte wie bei Runde 3); Features dokumentieren (Karte „Verhalten & Anzeige", Digest-Konfiguration, Insights/Muster/Jahresvergleich, GPX-Prognose/Rekorde, Offline-Banner); Entwicklung: `npm run perf` erwähnen; Performance-Absatz mit PERF.md-Verweis (falls nicht schon aus Punkt 8).
2. CLAUDE.md: Dateiliste ergänzen (`scripts/perf-audit.mjs`, `docs/PERF.md`, `vendor/fonts/`); neue Regeln aufnehmen: (a) Pref-Keys app_prefs/chart_prefs/widget_prefs nur über die Getter mit Defaults-Merge, (b) Fonts sind lokal — nie wieder externe Font-/CSS-Links einführen (CSP verbietet sie jetzt), (c) `npm run perf` für Startzeit-relevante Änderungen.
3. `docs/PERF.md`: finalen Lauf eintragen (nach ALLEN Punkten, gleiche Bedingungen wie Baseline) — Tabelle Baseline → nach Phase A → final.
4. PLAN4.md-Statusblock oben auf „✅ vollständig umgesetzt" setzen (mit finalen Testzahlen und SW-Version) — bei Abweichungen/ausgelassenen Teilpunkten ehrlich auflisten.
5. Finale Verifikation: `npm run lint` (0 Fehler), `npm test`, `npm run test:e2e` (jetzt 10 Tests), `npm run build:css` + `git status` sauber (tailwind.css committet), CACHE_NAME-Endstand im README-Deploy-Abschnitt aktualisieren.

**Abnahme:** Alle Checks grün; Doku beschreibt den Ist-Zustand; PERF.md enthält die vollständige Messreihe.

**Commit:** `Plan4-25: Abschluss - Doku, Roadmap und finale Verifikation Runde 4`

---

## Abhängigkeiten zwischen den Punkten (für abweichende Reihenfolge)

- **P1 vor allen anderen** (Baseline). P2→P3 (initDone-Struktur). P6 vor P10 (ensureFullHistory). P8 vor P11 (getHubWeather-Signatur). P9 vor P10/P11/P21 (Pref-Getter-Muster/getAppPrefs). P20 vor P21 (refreshVisibleView).
- Phase C-Punkte sind untereinander unabhängig; P14/P16 profitieren von P6 (14-Tage-Daten), setzen es aber nicht voraus.
- Wer nur Teile umsetzt: Phase A komplett > alles andere.
