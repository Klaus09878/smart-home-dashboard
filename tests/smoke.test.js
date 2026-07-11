// Smoke-Test gegen kaputte Deploys — läuft ohne Browser und ohne Dependencies
// als Teil von `npm test` (und damit im Cloudflare-Build vor jedem Deploy):
//   1. Jede per getElementById('…') referenzierte ID existiert im zugehörigen HTML
//   2. Jede per onclick="fn(…)" aufgerufene Funktion existiert im zugehörigen JS
//   3. Alle lokalen <script src>/<link href>-Referenzen zeigen auf existierende Dateien
//   4. Alle Dateien der Service-Worker-Shell (APP_SHELL) existieren
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

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

// IDs, die zur Laufzeit dynamisch erzeugt werden (nicht im HTML zu finden)
const DYNAMIC_IDS = new Set(['toast-container']);

const files = {
  'index.html': read('index.html'),
  'gpx.html': read('gpx.html'),
  'app.js': read('app.js'),
  'gpx.js': read('gpx.js'),
  'shared.js': read('shared.js'),
  'sw.js': read('sw.js')
};

const htmlIds = html => new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const usedIds = js => [...js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map(m => m[1]);

console.log('Smoke-Test – Seiten-Konsistenz');

test('app.js: alle getElementById-IDs existieren in index.html', () => {
  const ids = htmlIds(files['index.html']);
  const missing = [...new Set(usedIds(files['app.js']))].filter(id => !ids.has(id) && !DYNAMIC_IDS.has(id));
  assert.deepStrictEqual(missing, [], `fehlende IDs in index.html: ${missing.join(', ')}`);
});

test('gpx.js: alle getElementById-IDs existieren in gpx.html', () => {
  const ids = htmlIds(files['gpx.html']);
  const missing = [...new Set(usedIds(files['gpx.js']))].filter(id => !ids.has(id) && !DYNAMIC_IDS.has(id));
  assert.deepStrictEqual(missing, [], `fehlende IDs in gpx.html: ${missing.join(', ')}`);
});

// data-onclick/onchange/oninput/onsubmit/onbackdrop-Handler im HTML (Event-
// Delegation, P2-8) muessen im Seiten-JS (oder shared.js/lib/core.js) als
// Funktion definiert sein. Format: data-onX="fnName|arg1|arg2".
function checkHandlers(htmlFile, jsFiles) {
  const html = files[htmlFile];
  const js = jsFiles.map(f => files[f] || read(f)).join('\n');
  const calls = [...html.matchAll(/data-on(?:click|change|submit|input|backdrop)="\s*([A-Za-z_$][\w$]*)/g)].map(m => m[1]);
  const missing = [...new Set(calls)].filter(fn =>
    !new RegExp(`function\\s+${fn}\\s*\\(`).test(js) &&
    !new RegExp(`(const|let|var)\\s+${fn}\\s*=`).test(js)
  );
  assert.deepStrictEqual(missing, [], `nicht definierte Handler in ${htmlFile}: ${missing.join(', ')}`);
}

test('index.html: alle data-on*-Handler sind in app.js/shared.js definiert', () => {
  checkHandlers('index.html', ['app.js', 'shared.js', 'lib/core.js']);
});

test('gpx.html: alle data-on*-Handler sind in gpx.js/shared.js definiert', () => {
  checkHandlers('gpx.html', ['gpx.js', 'shared.js', 'lib/core.js']);
});

test('HTML: keine Inline-Event-Handler mehr (CSP ohne unsafe-inline)', () => {
  ['index.html', 'gpx.html'].forEach(page => {
    const bare = files[page].match(/[^-]on(?:click|change|submit|input)="/);
    assert.strictEqual(bare, null, `${page}: Inline-Handler gefunden (muss data-on* sein): ${bare && bare[0]}`);
  });
});

test('HTML: alle lokalen script-src/link-href-Dateien existieren', () => {
  ['index.html', 'gpx.html'].forEach(page => {
    const refs = [...files[page].matchAll(/(?:src|href)="([^"]+)"/g)]
      .map(m => m[1])
      .filter(u => !/^(https?:|#|mailto:)/.test(u) && !u.startsWith('data:'));
    refs.forEach(ref => {
      const clean = ref.split('#')[0].split('?')[0];
      if (clean === '' || clean.endsWith('.html')) return; // Anker/Seitenlinks
      assert.ok(fs.existsSync(path.join(root, clean)), `${page}: Referenz fehlt: ${ref}`);
    });
  });
});

test('sw.js: alle APP_SHELL-Dateien existieren', () => {
  const m = files['sw.js'].match(/APP_SHELL\s*=\s*\[([^\]]+)\]/);
  assert.ok(m, 'APP_SHELL nicht gefunden');
  const entries = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  entries.forEach(e => {
    const rel = e === './' ? 'index.html' : e.replace(/^\.\//, '');
    assert.ok(fs.existsSync(path.join(root, rel)), `Shell-Datei fehlt: ${e}`);
  });
  // Beide Seiten-Skripte müssen in der Offline-Shell liegen
  ['./app.js', './gpx.js', './shared.js'].forEach(mustHave => {
    assert.ok(entries.includes(mustHave), `APP_SHELL sollte ${mustHave} enthalten`);
  });
});

test('_headers: existiert und enthaelt eine Content-Security-Policy', () => {
  const p = path.join(root, '_headers');
  assert.ok(fs.existsSync(p), '_headers-Datei fehlt');
  const h = fs.readFileSync(p, 'utf8');
  assert.ok(/Content-Security-Policy:/.test(h), 'CSP-Header fehlt in _headers');
  assert.ok(/X-Content-Type-Options:\s*nosniff/.test(h), 'X-Content-Type-Options fehlt');
  assert.ok(/Strict-Transport-Security:/.test(h), 'HSTS-Header fehlt');
});

console.log(process.exitCode === 1 ? '\nSmoke-Tests FEHLGESCHLAGEN' : `\nAlle ${passed} Smoke-Tests bestanden ✔`);
