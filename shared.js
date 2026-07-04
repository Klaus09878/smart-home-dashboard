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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.innerText = str;
  return div.innerHTML;
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
