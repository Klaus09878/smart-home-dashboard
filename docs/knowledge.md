# Wissensdatenbank — bestaetigte Fehler & dauerhafte Praevention

Kleine, qualitaetsgesicherte Langzeit-Erinnerung fuer **projektspezifische,
verifizierte** Fehler. **Kein** Debug-Protokoll, **kein** Testersatz, **keine**
Vermutungen. Workflow und Zulaessigkeitsregeln: Skill `knowledge-learning`
(`.claude/skills/knowledge-learning/SKILL.md`).

**Vor jeder groesseren Aufgabe** die passenden Eintraege hier lesen; im
Abschlussbericht angewandte nennen. **Neuer Eintrag nur** bei bestaetigter
Ursache + dauerhafter Praevention. **Nie** Secrets/IDs/Tokens/private URLs/PII/
komplette Stacktraces speichern. Vor dem Schreiben auf Duplikate pruefen und
bestehende Eintraege aktualisieren statt duplizieren.

## Eintragsformat

```
### KB-<nr>: <kurzer Titel>
- **Bereich/Tags:** <z. B. auth, middleware, gpx, climate, a11y, ci>
- **Symptom:** <beobachtetes Fehlerbild>
- **Ursache (bestaetigt):** <verifizierte Grundursache>
- **Praevention (dauerhaft):** <Regel/Test/Validierung/Architekturregel>
- **Referenz:** <Datei/Test/Check/Commit, falls vorhanden>
```

---

## Eintraege

### KB-1: Redirect-Schleife durch Cloudflare Pretty-URL-308
- **Bereich/Tags:** auth, middleware, cloudflare, routing
- **Symptom:** Nach Deploy Endlos-Redirect im Browser („Load cannot follow more
  than 20 redirections"); Login-Seite nicht erreichbar.
- **Ursache (bestaetigt):** Cloudflare Pages normalisiert `/login.html` per
  308 auf die Pretty-URL `/login`. Stand `/login` nicht in den oeffentlichen
  Pfaden bzw. wurde auf `/login.html` weitergeleitet, schob die Middleware den
  nicht angemeldeten Request wieder Richtung Login → Schleife.
- **Praevention (dauerhaft):** `/login` (Pretty-URL) gehoert in
  `PUBLIC_PATHS`/`PUBLIC_PREFIXES` und Redirect-Ziele zeigen auf `/login`, nicht
  `/login.html`. Der Functions-Smoke prueft, dass `/` (nicht angemeldet) auf ein
  Ziel mit `/login` weiterleitet und `/login` selbst 200 liefert. Wichtig: der
  Smoke reproduziert die 308-Normalisierung **nicht** — Pretty-URL-Verhalten
  bei Redirect-Aenderungen bewusst mitdenken.
- **Referenz:** `functions/_middleware.js` (`PUBLIC_PATHS`),
  `tests/functions-smoke.mjs`.

### KB-2: axe-Kontrast-Gate vs. bewusster vivid Akzent
- **Bereich/Tags:** a11y, ci, design
- **Symptom:** Ein hartes axe-`color-contrast`-Gate wuerde die CI rot faerben,
  weil der Teal-Akzent als kleiner Statustext 4,5:1 nicht ohne Pastellierung
  trifft — Design-Entscheidung vs. Gate im Konflikt.
- **Ursache (bestaetigt):** axe prueft Kontrast pro Knoten hart; ein einzelner
  bewusst kraeftiger Akzent-Text bricht das Gate, obwohl es eine legitime
  Design-Wahl ist.
- **Praevention (dauerhaft):** Zweiteilung — **axe** deckt STRUKTUR hart ab
  (Namen/Rollen/ARIA/Tastatur, `disableRules(['color-contrast'])`), **Lighthouse**
  beobachtet Kontrast als **gescorte** A11y-Kategorie (≥ 0,90 hart, aber nicht
  pro Knoten). Kleine Fliesstext-Labels muessen trotzdem ≥ 4,5:1 liegen; nur der
  bewusste Akzent darf als Design-Entscheidung leicht darunter bleiben.
- **Referenz:** `tests/a11y.spec.js` (disableRules), `.lighthouserc.json`
  (`categories:accessibility` ≥ 0,90).

### KB-3: Ladepfade muessen „leer" von „fehlgeschlagen" unterscheiden
- **Bereich/Tags:** ui, states, error-handling
- **Symptom:** Ein `apiFetch`-Ladepfad faengt jeden Fehler und zeigt danach eine
  leere/versteckte Liste — ein transienter Netzfehler ist damit unsichtbar und
  wirkt wie „keine Daten" (Beispiel: Server-Backup-Panel wurde bei jedem Fehler
  ausgeblendet).
- **Ursache (bestaetigt):** Ein `catch`, der `unavailable` (Feature/Endpunkt/R2
  nicht vorhanden) nicht von einem echten transienten Fehler trennt.
- **Praevention (dauerhaft):** In Ladepfaden `err.unavailable` gesondert
  behandeln (Feature aus → ausblenden/Hinweis ist ok), jeden anderen Fehler
  **sichtbar** machen mit „Erneut versuchen". Nie einen echten Fehler als leeren
  Zustand tarnen (Domaenenregel „kein stiller Fallback"). Mutationen zeigen
  bereits `showNotification(..., 'error')` — Ladepfade genauso ehrlich halten.
- **Referenz:** `app-settings.js` `renderServerBackups` (Plan7-3);
  Skill `climateflow-data-quality`/`cloudflare-security-sync`.
