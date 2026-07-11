// Gemeinsame Auth-Helfer für die Pages Functions (Dateiname mit _ → keine Route).
// Mehrbenutzer-Login: jeder Login-Name ist ein eigenes Profil. Die Middleware
// erzwingt gültige Zugangsdaten, /api/whoami verrät dem Client das aktive Profil.
//
// Konfiguration (Pages → Settings → Environment variables):
//   AUTH_USER / AUTH_PASS   – Admin-Konto (Default admin/admin beim ersten Start)
//   AUTH_USERS              – weitere Profile, Format "name:passwort;name2:passwort2"
// Namen und Passwörter dürfen kein ':' oder ';' enthalten.

export function parseUsers(env) {
  const users = new Map();
  const adminUser = (env.AUTH_USER || 'admin').trim();
  const adminPass = env.AUTH_PASS || 'admin';
  users.set(adminUser, { pass: adminPass, isAdmin: true });

  (env.AUTH_USERS || '').split(';').forEach(pair => {
    const idx = pair.indexOf(':');
    if (idx <= 0) return;
    const name = pair.slice(0, idx).trim();
    const pass = pair.slice(idx + 1).trim();
    if (name && !users.has(name)) {
      users.set(name, { pass, isAdmin: name === adminUser });
    }
  });

  return { users, adminUser };
}

// Prüft den Basic-Auth-Header gegen die konfigurierten Nutzer.
// Rückgabe { user, isAdmin } bei Erfolg, sonst null.
export function authenticate(request, env) {
  const header = request.headers.get('Authorization');
  if (!header || !header.startsWith('Basic ')) return null;
  let decoded;
  try { decoded = atob(header.split(' ')[1]); } catch (e) { return null; }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);

  const { users } = parseUsers(env);
  const entry = users.get(user);
  if (entry && entry.pass === pass) return { user, isAdmin: entry.isAdmin };
  return null;
}

// Basic-Auth-Header dekodieren → { user, pass } oder null.
function decodeBasic(request) {
  const header = request.headers.get('Authorization');
  if (!header || !header.startsWith('Basic ')) return null;
  let decoded;
  try { decoded = atob(header.split(' ')[1]); } catch (e) { return null; }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

// Profil-Identität einer Anfrage — berücksichtigt auch Cloudflare Access.
// Bei AUTH_MODE=access liefert Access die E-Mail im Header; deren lokaler Teil
// wird zum Profilnamen. Rückgabe { user, isAdmin, mode } oder null.
//
// WICHTIG: identify() validiert das Passwort NICHT erneut — die Middleware
// (authenticateAsync) hat das bereits getan und laesst nur gueltige Anfragen
// durch. So werden auch D1-Nutzer (Plan2-16) erkannt, ohne dass identify async
// werden muss. Admin ist ausschliesslich das Env-Konto; D1-Nutzer sind normale
// Profile (isAdmin=false).
export function identify(request, env) {
  if (env.AUTH_MODE === 'access') {
    const email = request.headers.get('Cf-Access-Authenticated-User-Email');
    if (email) {
      return { user: email.split('@')[0] || 'access', isAdmin: true, mode: 'access' };
    }
    return null;
  }
  const creds = decodeBasic(request);
  if (!creds) return null;
  const { users } = parseUsers(env);
  const envEntry = users.get(creds.user);
  return { user: creds.user, isAdmin: envEntry ? envEntry.isAdmin : false, mode: 'basic' };
}

// ---- D1-Nutzerverwaltung (Plan2-16): PBKDF2-SHA256 ----
const PBKDF2_ITERS = 100000;
const _authCache = new Map(); // name+':'+passFingerprint -> okUntilMs (pro Isolate)

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return bytesToHex(new Uint8Array(buf));
}
async function pbkdf2Hex(password, saltHex, iters) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: iters, hash: 'SHA-256' }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}
// Konstantzeit-Vergleich zweier Hex-Strings gleicher Laenge.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Neuen Passwort-Hash erzeugen (fuer den users-Endpunkt).
export async function hashPassword(password) {
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await pbkdf2Hex(password, salt, PBKDF2_ITERS);
  return { salt, hash, iters: PBKDF2_ITERS };
}

export async function ensureUsersTable(db) {
  await db.exec('CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, pass_hash TEXT, salt TEXT, iters INTEGER, is_admin INTEGER, created_at INTEGER)');
}

// Namen aller D1-Nutzer (fuer die Profil-Liste in whoami). Best effort.
export async function dbUserNames(env) {
  if (!env.DB) return [];
  try {
    await ensureUsersTable(env.DB);
    const { results } = await env.DB.prepare('SELECT name FROM users').all();
    return (results || []).map(r => r.name);
  } catch (e) { return []; }
}

// Auth zuerst gegen die Env-Nutzer (unveraendert, Lockout-Schutz), dann gegen
// die D1-Nutzertabelle (PBKDF2, mit Isolate-Cache gegen wiederholtes Rechnen).
// D1-Fehler => null (nie durchlassen).
export async function authenticateAsync(request, env) {
  const sync = authenticate(request, env);
  if (sync) return sync;
  if (!env.DB) return null;
  const creds = decodeBasic(request);
  if (!creds) return null;
  try {
    await ensureUsersTable(env.DB);
    const row = await env.DB.prepare('SELECT pass_hash, salt, iters, is_admin FROM users WHERE name = ?').bind(creds.user).first();
    if (!row) return null;
    const fp = await sha256Hex(creds.pass + ':' + row.salt);
    const cacheKey = creds.user + ':' + fp;
    const cached = _authCache.get(cacheKey);
    if (cached && cached > Date.now()) return { user: creds.user, isAdmin: !!row.is_admin };
    const hash = await pbkdf2Hex(creds.pass, row.salt, row.iters || PBKDF2_ITERS);
    if (timingSafeEqual(hash, row.pass_hash)) {
      _authCache.set(cacheKey, Date.now() + 5 * 60 * 1000); // 5 min TTL
      return { user: creds.user, isAdmin: !!row.is_admin };
    }
    return null;
  } catch (e) {
    return null; // D1-Ausfall darf nie durchlassen
  }
}
