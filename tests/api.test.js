// Server-API-Tests fuer die Pages-Functions (Plan2-Punkt 6).
// Fuehrt die echten Endpunkte gegen einen node:sqlite-D1-Adapter aus und prueft
// vor allem die riskante Merge-/Tombstone-Logik (LWW). Ausfuehren: npm test.
// Benoetigt Node >= 22 (node:sqlite).
const assert = require('assert');
const { createD1, createR2, loadEndpoint, ctx, call } = require('./helpers/d1-node.js');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const jsonOf = res => res.json();

// ---- settings.js: Last-Write-Wins + Loeschung ----
test('settings: POST speichert, GET liest, aelterer updatedAt gewinnt nicht', async () => {
  const mod = await loadEndpoint('api/settings');
  const env = { DB: createD1() };
  await call(mod, ctx('POST', '/api/settings', { env, auth: 'test', body: { items: [
    { key: 'theme', value: 'dark', updatedAt: 1000 },
    { key: 'ntfy_topic', value: 'abc', updatedAt: 1000 }
  ] } }));
  let data = await jsonOf(await call(mod, ctx('GET', '/api/settings', { env, auth: 'test' })));
  assert.strictEqual(data.settings.theme.value, 'dark');
  assert.strictEqual(data.settings.ntfy_topic.value, 'abc');

  // aelterer Stand darf nicht ueberschreiben
  await call(mod, ctx('POST', '/api/settings', { env, auth: 'test', body: { items: [{ key: 'theme', value: 'light', updatedAt: 500 }] } }));
  data = await jsonOf(await call(mod, ctx('GET', '/api/settings', { env, auth: 'test' })));
  assert.strictEqual(data.settings.theme.value, 'dark');

  // neuerer Stand gewinnt
  await call(mod, ctx('POST', '/api/settings', { env, auth: 'test', body: { items: [{ key: 'theme', value: 'light', updatedAt: 2000 }] } }));
  data = await jsonOf(await call(mod, ctx('GET', '/api/settings', { env, auth: 'test' })));
  assert.strictEqual(data.settings.theme.value, 'light');
});

test('settings: value null loescht', async () => {
  const mod = await loadEndpoint('api/settings');
  const env = { DB: createD1() };
  await call(mod, ctx('POST', '/api/settings', { env, auth: 'test', body: { items: [{ key: 'k', value: 'v', updatedAt: 1 }] } }));
  await call(mod, ctx('POST', '/api/settings', { env, auth: 'test', body: { items: [{ key: 'k', value: null, updatedAt: 2 }] } }));
  const data = await jsonOf(await call(mod, ctx('GET', '/api/settings', { env, auth: 'test' })));
  assert.strictEqual(data.settings.k.value, null);
});

test('settings: ohne Auth 401', async () => {
  const mod = await loadEndpoint('api/settings');
  const res = await call(mod, ctx('GET', '/api/settings', { env: { DB: createD1() } })); // kein auth
  assert.strictEqual(res.status, 401);
});

// ---- todos.js: LWW + Tombstone ----
test('todos: Upsert, Tombstone gewinnt nach updatedAt, GET liefert eigene', async () => {
  const mod = await loadEndpoint('api/todos');
  const env = { DB: createD1() };
  await call(mod, ctx('POST', '/api/todos', { env, auth: 'test', body: { items: [
    { id: 'a', text: 'Milch kaufen', updatedAt: 100, createdAt: 100 }
  ] } }));
  let data = await jsonOf(await call(mod, ctx('GET', '/api/todos', { env, auth: 'test' })));
  assert.strictEqual(data.todos.length, 1);
  assert.strictEqual(data.todos[0].deleted, false);

  // Tombstone mit neuerem updatedAt
  await call(mod, ctx('POST', '/api/todos', { env, auth: 'test', body: { items: [{ id: 'a', text: 'Milch kaufen', deleted: true, updatedAt: 200 }] } }));
  data = await jsonOf(await call(mod, ctx('GET', '/api/todos', { env, auth: 'test' })));
  assert.strictEqual(data.todos[0].deleted, true);

  // aelteres Update kann Tombstone nicht wiederbeleben
  await call(mod, ctx('POST', '/api/todos', { env, auth: 'test', body: { items: [{ id: 'a', text: 'Milch', deleted: false, updatedAt: 150 }] } }));
  data = await jsonOf(await call(mod, ctx('GET', '/api/todos', { env, auth: 'test' })));
  assert.strictEqual(data.todos[0].deleted, true);
});

// ---- climate.js: idempotentes Upsert + CO2-Spalten ----
test('climate: POST-Upsert idempotent, CO2-Spalten, GET nach loc', async () => {
  const mod = await loadEndpoint('api/climate');
  const env = { DB: createD1() };
  const days = [{ day: '2026-01-01', tMin: 5, tMax: 10, tAvg: 7.5, hMin: 40, hMax: 60, hAvg: 50, samples: 24, co2Avg: 800, co2Max: 1200 }];
  await call(mod, ctx('POST', '/api/climate', { env, body: { loc: 'gillian', days } }));
  await call(mod, ctx('POST', '/api/climate', { env, body: { loc: 'gillian', days } })); // erneut → kein Duplikat
  const rows = await jsonOf(await call(mod, ctx('GET', '/api/climate?loc=gillian', { env })));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].t_avg, 7.5);
  assert.strictEqual(rows[0].co2_max, 1200);
});

// ---- gpx.js: PUT/Konflikt/DELETE-Tombstone ----
test('gpx: POST anlegen, DELETE setzt Tombstone, GET-Liste enthaelt ihn', async () => {
  const mod = await loadEndpoint('api/gpx');
  const env = { DB: createD1() };
  await call(mod, ctx('POST', '/api/gpx', { env, body: { uid: 'u1', name: 'Runde', type: 'ride', points: [[1, 2, 3, 0]], updatedAt: 100 } }));
  let list = await jsonOf(await call(mod, ctx('GET', '/api/gpx', { env })));
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].deleted, false);

  await call(mod, ctx('DELETE', '/api/gpx?uid=u1', { env }));
  list = await jsonOf(await call(mod, ctx('GET', '/api/gpx', { env })));
  const t = list.find(a => a.uid === 'u1');
  assert.strictEqual(t.deleted, true);
});

// ---- users.js + authenticateAsync: D1-Nutzerverwaltung (Plan2-16) ----
test('users: Admin legt D1-Nutzer an, D1-Login funktioniert, falsches Passwort nicht', async () => {
  const mod = await loadEndpoint('api/users');
  const auth = await loadEndpoint('_auth');
  const env = { AUTH_USER: 'test', AUTH_PASS: 'test', DB: createD1() };

  // Nicht-Admin (kein Env-Admin) darf nicht
  const forbidden = await call(mod, ctx('GET', '/api/users', { env, auth: 'bob:x' }));
  assert.strictEqual(forbidden.status, 403);

  // Admin legt Nutzer an
  const created = await call(mod, ctx('POST', '/api/users', { env, auth: 'test', body: { name: 'bob', password: 'geheim1' } }));
  assert.strictEqual(created.status, 200);

  // GET listet Env- + D1-Nutzer
  const list = await jsonOf(await call(mod, ctx('GET', '/api/users', { env, auth: 'test' })));
  assert.ok(list.users.some(u => u.name === 'bob' && u.source === 'd1'));
  assert.ok(list.users.some(u => u.name === 'test' && u.source === 'env'));

  // D1-Login: authenticateAsync akzeptiert bob mit korrektem Passwort
  const okId = await auth.authenticateAsync(ctx('GET', '/x', { env, auth: 'bob:geheim1' }).request, env);
  assert.ok(okId && okId.user === 'bob' && okId.isAdmin === false);

  // falsches Passwort → null
  const bad = await auth.authenticateAsync(ctx('GET', '/x', { env, auth: 'bob:falsch' }).request, env);
  assert.strictEqual(bad, null);

  // Env-Admin weiterhin gueltig
  const admin = await auth.authenticateAsync(ctx('GET', '/x', { env, auth: 'test' }).request, env);
  assert.ok(admin && admin.isAdmin === true);
});

test('users: doppelter Name und Env-Kollision werden abgelehnt', async () => {
  const mod = await loadEndpoint('api/users');
  const env = { DB: createD1() };
  await call(mod, ctx('POST', '/api/users', { env, auth: 'test', body: { name: 'bob', password: 'geheim1' } }));
  const dup = await call(mod, ctx('POST', '/api/users', { env, auth: 'test', body: { name: 'bob', password: 'geheim2' } }));
  assert.strictEqual(dup.status, 409);
  const envCollision = await call(mod, ctx('POST', '/api/users', { env, auth: 'test', body: { name: 'test', password: 'geheim2' } }));
  assert.strictEqual(envCollision.status, 409);
  // DELETE eines Env-Nutzers verboten
  const delEnv = await call(mod, ctx('DELETE', '/api/users?name=test', { env, auth: 'test' }));
  assert.strictEqual(delEnv.status, 400);
});

// ---- backup-dump.js: Dump nach R2 + Restore (Plan3-1) ----
test('backup-dump: Dump nach R2, Liste, Restore in frische DB', async () => {
  const dump = await loadEndpoint('api/backup-dump');
  const settings = await loadEndpoint('api/settings');
  const MEDIA = createR2();
  const env = { AUTH_USER: 'test', AUTH_PASS: 'test', DB: createD1(), MEDIA };

  await call(settings, ctx('POST', '/api/settings', { env, auth: 'test', body: { items: [{ key: 'theme', value: 'dark', updatedAt: 1000 }] } }));

  // Nicht-Admin darf nicht
  const forbidden = await call(dump, ctx('GET', '/api/backup-dump', { env, auth: 'bob:x' }));
  assert.strictEqual(forbidden.status, 403);

  const dumped = await jsonOf(await call(dump, ctx('GET', '/api/backup-dump', { env, auth: 'test' })));
  assert.ok(dumped.ok && dumped.key);

  const listed = await jsonOf(await call(dump, ctx('GET', '/api/backup-dump?list=1', { env, auth: 'test' })));
  assert.ok(listed.dumps.some(d => d.key === dumped.key));

  // Restore in eine frische DB (gleiches MEDIA), mit Doppelbestaetigung
  const env2 = { AUTH_USER: 'test', AUTH_PASS: 'test', DB: createD1(), MEDIA };
  const badConfirm = await call(dump, ctx('POST', '/api/backup-dump', { env: env2, auth: 'test', body: { key: dumped.key, confirm: 'falsch' } }));
  assert.strictEqual(badConfirm.status, 400);

  const restored = await jsonOf(await call(dump, ctx('POST', '/api/backup-dump', { env: env2, auth: 'test', body: { key: dumped.key, confirm: dumped.key } })));
  assert.ok(restored.ok);
  assert.strictEqual(restored.restored.user_settings, 1);

  const check = await jsonOf(await call(settings, ctx('GET', '/api/settings', { env: env2, auth: 'test' })));
  assert.strictEqual(check.settings.theme.value, 'dark');
});

// ---- locations.js: PUT + sauberes DELETE (Plan3-3) ----
test('locations: PUT aendert nur uebergebene Felder, DELETE raeumt Archiv', async () => {
  const mod = await loadEndpoint('api/locations');
  const climate = await loadEndpoint('api/climate');
  const env = { AUTH_USER: 'test', AUTH_PASS: 'test', DB: createD1() };
  await call(mod, ctx('POST', '/api/locations', { env, auth: 'test', body: { id: 'buero', name: 'Buero', channel: '111', readKey: 'KEY1', lat: 48, lon: 9, fields: { temp: 'field1', humidity: 'field2', extra: [] } } }));
  await call(climate, ctx('POST', '/api/climate', { env, body: { loc: 'buero', days: [{ day: '2026-01-01', tAvg: 20 }] } }));

  const forbidden = await call(mod, ctx('PUT', '/api/locations', { env, auth: 'bob:x', body: { id: 'buero', name: 'X' } }));
  assert.strictEqual(forbidden.status, 403);

  await call(mod, ctx('PUT', '/api/locations', { env, auth: 'test', body: { id: 'buero', name: 'Neu' } }));
  const row = await env.DB.prepare('SELECT name, channel, read_key FROM locations WHERE id = ?').bind('buero').first();
  assert.strictEqual(row.name, 'Neu');
  assert.strictEqual(row.channel, '111'); // nicht uebergeben -> unveraendert
  assert.strictEqual(row.read_key, 'KEY1'); // leer -> behalten

  await call(mod, ctx('DELETE', '/api/locations?id=buero', { env, auth: 'test' }));
  const cd = await env.DB.prepare('SELECT COUNT(*) AS n FROM climate_daily WHERE loc = ?').bind('buero').first();
  assert.strictEqual(cd.n, 0);
});

// ---- _notify.dispatch: erfolgreicher Versand wird protokolliert (Plan3-2) ----
test('dispatch: erfolgreicher Versand landet in alert_log', async () => {
  const notify = await loadEndpoint('_notify');
  const env = { DB: createD1() };
  const origFetch = global.fetch;
  global.fetch = async () => new Response('ok', { status: 200 }); // ntfy-Versand stubben
  try {
    const recipients = [{ profile: 'sean', topic: 'topic-x', rules: { types: { frost: { on: true } }, quiet: { on: false } }, subs: [] }];
    await notify.dispatch(env, recipients, 'frost', 'gillian', () => ({ title: 'Frost-Warnung', body: 'kalt', tags: 'snowflake' }));
  } finally { global.fetch = origFetch; }
  const row = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(type) AS t FROM alert_log').first();
  assert.strictEqual(row.n, 1);
  assert.strictEqual(row.t, 'frost');
});

// ---- Runner ----
(async () => {
  console.log('functions/api – Server-Endpunkte (node:sqlite)');
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log(`  ✔ ${name}`); }
    catch (err) { failed++; process.exitCode = 1; console.error(`  ✘ ${name}`); console.error(`    ${err && err.stack || err}`); }
  }
  console.log(failed ? '\nAPI-Tests FEHLGESCHLAGEN' : `\nAlle ${passed} API-Tests bestanden ✔`);
})();
