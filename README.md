# Smart Home Hub (ClimateFlow)

Multi-Projekt-Plattform auf Cloudflare Pages: Homescreen-Hub mit Klimadashboard
(**ClimateFlow**) für zwei Standorte und Platzhalter für den kommenden **GPX-Viewer**.

## Architektur

| Datei | Zweck |
|---|---|
| `index.html` | Hub-Homescreen (Uhr/Datum/Wetter/GPX-Widgets, Projekt-Kacheln) + ClimateFlow-Dashboard (nur Markup; Logik in `app.js`) |
| `app.js` | Hub-Navigation + gesamte ClimateFlow-Logik (aus index.html ausgelagert) |
| `gpx.html` | GPX-Viewer: eigenständige Seite (Leaflet-Karte, Höhenprofil, Statistiken, IndexedDB + Cloud-Sync) |
| `lib/core.js` | Getestete Kernlogik ohne DOM (Magnus, Feed-Verarbeitung, GPX-Statistik) — läuft im Browser und in Node |
| `tests/core.test.js` | Testsuite für lib/core.js (`npm test`) |
| `shared.js` | Gemeinsame Helfer: Formatierer, Icons, Toasts (`showToast`), API-Schicht (`apiFetch`), ntfy-Push (`sendPush`) |
| `tailwind.css` | Statisch gebautes Tailwind-CSS (`npm run build:css` nach Klassen-Änderungen!) |
| `functions/_middleware.js` | Cloudflare Pages Middleware: HTTP Basic Auth (`AUTH_USER` / `AUTH_PASS`) |
| `functions/api/feeds/[locId].js` | ThingSpeak-Proxy (versteckt Keys, 60 s Edge-Cache) |
| `functions/api/gpx.js` | GPX-Aktivitäten in Cloudflare D1 (CRUD, Sync-Backend) |
| `functions/api/climate.js` | Langzeit-Archiv: tägliche Klima-Aggregate in D1 |
| `functions/api/check-alerts.js` | Serverseitiger Sensor-Check + ntfy-Push (für externen Cron) |
| `manifest.webmanifest`, `sw.js`, `icons/` | PWA: installierbar auf dem iPhone-/Android-Homescreen, Offline-Fallback |

## 🔧 Einrichtung Cloud-Funktionen (To-do)

Alle Features laufen ohne diese Schritte weiter (Fallback auf Direktzugriff/lokal).
Nach der Einrichtung schalten sie sich automatisch scharf:

1. **D1-Datenbank** (GPX-Cloud-Sync + Klima-Archiv):
   Cloudflare Dashboard → Workers & Pages → D1 → *Create database* (Name z. B. `smarthub`).
   Dann im Pages-Projekt → *Settings → Functions → D1 database bindings*:
   Variable name **`DB`** → Datenbank auswählen → neu deployen.
   (Tabellen legt der Code beim ersten Zugriff selbst an.)
2. **ThingSpeak-Proxy** (Keys aus dem Frontend verstecken):
   Pages → *Settings → Environment variables*:
   `TS_KEY_GILLIAN` = Read-Key Kanal 3417815, `TS_KEY_SEAN` = Read-Key Kanal 3417935.
3. **Push-Benachrichtigungen (ntfy.sh)**:
   - Handy: kostenlose **ntfy**-App installieren, ein geheimes Topic abonnieren (z. B. `smarthub-abc123`).
   - Dashboard: Glocken-Symbol im ClimateFlow-Header → dasselbe Topic eintragen (Warnungen bei Sensor-Ausfall, Schimmelrisiko).
   - Serverseitig (auch bei geschlossenem Browser): Env-Var `NTFY_TOPIC` = Topic setzen und einen kostenlosen Cron-Dienst (z. B. cron-job.org) alle 1–6 h `GET https://<domain>/api/check-alerts` aufrufen lassen.
4. **Build automatisieren (empfohlen):** Pages → *Settings → Builds & deployments*:
   Build command = `npm run build` (führt Tests aus und baut das CSS), Build output directory = `/`.
   Damit kann das committete `tailwind.css` nie mehr veralten und fehlerhafte Kernlogik bricht den Deploy ab.
   Bis dahin gilt: nach HTML/Klassen-Änderungen lokal `npm run build:css` ausführen und committen.
5. **Nach Schritt 2 (Proxy aktiv): Fallback-Keys entfernen.** In `app.js` die `thingspeakUrl`-Einträge
   aus `LOCATIONS` und den Direktzugriff-Zweig in `fetchFeeds()` löschen — erst dann sind die
   Read-Keys wirklich aus dem Client verschwunden. (Der Code loggt bis dahin eine Warnung in die Konsole.)

**Grundprinzip für neue Projekte:** Jedes weitere Unterprojekt bekommt seine eigene
HTML-Seite (wie `gpx.html`) und eine Kachel auf dem Hub — so bleibt `index.html`
schlank und Projekte laden nur ihre eigenen Abhängigkeiten.

Datenquellen: ThingSpeak (Innenklima, 2 Kanäle), Open-Meteo (Außenwetter, `timeformat=unixtime`, `past_days=7`, `forecast_days=2`), OpenStreetMap (Kartenkacheln GPX-Viewer).

## ⚠️ Wichtig: iPhone-Kurzbefehl auf kombinierten Upload umstellen

**Problem:** Aktuell laden zwei getrennte Kurzbefehle Temperatur (`field1`) und
Luftfeuchtigkeit (`field2`) asynchron hoch. Das Dashboard muss die Werte per
Forward-Fill zu Paaren zusammensetzen — bricht ein Kurzbefehl ab, fällt genau
ein Messwert stundenlang aus (das Dashboard warnt inzwischen mit rotem Banner).

**Lösung:** Beide HomePod-Werte in *einem* Kurzbefehl auslesen und in *einem*
einzigen Request an ThingSpeak senden:

```
https://api.thingspeak.com/update?api_key=<WRITE_API_KEY>&field1=<Temperatur>&field2=<Luftfeuchtigkeit>
```

Aufbau des Kurzbefehls (pro Standort):
1. Aktion „Zuhause-Status abfragen" → Temperatur des HomePod-Sensors in Variable `Temp`
2. Aktion „Zuhause-Status abfragen" → Luftfeuchtigkeit in Variable `Hum`
3. Aktion „Inhalt von URL abrufen" (GET) mit der obigen URL, `Temp`/`Hum` eingesetzt

Hinweise:
- Den **Write API Key** des jeweiligen Kanals verwenden (ThingSpeak → Channel → API Keys), nicht den Read Key.
- Dezimal-Komma (`22,5`) ist okay — der Parser im Dashboard konvertiert es. Punkt ist trotzdem robuster.
- ThingSpeak akzeptiert pro Kanal max. 1 Update alle 15 Sekunden.

Der Forward-Fill im Dashboard bleibt als Fallback aktiv, alte Daten funktionieren weiter.

## Funktionen des Dashboards

- **KPI-Karten** mit „Zuletzt aktualisiert"-Anzeige (gelb, wenn ein Sensor > 2 h stumm ist; zusätzlich rotes Warnbanner)
- **Lüftungsberater** (Vergleich absolute Feuchte innen/außen, Magnus-Formel)
- **Taupunkt & Schimmelrisiko**: geschätzte Wandoberflächen-Feuchte über Temperaturfaktor f_Rsi = 0,7 (DIN 4108-2), kritisch ab 80 %
- **Lüftungsfenster-Prognose**: bewertet die nächsten 24 h stündlich (Open-Meteo-Forecast) und nennt das beste Lüftungsfenster
- **Klimaverlauf** (24 h / 3 d / 7 d / alles); der Graf endet beim letzten echten Messwert-Paar
- **Inkrementelles Laden**: nach dem ersten Voll-Load werden per ThingSpeak-`start`-Parameter nur neue Einträge geholt; Auto-Refresh alle 5 min läuft still im Hintergrund
- **Hub-Homescreen** mit Live-Werten beider Standorte auf der ClimateFlow-Kachel

## GPX-Viewer

- Upload per Drag & Drop oder Dateiauswahl (mehrere `.gpx` gleichzeitig)
- Speicherung **lokal (IndexedDB)** + automatischer **Cloud-Sync in D1** (sobald eingerichtet; Status im Header)
- **Backup**: alle Aktivitäten + Einstellungen als JSON herunterladen / wiederherstellen (Buttons im Header)
- Karte (Leaflet + OpenStreetMap, dunkler Look), Start-/Ziel-Marker, **Tempo-Färbung** (blau = langsam → rot = schnell)
- **Tour-Vergleich**: zweite Tour als Overlay auf Karte + Höhenprofil
- Gesamt-Statistik: km gesamt / diese Woche / dieses Jahr
- Statistiken pro Tour: Distanz, Dauer (Bewegungszeit, Pausen > 10 min ausgenommen), Ø/Max-Tempo (GPS-Ausreißer gefiltert), Anstieg (geglättet), Höhe min/max, Höhenprofil
- Aktivitätstyp wird über das Ø-Tempo geraten (Spazieren < 6,5 / Laufen < 13 / Rad < 42 / Motorrad) und ist manuell änderbar; Umbenennen & Löschen möglich

## Roadmap / weitere Ideen

1. **Hub-Ausbau**: frei anordenbare Widgets, Schnellzugriffe, Kalender-/To-do-Integration
2. **GPX**: Jahresziele, Heatmap aller Routen, Segmente/Bestzeiten
3. **Cloudflare Access** statt Basic Auth (Login per E-Mail-Code)

## Deployment

Push auf `main` → Cloudflare Pages deployt automatisch.
Bei Service-Worker-Änderungen `CACHE_NAME` in `sw.js` hochzählen (aktuell `smarthub-v3`).
