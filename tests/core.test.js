// Testsuite für lib/core.js — Ausführen mit: npm test  (bzw. node tests/core.test.js)
const assert = require('assert');
const core = require('../lib/core.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    console.error(`  ✘ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('lib/core.js – Klima');

test('satVaporPressure: ~23,4 hPa bei 20 °C', () => {
  assert.ok(Math.abs(core.satVaporPressure(20) - 23.4) < 0.5);
});

test('getAbsoluteHumidity: ~8,6 g/m³ bei 20 °C / 50 %', () => {
  assert.ok(Math.abs(core.getAbsoluteHumidity(20, 50) - 8.6) < 0.2);
});

test('getAbsoluteHumidity: 0 bei ungültigen Werten', () => {
  assert.strictEqual(core.getAbsoluteHumidity(null, 50), 0);
  assert.strictEqual(core.getAbsoluteHumidity(20, NaN), 0);
});

test('getDewPoint: ~9,3 °C bei 20 °C / 50 %', () => {
  assert.ok(Math.abs(core.getDewPoint(20, 50) - 9.3) < 0.4);
});

test('getDewPoint: Taupunkt = Temperatur bei 100 % rF', () => {
  assert.ok(Math.abs(core.getDewPoint(15, 100) - 15) < 0.1);
});

test('surfaceHumidity: warme Wand ≈ Raumfeuchte (kaum Temperaturgefälle)', () => {
  // Innen 20/50, außen 19 → Oberfläche fast raumwarm, Feuchte ≈ 50 %
  const r = core.surfaceHumidity(20, 50, 19);
  assert.ok(Math.abs(r.surfaceTemp - 19.7) < 0.1, `surfaceTemp=${r.surfaceTemp}`);
  assert.ok(Math.abs(r.surfaceRh - 52) < 2, `surfaceRh=${r.surfaceRh}`);
});

test('surfaceHumidity: kalte Außenwand → erhöhte Wandfeuchte', () => {
  // Innen 21/55, außen -5 → kalte Wandstelle, deutlich höhere Oberflächenfeuchte
  const r = core.surfaceHumidity(21, 55, -5);
  // -5 + 0,7·(21−(−5)) = 13,2 °C an der Wärmebrücke (deutlich unter Raumtemp.)
  assert.ok(r.surfaceTemp < 14, `surfaceTemp=${r.surfaceTemp}`);
  assert.ok(r.surfaceRh > r.surfaceRhRaw - 0.001); // surfaceRh ist Deckelung von Raw
  assert.ok(r.surfaceRh > 80, `surfaceRh=${r.surfaceRh}`);
});

test('surfaceHumidity: surfaceRh ist auf 100 % gedeckelt, Raw kann darüber liegen', () => {
  // Extrem: sehr feucht innen, sehr kalt außen → Kondensat (Raw > 100)
  const r = core.surfaceHumidity(22, 75, -15);
  assert.ok(r.surfaceRhRaw > 100, `raw=${r.surfaceRhRaw}`);
  assert.strictEqual(r.surfaceRh, 100);
});

test('surfaceHumidity: null bei ungültigen Werten', () => {
  assert.strictEqual(core.surfaceHumidity(null, 50, 5), null);
  assert.strictEqual(core.surfaceHumidity(20, NaN, 5), null);
  assert.strictEqual(core.surfaceHumidity(20, 50, undefined), null);
});

test('comfortScore: 100 im Wohlfühlband, Abzüge außerhalb', () => {
  assert.strictEqual(core.comfortScore(21, 50), 100);
  // 2 °C zu warm → −16
  assert.strictEqual(core.comfortScore(26, 50), 84);
  // 10 % zu feucht → −15
  assert.strictEqual(core.comfortScore(21, 70), 85);
  // Extremwerte: Abzüge sind gedeckelt (max. −40 Temp, −30 Feuchte)
  assert.strictEqual(core.comfortScore(40, 100), 100 - 40 - 30);
  assert.strictEqual(core.comfortScore(null, 50), null);
});

test('comfortScore: Schimmelrisiko senkt den Score, eigene Schwellwerte greifen', () => {
  assert.strictEqual(core.comfortScore(21, 50, 85), 70);       // >=80 % Wand → −30
  assert.strictEqual(core.comfortScore(21, 50, 75), 85);       // 75 % → −15
  assert.strictEqual(core.comfortScore(21, 50, 60), 100);      // unkritisch
  // Eigenes Band 20–22 °C: 23 °C ist jetzt 1 °C drüber → −8
  assert.strictEqual(core.comfortScore(23, 50, null, { tempMin: 20, tempMax: 22 }), 92);
});

test('detectVentilationEvents: erkennt Stoßlüften (Feuchte+Temp fallen schnell)', () => {
  const t0 = Date.UTC(2026, 6, 1, 8, 0, 0);
  const mk = (min, temp, hum) => ({ time: new Date(t0 + min * 60000), temp, humidity: hum });
  const aligned = [
    mk(0, 22.0, 58), mk(10, 22.1, 58),
    mk(20, 21.0, 52), mk(30, 20.2, 49),  // Lüftungssturz: −1,9 °C / −9 %
    mk(40, 20.8, 50), mk(50, 21.5, 52)
  ];
  const events = core.detectVentilationEvents(aligned);
  assert.strictEqual(events.length, 1);
  assert.ok(events[0].humDrop >= 9, `humDrop=${events[0].humDrop}`);
  assert.ok(events[0].tempDrop >= 1.8, `tempDrop=${events[0].tempDrop}`);
  assert.strictEqual(events[0].humBefore, 58);
});

test('detectVentilationEvents: Heizen (Feuchte sinkt, Temp steigt) ist KEIN Lüften', () => {
  const t0 = Date.UTC(2026, 6, 1, 8, 0, 0);
  const mk = (min, temp, hum) => ({ time: new Date(t0 + min * 60000), temp, humidity: hum });
  const aligned = [mk(0, 20.0, 60), mk(15, 21.0, 55), mk(30, 22.0, 50)];
  assert.strictEqual(core.detectVentilationEvents(aligned).length, 0);
});

test('detectVentilationEvents: langsamer Abfall über Stunden ist KEIN Lüften', () => {
  const t0 = Date.UTC(2026, 6, 1, 8, 0, 0);
  const aligned = [];
  for (let i = 0; i < 12; i++) {
    aligned.push({ time: new Date(t0 + i * 60 * 60000), temp: 22 - i * 0.3, humidity: 60 - i });
  }
  assert.strictEqual(core.detectVentilationEvents(aligned).length, 0);
});

test('heatingDemandIndex: heute vs. gestern inkl. Prozent-Änderung', () => {
  const now = Date.UTC(2026, 6, 2, 12, 0, 0);
  const h = 60 * 60 * 1000;
  const pairs = [];
  // Gestern: Differenz konstant 10 °C, heute: konstant 12 °C → +20 %
  // (Samples zur halben Stunde, damit keiner auf eine Fenstergrenze fällt)
  for (let i = 1; i <= 24; i++) pairs.push({ ms: now - 24 * h - i * h + h / 2, tin: 21, tout: 11 });
  for (let i = 1; i <= 24; i++) pairs.push({ ms: now - i * h + h / 2, tin: 21, tout: 9 });
  const r = core.heatingDemandIndex(pairs, now);
  assert.ok(Math.abs(r.today - 12) < 0.01, `today=${r.today}`);
  assert.ok(Math.abs(r.yesterday - 10) < 0.01, `yesterday=${r.yesterday}`);
  assert.ok(Math.abs(r.changePct - 20) < 0.5, `changePct=${r.changePct}`);
});

test('heatingDemandIndex: ohne Daten null, Sommer (innen kälter) → Index 0', () => {
  const now = Date.UTC(2026, 6, 2, 12, 0, 0);
  assert.strictEqual(core.heatingDemandIndex([], now).today, null);
  const pairs = [{ ms: now - 1000, tin: 22, tout: 30 }];
  assert.strictEqual(core.heatingDemandIndex(pairs, now).today, 0);
  assert.strictEqual(core.heatingDemandIndex(pairs, now).changePct, null);
});

test('forecastExtremes: Min/Max im Fenster, außerhalb wird ignoriert', () => {
  const now = Date.UTC(2026, 6, 1, 20, 0, 0);
  const times = [], temps = [];
  for (let i = 0; i < 24; i++) {
    times.push((now + i * 3600 * 1000) / 1000); // Unix-Sekunden
    temps.push(10 - i);                          // fällt stündlich um 1 °C
  }
  const r = core.forecastExtremes(times, temps, now, 12);
  assert.strictEqual(r.max, 10);
  assert.strictEqual(r.min, 10 - 12);
  assert.strictEqual(r.minAtMs, now + 12 * 3600 * 1000);
  // Fenster ohne Stunden → null
  assert.strictEqual(core.forecastExtremes(times, temps, now - 100 * 3600 * 1000, 1), null);
});

test('processRawFeeds: Forward-Fill bildet Paare, Komma-Dezimal wird geparst', () => {
  const feeds = [
    { created_at: '2026-07-01T10:00:00Z', field1: '21,5', field2: null, entry_id: 1 },
    { created_at: '2026-07-01T10:05:00Z', field1: null, field2: '50', entry_id: 2 },
    { created_at: '2026-07-01T10:10:00Z', field1: '22,0', field2: null, entry_id: 3 },
    { created_at: '2026-07-01T10:15:00Z', field1: null, field2: '52', entry_id: 4 }
  ];
  const { aligned } = core.processRawFeeds(feeds);
  // Paare ab Eintrag 2; Eintrag 4 wird getrimmt (Temperatur dort nur mitgezogen,
  // letztes echtes Paar endet bei 10:10)
  assert.strictEqual(aligned.length, 2);
  assert.strictEqual(aligned[0].temp, 21.5);
  assert.strictEqual(aligned[0].humidity, 50);
  assert.strictEqual(aligned[1].temp, 22.0);
  assert.strictEqual(aligned[1].humidity, 50); // forward-filled
});

test('processRawFeeds: Stale-Tail wird abgeschnitten (Chart endet beim letzten echten Paar)', () => {
  const feeds = [
    { created_at: '2026-07-01T10:00:00Z', field1: '21', field2: '50', entry_id: 1 },
    { created_at: '2026-07-01T10:10:00Z', field1: '22', field2: null, entry_id: 2 },
    // Temperatur fällt aus, nur noch Feuchte:
    { created_at: '2026-07-01T10:20:00Z', field1: null, field2: '55', entry_id: 3 },
    { created_at: '2026-07-01T10:30:00Z', field1: null, field2: '60', entry_id: 4 }
  ];
  const { aligned, lastTempTime, lastHumTime } = core.processRawFeeds(feeds);
  assert.strictEqual(lastTempTime.toISOString(), '2026-07-01T10:10:00.000Z');
  assert.strictEqual(lastHumTime.toISOString(), '2026-07-01T10:30:00.000Z');
  // Einträge nach 10:10 (nur mitgezogene Temperatur) müssen entfernt sein:
  assert.strictEqual(aligned[aligned.length - 1].time.toISOString(), '2026-07-01T10:10:00.000Z');
});

test('processRawFeeds: leere/ungültige Felder werden ignoriert', () => {
  const feeds = [
    { created_at: '2026-07-01T10:00:00Z', field1: '  ', field2: 'abc', entry_id: 1 },
    { created_at: '2026-07-01T10:05:00Z', field1: '20', field2: '40', entry_id: 2 }
  ];
  const { aligned } = core.processRawFeeds(feeds);
  assert.strictEqual(aligned.length, 1);
  assert.strictEqual(aligned[0].temp, 20);
});

test('processRawFeeds: benutzerdefiniertes Feld-Mapping (n-Kanäle-Schema)', () => {
  const feeds = [
    { created_at: '2026-07-01T10:00:00Z', field3: '21,5', field7: '48', entry_id: 1 },
    { created_at: '2026-07-01T10:05:00Z', field3: '22,0', field7: '50', entry_id: 2 }
  ];
  const { aligned } = core.processRawFeeds(feeds, { temp: 'field3', humidity: 'field7' });
  assert.strictEqual(aligned.length, 2);
  assert.strictEqual(aligned[0].temp, 21.5);
  assert.strictEqual(aligned[1].humidity, 50);
});

test('processRawFeeds: Extra-Felder (z. B. CO₂) werden forward-gefüllt angehängt', () => {
  const feeds = [
    { created_at: '2026-07-01T10:00:00Z', field1: '21', field2: '50', entry_id: 1 },
    { created_at: '2026-07-01T10:05:00Z', field1: '21', field2: '51', field3: '820', entry_id: 2 },
    { created_at: '2026-07-01T10:10:00Z', field1: '22', field2: '52', entry_id: 3 }
  ];
  const { aligned } = core.processRawFeeds(feeds, { extra: [{ key: 'co2', field: 'field3' }] });
  assert.strictEqual(aligned[0].co2, null);   // noch kein Wert
  assert.strictEqual(aligned[1].co2, 820);
  assert.strictEqual(aligned[2].co2, 820);    // forward-gefüllt
  assert.strictEqual(aligned[2].temp, 22);    // Standard-Felder unverändert
});

test('parseIcsEvents: UTC-Zeit, Ganztag, gefaltete Zeile, RRULE-Markierung', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'DTSTART:20260710T120000Z',
    'SUMMARY:Zahnarzt\\, Kontrolle',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20260712',
    // RFC-5545-Faltung: Fortsetzungszeile beginnt mit Leerzeichen (wird beim
    // Entfalten entfernt — das Inhalts-Leerzeichen steht vor dem Umbruch)
    'SUMMARY:Geburtstag mit einem sehr langen Titel der ',
    ' umgebrochen wurde',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART;TZID=Europe/Berlin:20260708T090000',
    'RRULE:FREQ=WEEKLY',
    'SUMMARY:Weekly',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
  const events = core.parseIcsEvents(ics);
  assert.strictEqual(events.length, 3);
  // sortiert nach Start: Weekly (08.), Zahnarzt (10.), Geburtstag (12.)
  assert.strictEqual(events[0].summary, 'Weekly');
  assert.strictEqual(events[0].recurring, true);
  assert.strictEqual(events[1].summary, 'Zahnarzt, Kontrolle');
  assert.strictEqual(events[1].startMs, Date.UTC(2026, 6, 10, 12, 0, 0));
  assert.strictEqual(events[1].allDay, false);
  assert.strictEqual(events[2].summary, 'Geburtstag mit einem sehr langen Titel der umgebrochen wurde');
  assert.strictEqual(events[2].allDay, true);
  // Müll rein → leeres Array
  assert.deepStrictEqual(core.parseIcsEvents('<html>Fehler</html>'), []);
});

test('ventilationStats: Anzahl, Ø-Feuchteabfall, Tageszählung', () => {
  const now = Date.UTC(2026, 6, 15, 12, 0, 0);
  const day = 86400000;
  const events = [
    { startMs: now - 1 * day, humDrop: 8 },
    { startMs: now - 1 * day + 3600000, humDrop: 6 },
    { startMs: now - 5 * day, humDrop: 10 },
    { startMs: now - 20 * day, humDrop: 99 } // außerhalb des 14-Tage-Fensters
  ];
  const s = core.ventilationStats(events, { nowMs: now, days: 14 });
  assert.strictEqual(s.count, 3);
  assert.ok(Math.abs(s.avgHumDrop - 8) < 1e-9);
  assert.strictEqual(s.dailyCounts.length, 14);
  assert.ok(Math.abs(s.perDay - 3 / 14) < 1e-9);
});

test('climateRecords: Extremwerte + Komfort-Serie', () => {
  const rows = [
    { day: '2026-01-01', t_min: -2, t_max: 5, t_avg: 21, h_avg: 50 }, // Komfort ~100
    { day: '2026-01-02', t_min: 1, t_max: 8, t_avg: 22, h_avg: 52 }, // ~100
    { day: '2026-01-03', t_min: 3, t_max: 25, t_avg: 30, h_avg: 80 }, // heiß+feucht → niedrig
    { day: '2026-01-04', t_min: 4, t_max: 10, t_avg: 20, h_avg: 45 }  // ~100
  ];
  const r = core.climateRecords(rows);
  assert.strictEqual(r.warmest.day, '2026-01-03');
  assert.strictEqual(r.coldest.day, '2026-01-01');
  assert.strictEqual(r.wettest.day, '2026-01-03');
  assert.strictEqual(r.comfortStreak, 2); // 01.+02. zusammenhängend, 03. bricht
});

test('trendForecast: steigende Feuchte erreicht Schwelle in der Zukunft', () => {
  const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
  const aligned = [];
  for (let i = 0; i < 7; i++) aligned.push({ time: new Date(t0 + i * 1800000), humidity: 50 + i * 2, temp: 21 });
  // +2 %/30min = 4 %/h; von 62 (letzter) auf 70 → ~2 h
  const tf = core.trendForecast(aligned, { threshold: 70 });
  assert.ok(Math.abs(tf.slopePerHour - 4) < 0.001, `slope=${tf.slopePerHour}`);
  assert.strictEqual(tf.current, 62);
  assert.ok(tf.etaMs > aligned[aligned.length - 1].time.getTime());
  // ohne Trend (zu wenige Punkte) → null
  assert.strictEqual(core.trendForecast([{ time: new Date(t0), humidity: 50 }]), null);
});

test('expandRecurring: wöchentlich expandiert im Fenster, EXDATE ausgenommen', () => {
  const events = [{
    startMs: Date.UTC(2026, 6, 7, 10, 0, 0), // Di 07.07.2026 12:00 Berlin ~ 10:00Z
    summary: 'Sport', allDay: false, rrule: 'FREQ=WEEKLY;INTERVAL=1',
    exdates: [Date.UTC(2026, 6, 21, 10, 0, 0)] // 21.07. fällt aus
  }];
  const occ = core.expandRecurring(events, Date.UTC(2026, 6, 1), Date.UTC(2026, 6, 31, 23, 59));
  const days = occ.map(o => new Date(o.startMs).getUTCDate());
  assert.deepStrictEqual(days, [7, 14, 28]); // 21. ausgenommen
  assert.ok(occ.every(o => o.recurring === true));
});

test('expandRecurring: COUNT begrenzt die Anzahl', () => {
  const events = [{ startMs: Date.UTC(2026, 0, 1, 8, 0, 0), summary: 'A', rrule: 'FREQ=DAILY;COUNT=3' }];
  const occ = core.expandRecurring(events, Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1));
  assert.strictEqual(occ.length, 3);
});

test('expandRecurring: UNTIL beendet die Serie', () => {
  const events = [{ startMs: Date.UTC(2026, 0, 1, 8, 0, 0), summary: 'A', rrule: 'FREQ=DAILY;UNTIL=20260105T000000Z' }];
  const occ = core.expandRecurring(events, Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1));
  assert.strictEqual(occ.length, 4); // 1.,2.,3.,4. (5. um 00:00 ausgeschlossen? >UNTIL bei 00:00:00 → 5. 08:00 liegt nach UNTIL)
});

test('expandRecurring: BYDAY erzeugt mehrere Wochentage', () => {
  // Start Mo 05.01.2026, jede Woche Mo+Mi+Fr
  const events = [{ startMs: Date.UTC(2026, 0, 5, 9, 0, 0), summary: 'Kurs', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR' }];
  const occ = core.expandRecurring(events, Date.UTC(2026, 0, 5), Date.UTC(2026, 0, 11, 23, 59));
  // erste Woche: Mo 5., Mi 7., Fr 9.
  const days = occ.map(o => new Date(o.startMs).getUTCDate()).sort((a, b) => a - b);
  assert.deepStrictEqual(days, [5, 7, 9]);
});

test('expandRecurring: Einzeltermin ohne RRULE bleibt erhalten', () => {
  const events = [{ startMs: Date.UTC(2026, 5, 15, 10, 0), summary: 'Einmalig', allDay: false }];
  const occ = core.expandRecurring(events, Date.UTC(2026, 5, 1), Date.UTC(2026, 5, 30));
  assert.strictEqual(occ.length, 1);
  assert.strictEqual(occ[0].recurring, false);
});

console.log('lib/core.js – GPX');

test('haversine: 1° Länge am Äquator ≈ 111,2 km', () => {
  assert.ok(Math.abs(core.haversine(0, 0, 0, 1) - 111195) < 300);
});

test('computeStats: Distanz, Bewegungszeit, Ø-Tempo (Spaziergang)', () => {
  // 10 Punkte, je ~100 m und 60 s Abstand → ~900 m in 9 min ≈ 6 km/h
  const t0 = Date.UTC(2026, 6, 1, 10, 0, 0);
  const points = [];
  for (let i = 0; i < 10; i++) {
    points.push([48.0 + i * 0.0009, 9.0, 100 + i * 10, t0 + i * 60 * 1000]);
  }
  const s = core.computeStats(points);
  assert.ok(Math.abs(s.distM - 900) < 20, `distM=${s.distM}`);
  assert.strictEqual(s.movingSec, 540);
  assert.ok(Math.abs(s.avgSpeed - 6.0) < 0.3, `avgSpeed=${s.avgSpeed}`);
  assert.strictEqual(s.eleMin, 100);
  assert.strictEqual(s.eleMax, 190);
  assert.ok(s.elevGain > 20, `elevGain=${s.elevGain}`);
  assert.strictEqual(s.startTime, t0);
});

test('computeStats: Pausen > 10 min zählen nicht als Bewegungszeit', () => {
  const t0 = Date.UTC(2026, 6, 1, 10, 0, 0);
  const points = [
    [48.0, 9.0, null, t0],
    [48.0009, 9.0, null, t0 + 60 * 1000],
    // 20 Minuten Pause:
    [48.0018, 9.0, null, t0 + 21 * 60 * 1000],
    [48.0027, 9.0, null, t0 + 22 * 60 * 1000]
  ];
  const s = core.computeStats(points);
  assert.strictEqual(s.movingSec, 120); // nur die zwei 60s-Segmente
  assert.strictEqual(s.totalSec, 22 * 60);
});

test('computeStats: ohne Zeitstempel keine Tempo-Werte', () => {
  const points = [[48.0, 9.0, null, null], [48.001, 9.0, null, null]];
  const s = core.computeStats(points);
  assert.strictEqual(s.totalSec, null);
  assert.strictEqual(s.avgSpeed, null);
  assert.strictEqual(s.maxSpeed, null);
});

test('guessType: Grenzwerte', () => {
  assert.strictEqual(core.guessType(5), 'walk');
  assert.strictEqual(core.guessType(10), 'run');
  assert.strictEqual(core.guessType(25), 'ride');
  assert.strictEqual(core.guessType(60), 'moto');
  assert.strictEqual(core.guessType(null), 'ride');
});

test('downsamplePoints: dünnt auf maxPoints aus, erster/letzter Punkt bleiben', () => {
  const points = [];
  for (let i = 0; i < 12000; i++) points.push([i, i, null, null]);
  const out = core.downsamplePoints(points, 5000);
  assert.strictEqual(out.length, 5000);
  assert.strictEqual(out[0][0], 0);
  assert.strictEqual(out[out.length - 1][0], 11999);
});

test('downsamplePoints: kleine Tracks bleiben unverändert', () => {
  const points = [[1, 1, null, null], [2, 2, null, null]];
  assert.strictEqual(core.downsamplePoints(points, 5000), points);
});

test('segmentSpeeds: konstantes Tempo, null ohne Zeitdaten', () => {
  const t0 = Date.UTC(2026, 6, 1, 10, 0, 0);
  // ~100 m pro 60 s ≈ 6 km/h
  const points = [];
  for (let i = 0; i < 5; i++) points.push([48.0 + i * 0.0009, 9.0, null, t0 + i * 60000]);
  const speeds = core.segmentSpeeds(points);
  assert.strictEqual(speeds.length, 4);
  speeds.forEach(v => assert.ok(Math.abs(v - 6.0) < 0.3, `v=${v}`));
  const noTime = core.segmentSpeeds([[48, 9, null, null], [48.001, 9, null, null]]);
  assert.strictEqual(noTime[0], null);
});

test('computeStreaks: aktuelle und längste Serie', () => {
  const days = ['2026-06-28', '2026-06-29', '2026-06-30', '2026-07-02', '2026-07-03', '2026-07-04'];
  const s = core.computeStreaks(days, '2026-07-04');
  assert.strictEqual(s.current, 3);  // 02.–04.
  assert.strictEqual(s.longest, 3);
  // heute nichts, gestern schon → Serie hält noch
  const s2 = core.computeStreaks(['2026-07-02', '2026-07-03'], '2026-07-04');
  assert.strictEqual(s2.current, 2);
  // Lücke seit vorgestern → Serie gerissen
  const s3 = core.computeStreaks(['2026-07-01'], '2026-07-04');
  assert.strictEqual(s3.current, 0);
  assert.strictEqual(s3.longest, 1);
});

test('routeCells/routeSimilarity: gleiche Strecke ~1, fremde Strecke ~0', () => {
  const mk = offset => {
    const pts = [];
    for (let i = 0; i < 100; i++) pts.push([48.0 + i * 0.0005 + offset, 9.0 + i * 0.0003, null, null]);
    return pts;
  };
  const a = core.routeCells(mk(0));
  const b = core.routeCells(mk(0.0001));  // GPS-Streuung ~11 m
  const c = core.routeCells(mk(0.05));    // ganz woanders (~5,5 km)
  assert.ok(core.routeSimilarity(a, a) === 1);
  assert.ok(core.routeSimilarity(a, b) > 0.6, `sim=${core.routeSimilarity(a, b)}`);
  assert.ok(core.routeSimilarity(a, c) < 0.05, `sim=${core.routeSimilarity(a, c)}`);
});

test('compareTracks: langsamere Tour hat positives, wachsendes Delta', () => {
  const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
  const ref = [], slow = [];
  // Referenz: 100 m alle 60 s; langsam: 100 m alle 120 s (doppelte Zeit)
  for (let i = 0; i < 20; i++) {
    const lat = 48 + i * 0.0009, lon = 9;
    ref.push([lat, lon, null, t0 + i * 60000]);
    slow.push([lat, lon, null, t0 + i * 120000]);
  }
  const cmp = core.compareTracks(ref, slow, 300);
  assert.ok(cmp.length >= 3);
  assert.ok(cmp.every(s => s.deltaSec > 0), 'alle Deltas positiv');
  // Delta wächst mit der Distanz (langsamer bleibt langsamer)
  assert.ok(cmp[cmp.length - 1].deltaSec > cmp[0].deltaSec);
  // leere Eingabe → leeres Ergebnis
  assert.deepStrictEqual(core.compareTracks([], slow), []);
});

test('buildGpxXml: gültiges GPX mit Punkten, Höhe, Zeit und escaptem Namen', () => {
  const xml = core.buildGpxXml({
    name: 'Tour <A> & B',
    points: [[48.1, 9.2, 312.5, Date.UTC(2026, 6, 1, 10, 0, 0)], [48.2, 9.3, null, null]]
  });
  assert.ok(xml.startsWith('<?xml'));
  assert.ok(xml.includes('lat="48.1" lon="9.2"'));
  assert.ok(xml.includes('<ele>312.5</ele>'));
  assert.ok(xml.includes('<time>2026-07-01T10:00:00.000Z</time>'));
  assert.ok(xml.includes('Tour &lt;A&gt; &amp; B'));
  assert.ok(!xml.includes('<ele></ele>'));
  // zweiter Punkt ohne ele/time
  assert.ok(xml.includes('<trkpt lat="48.2" lon="9.3"></trkpt>'));
});

console.log('\nlib/core.js – Status-Briefing');

test('buildBriefing: leere/keine Signale → allClear', () => {
  const r = core.buildBriefing([]);
  assert.strictEqual(r.allClear, true);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].severity, 'ok');
  // Auch bei nur 'ok'-Signalen (Bereiche geprueft, alles gut)
  const r2 = core.buildBriefing([{ severity: 'ok', text: 'Sensoren frisch' }]);
  assert.strictEqual(r2.allClear, true);
});

test('buildBriefing: warn vor info, status folgt der schwersten', () => {
  const r = core.buildBriefing([
    { severity: 'info', text: 'Hohe Luftfeuchte' },
    { severity: 'warn', text: 'Sensor stumm' }
  ]);
  assert.strictEqual(r.status, 'warn');
  assert.strictEqual(r.allClear, false);
  assert.strictEqual(r.items[0].text, 'Sensor stumm');
  assert.strictEqual(r.items[1].text, 'Hohe Luftfeuchte');
  // nur Hinweise → status info
  assert.strictEqual(core.buildBriefing([{ severity: 'info', text: 'x' }]).status, 'info');
});

test('buildBriefing: begrenzt auf max und meldet overflow', () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ severity: 'warn', text: `W${i}` }));
  const r = core.buildBriefing(many, { max: 5 });
  assert.strictEqual(r.items.length, 5);
  assert.strictEqual(r.overflow, 2);
});

test('buildBriefing: ignoriert kaputte Signale', () => {
  const r = core.buildBriefing([
    null,
    { severity: 'warn' },            // kein text
    { severity: 'schlimm', text: 'x' }, // unbekannte severity
    { severity: 'warn', text: 'echt' }
  ]);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].text, 'echt');
});

console.log('\nlib/core.js – Archiv (Jahr/Saison)');

const archiveRows = [
  { day: '2025-07-01', t_avg: 20, t_min: 16, t_max: 25, h_avg: 55 },
  { day: '2025-07-15', t_avg: 22, t_min: 18, t_max: 28, h_avg: 60 },
  { day: '2026-07-01', t_avg: 24, t_min: 19, t_max: 30, h_avg: 50 },
  { day: '2026-07-10', t_avg: 26, t_min: 21, t_max: 33, h_avg: 52 },
  { day: '2026-01-05', t_avg: 5,  t_min: 2,  t_max: 9,  h_avg: 70 }
];

test('yearHeatmap: filtert aufs Jahr, liefert min/max', () => {
  const h = core.yearHeatmap(archiveRows, 2026);
  assert.strictEqual(h.year, 2026);
  assert.strictEqual(h.days.length, 3); // zwei Juli-Tage + ein Januar-Tag
  assert.strictEqual(h.min, 5);
  assert.strictEqual(h.max, 26);
  // leeres/fremdes Jahr → keine Tage, min/max null
  const empty = core.yearHeatmap(archiveRows, 2020);
  assert.strictEqual(empty.days.length, 0);
  assert.strictEqual(empty.min, null);
});

test('periodCompare: Juli 2026 vs. Juli 2025 (Delta)', () => {
  const r = core.periodCompare(archiveRows,
    { from: '2026-07-01', to: '2026-07-31' },
    { from: '2025-07-01', to: '2025-07-31' });
  assert.strictEqual(r.a.days, 2);
  assert.strictEqual(r.b.days, 2);
  assert.strictEqual(r.a.tAvg, 25); // (24+26)/2
  assert.strictEqual(r.b.tAvg, 21); // (20+22)/2
  assert.strictEqual(r.deltaT, 4);
  assert.strictEqual(r.a.tMax, 33);
  assert.ok(Math.abs(r.deltaH - (51 - 57.5)) < 1e-9);
});

test('periodCompare: leerer Zeitraum → null-Seite, kein Delta', () => {
  const r = core.periodCompare(archiveRows,
    { from: '2026-07-01', to: '2026-07-31' },
    { from: '2024-07-01', to: '2024-07-31' });
  assert.ok(r.a);
  assert.strictEqual(r.b, null);
  assert.strictEqual(r.deltaT, null);
});

console.log('\nlib/core.js – ThingSpeak-CSV-Backfill');

test('parseThingSpeakCsv: Kopfzeile, Anfuehrungszeichen, leere Felder', () => {
  const csv = [
    'created_at,entry_id,field1,field2',
    '2026-01-01T10:00:00Z,1,"21,5",55',
    '2026-01-01T11:00:00Z,2,22,',        // field2 leer
    '',                                   // Leerzeile
    '2026-01-01T12:00:00Z,3,"20,0","60"'
  ].join('\n');
  const rows = core.parseThingSpeakCsv(csv);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].field1, '21,5'); // Rohstring, Komma bleibt
  assert.strictEqual(rows[0].created_at, '2026-01-01T10:00:00Z');
  assert.strictEqual(rows[1].field2, '');     // leeres Feld
  assert.strictEqual(rows[2].field2, '60');   // entquotet
  // Ohne Datenzeilen: leeres Array
  assert.deepStrictEqual(core.parseThingSpeakCsv('created_at,entry_id\n'), []);
  assert.deepStrictEqual(core.parseThingSpeakCsv(''), []);
});

test('parseThingSpeakCsv + processRawFeeds + aggregateDailyClimate: Kette', () => {
  const csv = [
    'created_at,entry_id,field1,field2',
    '2026-01-01T08:00:00Z,1,"20,0","50"',
    '2026-01-01T20:00:00Z,2,"24,0","60"',
    '2026-01-02T09:00:00Z,3,"18,0","70"'
  ].join('\n');
  const rows = core.parseThingSpeakCsv(csv);
  const aligned = core.processRawFeeds(rows, { temp: 'field1', humidity: 'field2' }).aligned;
  const days = core.aggregateDailyClimate(aligned, '2026-01-03');
  const d1 = days.find(d => d.day === '2026-01-01');
  assert.strictEqual(d1.samples, 2);
  assert.strictEqual(d1.tMin, 20);
  assert.strictEqual(d1.tMax, 24);
  assert.strictEqual(d1.tAvg, 22);
  assert.strictEqual(d1.hAvg, 55);
});

test('aggregateDailyClimate: heutiger Tag ausgelassen, CO2 nur bei Werten', () => {
  const mk = (iso, temp, humidity, co2) => ({ time: new Date(iso), temp, humidity, co2 });
  const aligned = [
    mk('2026-01-01T08:00:00Z', 20, 50, 800),
    mk('2026-01-01T20:00:00Z', 22, 54, 1200),
    mk('2026-01-02T09:00:00Z', 19, 60, null) // kein CO2
  ];
  const days = core.aggregateDailyClimate(aligned, '2026-01-02'); // 02. = heute → raus
  assert.strictEqual(days.length, 1);
  assert.strictEqual(days[0].day, '2026-01-01');
  assert.strictEqual(days[0].co2Avg, 1000);
  assert.strictEqual(days[0].co2Max, 1200);
  // Tag ohne CO2 hat keine co2-Felder
  const days2 = core.aggregateDailyClimate(aligned, '2026-01-03');
  const d2 = days2.find(d => d.day === '2026-01-02');
  assert.ok(!('co2Avg' in d2));
});

console.log('\nlib/core.js – Gradtagzahlen (Heizkosten)');

test('degreeDays: nur Tage unter Heizgrenze zaehlen', () => {
  const r = core.degreeDays([
    { day: '2026-01-01', tOut: 0 },   // 20-0 = 20
    { day: '2026-01-02', tOut: 10 },  // 20-10 = 10
    { day: '2026-01-03', tOut: 15 },  // = heatLimit → 0 (nicht gezaehlt)
    { day: '2026-01-04', tOut: 18 }   // > heatLimit → 0
  ]);
  assert.strictEqual(r.total, 30);
  assert.strictEqual(r.days, 2);
  assert.strictEqual(r.byMonth['2026-01'], 30);
});

test('degreeDays: warmer Sommer ergibt 0', () => {
  const r = core.degreeDays([{ day: '2026-07-01', tOut: 25 }, { day: '2026-07-02', tOut: 30 }]);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.days, 0);
});

test('degreeDays: eigene base/heatLimit, ungueltige Werte ignoriert', () => {
  const r = core.degreeDays([
    { day: '2026-02-01', tOut: 5 },       // base 18: 18-5 = 13
    { day: '2026-02-02', tOut: null },     // ignoriert
    { day: '2026-02-03', tOut: 12 }        // >= heatLimit 10 → 0
  ], { base: 18, heatLimit: 10 });
  assert.strictEqual(r.total, 13);
  assert.strictEqual(r.days, 1);
});

console.log('\nlib/core.js – Fenster-offen-Erkennung');

const mkPt = (minAgo, temp, T0) => ({ time: new Date(T0 - minAgo * 60000), temp });

test('detectOpenWindow: klarer Sturz ohne Erholung -> offen', () => {
  const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const aligned = [mkPt(45, 22, T0), mkPt(30, 21, T0), mkPt(15, 20, T0), mkPt(0, 19.5, T0)];
  const r = core.detectOpenWindow(aligned, { now: T0 });
  assert.strictEqual(r.open, true);
  assert.strictEqual(r.dropC, 2.5);
});

test('detectOpenWindow: Sturz mit Erholung (Stosslueften) -> zu', () => {
  const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const aligned = [mkPt(45, 24, T0), mkPt(20, 20, T0), mkPt(0, 21, T0)]; // wieder gestiegen
  assert.strictEqual(core.detectOpenWindow(aligned, { now: T0 }).open, false);
});

test('detectOpenWindow: stale letzter Wert -> zu', () => {
  const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const aligned = [mkPt(75, 22, T0), mkPt(45, 20, T0), mkPt(30, 19, T0)]; // letzter Wert 30 min alt
  assert.strictEqual(core.detectOpenWindow(aligned, { now: T0 }).open, false);
});

console.log('\nlib/core.js – Sensor-Kalibrierung');

test('applyCalibration: Offsets angewandt, Feuchte geklemmt', () => {
  const r = core.applyCalibration([{ temp: 20, humidity: 55 }, { temp: 18, humidity: 98 }], { tempOffset: 1.5, humOffset: 5 });
  assert.strictEqual(r[0].temp, 21.5);
  assert.strictEqual(r[0].humidity, 60);
  assert.strictEqual(r[1].humidity, 100); // 98+5 -> auf 100 geklemmt
});

test('applyCalibration: ohne Offset unveraendert, leeres Array', () => {
  const src = [{ temp: 20, humidity: 50 }];
  assert.strictEqual(core.applyCalibration(src, {}), src); // gleiche Referenz
  assert.deepStrictEqual(core.applyCalibration([], { tempOffset: 2 }), []);
});

console.log('\nlib/core.js – Termin-Wiederholung');

test('expandSimpleRepeat: taeglich im Fenster', () => {
  const start = Date.UTC(2026, 0, 1, 9, 0, 0);
  const r = core.expandSimpleRepeat([{ id: 'a', startMs: start, repeat: 'daily' }], start, start + 3 * 86400000);
  assert.strictEqual(r.length, 4); // Tag 0,1,2,3
});

test('expandSimpleRepeat: monatlich am 31. klemmt auf Monatsende', () => {
  const start = Date.UTC(2026, 0, 31, 8, 0, 0); // 31. Jan
  const r = core.expandSimpleRepeat([{ id: 'b', startMs: start, repeat: 'monthly' }], start, Date.UTC(2026, 2, 1));
  // Jan 31 + Feb (28.) → zwei Vorkommen; das Februar-Datum ist der 28.
  const febDay = new Date(r[1].startMs).getUTCDate();
  assert.strictEqual(r.length, 2);
  assert.strictEqual(febDay, 28);
});

test('expandSimpleRepeat: none nur im Fenster', () => {
  const start = Date.UTC(2026, 5, 1);
  assert.strictEqual(core.expandSimpleRepeat([{ id: 'c', startMs: start, repeat: 'none' }], start - 10, start + 10).length, 1);
  assert.strictEqual(core.expandSimpleRepeat([{ id: 'c', startMs: start, repeat: 'none' }], start + 100, start + 200).length, 0);
});

console.log(process.exitCode === 1 ? '\nTests FEHLGESCHLAGEN' : `\nAlle ${passed} Tests bestanden ✔`);
