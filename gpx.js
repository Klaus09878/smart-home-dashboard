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
    type: guessType(stats.avgSpeed),
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
    await apiFetch('/api/gpx', { method: 'POST', body: JSON.stringify(activityToPayload(activity)) });
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
  const settings = {};
  Object.keys(localStorage).forEach(k => {
    if (/^(loc_name_|loc_weather_|loc_thresholds_|selected_location|ntfy_topic|gpx_goals|hub_|ical_url)/.test(k)) settings[k] = localStorage.getItem(k);
  });
  const backup = {
    format: 'smarthub-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    activities
  };
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `smarthub-backup-${new Date().toISOString().substring(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  setUploadStatus(`Backup mit ${activities.length} Aktivität(en) heruntergeladen.`);
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
      Object.entries(backup.settings).forEach(([k, v]) => localStorage.setItem(k, v));
    }
    await refreshActivities();
    if (state.activities.length > 0 && state.selectedId === null) selectActivity(state.activities[0].id);
    syncWithCloud();
    setUploadStatus(`Backup eingespielt: ${restored} neue Aktivität(en), Einstellungen übernommen.`);
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
  try {
    const g = JSON.parse(localStorage.getItem('gpx_goals') || 'null');
    if (g && typeof g === 'object') return { yearKm: g.yearKm || 0, weekKm: g.weekKm || 0 };
  } catch (e) { /* defekte Daten → keine Ziele */ }
  return { yearKm: 0, weekKm: 0 };
}

function editGoals() {
  const g = getGoals();
  const yearStr = prompt('Jahresziel in km (0 = kein Ziel):', g.yearKm || 0);
  if (yearStr === null) return;
  const weekStr = prompt('Wochenziel in km (0 = kein Ziel):', g.weekKm || 0);
  if (weekStr === null) return;
  const yearKm = Math.max(0, parseFloat(yearStr.toString().replace(',', '.')) || 0);
  const weekKm = Math.max(0, parseFloat(weekStr.toString().replace(',', '.')) || 0);
  localStorage.setItem('gpx_goals', JSON.stringify({ yearKm, weekKm }));
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
  renderGoalBar('goal-week-bar', 'goal-week-label', 'goal-week-wrap', km(weekActs), goals.weekKm);
  renderGoalBar('goal-year-bar', 'goal-year-label', 'goal-year-wrap', km(yearActs), goals.yearKm);
  const hint = document.getElementById('goal-empty-hint');
  if (hint) hint.classList.toggle('hidden', !!(goals.weekKm || goals.yearKm));
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
      ? `🔥 Aktuelle Serie: <strong class="text-orange-300">${current} Tag${current === 1 ? '' : 'e'}</strong> · Längste: ${longest}`
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

  if (matches.length === 0) {
    card.classList.add('hidden');
    return;
  }

  const all = [act, ...matches]
    .filter(a => (a.movingSec || a.totalSec))
    .sort((a, b) => (a.movingSec || a.totalSec) - (b.movingSec || b.totalSec));
  if (all.length < 2) { card.classList.add('hidden'); return; }

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
  act.type = newType;
  act.updatedAt = Date.now();
  await dbPut(act);
  if (act.uid && state.cloud === 'ok') {
    apiFetch('/api/gpx', { method: 'PUT', body: JSON.stringify({ uid: act.uid, type: newType, updatedAt: act.updatedAt }) }).catch(() => {});
  }
  renderActivityList();
  renderDetail(act);
}

async function renameActivity() {
  const act = state.activities.find(a => a.id === state.selectedId);
  if (!act) return;
  const newName = prompt('Neuer Name für diese Aktivität:', act.name);
  if (newName !== null && newName.trim() !== '') {
    act.name = newName.trim();
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
  if (!confirm(`„${act.name}" wirklich löschen?`)) return;
  await dbDelete(act.id);

  // Löschung für den Cloud-Sync vormerken (überlebt auch Offline-Phasen)
  // und sofort zu propagieren versuchen
  if (act.uid) {
    addPendingDelete(act.uid);
    apiFetch(`/api/gpx?uid=${encodeURIComponent(act.uid)}`, { method: 'DELETE' })
      .then(() => removePendingDelete(act.uid))
      .catch(() => {});
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
  updateIcons();
  await refreshActivities();
  if (state.activities.length > 0) selectActivity(state.activities[0].id);

  // Cloud-Abgleich im Hintergrund (holt Touren von anderen Geräten)
  syncWithCloud().then(() => {
    if (state.activities.length > 0 && state.selectedId === null) {
      selectActivity(state.activities[0].id);
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

window.addEventListener('DOMContentLoaded', init);
