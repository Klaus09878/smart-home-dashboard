// Test-Hilfen fuer die Pages-Functions (Plan2-Punkt 6).
// - createD1(): ein D1-kompatibler Adapter ueber node:sqlite (in-memory).
// - loadFunctions(): kopiert functions/ nach os.tmpdir, schreibt ESM-Import-
//   Endungen .js -> .mjs um und macht die Endpunkte per dynamischem import()
//   ladbar (das Repo ist CJS, die Functions sind ESM).
// - ctx(): baut einen minimalen { request, env }-Kontext.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- D1-Adapter ----
function createD1() {
  const db = new DatabaseSync(':memory:');
  const clean = args => args.map(a => (a === undefined ? null : a));
  const stmt = sql => {
    const s = db.prepare(sql);
    let bound = [];
    return {
      bind(...args) { bound = clean(args); return this; },
      async first() { const r = s.get(...bound); return r === undefined ? null : r; },
      async all() { return { results: s.all(...bound) }; },
      async run() { const r = s.run(...bound); return { success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid } }; }
    };
  };
  return {
    prepare: sql => stmt(sql),
    async exec(sql) { db.exec(sql); },
    async batch(stmts) { const out = []; for (const st of stmts) out.push(await st.run()); return out; },
    _raw: db
  };
}

// ---- Functions als ESM ladbar machen ----
let _dir = null;
function loadFunctions() {
  if (_dir) return _dir;
  const src = path.join(__dirname, '..', '..', 'functions');
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'shh-fns-'));
  fs.cpSync(src, dst, { recursive: true });
  const walk = d => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!p.endsWith('.js')) continue;
      let code = fs.readFileSync(p, 'utf8');
      // relative ESM-Import-Endungen umschreiben (static + dynamisch)
      code = code.replace(/(from\s+['"]\.[^'"]+?)\.js(['"])/g, '$1.mjs$2');
      code = code.replace(/(import\(\s*['"]\.[^'"]+?)\.js(['"]\s*\))/g, '$1.mjs$2');
      fs.writeFileSync(p.replace(/\.js$/, '.mjs'), code);
      fs.rmSync(p);
    }
  };
  walk(dst);
  _dir = dst;
  return dst;
}

// Endpunkt-Modul laden (relPath z. B. 'api/settings')
async function loadEndpoint(relPath) {
  const dir = loadFunctions();
  const url = 'file://' + path.join(dir, relPath + '.mjs').replace(/\\/g, '/');
  return import(url);
}

// Minimaler Kontext. auth: 'test'/'test' erzeugt gueltigen Basic-Header.
function ctx(method, urlPath, { env = {}, body, auth } = {}) {
  const headers = {};
  // auth 'name' → name:name; auth 'name:pass' → wird roh verwendet
  if (auth) {
    const pair = auth.includes(':') ? auth : `${auth}:${auth}`;
    headers['Authorization'] = 'Basic ' + Buffer.from(pair).toString('base64');
  }
  const init = { method, headers };
  if (body !== undefined) { init.body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const request = new Request('https://test.local' + urlPath, init);
  return { request, env: { AUTH_USER: 'test', AUTH_PASS: 'test', ...env } };
}

// Endpunkt aufrufen — waehlt onRequest oder onRequestGet automatisch.
async function call(mod, context) {
  const fn = mod.onRequest || mod[`onRequest${context.request.method[0] + context.request.method.slice(1).toLowerCase()}`] || mod.onRequestGet;
  return fn(context);
}

module.exports = { createD1, loadEndpoint, ctx, call };
