# Smart Home Hub (ClimateFlow)

Multi-Projekt-Plattform auf Cloudflare Pages: Homescreen-Hub mit Klimadashboard
(**ClimateFlow**) für zwei Standorte und Platzhalter für den kommenden **GPX-Viewer**.

## Architektur

| Datei | Zweck |
|---|---|
| `index.html` | Gesamte SPA: Hub-Homescreen, ClimateFlow-Dashboard, GPX-Platzhalter (Hash-Routing `#home` / `#climate` / `#gpx`) |
| `functions/_middleware.js` | Cloudflare Pages Middleware: HTTP Basic Auth (`AUTH_USER` / `AUTH_PASS`) |
| `manifest.webmanifest`, `sw.js`, `icons/` | PWA: installierbar auf dem iPhone-/Android-Homescreen, Offline-Fallback |

Datenquellen: ThingSpeak (Innenklima, 2 Kanäle) und Open-Meteo (Außenwetter, `timeformat=unixtime`, `past_days=7`, `forecast_days=2`).

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

## Deployment

Push auf `main` → Cloudflare Pages deployt automatisch.
