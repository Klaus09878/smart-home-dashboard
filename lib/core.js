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

  // ============ Klima: ThingSpeak-Feed-Verarbeitung ============

  // Forward-Fill über die Roh-Feeds: bildet lückenlose Temp/Feuchte-Paare und
  // liefert die Zeitpunkte der letzten ECHTEN Messwerte pro Feld. Das
  // Forward-Fill-Ende wird abgeschnitten, damit der Chart beim letzten echten
  // Messwert-Paar endet statt eine flache Linie bis "jetzt" zu zeichnen.
  function processRawFeeds(rawFeeds) {
    let lastTemp = null;
    let lastHum = null;
    let lastTempTime = null;
    let lastHumTime = null;
    const aligned = [];

    rawFeeds.forEach(feed => {
      const f1 = feed.field1;
      const f2 = feed.field2;
      const feedTime = new Date(feed.created_at);

      if (f1 !== null && f1 !== undefined && f1.toString().trim() !== '') {
        const parsedTemp = parseFloat(f1.toString().replace(',', '.'));
        if (!isNaN(parsedTemp)) { lastTemp = parsedTemp; lastTempTime = feedTime; }
      }
      if (f2 !== null && f2 !== undefined && f2.toString().trim() !== '') {
        const parsedHum = parseFloat(f2.toString().replace(',', '.'));
        if (!isNaN(parsedHum)) { lastHum = parsedHum; lastHumTime = feedTime; }
      }

      if (lastTemp !== null && lastHum !== null) {
        aligned.push({
          time: feedTime,
          temp: lastTemp,
          humidity: lastHum,
          id: feed.entry_id
        });
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
    processRawFeeds,
    haversine,
    computeStats,
    guessType,
    downsamplePoints
  };
});
