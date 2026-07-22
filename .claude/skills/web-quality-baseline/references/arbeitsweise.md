# Arbeitsweise — Commits, Pläne, ehrliche Berichte, Merges

Die Prozess-Disziplin, die die Qualität über viele Runden hält. Weniger über
Werkzeuge, mehr über *Gewohnheiten*.

## 1. Ein Punkt = ein Commit

- Arbeit in benannte Einzelschritte zerlegen; jeder wird ein Commit mit klarem
  Prefix (`PlanN-M:`, `Improve-N:` o. Ä.). Ein Commit macht *eine* Sache.
- **Lokal grün vor Push.** Nie einen Schritt committen, dessen Tests/Lint rot
  sind. Wenn etwas rot ist und out-of-scope: als eigene Aufgabe notieren, nicht
  mit reinmischen.
- Pläne als Datei im Repo festhalten (`PLANn.md`), mit den Arbeitsregeln am
  Kopf. So ist über Runden hinweg nachvollziehbar, was warum entschieden wurde.

## 2. Vor dem Merge lokal die volle Kette fahren

Reihenfolge, die sich bewährt hat, *bevor* nach `main` gemergt wird:

```
npm test            # Unit + Smoke/Konsistenz
npm run lint        # ESLint
npm run test:e2e    # Browser-E2E inkl. axe-a11y
# optional je nach Projekt:
npm run build:css && git diff --exit-code -- tailwind.css   # Build-Freshness
node tests/functions-smoke.mjs                              # falls Functions
```

Erst wenn das alles grün ist, pushen.

## 3. Fast-Forward-Merge nach `main` (sauber, ohne Merge-Commit)

Wenn `main` der Deploy-Branch ist (Push = Auto-Deploy), lohnt ein sauberer
Fast-Forward statt eines Merge-Commits:

```bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD && echo "FF-OK" || echo "NICHT-FF"
# nur wenn FF-OK:
git push origin HEAD:main
```

- **`--is-ancestor` ist das Sicherheitsnetz:** ist `origin/main` *kein* Vorfahr
  von HEAD, wäre es kein sauberer FF → dann erst rebasen, nicht blind pushen.
- Push mit Retry/Backoff bei Netzfehlern (2s, 4s, 8s, 16s).
- **Ein Push auf `main` ist ein Produktions-Deploy** → davor Freigabe einholen,
  außer sie ist ausdrücklich für diese Runde erteilt. Freigabe aus einer
  früheren Runde gilt nicht automatisch für die nächste.

## 4. Nach dem Merge: Erst-Lauf der CI wirklich prüfen

Neue CI-Jobs laufen beim ersten Mal in einer *anderen* Umgebung als lokal.
Nicht annehmen, dass sie grün sind — nachsehen (GitHub-MCP `actions_list` →
`list_workflow_jobs`, Feld `conclusion` je Job). Bei Rot: Job-Logs ziehen,
Ursache diagnostizieren, fixen, neu pushen. Erst grün = fertig.

## 5. Ehrliche Berichte (die wichtigste Gewohnheit)

- **Grenzen jedes Tests mitliefern.** „functions-smoke prüft die Runtime, aber
  nicht die Plattform-308-Redirects" ist mehr wert als ein stilles grünes Häkchen.
- **Wenn etwas nur teilweise erfüllt ist, das sagen** — nicht als erfüllt
  darstellen. („teilweise nach Vorgabe" statt „fertig", wenn es so ist.)
- **Fehlschläge mit Output zeigen**, übersprungene Schritte benennen.
- Bei Design-/Architektur-Ermessen, das mehrere Deutungen zulässt, **nachfragen**
  statt zu raten (ein kurzes gezieltes Frage-Tool schlägt eine falsche Annahme).
- Vor dem Überschreiben/Löschen prüfen, was wirklich dort steht; widerspricht es
  der Beschreibung, das ansprechen statt einfach fortzufahren.

## 6. Was NICHT automatisieren

- **Keine harten Perf-Gates in CI** — Perf-Scores schwanken je Runner-Last;
  hart würden sie grüne PRs flaky rot machen. Nur als Warnung tracken.
- **Keine Tools einbauen, die nicht passen**, nur weil sie existieren. Vor der
  Übernahme eines Fremd-Tools ehrlich prüfen: löst es hier ein reales Problem?
  (Beispiel aus dem Projekt: ein Python-only-Optimizer und ein Repo-Analyse-Tool
  wurden *nicht* übernommen, weil 0 Python bzw. nur marginaler Nutzen bei ~8k
  Zeilen — stattdessen die vier passenden Gates gebaut.)
- **CI und Deploy getrennt denken.** Prüf-Pipeline ≠ Deploy-Pipeline.
