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
| `functions/api/check-alerts.js` | Serverseitiger Sensor-, Schimmelrisiko- **und Frost**-Check + ntfy-Push (für externen Cron) |
| `functions/api/weekly-report.js` | Wöchentlicher Klima-Report per ntfy (D1-Archiv + Vorwochen-Trend, für wöchentlichen Cron) |
| `functions/api/ical.js` | CORS-Proxy für Kalender-Feeds (.ics) — fürs Kalender-Widget auf dem Hub |
| `functions/api/config.js` | Key-Value-Speicher in D1 (z. B. Wetter-Koordinaten für die Server-Checks) |
| `gpx.js` | GPX-Viewer-Logik (aus gpx.html ausgelagert) |
| `tests/smoke.test.js` | Deploy-Schutz: prüft IDs/Handler/Dateiverweise über alle Seiten (`npm test`) |
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
   - Serverseitig (auch bei geschlossenem Browser): Env-Var `NTFY_TOPIC` = Topic setzen und einen kostenlosen Cron-Dienst (z. B. cron-job.org) alle 1–6 h `GET https://<domain>/api/check-alerts` aufrufen lassen. Dieser Endpunkt warnt bei **Sensor-Ausfall** (>2 h keine Werte, max. 1×/6 h), **Schimmel-/Kondensatrisiko** an kalten Wandstellen (Außentemperatur via Open-Meteo, max. 1×/12 h) und **Frost** (Tiefstwert der nächsten 2 Tage ≤ 0 °C, max. 1×/18 h). Die Entprellung braucht das D1-Binding `DB` (Schritt 1).
   - **Wochenbericht**: zusätzlich einen zweiten Cron-Job anlegen, der 1×/Woche (z. B. sonntags 19:00) `GET https://<domain>/api/weekly-report` aufruft — verschickt eine Wochen-Zusammenfassung (Ø/Min/Max, Komfort-Score, Vorwochen-Trend) als Push. Beide Jobs brauchen die Basic-Auth-Zugangsdaten (bei cron-job.org unter „Authentication" hinterlegen).
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
- **CSV-Export** der aktuellen Messreihe (Download-Symbol im Header): Zeit, Temperatur, Feuchte, absolute Feuchte, Taupunkt — Excel-freundlich (Semikolon/Komma, UTF-8-BOM)
- **Komfort-Score (0–100)** aus Temperatur, Feuchte und Schimmelrisiko — live in der 24h-Statistik und als Tages-Kurve im Langzeit-Archiv
- **Lüftungs-Erfolgskontrolle**: erkennt Stoßlüften der letzten 48 h automatisch (gleichzeitiger Feuchte-+Temperatursturz) und zeigt den Effekt („Feuchte −9 %")
- **Heizaufwand-Indikator**: mittlere Innen-Außen-Differenz heute vs. gestern (relativer Heizbedarf ohne Verbrauchsdaten)
- **Frost-/Hitzewarnung** aus der Prognose (Hinweis in der Wetter-Karte + Push): Frost ≤ 0 °C in den nächsten 15 h, Hitze ≥ 30 °C in den nächsten 36 h
- **Standort-Vergleich**: Button „Vergleich" legt beide Schlafzimmer in denselben Chart (Temperatur + Feuchte, 4 Serien)
- **Konfigurierbare Ziel-/Schwellwerte** pro Standort (Regler-Symbol neben dem Namen): Wohlfühlband für Temperatur/Feuchte steuert Comfort-Bewertungen, Komfort-Score und Lüftungsberater-Warnschwelle

## GPX-Viewer

- **Jahres-/Wochenziele** (Zielscheiben-Symbol) mit Fortschrittsbalken — auch auf der Hub-Kachel
- **Kalender & Streaks**: Monatsraster mit Aktivitätstagen, aktuelle/längste Serie
- **Heatmap** (Flammen-Symbol): alle Routen halbtransparent übereinander — häufige Wege glühen
- **Strecken-Bestzeiten**: wiederkehrende Strecken werden automatisch erkannt (60-m-Raster-Abgleich), Rangliste nach Bewegungszeit mit 🏆
- **Notiz & Start-Wetter** pro Tour: Textnotiz (auto-gespeichert, cloud-synct ☁️), Wetter beim Start wird automatisch nachgeschlagen
- **GPX-Export**: jede Tour wieder als GPX-1.1-Datei herunterladen
- Upload per Drag & Drop oder Dateiauswahl (mehrere `.gpx` gleichzeitig)
- Speicherung **lokal (IndexedDB)** + automatischer **Cloud-Sync in D1** (sobald eingerichtet; Status im Header)
- **Backup**: alle Aktivitäten + Einstellungen als JSON herunterladen / wiederherstellen (Buttons im Header)
- Karte (Leaflet + OpenStreetMap, dunkler Look), Start-/Ziel-Marker, **Tempo-Färbung** (blau = langsam → rot = schnell)
- **Tour-Vergleich**: zweite Tour als Overlay auf Karte + Höhenprofil
- Gesamt-Statistik: km gesamt / diese Woche / dieses Jahr
- Statistiken pro Tour: Distanz, Dauer (Bewegungszeit, Pausen > 10 min ausgenommen), Ø/Max-Tempo (GPS-Ausreißer gefiltert), Anstieg (geglättet), Höhe min/max, Höhenprofil
- Aktivitätstyp wird über das Ø-Tempo geraten (Spazieren < 6,5 / Laufen < 13 / Rad < 42 / Motorrad) und ist manuell änderbar; Umbenennen & Löschen möglich

## Hub-Widgets

- **Uhr/Begrüßung/Wetter jetzt**, **3-Tage-Wettervorschau**, **To-do-Liste** (lokal) und **Kalender** (nächste Termine)
- **Anpassbar**: Reihenfolge per Drag & Drop am Griff-Symbol (erscheint beim Überfahren), Ein-/Ausblenden über „Widgets anpassen" — beides bleibt gespeichert
- **Kalender verbinden**: Zahnrad im Termine-Widget → .ics-URL eintragen (Google Kalender: Einstellungen → [Kalender] → „Geheime Adresse im iCal-Format"). Braucht den deployten `/api/ical`-Proxy ☁️. Grenze: Serientermine erscheinen nur mit ihrem ersten Datum (↻-Markierung).
- **Fehler-Reporting**: unbehandelte JS-Fehler auf jedem Gerät werden als ntfy-Push gemeldet (max. 3/Sitzung, Topic muss eingerichtet sein)

## Cloudflare Access statt Basic Auth (optional, vorbereitet)

Login per E-Mail-Code statt Benutzer/Passwort — angenehmer auf dem iPhone (PWA):
1. [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → Access → Applications → *Add an application* → Self-hosted → Domain der Seite eintragen.
2. Policy anlegen: *Allow* → Include → Emails → deine E-Mail-Adresse(n).
3. Im Pages-Projekt die Env-Var **`AUTH_MODE`** = `access` setzen und neu deployen.
Die Middleware lässt dann nur noch Anfragen mit Access-JWT durch; Basic Auth ist abgeschaltet. Rückweg: `AUTH_MODE` löschen → Basic Auth gilt wieder.

## Roadmap / weitere Ideen

1. Serientermine (RRULE) im Kalender-Widget expandieren
2. GPX: Foto-Anhänge pro Tour, Segment-Detailvergleich (Teilstrecken)
3. To-do-Widget optional in D1 syncen (geräteübergreifend)

## Deployment

Push auf `main` → Cloudflare Pages deployt automatisch.
Bei Service-Worker-Änderungen `CACHE_NAME` in `sw.js` hochzählen (aktuell `smarthub-v3`).
