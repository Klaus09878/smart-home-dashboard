---
name: knowledge-learning
description: "Verbindlicher Lern-Workflow fuer die Projekt-Wissensdatenbank docs/knowledge.md. Anwenden zu Beginn UND zum Abschluss jeder groesseren Aufgabe an Architektur, Datenfluss, UI, API, Auth, Persistenz, Tests, Performance oder Sicherheit: relevante Eintraege vorher lesen, angewandte Erkenntnisse im Abschlussbericht nennen, und nur bei bestaetigter Ursache + dauerhafter Praevention einen Eintrag ergaenzen."
---

# Wissensdatenbank — Lern-Workflow

Die Wissensdatenbank (`docs/knowledge.md`) ist eine kleine, qualitaetsgesicherte
Langzeit-Erinnerung fuer **projektspezifische, bestaetigte** Fehler. Sie ist
**kein** Debug-Protokoll, **kein** Testersatz und **keine** Sammlung von
Vermutungen.

## Ablauf je Aufgabe

1. **Vorher lesen:** die zur Aufgabe passenden Eintraege in `docs/knowledge.md`
   lesen und in Analyse, Plan, Implementierung und Review beruecksichtigen.
2. **Abschlussbericht:** angewandte relevante Erkenntnisse ausdruecklich nennen.
3. **Nachher ergaenzen:** nur wenn Ursache bestaetigt und Praevention dauerhaft
   ist (siehe Zulaessigkeit).

## Ein Eintrag ist nur zulaessig, wenn mindestens eines gilt
- Ein Fehler ist **reproduzierbar** aufgetreten, Ursache **und** Loesung
  verifiziert.
- Der Nutzer gab eine Korrektur, aus der eine **wiederverwendbare** Regel folgt.
- Ein Test/Linter/Build/E2E/Functions-Smoke/Perf-Test/Review hat einen
  **konkreten** Fehler aufgedeckt und die endgueltige Praevention ist klar.
- Eine produktionsrelevante Regression wurde **nachweislich** verhindert.

## Nicht speichern
Vermutungen, temporaere Debug-Schritte, triviale Tippfehler, ungepruefte
Ansaetze, Duplikate — und **niemals** Secrets, IDs, Tokens, private URLs, PII
oder komplette Stacktraces.

## Eintragsformat (siehe Kopf von `docs/knowledge.md`)
Kurz und pruefbar: **Bereich/Tags · Symptom · bestaetigte Ursache ·
Praeventionsregel · Referenz** (Test/Datei/Check/Commit, falls vorhanden).

## Vor dem Schreiben
- Nach Duplikaten/Widerspruechen suchen (`grep` in `docs/knowledge.md`).
- Bestehenden Eintrag **aktualisieren** statt duplizieren.
- Pruefen, ob die Praevention wirklich umsetzbar ist — als Test, Validierung,
  Architekturregel oder Checkliste. Wo moeglich, die Regel zusaetzlich im
  passenden Domaenen-Skill (`climateflow-data-quality`, `gpx-data-integrity`,
  `cloudflare-security-sync`) verankern, damit sie beim naechsten Mal greift.
