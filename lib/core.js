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

  // Lüftungs-Statistik über erkannte Ereignisse (P5). events: [{startMs, humDrop}].
  // Liefert Anzahl, Ereignisse/Tag, Ø-Feuchteabfall, häufigste Stunde und die
  // Tageszählung der letzten `days` Tage (für das Balkendiagramm).
  function ventilationStats(events, opts = {}) {
    const nowMs = opts.nowMs || Date.now();
    const days = opts.days || 14;
    const dayMs = 24 * 60 * 60 * 1000;
    const fromMs = nowMs - days * dayMs;
    const inWin = (events || []).filter(e => e.startMs >= fromMs && e.startMs <= nowMs);

    const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const avgHumDrop = mean(inWin.map(e => e.humDrop).filter(v => v != null && !isNaN(v)));

    const hourCounts = {};
    inWin.forEach(e => { const h = new Date(e.startMs).getHours(); hourCounts[h] = (hourCounts[h] || 0) + 1; });
    let topHour = null, topN = 0;
    Object.entries(hourCounts).forEach(([h, n]) => { if (n > topN) { topN = n; topHour = +h; } });

    const dayKey = ms => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const counts = {};
    inWin.forEach(e => { const k = dayKey(e.startMs); counts[k] = (counts[k] || 0) + 1; });
    const dailyCounts = [];
    for (let i = days - 1; i >= 0; i--) {
      const k = dayKey(nowMs - i * dayMs);
      dailyCounts.push({ day: k, count: counts[k] || 0 });
    }

    return { count: inWin.length, perDay: inWin.length / days, avgHumDrop, topHour, dailyCounts };
  }

  // Wochen-Muster (Plan4-16): mittelt ein Feld (humidity|temp) je Wochentag und
  // Stunde. Rueckgabe { grid: 7x24 (Zeile 0 = Montag; null wo keine Daten), min,
  // max } oder null bei leerer Eingabe. aligned wie von processRawFeeds.
  function hourlyPattern(aligned, field = 'humidity') {
    const sums = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const counts = Array.from({ length: 7 }, () => new Array(24).fill(0));
    let any = false;
    (aligned || []).forEach(a => {
      if (!a || !(a.time instanceof Date)) return;
      const v = a[field];
      if (v == null || isNaN(v)) return;
      const row = (a.time.getDay() + 6) % 7; // 0 = Montag
      const h = a.time.getHours();
      sums[row][h] += v; counts[row][h]++; any = true;
    });
    if (!any) return null;
    let min = Infinity, max = -Infinity;
    const grid = sums.map((r, ri) => r.map((s, hi) => {
      if (counts[ri][hi] === 0) return null;
      const m = s / counts[ri][hi];
      if (m < min) min = m;
      if (m > max) max = m;
      return m;
    }));
    return { grid, min, max };
  }

  // Wirkung der erkannten Stosslueftungen (Plan4-14): mittlere Feuchte-Senkung
  // und Dauer pro Lueftung sowie das 3-Stunden-Fenster mit den meisten
  // Lueftungs-Starts. aligned wie von processRawFeeds. null bei 0 Ereignissen.
  function ventilationImpact(aligned, opts = {}) {
    const events = detectVentilationEvents(aligned, opts);
    if (!events.length) return null;
    const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const avgDropRh = mean(events.map(e => e.humDrop));
    const avgDurationMin = mean(events.map(e => (e.end.getTime() - e.start.getTime()) / 60000));
    // Bestes 3-h-Fenster: Startstunde mit der groessten Summe an Lueftungs-Starts
    // in [h, h+2]. Bei Gleichstand gewinnt die fruehere Stunde (deterministisch).
    const hourCounts = new Array(24).fill(0);
    events.forEach(e => { hourCounts[e.start.getHours()]++; });
    let bestStart = 0, bestSum = -1;
    for (let h = 0; h < 24; h++) {
      const sum = hourCounts[h] + hourCounts[(h + 1) % 24] + hourCounts[(h + 2) % 24];
      if (sum > bestSum) { bestSum = sum; bestStart = h; }
    }
    return {
      count: events.length,
      avgDropRh,
      avgDurationMin,
      bestHourFrom: bestStart,
      bestHourTo: (bestStart + 3) % 24
    };
  }

  // Klima-Rekorde aus dem Tages-Archiv (P6). rows: [{day, t_min, t_max, t_avg, h_avg}].
  // Liefert wärmsten/kältesten/feuchtesten Tag, besten Komfort-Tag und die längste
  // Serie zusammenhängender „Wohlfühl"-Tage (Komfort-Score >= threshold).
  function climateRecords(rows, threshold = 80) {
    const valid = (rows || []).filter(r => r && r.day);
    if (valid.length === 0) return null;

    let warmest = null, coldest = null, wettest = null, bestComfort = null;
    valid.forEach(r => {
      if (r.t_max != null && (!warmest || r.t_max > warmest.value)) warmest = { day: r.day, value: r.t_max };
      if (r.t_min != null && (!coldest || r.t_min < coldest.value)) coldest = { day: r.day, value: r.t_min };
      if (r.h_avg != null && (!wettest || r.h_avg > wettest.value)) wettest = { day: r.day, value: r.h_avg };
      const s = comfortScore(r.t_avg, r.h_avg);
      if (s !== null && (!bestComfort || s > bestComfort.score)) bestComfort = { day: r.day, score: s };
    });

    // Längste Serie zusammenhängender Kalendertage mit Komfort >= threshold
    const dayMs = 24 * 60 * 60 * 1000;
    const toMs = d => new Date(`${d}T12:00:00Z`).getTime();
    const sorted = valid.slice().sort((a, b) => a.day.localeCompare(b.day));
    let longest = 0, run = 0, prevMs = null;
    sorted.forEach(r => {
      const ok = comfortScore(r.t_avg, r.h_avg) >= threshold;
      const ms = toMs(r.day);
      if (ok) {
        run = (prevMs !== null && Math.round((ms - prevMs) / dayMs) === 1) ? run + 1 : 1;
        if (run > longest) longest = run;
      } else {
        run = 0;
      }
      prevMs = ms;
    });

    return { warmest, coldest, wettest, bestComfort, comfortStreak: longest };
  }

  // Monats-Insights aus dem Tages-Archiv (Plan4-15): vergleicht den juengsten
  // VOLLSTAENDIGEN Monat (>= 10 Datentage, nicht der laufende) mit dem Vormonat
  // und demselben Monat im Vorjahr. rows: [{day:'YYYY-MM-DD', t_avg, h_avg}].
  // Liefert deutsche Saetze mit Komma-Dezimal oder null.
  function monthlyInsights(rows, now = new Date()) {
    const byMonth = {};
    (rows || []).forEach(r => {
      if (!r || !r.day || r.t_avg == null) return;
      const mk = r.day.slice(0, 7);
      (byMonth[mk] = byMonth[mk] || []).push(r);
    });
    const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const monthAvg = mk => {
      const list = byMonth[mk];
      if (!list || list.length < 10) return null;
      return { tAvg: mean(list.map(r => r.t_avg)), hAvg: mean(list.filter(r => r.h_avg != null).map(r => r.h_avg)), days: list.length };
    };

    const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const keys = Object.keys(byMonth).filter(mk => mk !== curKey && byMonth[mk].length >= 10).sort();
    if (!keys.length) return null;
    const M = keys[keys.length - 1];
    const cur = monthAvg(M);
    if (!cur) return null;

    const [y, m] = M.split('-').map(Number);
    const prevKey = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    const yearAgoKey = `${y - 1}-${String(m).padStart(2, '0')}`;
    const prev = monthAvg(prevKey);
    const yearAgo = monthAvg(yearAgoKey);

    const monthName = ymd => new Date(`${ymd}-01T12:00:00`).toLocaleDateString('de-DE', { month: 'long' });
    const num = v => v.toFixed(1).replace('.', ',');
    const sentences = [];
    if (prev && prev.hAvg != null && cur.hAvg != null) {
      const dT = cur.tAvg - prev.tAvg;
      const dH = cur.hAvg - prev.hAvg;
      sentences.push(`Der ${monthName(M)} war ${num(Math.abs(dT))} °C ${dT >= 0 ? 'wärmer' : 'kälter'} und ${Math.abs(dH).toFixed(0)} % ${dH <= 0 ? 'trockener' : 'feuchter'} als der ${monthName(prevKey)}.`);
    }
    if (yearAgo) {
      const dT = cur.tAvg - yearAgo.tAvg;
      sentences.push(`Gegenüber ${monthName(M)} ${y - 1}: ${dT >= 0 ? '+' : '−'}${num(Math.abs(dT))} °C.`);
    }
    if (!sentences.length) sentences.push(`Der ${monthName(M)} lag im Mittel bei ${num(cur.tAvg)} °C und ${cur.hAvg != null ? cur.hAvg.toFixed(0) + ' %' : '–'} Feuchte.`);
    return { month: M, tAvg: cur.tAvg, hAvg: cur.hAvg, sentences };
  }

  // Tages-Mitteltemperatur eines Jahres auf die MM-TT-Achse mappen (Plan4-17,
  // Jahresvergleich). Ueberspringt den 29.02. (Schaltjahr) fuer eine
  // gemeinsame Achse. rows: [{day:'YYYY-MM-DD', t_avg}].
  function alignYearSeries(rows, year) {
    const y = String(year);
    return (rows || [])
      .filter(r => r && r.day && r.day.slice(0, 4) === y && r.day.slice(5) !== '02-29' && r.t_avg != null)
      .map(r => ({ md: r.day.slice(5), t_avg: r.t_avg }))
      .sort((a, b) => a.md.localeCompare(b.md));
  }

  // Trend-Prognose per linearer Regression über das letzte Zeitfenster (P7).
  // aligned: [{time: Date, humidity, temp}]. Liefert Steigung pro Stunde, den
  // aktuellen Wert und — falls threshold gesetzt und der Trend darauf zuläuft —
  // den voraussichtlichen Zeitpunkt des Erreichens (etaMs), sonst null.
  function trendForecast(aligned, opts = {}) {
    const field = opts.field || 'humidity';
    const windowMs = opts.windowMs || 3 * 60 * 60 * 1000;
    const threshold = opts.threshold;
    if (!Array.isArray(aligned) || aligned.length < 4) return null;

    const lastMs = aligned[aligned.length - 1].time.getTime();
    const nowMs = opts.nowMs || lastMs;
    const pts = aligned
      .filter(p => p.time.getTime() >= nowMs - windowMs && p[field] != null && !isNaN(p[field]))
      .map(p => ({ x: (p.time.getTime()) / 3600000, y: p[field] }));
    if (pts.length < 4) return null;

    const n = pts.length;
    const sx = pts.reduce((a, p) => a + p.x, 0);
    const sy = pts.reduce((a, p) => a + p.y, 0);
    const sxx = pts.reduce((a, p) => a + p.x * p.x, 0);
    const sxy = pts.reduce((a, p) => a + p.x * p.y, 0);
    const denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-9) return null;
    const slope = (n * sxy - sx * sy) / denom;      // pro Stunde
    const intercept = (sy - slope * sx) / n;
    const current = pts[pts.length - 1].y;

    let etaMs = null;
    if (threshold != null && Math.abs(slope) > 0.05) {
      const towards = (slope > 0 && threshold > current) || (slope < 0 && threshold < current);
      if (towards) {
        const xHit = (threshold - intercept) / slope;       // in Stunden-Einheiten
        const hitMs = xHit * 3600000;
        if (hitMs > lastMs) etaMs = hitMs;
      }
    }
    return { slopePerHour: slope, current, etaMs };
  }

  // Mehr-Tages-Trend eines Tagesaggregats (Plan7-8): erkennt eine ANHALTENDE
  // Zu-/Abnahme (z. B. Feuchte steigt seit N Tagen) als Fruehwarnung — anders als
  // trendForecast (Intraday). rows = [{ day:'YYYY-MM-DD', [field]:number }, …]
  // (Reihenfolge egal). Liefert null, wenn zu wenige Tage, das Netto-Delta zu
  // klein ist ODER der letzte Tag nicht das Fenster-Extrem ist (dann kein
  // anhaltender Trend, sondern Rauschen). days = Zahl der Tag-zu-Tag-Schritte.
  function dailyTrend(rows, opts = {}) {
    const field = opts.field || 'h_avg';
    const days = opts.days || 3;
    const minDelta = opts.minDelta != null ? opts.minDelta : 8;
    if (!Array.isArray(rows)) return null;
    const clean = rows
      .filter(r => r && r.day && r[field] != null && !isNaN(r[field]))
      .slice()
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    if (clean.length < days + 1) return null;
    const seg = clean.slice(-(days + 1));
    const vals = seg.map(r => Number(r[field]));
    const first = vals[0], last = vals[vals.length - 1];
    const delta = last - first;
    if (Math.abs(delta) < minDelta) return null;
    const up = delta > 0;
    // Anhaltend = der letzte Tag ist das Fenster-Extrem (Hoch bei Anstieg,
    // Tief bei Abfall) — ein zwischenzeitlich hoeherer/tieferer Tag bricht den Trend.
    if (up && last < Math.max(...vals)) return null;
    if (!up && last > Math.min(...vals)) return null;
    const r1 = n => Math.round(n * 10) / 10;
    return {
      field, direction: up ? 'up' : 'down', days,
      from: seg[0].day, to: seg[seg.length - 1].day,
      fromValue: r1(first), toValue: r1(last), delta: r1(delta)
    };
  }

  // Bester Lueftungszeitpunkt (Plan7-10): vergleicht die Innen-Absolutfeuchte mit
  // der stuendlichen Aussen-Prognose und liefert die kommenden Stunden, in denen
  // Lueften die Feuchte SENKT (Aussen-AH < Innen-AH) — plus die trockenste davon.
  // hourly = { time:[unixSec|iso], temperature_2m:[], relative_humidity_2m:[] }.
  function ventilationForecast(inAH, hourly, opts = {}) {
    if (inAH == null || isNaN(inAH) || !hourly || !Array.isArray(hourly.time)) return { best: null, hours: [], good: [] };
    const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
    const windowH = opts.hours || 12;
    const minBenefit = opts.minBenefit != null ? opts.minBenefit : 1.0;
    const r1 = n => Math.round(n * 10) / 10;
    const hours = [];
    for (let i = 0; i < hourly.time.length; i++) {
      const raw = hourly.time[i];
      const ms = typeof raw === 'number' ? raw * 1000 : new Date(raw).getTime();
      if (isNaN(ms) || ms < nowMs || ms > nowMs + windowH * 3600000) continue;
      const ot = hourly.temperature_2m && hourly.temperature_2m[i];
      const orh = hourly.relative_humidity_2m && hourly.relative_humidity_2m[i];
      if (ot == null || orh == null) continue;
      const outAH = getAbsoluteHumidity(ot, orh);
      hours.push({ ms, ot, orh, outAH: r1(outAH), benefit: r1(inAH - outAH) });
    }
    const good = hours.filter(h => h.benefit >= minBenefit);
    const best = good.reduce((b, h) => (!b || h.outAH < b.outAH ? h : b), null);
    return { best, hours, good };
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

  // Distanz-/Zeitprofil eines Tracks: kumulative Distanz und verstrichene
  // Sekunden ab Start je Punkt (für den Segment-Vergleich).
  function trackProfile(points) {
    const dist = [0], time = [0];
    const t0 = points[0][3];
    for (let i = 1; i < points.length; i++) {
      dist[i] = dist[i - 1] + haversine(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
      time[i] = (points[i][3] != null && t0 != null) ? (points[i][3] - t0) / 1000 : time[i - 1];
    }
    return { dist, time, total: dist[dist.length - 1] };
  }

  function timeAtDist(prof, target) {
    const { dist, time } = prof;
    if (target <= 0) return 0;
    if (target >= dist[dist.length - 1]) return time[time.length - 1];
    let i = 1;
    while (i < dist.length && dist[i] < target) i++;
    const d0 = dist[i - 1], d1 = dist[i], t0 = time[i - 1], t1 = time[i];
    const f = d1 > d0 ? (target - d0) / (d1 - d0) : 0;
    return t0 + f * (t1 - t0);
  }

  // Segment-Vergleich zweier Aufzeichnungen derselben Strecke (P9): liefert je
  // Distanz-Schritt (stepM) die verstrichene Zeit beider Touren und das Delta
  // (positiv = langsamer als die Referenz). Grundlage für die grün/rot-Färbung.
  function compareTracks(refPoints, points, stepM = 500) {
    if (!Array.isArray(refPoints) || !Array.isArray(points) || refPoints.length < 2 || points.length < 2) return [];
    const rp = trackProfile(refPoints), pp = trackProfile(points);
    const maxD = Math.min(rp.total, pp.total);
    const out = [];
    for (let d = stepM; d <= maxD + 1; d += stepM) {
      const dd = Math.min(d, maxD);
      const refSec = timeAtDist(rp, dd), sec = timeAtDist(pp, dd);
      out.push({ distM: dd, refSec, sec, deltaSec: sec - refSec });
      if (dd >= maxD) break;
    }
    return out;
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

  // ---- Status-Briefing (Hub) ---------------------------------------------
  // Verdichtet rohe Status-Signale zu einer priorisierten Kurzliste fuers Hub.
  // Jedes Signal: { severity: 'warn'|'info'|'ok', text, target }. 'warn' vor
  // 'info'; 'ok'-Signale sind nur die Rueckmeldung "Bereich geprueft, alles gut"
  // und erscheinen NICHT als eigene Zeile — ausser es gibt gar keine Warnungen
  // oder Hinweise, dann liefert die Funktion eine einzige Sammelzeile.
  // Rueckgabe: { status, allClear, items, overflow }.
  function buildBriefing(signals, opts) {
    const max = (opts && opts.max) || 5;
    const rank = { warn: 0, info: 1, ok: 2 };
    const clean = (Array.isArray(signals) ? signals : [])
      .filter(s => s && typeof s.text === 'string' && s.text && rank[s.severity] != null);
    const actionable = clean
      .filter(s => s.severity !== 'ok')
      .sort((a, b) => rank[a.severity] - rank[b.severity]);
    if (actionable.length === 0) {
      return {
        status: 'ok',
        allClear: true,
        items: [{ severity: 'ok', text: 'Alles im gruenen Bereich', target: null }],
        overflow: 0
      };
    }
    const status = actionable.some(s => s.severity === 'warn') ? 'warn' : 'info';
    const items = actionable.slice(0, max);
    return { status, allClear: false, items, overflow: actionable.length - items.length };
  }

  // ---- Langzeit-Archiv: Jahres-Heatmap + Zeitraumvergleich (Plan-Punkt 9) ----
  // rows = climate_daily-Zeilen ({ day:'YYYY-MM-DD', t_avg, t_min, t_max, h_avg, ... }).

  // Alle Tage eines Jahres mit ihrem Tagesmittel — Grundlage fuer die Kalender-
  // Heatmap. min/max dienen der Farbskalierung. Fehlende Tage tauchen nicht auf.
  function yearHeatmap(rows, year) {
    const prefix = String(year) + '-';
    const days = (Array.isArray(rows) ? rows : [])
      .filter(r => r && typeof r.day === 'string' && r.day.indexOf(prefix) === 0 && r.t_avg != null)
      .map(r => ({ day: r.day, tAvg: r.t_avg, hAvg: r.h_avg != null ? r.h_avg : null, note: r.note || null }));
    const temps = days.map(d => d.tAvg);
    return {
      year: Number(year),
      days,
      min: temps.length ? Math.min(...temps) : null,
      max: temps.length ? Math.max(...temps) : null
    };
  }

  // Zwei Zeitraeume vergleichen (z. B. Juli 2026 vs. Juli 2025, Heizperioden).
  // periodA/periodB = { from:'YYYY-MM-DD', to:'YYYY-MM-DD' } (inklusive).
  // Rueckgabe: { a, b, deltaT, deltaH } — a/b null, wenn keine Daten im Zeitraum.
  function periodCompare(rows, periodA, periodB) {
    const list = Array.isArray(rows) ? rows : [];
    const mean = arr => arr.reduce((x, y) => x + y, 0) / arr.length;
    const agg = p => {
      if (!p || !p.from || !p.to) return null;
      const sel = list.filter(r => r && r.day >= p.from && r.day <= p.to && r.t_avg != null);
      if (!sel.length) return null;
      const hs = sel.map(r => r.h_avg).filter(v => v != null);
      return {
        days: sel.length,
        tAvg: mean(sel.map(r => r.t_avg)),
        tMin: Math.min(...sel.map(r => r.t_min != null ? r.t_min : r.t_avg)),
        tMax: Math.max(...sel.map(r => r.t_max != null ? r.t_max : r.t_avg)),
        hAvg: hs.length ? mean(hs) : null
      };
    };
    const a = agg(periodA), b = agg(periodB);
    return {
      a, b,
      deltaT: (a && b) ? a.tAvg - b.tAvg : null,
      deltaH: (a && b && a.hAvg != null && b.hAvg != null) ? a.hAvg - b.hAvg : null
    };
  }

  // ---- ThingSpeak-CSV-Backfill (Plan2-Punkt 3) ----
  // Parst einen ThingSpeak-Feed-Export (Kopfzeile created_at,entry_id,field1,…)
  // in header-keyed Objekte, die processRawFeeds direkt verarbeiten kann. Roh-
  // strings bleiben erhalten (Komma-Dezimal loest processRawFeeds auf).
  function parseThingSpeakCsv(text) {
    const rows = [];
    const lines = String(text == null ? '' : text).split(/\r?\n/).filter(l => l.trim() !== '');
    if (lines.length < 2) return rows;
    const parseLine = line => {
      const out = []; let cur = ''; let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) {
          if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
          else cur += c;
        } else if (c === '"') { inQ = true; }
        else if (c === ',') { out.push(cur); cur = ''; }
        else cur += c;
      }
      out.push(cur);
      return out;
    };
    const header = parseLine(lines[0]).map(h => h.trim());
    for (let r = 1; r < lines.length; r++) {
      const cells = parseLine(lines[r]);
      const obj = {};
      header.forEach((h, i) => { obj[h] = cells[i] !== undefined ? cells[i] : ''; });
      if (obj.created_at) rows.push(obj);
    }
    return rows;
  }

  // Verdichtet processRawFeeds-Ausgabe (aligned) zu Tages-Aggregaten im POST-
  // Format von /api/climate. Tage >= todayKey ('YYYY-MM-DD') werden ausgelassen
  // (nur abgeschlossene Tage archivieren). CO2 nur, wenn an dem Tag vorhanden.
  function aggregateDailyClimate(aligned, todayKey) {
    const byDay = {};
    (Array.isArray(aligned) ? aligned : []).forEach(f => {
      if (!f || !(f.time instanceof Date) || isNaN(f.time.getTime())) return;
      const day = f.time.toISOString().substring(0, 10);
      if (todayKey && day >= todayKey) return;
      (byDay[day] = byDay[day] || []).push(f);
    });
    const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    return Object.entries(byDay).map(([day, list]) => {
      const temps = list.map(f => f.temp).filter(v => v != null && !isNaN(v));
      const hums = list.map(f => f.humidity).filter(v => v != null && !isNaN(v));
      const entry = { day, samples: list.length };
      if (temps.length) { entry.tMin = Math.min(...temps); entry.tMax = Math.max(...temps); entry.tAvg = parseFloat(avg(temps).toFixed(2)); }
      if (hums.length) { entry.hMin = Math.min(...hums); entry.hMax = Math.max(...hums); entry.hAvg = parseFloat(avg(hums).toFixed(2)); }
      const co2s = list.map(f => f.co2).filter(v => v != null && !isNaN(v));
      if (co2s.length) { entry.co2Avg = parseFloat(avg(co2s).toFixed(1)); entry.co2Max = Math.max(...co2s); }
      return entry;
    });
  }

  // Fenster-offen-Erkennung (Plan3-4): ein steiler, anhaltender Temperatursturz
  // ohne Erholung deutet auf ein offenes Fenster. aligned = processRawFeeds-
  // Ausgabe ({ time: Date, temp }). opts.now (Default Date.now()) fuer Tests.
  function detectOpenWindow(aligned, opts = {}) {
    const windowMin = opts.windowMin != null ? opts.windowMin : 45;
    const dropC = opts.dropC != null ? opts.dropC : 2.5;
    const now = opts.now != null ? opts.now : Date.now();
    const list = Array.isArray(aligned) ? aligned : [];
    if (list.length < 2) return { open: false };
    const last = list[list.length - 1];
    if (!last || !(last.time instanceof Date) || last.temp == null) return { open: false };
    // Letzter Messwert zu alt → keine Aussage (Sensor stumm ist ein anderer Fall)
    if (now - last.time.getTime() > 20 * 60 * 1000) return { open: false };
    const fromMs = last.time.getTime() - windowMin * 60 * 1000;
    const span = list.filter(e => e && e.time instanceof Date && e.time.getTime() >= fromMs && e.temp != null);
    if (span.length < 2) return { open: false };
    const temps = span.map(e => e.temp);
    const maxT = Math.max(...temps);
    const minT = Math.min(...temps);
    const drop = maxT - last.temp;
    if (drop < dropC) return { open: false };
    // Erholung: liegt der aktuelle Wert deutlich ueber dem Minimum, wurde wohl
    // schon wieder geschlossen/geheizt → kein offenes Fenster mehr.
    if (last.temp > minT + 0.3) return { open: false };
    return { open: true, dropC: Math.round(drop * 10) / 10, sinceMs: fromMs };
  }

  // Einfache Wiederholungen fuer eigene Termine expandieren (Plan3-8).
  // events = [{ startMs, endMs?, repeat: none|daily|weekly|monthly|yearly, ... }].
  // Monats-/Jahres-Vorkommen werden aus dem ORIGINAL-Start berechnet (keine
  // Drift) und der Tag auf das Monatsende geklemmt (z. B. 31. → 28./30.).
  function expandSimpleRepeat(events, fromMs, toMs, maxPerEvent = 60) {
    const addMonthsClamped = (baseMs, months, origDay) => {
      const d = new Date(baseMs);
      const nd = new Date(d.getFullYear(), d.getMonth() + months, 1, d.getHours(), d.getMinutes(), 0, 0);
      const lastDay = new Date(nd.getFullYear(), nd.getMonth() + 1, 0).getDate();
      nd.setDate(Math.min(origDay, lastDay));
      return nd.getTime();
    };
    const out = [];
    for (const e of (Array.isArray(events) ? events : [])) {
      if (!e || e.startMs == null) continue;
      const dur = (e.endMs != null && e.endMs > e.startMs) ? e.endMs - e.startMs : 0;
      const rep = e.repeat || 'none';
      if (rep === 'none') {
        if (e.startMs >= fromMs && e.startMs <= toMs) out.push({ ...e, startMs: e.startMs, endMs: e.startMs + dur });
        continue;
      }
      const origDay = new Date(e.startMs).getDate();
      for (let i = 0; i < maxPerEvent; i++) {
        let ms;
        if (rep === 'daily') ms = e.startMs + i * 86400000;
        else if (rep === 'weekly') ms = e.startMs + i * 7 * 86400000;
        else if (rep === 'monthly') ms = addMonthsClamped(e.startMs, i, origDay);
        else if (rep === 'yearly') ms = addMonthsClamped(e.startMs, i * 12, origDay);
        else break;
        if (ms > toMs) break;
        if (ms >= fromMs) out.push({ ...e, startMs: ms, endMs: ms + dur });
      }
    }
    return out.sort((a, b) => a.startMs - b.startMs);
  }

  // Sensor-Kalibrierung (Plan3-6): konstante Offsets auf Temperatur/Feuchte.
  // Liefert ein NEUES Array; Feuchte wird auf 0–100 % geklemmt. Ohne Offset
  // bleibt das Original (gleiche Referenz).
  function applyCalibration(aligned, opts = {}) {
    const tO = opts.tempOffset || 0;
    const hO = opts.humOffset || 0;
    const list = Array.isArray(aligned) ? aligned : [];
    if (!tO && !hO) return list;
    return list.map(e => {
      const out = { ...e };
      if (e.temp != null) out.temp = e.temp + tO;
      if (e.humidity != null) out.humidity = Math.max(0, Math.min(100, e.humidity + hO));
      return out;
    });
  }

  // Gradtagzahlen (Heating Degree Days, Plan2-17) aus Aussen-Tagesmitteln.
  // outDailyMeans = [{ day:'YYYY-MM-DD', tOut }]. Nach VDI: nur Tage unter der
  // Heizgrenze zaehlen, Beitrag (base - tOut). Rueckgabe { total, days, byMonth }.
  function degreeDays(outDailyMeans, opts = {}) {
    const base = opts.base != null ? opts.base : 20;
    const heatLimit = opts.heatLimit != null ? opts.heatLimit : 15;
    let total = 0, days = 0;
    const byMonth = {};
    (Array.isArray(outDailyMeans) ? outDailyMeans : []).forEach(d => {
      if (!d || typeof d.day !== 'string' || d.tOut == null || isNaN(d.tOut)) return;
      if (d.tOut >= heatLimit) return;
      const hdd = base - d.tOut;
      total += hdd; days++;
      const m = d.day.slice(0, 7);
      byMonth[m] = Math.round(((byMonth[m] || 0) + hdd) * 10) / 10;
    });
    return { total: Math.round(total * 10) / 10, days, byMonth };
  }

  // Track gleichmäßig auf maxPoints ausdünnen (erster/letzter Punkt bleiben).
  // GPX-Zielprognose (Plan4-18): rechnet aus dem bisherigen Jahres-km-Stand
  // hoch, ob das Jahresziel erreichbar ist, und was pro Woche noetig waere.
  // null bei goalKm <= 0 oder in der ersten Jahreswoche (zu wenig Daten).
  function goalForecast({ goalKm, doneKm, now = new Date() } = {}) {
    if (!goalKm || goalKm <= 0) return null;
    const yearStart = new Date(now.getFullYear(), 0, 1).getTime();
    const dayOfYear = Math.floor((now.getTime() - yearStart) / (24 * 60 * 60 * 1000)) + 1;
    if (dayOfYear < 7) return null;
    const yearLen = 365.25;
    const elapsed = dayOfYear / yearLen;
    const projectedKm = doneKm / elapsed;
    const weeksLeft = Math.max(0.1, (yearLen - dayOfYear) / 7);
    const requiredPerWeekKm = Math.max(0, (goalKm - doneKm) / weeksLeft);
    return { projectedKm, onTrack: projectedKm >= goalKm, requiredPerWeekKm };
  }

  // Persoenliche Rekorde aus den Aktivitaeten (Plan4-19). Erwartet einen Adapter
  // { id, name, startMs, distanceKm, movingSec, ascent }. Liefert laengste Tour,
  // meiste Hoehenmeter, schnellsten Schnitt (nur Touren >= 5 km) und die staerkste
  // Kalenderwoche (Mo-So). Einzelwerte { value, id?, name?, label } oder null.
  function personalRecords(activities) {
    const list = (activities || []).filter(a => a && a.startMs);
    const best = (arr, valFn) => {
      let win = null;
      arr.forEach(a => { const v = valFn(a); if (v != null && !isNaN(v) && (win === null || v > win.v)) win = { a, v }; });
      return win;
    };
    const longestW = best(list, a => a.distanceKm);
    const ascentW = best(list, a => a.ascent);
    const fastW = best(list.filter(a => a.distanceKm >= 5 && a.movingSec > 0), a => a.distanceKm / (a.movingSec / 3600));

    const weekBuckets = {};
    list.forEach(a => {
      const d = new Date(a.startMs);
      const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
      const key = monday.getTime();
      weekBuckets[key] = (weekBuckets[key] || 0) + (a.distanceKm || 0);
    });
    let bwKey = null, bwSum = -1;
    Object.entries(weekBuckets).forEach(([k, sum]) => { if (sum > bwSum) { bwSum = sum; bwKey = +k; } });
    const fmtDay = ms => {
      const d = new Date(ms);
      return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
    };

    return {
      longest: longestW ? { value: longestW.v, id: longestW.a.id, name: longestW.a.name, label: `${longestW.v.toFixed(1)} km` } : null,
      mostAscent: ascentW ? { value: ascentW.v, id: ascentW.a.id, name: ascentW.a.name, label: `${Math.round(ascentW.v)} hm` } : null,
      fastest: fastW ? { value: fastW.v, id: fastW.a.id, name: fastW.a.name, label: `${fastW.v.toFixed(1)} km/h` } : null,
      biggestWeek: bwKey != null ? { value: bwSum, name: `KW ab ${fmtDay(bwKey)}`, label: `${Math.round(bwSum)} km` } : null
    };
  }

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
    ventilationImpact,
    hourlyPattern,
    heatingDemandIndex,
    forecastExtremes,
    ventilationStats,
    climateRecords,
    monthlyInsights,
    alignYearSeries,
    trendForecast,
    dailyTrend,
    ventilationForecast,
    buildBriefing,
    yearHeatmap,
    periodCompare,
    parseThingSpeakCsv,
    aggregateDailyClimate,
    degreeDays,
    detectOpenWindow,
    applyCalibration,
    expandSimpleRepeat,
    processRawFeeds,
    haversine,
    computeStats,
    segmentSpeeds,
    computeStreaks,
    routeCells,
    routeSimilarity,
    compareTracks,
    buildGpxXml,
    guessType,
    goalForecast,
    personalRecords,
    downsamplePoints
  };
});
