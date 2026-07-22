---
name: climateflow-data-quality
description: "Domaenenregeln fuer die ClimateFlow-Datenqualitaet. Anwenden bei jeder Aenderung an Sensor-/Feed-Verarbeitung (processRawFeeds, ThingSpeak-Anbindung), am Klima-Chart, an Berechnungen (Magnus, absolute Feuchte, Taupunkt, comfortScore, Lueftungsberatung, Schimmelrisiko) oder an der Anzeige veralteter/fehlender Messwerte. Schuetzt gegen vorgetaeuschte Messwertpaare, unsichtbare Fehlerzustaende und ungetestete Formel-Aenderungen."
---

# ClimateFlow — Datenqualitaet

Sensorwerte kommen ueber ThingSpeak: unvollstaendig, verspaetet, komma-dezimal
und mit **asynchron** eintreffenden Feldern (field1=Temp, field2=Feuchte werden
getrennt hochgeladen). Diese Regeln halten die Kette ehrlich.

## Regeln

1. **Feed-Zugriff nur ueber `processRawFeeds`** (`lib/core.js`). Nie annehmen,
   dass ein Eintrag beide Felder hat; Komma-Dezimal beachten. ThingSpeak-
   Anbindung ausschliesslich serverseitig ueber `functions/api/feeds/[locId].js`
   — Read-Keys nie ins Frontend.

2. **Forward-Fill ist nur Fallback, nie Wahrheit.** Der Chart darf **nur bis
   zum letzten echten Messwertpaar** reichen (siehe `app-core.js` — „Zeitpunkte
   der letzten ECHTEN Messwerte (nicht forward-filled)"). Neue Logik darf keine
   Messwertpaare erzeugen, die es nicht gab.

3. **Veraltete/fehlende Werte sichtbar machen.** Werte aelter als
   `SENSOR_STALE_MS` (2 h, `app-core.js`) werden gekennzeichnet (Stale-Banner +
   amber-Hervorhebung in `app-analysis.js`). Feed-Fehler, Timeouts und
   Offline-Zustaende brauchen sichtbare Loading-/Empty-/Offline-/Error-States
   mit Retry, passend zum bestehenden Muster.

4. **Kein Erfolg ohne Serverbestaetigung.** Keine Geraete-, Sensor- oder
   Push-Aktion als erfolgreich darstellen, wenn die Serverantwort fehlschlug
   (`apiFetch` liefert `err.unavailable` bei 404/503/405 → Fallback, nicht
   „ok" vortaeuschen).

5. **Berechnungen DOM-frei + getestet.** Magnus, absolute Feuchte, Taupunkt,
   `comfortScore`, Lueftungsberatung, Schimmelrisiko gehoeren nach `lib/core.js`,
   wenn wiederverwendbar. Bei Formel-Aenderungen `tests/core.test.js` erweitern
   und **Grenzwerte sowie Fehlwerte explizit pruefen**. Achtung: Magnus/Komfort
   sind in `functions/api/` bewusst inline dupliziert — beide Stellen anfassen.

## Validierung
`npm test` (deckt `core.test.js` ab). Bei UI-Aenderungen `npm run test:e2e`
(ClimateFlow-Render + Lueftungsberater laufen dort mit Demo-Daten).
