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

// Prueft Name+Passwort direkt gegen die D1-Nutzertabelle — fuer den
// Self-Service-Passwortwechsel (Plan5-7, Altpasswort-Nachweis). true nur bei
// existierendem D1-Nutzer mit korrektem Passwort; D1-Fehler => false.
export async function verifyDbPassword(env, name, password) {
  if (!env.DB) return false;
  try {
    await ensureUsersTable(env.DB);
    const row = await env.DB.prepare('SELECT pass_hash, salt, iters FROM users WHERE name = ?').bind(name).first();
    if (!row) return false;
    const hash = await pbkdf2Hex(password, row.salt, row.iters || PBKDF2_ITERS);
    return timingSafeEqual(hash, row.pass_hash);
  } catch (e) { return false; }
}

// Login-Cache eines Nutzers in diesem Isolate verwerfen (nach Passwort-
// Aenderung oder Loeschung, Plan5-7), damit das alte Passwort bzw. eine
// Session eines geloeschten Nutzers nicht noch bis zu 5 Minuten weiterlebt.
export function invalidateAuthCache(name) {
  for (const key of [..._authCache.keys()]) {
    if (key.startsWith(name + ':')) _authCache.delete(key);
  }
  _sessionUserCache.delete(name);
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

// Zugangsdaten pruefen — zuerst gegen die Env-Nutzer (unveraendert,
// Lockout-Schutz), dann gegen die D1-Nutzertabelle (PBKDF2, mit Isolate-Cache
// gegen wiederholtes Rechnen). D1-Fehler => null (nie durchlassen).
// Von authenticateAsync (Basic-Header) UND /api/login (Formular, Plan5-5) genutzt.
export async function checkCredentialsAsync(user, pass, env) {
  const { users } = parseUsers(env);
  const entry = users.get(user);
  if (entry && entry.pass === pass) return { user, isAdmin: entry.isAdmin };
  if (!env.DB) return null;
  try {
    await ensureUsersTable(env.DB);
    const row = await env.DB.prepare('SELECT pass_hash, salt, iters, is_admin FROM users WHERE name = ?').bind(user).first();
    if (!row) return null;
    const fp = await sha256Hex(pass + ':' + row.salt);
    const cacheKey = user + ':' + fp;
    const cached = _authCache.get(cacheKey);
    if (cached && cached > Date.now()) return { user, isAdmin: !!row.is_admin };
    const hash = await pbkdf2Hex(pass, row.salt, row.iters || PBKDF2_ITERS);
    if (timingSafeEqual(hash, row.pass_hash)) {
      _authCache.set(cacheKey, Date.now() + 5 * 60 * 1000); // 5 min TTL
      return { user, isAdmin: !!row.is_admin };
    }
    return null;
  } catch (e) {
    return null; // D1-Ausfall darf nie durchlassen
  }
}

export async function authenticateAsync(request, env) {
  const creds = decodeBasic(request);
  if (!creds) return null;
  return checkCredentialsAsync(creds.user, creds.pass, env);
}

// Fehlversuch je IP in D1 zaehlen (P2-5, aus der Middleware extrahiert fuer
// /api/login). Rueckgabe: Anzahl im 15-Minuten-Fenster; D1-Fehler => 0
// (Brute-Force-Zaehlung darf den Login nie blockieren).
export async function registerAuthFail(env, ip) {
  if (!env.DB) return 0;
  try {
    await env.DB.exec('CREATE TABLE IF NOT EXISTS auth_fails (ip TEXT PRIMARY KEY, count INTEGER, first_ms INTEGER)');
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const row = await env.DB.prepare('SELECT count, first_ms FROM auth_fails WHERE ip = ?').bind(ip).first();
    let count = 1, firstMs = now;
    if (row && (now - row.first_ms) < windowMs) { count = row.count + 1; firstMs = row.first_ms; }
    await env.DB.prepare('INSERT OR REPLACE INTO auth_fails (ip, count, first_ms) VALUES (?, ?, ?)').bind(ip, count, firstMs).run();
    return count;
  } catch (e) { return 0; }
}

// ---- Session-Cookies (Plan5-5): HMAC-signierte Tokens statt Basic-Dialog ----
// Format: b64url(name).ablaufMs.hmacHex — signiert mit SESSION_SECRET (Env-Var)
// bzw. einem deterministischen Fallback aus den Env-Zugangsdaten (aendern sich
// diese, werden alle Sessions ungueltig — bewusst so).
const SESSION_COOKIE = 'sh_session';
const SESSION_REMEMBER_S = 30 * 24 * 3600; // „Angemeldet bleiben": 30 Tage
const SESSION_SHORT_S = 12 * 3600;         // sonst: 12 h (als Browser-Session-Cookie)
const _sessionUserCache = new Map();       // name -> okUntilMs (D1-Existenz, pro Isolate)

function b64Bytes(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}
function b64urlEncode(str) {
  return b64Bytes(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(b64) {
  try {
    const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  } catch (e) { return null; }
}

async function sessionSecret(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  return sha256Hex('smarthub-session:' + (env.AUTH_USER || 'admin') + ':' + (env.AUTH_PASS || 'admin') + ':' + (env.AUTH_USERS || ''));
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return bytesToHex(new Uint8Array(sig));
}

export async function createSessionCookie(env, user, remember) {
  const ttlS = remember ? SESSION_REMEMBER_S : SESSION_SHORT_S;
  const payload = b64urlEncode(user) + '.' + (Date.now() + ttlS * 1000);
  const sig = await hmacHex(await sessionSecret(env), payload);
  return `${SESSION_COOKIE}=${payload}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax${remember ? '; Max-Age=' + ttlS : ''}`;
}

export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// Nutzername aus einem gueltigen Session-Cookie, sonst null. Prueft Signatur,
// Ablauf und (mit 5-min-Isolate-Cache) ob der Nutzer noch existiert, damit
// geloeschte Profile nicht bis zum Cookie-Ablauf angemeldet bleiben.
export async function sessionUserFromCookie(request, env) {
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)sh_session=([^;]+)/);
  if (!m) return null;
  const [userB64, expStr, sig] = m[1].split('.');
  if (!userB64 || !expStr || !sig) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = await hmacHex(await sessionSecret(env), userB64 + '.' + expStr);
  if (!timingSafeEqual(sig, expected)) return null;
  const user = b64urlDecode(userB64);
  if (!user) return null;
  if (!(await sessionUserExists(env, user))) return null;
  return user;
}

async function sessionUserExists(env, user) {
  if (parseUsers(env).users.has(user)) return true;
  if (!env.DB) return false;
  const cached = _sessionUserCache.get(user);
  if (cached && cached > Date.now()) return true;
  try {
    await ensureUsersTable(env.DB);
    const row = await env.DB.prepare('SELECT name FROM users WHERE name = ?').bind(user).first();
    if (!row) return false;
    _sessionUserCache.set(user, Date.now() + 5 * 60 * 1000);
    return true;
  } catch (e) { return false; }
}

// Synthetischer Basic-Header fuer stromabwaerts liegende identify()-Aufrufe,
// nachdem das Session-Cookie validiert wurde (Plan5-5). Das „Passwort" ist nur
// ein Platzhalter — identify() prueft Passwoerter nicht erneut (siehe oben).
export function syntheticBasicHeader(user) {
  return 'Basic ' + b64Bytes(user + ':__session__');
}
