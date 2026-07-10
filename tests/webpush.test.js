// Testsuite fuer functions/_webpush.js (Web-Push-Krypto).
// Kernidee: was encryptPayload nach RFC 8291 verschluesselt, wird hier mit einer
// UNABHAENGIGEN Entschluesselung (rohe WebCrypto-Schritte) wieder aufgemacht.
// Stimmt der Klartext ueberein, ist ECDH + HKDF + AES-GCM + Framing korrekt.
const assert = require('assert');
const wp = require('../functions/_webpush.js');
const subtle = globalThis.crypto.subtle;

let passed = 0;
function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✔ ${name}`); })
    .catch(err => { console.error(`  ✘ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

console.log('functions/_webpush.js – Web-Push-Krypto');

test('b64url: Roundtrip beliebiger Bytes', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 62, 63]);
  const round = wp.b64urlToBytes(wp.bytesToB64url(bytes));
  assert.deepStrictEqual([...round], [...bytes]);
});

test('encryptPayload → unabhaengige Entschluesselung ergibt den Klartext', async () => {
  // 1. Browser-Subscription simulieren: UA-ECDH-Schluesselpaar + auth-Secret
  const ua = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPublic = new Uint8Array(await subtle.exportKey('raw', ua.publicKey)); // 65
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const p256dh = wp.bytesToB64url(uaPublic);
  const authB64 = wp.bytesToB64url(auth);

  const message = JSON.stringify({ title: 'Test', body: 'Schimmelrisiko Berlin' });
  const bodyBytes = await wp.encryptPayload(message, p256dh, authB64);

  // 2. Header parsen (RFC 8188): salt(16) | rs(4) | idlen(1) | keyid(asPublic 65) | ciphertext
  const salt = bodyBytes.slice(0, 16);
  const idlen = bodyBytes[20];
  assert.strictEqual(idlen, 65, 'keyid-Laenge = Server-Public (65 Byte)');
  const asPublic = bodyBytes.slice(21, 21 + idlen);
  const ct = bodyBytes.slice(21 + idlen);

  // 3. Gegenrechnung mit dem UA-Privatschluessel
  const asPubKey = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asPubKey }, ua.privateKey, 256));
  const enc = new TextEncoder();
  const keyInfo = wp.concatBytes(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await wp.hkdf(auth, ecdh, keyInfo, 32);
  const cek = await wp.hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await wp.hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ct));

  // 4. Delimiter 0x02 abschneiden, mit dem Original vergleichen
  assert.strictEqual(plain[plain.length - 1], 2, 'letzter Record endet mit Delimiter 0x02');
  const decoded = new TextDecoder().decode(plain.slice(0, -1));
  assert.strictEqual(decoded, message);
});

test('vapidAuthHeader: gueltige VAPID-Struktur (t=<JWT ES256>, k=<pub>)', async () => {
  // Ephemeres VAPID-Schluesselpaar erzeugen (P-256), als raw/base64url ableiten
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey)); // 65
  const jwk = await subtle.exportKey('jwk', kp.privateKey);
  const pubB64 = wp.bytesToB64url(pub);
  const privB64 = jwk.d; // schon base64url

  const header = await wp.vapidAuthHeader('https://fcm.googleapis.com/fcm/send/abc123', pubB64, privB64, 'mailto:x@y.de');
  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m, 'Header-Format vapid t=…, k=…');
  assert.strictEqual(m[2], pubB64);
  const [h, p] = m[1].split('.');
  const decode = s => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.strictEqual(decode(h).alg, 'ES256');
  assert.strictEqual(decode(p).aud, 'https://fcm.googleapis.com');
  assert.ok(decode(p).exp > Math.floor(Date.now() / 1000), 'exp in der Zukunft');
});

process.on('exit', () => {
  if (process.exitCode !== 1) console.log(`\nAlle ${passed} Web-Push-Tests bestanden ✔`);
  else console.log('\nWeb-Push-Tests FEHLGESCHLAGEN');
});
