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

console.log(process.exitCode === 1 ? '\nTests FEHLGESCHLAGEN' : `\nAlle ${passed} Tests bestanden ✔`);
