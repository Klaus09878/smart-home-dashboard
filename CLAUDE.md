# Smart Home Hub — Projektkontext für Claude

Multi-Projekt-SPA auf Cloudflare Pages (statisch + Functions), Mehrbenutzer-Login via `functions/_middleware.js`: Session-Cookie vom Login-Screen `login.html` (Plan5-5, HMAC; optional Env-Var `SESSION_SECRET`), Basic Auth (`AUTH_USER`/`AUTH_PASS` + `AUTH_USERS`) bleibt API-/Übergangs-Fallback, alternativ Cloudflare Access. Deploy: Push auf `main`. Alles Deutsch, Dark-Mode-Design (Tailwind, Glass-Panels) mit gepflegtem hellem Modus (`html.light`-Remaps in `tailwind.input.css`).

**Pläne:** Runde 1, `PLAN2.md`, `PLAN3.md`, `PLAN4.md` und `PLAN5.md` (Nutzer-Feedback-Runde) sind vollständig umgesetzt — Arbeitsweise für künftige Runden: ein Punkt = ein Commit mit Prefix `PlanN-M:`, Arbeitsregeln am Anfang der jeweiligen Plandatei.

## Profile & Einstellungs-Sync (WICHTIG)
- Jedes Login-Passwort = eigenes **Profil**. `settings-sync.js` stellt `Store` bereit: profilbezogene Schlüssel `p_<profil>_<key>` in localStorage + Spiegel nach D1 (`/api/settings`, Offline-Queue, `updatedAt`-Merge). `/api/whoami` liefert das aktive Profil.
- **Profilbezogene Einstellungen NIE roh über `localStorage` lesen/schreiben — immer `Store.get/set/getJSON/setJSON/remove`.** Gerätelokale Dinge (Dedupe-Zeitstempel `push_sent_*`, `gpx_pending_deletes`) bleiben bewusst bei rohem localStorage.
- `app.js`/`gpx.js` `init()` warten auf `await Store.init()`, bevor Einstellungen gelesen werden.

## Dateien & Zuständigkeiten
- `index.html` — nur Markup: Hub (`#home`), ClimateFlow (`#climate`), Einstellungen (`#settings`); Hash-Routing. ClimateFlow-Karten tragen `data-widget="cf-…"` (anpassbares Layout).
- `app-*.js` — Hub-/ClimateFlow-/Einstellungs-Logik, aus dem früheren `app.js` in sechs **klassische Skripte** zerlegt (Plan2-9): `app-core.js` (Konfiguration, Datenladen, Wetter/AQI, KPIs, Lüftungsberater), `app-analysis.js` (Komfort-Score, Lüftungsstatistik, Frost/Hitze, Chart, Vergleich), `app-archive.js` (Langzeit-Archiv, Rekorde, Heatmap, ntfy/Web-Push, CSV), `app-hub.js` (Hub-Widgets, `createLayout`-Factory, To-dos, Wetter, Kalender), `app-settings.js` (Einstellungen, `NOTIFY_TYPES`, Backup, Health, Onboarding), `app-main.js` (Hash-Routing, Status-Briefing, `init` — lädt ZULETZT). Kein Bundler: gemeinsamer globaler Scope, Reihenfolge in `index.html` = ursprüngliche Dateireihenfolge. **Beim Verschieben von Code die Ladereihenfolge beachten** (Top-Level-Aufrufe wie `createLayout` müssen vor ihrer Nutzung definiert sein).
- `gpx.html` + `gpx.js` — GPX-Viewer (IndexedDB v2, Leaflet, Cloud-Sync, Ziele `gpx_goals`, Streaks, Heatmap, Bestzeiten via `routeCells`, Segmentvergleich `compareTracks`, Auto-Typ-Lernen `gpx_type_hints`, Notiz + Start-Wetter, Export).
- `lib/core.js` — getestete DOM-freie Kernlogik (UMD): Magnus, `processRawFeeds`, `comfortScore`, `detectVentilationEvents`, `ventilationStats`, `climateRecords`, `trendForecast`, `heatingDemandIndex`, `forecastExtremes`, `parseIcsEvents` + `expandRecurring` (RRULE), GPX: `computeStats`, `segmentSpeeds`, `routeCells`/`routeSimilarity`, `compareTracks`, `computeStreaks`, `buildGpxXml`.
- `shared.js` — `updateIcons`, Formatierer, `showToast`, `apiFetch` (`err.unavailable` bei 404/503/405 → Fallback), `sendPush`, `downloadCsv`, Fehler-Reporting (respektiert `notify_rules.errors`).
- `settings-sync.js` — `Store` (Profil + D1-Sync). Wird VOR app.js/gpx.js geladen.
- `functions/_auth.js` — Nutzerliste/Identität, Credential-Check (Env + D1/PBKDF2), Session-Cookies (`createSessionCookie`/`sessionUserFromCookie`), Brute-Force-Zähler; `functions/_notify.js` — Push-Verteiler (Profile+Regeln aus D1, Ruhezeiten `Europe/Berlin`, per-Profil-Dedupe, Fallback `NTFY_TOPIC`).
- `login.html` + `login.js` — öffentlicher Login-Screen (Plan5-5), bewusst eigenständig (kein shared.js/Store); öffentliche Pfade stehen in `_middleware.js` (`PUBLIC_PATHS`/`PUBLIC_PREFIXES`). Das Inline-Theme-Snippet MUSS byte-identisch zu index.html/gpx.html sein (CSP-Hash, Smoke-Test prüft das).
- `functions/api/` — `whoami` (liefert auch `source: env|d1`), `login` (Session-Cookie), `logout` (löscht Cookie), `settings` (D1 `user_settings`), `feeds/[locId]` (Proxy, löst auch D1-`locations`), `gpx`, `climate`, `todos`, `users` (Admin + Self-Service-Passwortwechsel, Plan5-7), `locations` (Admin), `health`, `error-log`, `ical`, `config`, `check-alerts`/`weekly-report`/`monthly-report` (Cron). D1-Binding `DB`, Schema zur Laufzeit. Magnus-/Komfort-Formeln dort bewusst inline dupliziert — bei Formel-Änderungen beide Stellen anfassen.
- `tests/core.test.js` + `tests/smoke.test.js` — `npm test`; Smoke-Test prüft ID-/Handler-/Dateiverweise über alle Seiten. `tests/e2e.spec.js` (Playwright, `npm run test:e2e`) läuft separat, nicht im Deploy-Build.
- `scripts/perf-audit.mjs` (`npm run perf`) — misst den mobilen Erststart (Fast-3G/CPU-4x, gemockte APIs, MutationObserver-Reveal); Ergebnisse + Methodik in `docs/PERF.md`.
- `vendor/fonts/outfit-*.woff2` — lokale Outfit-Schrift (`@font-face` in `tailwind.input.css`).
- Dialoge über `modalPrompt`/`modalConfirm` (shared.js), nie `prompt()`/`confirm()`. Theme via `applyTheme`/`getTheme` (raw `localStorage.theme` + profilbezogen im Store). Icon-Buttons brauchen nur `title` — `updateIcons` setzt `aria-label` automatisch.
- `tailwind.css` — GEBAUT, nie von Hand editieren.

## Nicht-offensichtliche Regeln
1. **Nach jeder Klassen-Änderung in HTML/app.js/gpx.js/shared.js:** `npm run build:css` und `tailwind.css` mitcommitten (Tailwind scannt auch JS-Template-Strings).
2. **Bei Änderungen an gecachten Dateien:** `CACHE_NAME` in `sw.js` hochzählen (aktuell `smarthub-v74`; Shell-Liste dort pflegen).
3. **Profilbezogene Einstellungen** immer über `Store` (siehe oben), nie roh. Die Pref-Bündel `app_prefs`, `chart_prefs`, `widget_prefs` (Plan4-9/10/11) NUR über ihre Getter `getAppPrefs()` / `getChartPrefs()` / `getWidgetPrefs()` lesen — die mergen die Defaults, damit neue Schlüssel abwärtskompatibel bleiben.
4. **ThingSpeak-Daten:** Komma-Dezimal, Felder asynchron (field1=Temp, field2=Feuchte). Immer über `processRawFeeds`; nie annehmen, dass ein Eintrag beide Felder hat.
5. **Open-Meteo:** immer `timeformat=unixtime`; `past_days=7&forecast_days=2` für Chart + Prognose.
6. **GPX-Sync:** Identität `uid`, Konflikt `updatedAt`, Löschungen als Tombstones + Queue `gpx_pending_deletes`. Punkte auf max. 5000 downsamplen.
7. **Serverseitige Warnungen** laufen über `_notify.js` (pro Profil). Neuer Warntyp → in `DEFAULT_RULES` (core-Regeln), `NOTIFY_TYPES` (app.js UI) und den auslösenden Endpunkt eintragen.
8. Commits/Pushes direkt auf `main` sind gewollt (Auto-Deploy). Commit-Messages ohne Umlaute via `-F <datei>` (PowerShell-Quoting!).
9. **Schriften sind lokal** (`vendor/fonts`, Plan4-4) — NIE wieder externe Font-/CSS-Links einbauen: die CSP erlaubt `style-src`/`font-src` nur noch `'self'`, und externe Fonts blockieren den ersten Paint.
10. **Startzeit-relevante Änderungen** (init-Reihenfolge, `<head>`, Service Worker) mit `npm run perf` vorher/nachher belegen; Methodik und Messwerte in `docs/PERF.md`. Faustregel aus Runde 4: das Render-Gerüst darf NIE auf einen `await` warten — `renderRoute()` läuft vor allem anderen, Datenlader erst nach `appState.initDone`.

## Kanäle (Referenz)
- Gillian: ThingSpeak 3417815, Default Stuttgart (48.7758, 9.1829)
- Sean: ThingSpeak 3417935, Default Berlin (52.52, 13.405)
