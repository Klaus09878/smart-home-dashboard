// app-archive.js — Teil des ClimateFlow-Hub (aus app.js zerlegt, Plan2-9).
// Langzeit-Archiv (D1), Rekorde, Heatmap, ntfy/Web-Push, CSV-Export
// Klassische Skripte teilen den globalen Scope; Reihenfolge in index.html
// entspricht der urspruenglichen Dateireihenfolge (app-main.js zuletzt).

    // ============ Langzeit-Archiv (Cloudflare D1 über /api/climate) ============
    // Schreibt tägliche Aggregate abgeschlossener Tage in die Datenbank
    // (max. 1×/12h pro Standort). Ohne konfigurierte API/D1 passiert nichts.
    async function archiveClimateDaily() {
      try {
        const locId = appState.activeLocId;
        const throttleKey = `archive_last_${locId}`;
        const last = parseInt(localStorage.getItem(throttleKey) || '0', 10);
        if (Date.now() - last < 12 * 60 * 60 * 1000) return;

        const feeds = appState.insideData;
        if (!feeds || feeds.length === 0) return;

        // Tages-Aggregation (getestete Kernlogik in lib/core.js)
        const todayKey = new Date().toISOString().substring(0, 10);
        const days = aggregateDailyClimate(feeds, todayKey);
        if (days.length === 0) return;

        await apiFetch('/api/climate', { method: 'POST', body: JSON.stringify({ loc: locId, days }) });
        localStorage.setItem(throttleKey, Date.now().toString());
        console.log(`[Archiv] ${days.length} Tages-Aggregate für ${locId} in D1 gesichert.`);
      } catch (err) {
        if (!err.unavailable) console.warn('Klima-Archiv fehlgeschlagen:', err);
      }
    }

    // Rueckwirkender Import eines ThingSpeak-CSV-Exports ins Langzeit-Archiv
    // (P2-3). ThingSpeak haelt nur ~8000 Eintraege — so lassen sich aeltere
    // Messwerte einmalig nachtragen. Aggregation via getestete Kernlogik.
    async function importThingSpeakCsv(event) {
      const file = event.target.files[0];
      event.target.value = '';
      if (!file) return;
      const locId = appState.activeLocId;
      try {
        const rows = parseThingSpeakCsv(await file.text());
        if (rows.length === 0) { showNotification('CSV enthält keine Datenzeilen.', 'error'); return; }
        const { aligned } = processRawFeeds(rows, getLocationFields(locId));
        const todayKey = new Date().toISOString().substring(0, 10);
        const days = aggregateDailyClimate(aligned, todayKey);
        if (days.length === 0) { showNotification('Keine abgeschlossenen Tage im CSV gefunden.', 'error'); return; }
        showNotification(`Importiere ${days.length} Tage für ${getLocationName(locId)}…`);
        // In Bloecken posten (D1-Batch schonen)
        for (let i = 0; i < days.length; i += 300) {
          await apiFetch('/api/climate', { method: 'POST', body: JSON.stringify({ loc: locId, days: days.slice(i, i + 300) }) });
        }
        showNotification(`${days.length} Tage importiert.`);
        appState.archiveLoadedFor = null;
        loadArchiveView(true);
      } catch (err) {
        if (err.unavailable) showNotification('Cloud-Datenbank (D1) nicht eingerichtet — Import nicht möglich.', 'error');
        else showNotification(`Import fehlgeschlagen: ${err.message}`, 'error');
      }
    }

    // ============ Langzeit-Archiv-Ansicht (liest /api/climate) ============
    function toggleArchiveCollapse() { toggleCfCard('cf-archive'); }

    async function loadArchiveView(force = false) {
      const container = document.getElementById('archive-container');
      if (!container || container.classList.contains('hidden')) return;
      const locId = appState.activeLocId;
      if (!force && appState.archiveLoadedFor === locId) return;

      const emptyEl = document.getElementById('archive-empty');
      const wrap = document.getElementById('archive-chart-wrap');
      const showMessage = msg => {
        wrap.classList.add('hidden');
        emptyEl.innerText = msg;
        emptyEl.classList.remove('hidden');
      };

      try {
        const rows = await apiFetch(`/api/climate?loc=${encodeURIComponent(locId)}`);
        appState.archiveLoadedFor = locId;
        if (!rows || rows.length === 0) {
          showMessage('Noch keine Archivdaten vorhanden. Abgeschlossene Tage werden ab jetzt automatisch gesichert — hier entsteht mit der Zeit die Langzeit-Historie.');
          return;
        }
        emptyEl.classList.add('hidden');
        wrap.classList.remove('hidden');
        drawArchiveChart(rows);
        renderArchiveRecords(rows);
      } catch (err) {
        appState.archiveLoadedFor = null;
        if (err.unavailable) {
          showMessage('Cloud-Datenbank (D1) noch nicht eingerichtet — siehe README, Abschnitt „Einrichtung Cloud-Funktionen". Danach erscheinen hier die täglichen Langzeit-Werte.');
        } else {
          showMessage(`Archiv konnte nicht geladen werden: ${err.message}`);
        }
      }
    }

    // Rekorde & Monatsvergleich aus dem Tages-Archiv (P6)
    function renderArchiveRecords(rows) {
      const recEl = document.getElementById('archive-records');
      const cmpEl = document.getElementById('archive-month-compare');
      if (!recEl) return;

      const rec = climateRecords(rows, 80);
      if (!rec) { recEl.classList.add('hidden'); if (cmpEl) cmpEl.classList.add('hidden'); return; }

      const fmtDay = d => { const p = d.split('-'); return `${p[2]}.${p[1]}.`; };
      const card = (label, value, sub, color) => `
        <div class="bg-slate-900/50 border border-slate-800/60 rounded-xl p-2.5 text-center">
          <p class="text-[9px] text-slate-500 uppercase font-semibold">${label}</p>
          <p class="text-sm font-bold ${color} mt-0.5">${value}</p>
          <p class="text-[10px] text-slate-400">${sub}</p>
        </div>`;
      recEl.innerHTML =
        (rec.warmest ? card('Wärmster Tag', `${rec.warmest.value.toFixed(1)} °C`, fmtDay(rec.warmest.day), 'text-orange-400') : '') +
        (rec.coldest ? card('Kältester Tag', `${rec.coldest.value.toFixed(1)} °C`, fmtDay(rec.coldest.day), 'text-blue-400') : '') +
        (rec.wettest ? card('Feuchtester Tag', `${rec.wettest.value.toFixed(0)} %`, fmtDay(rec.wettest.day), 'text-indigo-400') : '') +
        (rec.bestComfort ? card('Bester Komfort', `${rec.bestComfort.score}/100`, fmtDay(rec.bestComfort.day), 'text-emerald-400') : '') +
        card('Wohlfühl-Serie', `${rec.comfortStreak} Tage`, 'am Stück', 'text-teal-400');
      recEl.classList.remove('hidden');

      // Monatsvergleich: aktueller vs. voriger Kalendermonat
      if (cmpEl) {
        const now = new Date();
        const key = (y, m) => `${y}-${String(m + 1).padStart(2, '0')}`;
        const curKey = key(now.getFullYear(), now.getMonth());
        const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const prevKey = key(prev.getFullYear(), prev.getMonth());
        const agg = mk => {
          const sub = rows.filter(r => r.day.startsWith(mk) && r.t_avg != null);
          if (!sub.length) return null;
          const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
          return {
            t: mean(sub.map(r => r.t_avg)),
            h: mean(sub.map(r => r.h_avg).filter(v => v != null)),
            score: Math.round(mean(sub.map(r => comfortScore(r.t_avg, r.h_avg, null, getThresholds())).filter(v => v != null)))
          };
        };
        const c = agg(curKey), p = agg(prevKey);
        if (c && p) {
          const arrow = d => d > 0.1 ? '↑' : d < -0.1 ? '↓' : '→';
          cmpEl.innerHTML = `<strong class="text-slate-200">Monatsvergleich:</strong> Ø ${c.t.toFixed(1)} °C (${arrow(c.t - p.t)} ${(c.t - p.t >= 0 ? '+' : '')}${(c.t - p.t).toFixed(1)} vs. Vormonat), Feuchte ${c.h.toFixed(0)} % (${arrow(c.h - p.h)} ${(c.h - p.h >= 0 ? '+' : '')}${(c.h - p.h).toFixed(0)} %), Komfort ${c.score}/100 (${arrow(c.score - p.score)} ${(c.score - p.score >= 0 ? '+' : '')}${c.score - p.score}).`;
          cmpEl.classList.remove('hidden');
        } else {
          cmpEl.classList.add('hidden');
        }
      }

      renderArchiveYear(rows);
      renderHeatingCost();
    }

    // Gradtagzahlen + Heizkosten-Schaetzung fuer die laufende Heizperiode (P2-17).
    // Aussen-Tagesmittel aus der Open-Meteo Archive-API (best effort, session-
    // gecacht); Kosten optional ueber energy_config.
    async function renderHeatingCost() {
      const wrap = document.getElementById('archive-heating');
      if (!wrap) return;
      const conf = appState.weatherConfig;
      if (!conf) { wrap.classList.add('hidden'); return; }

      const now = new Date();
      const cutoff = new Date(now.getTime() - 6 * 24 * 3600 * 1000); // Archive-API-Verzoegerung ~5 Tage
      const iso = d => d.toISOString().slice(0, 10);
      const heatStartYear = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;
      const period = y => {
        const end = new Date(y + 1, 2, 31);
        return { from: `${y}-10-01`, to: iso(end < cutoff ? end : cutoff) };
      };
      const cur = period(heatStartYear), prev = period(heatStartYear - 1);

      async function fetchMeans(p) {
        if (p.from > p.to) return null; // Periode noch nicht begonnen
        const key = `hdd_${conf.lat}_${conf.lon}_${p.from}_${p.to}`;
        try { const c = sessionStorage.getItem(key); if (c) return JSON.parse(c); } catch (e) { /* egal */ }
        try {
          const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${conf.lat}&longitude=${conf.lon}&start_date=${p.from}&end_date=${p.to}&daily=temperature_2m_mean&timezone=auto`;
          const res = await fetch(url);
          if (!res.ok) return null;
          const d = await res.json();
          const times = (d.daily && d.daily.time) || [];
          const means = (d.daily && d.daily.temperature_2m_mean) || [];
          const out = times.map((day, i) => ({ day, tOut: means[i] })).filter(x => x.tOut != null);
          try { sessionStorage.setItem(key, JSON.stringify(out)); } catch (e) { /* Quota egal */ }
          return out;
        } catch (e) { return null; }
      }

      const curMeans = await fetchMeans(cur);
      if (!curMeans || !curMeans.length) { wrap.classList.add('hidden'); return; }
      const ddCur = degreeDays(curMeans);
      const prevMeans = await fetchMeans(prev);
      const ddPrev = prevMeans && prevMeans.length ? degreeDays(prevMeans) : null;

      const cfg = Store.getJSON('energy_config', { kwhPerDegreeDay: 0, pricePerKwh: 0 }) || {};
      const kwhPerDd = Number(cfg.kwhPerDegreeDay) || 0;
      const price = Number(cfg.pricePerKwh) || 0;
      const euro = (kwhPerDd > 0 && price > 0) ? ddCur.total * kwhPerDd * price : null;

      let deltaHtml = '<span class="text-slate-500">– kein Vorjahresvergleich</span>';
      if (ddPrev && ddPrev.total > 0) {
        const pct = ((ddCur.total - ddPrev.total) / ddPrev.total) * 100;
        const cls = pct > 1 ? 'text-orange-300' : pct < -1 ? 'text-blue-300' : 'text-slate-400';
        const arrow = pct > 1 ? '↑' : pct < -1 ? '↓' : '→';
        deltaHtml = `vs. Vorsaison (${ddPrev.total.toLocaleString('de-DE')} Grdt.): <span class="${cls} font-semibold">${arrow} ${pct >= 0 ? '+' : ''}${pct.toFixed(0)} %</span>`;
      }
      const heatYearLabel = `${heatStartYear}/${String(heatStartYear + 1).slice(2)}`;

      wrap.innerHTML = `
        <div class="flex items-center justify-between gap-2 mb-3">
          <h3 class="text-[11px] font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5"><i data-lucide="flame" class="w-3.5 h-3.5 text-orange-400"></i> Heizperiode ${heatYearLabel}</h3>
          <button data-onclick="editEnergyConfig" title="Heizkosten-Faktoren einstellen" class="p-1.5 rounded-lg border border-slate-800 hover:border-slate-700 text-slate-400 hover:text-white transition-all"><i data-lucide="settings-2" class="w-3.5 h-3.5"></i></button>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <div class="bg-slate-900/50 border border-slate-800/60 rounded-xl p-2.5 text-center">
            <p class="text-[9px] text-slate-500 uppercase font-semibold">Gradtage</p>
            <p class="text-sm font-bold text-orange-300 mt-0.5">${ddCur.total.toLocaleString('de-DE')}</p>
            <p class="text-[10px] text-slate-400">${ddCur.days} Heiztage</p>
          </div>
          ${euro != null ? `<div class="bg-slate-900/50 border border-slate-800/60 rounded-xl p-2.5 text-center">
            <p class="text-[9px] text-slate-500 uppercase font-semibold">Schätzkosten</p>
            <p class="text-sm font-bold text-emerald-300 mt-0.5">${euro.toLocaleString('de-DE', { maximumFractionDigits: 0 })} €</p>
            <p class="text-[10px] text-slate-400">${kwhPerDd} kWh/Grdt · ${price.toString().replace('.', ',')} €/kWh</p>
          </div>` : `<div class="bg-slate-900/50 border border-slate-800/60 rounded-xl p-2.5 text-center flex flex-col justify-center">
            <p class="text-[10px] text-slate-500">Für eine Kostenschätzung kWh/Gradtag und Strompreis über das Zahnrad hinterlegen.</p>
          </div>`}
          <div class="bg-slate-900/50 border border-slate-800/60 rounded-xl p-2.5 text-center flex flex-col justify-center col-span-2 sm:col-span-1">
            <p class="text-[9px] text-slate-500 uppercase font-semibold">Vergleich</p>
            <p class="text-[11px] mt-0.5">${deltaHtml}</p>
          </div>
        </div>`;
      wrap.classList.remove('hidden');
      updateIcons();
    }

    async function editEnergyConfig() {
      const cfg = Store.getJSON('energy_config', { kwhPerDegreeDay: 0, pricePerKwh: 0 }) || {};
      const vals = await modalPrompt({
        title: 'Heizkosten-Faktoren',
        description: 'Grobe Schätzung: Gradtage × kWh je Gradtag × Preis je kWh. Beide 0 lassen = nur Gradtage anzeigen.',
        fields: [
          { key: 'kwhPerDegreeDay', label: 'kWh pro Gradtag', type: 'number', value: cfg.kwhPerDegreeDay || '' },
          { key: 'pricePerKwh', label: 'Preis pro kWh (€)', type: 'number', value: cfg.pricePerKwh || '' }
        ]
      });
      if (!vals) return;
      const n = v => parseFloat(String(v).replace(',', '.')) || 0;
      Store.setJSON('energy_config', { kwhPerDegreeDay: n(vals.kwhPerDegreeDay), pricePerKwh: n(vals.pricePerKwh) });
      renderHeatingCost();
    }

    // Jahres-Heatmap + Saisonvergleich (P9). Nutzt yearHeatmap/periodCompare aus
    // lib/core.js. Farbe = Tagesmittel-Temperatur (blau kalt → rot warm).
    function tempToColor(t, min, max) {
      if (t == null || min == null || max == null || max === min) return 'rgba(100,116,139,0.22)';
      const f = Math.max(0, Math.min(1, (t - min) / (max - min)));
      const r = Math.round(59 + f * (239 - 59));
      const g = Math.round(130 - f * (130 - 68));
      const b = Math.round(246 - f * (246 - 68));
      return `rgb(${r},${g},${b})`;
    }

    function renderArchiveYear(rows) {
      const wrap = document.getElementById('archive-year');
      if (!wrap) return;
      const years = [...new Set((rows || []).filter(r => r.t_avg != null).map(r => r.day.slice(0, 4)))].sort();
      if (years.length === 0) { wrap.classList.add('hidden'); return; }
      if (!appState.archiveYear || !years.includes(String(appState.archiveYear))) {
        appState.archiveYear = Number(years[years.length - 1]);
      }
      const year = appState.archiveYear;
      const hm = yearHeatmap(rows, year);
      const byDay = {}; hm.days.forEach(d => { byDay[d.day] = d; });
      const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

      // Jahr-Umschalter
      const yearBtns = years.map(y =>
        `<button data-year="${y}" class="px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${Number(y) === year ? 'bg-teal-500/20 text-teal-300 border border-teal-500/30' : 'text-slate-400 hover:text-white border border-slate-800'}">${y}</button>`
      ).join('');

      // Heatmap: 12 Monatszeilen à max. 31 Tageszellen
      let grid = '';
      for (let m = 0; m < 12; m++) {
        const mm = String(m + 1).padStart(2, '0');
        const daysInMonth = new Date(year, m + 1, 0).getDate();
        let cells = '';
        for (let d = 1; d <= 31; d++) {
          if (d > daysInMonth) { cells += '<div></div>'; continue; }
          const dayKey = `${year}-${mm}-${String(d).padStart(2, '0')}`;
          const rec = byDay[dayKey];
          const color = rec ? tempToColor(rec.tAvg, hm.min, hm.max) : 'rgba(100,116,139,0.12)';
          const hasNote = rec && rec.note;
          const title = rec ? `${dayKey}: Ø ${rec.tAvg.toFixed(1)} °C${rec.hAvg != null ? `, ${rec.hAvg.toFixed(0)} %` : ''}${hasNote ? ` — ${rec.note}` : ''}` : `${dayKey}: keine Daten`;
          // Tage mit Notiz (P3-7) bekommen einen weissen Rahmen
          const noteStyle = hasNote ? 'box-shadow:inset 0 0 0 1px rgba(255,255,255,.75);' : '';
          cells += `<div data-day="${dayKey}" title="${title.replace(/"/g, '&quot;')}" class="aspect-square rounded-[3px] ${rec ? 'cursor-pointer hover:ring-1 hover:ring-white/40' : ''}" style="background:${color};${noteStyle}"></div>`;
        }
        grid += `<div class="flex items-center gap-1.5">
          <span class="w-7 shrink-0 text-[10px] text-slate-500 text-right">${MONTHS[m]}</span>
          <div class="grid gap-[2px] flex-1" style="grid-template-columns:repeat(31,minmax(0,1fr))">${cells}</div>
        </div>`;
      }

      // Saisonvergleich: aktueller Monat vs. gleicher Monat im Vorjahr + Heizperiode
      const now = new Date();
      const curM = String(now.getMonth() + 1).padStart(2, '0');
      const lastDayCur = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const monthName = now.toLocaleDateString('de-DE', { month: 'long' });
      const cmpMonth = periodCompare(rows,
        { from: `${now.getFullYear()}-${curM}-01`, to: `${now.getFullYear()}-${curM}-${String(lastDayCur).padStart(2, '0')}` },
        { from: `${now.getFullYear() - 1}-${curM}-01`, to: `${now.getFullYear() - 1}-${curM}-31` });
      // Heizperiode Okt–Mär (aktuell laufende vs. Vorjahres-Periode)
      const heatStartYear = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;
      const heatP = y => ({ from: `${y}-10-01`, to: `${y + 1}-03-31` });
      const cmpHeat = periodCompare(rows, heatP(heatStartYear), heatP(heatStartYear - 1));

      const deltaSpan = (d, unit, digits = 1) => {
        if (d == null) return '<span class="text-slate-500">–</span>';
        const cls = d > 0.1 ? 'text-orange-300' : d < -0.1 ? 'text-blue-300' : 'text-slate-400';
        const arrow = d > 0.1 ? '↑' : d < -0.1 ? '↓' : '→';
        return `<span class="${cls} font-semibold">${arrow} ${d >= 0 ? '+' : ''}${d.toFixed(digits)}${unit}</span>`;
      };
      const cmpRow = (label, r) => (r.a && r.b)
        ? `<div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"><span class="text-slate-300 font-semibold">${label}:</span> <span>Ø ${r.a.tAvg.toFixed(1)} °C vs. ${r.b.tAvg.toFixed(1)} °C ${deltaSpan(r.deltaT, ' °C')}</span>${r.deltaH != null ? `<span class="text-slate-500">·</span> <span>Feuchte ${deltaSpan(r.deltaH, ' %', 0)}</span>` : ''}</div>`
        : `<div class="text-slate-500">${label}: noch keine Vergleichsdaten</div>`;

      wrap.innerHTML = `
        <div class="flex items-center justify-between gap-2 mb-3">
          <h3 class="text-[11px] font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5"><i data-lucide="calendar-range" class="w-3.5 h-3.5 text-teal-400"></i> Jahr & Saison</h3>
          <div class="flex gap-1" id="archive-year-btns">${yearBtns}</div>
        </div>
        <div class="flex flex-col gap-1">${grid}</div>
        <div class="flex items-center gap-2 mt-2 text-[10px] text-slate-500">
          <span>kühler</span>
          <span class="h-2 flex-1 rounded-full max-w-[120px]" style="background:linear-gradient(to right,rgb(59,130,246),rgb(239,68,68))"></span>
          <span>wärmer</span>
        </div>
        <div class="mt-4 space-y-1.5 text-xs text-slate-400 bg-slate-900/50 border border-slate-800/60 rounded-xl p-3">
          ${cmpRow(`${monthName} vs. Vorjahr`, cmpMonth)}
          ${cmpRow('Heizperiode vs. Vorjahr', cmpHeat)}
        </div>`;
      wrap.classList.remove('hidden');

      wrap.querySelectorAll('#archive-year-btns [data-year]').forEach(btn =>
        btn.addEventListener('click', () => { appState.archiveYear = Number(btn.dataset.year); renderArchiveYear(rows); }));
      wrap.querySelectorAll('[data-day]').forEach(cell =>
        cell.addEventListener('click', () => {
          const idx = (appState.archiveRows || []).findIndex(x => x.day === cell.dataset.day);
          if (idx >= 0) showArchiveDayDetail(idx);
        }));
      updateIcons();
    }

    async function drawArchiveChart(rows) {
      await ensureChartJs(); // Chart-Stack bei Bedarf nachladen (P2-19)
      appState.archiveRows = rows; // für den Tages-Detail-Klick (Punkt 21)
      const ctx = document.getElementById('archiveChart').getContext('2d');
      const labels = rows.map(r => {
        const parts = r.day.split('-');
        return `${parts[2]}.${parts[1]}.`;
      });

      const config = {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'Max (°C)', data: rows.map(r => r.t_max), borderColor: 'rgba(249,115,22,0.7)', backgroundColor: 'rgba(249,115,22,0.12)', borderWidth: 1, pointRadius: 0, tension: 0.3, fill: '+1', yAxisID: 'yT' },
            { label: 'Min (°C)', data: rows.map(r => r.t_min), borderColor: 'rgba(59,130,246,0.7)', borderWidth: 1, pointRadius: 0, tension: 0.3, fill: false, yAxisID: 'yT' },
            { label: 'Mittel (°C)', data: rows.map(r => r.t_avg), borderColor: '#f8fafc', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: false, yAxisID: 'yT' },
            { label: 'Feuchte Ø (%)', data: rows.map(r => r.h_avg), borderColor: '#6366f1', borderDash: [5, 5], borderWidth: 1.5, pointRadius: 0, tension: 0.3, fill: false, yAxisID: 'yH' },
            // Komfort-Score pro Tag (0–100, rechte Achse) aus den Tages-Mitteln
            { label: 'Komfort-Score', data: rows.map(r => comfortScore(r.t_avg, r.h_avg, null, getThresholds())), borderColor: '#10b981', borderWidth: 1.5, pointRadius: 0, tension: 0.3, fill: false, yAxisID: 'yH' }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          onClick: (evt, els) => { if (els && els.length) showArchiveDayDetail(els[0].index); },
          plugins: {
            legend: { display: true, labels: { color: '#94a3b8', font: { size: 10 }, boxWidth: 12 } },
            tooltip: { backgroundColor: 'rgba(15, 23, 42, 0.95)', titleColor: '#f8fafc', bodyColor: '#cbd5e1' }
          },
          scales: {
            x: { grid: { color: 'rgba(255,255,255,0.02)' }, ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 10 } },
            yT: { position: 'left', grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#94a3b8', callback: v => `${v}°` } },
            yH: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, ticks: { color: '#94a3b8', callback: v => `${v}%` } }
          }
        }
      };

      if (appState.archiveChart) appState.archiveChart.destroy();
      appState.archiveChart = new Chart(ctx, config);
    }

    // Tagesdetail beim Klick auf einen Archiv-Tag (Punkt 21): Werte + Komfort +
    // Vergleich „dieser Tag vor einem Jahr".
    function showArchiveDayDetail(index) {
      const rows = appState.archiveRows || [];
      const r = rows[index];
      if (!r) return;
      const th = getThresholds();
      const num = (v, d = 1, u = '') => (v == null || isNaN(v)) ? '–' : `${v.toFixed(d).replace('.', ',')}${u}`;
      const score = comfortScore(r.t_avg, r.h_avg, null, th);
      const d = new Date(`${r.day}T12:00:00`);
      const dayLabel = d.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

      // gleicher Tag im Vorjahr
      const p = r.day.split('-');
      const lastYearDay = `${+p[0] - 1}-${p[1]}-${p[2]}`;
      const ly = rows.find(x => x.day === lastYearDay);
      const cmp = ly
        ? `<div class="mt-3 pt-3 border-t border-slate-800/60 text-xs text-slate-400">Vor einem Jahr (${lastYearDay}): Ø ${num(ly.t_avg, 1, ' °C')}, Feuchte ${num(ly.h_avg, 0, ' %')}, Komfort ${comfortScore(ly.t_avg, ly.h_avg, null, th) ?? '–'}/100.</div>`
        : '';

      const overlay = document.createElement('div');
      overlay.className = 'fixed inset-0 z-[1700] bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in';
      overlay.innerHTML = `
        <div class="glass-panel rounded-2xl p-6 shadow-2xl w-full max-w-sm">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-base font-bold text-white">${dayLabel}</h3>
            <button data-x class="p-1.5 rounded-lg text-slate-500 hover:text-white"><i data-lucide="x" class="w-4 h-4"></i></button>
          </div>
          <div class="grid grid-cols-3 gap-2 text-center">
            <div class="bg-slate-900/60 border border-slate-800/60 rounded-xl p-2"><p class="text-[10px] text-slate-500 uppercase">Temp Ø</p><p class="text-sm font-bold text-white">${num(r.t_avg, 1, ' °C')}</p></div>
            <div class="bg-slate-900/60 border border-slate-800/60 rounded-xl p-2"><p class="text-[10px] text-slate-500 uppercase">Min/Max</p><p class="text-sm font-bold text-white">${num(r.t_min, 0)}/${num(r.t_max, 0)}°</p></div>
            <div class="bg-slate-900/60 border border-slate-800/60 rounded-xl p-2"><p class="text-[10px] text-slate-500 uppercase">Feuchte Ø</p><p class="text-sm font-bold text-indigo-400">${num(r.h_avg, 0, ' %')}</p></div>
          </div>
          <div class="mt-2 text-center"><span class="text-xs text-slate-400">Komfort-Score: </span><span class="text-sm font-bold text-emerald-400">${score ?? '–'}/100</span>${r.samples ? ` <span class="text-[10px] text-slate-500">· ${r.samples} Messungen</span>` : ''}</div>
          ${cmp}
          <div class="mt-3 pt-3 border-t border-slate-800/60">
            <label class="text-[11px] text-slate-500 uppercase font-semibold">Notiz</label>
            <textarea data-note rows="2" maxlength="280" placeholder="Ereignis an diesem Tag (z. B. Fenster getauscht, Urlaub) …" class="mt-1 w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-teal-500/50 focus:outline-none resize-y">${escapeHtml(r.note || '')}</textarea>
            <button data-save-note class="mt-1.5 w-full px-3 py-1.5 rounded-lg bg-teal-500/15 border border-teal-500/30 text-teal-200 hover:bg-teal-500/25 text-xs font-semibold transition-colors">Notiz speichern</button>
          </div>
        </div>`;
      const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
      const onKey = e => { if (e.key === 'Escape') close(); };
      overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
      overlay.querySelector('[data-x]').onclick = close;
      // Tagesnotiz speichern (P3-7)
      const saveNoteBtn = overlay.querySelector('[data-save-note]');
      if (saveNoteBtn) saveNoteBtn.onclick = async () => {
        const note = overlay.querySelector('[data-note]').value;
        try {
          await apiFetch('/api/climate', { method: 'PUT', body: JSON.stringify({ loc: appState.activeLocId, day: r.day, note }) });
          r.note = note.trim() || null; // lokalen Cache aktualisieren
          showNotification('Notiz gespeichert.');
          close();
          renderArchiveYear(appState.archiveRows || []); // Markierung aktualisieren
        } catch (e) { showNotification('Speichern fehlgeschlagen (Cloud-DB nötig).', 'error'); }
      };
      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
      updateIcons();
    }

    // ============ Push-Benachrichtigungen (ntfy.sh) ============
    async function configureNtfy() {
      const current = getNtfyTopic();
      const vals = await modalPrompt({
        title: 'Push-Benachrichtigungen (ntfy.sh)',
        description: 'Lade die kostenlose ntfy-App aufs Handy und abonniere dasselbe Topic. Der Name sollte geheim sein (wie ein Passwort). Leer lassen = deaktivieren.',
        fields: [{ key: 'topic', label: 'ntfy-Topic', value: current || 'smarthub-' + Math.random().toString(36).substring(2, 8) }],
        submitLabel: 'Speichern'
      });
      if (vals === null) return;
      if (vals.topic.trim() === '') {
        Store.remove('ntfy_topic');
        showNotification('Push-Benachrichtigungen deaktiviert.');
      } else {
        Store.set('ntfy_topic', vals.topic.trim());
        showNotification('Push aktiviert – Test-Nachricht gesendet.');
        sendPush('Smart Home Hub', 'Push-Benachrichtigungen sind eingerichtet ✔', 'tada');
      }
      updateNtfyButton();
    }

    function updateNtfyButton() {
      const btn = document.getElementById('ntfy-btn');
      if (btn) btn.classList.toggle('text-teal-400', !!getNtfyTopic());
    }

    // ============ Web Push (Push API, Plan-Punkt 7) ============
    // Native System-Benachrichtigungen ohne ntfy-App. Der oeffentliche VAPID-
    // Schluessel kommt vom Server (/api/push); pro Geraet wird eine Subscription
    // angelegt und in D1 gespeichert. Serverseitig verteilt _notify.js an ntfy
    // UND Web-Push. Ohne VAPID-Env-Vars bleibt der Button ausgeblendet.
    const _webpush = { configured: false, vapidKey: null };

    function urlB64ToUint8Array(b64) {
      const pad = '='.repeat((4 - b64.length % 4) % 4);
      const base64 = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(base64);
      const arr = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
      return arr;
    }

    async function currentPushSub() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
      const reg = await navigator.serviceWorker.getRegistration();
      return reg ? reg.pushManager.getSubscription() : null;
    }

    function updateWebPushButton(active) {
      const btn = document.getElementById('webpush-btn');
      const label = document.getElementById('webpush-btn-label');
      if (btn) btn.classList.toggle('text-teal-400', active);
      if (label) label.textContent = active ? 'Web-Push aktiv (deaktivieren)' : 'Web-Push auf diesem Gerät';
    }

    async function initWebPushUI() {
      const btn = document.getElementById('webpush-btn');
      const hint = document.getElementById('webpush-hint');
      if (!btn) return;
      let data = null;
      try { data = await apiFetch('/api/push'); } catch (e) { data = null; }
      _webpush.configured = !!(data && data.configured);
      _webpush.vapidKey = data && data.vapidPublicKey;

      const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
      if (!_webpush.configured || !supported) {
        btn.classList.add('hidden');
        if (hint) hint.classList.add('hidden');
        // iOS: Push nur in der installierten PWA moeglich
        if (hint && _webpush.configured && /iP(hone|ad|od)/.test(navigator.userAgent) &&
            !window.matchMedia('(display-mode: standalone)').matches) {
          hint.textContent = 'Web-Push auf dem iPhone: zuerst über „Teilen → Zum Home-Bildschirm" installieren.';
          hint.classList.remove('hidden');
        }
        return;
      }
      btn.classList.remove('hidden');
      if (hint) hint.classList.add('hidden');
      updateWebPushButton(!!(await currentPushSub()));
    }

    async function toggleWebPush() {
      try {
        const existing = await currentPushSub();
        if (existing) {
          try { await apiFetch('/api/push', { method: 'DELETE', body: JSON.stringify({ endpoint: existing.endpoint }) }); } catch (e) { /* Server ggf. offline */ }
          await existing.unsubscribe();
          updateWebPushButton(false);
          showNotification('Web-Push auf diesem Gerät deaktiviert.');
          return;
        }
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { showNotification('Benachrichtigungen wurden nicht erlaubt.', 'error'); return; }
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(_webpush.vapidKey)
        });
        await apiFetch('/api/push', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
        updateWebPushButton(true);
        showNotification('Web-Push auf diesem Gerät aktiviert ✔');
      } catch (err) {
        console.warn('Web-Push fehlgeschlagen:', err);
        showNotification('Web-Push konnte nicht aktiviert werden.', 'error');
      }
    }

    // ============ CSV-Export der aktuellen Messreihe ============
    // Exportiert die abgeglichenen Innen-Messwerte (appState.insideData) des aktiven
    // Standorts als CSV. Deutsch-/Excel-freundlich: Semikolon als Trenner,
    // Komma als Dezimalzeichen. Rechnet absolute Feuchte & Taupunkt gleich mit.
    function exportClimateCsv() {
      const feeds = appState.insideData;
      if (!feeds || feeds.length === 0) {
        showNotification('Keine Messwerte zum Exportieren vorhanden.', 'error');
        return;
      }
      if (appState.isDemoMode) {
        showNotification('Demo-Modus aktiv – es liegen keine echten Messwerte vor.', 'error');
        return;
      }

      const num = (v, d) => (v === null || v === undefined || isNaN(v)) ? '' : v.toFixed(d).replace('.', ',');
      const extras = getLocationFields(appState.activeLocId).extra || [];
      const header = ['Zeit (ISO)', 'Datum', 'Uhrzeit', 'Temperatur (°C)', 'Luftfeuchte (%)', 'Absolute Feuchte (g/m³)', 'Taupunkt (°C)',
        ...extras.map(e => `${e.label || e.key}${e.unit ? ` (${e.unit})` : ''}`), 'Eintrag-ID'];
      const rows = feeds.map(f => {
        const ah = getAbsoluteHumidity(f.temp, f.humidity);
        const dp = getDewPoint(f.temp, f.humidity);
        return [
          f.time.toISOString(),
          formatDate(f.time),
          formatTime(f.time),
          num(f.temp, 1),
          num(f.humidity, 0),
          num(ah, 2),
          num(dp, 1),
          ...extras.map(e => num(f[e.key], e.decimals !== undefined ? e.decimals : 0)),
          f.id != null ? f.id : ''
        ].join(';');
      });

      const safeName = getLocationName(appState.activeLocId).replace(/[^\wäöüÄÖÜß-]+/g, '_');
      const stamp = new Date().toISOString().substring(0, 10);
      downloadCsv(`climateflow_${safeName}_${stamp}.csv`, [header.join(';'), ...rows]);
      showNotification(`${feeds.length} Messwerte als CSV exportiert.`);
    }

    // CSV-Export der D1-Langzeitdaten (Tages-Aggregate inkl. Komfort-Score)
    async function exportArchiveCsv() {
      try {
        const locId = appState.activeLocId;
        const rows = await apiFetch(`/api/climate?loc=${encodeURIComponent(locId)}`);
        if (!rows || rows.length === 0) {
          showNotification('Noch keine Archivdaten vorhanden.', 'error');
          return;
        }
        const th = getThresholds();
        const num = (v, d = 1) => (v === null || v === undefined || isNaN(v)) ? '' : v.toFixed(d).replace('.', ',');
        const header = ['Tag', 'Temp Min (°C)', 'Temp Mittel (°C)', 'Temp Max (°C)', 'Feuchte Min (%)', 'Feuchte Mittel (%)', 'Feuchte Max (%)', 'Komfort-Score', 'Messwerte', 'CO2 Mittel (ppm)', 'CO2 Max (ppm)'];
        const lines = rows.map(r => [
          r.day,
          num(r.t_min), num(r.t_avg), num(r.t_max),
          num(r.h_min, 0), num(r.h_avg, 0), num(r.h_max, 0),
          comfortScore(r.t_avg, r.h_avg, null, th) ?? '',
          r.samples ?? '',
          num(r.co2_avg, 0), num(r.co2_max, 0)
        ].join(';'));
        const safeName = getLocationName(locId).replace(/[^\wäöüÄÖÜß-]+/g, '_');
        downloadCsv(`climateflow_archiv_${safeName}.csv`, [header.join(';'), ...lines]);
        showNotification(`${rows.length} Archiv-Tage als CSV exportiert.`);
      } catch (err) {
        showNotification(err.unavailable
          ? 'Cloud-Datenbank (D1) noch nicht eingerichtet — kein Archiv vorhanden.'
          : `Archiv-Export fehlgeschlagen: ${err.message}`, 'error');
      }
    }
