# Design & Anti-Slop — Zusammenspiel mit `hallmark`

Dieses Skill **ersetzt `hallmark` nicht** und dupliziert seine Inhalte nicht.
`hallmark` ist das Design-Skill (Token-System, 58-Gate-Slop-Test, „gemacht statt
generiert"). Hier steht nur, **wie beide zusammenspielen** und welche
Design-Erkenntnisse die Qualitäts-Gates berühren.

## Reihenfolge im neuen Projekt

1. **`hallmark` zuerst** für die Optik: Theme wählen (Katalog oder Custom),
   OKLCH-Token-System aufsetzen, Struktur-Varietät statt Template-Rhythmus,
   Slop-Test fahren. → das Skill `hallmark` per Name/Verb aufrufen.
2. **Dann die Qualitäts-Gates dieses Skills**, die das Design absichern (axe
   für Struktur-a11y, Lighthouse für Kontrast/BP). Erst wenn ein echtes
   Token-System steht, lohnt die a11y-Absicherung — sie schützt genau diese
   Arbeit vor Regression.

## Token-Disziplin (die Regel, die alles zusammenhält)

**Nie rohe Farbwerte einführen — immer ein Token ergänzen.** Konkret bewährt:

- Design-Tokens als OKLCH in *einer* Quelle (`:root` dunkel, `html.light` =
  Token-Flip). Der Framework-Config (z. B. `tailwind.config.js`) mappt die
  Utility-Klassen auf die Tokens — Komponenten sehen nur semantische Namen.
- **Ein** Akzent + semantische Statusfarben (success/warn/error). Kein zweiter
  „auch schöner" Ton.
- Chart-/Viz-/Karten-Farben über *eine* Token-Brücke (z. B. eine
  `chartToken()`/`viz.<rolle>()`-Funktion), nie rohe Hex/rgb in JS. Das gilt für
  **alle** Diagramme, Kartenrouten, Heatmaps — sonst driften Viz-Farben und
  Theme auseinander (das ist ein eigenes Slop-Gate).
- Messwerte/Uhrzeiten in `font-mono tabular-nums` (springt nicht beim Zählen).
- Keine Emojis als UI-Sprache, keine Verlaufs-Deko, keine Glow-Blobs, kein
  Panel-Glas als Default (flache Flächen; ein einziger erlaubter Blur z. B. für
  eine Floating-Nav-Pille).

Diese Regeln in die `CLAUDE.md` des Projekts schreiben, damit spätere Runden
sie nicht aus Versehen brechen.

## Slop-Test-Stamp

Vor jedem Design-Deploy den Slop-Test von `hallmark` fahren und das Ergebnis als
Stamp im Kopf der Token-Quelldatei hinterlegen (z. B. `tailwind.input.css`).
So ist auf einen Blick sichtbar, gegen welche Gate-Version zuletzt geprüft wurde.

## Berührungspunkt mit den a11y-Gates: die Kontrast-Entscheidung

Der wichtigste Reibungspunkt zwischen Design und a11y: **ein vivid Akzent-Ton
als kleiner Statustext trifft 4,5:1 (WCAG AA) oft nicht ohne Pastellierung.**

Falscher Reflex: axe-Kontrast als hartes pro-Knoten-Gate anschalten → CI zwingt
zur Verwässerung des Akzents.

Richtiger Weg (im Projekt so gelöst):
- **axe** prüft Struktur hart, Kontrast dort **aus**
  (`disableRules(['color-contrast'])`).
- **Lighthouse-a11y** (gescort, ≥ 0.90) beobachtet den Kontrast trotzdem — als
  Score, nicht als pro-Knoten-Bruch. Ein einzelner grenzwertiger Akzent-Text
  senkt den Score minimal, sprengt aber nicht die CI.
- Muted-Text-Token so justieren, dass **kleine Fließtext-Labels** ≥ 4,5:1
  liegen (das ist Pflicht, kein Akzent-Sonderfall). Nur der bewusst-vivide
  *Akzent* darf als Design-Entscheidung leicht darunter liegen — und wird in
  einer eigenen Runde adressiert, nicht durch ein rotes Gate erzwungen.

Diese Zweiteilung ist die zentrale übertragbare Erkenntnis: **harte Gates für
alles Strukturelle/Eindeutige, gescorte Gates für alles, wo Design-Ermessen
legitim mitspielt.**
