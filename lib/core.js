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
    comfortScore,
    detectVentilationEvents,
    heatingDemandIndex,
    forecastExtremes,
    processRawFeeds,
    haversine,
    computeStats,
    guessType,
    downsamplePoints
  };
});
