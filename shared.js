// Gemeinsame Helfer für alle Seiten des Smart Home Hub.
// Wird von index.html und gpx.html VOR dem seitenspezifischen Script eingebunden.

function updateIcons() {
  if (window.lucide) window.lucide.createIcons();
  // Barrierefreiheit (Punkt 15): Icon-Buttons ohne Text bekommen ein aria-label
  // aus ihrem title, damit Screenreader sie ansagen.
  try {
    document.querySelectorAll('button[title]:not([aria-label]), a[title]:not([aria-label])').forEach(el => {
      if (el.title) el.setAttribute('aria-label', el.title);
    });
  } catch (e) { /* defensive */ }
}

function formatTime(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return '--:--';
  return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return '--.--.';
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

// Relative Zeitangabe ("vor 5 Min.") für Zeitstempel-Anzeigen
function formatRelativeTime(date) {
  const diffMin = Math.floor((Date.now() - date.getTime()) / 60000);
  if (diffMin < 1) return 'gerade eben';
  if (diffMin < 60) return `vor ${diffMin} Min.`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `vor ${diffH} Std.`;
  return `am ${formatDate(date)} um ${formatTime(date)}`;
}

// Open-Meteo Weather-Code → deutsche Beschreibung (Dashboard + GPX-Start-Wetter)
function getWeatherDescription(code) {
  const codes = {
    0: 'Klarer Himmel', 1: 'Hauptsächlich klar', 2: 'Teilweise bewölkt', 3: 'Bedeckt',
    45: 'Nebel', 48: 'Ablagernder Reifnebel',
    51: 'Leichter Nieselregen', 53: 'Mäßiger Nieselregen', 55: 'Dichter Nieselregen',
    56: 'Leichter gefrierender Nieselregen', 57: 'Dichter gefrierender Nieselregen',
    61: 'Leichter Regen', 63: 'Mäßiger Regen', 65: 'Starker Regen',
    66: 'Leichter gefrierender Regen', 67: 'Starker gefrierender Regen',
    71: 'Leichter Schneefall', 73: 'Mäßiger Schneefall', 75: 'Starker Schneefall', 77: 'Schneegriesel',
    80: 'Leichte Regenschauer', 81: 'Mäßige Regenschauer', 82: 'Starke Regenschauer',
    85: 'Leichte Schneeschauer', 86: 'Starke Schneeschauer',
    95: 'Gewitter', 96: 'Gewitter mit leichtem Hagel', 99: 'Gewitter mit schwerem Hagel'
  };
  return codes[code] || 'Unbekannt';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.innerText = str;
  return div.innerHTML;
}

// ============ Toast-Benachrichtigungen ============
// showToast('Gespeichert!') · showToast('Fehler', 'error')
// Mit Aktions-Button: showToast('Gelöscht.', 'info', { label: 'Rückgängig', onClick: () => {...} })
function showToast(message, type = 'success', action = null, durationMs = 4000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'fixed bottom-4 right-4 z-[2000] flex flex-col gap-2 items-end pointer-events-none';
    document.body.appendChild(container);
  }

  const colors = {
    success: 'border-teal-500/40 text-teal-100',
    error: 'border-red-500/40 text-red-100',
    info: 'border-slate-700 text-slate-100'
  };

  const toast = document.createElement('div');
  toast.className = `glass-panel rounded-xl px-4 py-3 text-sm shadow-lg border ${colors[type] || colors.info} flex items-center gap-3 animate-fade-in max-w-sm pointer-events-auto`;

  const span = document.createElement('span');
  span.innerText = message;
  toast.appendChild(span);

  if (action && typeof action.onClick === 'function') {
    const btn = document.createElement('button');
    btn.className = 'px-2.5 py-1 rounded-lg bg-slate-800/80 border border-slate-700 hover:border-slate-500 text-xs font-semibold text-white transition-colors shrink-0';
    btn.innerText = action.label || 'OK';
    btn.onclick = () => { toast.remove(); action.onClick(); };
    toast.appendChild(btn);
    durationMs = Math.max(durationMs, 7000);
  }

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, durationMs);
}

// ============ Modale Dialoge (ersetzen prompt/confirm im App-Stil) ============
// Promise-basiert: `const ok = await modalConfirm({...})` / `const vals = await
// modalPrompt({...})` (null bei Abbruch). Tastatur: Esc = abbrechen, Enter =
// bestätigen/absenden. Fokus landet automatisch im Dialog.
function _mkOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-[1700] bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in';
  return overlay;
}

function modalConfirm(opts = {}) {
  return new Promise(resolve => {
    const { title = 'Bestätigen', message = '', confirmLabel = 'OK', cancelLabel = 'Abbrechen', danger = false } = opts;
    const overlay = _mkOverlay();
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="glass-panel rounded-2xl p-6 shadow-2xl w-full max-w-sm">
        <h3 class="text-lg font-bold text-white mb-2">${escapeHtml(title)}</h3>
        <p class="text-sm text-slate-300 mb-5 whitespace-pre-line">${escapeHtml(message)}</p>
        <div class="flex justify-end gap-2">
          <button data-act="cancel" class="px-4 py-2 rounded-xl bg-slate-800/80 border border-slate-700 text-sm text-slate-200 hover:border-slate-500 transition-colors">${escapeHtml(cancelLabel)}</button>
          <button data-act="ok" class="px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${danger ? 'bg-red-500/20 border border-red-500/40 text-red-200 hover:bg-red-500/30' : 'bg-teal-500/20 border border-teal-500/40 text-teal-200 hover:bg-teal-500/30'}">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    const close = val => { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(val); };
    const onKey = e => { if (e.key === 'Escape') close(false); else if (e.key === 'Enter') close(true); };
    overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });
    overlay.querySelector('[data-act="cancel"]').onclick = () => close(false);
    overlay.querySelector('[data-act="ok"]').onclick = () => close(true);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    overlay.querySelector('[data-act="ok"]').focus();
  });
}

// fields: [{ key, label, type?('text'|'number'|'select'|'checkbox'|'url'),
//   value?, placeholder?, options?([{value,label}]), hint? }]
// Rückgabe: Werte-Objekt (Strings/boolean) oder null bei Abbruch.
function modalPrompt(opts = {}) {
  return new Promise(resolve => {
    const { title = '', description = '', fields = [], submitLabel = 'Speichern' } = opts;
    const overlay = _mkOverlay();
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const fieldHtml = fields.map((f, i) => {
      const id = `mp-field-${i}`;
      const hint = f.hint ? `<span class="block text-[10px] text-slate-500 mt-0.5">${escapeHtml(f.hint)}</span>` : '';
      if (f.type === 'select') {
        const os = (f.options || []).map(o => `<option value="${escapeHtml(String(o.value))}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
        return `<label class="block mb-3"><span class="text-xs text-slate-400">${escapeHtml(f.label)}</span><select id="${id}" class="mt-1 w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 focus:border-teal-500/50 focus:outline-none">${os}</select>${hint}</label>`;
      }
      if (f.type === 'checkbox') {
        return `<label class="flex items-center gap-2 mb-3 cursor-pointer text-sm text-slate-200"><input type="checkbox" id="${id}" ${f.value ? 'checked' : ''} class="accent-teal-500"> ${escapeHtml(f.label)}</label>`;
      }
      return `<label class="block mb-3"><span class="text-xs text-slate-400">${escapeHtml(f.label)}</span><input type="${f.type || 'text'}" id="${id}" value="${f.value != null ? escapeHtml(String(f.value)) : ''}" placeholder="${escapeHtml(f.placeholder || '')}" ${f.type === 'number' ? 'inputmode="decimal"' : ''} class="mt-1 w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-teal-500/50 focus:outline-none">${hint}</label>`;
    }).join('');
    overlay.innerHTML = `
      <div class="glass-panel rounded-2xl p-6 shadow-2xl w-full max-w-md max-h-[85vh] overflow-y-auto">
        <h3 class="text-lg font-bold text-white mb-1">${escapeHtml(title)}</h3>
        ${description ? `<p class="text-xs text-slate-400 mb-4">${escapeHtml(description)}</p>` : '<div class="mb-2"></div>'}
        <form>${fieldHtml}
          <div class="flex justify-end gap-2 mt-5">
            <button type="button" data-act="cancel" class="px-4 py-2 rounded-xl bg-slate-800/80 border border-slate-700 text-sm text-slate-200 hover:border-slate-500 transition-colors">Abbrechen</button>
            <button type="submit" class="px-4 py-2 rounded-xl bg-teal-500/20 border border-teal-500/40 text-teal-200 text-sm font-semibold hover:bg-teal-500/30 transition-colors">${escapeHtml(submitLabel)}</button>
          </div>
        </form>
      </div>`;
    const close = val => { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(val); };
    const onKey = e => { if (e.key === 'Escape') close(null); };
    const readValues = () => {
      const out = {};
      fields.forEach((f, i) => {
        const el = document.getElementById(`mp-field-${i}`);
        if (!el) return;
        out[f.key] = f.type === 'checkbox' ? el.checked : el.value;
      });
      return out;
    };
    overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
    overlay.querySelector('[data-act="cancel"]').onclick = () => close(null);
    overlay.querySelector('form').addEventListener('submit', e => { e.preventDefault(); close(readValues()); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    const first = overlay.querySelector('input, select');
    if (first) first.focus();
  });
}

// ============ API-Schicht (/api/* → Cloudflare Pages Functions) ============
// Wirft Error mit .unavailable = true, wenn die API (noch) nicht eingerichtet
// ist (404: Functions fehlen, 503: Env-Var/D1-Binding nicht konfiguriert).
// Aufrufer können dann auf Direktzugriff oder Nur-Lokal-Betrieb zurückfallen.
async function apiFetch(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
  } catch (networkErr) {
    const e = new Error('API nicht erreichbar');
    e.unavailable = true;
    throw e;
  }

  if (res.status === 404 || res.status === 503 || res.status === 405) {
    const e = new Error(`API nicht verfügbar (${res.status})`);
    e.unavailable = true;
    throw e;
  }
  if (!res.ok) throw new Error(`API-Fehler ${res.status}`);

  const contentType = res.headers.get('content-type') || '';
  // Statisches Hosting ohne Functions liefert für /api/* teils die SPA-Seite aus
  if (!contentType.includes('application/json')) {
    const e = new Error('API nicht verfügbar (keine JSON-Antwort)');
    e.unavailable = true;
    throw e;
  }
  return res.json();
}

// ============ CSV-Download-Helfer ============
// lines: Array bereits fertig getrennter Zeilen (Semikolon-getrennt).
// Stellt das UTF-8-BOM voran, damit Excel Umlaute korrekt erkennt.
function downloadCsv(filename, lines) {
  const csv = '﻿' + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ============ Fehler-Reporting (unbehandelte Fehler → ntfy-Push) ============
// Meldet Laufzeitfehler ans konfigurierte ntfy-Topic (max. 3 pro Sitzung,
// gleicher Fehlertext höchstens 1×/6 h) — sonst bleiben Fehler auf anderen
// Geräten (z. B. bei Gillian) unbemerkt. Ohne Topic passiert nichts.
let _errorPushCount = 0;
function reportRuntimeError(kind, message) {
  try {
    if (_errorPushCount >= 3) return;
    // Regel „App-Fehler" respektieren, falls konfiguriert
    if (window.Store && window.Store.ready && typeof window.Store.getJSON === 'function') {
      const r = window.Store.getJSON('notify_rules', null);
      if (r && r.types && r.types.errors && r.types.errors.on === false) return;
    }
    const msg = (message || '').toString().substring(0, 300);
    if (!msg || msg === 'Script error.') return; // Cross-Origin-Rauschen ignorieren
    _errorPushCount++;
    let hash = 0;
    for (let i = 0; i < msg.length; i++) hash = (hash * 31 + msg.charCodeAt(i)) | 0;
    sendPush(
      'Smart Home Hub – Fehler',
      `${kind} auf ${location.pathname}${location.hash}: ${msg}`,
      'rotating_light',
      `err_${hash}`
    );
    // Zusätzlich serverseitig protokollieren (System-Seite), best effort
    fetch('/api/error-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: `${location.pathname}${location.hash}`, message: `${kind}: ${msg}` })
    }).catch(() => {});
  } catch (e) { /* Fehler-Reporting darf selbst nie werfen */ }
}
window.addEventListener('error', e => reportRuntimeError('Fehler', e.message));
window.addEventListener('unhandledrejection', e =>
  reportRuntimeError('Unbehandelte Promise-Ablehnung', e.reason && (e.reason.message || e.reason)));

// ============ Theme (hell/dunkel, Punkt 10) ============
// theme: 'dark' | 'light'. Wird sofort im <head> aus dem rohen localStorage
// angewandt; die profilbezogene Kopie liegt zusätzlich im Store.
function applyTheme(theme) {
  const light = theme === 'light';
  document.documentElement.classList.toggle('light', light);
  document.documentElement.classList.toggle('dark', !light);
  try { localStorage.setItem('theme', light ? 'light' : 'dark'); } catch (e) { /* ignore */ }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', light ? '#eef2f7' : '#0f172a');
}

function getTheme() {
  if (window.Store && window.Store.ready) return Store.get('theme') || 'dark';
  try { return localStorage.getItem('theme') || 'dark'; } catch (e) { return 'dark'; }
}

// ============ Service Worker + Update-Hinweis (PWA) ============
// Registriert den SW und bietet bei einer neuen Version einen „Neu laden"-Toast
// an (statt still die alte Version weiter auszuliefern).
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          showToast('Neue Version verfügbar.', 'info', {
            label: 'Neu laden',
            onClick: () => { (reg.waiting || nw).postMessage('skipWaiting'); }
          }, 20000);
        }
      });
    });
  }).catch(err => console.warn('Service Worker Registrierung fehlgeschlagen:', err));

  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
}

// ============ ntfy.sh Push-Benachrichtigungen ============
// Topic wird in localStorage ('ntfy_topic') gespeichert; Konfiguration siehe README.
function getNtfyTopic() {
  // Profilbezogen über Store (falls verfügbar), sonst roher Fallback.
  if (window.Store && window.Store.ready) return (window.Store.get('ntfy_topic') || '').trim();
  return (localStorage.getItem('ntfy_topic') || '').trim();
}

// Sendet eine Push-Nachricht; dedupeKey+dedupeMs verhindern Spam
// (z. B. nur 1 Benachrichtigung pro 6h für dieselbe Warnung).
async function sendPush(title, message, tags = 'warning', dedupeKey = null, dedupeMs = 6 * 60 * 60 * 1000) {
  const topic = getNtfyTopic();
  if (!topic) return false;

  if (dedupeKey) {
    const last = parseInt(localStorage.getItem(`push_sent_${dedupeKey}`) || '0', 10);
    if (Date.now() - last < dedupeMs) return false;
  }

  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      body: message,
      headers: { 'Title': title, 'Tags': tags, 'Priority': 'high' }
    });
    if (dedupeKey) localStorage.setItem(`push_sent_${dedupeKey}`, Date.now().toString());
    return true;
  } catch (err) {
    console.warn('ntfy-Push fehlgeschlagen:', err);
    return false;
  }
}

// ============ Event-Delegation statt Inline-Handler (P2-8) ============
// Ermoeglicht eine CSP ohne script-src 'unsafe-inline'. Markup nutzt
//   data-onclick / data-onchange / data-oninput / data-onsubmit = "fn|arg1|arg2"
// Sonderwerte: $value=el.value, $checked=el.checked, $event=Event-Objekt;
// numerische Argumente werden zu Number, true/false/null zu den Literalen.
// data-onbackdrop="fn" feuert nur bei Klick direkt auf das Element (Overlays).
function _delegatedArg(raw, el, event) {
  switch (raw) {
    case '$value': return el.value != null ? el.value : '';
    case '$checked': return !!el.checked;
    case '$event': return event;
    case 'true': return true;
    case 'false': return false;
    case 'null': return null;
    default: return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
}

['click', 'change', 'input', 'submit'].forEach(type => {
  document.addEventListener(type, event => {
    const target = event.target;
    if (!target || !target.closest) return;
    if (type === 'click') {
      const bd = target.closest('[data-onbackdrop]');
      if (bd && target === bd) {
        const bf = window[bd.getAttribute('data-onbackdrop')];
        if (typeof bf === 'function') bf(event);
      }
    }
    const el = target.closest(`[data-on${type}]`);
    if (!el) return;
    const [name, ...rawArgs] = el.getAttribute(`data-on${type}`).split('|');
    const fn = window[name];
    if (typeof fn !== 'function') return;
    if (type === 'submit') event.preventDefault();
    fn(...rawArgs.map(a => _delegatedArg(a, el, event)));
  });
});

// Ersetzt inline `document.getElementById(id).click()` fuer versteckte Datei-Inputs.
function openPicker(id) { const el = document.getElementById(id); if (el) el.click(); }
window.openPicker = openPicker;
