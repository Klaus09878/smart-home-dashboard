---
name: web-quality-baseline
description: "Qualitäts-, Test- und CI-Grundgerüst für neue oder bestehende Web-Frontends (statisch / Cloudflare Pages / Vanilla-JS-SPAs). Nutzen, wenn ein neues Web-Projekt aufgesetzt wird oder wenn Tests, CI, Barrierefreiheit (axe/Lighthouse), Functions-Runtime-Smoke, Security-Scan (CodeQL) oder eine saubere Commit-/Merge-Arbeitsweise eingerichtet werden sollen. Für das visuelle Design an das hallmark-Skill weiterreichen — dieses Skill deckt Qualität/Automatisierung/Architektur/Arbeitsweise ab, nicht die Optik."
version: 1.0.0
---

# Web-Quality-Baseline

Das destillierte Vorgehen aus dem Smart-Home-Hub-Projekt: wie man ein
Web-Frontend so aufsetzt und absichert, dass es **gemacht** wirkt (Design über
`hallmark`) **und** dauerhaft gemacht bleibt (Tests, CI-Gates, ehrliche
Arbeitsweise). Gedacht als Start-von-null-Playbook für das nächste Projekt —
kein Framework, keine schweren Abhängigkeiten, alles lokal nachvollziehbar.

**Leitphilosophie (nicht verhandelbar):**
- **Lokal verifizierbar vor CI.** Jeder Check muss auf dem eigenen Rechner
  laufen, bevor er die CI blockiert. CI wiederholt nur, was lokal grün war.
- **Schwere Werkzeuge über `npx` in CI, nicht als lokale devDeps.** Der lokale
  Loop bleibt schlank; Lighthouse/wrangler/CodeQL laufen ephemer.
- **Ehrlich über Grenzen.** Jedes Gate dokumentiert, was es *nicht* prüft. Ein
  Test, dessen Lücken man kennt, ist mehr wert als einer, dem man blind vertraut.
- **Ein Punkt = ein Commit.** Kleine, benannte Schritte; lokal grün vor Push.
- **Keine externen Laufzeit-Abhängigkeiten in Produktion.** Fonts lokal, CSP
  streng, kein CDN-Skript. Prüfwerkzeuge dürfen extern sein, das Produkt nicht.

---

## Wann dieses Skill greift

- „Neues Web-Projekt aufsetzen" / „von null starten" → **Start-Checkliste** unten.
- „Tests / CI / Pipeline einrichten" → [`references/testing-und-ci.md`](references/testing-und-ci.md).
- „Barrierefreiheit / a11y absichern" → axe (Struktur) + Lighthouse (Kontrast),
  siehe Testing-Referenz, Abschnitt „Die a11y-Zweiteilung".
- „Security-Scan / verwundbare Deps" → CodeQL (public Repo) bzw. Fallback,
  siehe Testing-Referenz, Abschnitt „Security".
- „Design / Redesign / sieht nach KI-Slop aus" → **an `hallmark` weiterreichen**
  (dieses Skill baut nur die Absicherung *um* das Design herum). Zusammenspiel:
  [`references/design-und-slop.md`](references/design-und-slop.md).
- „Wie war nochmal die Architektur/Arbeitsweise?" →
  [`references/architektur.md`](references/architektur.md) und
  [`references/arbeitsweise.md`](references/arbeitsweise.md).

---

## Start-Checkliste (neues Projekt von null)

Reihenfolge bewusst: erst das Skelett, dann die Gates. Jeder Schritt ist ein
eigener Commit.

1. **Projekt-Kontext festhalten.** Eine `CLAUDE.md` anlegen, die die
   nicht-offensichtlichen Regeln des Projekts festschreibt (Build-Befehl,
   Cache-Versionierung, „diese Datei ist gebaut, nie von Hand editieren",
   Formel-Duplikate). Diese Datei ist das Gedächtnis des Projekts — sie zuerst.
   Muster: [`references/architektur.md`](references/architektur.md).
2. **Kernlogik DOM-frei isolieren.** Reine Rechen-/Parse-Logik in ein
   testbares Modul (UMD/ESM) ohne DOM-Zugriff. Das ist die Basis der
   Unit-Tests und hält die UI-Schicht dünn.
3. **Unit- + Smoke-Tests zuerst** (`node --test`, keine Framework-Deps).
   Der Smoke-Test prüft *Konsistenz* über Dateien hinweg (jede `getElementById`-ID
   existiert im HTML, jeder Inline-Handler ist definiert, jede referenzierte
   Datei existiert, CSP-Hash stimmt). Diese Klasse Test fängt genau die Fehler,
   die ein Vanilla-Projekt ohne Bundler sonst erst im Browser sieht.
   Vorlage: [`references/testing-und-ci.md`](references/testing-und-ci.md).
4. **ESLint** (flat config) + **Build-Freshness-Gate** (falls es einen
   Build-Schritt gibt, z. B. Tailwind: CSS neu bauen und `git diff --exit-code`
   gegen den committeten Stand — verhindert veraltete gebaute Artefakte).
5. **Design über `hallmark`** aufsetzen (Token-System, Slop-Test-Stamp). Erst
   dann lohnen sich die a11y-Gates, weil sie das Design *absichern*.
6. **Browser-E2E (Playwright)** mit statischem Test-Server + **axe-A11y** in
   derselben Suite. Struktur-Barrierefreiheit wird ab hier eine harte Regression.
7. **Lighthouse-CI** für die *gescorten* Kategorien (a11y hart, Perf/BP als
   Warnung). Fängt Kontrast, den axe pro-Knoten nicht hart gaten sollte.
8. **Functions-Runtime-Smoke** (falls Serverless/Edge Functions vorhanden):
   echte Runtime statt Shim, prüft Middleware/Auth/Redirects end-to-end.
9. **Security-Scan** (CodeQL bei public Repo, sonst Fallback).
10. **Alle Checks in einer CI-Datei** bündeln, jeder Job unabhängig. Push-
    Trigger auf den Deploy-Branch + PRs. Deploy selbst bleibt getrennt.

Die konkreten, copy-paste-fertigen Konfigurationen zu Schritt 3–9 stehen in
[`references/testing-und-ci.md`](references/testing-und-ci.md).

---

## Die vier CI-Gates in einem Satz je

Aus dem Projekt destilliert — was jedes Gate leistet und was es **nicht** leistet:

| Gate | Sichert | Blindstelle (ehrlich) |
|---|---|---|
| **axe-core** (in E2E) | Struktur-A11y: Namen, Rollen, ARIA, Tastatur, Labels | Kontrast bewusst aus (`disableRules(['color-contrast'])`) — den macht Lighthouse |
| **Lighthouse-CI** | gescorte a11y (inkl. Kontrast), Best-Practices, PWA | Perf in CI schwankt → nur Warnung, nie hartes Gate |
| **Functions-Smoke** (wrangler) | echte Runtime: Imports, Bindings, Middleware, Auth-Redirects | reproduziert **nicht** Plattform-Quirks oberhalb der Runtime (z. B. Cloudflare Pretty-URL-308) |
| **CodeQL** | statische Security-Analyse (Injection, Auth-Muster, unsichere Regex) | gratis nur bei public Repo; kein Runtime-/Config-Fehler |

Die **a11y-Zweiteilung** (axe = Struktur hart, Lighthouse = Kontrast gescored)
ist die wichtigste Einzel-Erkenntnis: sie verhindert, dass ein kräftiger
Akzent-Ton (der als kleiner Statustext 4,5:1 nicht ohne Pastellierung trifft)
ein pro-Knoten-hartes axe-Gate sprengt — ohne den Kontrast unbeobachtet zu
lassen. Details: [`references/testing-und-ci.md`](references/testing-und-ci.md).

---

## Verhältnis zu `hallmark`

Dieses Skill ist die **Absicherung**, `hallmark` ist das **Design**. Sie
greifen ineinander:

- `hallmark` liefert Token-Disziplin (OKLCH), den 58-Gate-Slop-Test und die
  „gemacht statt generiert"-Regeln. → immer für Optik/Redesign/Audit.
- `web-quality-baseline` sorgt dafür, dass die von `hallmark` erzeugte Qualität
  **nicht wieder wegregrediert** (a11y-Struktur, Kontrast, Security, Runtime).

Beim nächsten Projekt: `hallmark` für das Design fahren, **dann** die
Start-Checkliste dieses Skills. Reihenfolge in
[`references/design-und-slop.md`](references/design-und-slop.md).

---

## Portabilität

Dieses Skill ist bewusst projekt-unabhängig gehalten. Um es ins nächste Projekt
mitzunehmen: den Ordner `.claude/skills/web-quality-baseline/` in das neue Repo
kopieren (oder nach `~/.claude/skills/` für globale Verfügbarkeit legen). Die
Vorlagen in den Referenzen sind generisch formuliert; projektspezifische Namen
(Views, Ports, Bindings) beim Übernehmen anpassen — die Kommentare markieren die
Stellen.
