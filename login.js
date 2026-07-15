// Login-Seite (Plan5-5): Formular-Login gegen /api/login, das Session-Cookie
// setzt die Antwort (HttpOnly). Bewusst eigenstaendig — kein shared.js, kein
// Store: die Seite laeuft VOR jeder Anmeldung.
(function () {
  const $ = id => document.getElementById(id);

  function showError(msg) {
    const el = $('login-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  // Sicheres Sprungziel nach dem Login (?next= aus der Middleware):
  // nur gleiche Herkunft (Pfad), nie zurueck auf die Login-Seite selbst —
  // '/login' deckt auch '/login.html' und verschachtelte next-Ketten ab
  // (Redirect-Schleife vor Plan5-5b).
  function nextTarget() {
    const next = new URLSearchParams(location.search).get('next') || '';
    const ok = next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login');
    return ok ? next : './';
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (window.lucide && lucide.createIcons) lucide.createIcons();

    // Bereits angemeldet (gueltiges Cookie oder gemerkte Basic-Daten)? Weiter.
    fetch('/api/whoami', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d && d.user) location.replace(nextTarget()); })
      .catch(() => { /* offline/Fehler: Formular einfach anzeigen */ });

    $('login-form').addEventListener('submit', async event => {
      event.preventDefault();
      const btn = $('login-submit');
      btn.disabled = true;
      $('login-error').classList.add('hidden');
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user: $('login-user').value.trim(),
            pass: $('login-pass').value,
            remember: $('login-remember').checked
          })
        });
        if (res.ok) { location.replace(nextTarget()); return; }
        if (res.status === 401) showError('Name oder Passwort falsch.');
        else if (res.status === 429) showError('Zu viele Fehlversuche — bitte 15 Minuten warten.');
        else showError((await res.json().catch(() => ({}))).error || 'Anmeldung fehlgeschlagen.');
      } catch (e) {
        showError('Keine Verbindung zum Server.');
      } finally {
        btn.disabled = false;
      }
    });
  });
})();
