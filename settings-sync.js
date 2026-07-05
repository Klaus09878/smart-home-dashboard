// Profil- & Einstellungs-Schicht für alle Seiten.
// Wird VOR app.js / gpx.js geladen (nach shared.js, das apiFetch liefert).
//
// Aufgaben:
//  1. Aktives Profil bestimmen (aus /api/whoami, sonst lokal „default").
//  2. Alle profilbezogenen Einstellungen unter dem Präfix  p_<profil>_<key>
//     im localStorage ablegen — so hat jedes Login-Profil seinen eigenen Bereich.
//  3. Diese Einstellungen nach D1 spiegeln (/api/settings) mit Offline-Queue und
//     Konfliktlösung über updatedAt (neuerer Stand gewinnt), damit sie
//     geräteübergreifend und über gelöschte Browser-Daten hinweg bestehen.
//
// Verwendung im App-Code:  Store.get(key) / Store.set(key, str) /
//   Store.getJSON(key, fallback) / Store.setJSON(key, obj) / Store.remove(key).
// Gerätelokale Dinge (Dedupe-Zeitstempel, Offline-Queues) bleiben bewusst bei
// rohem localStorage und werden NICHT synchronisiert.

const Store = (function () {
  const state = {
    profile: 'default',
    isAdmin: false,
    mode: 'local',      // 'server' sobald /api/whoami + D1 erreichbar
    profiles: null,
    ready: false,
    _initPromise: null
  };

  // Bekannte Alt-Schlüssel (ohne Profil-Präfix) für die einmalige Migration
  const LEGACY_KEYS = [
    'ntfy_topic', 'ical_url', 'gpx_goals', 'hub_widget_order', 'hub_widget_hidden',
    'hub_todos', 'selected_location', 'notify_rules', 'onboarding', 'gpx_type_hints'
  ];
  const LEGACY_PREFIXES = ['loc_thresholds_', 'loc_weather_', 'loc_name_'];

  const phys = key => `p_${state.profile}_${key}`;
  const metaKey = key => `p_${state.profile}_${key}__ts`;
  const pendingKey = () => `sync_pending_${state.profile}`;

  function localTs(key) {
    return parseInt(localStorage.getItem(metaKey(key)) || '0', 10);
  }

  // ---- Offline-Queue: ausstehende Änderungen (überlebt Reloads) ----
  function loadPending() {
    try { return JSON.parse(localStorage.getItem(pendingKey()) || '{}'); }
    catch (e) { return {}; }
  }
  function savePending(p) { localStorage.setItem(pendingKey(), JSON.stringify(p)); }

  let flushTimer = null;
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flushSync(); }, 1500);
  }
  function queueSync(key, value, ts) {
    const p = loadPending();
    p[key] = { key, value, updatedAt: ts }; // pro Schlüssel nur der neueste Stand
    savePending(p);
    scheduleFlush();
  }
  async function flushSync() {
    if (state.mode !== 'server') return;
    const items = Object.values(loadPending());
    if (items.length === 0) return;
    try {
      await apiFetch('/api/settings', { method: 'POST', body: JSON.stringify({ items }) });
      savePending({}); // erst nach Erfolg leeren
    } catch (err) {
      if (!err.unavailable) console.warn('Einstellungs-Sync fehlgeschlagen:', err);
      // sonst: in der Queue lassen, später erneut versuchen
    }
  }

  // ---- öffentliche Get/Set-API ----
  const api = {
    get profile() { return state.profile; },
    get isAdmin() { return state.isAdmin; },
    get mode() { return state.mode; },
    get profiles() { return state.profiles; },
    get ready() { return state.ready; },

    get(key) { return localStorage.getItem(phys(key)); },

    set(key, value, opts = {}) {
      localStorage.setItem(phys(key), value);
      const ts = opts.updatedAt || Date.now();
      localStorage.setItem(metaKey(key), String(ts));
      if (opts.sync !== false) queueSync(key, value, ts);
    },

    remove(key) {
      localStorage.removeItem(phys(key));
      const ts = Date.now();
      localStorage.setItem(metaKey(key), String(ts));
      queueSync(key, null, ts); // null = gelöscht (Tombstone für andere Geräte)
    },

    getJSON(key, fallback = null) {
      const raw = this.get(key);
      if (raw === null || raw === undefined) return fallback;
      try { return JSON.parse(raw); } catch (e) { return fallback; }
    },

    setJSON(key, obj, opts) { this.set(key, JSON.stringify(obj), opts); },

    flush: flushSync,

    // Lokaler Profil-Wechsel (nur ohne Server-Login sinnvoll — bei Basic Auth
    // wechselt man das Profil durch Anmelden mit anderen Zugangsdaten).
    switchLocalProfile(name) {
      localStorage.setItem('active_profile_local', name);
      location.reload();
    },

    init() {
      if (state._initPromise) return state._initPromise;
      state._initPromise = doInit();
      return state._initPromise;
    }
  };

  function migrateLegacy() {
    const flag = `p_${state.profile}___migrated`;
    if (localStorage.getItem(flag)) return;

    const allKeys = [];
    for (let i = 0; i < localStorage.length; i++) allKeys.push(localStorage.key(i));

    const copyIfLegacy = rawKey => {
      const val = localStorage.getItem(rawKey);
      if (val !== null && localStorage.getItem(phys(rawKey)) === null) {
        api.set(rawKey, val); // logischer Schlüssel == roher Alt-Schlüssel
      }
    };

    LEGACY_KEYS.forEach(k => { if (localStorage.getItem(k) !== null) copyIfLegacy(k); });
    allKeys.forEach(rk => {
      if (rk && !rk.startsWith('p_') && LEGACY_PREFIXES.some(p => rk.startsWith(p))) copyIfLegacy(rk);
    });

    localStorage.setItem(flag, '1');
  }

  async function pullServer() {
    let changed = 0;
    try {
      const data = await apiFetch('/api/settings');
      const settings = data.settings || {};
      Object.entries(settings).forEach(([key, entry]) => {
        const serverTs = entry.updatedAt || 0;
        if (serverTs > localTs(key)) {
          if (entry.value === null) {
            localStorage.removeItem(phys(key));
          } else {
            localStorage.setItem(phys(key),
              typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value));
          }
          localStorage.setItem(metaKey(key), String(serverTs));
          changed++;
        }
      });
    } catch (err) {
      if (!err.unavailable) console.warn('Einstellungen laden fehlgeschlagen:', err);
    }
    return changed;
  }

  // Öffentlicher Pull (periodisch / bei Tab-Fokus, Punkt 6). Dispatcht
  // 'store-updated', wenn ein anderer Gerät etwas geändert hat.
  api.pull = async function () {
    if (state.mode !== 'server') return 0;
    const changed = await pullServer();
    if (changed > 0) {
      try { window.dispatchEvent(new CustomEvent('store-updated', { detail: { changed } })); } catch (e) { /* alt */ }
    }
    return changed;
  };

  async function doInit() {
    try {
      const who = await apiFetch('/api/whoami');
      state.profile = (who.user || 'default').replace(/[^\w.-]/g, '_');
      state.isAdmin = !!who.isAdmin;
      state.profiles = who.profiles || null;
      state.mode = 'server';
    } catch (e) {
      state.profile = localStorage.getItem('active_profile_local') || 'default';
      state.mode = 'local';
    }

    migrateLegacy();
    if (state.mode === 'server') { await pullServer(); flushSync(); }
    state.ready = true;
    try { window.dispatchEvent(new CustomEvent('store-ready', { detail: { profile: state.profile } })); }
    catch (e) { /* ältere Browser */ }
  }

  return api;
})();

if (typeof window !== 'undefined') window.Store = Store;
