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

// Profil-Identität einer Anfrage — berücksichtigt auch Cloudflare Access.
// Bei AUTH_MODE=access liefert Access die E-Mail im Header; deren lokaler Teil
// wird zum Profilnamen. Rückgabe { user, isAdmin, mode } oder null.
export function identify(request, env) {
  if (env.AUTH_MODE === 'access') {
    const email = request.headers.get('Cf-Access-Authenticated-User-Email');
    if (email) {
      return { user: email.split('@')[0] || 'access', isAdmin: true, mode: 'access' };
    }
    return null;
  }
  const auth = authenticate(request, env);
  return auth ? { ...auth, mode: 'basic' } : null;
}
