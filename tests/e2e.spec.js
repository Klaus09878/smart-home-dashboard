// E2E-Smoke-Tests (Punkt 24) — laden die Seiten wirklich in einem Browser,
// klicken und prüfen Laufzeit-Verhalten, das der statische Smoke-Test nicht
// sieht. Ausführen: npm run test:e2e (siehe playwright.config.js).
const { test, expect } = require('@playwright/test');

// Läuft ohne /api → App im lokalen Profil „default".
async function waitReady(page) {
  await page.waitForFunction(() => window.Store && window.Store.ready, { timeout: 15000 });
}

test('Hub lädt: Widgets, Uhr, keine JS-Fehler', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/index.html#home');
  await waitReady(page);
  await expect(page.locator('#hub-widgets [data-widget]').first()).toBeVisible();
  await expect(page.locator('#hub-clock')).not.toHaveText('--:--');
  expect(errors, errors.join('\n')).toHaveLength(0);
});

test('Einstellungen: Regeln + Theme-Umschalter', async ({ page }) => {
  await page.goto('/index.html#settings');
  await waitReady(page);
  await expect(page.locator('#notify-rules > div')).toHaveCount(9); // 9 Regeltypen
  // Theme umschalten
  await page.click('button:has-text("umschalten")');
  await expect(page.locator('html')).toHaveClass(/light/);
});

test('To-do anlegen und abhaken', async ({ page }) => {
  await page.goto('/index.html#home');
  await waitReady(page);
  await page.fill('#todo-input', 'E2E-Test-Aufgabe');
  await page.click('form:has(#todo-input) button[type="submit"]');
  await expect(page.locator('#todo-list')).toContainText('E2E-Test-Aufgabe');
  await page.locator('#todo-list input[type="checkbox"]').first().check();
  await expect(page.locator('#todo-list .line-through')).toContainText('E2E-Test-Aufgabe');
});

test('GPX-Viewer lädt ohne Fehler', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/gpx.html');
  await waitReady(page);
  await expect(page.locator('#cal-grid > div').first()).toBeVisible();
  expect(errors, errors.join('\n')).toHaveLength(0);
});
