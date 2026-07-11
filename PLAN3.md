# Umsetzungsplan Runde 3 — 10 Punkte

Für die schrittweise Umsetzung durch ein KI-Modell (oder einen Menschen) geschrieben:
pro Punkt Ziel, Dateien mit Funktionsankern, konkrete Schritte, Abnahme und Fallstricke.
**Ein Punkt = ein Commit** (Prefix `Plan3-N:`), direkt auf `main` (Auto-Deploy, Projektregel 8).

## Arbeitsregeln (gelten für JEDEN Punkt)

1. Vor jedem Commit: `npm run lint` (0 Fehler) und `npm test` (Core + WebPush + API + Smoke) müssen grün sein; bei UI-/Endpunkt-Änderungen zusätzlich `npm run test:e2e`.
2. Die App-Logik liegt in **sechs klassischen Skripten** `app-core/analysis/archive/hub/settings/main.js` (gemeinsamer globaler Scope, Reihenfolge in index.html = Ladereihenfolge, `app-main.js` zuletzt). Es gibt KEIN `app.js` mehr. Neue Funktionen in die thematisch passende Datei; Top-Level-Aufrufe müssen nach ihrer Definition liegen.
3. Event-Handler NIE inline (`onclick=` bricht die CSP) — immer `data-onclick="fn|arg"` / `data-onchange` / … (Delegation in shared.js; `$value`, `$checked`, `$event` als Sonderargumente). Der Smoke-Test erzwingt das.
4. Nach Klassen-Änderungen in HTML/app-*.js/gpx.js/shared.js: `npm run build:css`, `tailwind.css` mitcommitten. Bei Änderungen an APP_SHELL-Dateien: `CACHE_NAME` in sw.js hochzählen (aktuell `smarthub-v34`).
5. Profilbezogene Einstellungen NUR über `Store.*`; gerätelokales (Dedupe, Aufnahme-Puffer) bewusst roh in localStorage.
6. Neuer Warntyp IMMER an 3 Stellen (`DEFAULT_RULES` in functions/_notify.js, `NOTIFY_TYPES` + `NOTIFY_DEFAULTS` in app-settings.js, auslösender Endpunkt) UND die E2E-Regelanzahl in tests/e2e.spec.js anpassen (aktuell 11; Punkt 4 → 12, Punkt 5 → 13 — Reihenfolge beachten oder Zahl je nach Umsetzungsstand setzen).
7. Neue externe CLIENT-Fetch-Ziele in `_headers` unter `connect-src`; das Inline-Theme-Snippet nie ändern, ohne den CSP-Hash neu zu berechnen (Smoke-Test prüft beides).
8. DOM-freie Logik nach `lib/core.js` (UMD-Muster) mit Tests in tests/core.test.js; Server-Endpunkt-Logik mit Tests in tests/api.test.js (D1-Adapter `tests/helpers/d1-node.js`; Node ≥ 22).
9. Formeln sind bewusst dupliziert (lib/core.js ↔ functions/) — bei Änderungen beide Stellen.
10. Commit-Messages ohne Umlaute, via `git commit -F <datei>`.

---

## Phase A — Bestehendes vervollständigen

### Punkt 1: R2-Backup wiederherstellen (Restore für den D1-Dump)

**Ziel:** Plan2-2 schreibt wöchentliche D1-Dumps nach R2 — aber es gibt keinen Weg zurück. Ohne Restore ist das Backup nur halb fertig.

**Dateien:** `functions/api/backup-dump.js`, `app-settings.js`, `index.html` (Daten-Karte), `tests/api.test.js`, `tests/helpers/d1-node.js` (R2-Mock), `sw.js` (Bump).

**Schritte:**
1. `backup-dump.js` erweitern (alles Admin-only: `identify(request, env)` → `isAdmin`, sonst 403 — der Dump enthält Daten ALLER Profile):
   - `GET ?list=1` → `{ dumps: [{ key, date, size }] }` aus `env.MEDIA.list({ prefix: 'backup/d1-' })`.
   - `POST` mit Body `{ key, confirm, tables? }` → Dump aus R2 lesen, je Tabelle `INSERT OR REPLACE` aller Zeilen (Spaltennamen aus `Object.keys(row)`); `tables` optional als Filterliste. Sicherung: `confirm` MUSS exakt dem `key` entsprechen, sonst 400. Vorher `ensureSchema`-Aufrufe nicht nötig — `CREATE TABLE IF NOT EXISTS` je Zieltabelle mit dem bekannten Schema der Quell-Endpunkte übernehmen (settings/todos/climate/gpx/locations/push_subscriptions/app_config kopieren die CREATE-Statements aus den jeweiligen Endpunkten).
   - Antwort: `{ ok, restored: { tabelle: zeilen } }`.
2. `tests/helpers/d1-node.js`: einfachen R2-Mock ergänzen — `createR2()` mit Map-basiertem `put/get/list/delete` (get liefert `{ body, text(), json() }`-ähnliches Objekt; `list` mit `prefix`-Filter, Objekte `{ key, size, uploaded }`).
3. `tests/api.test.js`: Dump erzeugen (GET auf backup-dump mit befüllter D1) → zweite leere D1 → POST-Restore → Zeilen identisch; falscher `confirm` → 400; Nicht-Admin → 403.
4. Admin-UI (app-settings.js, Karte „Daten & Widgets"): Abschnitt „Server-Backups (R2)" — Liste der Dumps (`GET ?list=1`, best effort verstecken bei 503/403), je Dump Button „Wiederherstellen" → `modalConfirm` mit deutlicher Warnung („überschreibt Server-Daten ALLER Profile") → zweite Bestätigung via `modalPrompt` („Zum Bestätigen den Dateinamen eintippen") → POST. Danach `location.reload()`.

**Abnahme:** API-Tests grün (Roundtrip Dump→Restore); UI zeigt Dumps nur für Admin.

**Fallstricke:** `INSERT OR REPLACE` mit dynamischen Spalten: Platzhalter aus `Object.keys(row)` bauen (`INSERT OR REPLACE INTO t (a,b) VALUES (?,?)`) — Spaltennamen gegen `/^[a-z_]+$/i` validieren (kein SQL-Injection-Vektor aus dem Dump). Große gpx-Zeilen einzeln inserten, nicht batchen.

**Commit:** `Plan3-1: R2-Dump-Restore (Liste, POST mit Doppelbestaetigung, Tests)`

---

### Punkt 2: Warnungs-Protokoll (alert_log) + Anzeige in der System-Diagnose

**Ziel:** „Habe ich gestern eine Warnung bekommen?" ist heute nicht beantwortbar — versendete Pushes werden nirgends protokolliert.

**Dateien:** `functions/_notify.js`, `functions/api/check-alerts.js` (Hygiene), `functions/api/health.js`, `app-settings.js` (Health-Ansicht), `tests/api.test.js`.

**Schritte:**
1. `_notify.js`, in `dispatch()` (Zeile ~133): nach jedem erfolgreichen Versand best effort in D1 loggen — Tabelle `alert_log (ts INTEGER, profile TEXT, type TEXT, slug TEXT, title TEXT)` (`CREATE TABLE IF NOT EXISTS` + INSERT in try/catch; env.DB kann fehlen).
2. `check-alerts.js`, D1-Hygiene-Block: `DELETE FROM alert_log WHERE ts < ?` (älter als 60 Tage).
3. `health.js` (voller Pfad, nicht `?quick`): letzte 15 Einträge aus `alert_log` als `out.alerts` mitliefern (try/catch, Tabelle evtl. leer).
4. Health-Ansicht (app-settings.js, `loadHealth()`): Abschnitt „Letzte Warnungen" — Zeitpunkt (`formatRelativeTime`), Typ-Label (aus `NOTIFY_TYPES`), Titel, Profil. Leer → „Noch keine Warnungen protokolliert."
5. Test (api.test.js): dispatch-Pfad indirekt über check-alerts zu testen ist schwer (externe Fetches) — stattdessen `_notify` direkt laden und `dispatch` mit einem Fake-Recipient (ntfy-Fetch via global `fetch`-Stub auf 200) gegen die Test-D1 laufen lassen; danach `SELECT COUNT(*) FROM alert_log` = 1.

**Abnahme:** Test grün; Health-Ansicht rendert die Liste (leerer Zustand ohne Fehler).

**Fallstricke:** `dispatch` läuft pro Empfänger×Typ — nur bei tatsächlichem Versand loggen (dort, wo auch der Dedupe-Zeitstempel gesetzt wird), nicht bei unterdrückten. Der globale `fetch`-Stub im Test muss nach dem Test zurückgesetzt werden.

**Commit:** `Plan3-2: alert_log Protokoll + Letzte Warnungen in der Diagnose`

---

### Punkt 3: Dynamische Standorte bearbeiten (PUT) — Verwaltung komplettieren

**Ziel:** `locations.js` kann GET/POST/DELETE, aber kein Bearbeiten — Tippfehler im Kanal/Feld-Schema erzwingen Löschen+Neuanlegen (und DELETE räumt evtl. Altdaten nicht auf; prüfen).

**Dateien:** `functions/api/locations.js`, `app-settings.js` (Standort-Karten), `tests/api.test.js`, `sw.js` (Bump).

**Schritte:**
1. `locations.js` lesen; `PUT` ergänzen: Body `{ id, name?, channel?, read_key?, lat?, lon?, fields? }` — nur übergebene Felder per `COALESCE`-UPDATE ändern (Muster: gpx.js-PUT); `read_key` leer lassen = unverändert. Admin-only wie POST/DELETE.
2. DELETE prüfen: räumt es `climate_daily`- und `app_config`-Zeilen (`weather_<id>`) des Standorts auf? Falls nein: ergänzen (try/catch, best effort).
3. Client (app-settings.js, Standort-Karten in `renderSettings`): für dynamische Standorte (nicht gillian/sean — erkennbar an `loc.dynamic` bzw. daran, wie `loadDynamicLocations` sie markiert; VOR dem Bauen nachschlagen) zwei Admin-Buttons „Bearbeiten" (modalPrompt mit vorbelegten Feldern, Read-Key-Feld leer = behalten) und „Löschen" (modalConfirm mit Hinweis auf Archivdaten).
4. Tests: PUT ändert nur übergebene Felder; PUT/DELETE ohne Admin → 403; DELETE entfernt climate_daily-Zeilen des Standorts.

**Abnahme:** Tests grün; Bearbeiten-Dialog ändert Name/Kanal ohne Neuanlegen.

**Fallstricke:** `fields`-JSON validieren (JSON.parse in try/catch, nur bekannte Schlüssel temp/humidity/extra übernehmen). Nach PUT clientseitig `loadDynamicLocations()` + `initConfigs()` + `renderSettings()` neu ausführen.

**Commit:** `Plan3-3: Standorte bearbeiten (PUT) + sauberes Loeschen inkl. Altdaten`

---

## Phase B — Neue Klima-Intelligenz

### Punkt 4: „Fenster offen vergessen?"-Erkennung

**Ziel:** Ein schneller, anhaltender Temperatursturz ohne Erholung = offenes Fenster. Bisher merkt das niemand, bis der Raum kalt ist.

**Dateien:** `lib/core.js` + `tests/core.test.js`, `functions/api/check-alerts.js`, `functions/_notify.js`, `app-settings.js` (NOTIFY_TYPES/DEFAULTS), `app-main.js` (Briefing), `tests/e2e.spec.js` (Regelanzahl), `sw.js` (Bump).

**Schritte:**
1. `lib/core.js`: `detectOpenWindow(aligned, opts = {})` — Eingabe wie von `processRawFeeds` (Einträge `{ time: Date, temp }`). Logik: betrachte die letzten `windowMin` (Default 45) Minuten; wenn `temp` in dieser Spanne um mehr als `dropC` (Default 2.5 °C) gefallen ist UND der letzte Wert nicht mehr als 0.3 °C über dem Minimum der Spanne liegt (keine Erholung → Fenster wohl noch offen) UND der letzte Messwert jünger als 20 min ist → `{ open: true, dropC, sinceMs }`, sonst `{ open: false }`. Export + 3 Tests (klarer Sturz ohne Erholung → true; Sturz mit Erholung (Stoßlüften) → false; stale Daten → false).
2. Warnregel `window` an den 3 Pflichtstellen: `DEFAULT_RULES.window = { on: true, dedupeH: 3 }`; `NOTIFY_TYPES` → `{ key: 'window', label: 'Fenster offen vergessen', icon: 'door-open' }`; `NOTIFY_DEFAULTS.types.window = { on: true }`.
3. `check-alerts.js`: pro Standort aus den bereits geladenen `feeds` eine kompakte Temperatur-Serie der letzten ~90 min bauen (`created_at` + `tempField`, Komma-Dezimal wie `lastRealValue`) und die Erkennung INLINE nachbilden (Projektregel: Formeln bewusst dupliziert; Kommentar auf lib/core.js als Quelle). Bei Treffer `dispatch(env, recipients, 'window', locId, …)` mit Grad-Angabe.
4. Briefing (app-main.js, Standort-Schleife in `loadHubPreviews`): `detectOpenWindow(processed.aligned)` → `warn`-Signal „Fenster offen? −X °C in 45 min (Name)".
5. E2E-Regelanzahl 11 → 12.

**Abnahme:** Core-Tests grün; E2E grün; Signal erscheint bei künstlicher Sturz-Serie (im Test der Core-Funktion abgedeckt).

**Fallstricke:** Heiz-Aus/Nacht senkt Temperatur LANGSAM — die Schwelle (2.5 °C in 45 min) ist bewusst steil; nicht „intelligenter" machen. Stoßlüft-Ereignisse (kurzer Sturz + Erholung) dürfen NICHT feuern — dafür ist die Erholungs-Bedingung da; Test dafür ist Pflicht.

**Commit:** `Plan3-4: Fenster-offen-Erkennung (detectOpenWindow, Regel window)`

---

### Punkt 5: Morgen-Digest als Push (opt-in)

**Ziel:** Ein Push am Morgen mit dem Tagesüberblick: Wetter, fällige To-dos, Klima-Status, optional Termine — statt vieler Einzelmeldungen.

**Dateien:** `functions/api/check-alerts.js`, `functions/_notify.js`, `app-settings.js`, `tests/e2e.spec.js`, `sw.js` (Bump).

**Schritte:**
1. Regel `digest` (3 Stellen): `DEFAULT_RULES.digest = { on: false, dedupeH: 20 }` (opt-in); `NOTIFY_TYPES` → `{ key: 'digest', label: 'Morgen-Digest (Tagesueberblick)', icon: 'sunrise' }`; Defaults `{ on: false }`.
2. `check-alerts.js`, NACH der Standort-Schleife (Muster: To-do-Block): nur im Berlin-Fenster 6–9 Uhr (`Intl.DateTimeFormat`-Muster vom vent-Block kopieren). Pro Recipient mit aktivem `digest` (und außerhalb Ruhezeit) einen Text bauen:
   - Wetter: aus den in der Standort-Schleife bereits geladenen Tageswerten (`frostMin`/`heatMax` bzw. der daily-Antwort) des ERSTEN Standorts — dafür die Werte außerhalb der Schleife in einer Variable `digestWeather` merken (Min/Max heute, Wettercode-Text optional weglassen).
   - To-dos: `SELECT text FROM todos WHERE (profile = ? OR shared = 1) AND done = 0 AND deleted = 0 AND due_ms < <heute 24:00> LIMIT 5` (Muster To-do-Block).
   - Klima-Kurzstatus: je Standort „Name: T °C / RH %" aus den bereits geladenen letzten Werten (`t.value`/`h.value` in der Schleife in `digestClimate[]` sammeln).
   - Termine (best effort): `ical_url` aus `rec.settings` (prüfen, wie `loadRecipients` die Settings bereitstellt — sonst per `SELECT value FROM user_settings WHERE profile=? AND key='ical_url'`); wenn gesetzt und Host der Allowlist aus `functions/api/ical.js` entspricht (Suffix-Liste dorthin exportieren oder kopieren): ICS holen, GROB nach `DTSTART` von heute filtern (kein RRULE-Support serverseitig — bewusst simpel, Kommentar), max. 3 Titel. Fehler → Abschnitt weglassen.
   - Versand über `shouldSend(db, profil:digest, 20h)` + `pushTo` (Muster To-do-Block), `priority: 'default'`, Tag `sun_with_face`.
3. E2E-Regelanzahl 12 → 13.

**Abnahme:** Regel erscheint in den Einstellungen (aus per Default); manueller Aufruf von `/api/check-alerts` im Zeitfenster erzeugt genau einen Digest pro aktivem Profil.

**Fallstricke:** KEINE neuen Fetches pro Digest-Empfänger für Wetter — die Schleifen-Daten wiederverwenden. ICS-Parsing serverseitig minimal halten (Zeilen mit `SUMMARY`/`DTSTART` reichen); `expandRecurring` NICHT nach functions/ kopieren.

**Commit:** `Plan3-5: Morgen-Digest als Opt-in-Push (Wetter, To-dos, Klima, Termine)`

---

### Punkt 6: Sensor-Kalibrierung (Offsets pro Standort)

**Ziel:** Günstige Sensoren weichen konstant ab (z. B. +1.2 °C). Ein Offset pro Standort korrigiert Anzeige UND serverseitige Warnungen.

**Dateien:** `lib/core.js` + `tests/core.test.js`, `app-core.js`, `app-settings.js`, `functions/api/check-alerts.js`, `functions/api/config.js` (nur lesen/verstehen), `sw.js` (Bump).

**Schritte:**
1. `lib/core.js`: `applyCalibration(aligned, { tempOffset = 0, humOffset = 0 } = {})` — liefert NEUES Array mit korrigierten `temp`/`humidity` (Feuchte auf 0–100 geklemmt), Originale unverändert. Tests: Offsets angewandt, Klemmen, leeres Array.
2. Speicherort: `app_config`-Tabelle (D1, server-lesbar, standort- statt profilbezogen), Schlüssel `calib_<locId>`, Wert `{ tempOffset, humOffset }`. Prüfen, wie `functions/api/config.js` liest/schreibt (das Muster `weather_<locId>` existiert) und den Schreibpfad wiederverwenden (Admin-only, falls config.js das so handhabt — sonst identisch absichern).
3. Client (app-core.js): nach JEDEM `processRawFeeds`-Aufruf für Anzeige-Daten (`loadIndoorData`-Pfad, `appState.insideData = …`) die Kalibrierung anwenden. Offsets beim Start je Standort über den config-Endpunkt laden (best effort, Cache in `appState.calib[locId]`, Default 0/0). Auch die Hub-Vorschau (app-main.js, `loadHubPreviews`) anwenden.
4. UI (app-settings.js, Standort-Karte): Zeile „Kalibrierung: +1,2 °C / −3 %" + Admin-Button „Kalibrieren" → `modalPrompt` (2 Zahlenfelder, Komma-Dezimal) → Speichern über config-Endpunkt.
5. Server (`check-alerts.js`): `calib_<locId>` über `getCoordOverride`-Muster lesen (analoge Hilfsfunktion) und auf `t.value`/`h.value` addieren, BEVOR Schimmel-/Fenster-/CO2-Checks rechnen (CO2 unkalibriert lassen).

**Abnahme:** Core-Tests grün; gesetzter Offset ändert KPI-Anzeige und (per Test der Hilfsfunktion oder Sichtpruefung) die Server-Berechnung.

**Fallstricke:** Kalibrierung NUR EINMAL anwenden — zentral direkt nach dem Verarbeiten, nicht zusätzlich in Chart/Advisor (die lesen `appState.insideData` bereits kalibriert). Offline-Snapshot (`climate_offline_*`) speichert dann kalibrierte Werte — akzeptabel, kurz kommentieren.

**Commit:** `Plan3-6: Sensor-Kalibrierung pro Standort (applyCalibration, app_config)`

---

### Punkt 7: Tagesnotizen im Klima-Archiv

**Ziel:** Ereignisse wie „Fenster getauscht", „Urlaub" erklären Ausreißer — direkt am Tag notieren und in der Jahres-Heatmap sehen.

**Dateien:** `functions/api/climate.js`, `app-archive.js`, `tests/api.test.js`, `sw.js` (Bump).

**Schritte:**
1. `climate.js`: Spalte `note TEXT` nachrüsten (try/catch-ALTER wie co2_avg). Neuer `PUT`-Zweig: Body `{ loc, day, note }` → `UPDATE climate_daily SET note = ? WHERE loc = ? AND day = ?` (note null = löschen; auf 280 Zeichen kürzen). Der POST-Upsert darf vorhandene Notizen NICHT überschreiben → im `INSERT OR REPLACE` die note-Spalte per Unterabfrage erhalten (`(SELECT note FROM climate_daily WHERE loc=? AND day=?)`) — oder einfacher: POST auf `INSERT ... ON CONFLICT(loc, day) DO UPDATE SET t_min=…` umbauen, das note unberührt lässt. Die ON-CONFLICT-Variante ist die saubere; Test dafür Pflicht.
2. Tagesdetail (`showArchiveDayDetail` in app-archive.js): Notiz-Anzeige + Textfeld mit Speichern-Button (`data-onclick`), PUT best effort.
3. Jahres-Heatmap (`renderArchiveYear`): Tage mit Notiz bekommen einen weißen Punkt/Rahmen (CSS `box-shadow: inset 0 0 0 1px rgba(255,255,255,.7)`); Tooltip um die Notiz ergänzt; `yearHeatmap` (lib/core.js) reicht `note` mit durch (Feld ergänzen, bestehende Tests bleiben grün).
4. Tests (api.test.js): PUT setzt/löscht Notiz; POST-Upsert danach lässt die Notiz stehen.

**Abnahme:** Notiz überlebt den täglichen Archiv-Upload; Heatmap markiert den Tag.

**Fallstricke:** SQLite `ON CONFLICT` braucht den PRIMARY KEY (loc, day) — existiert. Beim Umbau auf ON CONFLICT alle 9 Wertspalten im UPDATE-Teil aufzählen, `samples`/CO2 nicht vergessen; die bestehenden climate-API-Tests müssen unverändert grün bleiben.

**Commit:** `Plan3-7: Tagesnotizen im Archiv (PUT note, Heatmap-Markierung)`

---

## Phase C — Hub, GPX & PWA

### Punkt 8: Eigene Termine (lokaler Kalender in D1)

**Ziel:** Termine ohne Google-Kalender direkt in der App anlegen — erscheinen im Kalender-Widget und im Briefing.

**Dateien:** neu `functions/api/events.js`, `lib/core.js` + `tests/core.test.js`, `app-hub.js`, `index.html` (Kalender-Widget-Kopf), `tests/api.test.js`, `sw.js` (Bump), `tailwind.css` (Rebuild).

**Schritte:**
1. `functions/api/events.js` (Muster todos.js, LWW + Tombstones): Tabelle `events (id TEXT PRIMARY KEY, profile TEXT, title TEXT, start_ms INTEGER, end_ms INTEGER, all_day INTEGER, repeat TEXT, created_at INTEGER, updated_at INTEGER, deleted INTEGER DEFAULT 0)`; GET (eigene), POST Batch-Upsert (LWW über updated_at). `repeat` ∈ none|daily|weekly|monthly|yearly.
2. `lib/core.js`: `expandSimpleRepeat(events, fromMs, toMs, maxPerEvent = 60)` — expandiert `{ startMs, endMs, repeat }` in Vorkommen im Fenster (monthly/yearly über Kalenderarithmetik mit `Date`, Tag ggf. auf Monatsende klemmen). Tests: daily-Expansion, monthly am 31., none unverändert.
3. Client (app-hub.js): Store-Spiegel wie To-dos ist NICHT nötig — Termine direkt per apiFetch laden (best effort; ohne D1 Feature ausblenden). In `loadHubCalendar`: eigene Events laden, mit `expandSimpleRepeat` expandieren, als dritte Quelle (`cal: 2`, eigene Farbe `bg-teal-400`) in `all` mergen — landet damit automatisch auch in `appState.calEvents` (Briefing zählt heutige Termine bereits).
4. UI: Plus-Button im Kalender-Widget-Kopf (`data-onclick="addOwnEvent"`) → `modalPrompt` (Titel, Datum, Uhrzeit optional = ganztägig, Wiederholung als select) → POST. Klick auf einen eigenen Termin in der Liste → `modalConfirm` „Löschen?" → Tombstone-POST. (Bearbeiten = Löschen+Neu, bewusst schlank.)
5. Tests (api.test.js): Upsert, Tombstone, Profiltrennung (fremdes Profil sieht den Termin nicht).

**Abnahme:** Eigener Termin erscheint im Widget zwischen den ICS-Terminen und zählt im Briefing; Tests grün.

**Fallstricke:** `modalPrompt`-Feldtypen prüfen (date/time-Inputs vorhanden? sonst Text mit Format-Hinweis `TT.MM.JJJJ [HH:MM]` und robustem Parser). IDs wie bei To-dos generieren (`Date.now()+rand`).

**Commit:** `Plan3-8: Eigene Termine in D1 (events-Endpunkt, expandSimpleRepeat, Widget)`

---

### Punkt 9: GPX-Aufzeichnung 2.0 — Pause, Auto-Pause-Hinweis, Foto unterwegs

**Ziel:** Die Live-Aufzeichnung (Plan2-13) alltagstauglich machen: Pausen ohne Stopp, Fotos direkt aus der Aufnahme mit Geotag der aktuellen Position.

**Dateien:** `gpx.html`, `gpx.js`, `sw.js` (Bump), `tailwind.css` (Rebuild).

**Schritte:**
1. Statusleiste (gpx.html `#record-status`): zusätzlicher Button „Pause"/„Weiter" (`data-onclick="togglePauseRecording"`) und Foto-Button (`data-onclick="recordPhoto"`, Kamera-Icon) + verstecktes `<input type="file" accept="image/*" capture="environment" id="rec-photo-input" data-onchange="onRecPhotoPicked|$event">`.
2. `togglePauseRecording()` (gpx.js): Pause = `clearWatch` + `state.rec.paused = true` (Punkte-Sammlung stoppt; Wake Lock halten); Weiter = neuen `watchPosition` starten. Statusleiste zeigt „Pausiert" (amber statt rot). `updateRecordingUI` entsprechend erweitern. Pausen > 10 min erkennt `computeStats` beim Speichern ohnehin als Nicht-Bewegungszeit — Kommentar dazu.
3. Auto-Pause-HINWEIS (keine Datenänderung): wenn 90 s kein Fix akzeptiert wurde (Timer vergleicht `Date.now()` mit Zeitstempel des letzten akzeptierten Punkts), Statusleiste um „(steht still)" ergänzen — reine Anzeige.
4. `recordPhoto()`: öffnet den capture-Input. `onRecPhotoPicked(event)`: Datei + AKTUELLE Position (letzter akzeptierter Punkt, sonst EXIF-Fallback wie in `uploadTourPhoto`) in `state.rec.photos.push({ file, lat, lon })`; Toast „Foto vorgemerkt (n)".
5. `stopRecording()`/`saveRecordedActivity`: nach Cloud-Push (`pushActivityToCloud`) — wenn `state.rec.photos`-Queue gefüllt und `await photosAvailable()`: je Foto den bestehenden Resize-/Upload-Pfad nutzen (Logik aus `uploadTourPhoto` in eine Hilfsfunktion `uploadPhotoBlob(uid, file, gps)` extrahieren, die beide nutzen), Zähler-Toast. Ohne R2: Toast „Fotos konnten nicht hochgeladen werden (R2 fehlt)".
6. Recovery-Puffer: Fotos NICHT in localStorage (zu groß) — bei Crash gehen nur vorgemerkte Fotos verloren; Kommentar.

**Abnahme:** Playwright-Geolocation-Spotcheck wie bei Plan2-13 (Pause stoppt Punktzuwachs, Weiter setzt fort); Foto-Queue-Pfad per Sichtpruefung/Konsole.

**Fallstricke:** Beim Extrahieren von `uploadPhotoBlob` das Verhalten von `uploadTourPhoto` exakt erhalten (Limits, Nummernvergabe, renderPhotos-Refresh) — die bestehende Funktion danach auf die Hilfsfunktion umstellen, nicht duplizieren.

**Commit:** `Plan3-9: Aufzeichnung 2.0 (Pause/Weiter, Stillstands-Hinweis, Foto mit Geotag)`

---

### Punkt 10: PWA-Feinschliff — Shortcuts, App-Badge, Vendor-Cache-Header

**Ziel:** Die installierte App fühlt sich nativer an: Schnellzugriffe im App-Icon-Menü, Badge mit überfälligen To-dos, schnellere Wiederholbesuche.

**Dateien:** `manifest.webmanifest`, `gpx.js`, `app-hub.js`, `_headers`, `sw.js` (Bump).

**Schritte:**
1. Manifest `shortcuts`: `[{ name: 'ClimateFlow', url: 'index.html#climate' }, { name: 'GPX-Viewer', url: 'gpx.html' }, { name: 'Aufzeichnung starten', url: 'gpx.html#record' }]` (jeweils `icons` mit icon-192 wiederverwenden).
2. `gpx.js` `init()`: bei `location.hash === '#record'` → Hash entfernen und `startRecording()` aufrufen (Geolocation-Prompt ohne Geste ist erlaubt; wenn bereits eine Aufnahme läuft, nur Toast).
3. App-Badge (app-hub.js, in `renderTodos` am Ende): `const overdue = …` (Logik aus dem Briefing-Block wiederverwenden); `if ('setAppBadge' in navigator) { overdue ? navigator.setAppBadge(overdue) : navigator.clearAppBadge(); }` in try/catch.
4. `_headers`: Block `/vendor/*` mit `Cache-Control: public, max-age=604800` (7 Tage — bewusst NICHT `immutable`: die Dateinamen tragen keine Version; bei einem Vendor-Upgrade würde ein Jahres-Cache alte Bibliotheken festnageln. Kommentar in die Datei: bei Upgrade Datei umbenennen oder Cache-Zeit beachten).
5. Smoke-Test läuft unverändert (Manifest wird auf JSON-Validität nicht geprüft — `node -e "JSON.parse(...)"` manuell ausführen).

**Abnahme:** Manifest valide (JSON-Parse); Badge erscheint auf installierter PWA mit überfälligem To-do (Desktop-Chrome testbar); `curl -sI /vendor/chart.umd.js` zeigt den Cache-Header (nach Deploy).

**Fallstricke:** `setAppBadge` gibt es nur in sicheren Kontexten/installierten PWAs — immer feature-detecten, nie erzwingen. Shortcuts erfordern eine Neu-Installation der PWA zum Testen.

**Commit:** `Plan3-10: PWA-Shortcuts, App-Badge, Vendor-Cache-Header`

---

## Abschluss (nach Punkt 10)

- README-Roadmap aktualisieren; diese Datei: Status-Block oben auf „vollständig umgesetzt" setzen.
- Finale Verifikation: `npm run lint` + `npm test` + `npm run test:e2e` (Regelanzahl dann 13).
- CLAUDE.md: Verweis auf die dann aktuelle Plandatei pflegen.
