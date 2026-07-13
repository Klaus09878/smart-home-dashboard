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

## Verlauf während Phase A (Hub, Median)

| Stand | Gerüst sichtbar | Briefing | DCL | load | Requests | Transfer |
|---|---|---|---|---|---|---|
| Baseline (rAF-Messung) | 5470 ms | 2728 ms | 267 ms | 590 ms | 57 | 912 KB |
| nach Plan4-2 (rAF) | 4227 ms | 2794 ms | 278 ms | 633 ms | 57 | 914 KB |
| nach Plan4-3 (rAF) | 4227 ms | 1965 ms | 273 ms | 611 ms | 57 | 915 KB |
| nach Plan4-4 (MutationObserver) | **149 ms** | 1779 ms | 149 ms | 169 ms | 59 | 892 KB |

**Wichtige Mess-Korrektur (Plan4-4):** Bis Plan4-3 wurde „Gerüst sichtbar" per
`waitForFunction` (rAF-Poll) gemessen. Unter der CPU-4×-Drossel feuert dieser
Poll aber erst, wenn der Main-Thread nach der gesamten init-Arbeit frei ist —
er misst also „Main-Thread frei", nicht den echten Reveal. Ab Plan4-4 erfasst
ein vor der Navigation injizierter `MutationObserver` den exakten Moment, in dem
`#view-home` die `hidden`-Klasse verliert. Ergebnis: **149 ms** statt der
scheinbaren ~4200 ms — das Gerüst ist praktisch mit DOMContentLoaded sichtbar,
wie vom E2E-Test („Geruest nach ~300 ms trotz 5 s API-Latenz") belegt. Die
rAF-Zeilen oben bleiben als Nachweis der irreführenden alten Messung stehen.
Der ehrliche Baseline↔Nachher-Vergleich mit dem korrigierten Geschirr folgt in
Punkt 8 (Phase-A-Bilanz), gemessen gegen den ausgecheckten Baseline-Commit.

**Harness-Hinweis:** Die CDP-Netzdrossel greift bei localhost-Auslieferung
statischer Dateien nur schwach (load-Event < 200 ms trotz „Fast-3G"). Verlässlich
sind daher v. a. die serielle Await-Kette (Briefing-Zeit), Request-Anzahl und
Bytes sowie die MutationObserver-Reveal-Zeit; absolute Download-Millisekunden
sind optimistisch.

<!-- Nach Phase A (Punkt 8): hier die Vergleichstabelle Baseline ↔ Nachher. -->
<!-- Final (Punkt 25): kompletter Verlauf Baseline → Phase A → final. -->
