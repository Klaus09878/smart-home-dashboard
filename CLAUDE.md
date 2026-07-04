# Smart Home Hub — Projektkontext für Claude

Multi-Projekt-SPA auf Cloudflare Pages (statisch + Functions), Basic Auth via `functions/_middleware.js` (`AUTH_USER`/`AUTH_PASS`). Deploy: Push auf `main`. Alles Deutsch, Dark-Mode-Design (Tailwind, Glass-Panels).

## Dateien & Zuständigkeiten
- `index.html` — nur Markup: Hub-Homescreen (`#home`) + ClimateFlow-Dashboard (`#climate`, Hash-Routing)
- `app.js` — gesamte Hub-/ClimateFlow-Logik (appState, fetchFeeds, Charts inkl. Vergleichsmodus, Lüftungsberater + Erfolgskontrolle, Schimmelrisiko, Komfort-Score, Heizindikator, Frost-/Hitzewarnung, Prognose, Archiv-Ansicht, CSV-Export, Hub-Widgets, ntfy-Client). Schwellwerte pro Standort in localStorage `loc_thresholds_<locId>` (Defaults in `THRESHOLD_DEFAULTS`)
- `gpx.html` + `gpx.js` — GPX-Viewer, eigenständige Seite (Logik in gpx.js: IndexedDB `smarthub`/`gpx-activities` v2, Leaflet, Cloud-Sync, Backup, Tempo-Färbung, Vergleich, Ziele `gpx_goals`, Kalender/Streaks, Heatmap, Bestzeiten via routeCells, Notiz + Start-Wetter, GPX-Export)
- `lib/core.js` — getestete DOM-freie Kernlogik (UMD): Magnus-Formeln, `processRawFeeds` (Forward-Fill + Stale-Trim), `haversine`, `computeStats`, `guessType`, `downsamplePoints`
- `shared.js` — `updateIcons`, Formatierer, `showToast`, `apiFetch` (wirft `err.unavailable` bei 404/503 → Aufrufer fallen auf Direktzugriff/lokal zurück), `sendPush` (ntfy)
- `functions/api/` — `feeds/[locId].js` (ThingSpeak-Proxy, Env `TS_KEY_GILLIAN`/`TS_KEY_SEAN`), `gpx.js` (D1-CRUD mit Tombstones/`updated_at`), `climate.js` (Tages-Aggregate), `check-alerts.js` (ntfy: Sensor/Schimmel/Frost, Env `NTFY_TOPIC`), `weekly-report.js` (ntfy-Wochenbericht aus D1); D1-Binding heißt `DB`, Schema wird zur Laufzeit angelegt. Magnus-/Komfort-Formeln sind dort bewusst inline dupliziert (UMD aus lib/core.js nicht importierbar) — bei Formel-Änderungen beide Stellen anfassen
- `tests/core.test.js` + `tests/smoke.test.js` — `npm test` (muss vor jedem Push grün sein); der Smoke-Test prüft ID-/Handler-/Dateiverweise über alle Seiten — neue getElementById/onclick-Bezüge fallen dort auf
- `tailwind.css` — GEBAUT, nie von Hand editieren

## Nicht-offensichtliche Regeln
1. **Nach jeder Klassen-Änderung in HTML/app.js/shared.js:** `npm run build:css` ausführen und `tailwind.css` mitcommitten (Tailwind scannt auch JS-Template-Strings).
2. **Bei Änderungen an gecachten Dateien:** `CACHE_NAME` in `sw.js` hochzählen (Shell-Liste dort pflegen).
3. **ThingSpeak-Daten:** Werte kommen teils mit Komma-Dezimal, Felder asynchron (field1=Temp, field2=Feuchte, iPhone-Kurzbefehle). Immer über `processRawFeeds` gehen; nie annehmen, dass ein Eintrag beide Felder hat.
4. **Open-Meteo:** immer `timeformat=unixtime` (Epoch), sonst Zeitzonen-Bugs; `past_days=7&forecast_days=2` nötig für Chart + Prognose.
5. **GPX-Sync:** Identität über `uid`, Konfliktlösung über `updatedAt`, Löschungen als Tombstones (`deleted=1`) + lokale Queue `gpx_pending_deletes` in localStorage. Punkte auf max. 5000 downsamplen.
6. **Fallback-Keys:** `LOCATIONS[].thingspeakUrl` in app.js enthält Read-Keys als Übergangslösung; nach Aktivierung des Proxys (Env-Vars gesetzt) Fallback + Keys entfernen (README Schritt 5).
7. Commits/Pushes direkt auf `main` sind hier gewollt (Auto-Deploy). Commit-Messages ohne Umlaute-Probleme via `-F <datei>` (PowerShell-Quoting!).

## Kanäle (Referenz)
- Gillian: ThingSpeak 3417815, Default Stuttgart (48.7758, 9.1829)
- Sean: ThingSpeak 3417935, Default Berlin (52.52, 13.405)
