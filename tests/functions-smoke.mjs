// Functions-Runtime-Smoke (Improve-2) — startet `wrangler pages dev` gegen die
// echte workerd-Runtime und prueft das Middleware-/Login-Verhalten end-to-end.
// Ergaenzt tests/api.test.js (node:sqlite-Shim) um einen echten Runtime-Lauf:
// faengt kaputte Imports, Binding-/Runtime-Fehler und Middleware-Regressionen,
// die der Shim nicht sieht.
//
// Ausfuehren: node tests/functions-smoke.mjs  (laedt beim ersten Mal workerd).
// Vorbehalt: reproduziert NICHT Cloudflares Pretty-URL-308 (/login.html ->
// /login) — das ist Pages-Plattformverhalten oberhalb der Runtime.
import { spawn } from 'node:child_process';

const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const wrangler = spawn('npx', ['--yes', 'wrangler@4', 'pages', 'dev', '.',
  '--port', String(PORT), '--ip', '127.0.0.1'],
  { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });

let out = '';
wrangler.stdout.on('data', d => { out += d; });
wrangler.stderr.on('data', d => { out += d; });

function fail(msg) {
  console.error(`\n✘ ${msg}\n--- wrangler-Ausgabe (Ende) ---\n${out.slice(-1500)}`);
  try { wrangler.kill('SIGTERM'); } catch (e) { /* ignore */ }
  process.exit(1);
}

async function waitUp(timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/login`, { redirect: 'manual' });
      if (r.status > 0) return;
    } catch (e) { /* noch nicht oben */ }
    await new Promise(r => setTimeout(r, 1500));
  }
  fail(`Server kam nicht innerhalb ${timeoutMs / 1000}s hoch (workerd-Download?).`);
}

const checks = [];
function check(name, cond) { checks.push(name); if (!cond) fail(`Check fehlgeschlagen: ${name}`); else console.log(`  ✔ ${name}`); }

try {
  await waitUp();
  console.log('wrangler pages dev laeuft — Middleware-Routen pruefen:');

  // 1) Navigation ohne Session -> Redirect auf /login
  const nav = await fetch(`${BASE}/`, { headers: { Accept: 'text/html' }, redirect: 'manual' });
  check('/ (nicht angemeldet) -> 302/Redirect', [301, 302, 303, 307, 308].includes(nav.status));
  const loc = nav.headers.get('location') || '';
  check('Redirect-Ziel enthaelt /login', /\/login/.test(loc));

  // 2) /login ist oeffentlich -> 200
  const login = await fetch(`${BASE}/login`, { redirect: 'manual' });
  check('/login -> 200', login.status === 200);

  // 3) API ohne Cookie -> 401 JSON, KEIN WWW-Authenticate (kein Browser-Dialog)
  const who = await fetch(`${BASE}/api/whoami`);
  check('/api/whoami ohne Cookie -> 401', who.status === 401);
  check('/api/whoami ohne WWW-Authenticate', !who.headers.get('www-authenticate'));

  // 4) Statisches Asset oeffentlich erreichbar (Login-Assets)
  const css = await fetch(`${BASE}/tailwind.css`, { redirect: 'manual' });
  check('/tailwind.css -> 200 (oeffentlich)', css.status === 200);

  console.log(`\n✔ Functions-Runtime-Smoke bestanden (${checks.length} Checks).`);
  wrangler.kill('SIGTERM');
  process.exit(0);
} catch (e) {
  fail(`Unerwarteter Fehler: ${e && e.message}`);
}
