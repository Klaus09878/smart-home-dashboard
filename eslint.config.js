// ESLint (flat config, Plan2-Punkt 10). Bewusst minimal: faengt echte Fehler
// (undefinierte Namen, ungenutzte Variablen) ohne Stilkrieg mit dem Bestand.
const globals = require('globals');
const fs = require('fs');

// Cross-Datei-Globals der klassischen Skripte automatisch ableiten, damit die
// Liste nicht manuell gepflegt werden muss (shared.js/settings-sync.js sind
// keine Module; lib/core.js exportiert per UMD → in Node ladbar).
function declaredNames(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = {};
  for (const m of src.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) out[m[1]] = 'readonly';
  for (const m of src.matchAll(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) out[m[1]] = 'readonly';
  return out;
}
const coreGlobals = Object.fromEntries(Object.keys(require('./lib/core.js')).map(k => [k, 'readonly']));
const sharedGlobals = { ...declaredNames('shared.js'), ...declaredNames('settings-sync.js'), ...coreGlobals };

// Von Vendor-Bibliotheken bereitgestellte Globals.
const vendorGlobals = { Chart: 'readonly', L: 'readonly', lucide: 'readonly', Hammer: 'readonly', Store: 'readonly' };

module.exports = [
  { ignores: ['vendor/**', 'tailwind.css', 'node_modules/**', 'playwright-report/**', 'test-results/**'] },

  // Browser-Seitenskripte (klassische Scripts mit gemeinsamem globalem Scope).
  // no-unused-vars ist hier bewusst AUS: Funktionen werden ueber Dateigrenzen und
  // per data-on*-Delegation (String-Referenzen) aufgerufen, was ESLint pro Datei
  // nicht sieht → sonst nur Fehlalarme. no-undef faengt echte Tippfehler.
  {
    files: ['app.js', 'gpx.js', 'shared.js', 'settings-sync.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, ...sharedGlobals, ...vendorGlobals }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'off'
    }
  },

  // lib/core.js — UMD (Browser + Node), self-contained → unused-vars sinnvoll
  {
    files: ['lib/core.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals.browser, ...globals.node } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }] }
  },

  // Cloudflare Pages Functions — ESM, Worker-Runtime
  {
    files: ['functions/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.serviceworker, ...globals.browser } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }] }
  },

  // _webpush.js ist UMD (ESM-Import in _notify.js + module.exports fuer die Tests)
  {
    files: ['functions/_webpush.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.serviceworker, ...globals.browser, ...globals.node } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }] }
  },

  // Service Worker
  {
    files: ['sw.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals.serviceworker } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }] }
  },

  // Tests + Konfig — Node; e2e enthaelt Browser-Callbacks (page.evaluate)
  {
    files: ['tests/**/*.js', 'eslint.config.js', 'playwright.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }] }
  }
];
