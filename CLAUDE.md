# Smart Home Hub — Projektkontext für Claude

Multi-Projekt-SPA auf Cloudflare Pages (statisch + Functions), Mehrbenutzer-Login via `functions/_middleware.js` (`AUTH_USER`/`AUTH_PASS` + `AUTH_USERS`) bzw. Cloudflare Access. Deploy: Push auf `main`. Alles Deutsch, Dark-Mode-Design (Tailwind, Glass-Panels).

## Profile & Einstellungs-Sync (WICHTIG)
- Jedes Login-Passwort = eigenes **Profil**. `settings-sync.js` stellt `Store` bereit: profilbezogene Schlüssel `p_<profil>_<key>` in localStorage + Spiegel nach D1 (`/api/settings`, Offline-Queue, `updatedAt`-Merge). `/api/whoami` liefert das aktive Profil.
- **Profilbezogene Einstellungen NIE roh über `localStorage` lesen/schreiben — immer `Store.get/set/getJSON/setJSON/remove`.** Gerätelokale Dinge (Dedupe-Zeitstempel `push_sent_*`, `gpx_pending_deletes`) bleiben bewusst bei rohem localStorage.
- `app.js`/`gpx.js` `init()` warten auf `await Store.init()`, bevor Einstellungen gelesen werden.

## Dateien & Zuständigkeiten
- `index.html` — nur Markup: Hub (`#home`), ClimateFlow (`#climate`), Einstellungen (`#settings`); Hash-Routing. ClimateFlow-Karten tragen `data-widget="cf-…"` (anpassbares Layout).
- `app.js` — Hub-/ClimateFlow-/Einstellungs-Logik: Charts inkl. Vergleich, Lüftungsberater + Erfolgskontrolle + Tagebuch (`ventilationStats`) + Trend (`trendForecast`), Schimmel/Komfort/Heiz/Frost/Hitze, Archiv + Rekorde (`climateRecords`), AQI, dynamische Standort-Tabs (`renderLocationTabs`), Hub-Widgets (To-do 2.0, Kalender via `expandRecurring`, 3-Tage-Wetter), Benachrichtigungs-Center (`notify_rules`), Onboarding, `createLayout`-Factory (Hub + ClimateFlow), Health-Ansicht.
- `gpx.html` + `gpx.js` — GPX-Viewer (IndexedDB v2, Leaflet, Cloud-Sync, Ziele `gpx_goals`, Streaks, Heatmap, Bestzeiten via `routeCells`, Segmentvergleich `compareTracks`, Auto-Typ-Lernen `gpx_type_hints`, Notiz + Start-Wetter, Export).
- `lib/core.js` — getestete DOM-freie Kernlogik (UMD): Magnus, `processRawFeeds`, `comfortScore`, `detectVentilationEvents`, `ventilationStats`, `climateRecords`, `trendForecast`, `heatingDemandIndex`, `forecastExtremes`, `parseIcsEvents` + `expandRecurring` (RRULE), GPX: `computeStats`, `segmentSpeeds`, `routeCells`/`routeSimilarity`, `compareTracks`, `computeStreaks`, `buildGpxXml`.
- `shared.js` — `updateIcons`, Formatierer, `showToast`, `apiFetch` (`err.unavailable` bei 404/503/405 → Fallback), `sendPush`, `downloadCsv`, Fehler-Reporting (respektiert `notify_rules.errors`).
- `settings-sync.js` — `Store` (Profil + D1-Sync). Wird VOR app.js/gpx.js geladen.
- `functions/_auth.js` — Nutzerliste/Identität; `functions/_notify.js` — Push-Verteiler (Profile+Regeln aus D1, Ruhezeiten `Europe/Berlin`, per-Profil-Dedupe, Fallback `NTFY_TOPIC`).
- `functions/api/` — `whoami`, `settings` (D1 `user_settings`), `feeds/[locId]` (Proxy, löst auch D1-`locations`), `gpx`, `climate`, `todos`, `locations` (Admin), `health`, `error-log`, `ical`, `config`, `check-alerts`/`weekly-report`/`monthly-report` (Cron). D1-Binding `DB`, Schema zur Laufzeit. Magnus-/Komfort-Formeln dort bewusst inline dupliziert — bei Formel-Änderungen beide Stellen anfassen.
- `tests/core.test.js` + `tests/smoke.test.js` — `npm test`; Smoke-Test prüft ID-/Handler-/Dateiverweise über alle Seiten.
- `tailwind.css` — GEBAUT, nie von Hand editieren.

## Nicht-offensichtliche Regeln
1. **Nach jeder Klassen-Änderung in HTML/app.js/gpx.js/shared.js:** `npm run build:css` und `tailwind.css` mitcommitten (Tailwind scannt auch JS-Template-Strings).
2. **Bei Änderungen an gecachten Dateien:** `CACHE_NAME` in `sw.js` hochzählen (aktuell `smarthub-v9`; Shell-Liste dort pflegen).
3. **Profilbezogene Einstellungen** immer über `Store` (siehe oben), nie roh.
4. **ThingSpeak-Daten:** Komma-Dezimal, Felder asynchron (field1=Temp, field2=Feuchte). Immer über `processRawFeeds`; nie annehmen, dass ein Eintrag beide Felder hat.
5. **Open-Meteo:** immer `timeformat=unixtime`; `past_days=7&forecast_days=2` für Chart + Prognose.
6. **GPX-Sync:** Identität `uid`, Konflikt `updatedAt`, Löschungen als Tombstones + Queue `gpx_pending_deletes`. Punkte auf max. 5000 downsamplen.
7. **Serverseitige Warnungen** laufen über `_notify.js` (pro Profil). Neuer Warntyp → in `DEFAULT_RULES` (core-Regeln), `NOTIFY_TYPES` (app.js UI) und den auslösenden Endpunkt eintragen.
8. Commits/Pushes direkt auf `main` sind gewollt (Auto-Deploy). Commit-Messages ohne Umlaute via `-F <datei>` (PowerShell-Quoting!).

## Kanäle (Referenz)
- Gillian: ThingSpeak 3417815, Default Stuttgart (48.7758, 9.1829)
- Sean: ThingSpeak 3417935, Default Berlin (52.52, 13.405)
