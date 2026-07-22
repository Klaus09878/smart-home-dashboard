# PLAN7 — Tiefe, Intelligenz, Resilienz

Runde 7 baut auf dem reifen Stand nach PLAN2–6 auf. Kein Nachbauen fehlender
Basics (der Kern ist vollstaendig + zu ~100 % getestet), sondern gezielte
**Vertiefung**: Zugaenglichkeit, Feed-Resilienz, ein Intelligenz-Layer,
Observability, Robustheit. Grundlage ist die priorisierte Gap-Analyse (25 Punkte,
23 aufgenommen; gestrichen: Micro-Perf #25 = diminishing returns; #22 optional).

## Arbeitsregeln (verbindlich)
- **Ein Punkt = ein Commit** mit Prefix `Plan7-M:` (ohne Umlaute, per `-F`).
- **Phasen A→F der Reihe nach**; nach jeder Phase Tests + FF-Merge nach `main`
  als gepruefter, sofort deploybarer Zwischenstand.
- **Vor jedem Punkt** die passenden Domaenenregeln lesen: Skills
  `climateflow-data-quality`, `gpx-data-integrity`, `cloudflare-security-sync`,
  `web-quality-baseline` + relevante Eintraege in `docs/knowledge.md`.
- **Kein stiller Fallback, kein vorgetaeuschter Erfolg.** DOM-freie Logik nach
  `lib/core.js` mit Tests (Grenz-/Fehlwerte). Formel-Duplikate in `functions/`
  mitpflegen.
- **Validierung je Punkt:** `npm test`; bei UI `npm run test:e2e`; bei Functions
  `npm run test:functions`; bei Klassen `npm run build:css` (+ `tailwind.css`
  committen); bei SW-Aenderung `CACHE_NAME` in `sw.js` hochzaehlen; bei
  erststartkritischen Aenderungen `npm run perf` vorher/nachher.
- **Nach bestaetigter Ursache + dauerhafter Praevention:** `docs/knowledge.md`
  ergaenzen (nie Secrets/PII/Stacktraces).

---

## Phase A · Zugaenglichkeit & ehrliche Zustaende
Skill: `web-quality-baseline`. Ziel: Kernfeature fuer alle nutzbar, jeder async
Zustand sichtbar.

- **Plan7-1** Chart-a11y: aria-Zusammenfassung + zuschaltbare **Datentabelle**
  je Diagramm (`climateChart`, `archiveChart`, `elevationChart`). Canvas ist
  fuer Screenreader opak — axe/Lighthouse sehen das nicht.
  Dateien: `index.html`, `gpx.html`, `app-analysis.js`, `app-archive.js`,
  `gpx.js`. Test: `a11y.spec.js` erweitern.
- **Plan7-2** Volle **Tastaturbedienung** Leaflet-Karte + Drag-Layout.
  Dateien: `gpx.js`, `app-hub.js`. Test: `e2e.spec.js`.
- **Plan7-3** **State-Audit** Loading/Empty/Offline/Error+Retry ueber ALLE async
  Flaechen (Checkliste + Nachruesten der Luecken). Dateien: quer `app-*.js`,
  `gpx.js`. Test: neue `e2e`-Faelle.

## Phase B · Feed-Resilienz & Datensicherheit
Skills: `cloudflare-security-sync` + `climateflow-data-quality`.

- **Plan7-4** **Last-Known-Good-Cache** (D1) fuer ThingSpeak/Open-Meteo — bei
  Ausfall letzte gueltige Werte statt leer. Dateien:
  `functions/api/feeds/[locId].js`, `functions/api/climate.js`. Test:
  `api.test.js`, `test:functions`.
- **Plan7-5** **Rate-Limit/Quota-Backoff** + Anzeige bei Limitnaehe. Dateien:
  `functions/api/feeds/[locId].js`, `shared.js`. Test: `api.test.js`.
- **Plan7-6** **Verifiziertes Auto-Backup + Retention + Restore-Drill** +
  Cron-Heartbeat-Alarm. Dateien: `functions/api/backup-dump.js`,
  `functions/api/check-alerts.js`. Test: `api.test.js`.
- **Plan7-7** **Self-Service-Gesamtexport** „Meine Daten" (Settings +
  Klimaarchiv + GPX als ein Archiv). Dateien: `app-settings.js`, neue Function.
  Test: `api.test.js`.

## Phase C · Intelligenz-Layer (der eigentliche Mehrwert)
Skill: `climateflow-data-quality`. Alle Formeln DOM-frei in `lib/core.js` +
Tests.

- **Plan7-8** **Anomalie-/Trend-Erkennung** („Feuchte steigt seit 3 Tagen") →
  Push. Dateien: `lib/core.js`, `functions/_notify.js`, `app-settings.js`
  (`NOTIFY_TYPES`). Test: `core.test.js` (Grenz-/Fehlwerte).
- **Plan7-9** **Raum-Vergleichs-Matrix** (Temp/Feuchte/Komfort/Schimmel
  side-by-side). Dateien: `index.html`, `app-analysis.js`. Test: `e2e.spec.js`.
- **Plan7-10** **„Bester Lueftungszeitpunkt heute"** (Aussentaupunkt vs. innen,
  stuendlich). Dateien: `lib/core.js`, `app-core.js`. Test: `core.test.js`.
- **Plan7-11** **Klima-Ziele/Budget** je Raum + „Tage im gruenen Bereich"-Score.
  Dateien: `lib/core.js`, `app-analysis.js`. Test: `core.test.js`.

## Phase D · Sicherheit & Observability
Skills: `cloudflare-security-sync` + `web-quality-baseline`.

- **Plan7-12** **CSP-Report-Endpoint** (`report-to`) → speist `error-log`.
  Dateien: `_headers`, `functions/_middleware.js`, `functions/api/error-log.js`.
  Test: `test:functions`.
- **Plan7-13** **Fehler-Trend-Ansicht** (Rate/Spike statt nur Ringpuffer) +
  Alarm bei Haeufung. Dateien: `app-settings.js`, `functions/api/error-log.js`.
  Test: `api.test.js`.
- **Plan7-14** **Produktions-Synthetic-Monitoring** (geplanter Endpunkt-Ping →
  Push bei Ausfall). Dateien: `functions/api/check-alerts.js`. Test:
  `api.test.js`.
- **Plan7-15** **Vendor-CVE/Versions-Check** als CI-Job
  (Leaflet/Chart/Hammer/exifr/lucide). Dateien: `.github/workflows/ci.yml`,
  neues Script. Test: CI-Job gruen.
- **Plan7-16** **Auth-Haertung-Review** (Session-Ablauf/Rotation,
  Login-Rate-Limit) dokumentieren & absichern. Dateien: `functions/_auth.js`,
  `functions/_middleware.js`. Test: `api.test.js`.

## Phase E · Robustheit & Architektur-Tiefe
Skills: `gpx-data-integrity` + `cloudflare-security-sync`.

- **Plan7-17** **Versionierte D1-Migration** (`schema_version`) statt
  per-Request-`ALTER`. Dateien: neue `functions/_schema.js`, betroffene
  API-Handler. Test: `api.test.js`.
- **Plan7-18** **Einheitlicher Sync-Status-Indikator** + „Jetzt synchronisieren".
  Dateien: `settings-sync.js`, `shared.js`, `index.html`. Test: `e2e.spec.js`.
- **Plan7-19** **IndexedDB-Korruptions-/Recovery-Strategie**. Dateien: `gpx.js`.
  Test: `e2e.spec.js`.
- **Plan7-20** **GPX-Aufzeichnungs-Absturzsicherung** (periodisch persistieren +
  Recovery nach Neustart). Dateien: `gpx.js`. Test: `e2e.spec.js`.

## Phase F · Politur (optional, leicht)
- **Plan7-21** Druck-/Teil-Ansichten fuer Wochen-/Monatsbericht.
- **Plan7-22** *(optional)* Layout-Presets & Reset der Hub-Widgets.
- **Plan7-23** Onboarding-Assistent vertiefen (Kanal → Raeume → Kalibrierung →
  Warnregeln).

---

## Bewusst NICHT in dieser Runde
- **#25 Micro-Perf** (Chart-Lazy-Init, Ladereihenfolge-Feinschliff): `docs/PERF.md`
  zeigt bereits Top-Werte, echter Grenznutzen ~0 — nur bei konkretem Messbefund.
