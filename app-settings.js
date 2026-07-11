// app-settings.js — Teil des ClimateFlow-Hub (aus app.js zerlegt, Plan2-9).
// Einstellungen, Benachrichtigungs-Center, Backup, Health, Onboarding
// Klassische Skripte teilen den globalen Scope; Reihenfolge in index.html
// entspricht der urspruenglichen Dateireihenfolge (app-main.js zuletzt).

    // ============ Einstellungsseite (P1) ============
    function renderSettings() {
      // Profil
      const pEl = document.getElementById('settings-profile');
      if (pEl) {
        const name = getProfileDisplayName() || 'Standard';
        const mode = (window.Store && Store.mode) === 'server' ? 'angemeldet (Login)' : 'nur lokal';
        let html = `<p>Aktives Profil: <strong class="text-white">${escapeHtml(name)}</strong> <span class="text-slate-500">· ${mode}</span></p>`;
        if (Store.isAdmin && Store.profiles && Store.profiles.length) {
          html += `<p class="text-xs text-slate-400 mt-1">Profile: ${Store.profiles.map(p => escapeHtml(p)).join(', ')}</p>`;
          html += `<p class="text-[11px] text-slate-500 mt-1">Neues Profil anlegen: in Cloudflare die Env-Var <code class="text-slate-300">AUTH_USERS</code> um <code class="text-slate-300">name:passwort</code> ergänzen (mit „;" getrennt) und neu deployen.</p>`;
        } else if (Store.mode !== 'server') {
          html += `<p class="text-[11px] text-slate-500 mt-1">Auf dem Server ist jedes Login-Passwort ein eigenes Profil. Lokal wird „Standard" verwendet.</p>`;
        }
        const light = getTheme() === 'light';
        html += `<div class="mt-3 pt-3 border-t border-slate-800/60 flex items-center justify-between">
          <span class="text-sm text-slate-300 flex items-center gap-1.5"><i data-lucide="${light ? 'sun' : 'moon'}" class="w-4 h-4 text-amber-400"></i> Erscheinungsbild</span>
          <button data-onclick="toggleTheme" class="px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-800 hover:border-slate-700 text-xs text-slate-200 transition-colors">${light ? 'Heller Modus' : 'Dunkler Modus'} · umschalten</button>
        </div>`;
        if (window.Store && Store.mode === 'server') {
          html += `<div class="mt-2 flex justify-end"><button data-onclick="logout" class="px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-800 hover:border-red-500/40 text-xs text-slate-400 hover:text-red-300 transition-colors flex items-center gap-1.5"><i data-lucide="log-out" class="w-3.5 h-3.5"></i> Abmelden</button></div>`;
        }
        pEl.innerHTML = html;
      }

      // ntfy-Topic
      const topic = getNtfyTopic();
      const tEl = document.getElementById('settings-ntfy-topic');
      if (tEl) tEl.innerText = topic || 'nicht gesetzt';

      renderNotifyRules();
      initWebPushUI(); // Web-Push-Button je nach Server-/Geraete-Faehigkeit

      // Standorte
      const locEl = document.getElementById('settings-locations');
      if (locEl) {
        locEl.innerHTML = '';
        LOCATIONS.forEach(loc => {
          const th = getThresholds(loc.id);
          const card = document.createElement('div');
          card.className = 'bg-slate-900/50 border border-slate-800/60 rounded-xl p-3';
          card.innerHTML = `
            <div class="flex items-center justify-between gap-2">
              <p class="text-sm font-semibold text-white truncate">${escapeHtml(getLocationName(loc.id))}</p>
              <button class="p-1 rounded text-slate-500 hover:text-white transition-colors" title="Umbenennen"><i data-lucide="edit-2" class="w-3.5 h-3.5"></i></button>
            </div>
            <p class="text-[11px] text-slate-400 mt-1">Wohlfühlband: ${th.tempMin}–${th.tempMax} °C · ${th.humMin}–${th.humMax} %</p>
            <button class="mt-2 text-[11px] text-teal-300 hover:text-teal-200 transition-colors">Schwellwerte bearbeiten</button>
          `;
          card.querySelector('button[title="Umbenennen"]').onclick = () => renameLocation(loc.id);
          card.querySelectorAll('button')[1].onclick = () => editLocationThresholds(loc.id);
          locEl.appendChild(card);
        });

        // Admin: Zusatz-Standort anlegen (P8)
        if (window.Store && Store.isAdmin) {
          const add = document.createElement('button');
          add.className = 'bg-slate-900/40 border border-dashed border-slate-700 hover:border-teal-500/40 rounded-xl p-3 text-sm text-slate-400 hover:text-teal-300 transition-colors flex items-center justify-center gap-2';
          add.innerHTML = '<i data-lucide="plus" class="w-4 h-4"></i> Standort hinzufügen';
          add.onclick = addLocation;
          locEl.appendChild(add);
        }
      }

      // Kalender-Status
      const icalEl = document.getElementById('settings-ical-state');
      if (icalEl) {
        const url = Store.get('ical_url');
        icalEl.innerText = url ? `Verbunden: ${url.substring(0, 48)}${url.length > 48 ? '…' : ''}` : 'Kein Kalender verbunden.';
      }

      // Ziele-Status
      const goalsEl = document.getElementById('settings-goals-state');
      if (goalsEl) {
        const g = Store.getJSON('gpx_goals', null);
        goalsEl.innerText = (g && (g.weekKm || g.yearKm))
          ? `Wochenziel: ${g.weekKm || 0} km · Jahresziel: ${g.yearKm || 0} km`
          : 'Keine Ziele gesetzt.';
      }

      // Onboarding-Status
      const obEl = document.getElementById('onboarding-status');
      if (obEl) {
        const ob = Store.getJSON('onboarding', null);
        obEl.innerText = ob && ob.done
          ? 'Ersteinrichtung abgeschlossen — jederzeit erneut aufrufbar.'
          : 'Geführte Ersteinrichtung: Push, Schwellwerte, Kalender & Ziele.';
      }

      updateIcons();
    }

    async function renameLocation(locId) {
      const vals = await modalPrompt({
        title: 'Standort umbenennen',
        fields: [{ key: 'name', label: 'Name', value: getLocationName(locId) }]
      });
      if (!vals || vals.name.trim() === '') return;
      Store.set(`loc_name_${locId}`, vals.name.trim());
      updateTabLabels();
      renderSettings();
      showNotification('Name geändert.');
    }

    async function editLocationThresholds(locId) {
      const th = getThresholds(locId);
      const hasCo2 = (getLocationFields(locId).extra || []).some(e => e.key === 'co2');
      const fields = [
        { key: 'tempMin', label: 'Temperatur Minimum (°C)', type: 'number', value: th.tempMin },
        { key: 'tempMax', label: 'Temperatur Maximum (°C)', type: 'number', value: th.tempMax },
        { key: 'humMin', label: 'Feuchte Minimum (%)', type: 'number', value: th.humMin },
        { key: 'humMax', label: 'Feuchte Maximum (%)', type: 'number', value: th.humMax }
      ];
      if (hasCo2) fields.push({ key: 'co2Max', label: 'CO₂ Maximum (ppm)', type: 'number', value: th.co2Max });
      const vals = await modalPrompt({
        title: 'Wohlfühlband bearbeiten',
        description: `Für ${getLocationName(locId)}. Steuert Komfort-Bewertung, Score und Warnschwellen.`,
        fields
      });
      if (!vals) return;
      const n = v => parseFloat(String(v).replace(',', '.'));
      const tempMin = n(vals.tempMin), tempMax = n(vals.tempMax), humMin = n(vals.humMin), humMax = n(vals.humMax);
      if ([tempMin, tempMax, humMin, humMax].some(v => isNaN(v)) || tempMin >= tempMax || humMin >= humMax || humMin < 0 || humMax > 100) {
        showNotification('Ungültige Werte (Min < Max, Feuchte 0–100).', 'error');
        return;
      }
      const saved = { tempMin, tempMax, humMin, humMax };
      if (hasCo2) {
        const co2Max = n(vals.co2Max);
        if (!isNaN(co2Max) && co2Max > 0) saved.co2Max = co2Max;
      } else if (th.co2Max !== THRESHOLD_DEFAULTS.co2Max) {
        saved.co2Max = th.co2Max; // vorhandenen Wert nicht verlieren
      }
      Store.setJSON(`loc_thresholds_${locId}`, saved);
      renderSettings();
      if (typeof renderActiveView === 'function') renderActiveView();
      showNotification('Schwellwerte gespeichert.');
    }

    // Zusatz-Standort über die Oberfläche anlegen (P8, nur Admin). Der Read-Key
    // wird nur an den Server geschickt und dort gespeichert, nie clientseitig.
    // Extra-Felder (z. B. CO₂) als "key:field:Label:Einheit"-Zeilen (P20).
    async function addLocation() {
      const vals = await modalPrompt({
        title: 'Standort hinzufügen',
        description: 'ThingSpeak-Kanal + Read-Key (wird nur serverseitig gespeichert). Extra-Sensoren optional.',
        fields: [
          { key: 'id', label: 'Kurz-ID (a–z, 0–9, _-)', placeholder: 'wohnzimmer' },
          { key: 'name', label: 'Anzeigename', placeholder: 'Wohnzimmer' },
          { key: 'channel', label: 'ThingSpeak Kanal-ID' },
          { key: 'readKey', label: 'ThingSpeak Read API Key' },
          { key: 'lat', label: 'Breitengrad (lat)', type: 'number', value: '48.78' },
          { key: 'lon', label: 'Längengrad (lon)', type: 'number', value: '9.18' },
          { key: 'tempField', label: 'Feld für Temperatur', value: 'field1' },
          { key: 'humField', label: 'Feld für Luftfeuchte', value: 'field2' },
          { key: 'extra', label: 'Extra-Sensoren (optional)', placeholder: 'co2:field3:CO₂:ppm', hint: 'Pro Zeile key:field:Label:Einheit — mit Komma trennen' }
        ]
      });
      if (!vals) return;
      if (!/^[a-z0-9_-]{2,32}$/.test((vals.id || '').trim())) { showNotification('Ungültige ID.', 'error'); return; }
      if (!vals.channel.trim() || !vals.readKey.trim()) { showNotification('Kanal und Read-Key erforderlich.', 'error'); return; }
      const extra = (vals.extra || '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
        const [key, field, label, unit] = s.split(':').map(x => (x || '').trim());
        return key && field ? { key, field, label: label || key, unit: unit || '', decimals: 0 } : null;
      }).filter(Boolean);
      try {
        await apiFetch('/api/locations', {
          method: 'POST',
          body: JSON.stringify({
            id: vals.id.trim(), name: vals.name.trim() || vals.id.trim(), channel: vals.channel.trim(), readKey: vals.readKey.trim(),
            lat: parseFloat(String(vals.lat).replace(',', '.')), lon: parseFloat(String(vals.lon).replace(',', '.')),
            fields: { temp: vals.tempField || 'field1', humidity: vals.humField || 'field2', extra }
          })
        });
        showNotification('Standort angelegt – lade neu…');
        setTimeout(() => location.reload(), 900);
      } catch (err) {
        showNotification(err.unavailable ? 'Cloud-DB nicht eingerichtet.' : `Fehlgeschlagen: ${err.message}`, 'error');
      }
    }

    async function editHubGoals() {
      const g = Store.getJSON('gpx_goals', { yearKm: 0, weekKm: 0 }) || { yearKm: 0, weekKm: 0 };
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
      renderSettings();
      showNotification('Ziele gespeichert.');
    }

    // ============ Benachrichtigungs-Center (P4) ============
    const NOTIFY_TYPES = [
      { key: 'sensor',  label: 'Sensor-Ausfall',      icon: 'thermometer' },
      { key: 'mold',    label: 'Schimmelrisiko',      icon: 'droplet',   thLabel: 'Grenze %',  thDef: 80 },
      { key: 'frost',   label: 'Frost',               icon: 'snowflake', thLabel: 'Grenze °C', thDef: 0 },
      { key: 'heat',    label: 'Hitze',               icon: 'flame',     thLabel: 'Grenze °C', thDef: 30 },
      { key: 'co2',     label: 'CO₂ zu hoch',         icon: 'wind',      thLabel: 'Grenze ppm', thDef: 1200 },
      { key: 'vent',    label: 'Lüftungsfenster (morgens)', icon: 'wind' },
      { key: 'errors',  label: 'App-Fehler',          icon: 'bug' },
      { key: 'weekly',  label: 'Klima-Wochenbericht', icon: 'bar-chart-3' },
      { key: 'monthly', label: 'GPX-Monatsbericht',   icon: 'route' },
      { key: 'todo',    label: 'To-do-Erinnerungen',  icon: 'check-square' }
    ];
    const NOTIFY_DEFAULTS = {
      types: {
        sensor: { on: true }, mold: { on: true, threshold: 80 }, frost: { on: true, threshold: 0 },
        heat: { on: true, threshold: 30 }, co2: { on: false, threshold: 1200 }, vent: { on: false },
        errors: { on: true }, weekly: { on: true }, monthly: { on: true }, todo: { on: true }
      },
      quiet: { on: false, from: 22, to: 7 }
    };

    function getNotifyRules() {
      const r = Store.getJSON('notify_rules', {}) || {};
      const merged = { types: {}, quiet: { ...NOTIFY_DEFAULTS.quiet, ...(r.quiet || {}) } };
      NOTIFY_TYPES.forEach(t => {
        merged.types[t.key] = { ...NOTIFY_DEFAULTS.types[t.key], ...((r.types || {})[t.key] || {}) };
      });
      return merged;
    }

    function renderNotifyRules() {
      const wrap = document.getElementById('notify-rules');
      if (!wrap) return;
      const rules = getNotifyRules();
      wrap.innerHTML = '';
      NOTIFY_TYPES.forEach(t => {
        const cfg = rules.types[t.key];
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between gap-2 bg-slate-900/50 border border-slate-800/60 rounded-xl px-3 py-2';
        const thHtml = t.thLabel
          ? `<span class="text-[11px] text-slate-400 flex items-center gap-1">${t.thLabel}
               <input type="number" id="nr-th-${t.key}" value="${cfg.threshold ?? t.thDef}" class="w-16 bg-slate-900 border border-slate-800 rounded px-1.5 py-0.5 text-slate-200" data-onchange="saveNotifyRulesFromUI"></span>`
          : '';
        row.innerHTML = `
          <label class="flex items-center gap-2 text-sm text-slate-200 cursor-pointer min-w-0">
            <input type="checkbox" id="nr-on-${t.key}" class="accent-teal-500 shrink-0" ${cfg.on ? 'checked' : ''} data-onchange="saveNotifyRulesFromUI">
            <i data-lucide="${t.icon}" class="w-3.5 h-3.5 text-slate-400 shrink-0"></i>
            <span class="truncate">${t.label}</span>
          </label>
          ${thHtml}
        `;
        wrap.appendChild(row);
      });

      const rq = rules.quiet;
      const qOn = document.getElementById('quiet-on');
      const qFrom = document.getElementById('quiet-from');
      const qTo = document.getElementById('quiet-to');
      if (qOn) qOn.checked = !!rq.on;
      if (qFrom) qFrom.value = rq.from;
      if (qTo) qTo.value = rq.to;
      updateIcons();
    }

    function saveNotifyRulesFromUI() {
      const rules = { types: {}, quiet: {} };
      NOTIFY_TYPES.forEach(t => {
        const on = document.getElementById(`nr-on-${t.key}`);
        rules.types[t.key] = { on: on ? on.checked : true };
        if (t.thLabel) {
          const thEl = document.getElementById(`nr-th-${t.key}`);
          const v = thEl ? parseFloat(thEl.value.toString().replace(',', '.')) : NaN;
          rules.types[t.key].threshold = isNaN(v) ? t.thDef : v;
        }
      });
      const qOn = document.getElementById('quiet-on');
      const qFrom = document.getElementById('quiet-from');
      const qTo = document.getElementById('quiet-to');
      const clampH = (v, d) => { const n = parseInt(v, 10); return (isNaN(n) || n < 0 || n > 23) ? d : n; };
      rules.quiet = {
        on: qOn ? qOn.checked : false,
        from: clampH(qFrom && qFrom.value, 22),
        to: clampH(qTo && qTo.value, 7)
      };
      Store.setJSON('notify_rules', rules);
    }

    function sendTestPush() {
      if (!getNtfyTopic()) {
        showNotification('Erst ein ntfy-Topic hinterlegen.', 'error');
        return;
      }
      sendPush('Smart Home Hub', 'Test-Push ✔ — Benachrichtigungen funktionieren.', 'tada', null);
      showNotification('Test-Push gesendet.');
    }

    // ============ Daten & Widgets ============
    function collectProfileSettings() {
      const prefix = `p_${Store.profile}_`;
      const out = {};
      Object.keys(localStorage).forEach(k => {
        if (k.startsWith(prefix) && !k.endsWith('__ts') && !k.endsWith('___migrated')) {
          out[k.slice(prefix.length)] = localStorage.getItem(k);
        }
      });
      return out;
    }

    function exportSettingsJson() {
      const backup = {
        format: 'smarthub-settings', version: 1, profile: Store.profile,
        exportedAt: new Date().toISOString(), settings: collectProfileSettings()
      };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `smarthub-einstellungen-${Store.profile}-${new Date().toISOString().substring(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      showNotification('Einstellungen exportiert.');
    }

    async function importSettingsJson(event) {
      const file = event.target.files[0];
      event.target.value = '';
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (data.format !== 'smarthub-settings' || !data.settings) throw new Error('Kein gültiger Einstellungs-Export');
        Object.entries(data.settings).forEach(([k, v]) => Store.set(k, v));
        showNotification('Einstellungen importiert – lade neu…');
        setTimeout(() => location.reload(), 800);
      } catch (err) {
        showNotification(`Import fehlgeschlagen: ${err.message}`, 'error');
      }
    }

    function resetHubLayout() {
      Store.remove('hub_widget_order');
      Store.remove('hub_widget_hidden');
      applyWidgetLayout();
      showNotification('Widget-Layout zurückgesetzt.');
    }

    // ============ Komplett-Backup (Plan-Punkt 10a) ============
    // Ein-Datei-Sicherung aller profilbezogenen Daten: Einstellungen (Store),
    // To-dos und das Klima-Archiv (D1). GPX-Touren haben ihre eigene Sicherung im
    // GPX-Viewer. Restore fuehrt ueber die getesteten Sync-Pfade zusammen (LWW).
    async function exportFullBackup() {
      showNotification('Backup wird erstellt…');
      let climate = [];
      try { climate = await apiFetch('/api/climate'); } catch (e) { /* D1 evtl. aus → ohne Archiv */ }
      const backup = {
        format: 'smarthub-full-backup', version: 1, profile: Store.profile,
        exportedAt: new Date().toISOString(),
        settings: Store.exportAll(),
        todos: getTodos().filter(t => !t.deleted),
        climate: Array.isArray(climate) ? climate : []
      };
      const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `smarthub-full-backup-${Store.profile}-${new Date().toISOString().substring(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      showNotification(`Backup gesichert: ${Object.keys(backup.settings).length} Einstellungen, ${backup.todos.length} To-dos, ${backup.climate.length} Archiv-Tage.`);
    }

    async function importFullBackup(event) {
      const file = event.target.files[0];
      event.target.value = '';
      if (!file) return;
      let data;
      try { data = JSON.parse(await file.text()); } catch (e) { showNotification('Datei ist kein gültiges JSON.', 'error'); return; }
      if (data.format !== 'smarthub-full-backup') { showNotification('Kein gültiges Komplett-Backup.', 'error'); return; }
      const ok = await modalConfirm({
        title: 'Backup einspielen?',
        message: `Einstellungen (${Object.keys(data.settings || {}).length}), To-dos (${(data.todos || []).length}) und Klima-Archiv (${(data.climate || []).length} Tage) werden zusammengeführt. Neuere lokale Werte bleiben erhalten.`,
        confirmLabel: 'Einspielen'
      });
      if (!ok) return;
      try {
        // 1. Einstellungen (Last-Write-Wins)
        const nSet = Store.importAll(data.settings || {});
        // 2. To-dos zusammenführen (LWW über updatedAt)
        if (Array.isArray(data.todos) && data.todos.length) {
          const byId = {};
          getTodos().forEach(t => { byId[t.id] = t; });
          data.todos.forEach(t => {
            if (!t || !t.id) return;
            const ex = byId[t.id];
            if (!ex || (t.updatedAt || 0) > (ex.updatedAt || 0)) byId[t.id] = t;
          });
          saveTodos(Object.values(byId)); // rendert + synct nach D1
        }
        // 3. Klima-Archiv je Standort zurückspielen
        if (Array.isArray(data.climate) && data.climate.length) {
          const byLoc = {};
          data.climate.forEach(r => {
            if (!r || !r.loc || !r.day) return;
            (byLoc[r.loc] = byLoc[r.loc] || []).push({
              day: r.day, tMin: r.t_min, tMax: r.t_max, tAvg: r.t_avg,
              hMin: r.h_min, hMax: r.h_max, hAvg: r.h_avg, samples: r.samples,
              co2Avg: r.co2_avg, co2Max: r.co2_max
            });
          });
          for (const [loc, days] of Object.entries(byLoc)) {
            try { await apiFetch('/api/climate', { method: 'POST', body: JSON.stringify({ loc, days }) }); } catch (e) { /* D1 evtl. aus */ }
          }
        }
        await Store.flush();
        showNotification(`Backup eingespielt (${nSet} Einstellungen). Lade neu…`);
        setTimeout(() => location.reload(), 900);
      } catch (err) {
        showNotification(`Import fehlgeschlagen: ${err.message}`, 'error');
      }
    }

    async function clearLocalData() {
      const ok = await modalConfirm({
        title: 'Lokale Daten löschen?',
        message: 'Alle lokalen Daten dieses Profils werden entfernt. Cloud-synchronisierte Einstellungen kommen beim nächsten Laden zurück.',
        confirmLabel: 'Löschen', danger: true
      });
      if (!ok) return;
      const prefix = `p_${Store.profile}_`;
      Object.keys(localStorage).filter(k => k.startsWith(prefix)).forEach(k => localStorage.removeItem(k));
      showNotification('Lokale Daten gelöscht – lade neu…');
      setTimeout(() => location.reload(), 800);
    }

    // ============ System-/Gesundheitsstatus (P15, Endpunkt in Phase 3) ============
    async function loadHealth() {
      const el = document.getElementById('settings-health');
      if (!el) return;
      el.innerHTML = '<span class="text-slate-500">Prüfe Systemstatus …</span>';
      try {
        const h = await apiFetch('/api/health');
        el.innerHTML = renderHealth(h);
      } catch (err) {
        el.innerHTML = err.unavailable
          ? '<span class="text-amber-400">System-Endpunkt noch nicht deployt (erscheint nach dem nächsten Cloudflare-Deploy).</span>'
          : `<span class="text-red-400">Status nicht abrufbar: ${escapeHtml(err.message)}</span>`;
      }
      updateIcons();
    }

    function renderHealth(h) {
      const dot = ok => ok ? '<span class="text-emerald-400">●</span>' : '<span class="text-red-400">●</span>';
      const warn = '<span class="text-amber-400">●</span>';
      const rows = [];
      rows.push(`<div>${dot(h.d1)} Cloud-Datenbank (D1): ${h.d1 ? 'verbunden' : 'nicht verbunden'}</div>`);
      const envAll = h.env && Object.values(h.env).every(Boolean);
      rows.push(`<div>${h.env ? (envAll ? dot(true) : warn) : dot(false)} Umgebungsvariablen: ${h.env ? Object.entries(h.env).map(([k, v]) => `${k}${v ? '✓' : '✗'}`).join(' · ') : '–'}</div>`);
      if (h.lastCron) {
        const hrs = Math.round((Date.now() - h.lastCron) / 3600000);
        rows.push(`<div>${hrs <= 8 ? dot(true) : warn} Letzter Warn-Check: vor ${hrs} h ${hrs > 8 ? '(sollte ≤ 6 h sein → Cron prüfen)' : ''}</div>`);
      } else {
        rows.push(`<div>${warn} Letzter Warn-Check: noch nie (Cron-Job auf /api/check-alerts einrichten)</div>`);
      }
      if (h.channels) {
        Object.entries(h.channels).forEach(([loc, info]) => {
          const hrs = info.lastMs ? Math.round((Date.now() - info.lastMs) / 3600000) : null;
          rows.push(`<div>${hrs !== null && hrs <= 2 ? dot(true) : warn} Messwerte ${escapeHtml(loc)}: ${hrs !== null ? `vor ${hrs} h` : 'keine'}</div>`);
        });
      }
      if (h.counts) {
        rows.push(`<div class="text-xs text-slate-500 mt-1">Archiv: ${h.counts.climate_daily ?? 0} Tage · Touren: ${h.counts.gpx ?? 0} · To-dos: ${h.counts.todos ?? 0}</div>`);
      }
      if (Array.isArray(h.errors) && h.errors.length) {
        rows.push(`<div class="text-xs text-slate-500 mt-2 border-t border-slate-800/60 pt-2">Letzte Fehler:</div>`);
        h.errors.slice(0, 5).forEach(e => {
          rows.push(`<div class="text-[11px] text-slate-500 truncate">· ${escapeHtml((e.page || '') + ' ' + (e.message || ''))}</div>`);
        });
      }
      return rows.join('');
    }

    // ============ Onboarding-Assistent (P16) ============
    const ONBOARDING_STEPS = ['intro', 'ntfy', 'thresholds', 'calendar', 'goals', 'done'];
    let obStep = 0;

    function openOnboarding() {
      obStep = 0;
      document.getElementById('onboarding-modal').classList.remove('hidden');
      renderOnboardingStep();
    }
    function closeOnboarding() {
      document.getElementById('onboarding-modal').classList.add('hidden');
      renderSettings();
    }
    function onboardingNext(skip) {
      if (obStep >= ONBOARDING_STEPS.length - 1) {
        Store.setJSON('onboarding', { done: true, at: Date.now() });
        closeOnboarding();
        showNotification('Einrichtung abgeschlossen ✔');
        return;
      }
      obStep++;
      renderOnboardingStep();
    }
    function renderOnboardingStep() {
      const step = ONBOARDING_STEPS[obStep];
      const body = document.getElementById('onboarding-body');
      const prog = document.getElementById('onboarding-progress');
      const nextBtn = document.getElementById('onboarding-next');
      const skipBtn = document.getElementById('onboarding-skip');
      if (!body) return;
      prog.style.width = `${Math.round((obStep / (ONBOARDING_STEPS.length - 1)) * 100)}%`;
      nextBtn.innerText = obStep === ONBOARDING_STEPS.length - 1 ? 'Fertig' : 'Weiter';
      skipBtn.style.visibility = (step === 'intro' || step === 'done') ? 'hidden' : 'visible';

      const topic = getNtfyTopic();
      const contents = {
        intro: `<p class="mb-2">Willkommen${getProfileDisplayName() ? ', ' + escapeHtml(getProfileDisplayName()) : ''}! 👋</p>
          <p class="text-slate-400">In wenigen Schritten richten wir Push-Benachrichtigungen, dein Wohlfühlband, den Kalender und deine Ziele ein. Du kannst jeden Schritt überspringen.</p>`,
        ntfy: `<p class="font-semibold text-white mb-1">1 · Push-Benachrichtigungen</p>
          <p class="text-slate-400 mb-3">Lade die kostenlose <strong>ntfy</strong>-App und abonniere ein geheimes Topic. Trag denselben Namen hier ein.</p>
          <p class="text-xs mb-2">Aktuell: <span class="font-mono text-teal-300">${topic ? escapeHtml(topic) : 'nicht gesetzt'}</span></p>
          <div class="flex gap-2"><button data-onclick="obConfigureNtfy" class="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200">Topic setzen</button>
          <button data-onclick="sendTestPush" class="px-3 py-1.5 rounded-lg bg-teal-500/15 border border-teal-500/30 text-teal-200 text-xs">Test-Push</button></div>`,
        thresholds: `<p class="font-semibold text-white mb-1">2 · Wohlfühlband</p>
          <p class="text-slate-400 mb-3">Lege pro Standort den Temperatur- und Feuchtebereich fest — er steuert Komfort-Score und Warnungen.</p>
          <div class="flex flex-wrap gap-2">${LOCATIONS.map(l => `<button data-onclick="obEditThresholds|${l.id}" class="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200">${escapeHtml(getLocationName(l.id))}</button>`).join('')}</div>`,
        calendar: `<p class="font-semibold text-white mb-1">3 · Kalender (optional)</p>
          <p class="text-slate-400 mb-3">Verbinde einen .ics-Feed (z. B. Google Kalender „geheime Adresse"), um Termine auf dem Hub zu sehen.</p>
          <button data-onclick="obConfigureIcal" class="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200">Kalender verbinden</button>`,
        goals: `<p class="font-semibold text-white mb-1">4 · GPX-Ziele (optional)</p>
          <p class="text-slate-400 mb-3">Setze ein Wochen-/Jahresziel in km für den GPX-Viewer.</p>
          <button data-onclick="obEditGoals" class="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200">Ziele setzen</button>`,
        done: `<p class="font-semibold text-white mb-1">Fertig! 🎉</p>
          <p class="text-slate-400">Du kannst alles jederzeit in den Einstellungen anpassen. Viel Freude mit deinem Smart Home Hub!</p>`
      };
      body.innerHTML = contents[step] || '';
      updateIcons();
    }
