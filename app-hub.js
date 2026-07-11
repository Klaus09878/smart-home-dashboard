// app-hub.js — Teil des ClimateFlow-Hub (aus app.js zerlegt, Plan2-9).
// Hub-Widgets, Layout-Factory (createLayout), To-dos, Wetter, Kalender
// Klassische Skripte teilen den globalen Scope; Reihenfolge in index.html
// entspricht der urspruenglichen Dateireihenfolge (app-main.js zuletzt).

    // ============ Hub-Widgets: Uhr, Datum, Begrüßung, Wetter, GPX ============
    // (updateHubClock & loadHubWeather sind weiter unten definiert.)

    // GPX-Widget: liest die lokal gespeicherten Aktivitäten des GPX-Viewers (IndexedDB)
    function loadGpxWidget() {
      try {
        const req = indexedDB.open('smarthub');
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('gpx-activities')) { db.close(); return; }
          const getAll = db.transaction('gpx-activities', 'readonly').objectStore('gpx-activities').getAll();
          getAll.onsuccess = () => {
            const acts = getAll.result || [];
            db.close();
            if (acts.length === 0) return;
            acts.sort((a, b) => (b.startTime || b.addedAt) - (a.startTime || a.addedAt));

            const lastAct = acts[0];
            document.getElementById('hub-gpx-last').innerText = lastAct.name;
            document.getElementById('hub-gpx-last-info').innerText =
              `${(lastAct.distM / 1000).toFixed(1)} km${lastAct.startTime ? ' · ' + formatRelativeTime(new Date(lastAct.startTime)) : ''}`;

            const weekStart = Date.now() - 7 * 24 * 60 * 60 * 1000;
            const weekActs = acts.filter(a => (a.startTime || a.addedAt) >= weekStart);
            const weekKm = weekActs.reduce((sum, a) => sum + (a.distM || 0), 0) / 1000;
            document.getElementById('hub-gpx-week').innerText = `${weekKm.toFixed(1)} km`;
            document.getElementById('hub-gpx-count').innerText = `${weekActs.length} diese Woche · ${acts.length} gesamt`;

            // Wochenziel-Fortschritt (gpx_goals aus dem GPX-Viewer)
            try {
              const goals = Store.getJSON('gpx_goals', null);
              const wrap = document.getElementById('hub-gpx-goal-wrap');
              if (wrap && goals && goals.weekKm > 0) {
                const pct = Math.min(100, (weekKm / goals.weekKm) * 100);
                document.getElementById('hub-gpx-goal-bar').style.width = `${pct}%`;
                document.getElementById('hub-gpx-goal-label').innerText = `Wochenziel: ${Math.round(pct)} % von ${goals.weekKm} km`;
                wrap.classList.remove('hidden');
              } else if (wrap) {
                wrap.classList.add('hidden');
              }
            } catch (e) { /* Ziel-Anzeige optional */ }
          };
        };
        req.onerror = () => {};
      } catch (e) { /* Widget optional */ }
    }

    // ============ Hub-Widgets: Layout (Drag & Drop + Ein-/Ausblenden) ============
    // Reihenfolge in localStorage 'hub_widget_order', ausgeblendete Widgets in
    // 'hub_widget_hidden'. Gezogen wird am Griff-Symbol (erscheint beim Hover).
    const HUB_WIDGET_META = {
      clock: 'Uhr & Wetter jetzt',
      briefing: 'Status-Briefing',
      forecast: 'Wetter (3 Tage)',
      todo: 'To-do-Liste',
      calendar: 'Nächste Termine'
    };

    // Wiederverwendbare Drag-&-Ausblend-Layout-Schicht (Hub + ClimateFlow).
    // Reihenfolge/Sichtbarkeit pro Profil im Store; Interaktion wahlweise per
    // Griff-Ziehen (Hub) oder per Pfeil-Buttons im Panel (ClimateFlow).
    function createLayout(cfg) {
      const getOrder = () => {
        let o = Store.getJSON(cfg.orderKey, []);
        if (!Array.isArray(o)) o = [];
        const known = Object.keys(cfg.meta);
        o = o.filter(id => known.includes(id));
        known.forEach(id => { if (!o.includes(id)) o.push(id); });
        return o;
      };
      const getHidden = () => { const h = Store.getJSON(cfg.hiddenKey, []); return Array.isArray(h) ? h : []; };
      const apply = () => {
        const c = document.getElementById(cfg.container);
        if (!c) return;
        const hidden = new Set(getHidden());
        getOrder().forEach(id => {
          const el = c.querySelector(`[data-widget="${id}"]`);
          if (!el) return;
          c.appendChild(el);
          el.classList.toggle('hidden', hidden.has(id));
        });
      };
      const saveOrder = () => {
        const c = document.getElementById(cfg.container);
        if (!c) return;
        Store.setJSON(cfg.orderKey, [...c.querySelectorAll('[data-widget]')].map(el => el.dataset.widget));
      };
      const move = (id, dir) => {
        const order = getOrder();
        const i = order.indexOf(id), j = i + dir;
        if (i < 0 || j < 0 || j >= order.length) return;
        [order[i], order[j]] = [order[j], order[i]];
        Store.setJSON(cfg.orderKey, order);
        apply(); renderPanel();
      };
      const initDrag = () => {
        const c = document.getElementById(cfg.container);
        if (!c) return;
        c.querySelectorAll('[data-widget]').forEach(el => {
          const grip = el.querySelector('.' + (cfg.gripClass || 'widget-grip'));
          if (grip) {
            grip.addEventListener('mousedown', () => { el.draggable = true; });
            grip.addEventListener('touchstart', () => { el.draggable = true; }, { passive: true });
          }
          el.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', el.dataset.widget); e.dataTransfer.effectAllowed = 'move'; el.classList.add('opacity-50'); });
          el.addEventListener('dragend', () => { el.classList.remove('opacity-50'); el.draggable = false; });
          el.addEventListener('dragover', e => e.preventDefault());
          el.addEventListener('drop', e => {
            e.preventDefault();
            const draggedId = e.dataTransfer.getData('text/plain');
            if (!draggedId || draggedId === el.dataset.widget) return;
            const dragged = c.querySelector(`[data-widget="${draggedId}"]`);
            if (!dragged) return;
            const kids = [...c.querySelectorAll('[data-widget]')];
            if (kids.indexOf(dragged) < kids.indexOf(el)) el.after(dragged); else el.before(dragged);
            saveOrder();
          });
        });
      };
      const renderPanel = () => {
        const list = document.getElementById(cfg.panelList);
        if (!list) return;
        const hidden = new Set(getHidden());
        const order = getOrder();
        list.innerHTML = '';
        order.forEach((id, idx) => {
          const row = document.createElement('div');
          row.className = 'flex items-center gap-2 justify-between';
          const lbl = document.createElement('label');
          lbl.className = 'flex items-center gap-2 cursor-pointer hover:text-white transition-colors min-w-0';
          const cb = document.createElement('input');
          cb.type = 'checkbox'; cb.checked = !hidden.has(id); cb.className = 'accent-teal-500 shrink-0';
          cb.onchange = () => {
            const h = new Set(getHidden());
            if (cb.checked) h.delete(id); else h.add(id);
            Store.setJSON(cfg.hiddenKey, [...h]);
            apply();
          };
          lbl.appendChild(cb);
          lbl.appendChild(document.createTextNode(cfg.meta[id]));
          row.appendChild(lbl);
          if (cfg.reorderButtons) {
            const btns = document.createElement('div');
            btns.className = 'flex gap-0.5 shrink-0';
            const up = document.createElement('button'); up.innerText = '▲'; up.className = 'px-1 text-slate-500 hover:text-white disabled:opacity-20'; up.disabled = idx === 0; up.onclick = () => move(id, -1);
            const dn = document.createElement('button'); dn.innerText = '▼'; dn.className = 'px-1 text-slate-500 hover:text-white disabled:opacity-20'; dn.disabled = idx === order.length - 1; dn.onclick = () => move(id, 1);
            btns.append(up, dn); row.appendChild(btns);
          }
          list.appendChild(row);
        });
      };
      const toggleSettings = () => {
        const panel = document.getElementById(cfg.panel);
        if (!panel) return;
        if (panel.classList.contains('hidden')) { renderPanel(); panel.classList.remove('hidden'); }
        else panel.classList.add('hidden');
      };
      return { apply, initDrag, toggleSettings, saveOrder, getOrder, getHidden, renderPanel, move };
    }

    // Hub-Layout (Griff-Ziehen) — Wrapper erhalten die bestehenden onclick-Handler
    // reorderButtons: Pfeil-Buttons im Panel zusätzlich zum Griff-Ziehen —
    // HTML5-Drag funktioniert auf iOS Safari nicht, die Pfeile schon (Punkt 1).
    const hubLayout = createLayout({ container: 'hub-widgets', meta: HUB_WIDGET_META, orderKey: 'hub_widget_order', hiddenKey: 'hub_widget_hidden', panel: 'widget-settings', panelList: 'widget-settings-list', gripClass: 'widget-grip', reorderButtons: true });
    function applyWidgetLayout() { hubLayout.apply(); }
    function initWidgetDrag() { hubLayout.initDrag(); }
    function toggleWidgetSettings() { hubLayout.toggleSettings(); }

    // ClimateFlow-Layout (P14): Karten aus-/einblenden + per Pfeil ordnen
    const CF_CARD_META = {
      'cf-kpi': 'Messwerte & Wetter',
      'cf-analytics': 'Lüftungsberater & 24h-Statistik',
      'cf-chart': 'Klimaverlauf',
      'cf-archive': 'Langzeit-Archiv',
      'cf-table': 'Rohdaten-Tabelle'
    };
    const climateLayout = createLayout({ container: 'climate-cards', meta: CF_CARD_META, orderKey: 'cf_order', hiddenKey: 'cf_hidden', panel: 'cf-settings', panelList: 'cf-settings-list', reorderButtons: true });
    function applyClimateLayout() { climateLayout.apply(); }
    function toggleClimateSettings() { climateLayout.toggleSettings(); }

    // ============ Hub-Widget: To-do-Liste 2.0 (P12) ============
    // Lokal-first (Store 'hub_todos') mit D1-Sync (/api/todos), Fälligkeiten,
    // Wiederholungen und gemeinsamen Einträgen (für beide Profile sichtbar).
    const DAY_MS = 24 * 60 * 60 * 1000;

    function getTodos() {
      const t = Store.getJSON('hub_todos', []);
      return Array.isArray(t) ? t : [];
    }
    function saveTodos(list, sync = true) {
      Store.setJSON('hub_todos', list);
      renderTodos();
      if (sync) syncTodos();
    }
    function touchTodo(t) { t.updatedAt = Date.now(); return t; }

    // Zwei-Wege-Abgleich mit D1 (LWW über updatedAt, Tombstones via deleted)
    let _todoSyncing = false;
    async function syncTodos() {
      if (_todoSyncing || !(window.Store)) return;
      _todoSyncing = true;
      try {
        const local = getTodos();
        if (local.length) {
          await apiFetch('/api/todos', { method: 'POST', body: JSON.stringify({ items: local }) });
        }
        const data = await apiFetch('/api/todos');
        const server = (data && data.todos) || [];
        const byId = {};
        local.forEach(t => { byId[t.id] = t; });
        server.forEach(t => {
          const cur = byId[t.id];
          if (!cur || (t.updatedAt || 0) >= (cur.updatedAt || 0)) byId[t.id] = t;
        });
        const merged = Object.values(byId);
        Store.setJSON('hub_todos', merged);
        renderTodos();
      } catch (err) {
        if (!err.unavailable) console.warn('To-do-Sync fehlgeschlagen:', err);
        // offline / kein D1 → bleibt rein lokal
      } finally {
        _todoSyncing = false;
      }
    }

    function todoSortKey(t) {
      // offen zuerst; überfällige/fällige nach Datum; undatierte danach; erledigte zuletzt
      if (t.done) return 3e15 + (t.updatedAt || 0);
      if (t.dueMs) return t.dueMs;
      return 2e15 + (t.createdAt || 0);
    }

    // Farbe aus dem Kategorienamen ableiten (stabil, Punkt 19)
    const TODO_COLORS = ['#f97316', '#14b8a6', '#6366f1', '#ec4899', '#eab308', '#22c55e', '#0ea5e9'];
    function categoryColor(cat) {
      if (!cat) return null;
      let hash = 0;
      for (let i = 0; i < cat.length; i++) hash = (hash * 31 + cat.charCodeAt(i)) | 0;
      return TODO_COLORS[Math.abs(hash) % TODO_COLORS.length];
    }
    function endOfToday() { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); }

    function renderTodos() {
      const listEl = document.getElementById('todo-list');
      const countEl = document.getElementById('todo-count');
      if (!listEl) return;
      // Manuelle Position (falls gesetzt) zuerst, sonst die smarte Sortierung
      const todos = getTodos().filter(t => !t.deleted).sort((a, b) => {
        const pa = a.pos || 1e6, pb = b.pos || 1e6;
        return pa !== pb ? pa - pb : todoSortKey(a) - todoSortKey(b);
      });
      const open = todos.filter(t => !t.done).length;
      const overdue = todos.filter(t => !t.done && t.dueMs && t.dueMs < Date.now()).length;
      const todayEnd = endOfToday();
      const dueToday = todos.filter(t => !t.done && t.dueMs && t.dueMs <= todayEnd && t.dueMs >= Date.now()).length;
      if (countEl) countEl.innerText = todos.length ? `${open} offen${overdue ? ` · ${overdue} überfällig` : ''}${dueToday ? ` · ${dueToday} heute` : ''}` : '';

      listEl.innerHTML = '';
      if (todos.length === 0) {
        listEl.innerHTML = '<p class="text-xs text-slate-500">Nichts zu tun 🎉</p>';
        return;
      }
      todos.forEach(t => {
        const isOverdue = !t.done && t.dueMs && t.dueMs < Date.now();
        const row = document.createElement('div');
        row.className = 'flex items-center gap-1.5 group/todo';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!t.done;
        cb.className = 'accent-teal-500 shrink-0 cursor-pointer';
        cb.onchange = () => toggleTodo(t.id, cb.checked);

        // Kategorie-Farbpunkt (Punkt 19)
        const catColor = categoryColor(t.category);
        if (catColor) {
          const dot = document.createElement('span');
          dot.className = 'w-1.5 h-1.5 rounded-full shrink-0';
          dot.style.backgroundColor = catColor;
          dot.title = t.category;
          row.appendChild(dot);
        }

        const mid = document.createElement('div');
        mid.className = 'flex-1 min-w-0';
        const dueBadge = t.dueMs
          ? `<span class="text-[9px] ${isOverdue ? 'text-red-400 font-semibold' : 'text-slate-500'}">${new Date(t.dueMs).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}${t.repeatDays ? ' ↻' : ''}</span>`
          : (t.repeatDays ? '<span class="text-[9px] text-slate-500">↻</span>' : '');
        mid.innerHTML = `<span class="block truncate text-xs ${t.done ? 'line-through text-slate-600' : 'text-slate-300'}">${t.shared ? '<i data-lucide=\'users\' class=\'w-2.5 h-2.5 inline text-indigo-400\'></i> ' : ''}${escapeHtml(t.text)}</span>${dueBadge}`;

        const opts = document.createElement('button');
        opts.className = 'p-0.5 rounded text-slate-600 hover:text-teal-300 opacity-0 group-hover/todo:opacity-100 transition-opacity shrink-0';
        opts.title = 'Fällig/Wiederholung/geteilt';
        opts.innerHTML = '<i data-lucide="sliders-horizontal" class="w-3 h-3"></i>';
        opts.onclick = () => editTodo(t.id);

        const del = document.createElement('button');
        del.className = 'p-0.5 rounded text-slate-600 hover:text-red-400 opacity-0 group-hover/todo:opacity-100 transition-opacity shrink-0';
        del.title = 'Löschen';
        del.innerHTML = '<i data-lucide="x" class="w-3 h-3"></i>';
        del.onclick = () => deleteTodo(t.id);

        row.append(cb, mid, opts, del);
        listEl.appendChild(row);
      });
      updateIcons();
    }

    function toggleTodo(id, checked) {
      const list = getTodos();
      const t = list.find(x => x.id === id);
      if (!t) return;
      t.done = checked;
      touchTodo(t);
      // Wiederkehrende Aufgabe: beim Abhaken den nächsten Termin erzeugen
      if (checked && t.repeatDays > 0) {
        const baseMs = t.dueMs && t.dueMs > Date.now() - 30 * DAY_MS ? t.dueMs : Date.now();
        list.push(touchTodo({
          id: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
          text: t.text, done: false,
          dueMs: baseMs + t.repeatDays * DAY_MS,
          repeatDays: t.repeatDays, shared: t.shared,
          createdAt: Date.now()
        }));
      }
      saveTodos(list);
    }

    function deleteTodo(id) {
      const list = getTodos();
      const t = list.find(x => x.id === id);
      if (!t) return;
      t.deleted = true; // Tombstone (für den Sync), lokal ausgeblendet
      touchTodo(t);
      saveTodos(list);
      // Rückgängig anbieten (Punkt 14)
      showToast('To-do gelöscht.', 'info', {
        label: 'Rückgängig',
        onClick: () => {
          const l = getTodos();
          const item = l.find(x => x.id === id);
          if (item) { item.deleted = false; touchTodo(item); saveTodos(l); }
        }
      });
    }

    async function editTodo(id) {
      const list = getTodos();
      const t = list.find(x => x.id === id);
      if (!t) return;
      const vals = await modalPrompt({
        title: 'To-do bearbeiten',
        description: t.text,
        fields: [
          { key: 'text', label: 'Text', value: t.text },
          { key: 'due', label: 'Fällig am', type: 'date', value: t.dueMs ? new Date(t.dueMs).toISOString().substring(0, 10) : '' },
          { key: 'repeat', label: 'Wiederholung alle X Tage (0 = keine)', type: 'number', value: t.repeatDays || 0 },
          { key: 'category', label: 'Kategorie (optional, für Farbe)', value: t.category || '', placeholder: 'Haushalt' },
          { key: 'pos', label: 'Position (0 = automatisch)', type: 'number', value: t.pos || 0 },
          { key: 'shared', label: 'Gemeinsam (für alle Profile sichtbar)', type: 'checkbox', value: !!t.shared }
        ],
        submitLabel: 'Speichern'
      });
      if (vals === null) return;
      if (vals.text.trim()) t.text = vals.text.trim();
      t.dueMs = vals.due ? new Date(`${vals.due}T09:00:00`).getTime() : null;
      t.repeatDays = Math.max(0, parseInt(vals.repeat, 10) || 0) || null;
      t.category = vals.category.trim() || null;
      t.pos = Math.max(0, parseInt(vals.pos, 10) || 0) || null;
      t.shared = !!vals.shared;
      touchTodo(t);
      saveTodos(list);
      showNotification('To-do aktualisiert.');
    }

    function addTodo(event) {
      event.preventDefault();
      const input = document.getElementById('todo-input');
      const text = input.value.trim();
      if (!text) return;
      const list = getTodos();
      list.push(touchTodo({
        id: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        text, done: false, dueMs: null, repeatDays: null, shared: false,
        createdAt: Date.now()
      }));
      input.value = '';
      saveTodos(list);
    }

    // ============ Hub-Widget: 3-Tage-Wettervorschau ============
    function weatherIconFor(code) {
      if (code === 0) return 'sun';
      if (code >= 1 && code <= 3) return 'cloud-sun';
      if (code === 45 || code === 48) return 'cloud-fog';
      if (code >= 71 && code <= 77) return 'snowflake';
      if (code >= 51 && code <= 82) return 'cloud-rain';
      if (code >= 85 && code <= 86) return 'snowflake';
      if (code >= 95) return 'cloud-lightning';
      return 'cloud-sun';
    }

    async function loadHubForecast() {
      const el = document.getElementById('hub-forecast');
      if (!el || !appState.weatherConfig) return;
      try {
        const conf = appState.weatherConfig;
        // Zusätzlich stündlich Temperatur + Regenwahrscheinlichkeit (Punkt 18)
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${conf.lat}&longitude=${conf.lon}&daily=temperature_2m_max,temperature_2m_min,weather_code&hourly=temperature_2m,precipitation_probability,weather_code&forecast_days=3&timezone=auto&timeformat=unixtime`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP-Fehler: ${res.status}`);
        const data = await res.json();
        const daily = data.daily;
        if (!daily || !daily.time) throw new Error('keine Tagesdaten');
        appState.hourlyWeather = data.hourly || null;

        el.innerHTML = '';
        daily.time.forEach((day, i) => {
          const label = i === 0 ? 'Heute' : new Date(`${day}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'short' });
          const cell = document.createElement('div');
          cell.className = 'bg-slate-900/60 border border-slate-800/60 rounded-xl p-2 text-center cursor-pointer hover:border-slate-700 transition-colors';
          cell.title = getWeatherDescription(daily.weather_code[i]) + ' — für Stunden antippen';
          cell.innerHTML = `
            <p class="text-[10px] text-slate-500 font-semibold">${label}</p>
            <i data-lucide="${weatherIconFor(daily.weather_code[i])}" class="w-4 h-4 mx-auto my-1 text-teal-400"></i>
            <p class="text-[11px] text-slate-200 font-semibold">${Math.round(daily.temperature_2m_max[i])}°<span class="text-slate-500 font-normal"> / ${Math.round(daily.temperature_2m_min[i])}°</span></p>
          `;
          cell.onclick = () => showHourlyForecast(i);
          el.appendChild(cell);
        });
        renderRainHint();
        updateIcons();
      } catch (err) {
        console.warn('Hub-Vorschau fehlgeschlagen:', err);
        el.innerHTML = '<p class="text-xs text-slate-500 col-span-3">Vorschau nicht verfügbar.</p>';
      }
    }

    // Stunden-Leiste für einen Tag im Vorschau-Widget (Punkt 18)
    function showHourlyForecast(dayIndex) {
      const box = document.getElementById('hub-hourly');
      const h = appState.hourlyWeather;
      if (!box || !h || !h.time) return;
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0); dayStart.setDate(dayStart.getDate() + dayIndex);
      const from = dayStart.getTime(), to = from + 24 * 60 * 60 * 1000;
      const now = Date.now();
      const cells = [];
      h.time.forEach((ts, i) => {
        const ms = ts * 1000;
        if (ms < from || ms >= to) return;
        if (dayIndex === 0 && ms < now - 3600000) return; // vergangene Stunden heute überspringen
        const hr = new Date(ms).getHours();
        const pop = h.precipitation_probability ? h.precipitation_probability[i] : null;
        cells.push(`<div class="flex flex-col items-center gap-0.5 shrink-0 w-9">
          <span class="text-[9px] text-slate-500">${hr}h</span>
          <i data-lucide="${weatherIconFor(h.weather_code ? h.weather_code[i] : 0)}" class="w-3.5 h-3.5 text-teal-400"></i>
          <span class="text-[10px] text-slate-200">${Math.round(h.temperature_2m[i])}°</span>
          <span class="text-[9px] ${pop >= 50 ? 'text-blue-400 font-semibold' : 'text-slate-600'}">${pop != null ? pop + '%' : ''}</span>
        </div>`);
      });
      box.innerHTML = `<div class="flex gap-1 overflow-x-auto pt-2 mt-2 border-t border-slate-800/60">${cells.join('')}</div>`;
      box.classList.remove('hidden');
      updateIcons();
    }

    // Regenhinweis: nächster Regen in den kommenden ~12 h (Punkt 18)
    function renderRainHint() {
      const el = document.getElementById('hub-rain-hint');
      const h = appState.hourlyWeather;
      if (!el || !h || !h.time || !h.precipitation_probability) { if (el) el.classList.add('hidden'); return; }
      const now = Date.now();
      let hit = null;
      for (let i = 0; i < h.time.length; i++) {
        const ms = h.time[i] * 1000;
        if (ms < now || ms > now + 12 * 3600000) continue;
        if (h.precipitation_probability[i] >= 60) { hit = { ms, pop: h.precipitation_probability[i] }; break; }
      }
      if (!hit) { el.classList.add('hidden'); return; }
      const t = new Date(hit.ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      el.innerHTML = `<i data-lucide="cloud-rain" class="w-3.5 h-3.5 inline text-blue-400"></i> Regen wahrscheinlich gegen ${t} Uhr (${hit.pop} %).`;
      el.classList.remove('hidden');
    }

    // ============ Hub-Widget: Kalender (.ics über /api/ical) ============
    async function configureIcal() {
      const vals = await modalPrompt({
        title: 'Kalender verbinden',
        description: 'Zwei .ics-Feeds möglich (z. B. privat + gemeinsam) — etwa die „geheime Adresse im iCal-Format" eines Google Kalenders. Leer lassen = deaktivieren.',
        fields: [
          { key: 'url', label: 'Kalender 1 (.ics-URL)', type: 'url', value: Store.get('ical_url') || '' },
          { key: 'url2', label: 'Kalender 2 (optional)', type: 'url', value: Store.get('ical_url2') || '' }
        ],
        submitLabel: 'Speichern'
      });
      if (vals === null) return;
      const setUrl = (key, v) => {
        v = (v || '').trim();
        if (v === '') { Store.remove(key); return true; }
        if (!/^https:\/\//i.test(v)) { showNotification('Bitte eine https://-URL angeben.', 'error'); return false; }
        Store.set(key, v); return true;
      };
      if (!setUrl('ical_url', vals.url)) return;
      if (!setUrl('ical_url2', vals.url2)) return;
      loadHubCalendar(true);
    }

    // Einen .ics-Feed laden und zu konkreten Terminen im Fenster auflösen.
    async function fetchIcalEvents(url, fromMs, toMs) {
      const res = await fetch(`/api/ical?url=${encodeURIComponent(url)}`);
      if (res.status === 404 || res.status === 503 || res.status === 405) { const e = new Error('proxy'); e.unavailable = true; throw e; }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      return expandRecurring(parseIcsEvents(await res.text()), fromMs, toMs);
    }

    // Kalender-Widget: bis zu zwei Feeds (Farbpunkt je Kalender), Punkt 17.
    async function loadHubCalendar(force = false) {
      const el = document.getElementById('hub-cal-list');
      if (!el) return;
      const url1 = Store.get('ical_url');
      const url2 = Store.get('ical_url2');
      if (!url1 && !url2) {
        el.innerHTML = 'Kein Kalender verbunden — über das Zahnrad eine .ics-URL hinterlegen (z. B. Google Kalender „geheime Adresse").';
        return;
      }

      const now = Date.now();
      const from = now - 24 * 60 * 60 * 1000;
      const horizon = now + 14 * 24 * 60 * 60 * 1000;
      const colors = ['bg-orange-400', 'bg-indigo-400'];
      const feeds = [url1, url2].filter(Boolean);

      try {
        let all = [];
        let proxyMissing = false;
        for (let i = 0; i < feeds.length; i++) {
          try {
            const evs = await fetchIcalEvents(feeds[i], from, horizon);
            evs.forEach(e => all.push({ ...e, cal: i }));
          } catch (err) {
            if (err.unavailable) proxyMissing = true; else throw err;
          }
        }
        if (proxyMissing && all.length === 0) {
          el.innerHTML = 'Kalender-Proxy (/api/ical) noch nicht deployt — erscheint nach dem nächsten Cloudflare-Deploy automatisch.';
          return;
        }

        const upcoming = all
          .filter(e => e.startMs >= now - (e.allDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000))
          .sort((a, b) => a.startMs - b.startMs)
          .slice(0, 6);

        if (upcoming.length === 0) {
          el.innerHTML = 'Keine Termine in den nächsten 14 Tagen.';
          return;
        }

        el.innerHTML = '';
        upcoming.forEach(e => {
          const d = new Date(e.startMs);
          const dayLabel = d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
          const row = document.createElement('div');
          row.className = 'flex items-center gap-2';
          const dot = feeds.length > 1 ? `<span class="w-1.5 h-1.5 rounded-full shrink-0 ${colors[e.cal] || colors[0]}"></span>` : '';
          row.innerHTML = `
            ${dot}
            <span class="shrink-0 w-20 text-[10px] font-semibold text-orange-300">${dayLabel}${e.allDay ? '' : ` ${formatTime(d)}`}</span>
            <span class="flex-1 min-w-0 truncate text-slate-300">${escapeHtml(e.summary || '(ohne Titel)')}${e.recurring ? ' ↻' : ''}</span>
          `;
          el.appendChild(row);
        });
      } catch (err) {
        console.warn('Kalender laden fehlgeschlagen:', err);
        el.innerHTML = `Kalender konnte nicht geladen werden: ${escapeHtml(err.message)}`;
      }
    }
