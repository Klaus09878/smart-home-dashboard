# Testing & CI — konkrete, portable Vorlagen

Alle Vorlagen sind aus dem Smart-Home-Hub destilliert und funktionieren ohne
Bundler/Framework. Projektspezifische Namen (Views, Ports, Bindings, Pfade)
beim Übernehmen anpassen — die Kommentare markieren die Stellen.

Grundprinzip der Test-Pyramide hier:

```
  Unit (node --test, DOM-frei)      ── schnell, viele, Kernlogik
  Smoke/Konsistenz (node --test)    ── mittel, prüft Datei-Querverweise
  E2E + axe (Playwright)            ── langsamer, echter Browser, Struktur-a11y
  Lighthouse-CI                     ── gescorte Kategorien (a11y/BP/Perf)
  Functions-Runtime-Smoke (wrangler)── echte Edge-Runtime (falls Functions)
  CodeQL                            ── statische Security-Analyse
```

Jede Ebene fängt eine Fehlerklasse, die die darunter nicht sieht. Nichts doppelt.

---

## 1. Unit-Tests ohne Framework (`node --test`)

Reine Logik in ein DOM-freies Modul auslagern und mit dem eingebauten Runner
testen — keine Jest/Vitest-Deps nötig.

```js
// tests/core.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../lib/core.js'); // UMD/CJS, kein DOM

test('comfortScore: Beispielwert', () => {
  assert.equal(core.comfortScore(21, 45), /* erwartet */ 92);
});
```

`package.json`:
```json
"scripts": { "test": "node tests/core.test.js && node tests/smoke.test.js" }
```

**Wichtig bei dupliziertem Code:** Wenn eine Formel bewusst an zwei Stellen lebt
(z. B. in `lib/core.js` *und* inline in einer Serverless-Function, weil die
Function das Modul nicht importieren kann), das in `CLAUDE.md` festhalten und
bei Formel-Änderungen **beide** Stellen anfassen. Ein Test, der beide gegen
denselben Erwartungswert prüft, fängt das Auseinanderlaufen.

---

## 2. Smoke-/Konsistenztest (die heimliche Geheimwaffe ohne Bundler)

Ohne Bundler gibt es keinen Compiler, der „diese ID existiert nicht" meldet.
Ein Smoke-Test, der Datei-Querverweise prüft, ersetzt genau das:

```js
// tests/smoke.test.js — prüft Konsistenz ÜBER Dateien hinweg
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

test('app.js: alle getElementById-IDs existieren im HTML', () => {
  const js = fs.readFileSync('app.js', 'utf8');
  const html = fs.readFileSync('index.html', 'utf8');
  const ids = [...js.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`), `Fehlende ID im HTML: ${id}`);
  }
});
```

Bewährte Checks dieser Klasse:
- jede `getElementById`-ID existiert im zugehörigen HTML
- jeder `data-on*`-Handler ist in einer geladenen JS-Datei definiert
- keine Inline-Event-Handler mehr (CSP ohne `unsafe-inline`)
- jede lokal referenzierte `script-src`/`link-href`-Datei existiert
- jede Datei in der Service-Worker-Shell-Liste existiert
- `_headers` enthält eine CSP; der Theme-Snippet-Hash stimmt mit dem CSP-Hash

---

## 3. Statischer Test-Server + Playwright-Config

Kein Extra-Dependency für den Server — ein winziger `http`-Server reicht.

```js
// tests/static-server.js — dient das Projektwurzelverzeichnis auf 8123 aus.
// /api/* bewusst 404 → App läuft im lokalen Modus (kein Backend nötig).
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml',
  '.png':'image/png', '.webmanifest':'application/manifest+json' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p.startsWith('/api/')) { res.writeHead(404); res.end('no api'); return; }
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(process.env.PORT || 8123,
  () => console.log(`Test-Server auf http://localhost:${process.env.PORT || 8123}`));
```

```js
// playwright.config.js
const { defineConfig, devices } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests', testMatch: '**/*.spec.js', timeout: 30000,
  use: { baseURL: 'http://localhost:8123', headless: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'node tests/static-server.js', port: 8123, reuseExistingServer: true }
});
```

---

## 4. axe-core A11y in der E2E-Suite — und die a11y-Zweiteilung

Der zentrale Kniff: **axe prüft STRUKTUR hart, Lighthouse prüft KONTRAST
gescored.** Warum getrennt? Ein kräftiger Akzent-Ton als kleiner Statustext
trifft 4,5:1 oft nicht ohne Pastellierung. Ein pro-Knoten-hartes axe-Kontrast-
Gate würde die CI dann zwingen, das Design zu verwässern. Also: Kontrast in axe
aus, dafür über die *gescorte* Lighthouse-a11y-Kategorie (≥ 0.90) beobachtet —
Design-Entscheidung bleibt möglich, Kontrast bleibt trotzdem im Blick.

```js
// tests/a11y.spec.js — axe über jede View in BEIDEN Themes.
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

const VIEWS = [ // projektspezifisch anpassen
  { name: 'Hub',   url: '/index.html#home' },
  { name: 'Login', url: '/login.html' },
];

for (const theme of ['dark', 'light']) {
  for (const view of VIEWS) {
    test(`a11y: ${view.name} (${theme})`, async ({ page }) => {
      await page.addInitScript(t => { try {
        localStorage.setItem('theme', t); } catch (e) {} }, theme);
      await page.goto(view.url);
      await page.waitForTimeout(800); // Reveal/Icons setteln lassen

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .disableRules(['color-contrast']) // BEWUSST: Kontrast macht Lighthouse
        .analyze();

      // NUR serious+critical: das ist der Rauschabstand, ab dem ein Verstoß
      // real stört. minor/moderate würden die CI mit Vorbestehendem fluten.
      const severe = results.violations.filter(
        v => v.impact === 'serious' || v.impact === 'critical');
      const msg = severe.map(v => `  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length}x)`).join('\n');
      expect(severe, `Schwere A11y-Verstöße in ${view.name}/${theme}:\n${msg}`).toHaveLength(0);
    });
  }
}
```

**Erwarte echte Funde beim ersten Lauf** und triagiere sie *sofort statt sie
auszublenden*: fehlende Input-`aria-label`s, unlesbare Buttons (Kontrast eines
Textes gegen seinen Hintergrund < 1,2:1 ist ein Struktur-*und*-Kontrastproblem),
Tastaturfallen. Nur was eine eigene Design-Runde braucht, dokumentiert per
`disableRules` mit Begründung ausnehmen — nie stillschweigend.

devDep (der **einzige** neue lokale): `@axe-core/playwright`. Kein separater
CI-Job nötig — `npm run test:e2e` nimmt die Spec automatisch mit.

---

## 5. Lighthouse-CI (gescorte Kategorien, Perf nur als Warnung)

```json
// .lighthouserc.json
{
  "ci": {
    "collect": {
      "startServerCommand": "node tests/static-server.js",
      "startServerReadyPattern": "Test-Server auf",
      "url": ["http://localhost:8123/index.html", "http://localhost:8123/login.html"],
      "numberOfRuns": 1,
      "settings": { "chromeFlags": "--no-sandbox --headless=new" }
    },
    "assert": {
      "assertions": {
        "categories:accessibility":  ["error", { "minScore": 0.9 }],
        "categories:best-practices": ["warn",  { "minScore": 0.9 }],
        "categories:performance":    ["warn",  { "minScore": 0.5 }],
        "categories:seo": "off"
      }
    },
    "upload": { "target": "filesystem", "outputDir": ".lighthouseci" }
  }
}
```

Wichtige Entscheidungen (hart erarbeitet):
- **a11y hart (`error`), Perf/BP weich (`warn`).** LHCI-Perf schwankt in CI je
  nach Runner-Last stark — als hartes Gate wäre es flaky und würde grüne PRs
  rot machen. Nur tracken, nicht brechen.
- **`--no-sandbox`** ist in Root-Containern/CI Pflicht, sonst startet Chromium
  still nicht.
- **SEO aus**, wenn es ein auth-geschütztes/privates PWA ist.
- Lokal: `CHROME_PATH=<chrome-binary> npx -y @lhci/cli@0.14.x autorun`. In diesem
  Container-Typ liegt eine Chromium-Binary unter `/opt/pw-browsers/`.
- Läuft über `npx` in CI — **kein** lokaler devDep.

---

## 6. Functions-Runtime-Smoke (echte Edge-Runtime statt Shim)

Nur relevant, wenn das Projekt Serverless/Edge Functions hat (Cloudflare Pages
Functions, Workers). Ergänzt Unit-Tests, die die Functions über einen
SQLite-Shim testen, um einen **echten Runtime-Lauf** gegen `workerd`.

```js
// tests/functions-smoke.mjs — startet `wrangler pages dev` und prüft Middleware.
import { spawn } from 'node:child_process';
const PORT = 8788, BASE = `http://127.0.0.1:${PORT}`;
const w = spawn('npx', ['--yes','wrangler@4','pages','dev','.','--port',String(PORT),'--ip','127.0.0.1'],
  { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore','pipe','pipe'] });
let out = ''; w.stdout.on('data', d => out += d); w.stderr.on('data', d => out += d);
const fail = m => { console.error(`✘ ${m}\n${out.slice(-1500)}`); try { w.kill('SIGTERM'); } catch {} process.exit(1); };

async function waitUp(ms = 120000) { // workerd lädt beim ersten Mal → großzügig
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${BASE}/login`, { redirect: 'manual' }); if (r.status > 0) return; } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  fail(`Server kam nicht innerhalb ${ms/1000}s hoch (workerd-Download?).`);
}
const ok = (n, c) => c ? console.log(`  ✔ ${n}`) : fail(`Check fehlgeschlagen: ${n}`);

await waitUp();
const nav = await fetch(`${BASE}/`, { headers:{Accept:'text/html'}, redirect:'manual' });
ok('/ ohne Session → Redirect', [301,302,303,307,308].includes(nav.status));
ok('Redirect-Ziel /login', /\/login/.test(nav.headers.get('location') || ''));
const who = await fetch(`${BASE}/api/whoami`);
ok('/api/whoami ohne Cookie → 401', who.status === 401);
ok('kein WWW-Authenticate (kein Browser-Dialog)', !who.headers.get('www-authenticate'));
console.log('✔ Functions-Runtime-Smoke bestanden'); w.kill('SIGTERM'); process.exit(0);
```

`wrangler.toml` (**nur lokal/CI, NICHT für den Deploy** — Pages-Git-Integration
braucht keins):
```toml
name = "<projektname>"
pages_build_output_dir = "."
compatibility_date = "2024-09-23"
[[d1_databases]]           # nur falls D1 genutzt wird
binding = "DB"
database_name = "<name>-local"
database_id = "00000000-0000-0000-0000-000000000000"  # lokal beliebig
```

**Ehrliche Vorbehalte (in Commit + Doku festhalten):**
- Reproduziert **nicht** Plattform-Quirks *oberhalb* der Runtime, z. B.
  Cloudflares Pretty-URL-308 (`/login.html` → `/login`). Solche Redirects muss
  man separat bedenken (sie waren im Projekt mal die Ursache einer Redirect-
  Schleife — die Runtime allein hätte das nicht gezeigt).
- Fängt aber genau das, was ein Shim nicht sieht: kaputte Imports, fehlende
  Bindings, echte Middleware-/Auth-Regressionen.
- `workerd` wird beim ersten Lauf geladen. Klappt das im lokalen Container nicht
  über den Proxy → Skript-/YAML-Korrektheit lokal prüfen, den echten Lauf der
  CI überlassen (offenes Netz).

---

## 7. Security-Scan (CodeQL bei public Repo)

**Erst Sichtbarkeit prüfen.** CodeQL ist bei public Repos gratis; bei privaten
ohne „GitHub Advanced Security" kostenpflichtig.

```yaml
# .github/workflows/codeql.yml — public Repo → gratis, Befunde im Security-Tab.
name: CodeQL
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
  schedule: [{ cron: '27 4 * * 1' }] # wöchentlich Mo 04:27 UTC
jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions: { actions: read, contents: read, security-events: write }
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with: { languages: javascript-typescript, queries: security-extended }
      - uses: github/codeql-action/analyze@v3
        with: { category: "/language:javascript-typescript" }
```

**Fallback für private Repos ohne GHAS** (gratis, lokal): `eslint-plugin-security`
in die ESLint-Config + ein CI-Job `npm audit --audit-level=high`. Deckt unsichere
Regex/Eval/Injection-Muster und verwundbare Deps ab — weniger tief als CodeQL,
aber ohne Bezahldienst.

Sichtbarkeit per GitHub-MCP prüfen: `search_repositories` bzw. Repo-`get` →
Feld `"visibility": "public"`.

---

## 8. Alles in einer CI-Datei

```yaml
# .github/workflows/ci.yml — jeder Job unabhängig, läuft parallel.
name: CI
on:
  push: { branches: [main] }
  pull_request:
  workflow_dispatch:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm test

  css-check:               # nur falls es einen Build-Schritt gibt (z. B. Tailwind)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: |
          npm run build:css
          git diff --exit-code -- tailwind.css \
            || (echo "::error::Gebautes CSS veraltet — build:css ausführen & committen"; exit 1)

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npm run lint

  e2e:                      # inkl. tests/a11y.spec.js (axe)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npx playwright install chromium --with-deps
      - run: npm run test:e2e

  functions-smoke:          # nur falls Edge Functions vorhanden
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: node tests/functions-smoke.mjs

  lighthouse:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx -y @lhci/cli@0.14.x autorun
```

`.gitignore` ergänzen: `.wrangler/`, `.dev.vars`, `.lighthouseci/`.

**Deploy bleibt getrennt.** Dieses CI-File prüft nur; der Deploy läuft über die
Plattform-Git-Integration (Push auf `main`). CI und Deploy nie vermischen — ein
roter Lint soll den Deploy nicht blockieren, wenn die Plattform ihn eh separat
fährt (bzw. umgekehrt bewusst als Branch-Protection koppeln, aber getrennt
denken).

---

## 9. Erst-Lauf-Verifikation

Beim ersten Push die CI-Jobs tatsächlich prüfen (nicht annehmen, dass sie grün
sind — `functions-smoke`, `lighthouse`, `codeql` laufen zum ersten Mal in einer
*anderen* Umgebung als lokal). Per GitHub-MCP: `actions_list` mit
`list_workflow_jobs`, Feld `conclusion` je Job. Bei Rot: Logs des Jobs ziehen,
Ursache diagnostizieren, fixen, neu pushen — nicht raten.
