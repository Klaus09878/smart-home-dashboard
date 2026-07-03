# Smart Home Hub (ClimateFlow)

Multi-Projekt-Plattform auf Cloudflare Pages: Homescreen-Hub mit Klimadashboard
(**ClimateFlow**) für zwei Standorte und Platzhalter für den kommenden **GPX-Viewer**.

## Architektur

| Datei | Zweck |
|---|---|
| `index.html` | Hub-Homescreen (Uhr/Datum/Wetter-Widget, Projekt-Kacheln) + ClimateFlow-Dashboard (Hash-Routing `#home` / `#climate`) |
| `gpx.html` | GPX-Viewer: eigenständige Seite (Leaflet-Karte, Höhenprofil, Statistiken, IndexedDB-Speicher) |
| `functions/_middleware.js` | Cloudflare Pages Middleware: HTTP Basic Auth (`AUTH_USER` / `AUTH_PASS`) |
| `manifest.webmanifest`, `sw.js`, `icons/` | PWA: installierbar auf dem iPhone-/Android-Homescreen, Offline-Fallback |

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
- Speicherung **lokal im Browser (IndexedDB)** — kein Server, keine Uploads ins Netz, funktioniert pro Gerät
- Karte (Leaflet + OpenStreetMap, dunkler Look), Start-/Ziel-Marker
- Statistiken: Distanz, Dauer (Bewegungszeit, Pausen > 10 min ausgenommen), Ø/Max-Tempo (GPS-Ausreißer gefiltert), Anstieg (geglättet), Höhe min/max
- Höhenprofil über Distanz (Chart.js)
- Aktivitätstyp wird über das Ø-Tempo geraten (Spazieren < 6,5 / Laufen < 13 / Rad < 42 / Motorrad) und ist manuell änderbar; Umbenennen & Löschen möglich

## Roadmap / Basis-Ausbau

1. **Tailwind-Build statt CDN** (Performance, keine Runtime-Kompilierung)
2. **Gemeinsame Assets extrahieren** (`shared.css`, `shared.js`: Glass-Styles, Formatierer, Icons-Init), sobald ein drittes Projekt dazukommt
3. **Cloudflare Functions als API-Schicht** (`/api/...`): ThingSpeak-Keys verstecken, serverseitiges Caching, später Langzeit-Archiv in D1
4. **Langzeit-Archiv Klimadaten** (ThingSpeak-Limit 8000 Einträge): tägliche Aggregate in Cloudflare D1/KV
5. **Push-Benachrichtigungen** bei Sensor-Ausfall/Schimmelrisiko (z. B. ntfy.sh)
6. **GPX-Ausbau**: Gesamt-Statistik über alle Aktivitäten (km/Woche, Jahresziele), Tempo-Färbung der Route, Vergleich zweier Touren
7. **Hub-Ausbau**: frei anordenbare Widgets, Schnellzugriffe, Kalender-/To-do-Integration

## Deployment

Push auf `main` → Cloudflare Pages deployt automatisch.
Bei Service-Worker-Änderungen `CACHE_NAME` in `sw.js` hochzählen (aktuell `smarthub-v2`).
