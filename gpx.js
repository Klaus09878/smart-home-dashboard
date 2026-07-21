// GPX-Viewer — Logik (ausgelagert aus gpx.html).
// Nutzt lib/core.js (getestete Kernlogik: computeStats, segmentSpeeds,
// computeStreaks, routeCells/routeSimilarity, buildGpxXml, …) und shared.js.

// ============ Aktivitätstypen ============
const ACTIVITY_TYPES = {
  walk: { label: 'Spazieren/Wandern', icon: 'footprints', emoji: '🚶' },
  run:  { label: 'Laufen',            icon: 'flame',      emoji: '🏃' },
  ride: { label: 'Fahrrad',           icon: 'bike',       emoji: '🚴' },
  moto: { label: 'Motorrad',          icon: 'gauge',      emoji: '🏍️' }
};

const state = {
  activities: [], selectedId: null, map: null, trackLayer: null,
  compareLayer: null, compareId: null, speedColor: false, chart: null,
  cloud: 'unknown',
  // Heatmap-Modus (alle Routen übereinander) + Kalender-Monat
  heatmap: false, heatmapLayer: null,
  calMonth: new Date(),
  // Routen-Signaturen-Cache für die Bestzeiten-Erkennung (id → Set)
  cellCache: new Map()
};

// ============ IndexedDB (lokale, dauerhafte Speicherung) ============
const DB_NAME = 'smarthub';
const STORE = 'gpx-activities';

function openDb() {
  return new Promise((resolve, reject) => {
    // v2: Aktivitäten tragen zusätzlich eine uid für den Cloud-Sync
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbRequest(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const dbGetAll = () => dbRequest('readonly', store => store.getAll());
const dbPut = activity => dbRequest('readwrite', store => store.put(activity));
const dbDelete = id => dbRequest('readwrite', store => store.delete(id));

// ============ GPX-Parsing ============
function parseGpx(xmlText, fileName) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Ungültige GPX/XML-Datei');
  }

  // Track-Punkte (Fallback: Routen-Punkte)
  let ptNodes = Array.from(doc.getElementsByTagName('trkpt'));
  if (ptNodes.length === 0) ptNodes = Array.from(doc.getElementsByTagName('rtept'));
  if (ptNodes.length < 2) throw new Error('Keine Track-Punkte gefunden');

  // Kompakt speichern: [lat, lon, ele|null, timestampMs|null]
  const points = ptNodes.map(node => {
    const eleNode = node.getElementsByTagName('ele')[0];
    const timeNode = node.getElementsByTagName('time')[0];
    const ele = eleNode ? parseFloat(eleNode.textContent) : null;
    const t = timeNode ? new Date(timeNode.textContent).getTime() : null;
    return [
      parseFloat(node.getAttribute('lat')),
      parseFloat(node.getAttribute('lon')),
      isNaN(ele) ? null : ele,
      isNaN(t) ? null : t
    ];
  }).filter(p => !isNaN(p[0]) && !isNaN(p[1]));

  const nameNode = doc.getElementsByTagName('name')[0];
  const name = (nameNode ? nameNode.textContent.trim() : '') || fileName.replace(/\.gpx$/i, '');

  return { name, points };
}

// ============ Formatierung ============
const fmtDist = m => m >= 1000 ? `${(m / 1000).toFixed(m >= 100000 ? 0 : 1)} km` : `${Math.round(m)} m`;
const fmtSpeed = v => v === null ? '–' : `${v.toFixed(1)} km/h`;

function fmtDuration(sec) {
  if (sec === null || sec === undefined) return '–';
  const totalMin = Math.round(sec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')} h` : `${m} min`;
}

function fmtDateTime(ms) {
  if (!ms) return 'Datum unbekannt';
  const d = new Date(ms);
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
}

// Lokaler Tages-Schlüssel 'YYYY-MM-DD' (für Kalender & Streaks)
function toLocalDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ============ Upload-Handling ============
async function handleFileInput(event) {
  await importFiles(Array.from(event.target.files));
  event.target.value = '';
}

async function importFiles(files) {
  const gpxFiles = files.filter(f => /\.gpx$/i.test(f.name));
  if (gpxFiles.length === 0) {
    setUploadStatus('Keine .gpx-Dateien erkannt.', true);
    return;
  }

  let imported = 0, failed = 0, lastId = null;
  for (const file of gpxFiles) {
    try {
      const text = await file.text();
      lastId = await importGpxText(text, file.name);
      imported++;
    } catch (err) {
      console.error(`Import von ${file.name} fehlgeschlagen:`, err);
      failed++;
    }
  }

  await refreshActivities();
  if (lastId !== null) selectActivity(lastId);
  setUploadStatus(`${imported} Aktivität(en) importiert${failed ? `, ${failed} fehlgeschlagen` : ''}.`, failed > 0);
}

function genUid() {
  return (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : `uid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Kernimport (auch direkt aufrufbar, z. B. für Tests)
async function importGpxText(xmlText, fileName) {
  const { name, points } = parseGpx(xmlText, fileName);
  // Statistik auf dem vollen Track berechnen, gespeichert wird ausgedünnt
  // (max. 5000 Punkte), um IndexedDB/D1 vor Riesen-Tracks zu schützen.
  const stats = computeStats(points);
  const storedPoints = downsamplePoints(points, 5000);
  const activity = {
    uid: genUid(),
    name,
    type: guessTypeWithHints(storedPoints, stats.avgSpeed),
    points: storedPoints,
    distM: stats.distM,
    totalSec: stats.totalSec,
    movingSec: stats.movingSec,
    avgSpeed: stats.avgSpeed,
    maxSpeed: stats.maxSpeed,
    elevGain: stats.elevGain,
    eleMin: stats.eleMin,
    eleMax: stats.eleMax,
    startTime: stats.startTime,
    note: null,
    startWeather: null,
    addedAt: Date.now(),
    updatedAt: Date.now()
  };
  const localId = await dbPut(activity);
  // Automatisch in die Cloud-Datenbank schreiben (best effort)
  pushActivityToCloud(activity);
  return localId;
}

// ============ Cloud-Sync (/api/gpx → Cloudflare D1) ============
function setCloudStatus(mode) {
  state.cloud = mode;
  const el = document.getElementById('cloud-status');
  if (!el) return;
  const map = {
    ok:    ['Cloud-Sync aktiv', 'text-teal-400'],
    sync:  ['synchronisiere…', 'text-slate-400'],
    local: ['nur lokal (Cloud-DB nicht eingerichtet)', 'text-amber-400'],
    error: ['Sync-Fehler – Daten sind lokal gesichert', 'text-red-400']
  };
  const entry = map[mode] || map.local;
  el.innerText = entry[0];
  el.className = entry[1];
}

function activityToPayload(a) {
  return {
    uid: a.uid, name: a.name, type: a.type, startTime: a.startTime,
    distM: a.distM, totalSec: a.totalSec, movingSec: a.movingSec,
    avgSpeed: a.avgSpeed, maxSpeed: a.maxSpeed, elevGain: a.elevGain,
    eleMin: a.eleMin, eleMax: a.eleMax, addedAt: a.addedAt,
    updatedAt: a.updatedAt || a.addedAt || Date.now(),
    note: a.note || null,
    startWeather: a.startWeather || null,
    // Sicherheitsnetz für Alt-Bestände, die noch ungedrosselt gespeichert wurden
    points: downsamplePoints(a.points, 5000)
  };
}

// ============ Lösch-Queue: Tombstones auch offline zuverlässig propagieren ============
function getPendingDeletes() {
  try { return JSON.parse(localStorage.getItem('gpx_pending_deletes') || '[]'); }
  catch (e) { return []; }
}
function setPendingDeletes(list) {
  localStorage.setItem('gpx_pending_deletes', JSON.stringify(list));
}
function addPendingDelete(uid) {
  const list = getPendingDeletes();
  if (!list.includes(uid)) { list.push(uid); setPendingDeletes(list); }
}
function removePendingDelete(uid) {
  setPendingDeletes(getPendingDeletes().filter(u => u !== uid));
}

async function pushActivityToCloud(activity) {
  if (state.cloud === 'local') return;
  try {
    await apiFetch('/api/gpx', { method: 'POST', body: JSON.stringify(activityToPayload(activity)), timeoutMs: 30000 });
    setCloudStatus('ok');
  } catch (err) {
    if (err.unavailable) setCloudStatus('local');
    else { setCloudStatus('error'); console.warn('Cloud-Upload fehlgeschlagen:', err); }
  }
}

// Zwei-Wege-Abgleich mit Tombstones (Löschungen) und Meta-Reconcile
// (Name/Typ/Notiz: neuerer updatedAt gewinnt, egal auf welchem Gerät geändert).
async function syncWithCloud() {
  setCloudStatus('sync');
  try {
    // Alt-Bestände ohne uid/updatedAt nachrüsten
    for (const a of state.activities) {
      let dirty = false;
      if (!a.uid) { a.uid = genUid(); dirty = true; }
      if (!a.updatedAt) { a.updatedAt = a.addedAt || Date.now(); dirty = true; }
      if (dirty) await dbPut(a);
    }

    // 1) Ausstehende Löschungen zuerst propagieren
    for (const uid of getPendingDeletes()) {
      await apiFetch(`/api/gpx?uid=${encodeURIComponent(uid)}`, { method: 'DELETE' });
      removePendingDelete(uid);
    }

    // 2) Abgleich anhand der Server-Liste (enthält auch Tombstones)
    const serverList = await apiFetch('/api/gpx');
    const serverByUid = new Map(serverList.map(s => [s.uid, s]));
    let changed = false;

    for (const s of serverList) {
      const local = state.activities.find(a => a.uid === s.uid);

      if (s.deleted) {
        // Tombstone: auf allen Geräten löschen
        if (local) { await dbDelete(local.id); changed = true; }
        continue;
      }

      if (!local) {
        const full = await apiFetch(`/api/gpx?uid=${encodeURIComponent(s.uid)}`);
        delete full.id;
        await dbPut(full);
        changed = true;
      } else if (s.name !== local.name || s.type !== local.type || (s.note || null) !== (local.note || null)) {
        const serverUpd = s.updatedAt || 0;
        const localUpd = local.updatedAt || local.addedAt || 0;
        if (serverUpd > localUpd) {
          local.name = s.name;
          local.type = s.type;
          local.note = s.note || null;
          local.updatedAt = serverUpd;
          await dbPut(local);
          changed = true;
        } else {
          await apiFetch('/api/gpx', {
            method: 'PUT',
            body: JSON.stringify({ uid: local.uid, name: local.name, type: local.type, note: local.note || null, updatedAt: localUpd })
          });
        }
      }
    }

    // 3) Lokale Aktivitäten hochladen, die dem Server fehlen
    for (const a of state.activities) {
      if (!serverByUid.has(a.uid)) {
        await apiFetch('/api/gpx', { method: 'POST', body: JSON.stringify(activityToPayload(a)) });
      }
    }

    if (changed) await refreshActivities();
    setCloudStatus('ok');
  } catch (err) {
    setCloudStatus(err.unavailable ? 'local' : 'error');
    if (!err.unavailable) console.warn('Cloud-Sync fehlgeschlagen:', err);
  }
}

// ============ Backup: Export/Import als JSON-Datei ============
async function exportBackup() {
  const activities = await dbGetAll();
  // Einstellungen des aktiven Profils als LOGISCHE Schlüssel sichern (kein
  // p_<profil>_-Präfix, keine Meta) — beim Restore laufen sie über Store und
  // werden mit-synchronisiert (Punkt 3).
  const settings = {};
  const prefix = `p_${Store.profile}_`;
  Object.keys(localStorage).forEach(k => {
    if (k.startsWith(prefix) && !k.endsWith('__ts') && !k.endsWith('___migrated')) {
      settings[k.slice(prefix.length)] = localStorage.getItem(k);
    }
  });
  const backup = {
    format: 'smarthub-backup',
    version: 3,
    exportedAt: new Date().toISOString(),
    settings,
    activities
  };

  // Fotos pro Tour mitsichern (P2-4), sofern R2 aktiv — auf Nachfrage, weil
  // base64-Bilder die Datei stark vergroessern.
  const withUid = activities.filter(a => a.uid);
  if (withUid.length && await photosAvailable()) {
    const withPhotos = await modalConfirm({
      title: 'Fotos mitsichern?',
      message: 'Foto-Anhänge der Touren als base64 einbetten. Das macht die Backup-Datei deutlich größer.',
      confirmLabel: 'Ja, mit Fotos'
    });
    if (withPhotos) {
      setUploadStatus('Fotos werden gesammelt…');
      const photos = {};
      for (const a of withUid) {
        try {
          const data = await apiFetch(`/api/photos?uid=${encodeURIComponent(a.uid)}`);
          const list = (data && data.photos) || [];
          if (!list.length) continue;
          const out = [];
          for (const p of list) {
            const blob = await fetch(p.url).then(r => r.ok ? r.blob() : null).catch(() => null);
            if (!blob) continue;
            const dataUrl = await new Promise(res => {
              const fr = new FileReader();
              fr.onload = () => res(fr.result);
              fr.onerror = () => res(null);
              fr.readAsDataURL(blob);
            });
            if (dataUrl) out.push({ n: p.n, dataUrl });
          }
          if (out.length) photos[a.uid] = out;
        } catch (e) { /* Tour ohne Fotos oder R2 aus */ }
      }
      if (Object.keys(photos).length) backup.photos = photos;
    }
  }

  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `smarthub-backup-${new Date().toISOString().substring(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  const nPhotos = backup.photos ? Object.values(backup.photos).reduce((s, l) => s + l.length, 0) : 0;
  setUploadStatus(`Backup mit ${activities.length} Aktivität(en)${nPhotos ? ` und ${nPhotos} Foto(s)` : ''} heruntergeladen.`);
}

// Sind Foto-Anhaenge verfuegbar (R2 + Endpunkt)? Ergebnis wird gecached
// (_photosSupported aus dem Foto-Modul, Plan-10b).
async function photosAvailable() {
  if (_photosSupported !== null) return _photosSupported;
  const first = state.activities.find(a => a.uid);
  if (!first) return false;
  try { await apiFetch(`/api/photos?uid=${encodeURIComponent(first.uid)}`); _photosSupported = true; }
  catch (e) { _photosSupported = false; }
  return _photosSupported;
}

async function handleRestoreInput(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    if (backup.format !== 'smarthub-backup' || !Array.isArray(backup.activities)) {
      throw new Error('Kein gültiges Smart-Home-Hub-Backup');
    }
    const existingUids = new Set(state.activities.map(a => a.uid));
    let restored = 0;
    for (const a of backup.activities) {
      if (a.uid && existingUids.has(a.uid)) continue; // Duplikate überspringen
      delete a.id; // neue lokale ID vergeben lassen
      if (!a.uid) a.uid = genUid();
      if (!a.updatedAt) a.updatedAt = a.addedAt || Date.now();
      a.points = downsamplePoints(a.points, 5000);
      await dbPut(a);
      restored++;
    }
    if (backup.settings) {
      // Über Store einspielen → landet in der D1-Sync-Queue (Punkt 3).
      // Alt-Backups (v1) trugen physische p_<profil>_-Schlüssel → auf den
      // logischen Teil reduzieren.
      Object.entries(backup.settings).forEach(([k, v]) => {
        const logical = k.startsWith('p_') ? k.replace(/^p_[^_]*_/, '') : k;
        if (logical && !logical.endsWith('__ts') && !logical.endsWith('__migrated')) Store.set(logical, v);
      });
    }
    // Fotos wiederherstellen (P2-4), sofern im Backup und R2 aktiv
    let photoCount = 0;
    if (backup.photos && await photosAvailable()) {
      setUploadStatus('Fotos werden hochgeladen…');
      for (const [uid, list] of Object.entries(backup.photos)) {
        for (const p of (list || [])) {
          try {
            const blob = await fetch(p.dataUrl).then(r => r.blob());
            const res = await fetch(`/api/photos?uid=${encodeURIComponent(uid)}&n=${p.n}`, {
              method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: blob
            });
            if (res.ok) photoCount++;
          } catch (e) { /* einzelnes Foto ueberspringen */ }
        }
      }
    }

    await refreshActivities();
    if (state.activities.length > 0 && state.selectedId === null) selectActivity(state.activities[0].id);
    syncWithCloud();
    setUploadStatus(`Backup eingespielt: ${restored} neue Aktivität(en)${photoCount ? `, ${photoCount} Foto(s)` : ''}, Einstellungen übernommen.`);
  } catch (err) {
    console.error('Restore fehlgeschlagen:', err);
    setUploadStatus('Backup konnte nicht gelesen werden.', true);
  }
}

function setUploadStatus(msg, isError = false) {
  const el = document.getElementById('upload-status');
  el.innerText = msg;
  el.className = `text-xs mt-2 ${isError ? 'text-amber-400' : 'text-teal-400'}`;
  setTimeout(() => el.classList.add('hidden'), 6000);
  el.classList.remove('hidden');
}

// Drag & Drop
const dropzone = document.getElementById('dropzone');
['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, e => {
  e.preventDefault();
  dropzone.classList.add('dragover');
}));
['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, e => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
}));
dropzone.addEventListener('drop', e => importFiles(Array.from(e.dataTransfer.files)));

// ============ Liste & Auswahl ============
async function refreshActivities() {
  state.activities = (await dbGetAll()).sort((a, b) => (b.startTime || b.addedAt) - (a.startTime || a.addedAt));
  state.cellCache.clear();
  document.getElementById('activity-count').innerText = state.activities.length;
  document.getElementById('main-area').classList.toggle('hidden', state.activities.length === 0);
  renderSummary();
  renderActivityList();
  renderCalendar();
}

// ============ Jahres-/Wochenziele (localStorage) ============
function getGoals() {
  const g = Store.getJSON('gpx_goals', null);
  if (g && typeof g === 'object') return { yearKm: g.yearKm || 0, weekKm: g.weekKm || 0 };
  return { yearKm: 0, weekKm: 0 };
}

async function editGoals() {
  const g = getGoals();
  const vals = await modalPrompt({
    title: 'GPX-Ziele',
    fields: [
      { key: 'yearKm', label: 'Jahresziel in km (0 = kein Ziel)', type: 'number', value: g.yearKm || 0 },
      { key: 'weekKm', label: 'Wochenziel in km (0 = kein Ziel)', type: 'number', value: g.weekKm || 0 }
    ]
  });
  if (!vals) return;
  const yearKm = Math.max(0, parseFloat(String(vals.yearKm).replace(',', '.')) || 0);
  const weekKm = Math.max(0, parseFloat(String(vals.weekKm).replace(',', '.')) || 0);
  Store.setJSON('gpx_goals', { yearKm, weekKm });
  renderSummary();
  showToast('Ziele gespeichert.');
}

function renderGoalBar(barId, labelId, wrapId, doneKm, goalKm) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  if (!goalKm || goalKm <= 0) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  const pct = Math.min(100, (doneKm / goalKm) * 100);
  document.getElementById(barId).style.width = `${pct}%`;
  document.getElementById(labelId).innerText = `${doneKm.toFixed(doneKm >= 100 ? 0 : 1)} / ${goalKm} km (${Math.round(pct)} %)`;
}

// Gesamt-Statistik über alle Aktivitäten (+ Zielfortschritt)
function renderSummary() {
  const km = arr => arr.reduce((sum, a) => sum + (a.distM || 0), 0) / 1000;
  const now = Date.now();
  const weekActs = state.activities.filter(a => (a.startTime || a.addedAt) >= now - 7 * 24 * 60 * 60 * 1000);
  const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime();
  const yearActs = state.activities.filter(a => (a.startTime || a.addedAt) >= yearStart);

  document.getElementById('sum-total').innerText = `${km(state.activities).toFixed(km(state.activities) >= 100 ? 0 : 1)} km`;
  document.getElementById('sum-week').innerText = `${km(weekActs).toFixed(1)} km`;
  document.getElementById('sum-year').innerText = `${km(yearActs).toFixed(km(yearActs) >= 100 ? 0 : 1)} km`;

  const goals = getGoals();
  const yearKmDone = km(yearActs);
  renderGoalBar('goal-week-bar', 'goal-week-label', 'goal-week-wrap', km(weekActs), goals.weekKm);
  renderGoalBar('goal-year-bar', 'goal-year-label', 'goal-year-wrap', yearKmDone, goals.yearKm);
  const hint = document.getElementById('goal-empty-hint');
  if (hint) hint.classList.toggle('hidden', !!(goals.weekKm || goals.yearKm));

  renderRecords();

  // Zielprognose (Plan4-18)
  const fcEl = document.getElementById('goal-year-forecast');
  if (fcEl) {
    const fc = goalForecast({ goalKm: goals.yearKm, doneKm: yearKmDone });
    if (fc) {
      const proj = fc.projectedKm.toLocaleString('de-DE', { maximumFractionDigits: 0 });
      fcEl.innerText = fc.onTrack
        ? `Prognose: ~${proj} km · auf Kurs ✅`
        : `Prognose: ~${proj} km · ~${fc.requiredPerWeekKm.toLocaleString('de-DE', { maximumFractionDigits: 0 })} km/Woche nötig`;
    } else {
      fcEl.innerText = '';
    }
  }
}

// Persoenliche Rekorde (Plan4-19): aus den Aktivitaeten, klickbar zur Tour.
function renderRecords() {
  const el = document.getElementById('gpx-records');
  if (!el) return;
  const adapted = state.activities.map(a => ({
    id: a.id, name: a.name, startMs: a.startTime || a.addedAt,
    distanceKm: (a.distM || 0) / 1000, movingSec: a.movingSec || 0, ascent: a.elevGain || 0
  }));
  const rec = personalRecords(adapted);
  // Lucide-Icons statt Emojis (Plan6-4, design.md: keine Emojis als UI-Sprache)
  const items = [
    { icon: 'award', title: 'Längste Tour', r: rec.longest },
    { icon: 'mountain', title: 'Meiste Höhenmeter', r: rec.mostAscent },
    { icon: 'zap', title: 'Schnellster Schnitt', r: rec.fastest },
    { icon: 'flame', title: 'Stärkste Woche', r: rec.biggestWeek }
  ].filter(it => it.r);
  if (!items.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = '';
  items.forEach(it => {
    const card = document.createElement('div');
    card.className = 'bg-slate-900/60 border border-slate-800/60 rounded-xl p-2' + (it.r.id ? ' cursor-pointer hover:border-slate-600 transition-colors' : '');
    card.innerHTML = `<p class="text-[10px] text-slate-500 uppercase font-semibold flex items-center gap-1"><i data-lucide="${it.icon}" class="w-3 h-3"></i> ${it.title}</p>`
      + `<p class="text-sm font-bold text-white mt-0.5 font-mono tabular-nums">${it.r.label}</p>`
      + `<p class="text-[10px] text-slate-400 truncate">${escapeHtml(it.r.name || '')}</p>`;
    if (it.r.id) card.onclick = () => selectActivity(it.r.id);
    el.appendChild(card);
  });
  updateIcons();
}

// ============ Kalender & Streaks ============
function changeCalMonth(delta) {
  state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + delta, 1);
  renderCalendar();
}

function renderCalendar() {
  const grid = document.getElementById('cal-grid');
  const title = document.getElementById('cal-title');
  const streakEl = document.getElementById('cal-streak');
  if (!grid || !title) return;

  const activityDays = new Set(
    state.activities.filter(a => a.startTime).map(a => toLocalDayKey(a.startTime))
  );

  // Streak-Zeile
  if (streakEl) {
    const { current, longest } = computeStreaks([...activityDays], toLocalDayKey(Date.now()));
    streakEl.innerHTML = current > 0
      ? `Aktuelle Serie: <strong class="text-white">${current} Tag${current === 1 ? '' : 'e'}</strong> · Längste: ${longest}`
      : `Aktuelle Serie: 0 Tage${longest > 0 ? ` · Längste: ${longest}` : ''}`;
  }

  const y = state.calMonth.getFullYear();
  const m = state.calMonth.getMonth();
  title.innerText = state.calMonth.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });

  const firstDay = new Date(y, m, 1);
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const offset = (firstDay.getDay() + 6) % 7; // Montag = 0
  const todayKey = toLocalDayKey(Date.now());

  grid.innerHTML = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
    .map(d => `<div class="text-[9px] text-slate-500 font-semibold text-center">${d}</div>`).join('');
  for (let i = 0; i < offset; i++) grid.innerHTML += '<div></div>';
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const isActive = activityDays.has(key);
    const isToday = key === todayKey;
    grid.innerHTML += `<div class="aspect-square flex items-center justify-center rounded-md text-[10px] ${
      isActive ? 'bg-orange-500/25 text-orange-200 font-bold border border-orange-500/40'
        : isToday ? 'border border-slate-600 text-slate-300'
        : 'text-slate-500'
    }" title="${key}${isActive ? ' · Aktivität' : ''}">${day}</div>`;
  }
}

function renderActivityList() {
  const list = document.getElementById('activity-list');
  list.innerHTML = '';

  // Leerzustand (Plan4-22): statt leerer Flaeche ein Hinweis, was zu tun ist.
  if (state.activities.length === 0) {
    list.innerHTML = emptyStateHtml({
      icon: 'route',
      text: 'Noch keine Touren — GPX-Datei hierher ziehen oder eine Aufzeichnung starten.'
    });
    updateIcons();
    return;
  }

  state.activities.forEach(act => {
    const type = ACTIVITY_TYPES[act.type] || ACTIVITY_TYPES.ride;
    const isActive = act.id === state.selectedId;
    const btn = document.createElement('button');
    btn.className = `w-full text-left p-3 rounded-xl border transition-all flex items-center gap-3 ${
      isActive ? 'bg-orange-500/10 border-orange-500/30' : 'bg-slate-900/40 border-slate-800/60 hover:border-slate-700'
    }`;
    btn.innerHTML = `
      <div class="w-9 h-9 rounded-lg ${isActive ? 'bg-orange-500/20 text-orange-300' : 'bg-slate-800/80 text-slate-400'} flex items-center justify-center shrink-0">
        <i data-lucide="${type.icon}" class="w-4.5 h-4.5"></i>
      </div>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold ${isActive ? 'text-white' : 'text-slate-200'} truncate">${escapeHtml(act.name)}</p>
        <p class="text-[11px] text-slate-500">${act.startTime ? new Date(act.startTime).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '–'} · ${fmtDist(act.distM)} · ${fmtDuration(act.movingSec || act.totalSec)}</p>
      </div>
    `;
    btn.onclick = () => selectActivity(act.id);
    list.appendChild(btn);
  });
  updateIcons();
}

function selectActivity(id) {
  state.selectedId = id;
  renderActivityList();
  const act = state.activities.find(a => a.id === id);
  if (act) renderDetail(act);
}

// ============ Detail: Karte, Stats, Höhenprofil ============
function renderDetail(act) {
  const type = ACTIVITY_TYPES[act.type] || ACTIVITY_TYPES.ride;

  document.getElementById('detail-name').innerText = act.name;
  document.getElementById('detail-date').innerText = fmtDateTime(act.startTime);
  document.getElementById('detail-type').value = act.type;
  document.getElementById('detail-icon').innerHTML = `<i data-lucide="${type.icon}" class="w-5 h-5"></i>`;

  document.getElementById('stat-dist').innerText = fmtDist(act.distM);
  document.getElementById('stat-duration').innerText = fmtDuration(act.movingSec || act.totalSec);
  document.getElementById('stat-avg').innerText = fmtSpeed(act.avgSpeed);
  document.getElementById('stat-max').innerText = fmtSpeed(act.maxSpeed);
  document.getElementById('stat-gain').innerText = act.elevGain !== null ? `${act.elevGain} m` : '–';
  document.getElementById('stat-ele').innerText = act.eleMin !== null ? `${Math.round(act.eleMin)}–${Math.round(act.eleMax)} m` : '–';

  renderNoteAndWeather(act);
  renderPhotos(act);
  renderRouteMatches(act);
  updateCompareSelect();
  drawMap(act);
  drawElevationChart(act);
  updateIcons();
}

// ============ Notiz & Start-Wetter (P14) ============
function renderNoteAndWeather(act) {
  const noteEl = document.getElementById('detail-note');
  if (noteEl) noteEl.value = act.note || '';

  const weatherEl = document.getElementById('detail-weather');
  if (!weatherEl) return;
  if (act.startWeather && act.startWeather.temp !== null && act.startWeather.temp !== undefined) {
    weatherEl.innerHTML = `<i data-lucide="cloud-sun" class="w-3.5 h-3.5 inline"></i> Beim Start: ${act.startWeather.temp.toFixed(1)} °C · ${getWeatherDescription(act.startWeather.code)}`;
    weatherEl.classList.remove('hidden');
  } else {
    weatherEl.classList.add('hidden');
    fetchStartWeather(act); // best effort, aktualisiert die Anzeige nachträglich
  }
}

// ============ Fotos pro Tour (P10b, R2) ============
// Braucht Cloud-Sync (uid) + R2-Binding (/api/photos). Ohne beides bleibt die
// Foto-UI ausgeblendet. Bilder werden vor dem Upload lokal auf WebP verkleinert.
let _photosSupported = null;

async function renderPhotos(act) {
  const block = document.getElementById('photos-block');
  const grid = document.getElementById('detail-photos');
  const hint = document.getElementById('photo-hint');
  const addBtn = document.getElementById('photo-add-btn');
  if (!block || !grid) return;
  if (!act.uid) { block.classList.add('hidden'); return; } // erst nach Cloud-Sync moeglich

  let data;
  try { data = await apiFetch(`/api/photos?uid=${encodeURIComponent(act.uid)}`); }
  catch (e) { _photosSupported = false; block.classList.add('hidden'); return; }
  _photosSupported = true;
  block.classList.remove('hidden');

  const photos = (data && data.photos) || [];
  grid.dataset.usedN = JSON.stringify(photos.map(p => p.n));
  grid.innerHTML = '';
  photos.forEach(p => {
    const cell = document.createElement('div');
    cell.className = 'relative aspect-square rounded-lg overflow-hidden group/photo bg-slate-900';
    cell.innerHTML = `<img src="${p.url}" alt="Tour-Foto" class="w-full h-full object-cover cursor-pointer" loading="lazy">
      <button title="Foto löschen" class="absolute top-1 right-1 p-1 rounded bg-slate-950/70 text-slate-300 hover:text-red-400 opacity-0 group-hover/photo:opacity-100 transition-opacity"><i data-lucide="trash-2" class="w-3 h-3"></i></button>`;
    cell.querySelector('img').addEventListener('click', () => openPhotoLightbox(p.url));
    cell.querySelector('button').addEventListener('click', () => deleteTourPhoto(act, p.n));
    grid.appendChild(cell);
  });
  if (addBtn) addBtn.classList.toggle('hidden', photos.length >= 5);
  if (hint) hint.textContent = photos.length >= 5 ? 'Maximal 5 Fotos pro Tour.' : `${photos.length}/5 Fotos · max. 500 KB pro Bild.`;
  renderPhotoMarkers(photos);
  updateIcons();
}

// Foto-Marker mit Geotag auf der Tourkarte (P2-15). Wird nach dem Kartenaufbau
// (drawMap) aufgerufen; entfernt vorherige Marker.
function renderPhotoMarkers(photos) {
  if (!state.map) return;
  if (state.photoMarkers) { state.map.removeLayer(state.photoMarkers); state.photoMarkers = null; }
  const geo = (photos || []).filter(p => p.lat != null && p.lon != null);
  if (!geo.length) return;
  const icon = L.divIcon({
    className: '',
    html: '<div style="background:#0f172a;border:2px solid #14b8a6;border-radius:9999px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;color:#5eead4;box-shadow:0 1px 4px rgba(0,0,0,.5)">📷</div>',
    iconSize: [26, 26], iconAnchor: [13, 13]
  });
  const markers = geo.map(p => {
    const m = L.marker([p.lat, p.lon], { icon });
    m.bindPopup(`<img src="${p.url}" alt="Foto" style="max-width:200px;max-height:200px;border-radius:8px;cursor:pointer" data-onclick="openPhotoLightbox|${p.url}">`);
    return m;
  });
  state.photoMarkers = L.layerGroup(markers).addTo(state.map);
}

// Bild lokal auf max. Kantenlaenge verkleinern und als WebP-Blob liefern.
function resizeImageToWebp(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let width = img.naturalWidth, height = img.naturalHeight;
      if (Math.max(width, height) > maxDim) {
        const s = maxDim / Math.max(width, height);
        width = Math.round(width * s); height = Math.round(height * s);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(img.src);
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('Komprimierung fehlgeschlagen')), 'image/webp', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('Bild konnte nicht gelesen werden')); };
    img.src = URL.createObjectURL(file);
  });
}

// EXIF-GPS eines Bildes lesen (vor dem Resize, der EXIF verwirft) — P2-15.
async function exifGps(file) {
  try {
    if (typeof exifr !== 'undefined' && exifr.gps) {
      const g = await exifr.gps(file);
      if (g && typeof g.latitude === 'number' && typeof g.longitude === 'number') return { lat: g.latitude, lon: g.longitude };
    }
  } catch (e) { /* kein GPS im Foto */ }
  return null;
}

// Ein Foto (auf WebP verkleinert) unter Nummer n zu einer Tour hochladen.
// Gemeinsam genutzt von uploadTourPhoto und der Aufzeichnungs-Queue (P3-9).
async function uploadPhotoBlob(uid, file, gps, n) {
  let blob = await resizeImageToWebp(file, 1600, 0.8);
  if (blob.size > 500 * 1024) blob = await resizeImageToWebp(file, 1200, 0.7);
  if (blob.size > 500 * 1024) throw new Error('Foto auch komprimiert zu groß');
  const geo = gps ? `&lat=${gps.lat}&lon=${gps.lon}` : '';
  const res = await fetch(`/api/photos?uid=${encodeURIComponent(uid)}&n=${n}${geo}`, {
    method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: blob
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function uploadTourPhoto(event) {
  const file = event.target.files[0];
  event.target.value = '';
  const act = state.activities.find(a => a.id === state.selectedId);
  if (!file || !act || !act.uid) return;
  try {
    const gps = await exifGps(file);
    const used = JSON.parse((document.getElementById('detail-photos').dataset.usedN) || '[]');
    let n = 0; while (used.includes(n) && n < 5) n++;
    if (n >= 5) { showToast('Maximal 5 Fotos pro Tour.', 'error'); return; }
    await uploadPhotoBlob(act.uid, file, gps, n);
    await renderPhotos(act);
    showToast('Foto hinzugefügt.', 'success');
  } catch (e) {
    showToast('Foto-Upload fehlgeschlagen (nur online möglich).', 'error');
  }
}

async function deleteTourPhoto(act, n) {
  const ok = await modalConfirm({ title: 'Foto löschen?', message: 'Dieses Foto wird endgültig entfernt.', confirmLabel: 'Löschen', danger: true });
  if (!ok) return;
  try {
    await apiFetch(`/api/photos?uid=${encodeURIComponent(act.uid)}&n=${n}`, { method: 'DELETE' });
    await renderPhotos(act);
  } catch (e) { showToast('Löschen fehlgeschlagen.', 'error'); }
}

function openPhotoLightbox(url) {
  const lb = document.getElementById('photo-lightbox');
  const img = document.getElementById('photo-lightbox-img');
  if (!lb || !img) return;
  img.src = url;
  lb.classList.remove('hidden');
}
function closePhotoLightbox() {
  const lb = document.getElementById('photo-lightbox');
  if (lb) lb.classList.add('hidden');
}

// ============ Live-Aufzeichnung (P2-13) ============
// Zeichnet eine Tour direkt im Browser per Geolocation auf. Punkte im selben
// Format wie der Datei-Import: [lat, lon, ele|null, timestampMs]. Roh-Puffer in
// localStorage (geraetelokal) fuer Crash-Recovery.
function toggleRecording() {
  if (state.rec && state.rec.active) stopRecording(); else startRecording();
}

async function startRecording() {
  if (!('geolocation' in navigator)) { setUploadStatus('Kein GPS auf diesem Gerät verfügbar.', true); return; }
  state.rec = { active: true, paused: false, points: [], photos: [], startMs: Date.now(), lastSave: 0, lastLive: 0, lastFixMs: Date.now(), wakeLock: null };
  try { if (navigator.wakeLock) state.rec.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* Wake Lock optional */ }
  state.rec.watchId = navigator.geolocation.watchPosition(onRecFix, onRecErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  state.rec.timer = setInterval(updateRecordingUI, 1000);
  updateRecordingUI();
  showToast('Aufzeichnung läuft. Bildschirm anlassen — iOS pausiert GPS bei gesperrtem Display.', 'info');
}

// Pause / Weiter (P3-9): Pause stoppt nur die Punkte-Sammlung, Wake Lock bleibt.
function togglePauseRecording() {
  const r = state.rec;
  if (!r || !r.active) return;
  if (r.paused) {
    r.paused = false;
    r.lastFixMs = Date.now();
    r.watchId = navigator.geolocation.watchPosition(onRecFix, onRecErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  } else {
    r.paused = true;
    if (r.watchId != null) navigator.geolocation.clearWatch(r.watchId);
    r.watchId = null;
  }
  updateRecordingUI();
}

// Foto waehrend der Aufnahme (P3-9): Geotag = aktuelle Position, sonst EXIF.
function recordPhoto() {
  if (!state.rec || !state.rec.active) { showToast('Nur während einer Aufzeichnung.', 'error'); return; }
  const inp = document.getElementById('rec-photo-input');
  if (inp) inp.click();
}
async function onRecPhotoPicked(event) {
  const file = event.target.files[0];
  event.target.value = '';
  const r = state.rec;
  if (!file || !r) return;
  const last = r.points[r.points.length - 1];
  const gps = last ? { lat: last[0], lon: last[1] } : await exifGps(file);
  r.photos = r.photos || [];
  if (r.photos.length >= 5) { showToast('Maximal 5 Fotos pro Tour.', 'error'); return; }
  r.photos.push({ file, gps });
  showToast(`Foto vorgemerkt (${r.photos.length}).`, 'success');
}

// Wake Lock nach Tab-Wechsel erneut anfordern (wird beim Verstecken freigegeben)
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.rec && state.rec.active && navigator.wakeLock && !state.rec.wakeLock) {
    try { state.rec.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* egal */ }
  } else if (document.visibilityState === 'hidden' && state.rec) {
    state.rec.wakeLock = null; // wird vom System freigegeben
  }
});

function onRecFix(pos) {
  const r = state.rec;
  if (!r || !r.active || r.paused) return;
  const c = pos.coords;
  r.lastFixMs = Date.now(); // fuer den Stillstands-Hinweis
  if (c.accuracy != null && c.accuracy > 50) return; // ungenaue Fixes verwerfen
  const pt = [c.latitude, c.longitude, (c.altitude != null && !isNaN(c.altitude)) ? c.altitude : null, Date.now()];
  const last = r.points[r.points.length - 1];
  if (last && haversine(last[0], last[1], pt[0], pt[1]) < 2) return; // Stillstand-Rauschen filtern
  r.points.push(pt);
  const now = Date.now();
  if (now - r.lastSave > 30000) { r.lastSave = now; try { localStorage.setItem('gpx_rec_buffer', JSON.stringify(r.points)); } catch (e) { /* Quota egal */ } }
  if (state.map && now - r.lastLive > 5000) { r.lastLive = now; drawLivePolyline(); }
  updateRecordingUI();
}

function onRecErr(err) { console.warn('GPS-Fehler bei der Aufzeichnung:', err && err.message); }

function drawLivePolyline() {
  const r = state.rec;
  if (!r || !state.map || r.points.length < 2) return;
  const latlngs = r.points.map(p => [p[0], p[1]]);
  if (state.recLiveLayer) state.recLiveLayer.setLatLngs(latlngs);
  else state.recLiveLayer = L.polyline(latlngs, { color: '#f43f5e', weight: 4, opacity: 0.9 }).addTo(state.map);
}

function updateRecordingUI() {
  const btn = document.getElementById('record-btn');
  const bar = document.getElementById('record-status');
  const stats = document.getElementById('record-stats');
  const label = document.getElementById('record-label');
  const pauseBtn = document.getElementById('record-pause-btn');
  const r = state.rec;
  const active = !!(r && r.active);
  if (btn) btn.classList.toggle('text-rose-400', active);
  if (bar) bar.classList.toggle('hidden', !active);
  if (!active) return;
  const dur = Math.floor((Date.now() - r.startMs) / 1000);
  const dist = r.points.length > 1 ? computeStats(r.points).distM : 0;
  const still = !r.paused && r.lastFixMs && (Date.now() - r.lastFixMs > 90000);
  if (stats) stats.textContent = `${fmtDuration(dur)} · ${fmtDist(dist)} · ${r.points.length} Punkte${still ? ' · steht still' : ''}`;
  if (label) label.innerHTML = r.paused
    ? '<span class="w-2.5 h-2.5 rounded-full bg-amber-500"></span> Pausiert'
    : '<span class="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse"></span> Aufzeichnung läuft';
  if (pauseBtn) pauseBtn.textContent = r.paused ? 'Weiter' : 'Pause';
}

async function stopRecording() {
  const r = state.rec;
  if (!r) return;
  r.active = false;
  if (r.watchId != null) navigator.geolocation.clearWatch(r.watchId);
  if (r.timer) clearInterval(r.timer);
  if (r.wakeLock) { try { await r.wakeLock.release(); } catch (e) { /* egal */ } }
  if (state.recLiveLayer && state.map) { state.map.removeLayer(state.recLiveLayer); state.recLiveLayer = null; }
  const points = r.points;
  const photos = r.photos || [];
  state.rec = null;
  localStorage.removeItem('gpx_rec_buffer');
  updateRecordingUI();
  if (points.length < 10) { setUploadStatus('Zu wenige GPS-Punkte — Aufzeichnung verworfen.', true); return; }
  await saveRecordedActivity(points, `Aufzeichnung ${new Date().toLocaleDateString('de-DE')}`, photos);
}

// Aufgezeichnete Punkte als Aktivitaet speichern (gleiche Struktur wie Import).
async function saveRecordedActivity(points, name, photos) {
  const stats = computeStats(points);
  const storedPoints = downsamplePoints(points, 5000);
  const activity = {
    uid: genUid(),
    name,
    type: guessTypeWithHints(storedPoints, stats.avgSpeed),
    points: storedPoints,
    distM: stats.distM, totalSec: stats.totalSec, movingSec: stats.movingSec,
    avgSpeed: stats.avgSpeed, maxSpeed: stats.maxSpeed,
    elevGain: stats.elevGain, eleMin: stats.eleMin, eleMax: stats.eleMax,
    startTime: stats.startTime, note: null, startWeather: null,
    addedAt: Date.now(), updatedAt: Date.now()
  };
  const localId = await dbPut(activity);
  pushActivityToCloud(activity);
  await refreshActivities();
  if (localId != null) selectActivity(localId);
  showToast(`Tour gespeichert: ${fmtDist(stats.distM)}.`, 'success');

  // Waehrend der Aufnahme vorgemerkte Fotos hochladen (P3-9)
  if (photos && photos.length && await photosAvailable()) {
    let ok = 0;
    for (let n = 0; n < photos.length && n < 5; n++) {
      try { await uploadPhotoBlob(activity.uid, photos[n].file, photos[n].gps, n); ok++; } catch (e) { /* einzelnes Foto */ }
    }
    if (ok) { showToast(`${ok} Foto(s) hochgeladen.`, 'success'); const a = state.activities.find(x => x.uid === activity.uid); if (a) renderPhotos(a); }
    else showToast('Fotos konnten nicht hochgeladen werden (R2 fehlt?).', 'error');
  }
}

// Nach einem Absturz/Reload waehrend der Aufnahme anbieten, den Puffer zu retten.
async function checkRecordingRecovery() {
  let buf = null;
  try { buf = JSON.parse(localStorage.getItem('gpx_rec_buffer') || 'null'); } catch (e) { /* kaputt */ }
  if (!Array.isArray(buf) || buf.length < 10) { localStorage.removeItem('gpx_rec_buffer'); return; }
  const ok = await modalConfirm({ title: 'Unterbrochene Aufzeichnung', message: `Eine unterbrochene Aufzeichnung mit ${buf.length} Punkten wurde gefunden. Als Tour speichern?`, confirmLabel: 'Speichern' });
  localStorage.removeItem('gpx_rec_buffer');
  if (ok) await saveRecordedActivity(buf, `Wiederhergestellt ${new Date().toLocaleDateString('de-DE')}`);
}

async function saveNote(value) {
  const act = state.activities.find(a => a.id === state.selectedId);
  if (!act) return;
  const note = value.trim() === '' ? null : value.trim();
  if ((act.note || null) === note) return;
  act.note = note;
  act.updatedAt = Date.now();
  await dbPut(act);
  if (act.uid && state.cloud === 'ok') {
    apiFetch('/api/gpx', { method: 'PUT', body: JSON.stringify({ uid: act.uid, note: act.note, updatedAt: act.updatedAt }) }).catch(() => {});
  }
  showToast('Notiz gespeichert.');
}

// Wetter zum Tour-Start nachschlagen (Open-Meteo Archiv; bei jungen Touren
// die Forecast-API mit past_days, weil das Archiv einige Tage nachläuft).
async function fetchStartWeather(act) {
  if (!act.startTime || !act.points || act.points.length === 0) return;
  if (act._weatherTried) return;
  act._weatherTried = true;

  try {
    const [lat, lon] = act.points[0];
    const day = new Date(act.startTime).toISOString().substring(0, 10);
    const isRecent = Date.now() - act.startTime < 6 * 24 * 60 * 60 * 1000;
    const url = isRecent
      ? `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,weather_code&timeformat=unixtime&past_days=7&forecast_days=1`
      : `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${day}&end_date=${day}&hourly=temperature_2m,weather_code&timeformat=unixtime`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    const hourly = data.hourly;
    if (!hourly || !hourly.time || hourly.time.length === 0) return;

    // Stunde mit dem geringsten Abstand zum Start finden
    let best = -1, bestDiff = Infinity;
    hourly.time.forEach((t, i) => {
      const diff = Math.abs(t * 1000 - act.startTime);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    });
    if (best === -1 || bestDiff > 2 * 60 * 60 * 1000) return;
    const temp = hourly.temperature_2m[best];
    if (temp === null || temp === undefined) return;

    act.startWeather = { temp, code: hourly.weather_code ? hourly.weather_code[best] : null };
    act.updatedAt = Date.now();
    await dbPut(act);
    if (act.uid && state.cloud === 'ok') {
      apiFetch('/api/gpx', { method: 'PUT', body: JSON.stringify({ uid: act.uid, startWeather: act.startWeather, updatedAt: act.updatedAt }) }).catch(() => {});
    }
    if (state.selectedId === act.id) renderNoteAndWeather(act);
  } catch (err) {
    console.warn('Start-Wetter laden fehlgeschlagen:', err);
  }
}

// ============ Strecken-Bestzeiten (P12) ============
function cellsFor(act) {
  if (!state.cellCache.has(act.id)) {
    state.cellCache.set(act.id, routeCells(downsamplePoints(act.points, 1500)));
  }
  return state.cellCache.get(act.id);
}

// ============ Auto-Typ-Lernen (P10) ============
// Korrigiert der Nutzer den geratenen Aktivitätstyp, merkt sich das System die
// Routen-Signatur → Typ. Beim nächsten Import derselben Strecke wird sofort
// richtig geraten. Signatur bewusst grob (downsample 200) für kleinen Speicher.
function getTypeHints() {
  const h = Store.getJSON('gpx_type_hints', []);
  return Array.isArray(h) ? h : [];
}
function recordTypeHint(points, type) {
  if (!points || points.length < 2) return;
  const cells = [...routeCells(downsamplePoints(points, 200))];
  const hints = getTypeHints().filter(h => routeSimilarity(new Set(h.cells), new Set(cells)) < 0.75);
  hints.unshift({ cells, type });
  Store.setJSON('gpx_type_hints', hints.slice(0, 20)); // jüngste 20 behalten
}
function guessTypeWithHints(points, avgSpeed) {
  if (points && points.length >= 2) {
    const cells = routeCells(downsamplePoints(points, 200));
    for (const h of getTypeHints()) {
      if (routeSimilarity(new Set(h.cells), cells) >= 0.75) return h.type;
    }
  }
  return guessType(avgSpeed);
}

// ============ Segment-Vergleich mit der Bestzeit (P9) ============
function compareWithBest() {
  const act = state.activities.find(a => a.id === state.selectedId);
  const ref = state.routeRef;
  const resEl = document.getElementById('segment-compare-result');
  if (!act || !ref || !resEl) return;

  const segs = compareTracks(ref.points, act.points, 200);
  if (segs.length === 0) { resEl.innerText = 'Vergleich nicht möglich (fehlende Zeitdaten).'; resEl.classList.remove('hidden'); return; }

  drawSegmentComparison(act, segs);

  const totalDelta = segs[segs.length - 1].deltaSec;
  // größten Zeitverlust-Abschnitt finden (max. Zunahme des Deltas)
  let worst = { from: 0, inc: -Infinity, at: 0 };
  for (let i = 1; i < segs.length; i++) {
    const inc = segs[i].deltaSec - segs[i - 1].deltaSec;
    if (inc > worst.inc) worst = { from: segs[i - 1].distM, inc, at: segs[i].distM };
  }
  const sign = totalDelta >= 0 ? '+' : '';
  resEl.innerHTML = `Gegenüber der Bestzeit (${escapeHtml(ref.name)}): <strong class="${totalDelta > 0 ? 'text-red-400' : 'text-emerald-400'}">${sign}${Math.round(totalDelta)} s</strong>. ` +
    (worst.inc > 1 ? `Größter Rückstand zwischen km ${(worst.from / 1000).toFixed(1)}–${(worst.at / 1000).toFixed(1)}.` : 'Sehr gleichmäßig.') +
    ` <span class="text-slate-500">(grün = schneller, rot = langsamer)</span>`;
  resEl.classList.remove('hidden');
}

// Aktuelle Route auf der Karte nach Zeit-Delta einfärben (grün schneller/rot langsamer).
function drawSegmentComparison(act, segs) {
  ensureMap();
  if (state.trackLayer) { state.map.removeLayer(state.trackLayer); state.trackLayer = null; }
  if (state.heatmapLayer) { state.map.removeLayer(state.heatmapLayer); state.heatmapLayer = null; }

  const pts = act.points;
  const deltaAt = distM => {
    let best = segs[0];
    for (const s of segs) { if (s.distM <= distM) best = s; else break; }
    return best.deltaSec;
  };
  const layers = [];
  let cum = 0;
  for (let i = 1; i < pts.length; i++) {
    cum += haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    const d = deltaAt(cum);
    const color = d > 2 ? '#ef4444' : d < -2 ? '#10b981' : '#eab308';
    layers.push(L.polyline([[pts[i - 1][0], pts[i - 1][1]], [pts[i][0], pts[i][1]]], { color, weight: 4, opacity: 0.9 }));
  }
  const bounds = L.latLngBounds(pts.map(p => [p[0], p[1]]));
  layers.push(L.circleMarker([pts[0][0], pts[0][1]], { radius: 6, color: '#10b981', fillColor: '#10b981', fillOpacity: 1 }).bindTooltip('Start'));
  state.trackLayer = L.layerGroup(layers).addTo(state.map);
  state.map.fitBounds(bounds, { padding: [24, 24] });
}

// Findet Aktivitäten auf (nahezu) derselben Strecke und rankt sie nach Zeit.
function renderRouteMatches(act) {
  const card = document.getElementById('segments-card');
  const listEl = document.getElementById('segments-list');
  const subEl = document.getElementById('segments-sub');
  if (!card || !listEl) return;

  const myCells = cellsFor(act);
  const matches = state.activities.filter(other => {
    if (other.id === act.id || other.type !== act.type) return false;
    if (!other.distM || !act.distM) return false;
    const ratio = other.distM / act.distM;
    if (ratio < 0.8 || ratio > 1.25) return false;
    return routeSimilarity(myCells, cellsFor(other)) >= 0.75;
  });

  const compareBtn = document.getElementById('segment-compare-btn');
  const compareRes = document.getElementById('segment-compare-result');
  if (compareRes) compareRes.classList.add('hidden');

  if (matches.length === 0) {
    card.classList.add('hidden');
    state.routeRef = null;
    if (compareBtn) compareBtn.classList.add('hidden');
    return;
  }

  const all = [act, ...matches]
    .filter(a => (a.movingSec || a.totalSec))
    .sort((a, b) => (a.movingSec || a.totalSec) - (b.movingSec || b.totalSec));
  if (all.length < 2) { card.classList.add('hidden'); return; }

  // Referenz für den Segmentvergleich: schnellste Tour, die nicht die aktuelle ist
  state.routeRef = all.find(a => a.id !== act.id) || null;
  if (compareBtn) compareBtn.classList.toggle('hidden', !state.routeRef);

  subEl.innerText = `Diese Strecke bist du ${all.length}× ${act.type === 'ride' || act.type === 'moto' ? 'gefahren' : 'gelaufen bzw. gegangen'} — Rangliste nach Bewegungszeit.`;
  listEl.innerHTML = '';
  all.forEach((a, idx) => {
    const isCurrent = a.id === act.id;
    const row = document.createElement('div');
    row.className = `flex items-center justify-between gap-2 px-3 py-2 rounded-xl border text-xs ${
      isCurrent ? 'bg-orange-500/10 border-orange-500/30 text-white' : 'bg-slate-900/40 border-slate-800/60 text-slate-300'
    }`;
    row.innerHTML = `
      <span class="flex items-center gap-2 min-w-0">
        <span class="font-bold w-8 shrink-0">${idx === 0 ? '🏆' : `${idx + 1}.`}</span>
        <span class="truncate">${a.startTime ? new Date(a.startTime).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '–'} · ${escapeHtml(a.name)}${isCurrent ? ' (diese)' : ''}</span>
      </span>
      <span class="font-mono font-semibold shrink-0">${fmtDuration(a.movingSec || a.totalSec)} · ${fmtSpeed(a.avgSpeed)}</span>
    `;
    if (!isCurrent) { row.style.cursor = 'pointer'; row.onclick = () => selectActivity(a.id); }
    listEl.appendChild(row);
  });
  card.classList.remove('hidden');
}

// segmentSpeeds kommt aus lib/core.js (getestet).

const SPEED_COLORS = ['#3b82f6', '#14b8a6', '#22c55e', '#eab308', '#f97316', '#ef4444'];

function toggleSpeedColor() {
  state.speedColor = !state.speedColor;
  const btn = document.getElementById('btn-speed-color');
  btn.className = state.speedColor
    ? 'absolute top-4 right-4 z-[1000] px-3 py-1.5 rounded-lg text-xs font-semibold bg-teal-500/20 border border-teal-500/40 text-teal-300 transition-all'
    : 'absolute top-4 right-4 z-[1000] px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-900/90 border border-slate-800 text-slate-300 hover:border-slate-600 transition-all';
  const act = state.activities.find(a => a.id === state.selectedId);
  if (act) drawMap(act);
}

function setCompare(value) {
  state.compareId = value ? parseInt(value, 10) : null;
  const act = state.activities.find(a => a.id === state.selectedId);
  if (act) { drawMap(act); drawElevationChart(act); }
}

function updateCompareSelect() {
  const sel = document.getElementById('compare-select');
  if (!sel) return;
  const current = state.compareId;
  sel.innerHTML = '<option value="">Vergleich: aus</option>';
  state.activities.filter(a => a.id !== state.selectedId).forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = `vs. ${a.name}`;
    sel.appendChild(opt);
  });
  sel.value = (current && current !== state.selectedId) ? current.toString() : '';
  if (sel.value === '') state.compareId = null;
}

function ensureMap() {
  if (!state.map) {
    state.map = L.map('map', { zoomControl: true, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      // Die globale Referrer-Policy (_headers) ist no-referrer, aber die
      // OSM-Tile-Server verlangen einen Referer und liefern sonst
      // "Access blocked"-Kacheln — daher nur fuer die Tiles den Origin
      // mitschicken (Plan5-3).
      referrerPolicy: 'strict-origin-when-cross-origin',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(state.map);
  }
}

// ============ Heatmap aller Routen (P11) ============
function updateHeatmapButton() {
  const btn = document.getElementById('btn-heatmap');
  if (!btn) return;
  btn.className = state.heatmap
    ? 'p-2.5 rounded-xl bg-orange-500/20 border border-orange-500/40 text-orange-300 transition-colors'
    : 'p-2.5 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-slate-700 text-slate-400 hover:text-white transition-colors';
}

function toggleHeatmap() {
  state.heatmap = !state.heatmap;
  updateHeatmapButton();

  if (!state.heatmap) {
    if (state.heatmapLayer) { state.map.removeLayer(state.heatmapLayer); state.heatmapLayer = null; }
    const act = state.activities.find(a => a.id === state.selectedId);
    if (act) drawMap(act);
    return;
  }

  ensureMap();
  if (state.trackLayer) { state.map.removeLayer(state.trackLayer); state.trackLayer = null; }
  if (state.heatmapLayer) state.map.removeLayer(state.heatmapLayer);

  // Alle Tracks halbtransparent übereinander — häufig gefahrene Wege „glühen"
  // durch die Überlagerung. Zwei Durchgänge (breit schwach + schmal kräftiger)
  // verstärken den Effekt.
  const layers = [];
  let bounds = null;
  state.activities.forEach(a => {
    if (!a.points || a.points.length < 2) return;
    const latlngs = downsamplePoints(a.points, 600).map(p => [p[0], p[1]]);
    layers.push(L.polyline(latlngs, { color: '#f97316', weight: 5, opacity: 0.10, interactive: false }));
    layers.push(L.polyline(latlngs, { color: '#fdba74', weight: 1.5, opacity: 0.45, interactive: false }).bindTooltip(a.name));
    bounds = bounds ? bounds.extend(L.latLngBounds(latlngs)) : L.latLngBounds(latlngs);
  });

  if (layers.length === 0 || !bounds) {
    showToast('Keine Routen für die Heatmap vorhanden.', 'info');
    state.heatmap = false;
    updateHeatmapButton();
    return;
  }
  state.heatmapLayer = L.layerGroup(layers).addTo(state.map);
  state.map.fitBounds(bounds, { padding: [24, 24] });
}

function drawMap(act) {
  ensureMap();

  // Einzelansicht beendet den Heatmap-Modus
  if (state.heatmap) {
    state.heatmap = false;
    updateHeatmapButton();
  }
  if (state.heatmapLayer) { state.map.removeLayer(state.heatmapLayer); state.heatmapLayer = null; }
  if (state.trackLayer) state.map.removeLayer(state.trackLayer);

  const latlngs = act.points.map(p => [p[0], p[1]]);
  const layers = [];

  // Route: einfarbig oder nach Tempo eingefärbt (Quantile p5–p95 → 6 Farbstufen)
  const speeds = state.speedColor ? segmentSpeeds(act.points) : null;
  const validSpeeds = speeds ? speeds.filter(v => v !== null).sort((a, b) => a - b) : [];

  if (speeds && validSpeeds.length > 10) {
    const lo = validSpeeds[Math.floor(validSpeeds.length * 0.05)];
    const hi = validSpeeds[Math.floor(validSpeeds.length * 0.95)];
    const colorFor = v => {
      if (v === null) return SPEED_COLORS[0];
      const t = Math.max(0, Math.min(1, (v - lo) / Math.max(0.1, hi - lo)));
      return SPEED_COLORS[Math.min(SPEED_COLORS.length - 1, Math.floor(t * SPEED_COLORS.length))];
    };
    let seg = [latlngs[0]];
    let segColor = colorFor(speeds[0]);
    for (let i = 1; i < latlngs.length; i++) {
      const c = colorFor(speeds[i - 1]);
      if (c !== segColor) {
        layers.push(L.polyline(seg, { color: segColor, weight: 4, opacity: 0.9 }));
        seg = [seg[seg.length - 1]];
        segColor = c;
      }
      seg.push(latlngs[i]);
    }
    layers.push(L.polyline(seg, { color: segColor, weight: 4, opacity: 0.9 }));
  } else {
    layers.push(L.polyline(latlngs, { color: '#f97316', weight: 3.5, opacity: 0.9 }));
  }

  layers.push(L.circleMarker(latlngs[0], { radius: 6, color: '#10b981', fillColor: '#10b981', fillOpacity: 1 }).bindTooltip('Start'));
  layers.push(L.circleMarker(latlngs[latlngs.length - 1], { radius: 6, color: '#ef4444', fillColor: '#ef4444', fillOpacity: 1 }).bindTooltip('Ziel'));

  const bounds = L.latLngBounds(latlngs);

  // Vergleichstour einblenden (gestrichelt, indigo)
  if (state.compareId && state.compareId !== act.id) {
    const other = state.activities.find(a => a.id === state.compareId);
    if (other) {
      const otherLatlngs = other.points.map(p => [p[0], p[1]]);
      layers.push(L.polyline(otherLatlngs, { color: '#818cf8', weight: 3, opacity: 0.75, dashArray: '6 6' }).bindTooltip(other.name));
      bounds.extend(L.latLngBounds(otherLatlngs));
    }
  }

  state.trackLayer = L.layerGroup(layers).addTo(state.map);
  state.map.fitBounds(bounds, { padding: [24, 24] });
}

// Höhenprofil-Datenreihe: {x: km, y: Höhe}, auf max. 300 Punkte ausgedünnt
function elevationSeries(act) {
  const step = Math.max(1, Math.ceil(act.points.length / 300));
  let dist = 0;
  const data = [];
  for (let i = 0; i < act.points.length; i++) {
    if (i > 0) dist += haversine(act.points[i - 1][0], act.points[i - 1][1], act.points[i][0], act.points[i][1]);
    if (i % step !== 0) continue;
    if (act.points[i][2] === null) continue;
    data.push({ x: dist / 1000, y: act.points[i][2] });
  }
  return data;
}

function drawElevationChart(act) {
  const hasEle = act.eleMin !== null;
  document.getElementById('no-elevation-hint').classList.toggle('hidden', hasEle);
  document.getElementById('elevationChart').style.display = hasEle ? '' : 'none';
  if (!hasEle) { if (state.chart) { state.chart.destroy(); state.chart = null; } return; }

  const ctx = document.getElementById('elevationChart').getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 180);
  grad.addColorStop(0, 'rgba(99, 102, 241, 0.25)');
  grad.addColorStop(1, 'rgba(99, 102, 241, 0)');

  const datasets = [{
    label: act.name,
    data: elevationSeries(act),
    borderColor: '#6366f1',
    borderWidth: 2,
    backgroundColor: grad,
    fill: true,
    tension: 0.3,
    pointRadius: 0,
    pointHoverRadius: 4
  }];

  // Vergleichstour als zweites Profil (gestrichelt, teal)
  if (state.compareId && state.compareId !== act.id) {
    const other = state.activities.find(a => a.id === state.compareId);
    if (other && other.eleMin !== null) {
      datasets.push({
        label: other.name,
        data: elevationSeries(other),
        borderColor: '#14b8a6',
        borderWidth: 2,
        borderDash: [5, 5],
        backgroundColor: 'transparent',
        fill: false,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4
      });
    }
  }

  if (state.chart) state.chart.destroy();
  state.chart = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.95)',
          callbacks: {
            title: items => `km ${items[0].parsed.x.toFixed(1)}`,
            label: item => `${Math.round(item.parsed.y)} m ü. M.`
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          grid: { color: 'rgba(255,255,255,0.03)' },
          ticks: { color: '#64748b', font: { size: 10 }, callback: v => `${v.toFixed(0)} km` }
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#94a3b8', font: { size: 10 }, callback: v => `${v} m` }
        }
      }
    }
  });
}

// ============ Aktionen ============
async function changeActivityType(newType) {
  const act = state.activities.find(a => a.id === state.selectedId);
  if (!act) return;
  const wasGuess = act.type;
  act.type = newType;
  act.updatedAt = Date.now();
  await dbPut(act);
  if (act.uid && state.cloud === 'ok') {
    apiFetch('/api/gpx', { method: 'PUT', body: JSON.stringify({ uid: act.uid, type: newType, updatedAt: act.updatedAt }) }).catch(() => {});
  }
  // Korrektur merken → nächste Aufzeichnung derselben Strecke wird richtig geraten
  if (wasGuess !== newType) {
    recordTypeHint(act.points, newType);
    showToast('Typ geändert — für diese Strecke gemerkt. 🎓');
  }
  renderActivityList();
  renderDetail(act);
}

async function renameActivity() {
  const act = state.activities.find(a => a.id === state.selectedId);
  if (!act) return;
  const vals = await modalPrompt({ title: 'Aktivität umbenennen', fields: [{ key: 'name', label: 'Name', value: act.name }] });
  if (vals && vals.name.trim() !== '') {
    act.name = vals.name.trim();
    act.updatedAt = Date.now();
    await dbPut(act);
    if (act.uid && state.cloud === 'ok') {
      apiFetch('/api/gpx', { method: 'PUT', body: JSON.stringify({ uid: act.uid, name: act.name, updatedAt: act.updatedAt }) }).catch(() => {});
    }
    renderActivityList();
    renderDetail(act);
  }
}

// Tour wieder als .gpx-Datei herunterladen (P15)
function exportGpx() {
  const act = state.activities.find(a => a.id === state.selectedId);
  if (!act) return;
  const xml = buildGpxXml(act);
  const blob = new Blob([xml], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${act.name.replace(/[^\wäöüÄÖÜß-]+/g, '_')}.gpx`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('GPX-Datei heruntergeladen.');
}

async function deleteActivity() {
  const act = state.activities.find(a => a.id === state.selectedId);
  if (!act) return;
  const ok = await modalConfirm({ title: 'Aktivität löschen?', message: `„${act.name}" wirklich löschen?`, confirmLabel: 'Löschen', danger: true });
  if (!ok) return;
  await dbDelete(act.id);

  // Löschung für den Cloud-Sync vormerken (überlebt auch Offline-Phasen)
  // und sofort zu propagieren versuchen
  if (act.uid) {
    addPendingDelete(act.uid);
    apiFetch(`/api/gpx?uid=${encodeURIComponent(act.uid)}`, { method: 'DELETE' })
      .then(() => removePendingDelete(act.uid))
      .catch(() => {});
    // Fotos der Tour aus R2 entfernen (best effort; ohne R2-Binding No-op)
    if (_photosSupported) apiFetch(`/api/photos?uid=${encodeURIComponent(act.uid)}`, { method: 'DELETE' }).catch(() => {});
  }

  if (state.compareId === act.id) state.compareId = null;
  state.selectedId = null;
  await refreshActivities();
  if (state.activities.length > 0) selectActivity(state.activities[0].id);

  // Undo anbieten: stellt lokal wieder her und belebt den Server-Eintrag
  const backup = { ...act };
  delete backup.id;
  showToast(`„${act.name}" gelöscht.`, 'info', {
    label: 'Rückgängig',
    onClick: async () => {
      if (backup.uid) removePendingDelete(backup.uid);
      backup.updatedAt = Date.now();
      await dbPut(backup);
      pushActivityToCloud(backup);
      await refreshActivities();
      const restored = state.activities.find(a => a.uid === backup.uid);
      if (restored) selectActivity(restored.id);
    }
  });
}

// ============ Init ============
async function init() {
  // Profil/Einstellungen parallel starten, aber NICHT darauf warten (Plan4-24):
  // die Tourenliste kommt aus IndexedDB und braucht weder Netz noch Store.
  const storeP = Store.init();
  updateIcons(); // Shell-Icons sofort — brauchen keinen Store

  await refreshActivities();  // IndexedDB → Liste ist sofort sichtbar
  if (state.activities.length > 0) selectActivity(state.activities[0].id);

  // Ab hier Store-Abhaengiges. renderSummary lief in refreshActivities bereits
  // einmal mit Default-Zielen (getGoals ohne aktives Profil) — nach Store.init
  // erneut rendern, damit Ziele/Prognose des echten Profils erscheinen.
  await storeP;
  applyTheme(getTheme());
  renderSummary();

  // Cloud-Abgleich im Hintergrund (holt Touren von anderen Geräten)
  syncWithCloud().then(() => {
    if (state.activities.length > 0 && state.selectedId === null) {
      selectActivity(state.activities[0].id);
    }
  });

  registerServiceWorker();
  // Netz-Rueckkehr (Plan4-20): Cloud-Abgleich nachholen
  window.addEventListener('net-online', () => { syncWithCloud().catch(() => {}); });
  handleSharedGpx();          // via Share-Target geteilte Datei (P2-14)
  handleLaunchQueueFiles();   // via File-Handler geoeffnete .gpx-Datei (P2-14)

  // Live-Aufzeichnung (P2-13): Button nur bei GPS-Unterstuetzung, Crash-Recovery
  if ('geolocation' in navigator) {
    const rb = document.getElementById('record-btn');
    if (rb) rb.classList.remove('hidden');
    checkRecordingRecovery();
    // PWA-Shortcut "Aufzeichnung starten" (P3-10): direkt loslegen. Der Wunsch
    // wird in sessionStorage gemerkt, damit er einen Service-Worker-Reload beim
    // ersten Start uebersteht (Flag wird genau einmal eingeloest).
    if (location.hash === '#record') {
      sessionStorage.setItem('gpx_autostart', '1');
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* alt */ }
    }
    if (sessionStorage.getItem('gpx_autostart') === '1' && !(state.rec && state.rec.active)) {
      startRecording();
      // Flag nach kurzer Frist loeschen. Seit Plan4-7 reloadt der erste
      // SW-Install nicht mehr, der Autostart laeuft also genau einmal direkt;
      // die Frist deckt den Fall ab, dass doch ein Reload dazwischenkommt.
      setTimeout(() => sessionStorage.removeItem('gpx_autostart'), 4000);
    }
  }
}

// Vom Service Worker (Share-Target) zwischengespeicherte GPX-Datei einlesen.
async function handleSharedGpx() {
  if (location.hash !== '#shared' || !window.caches) return;
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* alt */ }
  try {
    const resp = await caches.match('shared-gpx');
    if (!resp) return;
    const text = await resp.text();
    const name = resp.headers.get('X-Shared-Name') || 'geteilt.gpx';
    // Aufraeumen (aus allen Caches, da der Cache-Name hier nicht bekannt ist)
    const names = await caches.keys();
    for (const n of names) { try { await (await caches.open(n)).delete('shared-gpx'); } catch (e) { /* egal */ } }
    const id = await importGpxText(text, name);
    await refreshActivities();
    if (id != null) selectActivity(id);
    setUploadStatus('Geteilte GPX-Datei importiert.');
  } catch (e) { setUploadStatus('Geteilte Datei konnte nicht gelesen werden.', true); }
}

// File-Handler: per Betriebssystem geoeffnete .gpx-Dateien.
function handleLaunchQueueFiles() {
  if (!('launchQueue' in window) || !window.launchQueue) return;
  window.launchQueue.setConsumer(async params => {
    if (!params || !params.files || !params.files.length) return;
    let last = null;
    for (const handle of params.files) {
      try { const file = await handle.getFile(); last = await importGpxText(await file.text(), file.name); } catch (e) { /* Datei ueberspringen */ }
    }
    await refreshActivities();
    if (last != null) selectActivity(last);
    setUploadStatus('Geöffnete GPX-Datei importiert.');
  });
}

window.addEventListener('DOMContentLoaded', init);
