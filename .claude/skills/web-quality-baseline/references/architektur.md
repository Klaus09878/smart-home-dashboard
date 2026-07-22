# Architektur-Muster (Vanilla / Static / Edge)

Die tragenden Muster aus dem Smart-Home-Hub — übertragbar auf jedes
bundlerlose Web-Frontend mit optionalem Edge-Backend. Kein Muster ist Pflicht;
jedes löst ein konkretes Problem, das benannt ist.

## 1. `CLAUDE.md` als Projektgedächtnis (zuerst anlegen)

Die wertvollste Datei im Repo für die Zusammenarbeit mit einem KI-Assistenten.
Sie hält die **nicht-offensichtlichen** Regeln fest, die man sonst jedes Mal neu
herleitet oder bricht. Bewährte Rubriken:

- **Was ist gebaut, nie von Hand editieren** (z. B. `tailwind.css`) — und der
  Befehl, der es neu baut.
- **Cache-Versionierung**: welche Zahl hochzählen, wenn gecachte Dateien sich
  ändern (Service-Worker `CACHE_NAME`).
- **Bewusste Duplikate**: welche Formel an zwei Stellen lebt und warum, mit dem
  Hinweis „bei Änderung beide anfassen".
- **Ladereihenfolge/Scope-Regeln** bei bundlerlosem Code (s. u.).
- **Datenquellen-Eigenheiten** (Komma-Dezimal, asynchrone Felder, Zeitformate).
- **Zuständigkeit je Datei** in einem Satz.

## 2. Kein Bundler: klassische Skripte, gemeinsamer globaler Scope

Wenn bewusst kein Bundler genutzt wird (schnellster First-Paint, keine
Build-Kette für den Deploy):

- Code in mehrere klassische `<script>`-Dateien zerlegen, die sich einen
  globalen Scope teilen. **Die Reihenfolge im HTML = die Abhängigkeitsreihenfolge.**
  Top-Level-Aufrufe (Factories, die sofort laufen) müssen *vor* ihrer Nutzung
  definiert sein.
- Beim Verschieben von Code die Ladereihenfolge mitdenken — der Smoke-Test
  (Konsistenztest) fängt fehlende IDs/Handler, aber nicht jede Reihenfolge-Falle.
- Reine Logik in ein DOM-freies UMD/CJS-Modul (`lib/core.js`) auslagern → testbar
  ohne Browser, wiederverwendbar in Edge-Functions.

## 3. Profil-/Einstellungs-Sync über einen `Store`, nie roh

Wenn es Mehrbenutzer-Profile mit synchronisierten Einstellungen gibt:

- **Nie roh `localStorage` für profilbezogene Werte** lesen/schreiben. Eine
  `Store`-Abstraktion kapselt profil-gescopte Schlüssel (`p_<profil>_<key>`) +
  Spiegelung ins Backend (Offline-Queue, `updatedAt`-Merge).
- Gerätelokale Dinge (Dedupe-Zeitstempel, ausstehende Löschungen) bleiben
  bewusst bei rohem `localStorage` — die Grenze klar in `CLAUDE.md` ziehen.
- `init()` wartet auf `await Store.init()`, **bevor** Einstellungen gelesen
  werden.
- Pref-Bündel nur über Getter lesen, die Defaults mergen (`getAppPrefs()` etc.)
  — so bleiben neue Schlüssel abwärtskompatibel.

## 4. CSP-streng + lokale Fonts (First-Paint + Sicherheit)

- **Keine externen Font-/CSS-/Skript-Links.** `style-src`/`font-src`/`script-src`
  nur `'self'`. Externe Fonts blockieren den ersten Paint und weiten die
  Angriffsfläche. Fonts als lokale `woff2` mit `@font-face` + Preload.
- **Kein `unsafe-inline`.** Inline-Event-Handler raus (der Smoke-Test prüft
  das); nötige Inline-Snippets (z. B. Theme-Setzung vor First-Paint) per
  CSP-Hash erlauben — und der Smoke-Test prüft, dass der Hash zum Snippet passt.
- Das Inline-Theme-Snippet, das FOUC verhindert, muss über alle Seiten
  **byte-identisch** sein (sonst bricht der CSP-Hash) — per Test absichern.

## 5. Service Worker: Cache-Version + Reveal-Disziplin

- `CACHE_NAME` bei jeder Änderung an gecachten Dateien hochzählen; die
  Shell-Liste dort pflegen (der Smoke-Test prüft, dass alle gelisteten Dateien
  existieren).
- SW weicht nach kurzem Timeout auf den Cache aus; der erste Install löst
  keinen Voll-Reload aus.

## 6. Perf-Faustregel: das Render-Gerüst wartet nie auf `await`

Die teuerste Erststart-Falle war eine serielle `await`-Kette vor dem ersten
Reveal (whoami → settings → locations → *dann* Seite sichtbar). Regel daraus:

- **`renderRoute()` läuft vor allem anderen.** Das Gerüst wird beim init-Start
  sichtbar (≈ DOMContentLoaded), Datenlader erst *nach* dem Reveal.
- Startzeit-relevante Änderungen (init-Reihenfolge, `<head>`, Service Worker)
  vorher/nachher messen. Ein kleines Perf-Skript (headless Browser, gedrosselt,
  gemockte APIs, MutationObserver auf den Reveal-Moment) genügt — Ergebnisse +
  Methodik in eine `docs/PERF.md`.
- **Mess-Ehrlichkeit:** localhost-Auslieferung greift Netzdrosseln nur schwach.
  Verlässlich sind Request-Zahl, Bytes und die Differenz „Gerüst − DCL"; absolute
  Download-ms schwanken. Das dokumentieren, nicht kaschieren.

## 7. Edge-Functions + Datenbank

- Functions legen ihr Schema zur Laufzeit selbst an (`CREATE TABLE IF NOT
  EXISTS`) — kein separater Migrationsschritt für einfache Fälle.
- Auth-Bausteine bewusst klein und getrennt halten: Identität/Credential-Check,
  Session-Cookies (HMAC), Brute-Force-Zähler, Push-Verteiler je in eigener
  Datei. Erleichtert den Security-Scan und das Testen.
- `wrangler.toml` **nur für lokal/CI**, nicht für den Deploy (Pages-Git-
  Integration braucht keins). Diese Grenze explizit kommentieren.
