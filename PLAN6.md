# Umsetzungsplan Runde 6 — Design-Redesign („Anti-AI-Slop", hallmark)

> **Status: ✅ umgesetzt** (Commits `Plan6-1` … `Plan6-5`). Verifiziert je Etappe:
> `npm test` (109), `npm run lint`, `npm run test:e2e` (9/9); Screenshots aller
> fünf Views in beiden Themes; `npm run perf` ohne Regress (docs/PERF.md,
> Gerüst−DCL = 0 ms). Richtung nach zwei Feedback-Runden am Hub-Probelauf:
> **„Instrument", modern-minimal, moderne Web-App-Signaturen** (hallmark N5
> Floating-Pill-Nav, Token-System, Mono-Messwerte, EIN Teal-Akzent, flache
> Panels statt Glas, Pill-CTAs, keine Emojis/Glows/Verläufe).
> Verbindliches System: `design.md` (gesperrt). Restarbeiten für eine spätere
> Runde: Kompat-Restblock in tailwind.input.css auflösen (unmigrierte Hues in
> Detailbereichen von ClimateFlow/GPX), `.glass-panel` → `.panel` umbenennen,
> Heatmap-/GPX-Chart-Chrome auf chartToken() umstellen.
>
> Ursprüngliches Ziel: das „typisch Kindische"/KI-Generische aus dem Design entfernen,
> per Voll-Redesign auf Basis des gevendorten hallmark-Skills
> (`.claude/skills/hallmark/`, MIT, Upstream `Nutlope/hallmark`). Arbeitsweise wie
> immer: ein Punkt = ein Commit (`Plan6-N:`), Tests/build:css/SW-Bump je Etappe.
> hallmark-Modus: `redesign` (Multi-Page-Flow) — Routen, Informationsarchitektur,
> Texte und Funktionalität bleiben; NUR die visuelle Schicht wird ersetzt.

## Pre-flight-Scan (hallmark Schritt 0)

```
Pre-flight findings:
· Font-Stack: Outfit 300–700, lokal (vendor/fonts, @font-face tailwind.input.css L9–13)
· Palette: keine Tokens — ad hoc Tailwind-Palette (slate/teal/indigo/orange/amber/…)
  quer durch HTML UND JS-Template-Strings; heller Modus als html.light-Remap-Schicht
  (tailwind.input.css L52 ff.)
· Motion: keine Motion-Library (motion-cut); CSS-Transitions + zwei Keyframes
  (fade-in/slide-up, tailwind.config.js)
· Spacing: Tailwind-Default (4-pt-Raster implizit)
· Framework: Vanilla HTML + klassische Skripte, Tailwind 3.4 statischer Build,
  Cloudflare Pages; CSP erlaubt NUR lokale Fonts/Styles (Projektregel 9)

hallmark bewahrt: Informationsarchitektur, deutsche Texte, Funktionalität,
  Dark-Mode-first + heller Modus, lokale Font-Strategie.
hallmark führt ein: benanntes Token-System (Farben/Radien/Schatten/Typo),
  ein Genre + EIN Akzent statt Hue-Jonglage, Slop-Test-Gates.
```

## Audit (hallmark Schritt „audit" — Befunde, kein Edit)

**Kritisch (wirkt KI-generiert / Ursache des „Kindischen"):**
1. **Glassmorphism flächendeckend** — `.glass-panel` (tailwind.input.css L34, 51× in
   index.html, 15× gpx.html, 1× login.html): backdrop-blur-Glas ist in JEDEM
   hallmark-Genre gebannt. → Ersetzen durch flache Papier-/Elevationsflächen mit Tokens.
2. **Kein Token-System** — Farben/Radien ad hoc; hallmark-Kernregel „Locked tokens".
   → `:root`-Tokens (OKLCH) + Tailwind `theme.extend`, alles referenziert Namen.
3. **Akzent-Hue-Jonglage** — teal + indigo + orange + amber + emerald + sky + violet +
   rose gleichzeitig als Deko. → EIN Markenakzent (Teal bleibt) + semantische
   Statusfarben (ok/warn/alarm) NUR mit Bedeutung.
4. **Gradient-Text** — Uhr `bg-clip-text text-transparent` (index.html L103):
   hallmark Gate 2, global gebannt. → einfarbige Ziffern, tabular-nums.

**Major:**
5. **Deko-Verlaufs-Chips & -Buttons** — 18 `bg-gradient-to-*` in index.html (Projekt-
   Icons, Zahnrad-Chip, Login-/Upload-CTAs). → flache Flächen, 1 Akzent, klare Kanten.
6. **Glow-Blobs** — `blur-[100px]`-Kreise auf allen 3 Seiten (index L57/58, gpx L40/41,
   login L28/29). → ersatzlos streichen (bzw. Richtung B: EIN ruhiger Bloom).
7. **Emojis als UI-Sprache** — 👋 (Begrüßung, Onboarding), 🎉 (To-do leer, Onboarding),
   🔥 (GPX-Rekorde/Serie). → Text bzw. Lucide-Icons in Akzent-/Statusfarbe.
8. **Einheitsbrei-Radius** — 51× `rounded-2xl`, alles gleich blobby. → Radius-Tokens
   (Karte/Steuerfläche/Pille getrennt, deutlich straffer).
9. **Typografie ohne Instrumenten-Charakter** — Outfit (rund-geometrisch) für alles;
   Messwerte ohne `tabular-nums`/Mono. → Zahlen auf Mono/tabular, Hierarchie über
   Gewicht + Größe statt Farbe.
10. **Glow-Hover-Schatten** (glass-card-hover, teal Schein) + `shadow-lg` überall.
    → Elevation über Flächenhelligkeit/1-px-Kanten, max. ein dezenter Schatten-Token.

**Minor:**
11. Pastell-Pillen („Live", Badges) als Deko ohne Information; 12. `tracking-wider`-
Uppercase-Labels inkonsistent; 13. Scrollbar-/Leaflet-Styling hartkodiert statt Tokens.

**Zählung: 4 kritisch · 6 major · 3 minor.**

## Richtungsvorschläge (Genre + Theme, hallmark-Katalog)

**A — „Instrument" (modern-minimal, Cobalt-adaptiert) — EMPFEHLUNG.** Messgeräte-/
Instrumententafel-Charakter: ruhige, fast monochrome Flächen (dunkel: tiefes
Neutral-Schieferblau OHNE Glas; hell: kühles Off-White), 1-px-Linienzüge statt
Schatten, straffe Radien (~6 px), EIN Teal-Akzent, Messwerte in Mono/tabular-nums,
Labels als stille Uppercase-Miniaturen. Dark-first bleibt, heller Modus wird
gleichwertig. Passt am besten zu „Klimadaten ablesen".

**B — „Nachtpult" (atmospheric, Midnight/Terminal-Familie).** Bewusst dunkel und
ruhig: tiefer Canvas, EIN warmer oder teal Bloom (statt sechs Glow-Blobs), erhöhte
Karten über Flächenhelligkeit, Mono-Anteile. Behält die heutige Nacht-Stimmung,
entfernt Glas/Verläufe/Emojis. Heller Modus bleibt Zweitbürger.

**C — „Werkblatt" (editorial-technisch).** Papierartig, hairline-Linien, Serif-Display
für Überschriften, sehr zurückhaltend. Eleganteste Option, aber am weitesten vom
heutigen Charakter entfernt und für ein Live-Dashboard die riskanteste.

## Vorgehen (nach hallmark `redesign` § Multi-page)

- **Plan6-2 (Probelauf):** `design.md` (verbindliches System, Richtung A) + Tokens
  (`tailwind.input.css` `:root` + `theme.extend`) + Hub-View umbauen. Screenshots
  hell+dunkel an Sean → **Freigabe-Gate** (bestätigen / Richtung wechseln / stoppen).
- **Plan6-3 …:** je ein Commit pro View: ClimateFlow (inkl. Chart.js-Farben aus
  Tokens), Einstellungen, GPX-Viewer (inkl. Leaflet), Login. Slop-Test-Gates je View.
- **Abschluss:** PLAN6-Status, CLAUDE.md, `npm run perf` Vorher/Nachher, Push.
- Invarianten je Etappe: `npm test` + `npm run lint` + `npm run test:e2e` grün,
  `npm run build:css`, SW-Bump, CSP unangetastet (Fonts nur lokal).
