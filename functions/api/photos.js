// Foto-Anhaenge pro GPX-Tour (Plan-Punkt 10b) in Cloudflare R2 (Binding "MEDIA").
// Bilder gehoeren nicht in die D1-Datenbank — daher R2. Schluessel:
//   gpx/<profil>/<uid>/<n>.webp
//
//   GET    /api/photos?uid=<tour>          → { photos: [{ n, url }] }  (Liste)
//   GET    /api/photos?key=<key>           → das Bild (Bytes)
//   PUT    /api/photos?uid=<tour>&n=<i>    → Bild speichern (Body = Bilddaten)
//   DELETE /api/photos?uid=<tour>&n=<i>    → ein Foto loeschen
//   DELETE /api/photos?uid=<tour>          → alle Fotos der Tour loeschen
//
// Ohne R2-Binding antwortet der Endpunkt 503 → der Client blendet die Foto-UI
// aus (☁️-Fallback). Limits: 5 Fotos/Tour, 500 KB/Foto.
import { identify } from '../_auth.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const MAX_PER_TOUR = 5;
const MAX_BYTES = 500 * 1024;
const safe = s => String(s || '').replace(/[^\w-]/g, '').slice(0, 64);

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!env.MEDIA) return json({ error: 'R2-Speicher nicht konfiguriert (Binding "MEDIA")' }, 503);
  const id = identify(request, env);
  if (!id) return json({ error: 'nicht authentifiziert' }, 401);
  const profile = safe(id.user);

  // Bild ausliefern (kein uid noetig; Key ist profil-gebunden)
  if (request.method === 'GET' && url.searchParams.get('key')) {
    const key = url.searchParams.get('key');
    if (key.indexOf(`gpx/${profile}/`) !== 0) return json({ error: 'kein Zugriff' }, 403);
    const obj = await env.MEDIA.get(key);
    if (!obj) return json({ error: 'nicht gefunden' }, 404);
    return new Response(obj.body, {
      headers: { 'Content-Type': obj.httpMetadata?.contentType || 'image/webp', 'Cache-Control': 'private, max-age=86400' }
    });
  }

  const uid = safe(url.searchParams.get('uid'));
  if (!uid) return json({ error: 'uid erforderlich' }, 400);
  const prefix = `gpx/${profile}/${uid}/`;

  if (request.method === 'GET') {
    const list = await env.MEDIA.list({ prefix, include: ['customMetadata'] });
    const photos = (list.objects || [])
      .map(o => {
        const md = o.customMetadata || {};
        const lat = md.lat != null ? parseFloat(md.lat) : null;
        const lon = md.lon != null ? parseFloat(md.lon) : null;
        return {
          n: Number(o.key.slice(prefix.length).replace(/\.webp$/, '')),
          key: o.key,
          url: `/api/photos?key=${encodeURIComponent(o.key)}`,
          lat: (lat != null && !isNaN(lat)) ? lat : null,
          lon: (lon != null && !isNaN(lon)) ? lon : null
        };
      })
      .filter(p => !isNaN(p.n))
      .sort((a, b) => a.n - b.n);
    return json({ photos });
  }

  if (request.method === 'PUT') {
    const n = parseInt(url.searchParams.get('n'), 10);
    if (isNaN(n) || n < 0 || n >= MAX_PER_TOUR) return json({ error: 'ungueltige Foto-Nummer' }, 400);
    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0) return json({ error: 'leerer Body' }, 400);
    if (buf.byteLength > MAX_BYTES) return json({ error: `Foto zu gross (max. ${Math.round(MAX_BYTES / 1024)} KB)` }, 413);
    // Obergrenze pro Tour pruefen (neue Nummer)
    const existing = await env.MEDIA.list({ prefix });
    const keys = new Set((existing.objects || []).map(o => o.key));
    const key = `${prefix}${n}.webp`;
    if (!keys.has(key) && keys.size >= MAX_PER_TOUR) return json({ error: `max. ${MAX_PER_TOUR} Fotos pro Tour` }, 409);
    // Foto-Geotag (P2-15): gueltige Koordinaten als customMetadata ablegen
    const opts = { httpMetadata: { contentType: request.headers.get('content-type') || 'image/webp' } };
    const lat = parseFloat(url.searchParams.get('lat'));
    const lon = parseFloat(url.searchParams.get('lon'));
    if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      opts.customMetadata = { lat: String(lat), lon: String(lon) };
    }
    await env.MEDIA.put(key, buf, opts);
    return json({ ok: true, key, url: `/api/photos?key=${encodeURIComponent(key)}` });
  }

  if (request.method === 'DELETE') {
    const nRaw = url.searchParams.get('n');
    if (nRaw !== null) {
      const n = parseInt(nRaw, 10);
      if (isNaN(n)) return json({ error: 'ungueltige Foto-Nummer' }, 400);
      await env.MEDIA.delete(`${prefix}${n}.webp`);
      return json({ ok: true });
    }
    // ganze Tour: alle Fotos entfernen (Tombstone-Aufraeumung)
    const list = await env.MEDIA.list({ prefix });
    await Promise.all((list.objects || []).map(o => env.MEDIA.delete(o.key)));
    return json({ ok: true, deleted: (list.objects || []).length });
  }

  return json({ error: 'Methode nicht erlaubt' }, 405);
}
