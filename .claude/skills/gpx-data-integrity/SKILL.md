---
name: gpx-data-integrity
description: "Integritaetsregeln fuer den GPX-Viewer. Anwenden bei jeder Aenderung an GPX-Import, IndexedDB-Speicherung, D1-Sync, Offline-Queue, Merge, Backup/Restore oder Export (gpx.js, lib/core.js). Schuetzt gegen stilles Ueberschreiben/Verlieren von Aktivitaeten, kaputte Exporte und Abstuerze bei D1-/R2-Ausfall."
---

# GPX — Datenintegritaet

GPX-Daten koennen fehlerhaft, unvollstaendig, ungewoehnlich gross oder mit
GPS-Ausreissern versehen sein. Aktivitaeten sind Nutzerdaten — Verlust ist
inakzeptabel.

## Regeln

1. **Identitaet `uid`, Konflikt-Merge ueber neueren `updatedAt`** (`gpx.js` —
   „neuerer updatedAt gewinnt, egal auf welchem Geraet geaendert"). Nie eine
   vorhandene Aktivitaet still ueberschreiben oder verlieren; Merge ist
   feldbewusst (Name/Typ/Notiz).

2. **Loeschungen als Tombstones + Queue `gpx_pending_deletes`** (bewusst roh in
   localStorage, geraetelokal). Kein Hard-Delete ohne Tombstone/Queue — sonst
   „auferstehen" geloeschte Tracks beim naechsten Sync.

3. **Vor IndexedDB/D1 auf max. 5000 Punkte downsamplen** (`downsamplePoints`,
   `lib/core.js`; `gpx.js` nutzt es beim Speichern), um Riesen-Tracks
   abzufangen. Kaputte/unvollstaendige GPX und GPS-Ausreisser defensiv
   behandeln, nicht blind vertrauen.

4. **Sauberer lokaler Fallback bei D1-/R2-Ausfall.** IndexedDB bleibt die
   Quelle der Wahrheit auf dem Geraet; Cloud-Ausfall darf nicht abstuerzen,
   sondern muss definiert degradieren. Import und Cloud-Sync brauchen
   nachvollziehbare Fehlerzustaende (keine stillen Fallbacks, die Fehler
   verschleiern).

5. **Export ueber `buildGpxXml`** (`lib/core.js`) → valides, reproduzierbares
   Format. DOM-freie GPX-Logik (Stats, Segmente, `routeCells`, `compareTracks`,
   Streaks, XML-Bau) gehoert nach `lib/core.js` und braucht Tests bei Aenderung.

## Validierung
`npm test` (GPX-Kernlogik in `core.test.js`). Bei Viewer-UI `npm run test:e2e`
(GPX-Viewer-Ladepfad laeuft dort mit).
