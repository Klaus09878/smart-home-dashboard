# Design — Smart Home Hub

Verbindliches Design-System (hallmark `redesign`, Multi-Page-Flow, Runde 6).
Jede View-Umgestaltung liest DIESE Datei; nicht pro Seite neu erfinden —
erweitern/ändern nur hier. **Status: GESPERRT
(Rollout Plan6-2…6-6 abgeschlossen) — Änderungen nur über diese Datei.**

## Genre

modern-minimal — Richtung „Instrument": Messgeräte-Charakter, ruhige fast
monochrome Flächen, 1-px-Kanten statt Schatten/Glas, EIN Akzent.

## Makrostruktur-Familie

- App-Views (Hub, ClimateFlow, Einstellungen, GPX): **Workbench** — Karten auf
  Arbeitsfläche, Reihenfolge = Informationshierarchie, KEINE Enrichments.
- Login: einzelne zentrierte Karte, Typografie-only.

## Theme (Tokens — Quelle: tailwind.input.css `:root` / `html.light`)

OKLCH-Komponenten (L C H), hell = Token-Flip. Tailwind mappt `slate`/`teal`/
`white`-Klassen darauf (tailwind.config.js) — Klassen in Markup/JS bleiben,
bekommen aber Token-Werte.

| Token | dunkel | hell | Rolle |
|---|---|---|---|
| `--sh-paper` | 15% 0.016 252 | 96.5% 0.004 250 | Seite |
| `--sh-surface` | 19.5% 0.016 252 | 99% 0.002 250 | Karten |
| `--sh-rule` | 27% 0.015 252 | 88% 0.007 250 | 1px-Linien, flache Chips |
| `--sh-rule-2` | 34% 0.014 252 | 79% 0.010 250 | Hover-Linien |
| `--sh-ink` … `--sh-ink-5` | 96.5→45% | 21→62% | 5-stufige Schrift-Leiter |
| `--sh-accent` | 74% 0.115 183 | 49% 0.105 188 | DER Akzent (Marke Teal) |
| `--sh-accent-soft/-strong/-ink` | s. Datei | s. Datei | Abstufungen/Fülltext |

**Statusfarben sind semantisch, nie dekorativ:** ok = emerald, Hinweis = amber,
Alarm = red — nur an Stellen mit echter Bedeutung (Badges, Warnbanner,
Schwellwert-Verletzungen). Deko-Verwendungen von indigo/orange/sky/violet/rose
werden im Rollout entfernt. Neue Farben NIE inline — Token ergänzen.

## Typografie

- Display + Body: **Outfit** (lokal, vendor/fonts) — Gewichte 400/500/600;
  Überschriften 600 `tracking-tight`, roman (nie kursiv).
- **Messwerte/Uhrzeiten: `font-mono tabular-nums`** (System-Mono-Stack, kein
  Download) — der Instrumenten-Kern des Themes.
- Daten-Labels: 10–11 px, uppercase, `tracking-wider`, ink-4 — sparsam.
- Kein Gradient-Text, keine Emojis als UI-Sprache (Lucide-Icons stattdessen).

## Flächen & Geometrie

- Panels: `--sh-surface` + 1px `--sh-rule` (Klasse `.panel`, interaktive
  Karten zusätzlich `.card-hover`). KEIN backdrop-blur, KEINE Glow-Blobs,
  KEINE Verlaufs-Chips/-Buttons, KEINE Standard-Schatten auf Karten.
- Radien: Karten `--sh-radius-card` (10px, `rounded-2xl`), Controls
  `--sh-radius-control` (6px, `rounded-lg/-xl`), Pillen nur `rounded-full`
  für echte Pillen (Toggles, Statuspunkte).
- Elevation über Flächenhelligkeit + Kanten; Schatten nur auf Popovern.

## Motion

- Easing: `--sh-ease` = cubic-bezier(0.16, 1, 0.3, 1); Dauer ≤ 200 ms.
- Nur `transform`/`opacity`; Hover = 1px-Lift + Kantenfarbe, kein Glow/Scale.
- `prefers-reduced-motion`: bestehende Regeln bleiben.

## Fokus & Interaktion

- `:focus-visible`: 2px Akzent-Ring, offset 2px, nie animiert (global gesetzt).
- Stiller Erfolg (Toasts sparsam), Fehlertexte konkret. Bestehende
  modalPrompt/modalConfirm-Muster bleiben.

## Was alle Views teilen MÜSSEN

Token-Satz, Typo-Regeln (inkl. Mono-Messwerte), EIN Akzent + semantische
Statusfarben, Radius-/Kanten-System, Fokus-Ring, deutsche Texte.

## Was Views unterscheiden DÜRFEN

Dichte (GPX-Viewer dichter als Hub), Kartenraster, view-spezifische
Komponenten (Chart, Karte, Heatmap) — alles aus denselben Tokens.

## Chart/Karte (Rollout-Pflicht)

Chart.js-Farben und Leaflet-Look beziehen ihre Werte aus den Tokens
(getComputedStyle-Helfer statt hartkodierter rgba-Strings).
