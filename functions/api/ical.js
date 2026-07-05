// CORS-Proxy für Kalender-Feeds (.ics) — das Kalender-Widget auf dem Hub kann
// externe iCal-URLs (z. B. die „geheime Adresse" eines Google Kalenders) nicht
// direkt laden, weil deren Server kein CORS erlauben. Dieser Endpunkt holt den
// Feed serverseitig und reicht ihn durch (5 Min Edge-Cache, 512-KB-Deckel).
//
// Aufruf: GET /api/ical?url=https%3A%2F%2F...
// Hinter der Basic-Auth-Middleware — und zusätzlich auf bekannte Kalender-Hosts
// beschränkt (Punkt 27), damit der Proxy nicht als offener Fetch missbraucht wird.

const MAX_BYTES = 512 * 1024;
// Erlaubte Host-Endungen (Google, Apple/iCloud, Outlook/Office365, Nextcloud-Cloud …)
const ALLOWED_HOST_SUFFIXES = [
  'google.com', 'googleusercontent.com', 'calendar.google.com',
  'icloud.com', 'me.com',
  'outlook.com', 'outlook.office365.com', 'office365.com', 'live.com',
  'yahoo.com', 'fastmail.com', 'posteo.de', 'mailbox.org', 'gmx.net', 'web.de'
];

function hostAllowed(host) {
  host = host.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some(s => host === s || host.endsWith('.' + s));
}

export async function onRequestGet(context) {
  const target = new URL(context.request.url).searchParams.get('url');

  if (!target || !/^https:\/\//i.test(target)) {
    return new Response(JSON.stringify({ error: 'Parameter url (https://…) erforderlich' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  let host;
  try { host = new URL(target).hostname; } catch (e) {
    return new Response(JSON.stringify({ error: 'Ungültige URL' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (!hostAllowed(host)) {
    return new Response(JSON.stringify({ error: `Kalender-Host nicht erlaubt: ${host}. Unterstützt werden u. a. Google, iCloud, Outlook.` }), {
      status: 403, headers: { 'Content-Type': 'application/json' }
    });
  }

  let res;
  try {
    res = await fetch(target, {
      headers: { 'Accept': 'text/calendar, text/plain;q=0.8' },
      cf: { cacheTtl: 300, cacheEverything: true }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Kalender nicht erreichbar: ${err.message}` }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }
  if (!res.ok) {
    return new Response(JSON.stringify({ error: `Kalender-Server antwortet mit ${res.status}` }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }

  const text = (await res.text()).slice(0, MAX_BYTES);
  if (text.indexOf('BEGIN:VCALENDAR') === -1) {
    return new Response(JSON.stringify({ error: 'Antwort ist kein iCal-Feed (BEGIN:VCALENDAR fehlt)' }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response(text, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'private, max-age=300'
    }
  });
}
