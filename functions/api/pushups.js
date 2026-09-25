// functions/api/pushups.js — Liegestütz-Tracking & iCloud/Shortcut Ingestion via Cloudflare D1.
//
// Unterstützt:
//   1. Session-Cookie / Basic Auth (Browser & Dashboard)
//   2. API-Token (Header "X-Pushup-Token" oder Query "?token=") für Apple Kurzbefehle
//   3. Single Entry JSON: { delta, type, timestamp?, total? }
//   4. Bulk CSV Upload / Ingestion (text/csv oder text/plain)
//   5. GET /api/pushups → JSON mit Records & Summary (oder format=csv)

import { identify, authenticateAsync } from '../_auth.js';

const json = (obj, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders
    }
  });

async function ensureSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pushup_logs (
      id TEXT PRIMARY KEY,
      profile TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      delta INTEGER NOT NULL,
      type TEXT NOT NULL,
      total INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      deleted INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pushup_profile_ts ON pushup_logs(profile, timestamp);
  `);
}

function parseToken(request, env) {
  const configured = (env.PUSHUP_TOKEN || env.SESSION_SECRET || 'pushup-secret-token').trim();
  const headerToken = request.headers.get('X-Pushup-Token') || request.headers.get('X-Api-Key');
  if (headerToken && headerToken.trim() === configured) return true;
  
  const authHeader = request.headers.get('Authorization') || '';
  if (authHeader.startsWith('Bearer ') && authHeader.slice(7).trim() === configured) return true;
  
  const url = new URL(request.url);
  const queryToken = url.searchParams.get('token');
  if (queryToken && queryToken.trim() === configured) return true;

  return false;
}

function formatIso(d = new Date()) {
  const pad = n => (n < 10 ? '0' : '') + n;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB) {
    return json({ error: 'D1-Datenbank nicht konfiguriert (Binding "DB" in den Pages-Einstellungen anlegen)' }, 503);
  }

  // Auth: 1. Session / Basic Auth, 2. Token
  let user = null;
  const id = identify(request, env);
  if (id && id.user) {
    user = id.user;
  } else if (await authenticateAsync(request, env)) {
    const creds = identify(request, env);
    user = creds ? creds.user : (env.AUTH_USER || 'admin');
  } else if (parseToken(request, env)) {
    user = env.AUTH_USER || 'admin';
  }

  if (!user) {
    return json({ error: 'Nicht autorisiert. Bitte Login, Basic Auth oder X-Pushup-Token angeben.' }, 401);
  }

  await ensureSchema(env.DB);
  const url = new URL(request.url);

  // -------------------------------------------------------------
  // GET: Abruf der Liegestütz-Historie & Zusammenfassung
  // -------------------------------------------------------------
  if (request.method === 'GET') {
    const format = url.searchParams.get('format');
    const limit = Math.min(1000, parseInt(url.searchParams.get('limit') || '500', 10));

    const { results } = await env.DB
      .prepare('SELECT id, timestamp, delta, type, total, created_at FROM pushup_logs WHERE profile = ? AND deleted = 0 ORDER BY timestamp ASC')
      .bind(user)
      .all();

    const records = results || [];

    // CSV-Export
    if (format === 'csv') {
      const csvLines = ['timestamp;delta;type;total'];
      records.forEach(r => {
        csvLines.push(`${r.timestamp};${r.delta};${r.type};${r.total}`);
      });
      return new Response(csvLines.join('\n'), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="pushups.csv"'
        }
      });
    }

    // Summary berechnen
    let totalDone = 0;
    let totalOpen = 0;
    let recordSession = 0;
    const todayStr = new Date().toISOString().slice(0, 10);
    let todayDone = 0;
    let todayOpen = 0;
    let currentTotal = records.length > 0 ? records[records.length - 1].total : 0;

    records.forEach(r => {
      const isToday = r.timestamp && r.timestamp.startsWith(todayStr);
      if (r.type === 'done' || r.delta < 0) {
        const val = Math.abs(r.delta);
        totalDone += val;
        if (val > recordSession) recordSession = val;
        if (isToday) todayDone += val;
      }
      if (r.type === 'open' || r.delta > 0) {
        totalOpen += r.delta;
        if (isToday) todayOpen += r.delta;
      }
    });

    const displayRecords = records.slice(-limit);

    return json({
      profile: user,
      summary: {
        currentTotal,
        todayDone,
        todayOpen,
        todayNet: todayOpen - todayDone,
        totalDone,
        totalOpen,
        recordSession,
        count: records.length,
        status: currentTotal <= 0 ? 'debt-free' : (currentTotal <= 20 ? 'moderate' : 'high-debt')
      },
      records: displayRecords
    });
  }

  // -------------------------------------------------------------
  // POST: Eintrag erfassen (Single JSON, Bulk Items oder CSV Text)
  // -------------------------------------------------------------
  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type') || '';
    const now = Date.now();

    // Letzten Stand für fortlaufendes Total laden
    const lastRow = await env.DB
      .prepare('SELECT total FROM pushup_logs WHERE profile = ? AND deleted = 0 ORDER BY timestamp DESC, id DESC LIMIT 1')
      .bind(user)
      .first();
    let runningTotal = lastRow ? Number(lastRow.total) : 0;

    let entriesToInsert = [];

    if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
      const rawText = await request.text();
      const lines = rawText.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.toLowerCase().startsWith('timestamp')) continue;
        const delim = trimmed.includes(';') ? ';' : ',';
        const parts = trimmed.split(delim);
        if (parts.length < 2) continue;

        const ts = parts[0].trim() || formatIso();
        const delta = parseInt(parts[1].trim(), 10) || 0;
        let type = parts[2] ? parts[2].trim().toLowerCase() : (delta < 0 ? 'done' : 'open');
        let total = parts[3] ? parseInt(parts[3].trim(), 10) : NaN;

        if (isNaN(total)) {
          runningTotal += delta;
          total = runningTotal;
        } else {
          runningTotal = total;
        }

        entriesToInsert.push({
          id: 'p_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16),
          timestamp: ts,
          delta,
          type,
          total
        });
      }
    } else {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: 'Ungültiges JSON oder leere Anfrage' }, 400);
      }

      const items = Array.isArray(body) ? body : (Array.isArray(body.items) ? body.items : [body]);

      for (const item of items) {
        const delta = parseInt(item.delta, 10);
        if (isNaN(delta)) continue;

        let type = item.type ? String(item.type).toLowerCase() : (delta < 0 ? 'done' : 'open');
        const ts = item.timestamp ? String(item.timestamp).trim() : formatIso();
        let total = typeof item.total === 'number' ? item.total : (parseInt(item.total, 10));

        if (isNaN(total)) {
          runningTotal += delta;
          total = runningTotal;
        } else {
          runningTotal = total;
        }

        entriesToInsert.push({
          id: item.id || ('p_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16)),
          timestamp: ts,
          delta,
          type,
          total
        });
      }
    }

    if (entriesToInsert.length === 0) {
      return json({ error: 'Keine gültigen Einträge zum Speichern übergeben' }, 400);
    }

    // In D1 schreiben (Batch)
    const statements = entriesToInsert.map(entry => {
      return env.DB.prepare(
        'INSERT OR REPLACE INTO pushup_logs (id, profile, timestamp, delta, type, total, created_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
      ).bind(entry.id, user, entry.timestamp, entry.delta, entry.type, entry.total, now);
    });

    // Cloudflare D1 unterstützt db.batch(statements)
    await env.DB.batch(statements);

    return json({
      success: true,
      inserted: entriesToInsert.length,
      currentTotal: runningTotal,
      latest: entriesToInsert[entriesToInsert.length - 1]
    });
  }

  // -------------------------------------------------------------
  // DELETE: Einzelnen Eintrag löschen oder zurücksetzen
  // -------------------------------------------------------------
  if (request.method === 'DELETE') {
    const idToDelete = url.searchParams.get('id');
    if (!idToDelete) {
      return json({ error: 'ID erforderlich (?id=...)' }, 400);
    }
    await env.DB
      .prepare('UPDATE pushup_logs SET deleted = 1 WHERE profile = ? AND id = ?')
      .bind(user, idToDelete)
      .run();
    return json({ success: true, deletedId: idToDelete });
  }

  return json({ error: 'Method not allowed' }, 405);
}
