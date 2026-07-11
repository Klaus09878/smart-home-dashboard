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
  await expect(page.locator('#notify-rules > div')).toHaveCount(10); // 10 Regeltypen (inkl. CO₂)
  // Theme umschalten
  await page.click('button:has-text("umschalten")');
  await expect(page.locator('html')).toHaveClass(/light/);
});

test('To-do anlegen und abhaken', async ({ page }) => {
  await page.goto('/index.html#home');
  await waitReady(page);
  // Auf einem frisch geladenen Hub kann ein sehr frueher Submit verloren gehen,
  // solange init() noch rendert (das Formular ist da, aber das synthetische
  // Event trifft die noch beschaeftigte Main-Thread-Phase). Robust wie ein
  // echter Nutzer: Eingabe + Absenden wiederholen, bis das To-do wirklich steht.
  await expect(async () => {
    await page.fill('#todo-input', 'E2E-Test-Aufgabe');
    await page.click('form:has(#todo-input) button[type="submit"]');
    await expect(page.locator('#todo-list')).toContainText('E2E-Test-Aufgabe', { timeout: 1000 });
  }).toPass({ timeout: 10000 });
  await page.locator('#todo-list input[type="checkbox"]').first().check();
  await expect(page.locator('#todo-list .line-through')).toContainText('E2E-Test-Aufgabe');
});

// Deterministisches Aussenwetter (Zeiten relativ zu jetzt, sonst greift die
// Stale-Erkennung). Deckt forecast + air-quality ab.
function weatherResponse() {
  const now = Math.floor(Date.now() / 1000);
  const time = [], temperature_2m = [], relative_humidity_2m = [];
  for (let i = 24 * 9; i >= 0; i--) { time.push(now - i * 3600); temperature_2m.push(8); relative_humidity_2m.push(70); }
  return {
    current: { time: now, temperature_2m: 8, relative_humidity_2m: 70, weather_code: 1 },
    hourly: { time, temperature_2m, relative_humidity_2m },
    daily: { time: [now], temperature_2m_min: [3], temperature_2m_max: [12], weather_code: [1] }
  };
}
async function routeOpenMeteo(page) {
  await page.route(/open-meteo\.com/, route => {
    const url = route.request().url();
    const body = url.includes('air-quality')
      ? { current: { european_aqi: 30, pm2_5: 5, pm10: 8 } }
      : weatherResponse();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
}

test('ClimateFlow: Chart + Lüftungsberater rendern (Demo-Daten)', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await routeOpenMeteo(page);
  // Ohne /api faellt die App in den Demo-Modus (Mock-Feeds) → Chart + Berater
  await page.goto('/index.html#climate');
  await waitReady(page);
  // Aussentemperatur aus dem Wetter-Fixture (Default war "--.-")
  await expect(page.locator('#kpi-temp-out')).not.toHaveText('--.-', { timeout: 15000 });
  // Berater-Verdict gesetzt (Default war "Unklar")
  await expect(page.locator('#ventilation-verdict')).toHaveText(/LÜFTEN|SCHLIESSEN|EGAL/, { timeout: 15000 });
  expect(errors, errors.join('\n')).toHaveLength(0);
});

test('ClimateFlow: Chart-Karte klappt ein und aus', async ({ page }) => {
  await routeOpenMeteo(page);
  await page.goto('/index.html#climate');
  await waitReady(page);
  const body = page.locator('#chart-collapse-body');
  await expect(body).toBeVisible(); // Standard: Chart offen
  await page.click('button[title="Klimaverlauf ein-/ausklappen"]');
  await expect(body).toBeHidden();
  await page.click('button[title="Klimaverlauf ein-/ausklappen"]');
  await expect(body).toBeVisible();
});

test('Hub: Status-Briefing rendert', async ({ page }) => {
  await routeOpenMeteo(page);
  await page.goto('/index.html#home');
  await waitReady(page);
  // Briefing fuellt sich (mind. eine Zeile: Signale oder "alles im gruenen Bereich")
  await expect(page.locator('#briefing-list > *').first()).toBeVisible({ timeout: 15000 });
});

test('GPX-Viewer lädt ohne Fehler', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/gpx.html');
  await waitReady(page);
  // Ohne Touren (leeres IndexedDB im Test) bleibt #main-area mit dem Kalender
  // versteckt; die Dropzone ist der immer sichtbare Leerzustand.
  await expect(page.locator('#dropzone')).toBeVisible();
  expect(errors, errors.join('\n')).toHaveLength(0);
});
