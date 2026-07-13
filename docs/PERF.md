# Performance des mobilen Erststarts (PLAN4 Phase A)

Gemessen mit `npm run perf` (`scripts/perf-audit.mjs`): frischer Browser-Kontext
je Lauf (= Erstbesuch, kein Service-Worker/Cache), Drossel **Fast-3G**
(150 ms Latenz, ~200 KB/s Download) + **CPU 4×**. `/api/*` mit 400 ms, Wetter-APIs
mit 300 ms simulierter Latenz gemockt. Hub-Werte = Median aus 3 Läufen; die
Metriken werden je Spalte einzeln über die Läufe gemediant (bei hoher Varianz
können `Gerüst` und `Briefing` daher aus verschiedenen Läufen stammen).

**Kennzahl mit dem größten Nutzerbezug:** „Gerüst sichtbar" — die Zeit vom
Navigationsstart, bis `#view-home` nicht mehr `hidden` ist (bis dahin sieht der
Nutzer nur den Footer).

## Baseline (vor Runde 4) — Messung 2026-07-13

| Metrik | Hub (index.html) | GPX (gpx.html) |
|---|---|---|
| **Gerüst sichtbar (#view-home)** | **5470 ms** | – |
| Briefing gefüllt | 2728 ms | – |
| DOMContentLoaded | 267 ms | 5284 ms |
| load-Event | 590 ms | 5662 ms |
| Requests | 57 | 16 |
| Transfer | 912 KB | 977 KB |

**Befund:** Das DOM steht auf dem Hub bereits nach 267 ms, aber das Dashboard
bleibt bis 5470 ms unsichtbar — `init()` blendet die View erst nach mehreren
seriellen API-Roundtrips (whoami → settings → locations) ein. Auf gpx.html ist
schon DOMContentLoaded (5284 ms) durch die synchron im `<head>` geladenen
Vendor-Skripte (chart.umd.js, leaflet.js, lucide) blockiert. Genau diese beiden
Punkte adressiert Phase A.

## Verlauf während Phase A (Hub „Gerüst sichtbar", Median)

| Stand | Gerüst sichtbar | Requests | Transfer | Bemerkung |
|---|---|---|---|---|
| Baseline (vor P4) | 5470 ms | 57 | 912 KB | init() awaitet vor dem View-Wechsel |
| nach Plan4-2 | 4227 ms | 57 | 914 KB | Render-Gerüst vor dem ersten await |

**Harness-Hinweis:** Die CDP-Netzdrossel greift bei localhost-Auslieferung
statischer Dateien nur schwach (load-Event ~600 ms trotz „Fast-3G"); das
Messgeschirr erfasst v. a. die serielle Await-Kette, Request-Anzahl und Bytes
verlässlich. Der E2E-Test „Erststart zeigt Geruest sofort" belegt die reine
Render-Logik direkt: Gerüst nach ~300 ms trotz 5 s künstlicher API-Latenz.
Absolute Millisekunden daher als grober Richtwert lesen, die Deltas als Trend.

<!-- Nach Phase A (Punkt 8): hier die Vergleichstabelle Baseline ↔ Nachher. -->
<!-- Final (Punkt 25): kompletter Verlauf Baseline → Phase A → final. -->
