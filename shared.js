// Gemeinsame Helfer für alle Seiten des Smart Home Hub.
// Wird von index.html und gpx.html VOR dem seitenspezifischen Script eingebunden.

function updateIcons() {
  if (window.lucide) window.lucide.createIcons();
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

// ============ ntfy.sh Push-Benachrichtigungen ============
// Topic wird in localStorage ('ntfy_topic') gespeichert; Konfiguration siehe README.
function getNtfyTopic() {
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
