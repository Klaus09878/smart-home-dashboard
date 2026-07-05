// Kernlogik des Smart Home Hub — reine Funktionen ohne DOM-Zugriff.
// Läuft im Browser (globale Funktionen) UND in Node (module.exports) für die
// Testsuite unter tests/core.test.js (Ausführen: npm test).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ============ Klima: Magnus-Formeln ============

  // Sättigungsdampfdruck in hPa
  function satVaporPressure(temp) {
    return 6.112 * Math.exp((17.67 * temp) / (temp + 243.5));
  }

  // Absolute Luftfeuchtigkeit in g/m³
  function getAbsoluteHumidity(temp, rh) {
    if (temp === null || rh === null || isNaN(temp) || isNaN(rh)) return 0;
    const e = (rh / 100) * satVaporPressure(temp);
    return (216.74 * e) / (temp + 273.15);
  }

  // Taupunkt in °C (Umkehrung der Magnus-Formel)
  function getDewPoint(temp, rh) {
    if (temp === null || rh === null || isNaN(temp) || isNaN(rh) || rh <= 0) return null;
    const lnE = Math.log(((rh / 100) * satVaporPressure(temp)) / 6.112);
    return (243.5 * lnE) / (17.67 - lnE);
  }

  // Geschätzte relative Feuchte an der kältesten Wandoberfläche — Schimmel-Indikator.
  // Über den Temperaturfaktor fRsi (DIN 4108-2: Mindeststandard 0,7) wird die
  // Oberflächentemperatur einer Wärmebrücke geschätzt und daraus die relative
  // Feuchte direkt an der Wand. Ab ~80 % kann Schimmel wachsen, ab 100 % kondensiert
  // Wasser. Liefert null bei ungültigen Eingaben.
  // Rückgabe: { surfaceTemp, surfaceRhRaw (ungedeckelt), surfaceRh (max. 100) }
  function surfaceHumidity(inTemp, inRh, outTemp, fRsi = 0.7) {
    if ([inTemp, inRh, outTemp].some(v => v === null || v === undefined || isNaN(v))) return null;
    const surfaceTemp = outTemp + fRsi * (inTemp - outTemp);
    const vaporPressure = (inRh / 100) * satVaporPressure(inTemp);
    const surfaceRhRaw = (vaporPressure / satVaporPressure(surfaceTemp)) * 100;
    return { surfaceTemp, surfaceRhRaw, surfaceRh: Math.min(100, surfaceRhRaw) };
  }

  // Komfort-Score 0–100 für ein Klima-Paar. Abzüge für Abweichung vom
  // Wohlfühlband (Temperatur stärker gewichtet als Feuchte) und optional für
  // Schimmelrisiko (Wandoberflächen-Feuchte ab 70 %). Schwellwerte sind
  // konfigurierbar (Dashboard-Einstellungen); Defaults = bisherige Konstanten.
  function comfortScore(temp, rh, surfaceRh = null, th = {}) {
    if ([temp, rh].some(v => v === null || v === undefined || isNaN(v))) return null;
    const tempMin = th.tempMin ?? 19, tempMax = th.tempMax ?? 24;
    const humMin = th.humMin ?? 40, humMax = th.humMax ?? 60;

    let score = 100;
    const tDev = temp < tempMin ? tempMin - temp : temp > tempMax ? temp - tempMax : 0;
    score -= Math.min(40, tDev * 8);
    const hDev = rh < humMin ? humMin - rh : rh > humMax ? rh - humMax : 0;
    score -= Math.min(30, hDev * 1.5);
    if (surfaceRh !== null && surfaceRh !== undefined && !isNaN(surfaceRh)) {
      if (surfaceRh >= 80) score -= 30;
      else if (surfaceRh > 70) score -= (surfaceRh - 70) * 3;
    }
    return Math.max(0, Math.round(score));
  }

  // Lüftungs-Ereignisse in der abgeglichenen Messreihe erkennen: schneller
  // gleichzeitiger Abfall von Feuchte UND Temperatur innerhalb eines kurzen
  // Fensters (typische Stoßlüftungs-Signatur — Heizung/Trockner senken die
  // relative Feuchte nicht zusammen mit der Temperatur).
  // aligned: [{time: Date, temp, humidity}], Rückgabe: Ereignisliste chronologisch.
  function detectVentilationEvents(aligned, opts = {}) {
    const minHumDrop = opts.minHumDrop ?? 4;      // Prozentpunkte
    const minTempDrop = opts.minTempDrop ?? 0.2;  // °C
    const maxWindowMs = opts.maxWindowMs ?? 45 * 60 * 1000;

    const events = [];
    if (!Array.isArray(aligned) || aligned.length < 2) return events;

    let i = 0;
    while (i < aligned.length - 1) {
      const start = aligned[i];
      let best = null;
      for (let j = i + 1; j < aligned.length; j++) {
        const dtMs = aligned[j].time.getTime() - start.time.getTime();
        if (dtMs > maxWindowMs) break;
        const humDrop = start.humidity - aligned[j].humidity;
        const tempDrop = start.temp - aligned[j].temp;
        if (humDrop >= minHumDrop && tempDrop >= minTempDrop && (!best || humDrop > best.humDrop)) {
          best = { j, humDrop, tempDrop };
        }
      }
      if (best) {
        const end = aligned[best.j];
        events.push({
          start: start.time,
          end: end.time,
          humBefore: start.humidity,
          humAfter: end.humidity,
          humDrop: best.humDrop,
          tempDrop: best.tempDrop
        });
        i = best.j + 1; // hinter das Ereignis springen (keine Überlappungen)
      } else {
        i++;
      }
    }
    return events;
  }

  // Relativer Heizaufwand: Mittel der positiven Innen-Außen-Differenz über die
  // letzten 24 h vs. die 24 h davor. pairs: [{ms, tin, tout}] (tout darf null
  // sein → Paar wird ignoriert). changePct ist null, wenn kein Vergleich möglich.
  function heatingDemandIndex(pairs, nowMs) {
    const dayMs = 24 * 60 * 60 * 1000;
    const mean = list => list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
    const windowVals = (fromMs, toMs) => pairs
      .filter(p => p.ms >= fromMs && p.ms < toMs &&
        [p.tin, p.tout].every(v => v !== null && v !== undefined && !isNaN(v)))
      .map(p => Math.max(0, p.tin - p.tout));

    const today = mean(windowVals(nowMs - dayMs, nowMs));
    const yesterday = mean(windowVals(nowMs - 2 * dayMs, nowMs - dayMs));
    let changePct = null;
    if (today !== null && yesterday !== null && yesterday > 0.5) {
      changePct = ((today - yesterday) / yesterday) * 100;
    }
    return { today, yesterday, changePct };
  }

  // Min/Max der Temperatur-Prognose in einem Zeitfenster [fromMs, fromMs+hours].
  // times: Unix-Sekunden (Open-Meteo timeformat=unixtime) oder ISO-Strings.
  // Rückgabe null, wenn keine Stunde ins Fenster fällt.
  function forecastExtremes(times, temps, fromMs, hours) {
    if (!Array.isArray(times) || !Array.isArray(temps)) return null;
    const toMs = fromMs + hours * 60 * 60 * 1000;
    let min = null, max = null, minAtMs = null, maxAtMs = null;
    for (let i = 0; i < times.length; i++) {
      const ms = typeof times[i] === 'number' ? times[i] * 1000 : new Date(times[i]).getTime();
      if (ms < fromMs || ms > toMs) continue;
      const t = temps[i];
      if (t === null || t === undefined || isNaN(t)) continue;
      if (min === null || t < min) { min = t; minAtMs = ms; }
      if (max === null || t > max) { max = t; maxAtMs = ms; }
    }
    return min === null ? null : { min, minAtMs, max, maxAtMs };
  }

  // ============ Klima: ThingSpeak-Feed-Verarbeitung ============

  // Forward-Fill über die Roh-Feeds: bildet lückenlose Temp/Feuchte-Paare und
  // liefert die Zeitpunkte der letzten ECHTEN Messwerte pro Feld. Das
  // Forward-Fill-Ende wird abgeschnitten, damit der Chart beim letzten echten
  // Messwert-Paar endet statt eine flache Linie bis "jetzt" zu zeichnen.
  //
  // fields (optional) generalisiert das Kanal-Schema auf beliebige Felder:
  //   { temp: 'field1', humidity: 'field2',
  //     extra: [{ key: 'co2', field: 'field3' }, ...] }
  // Extra-Felder werden ebenfalls forward-gefüllt und landen unter ihrem key
  // in jedem aligned-Eintrag (null, solange noch kein Wert kam). So lässt sich
  // z. B. ein späterer CO₂-Sensor rein per Konfiguration ergänzen.
  function processRawFeeds(rawFeeds, fields = {}) {
    const tempField = fields.temp || 'field1';
    const humField = fields.humidity || 'field2';
    const extra = Array.isArray(fields.extra) ? fields.extra : [];

    const parseNum = v => {
      if (v === null || v === undefined || v.toString().trim() === '') return null;
      const n = parseFloat(v.toString().replace(',', '.'));
      return isNaN(n) ? null : n;
    };

    let lastTemp = null;
    let lastHum = null;
    let lastTempTime = null;
    let lastHumTime = null;
    const lastExtra = {};
    const aligned = [];

    rawFeeds.forEach(feed => {
      const feedTime = new Date(feed.created_at);

      const parsedTemp = parseNum(feed[tempField]);
      if (parsedTemp !== null) { lastTemp = parsedTemp; lastTempTime = feedTime; }
      const parsedHum = parseNum(feed[humField]);
      if (parsedHum !== null) { lastHum = parsedHum; lastHumTime = feedTime; }
      extra.forEach(e => {
        const v = parseNum(feed[e.field]);
        if (v !== null) lastExtra[e.key] = v;
      });

      if (lastTemp !== null && lastHum !== null) {
        const entry = {
          time: feedTime,
          temp: lastTemp,
          humidity: lastHum,
          id: feed.entry_id
        };
        extra.forEach(e => {
          entry[e.key] = lastExtra[e.key] !== undefined ? lastExtra[e.key] : null;
        });
        aligned.push(entry);
      }
    });

    if (lastTempTime && lastHumTime) {
      const lastRealMs = Math.min(lastTempTime.getTime(), lastHumTime.getTime());
      while (aligned.length > 0 && aligned[aligned.length - 1].time.getTime() > lastRealMs) {
        aligned.pop();
      }
    }

    return { aligned, lastTempTime, lastHumTime };
  }

  // ============ Kalender: minimaler ICS-Parser (RFC 5545) ============
  // Extrahiert VEVENTs mit Startzeit und Titel aus einem .ics-Feed (z. B.
  // „geheime Adresse" eines Google Kalenders). Bewusste Grenzen: RRULE-Termine
  // werden nur mit ihrem DTSTART geliefert (als recurring markiert, keine
  // Expansion); TZID-Zeiten werden als lokale Zeit interpretiert.
  function parseIcsEvents(icsText) {
    if (typeof icsText !== 'string' || icsText.indexOf('BEGIN:VEVENT') === -1) return [];
    // Fortsetzungszeilen entfalten (Zeilen, die mit Leerzeichen/Tab beginnen)
    const lines = icsText.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
    const events = [];
    let cur = null;

    lines.forEach(line => {
      if (line === 'BEGIN:VEVENT') { cur = {}; return; }
      if (line === 'END:VEVENT') {
        if (cur && cur.startMs !== undefined) events.push(cur);
        cur = null;
        return;
      }
      if (!cur) return;

      if (line.startsWith('SUMMARY')) {
        cur.summary = line.substring(line.indexOf(':') + 1)
          .replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/gi, ' ').trim();
      } else if (line.startsWith('DTSTART')) {
        const colon = line.indexOf(':');
        const props = line.substring(0, colon);
        const value = line.substring(colon + 1).trim();
        if (/VALUE=DATE(;|$)/.test(props) || /^\d{8}$/.test(value)) {
          cur.startMs = new Date(+value.substring(0, 4), +value.substring(4, 6) - 1, +value.substring(6, 8)).getTime();
          cur.allDay = true;
        } else {
          const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
          if (m) {
            cur.startMs = m[7] === 'Z'
              ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))
              : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
            cur.allDay = false;
          }
        }
      } else if (line.startsWith('RRULE')) {
        cur.recurring = true;
        cur.rrule = line.substring(line.indexOf(':') + 1).trim();
      } else if (line.startsWith('EXDATE')) {
        const val = line.substring(line.indexOf(':') + 1).trim();
        cur.exdates = cur.exdates || [];
        val.split(',').forEach(v => {
          const ms = parseIcsDate(v.trim());
          if (ms !== null) cur.exdates.push(ms);
        });
      }
    });

    return events
      .filter(e => e.startMs !== undefined && !isNaN(e.startMs))
      .sort((a, b) => a.startMs - b.startMs);
  }

  // Einzelnes ICS-Datum (YYYYMMDD oder YYYYMMDDTHHMMSS[Z]) → ms.
  function parseIcsDate(v) {
    if (/^\d{8}$/.test(v)) return new Date(+v.substring(0, 4), +v.substring(4, 6) - 1, +v.substring(6, 8)).getTime();
    const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
    if (!m) return null;
    return m[7] === 'Z'
      ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))
      : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
  }

  // Serientermine (RRULE) zu konkreten Terminen im Fenster [fromMs, toMs] auflösen.
  // Unterstützt FREQ=DAILY/WEEKLY/MONTHLY/YEARLY mit INTERVAL, COUNT, UNTIL,
  // BYDAY (für WEEKLY) und EXDATE. Sicherheitsdeckel maxPerEvent verhindert
  // Endlos-Expansion. Einzeltermine werden unverändert übernommen, wenn sie ins
  // Fenster fallen. Rückgabe chronologisch.
  function expandRecurring(events, fromMs, toMs, maxPerEvent = 500) {
    const out = [];
    for (const ev of events || []) {
      if (!ev.rrule) {
        if (ev.startMs >= fromMs && ev.startMs <= toMs) {
          out.push({ startMs: ev.startMs, summary: ev.summary, allDay: ev.allDay, recurring: false });
        }
        continue;
      }
      const ex = new Set(ev.exdates || []);
      generateOccurrences(ev, toMs, maxPerEvent).forEach(ms => {
        if (ms >= fromMs && ms <= toMs && !ex.has(ms)) {
          out.push({ startMs: ms, summary: ev.summary, allDay: ev.allDay, recurring: true });
        }
      });
    }
    return out.sort((a, b) => a.startMs - b.startMs);
  }

  function parseUntilMs(v) {
    const m = v.match(/^(\d{4})(\d{2})(\d{2})(T(\d{2})(\d{2})(\d{2})Z?)?/);
    if (!m) return null;
    return m[4]
      ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[5], +m[6], +m[7])
      : new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59).getTime();
  }

  function generateOccurrences(ev, toMs, cap) {
    const rule = {};
    ev.rrule.split(';').forEach(p => { const [k, v] = p.split('='); if (k) rule[k.toUpperCase()] = v; });
    const freq = (rule.FREQ || '').toUpperCase();
    const interval = Math.max(1, parseInt(rule.INTERVAL || '1', 10) || 1);
    const count = rule.COUNT ? parseInt(rule.COUNT, 10) : null;
    const until = rule.UNTIL ? parseUntilMs(rule.UNTIL) : null;
    const hardStop = until != null ? Math.min(toMs, until) : toMs;
    const base = new Date(ev.startMs);
    const wdMap = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
    const byday = rule.BYDAY ? rule.BYDAY.split(',').map(s => wdMap[s.trim().slice(-2)]).filter(v => v != null) : null;
    const times = [];

    if (freq === 'WEEKLY' && byday && byday.length) {
      const weekStart = new Date(base);
      weekStart.setDate(base.getDate() - base.getDay()); // Sonntag der Startwoche
      let safety = 0;
      const sortedDays = byday.slice().sort((a, b) => a - b);
      while (times.length < cap && safety < cap * 3) {
        for (const td of sortedDays) {
          const d = new Date(weekStart);
          d.setDate(weekStart.getDate() + td);
          d.setHours(base.getHours(), base.getMinutes(), base.getSeconds(), 0);
          const ms = d.getTime();
          if (ms >= ev.startMs && (until == null || ms <= until)) times.push(ms);
        }
        weekStart.setDate(weekStart.getDate() + 7 * interval);
        safety++;
        if (weekStart.getTime() > hardStop) break;
      }
    } else {
      const d = new Date(base);
      let safety = 0;
      while (times.length < cap && safety < cap) {
        const ms = d.getTime();
        if (until != null && ms > until) break;
        times.push(ms);
        if (ms > toMs) break;
        if (freq === 'DAILY') d.setDate(d.getDate() + interval);
        else if (freq === 'WEEKLY') d.setDate(d.getDate() + 7 * interval);
        else if (freq === 'MONTHLY') d.setMonth(d.getMonth() + interval);
        else if (freq === 'YEARLY') d.setFullYear(d.getFullYear() + interval);
        else break;
        safety++;
      }
    }
    times.sort((a, b) => a - b);
    return count != null ? times.slice(0, count) : times;
  }

  // ============ GPX: Geometrie & Statistik ============

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // Statistik über einen Track aus Punkten [lat, lon, ele|null, timestampMs|null]
  function computeStats(points) {
    let distM = 0, movingSec = 0, maxSpeed = 0;
    const cumDist = [0];

    for (let i = 1; i < points.length; i++) {
      const d = haversine(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
      distM += d;
      cumDist.push(distM);

      const t0 = points[i - 1][3], t1 = points[i][3];
      if (t0 !== null && t1 !== null) {
        const dt = (t1 - t0) / 1000;
        // Pausen (>10 min Lücke) nicht als Bewegungszeit zählen
        if (dt > 0 && dt < 600) {
          const v = (d / dt) * 3.6;
          if (v > 1.5) movingSec += dt;
          // GPS-Ausreißer filtern: nur Segmente >= 3s und plausible Tempi
          if (dt >= 3 && v < 250 && v > maxSpeed) maxSpeed = v;
        }
      }
    }

    // Höhenmeter: geglättete Serie (gleitendes Mittel), nur Anstiege > Rauschschwelle
    const eles = points.map(p => p[2]).filter(e => e !== null);
    let elevGain = null, eleMin = null, eleMax = null;
    if (eles.length > points.length * 0.5) {
      const smooth = [];
      const win = 5;
      const rawEles = points.map(p => p[2]);
      for (let i = 0; i < rawEles.length; i++) {
        let sum = 0, n = 0;
        for (let j = Math.max(0, i - win); j <= Math.min(rawEles.length - 1, i + win); j++) {
          if (rawEles[j] !== null) { sum += rawEles[j]; n++; }
        }
        smooth.push(n > 0 ? sum / n : null);
      }
      elevGain = 0;
      let ref = null;
      smooth.forEach(e => {
        if (e === null) return;
        if (ref === null) { ref = e; return; }
        const delta = e - ref;
        if (delta > 2) { elevGain += delta; ref = e; }
        else if (delta < -2) { ref = e; }
      });
      eleMin = Math.min(...eles);
      eleMax = Math.max(...eles);
    }

    const tStart = points[0][3], tEnd = points[points.length - 1][3];
    const totalSec = (tStart !== null && tEnd !== null && tEnd > tStart) ? (tEnd - tStart) / 1000 : null;
    const effMovingSec = movingSec > 0 ? movingSec : totalSec;
    const avgSpeed = (effMovingSec && effMovingSec > 0) ? (distM / effMovingSec) * 3.6 : null;

    return {
      distM,
      totalSec,
      movingSec: movingSec > 0 ? movingSec : null,
      avgSpeed,
      maxSpeed: maxSpeed > 0 ? maxSpeed : null,
      elevGain: elevGain !== null ? Math.round(elevGain) : null,
      eleMin, eleMax,
      cumDist,
      startTime: tStart
    };
  }

  // Geglättete Segment-Geschwindigkeiten für die Tempo-Färbung der Karte
  // (km/h pro Segment, null ohne Zeitdaten; gleitendes Mittel über 5 Segmente).
  function segmentSpeeds(points) {
    const speeds = [];
    for (let i = 1; i < points.length; i++) {
      const d = haversine(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
      const t0 = points[i - 1][3], t1 = points[i][3];
      speeds.push(t0 !== null && t1 !== null && t1 > t0 ? (d / ((t1 - t0) / 1000)) * 3.6 : null);
    }
    return speeds.map((_, i) => {
      let sum = 0, n = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(speeds.length - 1, i + 2); j++) {
        if (speeds[j] !== null) { sum += speeds[j]; n++; }
      }
      return n > 0 ? sum / n : null;
    });
  }

  // Aktivitäts-Serien („Streaks") aus lokalen Tages-Schlüsseln ('YYYY-MM-DD').
  // current zählt rückwärts ab heute (oder gestern, falls heute noch nichts war).
  function computeStreaks(dayKeys, todayKey) {
    const days = new Set(dayKeys);
    const dayMs = 24 * 60 * 60 * 1000;
    const toMs = k => new Date(`${k}T12:00:00Z`).getTime();
    const toKey = ms => new Date(ms).toISOString().substring(0, 10);

    let longest = 0, run = 0, prev = null;
    [...days].sort().forEach(k => {
      run = (prev !== null && Math.round((toMs(k) - toMs(prev)) / dayMs) === 1) ? run + 1 : 1;
      if (run > longest) longest = run;
      prev = k;
    });

    let current = 0;
    let cursor = days.has(todayKey) ? todayKey : toKey(toMs(todayKey) - dayMs);
    while (days.has(cursor)) {
      current++;
      cursor = toKey(toMs(cursor) - dayMs);
    }
    return { current, longest };
  }

  // Routen-Signatur: Menge der besuchten Gitterzellen (Kantenlänge ~cellM Meter).
  // Zwei Aufzeichnungen derselben Strecke landen trotz GPS-Streuung in fast
  // denselben Zellen — Grundlage der Bestzeiten-Erkennung.
  function routeCells(points, cellM = 60) {
    const cells = new Set();
    if (!Array.isArray(points) || points.length === 0) return cells;
    const latScale = 111320;
    const lonScale = Math.max(1000, Math.cos(points[0][0] * Math.PI / 180) * 111320);
    points.forEach(p => {
      cells.add(`${Math.round(p[0] * latScale / cellM)}:${Math.round(p[1] * lonScale / cellM)}`);
    });
    return cells;
  }

  // Überdeckungsgrad zweier Routen-Signaturen (0–1): Anteil gemeinsamer Zellen
  // an der kleineren Signatur. >= ~0,75 bei gleicher Strecke.
  function routeSimilarity(cellsA, cellsB) {
    if (!cellsA || !cellsB || cellsA.size === 0 || cellsB.size === 0) return 0;
    const [small, large] = cellsA.size <= cellsB.size ? [cellsA, cellsB] : [cellsB, cellsA];
    let inter = 0;
    small.forEach(c => { if (large.has(c)) inter++; });
    return inter / small.size;
  }

  // GPX-1.1-Datei aus einer gespeicherten Aktivität erzeugen (Re-Export).
  function buildGpxXml(activity) {
    const esc = s => s.toString()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const pts = (activity.points || []).map(p => {
      const ele = (p[2] !== null && p[2] !== undefined) ? `<ele>${p[2]}</ele>` : '';
      const time = p[3] ? `<time>${new Date(p[3]).toISOString()}</time>` : '';
      return `      <trkpt lat="${p[0]}" lon="${p[1]}">${ele}${time}</trkpt>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<gpx version="1.1" creator="Smart Home Hub" xmlns="http://www.topografix.com/GPX/1/1">\n` +
      `  <trk>\n    <name>${esc(activity.name || 'Aktivität')}</name>\n    <trkseg>\n` +
      `${pts}\n    </trkseg>\n  </trk>\n</gpx>\n`;
  }

  // Aktivitätstyp anhand des Ø-Tempos raten
  function guessType(avgSpeed) {
    if (avgSpeed === null || avgSpeed === undefined) return 'ride';
    if (avgSpeed < 6.5) return 'walk';
    if (avgSpeed < 13) return 'run';
    if (avgSpeed < 42) return 'ride';
    return 'moto';
  }

  // Track gleichmäßig auf maxPoints ausdünnen (erster/letzter Punkt bleiben).
  // Schützt die D1-Zeilengröße bei sehr langen Aufzeichnungen.
  function downsamplePoints(points, maxPoints = 5000) {
    if (!Array.isArray(points) || points.length <= maxPoints) return points;
    const step = (points.length - 1) / (maxPoints - 1);
    const out = [];
    for (let i = 0; i < maxPoints; i++) {
      out.push(points[Math.round(i * step)]);
    }
    return out;
  }

  return {
    satVaporPressure,
    getAbsoluteHumidity,
    getDewPoint,
    surfaceHumidity,
    parseIcsEvents,
    expandRecurring,
    comfortScore,
    detectVentilationEvents,
    heatingDemandIndex,
    forecastExtremes,
    processRawFeeds,
    haversine,
    computeStats,
    segmentSpeeds,
    computeStreaks,
    routeCells,
    routeSimilarity,
    buildGpxXml,
    guessType,
    downsamplePoints
  };
});
