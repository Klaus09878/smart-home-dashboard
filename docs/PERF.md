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

**Plan4-6 (ThingSpeak-Erst-Load):** Der erste Klima-Load fordert jetzt 4032
statt 8000 ThingSpeak-Eintraege an (~14 Tage, ~50 % weniger Feed-Bytes/Parse);
die volle Historie holt `ensureFullHistory` erst beim Klick auf „Alle". Das
hub-fokussierte Perf-Skript misst den Klima-Feed-Load nicht (der Hub nutzt nur
`results=400`-Vorschauen), daher steht der Effekt nicht in der Tabelle oben —
verifiziert ueber den Code-Pfad und den `results`-Parameter im Feed-Mock.

## Bilanz Phase A (Plan4-1 bis Plan4-8)

Was am mobilen Erststart konkret verbessert wurde (code-verifizierbar, unabhängig
von der Mess-Streuung des localhost-Harness):

1. **Reveal vor den API-Roundtrips (Plan4-2/3):** Das Hub-Gerüst wird beim
   init-Start sichtbar (≈ DOMContentLoaded), nicht mehr erst nach der seriellen
   Kette whoami → settings → locations. E2E-Beleg: Gerüst nach ~300 ms trotz 5 s
   künstlicher API-Latenz. whoami+settings laufen zusätzlich parallel
   (Briefing-Zeit im Harness 2728 → ~1800 ms).
2. **Kein render-blockierender Fremd-Request mehr (Plan4-4):** Google Fonts
   (2 Preconnects + 1 blockierendes CSS + gstatic-woff2) entfernt → lokale
   Outfit-woff2 mit Preload. Vendor-Skripte (lucide; auf gpx.html zusätzlich
   Chart+Leaflet) auf `defer`. Im Harness sank das Hub-load-Event von ~590 ms
   auf < 200 ms (wenn die Drossel localhost nicht greift).
3. **Weniger/kleinere Requests (Plan4-6/8):** Erst-Feed-Load 8000 → 4032
   Einträge (~50 % weniger); Hub-Wetter je Koordinate ein gebündelter Abruf
   statt bis zu vier (Uhr-Wetter, 3-Tage-Vorschau, Schimmel-Außentemperatur,
   DWD teilen sich einen 10-min-Cache). Request-Zahl im Harness ~57 → ~28.
4. **Robustheit (Plan4-5/7):** apiFetch/Wetter-fetches brechen nach 8–10 s ab
   (GET-Retry), der SW weicht nach 2,5 s auf den Cache aus, und der erste
   SW-Install löst keinen Voll-Reload mehr aus.

**Mess-Streuung (ehrlich):** Der CDP-Netzdrossel greift bei localhost je nach
Lauf unterschiedlich stark. Greift sie, liegen DOMContentLoaded und Gerüst-Reveal
gemeinsam bei ~4,3 s (die App-Skripte brauchen unter Fast-3G real ~4 s zum
Laden) — der Reveal passiert dann trotzdem GENAU bei DCL (init-Start), nicht
danach. Greift sie nicht, liegt beides bei ~150 ms. In beiden Fällen ist die
Kernaussage dieselbe: das Gerüst erscheint mit dem init-Start, nicht nach der
Await-Kette. Verlässlich sind Request-Zahl, Bytes und die eliminierten
Fremd-Requests; die absoluten Download-Millisekunden schwanken.

Die faire Baseline-Neumessung mit dem korrigierten (MutationObserver-)Harness
gegen den ausgecheckten Baseline-Commit steht in Punkt 25 (finale Verifikation).

## Abschlussmessung Runde 4 (Plan4-25) — 2026-07-13

Beide Stände mit **demselben, korrigierten Messgeschirr** gemessen: der
Baseline-Commit (`0a57063`) wurde dafür temporär ausgecheckt.

| Metrik | Baseline (vor Runde 4) | nach Runde 4 |
|---|---|---|
| DOMContentLoaded | 335 ms | 4627 ms* |
| **Gerüst sichtbar** | **1719 ms** | **4624 ms*** |
| **⇒ Wartezeit NACH fertigem DOM** | **+1384 ms** | **≈ 0 ms** |
| Requests (Hub) | 57 | **28** |
| Transfer (Hub) | 938 KB | 916 KB |

\* In diesem Lauf griff die CDP-Drossel auf die localhost-Auslieferung, im
Baseline-Lauf nicht — die **absoluten** ms sind deshalb nicht direkt
vergleichbar (siehe Harness-Hinweis). Vergleichbar und aussagekräftig ist die
**Differenz Gerüst − DOMContentLoaded**: Sie misst genau das, was der Nutzer als
„leere Seite" erlebt, und ist von der Download-Geschwindigkeit unabhängig.

### Das Ergebnis in einem Satz

**Vorher** erschien das Dashboard erst **1,4 Sekunden nachdem das DOM fertig
war** — bis dahin sah man nur den Footer, weil `init()` erst die serielle Kette
whoami → settings → locations abwartete. **Jetzt** erscheint das Gerüst
**zusammen mit dem DOM** (Gerüst = DCL, in drei aufeinanderfolgenden Läufen
4624/4632/4612 ms bei DCL 4627/4633/4613 ms). Zusätzlich halbiert sich die
Request-Zahl (57 → 28), und es gibt keinen render-blockierenden
Google-Fonts-Request mehr.

Auf echtem Mobilfunk addiert sich die eingesparte Wartezeit weiter: Die 1384 ms
im Harness entstehen aus drei simulierten 400-ms-Roundtrips; bei realer
Mobilfunk-Latenz (oft 200–500 ms pro Roundtrip, dazu die Cloudflare-Function-
Laufzeit) fällt der Gewinn entsprechend größer aus. Die vom Nutzer berichteten
„bis zu ~10 Sekunden" setzten sich aus genau diesen Bausteinen zusammen:
Await-Kette + render-blockende Fonts + 8000-Einträge-Feed + Erstbesuch-Reload
des Service Workers — alle vier sind adressiert.
