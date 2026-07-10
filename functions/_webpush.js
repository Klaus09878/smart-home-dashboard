// Web-Push-Versand (VAPID nach RFC 8292 + Payload-Verschluesselung "aes128gcm"
// nach RFC 8291/8188) ohne externe Abhaengigkeit — nur ueber WebCrypto, das in
// Cloudflare Workers UND in Node 18+ verfuegbar ist.
//
// UMD wie lib/core.js: laeuft als CommonJS (Testsuite via require) und wird von
// den Cloudflare-Functions per `import` genutzt (esbuild-Interop). Dateiname
// mit _ → keine oeffentliche Route.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const enc = new TextEncoder();
  const subtle = () => (globalThis.crypto || crypto).subtle;

  function b64urlToBytes(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64url(bytes) {
    const b = new Uint8Array(bytes);
    let bin = '';
    for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function concatBytes() {
    const arrs = Array.prototype.slice.call(arguments);
    let len = 0; arrs.forEach(a => { len += a.length; });
    const out = new Uint8Array(len); let o = 0;
    arrs.forEach(a => { out.set(a, o); o += a.length; });
    return out;
  }

  // HKDF (Extract + Expand) ueber WebCrypto.
  async function hkdf(salt, ikm, info, length) {
    const key = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const bits = await subtle().deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
    return new Uint8Array(bits);
  }

  // Payload fuer eine Subscription verschluesseln (RFC 8291, "aes128gcm").
  // opts.serverKeys / opts.salt sind nur fuer Tests (deterministische Vektoren).
  // Rueckgabe: Uint8Array (kompletter Body inkl. Header).
  async function encryptPayload(plaintext, uaPublicB64, authSecretB64, opts) {
    opts = opts || {};
    const uaPublic = b64urlToBytes(uaPublicB64);       // 65 Byte (0x04 || X || Y)
    const authSecret = b64urlToBytes(authSecretB64);   // 16 Byte
    const plaintextBytes = typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext;

    const asKeys = opts.serverKeys || await subtle().generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const asPublic = new Uint8Array(await subtle().exportKey('raw', asKeys.publicKey)); // 65 Byte

    const uaPubKey = await subtle().importKey('raw', uaPublic,
      { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const ecdhSecret = new Uint8Array(await subtle().deriveBits(
      { name: 'ECDH', public: uaPubKey }, asKeys.privateKey, 256));   // 32 Byte

    const salt = opts.salt || (globalThis.crypto || crypto).getRandomValues(new Uint8Array(16));

    // RFC 8291 §3.4: gemeinsames IKM aus auth_secret + ECDH-Secret
    const keyInfo = concatBytes(enc.encode('WebPush: info\0'), uaPublic, asPublic);
    const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

    // RFC 8188 §2.2: Content-Encryption-Key + Nonce
    const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

    // Plaintext || 0x02 (Delimiter fuer den letzten/einzigen Record)
    const padded = concatBytes(plaintextBytes, new Uint8Array([2]));
    const aesKey = await subtle().importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(await subtle().encrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded));

    // Header: salt(16) | rs(4, big-endian) | idlen(1) | keyid = asPublic(65)
    const rs = new Uint8Array([0, 0, 0x10, 0]); // 4096
    const header = concatBytes(salt, rs, new Uint8Array([asPublic.length]), asPublic);
    return concatBytes(header, ct);
  }

  // VAPID-Authorization-Header fuer einen Endpoint erzeugen (RFC 8292).
  async function vapidAuthHeader(endpoint, vapidPublicB64, vapidPrivateB64, subject) {
    const url = new URL(endpoint);
    const aud = `${url.protocol}//${url.host}`;
    const header = { typ: 'JWT', alg: 'ES256' };
    const payload = { aud, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: subject || 'mailto:admin@smarthub' };
    const signingInput =
      bytesToB64url(enc.encode(JSON.stringify(header))) + '.' +
      bytesToB64url(enc.encode(JSON.stringify(payload)));

    const priv = b64urlToBytes(vapidPrivateB64); // 32 Byte d
    const pub = b64urlToBytes(vapidPublicB64);    // 65 Byte (0x04 || X || Y)
    const jwk = {
      kty: 'EC', crv: 'P-256',
      d: bytesToB64url(priv),
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
      ext: true
    };
    const key = await subtle().importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const sig = new Uint8Array(await subtle().sign(
      { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput))); // raw r||s (64 Byte)
    const jwt = signingInput + '.' + bytesToB64url(sig);
    return `vapid t=${jwt}, k=${vapidPublicB64}`;
  }

  // Eine Benachrichtigung an eine Subscription senden. vapid = {publicKey,
  // privateKey (base64url), subject}. Gibt die fetch-Response zurueck (Status
  // 404/410 → Subscription abgelaufen, aufraeumen).
  async function sendWebPush(subscription, payloadObj, vapid) {
    const body = await encryptPayload(
      JSON.stringify(payloadObj), subscription.keys.p256dh, subscription.keys.auth);
    const auth = await vapidAuthHeader(subscription.endpoint, vapid.publicKey, vapid.privateKey, vapid.subject);
    return fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': auth,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': '86400'
      },
      body
    });
  }

  return { b64urlToBytes, bytesToB64url, concatBytes, hkdf, encryptPayload, vapidAuthHeader, sendWebPush };
});
