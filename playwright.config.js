// Playwright-Konfiguration für die E2E-Smoke-Tests (Punkt 24).
// Ausführen:  npm i -D @playwright/test && npx playwright install chromium && npm run test:e2e
// Startet automatisch den statischen Test-Server aus tests/static-server.js.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  timeout: 30000,
  use: { baseURL: 'http://localhost:8123', headless: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node tests/static-server.js',
    port: 8123,
    reuseExistingServer: true
  }
});
