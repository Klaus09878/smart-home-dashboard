---
name: working-standards
description: "Personalisierte Arbeits- und Best-Practice-Standards fuer Code-Aufgaben. Zu Beginn JEDER Implementierungs-/Refactor-/Review-Aufgabe anwenden: die Lean-Entscheidungsleiter (erst pruefen, ob Code ueberhaupt noetig ist bzw. schon existiert) PLUS die im Projekt hart erarbeiteten Lehren (ehrliche Zustaende, keine erfundene Arbeit, DOM-freie getestete Logik, keine externen Laufzeit-Deps). Bei Konflikt zwischen generischem Rat und der hier gemachten Projekterfahrung GEWINNT die Projekterfahrung. Fuer Test-/CI-/Architektur-Details an web-quality-baseline weiterreichen, fuer Design an hallmark, fuer Domaenen an die climateflow-/gpx-/cloudflare-Skills."
---

# Working Standards (personalisiert)

Der destillierte Arbeitsstil aus der Zusammenarbeit an diesem Projekt, verschmolzen
mit der bewaehrten „Lean/lazy-senior"-Denkweise (Idee u. a. aus dem ponytail-Skill:
*„Der beste Code ist der, den man nie schreibt."*). Dies ist die **Denk- und
Entscheidungs**-Schicht; die konkreten Test-/CI-/Architektur-/Design-Regeln stehen
in den anderen Skills und werden hier NICHT wiederholt.

## Vorrangregel (die wichtigste Regel)

Wenn ein **allgemeiner** Best-Practice-Rat und die **hier im Projekt gemachte
Erfahrung** sich widersprechen, **gewinnt die Projekterfahrung**. Die generische
Leiter unten ist der Startpunkt; die *Overrides* darunter sind der personalisierte
Standard und stechen sie.

## Lean-Entscheidungsleiter (bevor Code entsteht)

1. **Muss es das ueberhaupt geben?** (YAGNI — kein Feature auf Vorrat.)
2. **Gibt es das schon im Code?** → ZUERST suchen (`grep`/lesen), dann erst bauen.
   In diesem Projekt existierte mehr, als es schien (Voll-Export, Reorder-Buttons,
   Backup-Retention, Wake-Lock, State-Handling) — vorhandenes **erweitern statt
   neu bauen**.
3. **Standardbibliothek / native Plattform-Funktion** statt Eigenbau?
4. **Schon vorhandene (gevendorte) Abhaengigkeit** nutzen — aber **keine neue
   ziehen** (Override 2).
5. **Geht es in einer Zeile / als minimale Erweiterung** des Vorhandenen?
6. **Erst dann** minimalen, funktionierenden Code schreiben.

## Projekt-Overrides (Erfahrung schlaegt generischen Rat)

1. **Robustheit vor Minimalismus.** „Minimal" heisst nicht „nackt". Jede async
   Flaeche braucht sinnvolle Loading-/Empty-/Offline-/Error-States **mit Retry** —
   auch wenn das mehr Code ist. **Kein stiller Fallback, kein vorgetaeuschter
   Erfolg, „leer" ≠ „fehlgeschlagen"** (siehe `docs/knowledge.md` KB-3).
2. **Keine externen Laufzeit-Deps / fremden Plugins.** Lean sagt „nutze eine
   installierte Dependency"; hier gilt: stdlib / native / kleiner eigener Code >
   neue Dependency, und **ein kleines lokales Skill > ein Marketplace-Plugin**
   (genau die ponytail-Entscheidung selbst). CSP streng, alles self-hosted.
3. **DOM-freie Logik nach `lib/core.js` + Tests** (Grenz-/Fehlwerte). Wiederverwenden
   statt duplizieren; bewusste Duplikate (z. B. Formeln in Functions) markieren und
   beide Stellen pflegen.
4. **Ehrlichkeit vor Tempo und Schein-Vollstaendigkeit.** „Ist schon reif / keine
   Luecke" sagen, wenn es stimmt — **keine Arbeit erfinden**. Fehlschlaege mit
   Output zeigen, „teilweise" nicht als „fertig" verkaufen, Marketing-Zahlen
   skeptisch pruefen.
5. **Gegen die Realitaet arbeiten, nicht raten.** Vor dem Aendern die Datei lesen;
   vor dem Bewerten eines Tools/Repos es tatsaechlich ansehen; vor „fertig" die
   passenden Tests wirklich laufen lassen.

## Arbeitsweise (Kurzform — Details in `web-quality-baseline`)

- Ein Punkt = ein Commit; **lokal gruen vor Merge**; phasenweise nach `main`.
- Klassen-/Cache-/Startzeit-Regeln beachten (`build:css` + `tailwind.css` committen,
  `CACHE_NAME` hochzaehlen, `npm run perf` bei Erststart-Aenderungen).
- Nach bestaetigter Ursache + dauerhafter Praevention: Eintrag via `knowledge-learning`.

## Weiterreichen (keine Doppelregeln)

- Test / CI / Architektur → **`web-quality-baseline`**
- Design / Anti-Slop → **`hallmark`**
- Domaenen → **`climateflow-data-quality`**, **`gpx-data-integrity`**, **`cloudflare-security-sync`**
- Lern-Workflow / Wissensdatenbank → **`knowledge-learning`**

## Portabilitaet

Projekt-unabhaengig gehalten. Ins naechste Projekt mitnehmen: den Ordner
`.claude/skills/working-standards/` kopieren (oder nach `~/.claude/skills/` fuer
globale Verfuegbarkeit). Die Overrides sind bewusst der personalisierte Kern —
sie gelten auch dort, wo ein generischer Rat etwas anderes vorschlaegt.
