// app-main.js — Teil des ClimateFlow-Hub (aus app.js zerlegt, Plan2-9).
// Hash-Routing, Status-Briefing, init (laedt ZULETZT)
// Klassische Skripte teilen den globalen Scope; Reihenfolge in index.html
// entspricht der urspruenglichen Dateireihenfolge (app-main.js zuletzt).

    // ============ HUB NAVIGATION (Hash-Routing) ============
    const HUB_VIEWS = ['home', 'climate', 'settings'];

    function navigateTo(view) {
      if (location.hash === `#${view}`) {
        handleRoute();
      } else {
        location.hash = view;
      }
    }

    // Synchroner View-Wechsel — KEIN Store-Zugriff, kein await, keine Datenlader.
    // Wird beim Start VOR jedem await aufgerufen, damit das Geruest schon beim
    // ersten Paint sichtbar ist (Plan4-2, behebt den Footer-Blitzer). Liefert den
    // aufgeloesten View-Namen zurueck (null bei #gpx-Umleitung).
    function renderRoute() {
      let view = (location.hash || '').replace('#', '');

      // Der GPX-Viewer ist eine eigenständige Seite (alte #gpx-Links umleiten)
      if (view === 'gpx') {
        location.replace('gpx.html');
        return null;
      }

      if (!HUB_VIEWS.includes(view)) view = 'home';

      HUB_VIEWS.forEach(id => {
        const el = document.getElementById(`view-${id}`);
        if (!el) return;
        if (id === view) {
          el.classList.remove('hidden');
          el.classList.add('flex');
        } else {
          el.classList.add('hidden');
          el.classList.remove('flex');
        }
      });

      document.title = view === 'climate' ? 'ClimateFlow | Smart Home Hub' : 'Smart Home Hub';

      updateIcons();
      return view;
    }

    // Datenlader je View — liest Einstellungen und ruft Netz-Loader, laeuft daher
    // erst NACH Store.init (appState.initDone). Vom Geruest-Rendern getrennt.
    function loadRouteData(view) {
      // Klimadaten erst beim ersten Öffnen des Dashboards laden (Performance)
      if (view === 'climate') {
        applyClimateLayout(); // gespeicherte Karten-Reihenfolge/-Sichtbarkeit
        applyCfCollapse();    // gespeicherter Einklapp-/Kompakt-Zustand
        if (!appState.climateLoaded) {
          appState.climateLoaded = true;
          // Bevorzugten Chart-Zeitraum anwenden (Plan4-10)
          const cp = getChartPrefs();
          appState.currentChartTimeframe = (cp.rememberLast && cp.lastTf) || cp.defaultTf;
          highlightTfButton(appState.currentChartTimeframe);
          reloadData();
          // "Alle" als Standard: volle Historie nachladen und neu zeichnen
          if (appState.currentChartTimeframe === -1) ensureFullHistory().then(drawChart);
        } else if (appState.chartInstance) {
          // Chart neu dimensionieren, falls die View zwischenzeitlich versteckt war
          appState.chartInstance.resize();
        }
      }

      // Hub-Widgets aktualisieren
      if (view === 'home') {
        updateHubClock();
        loadHubWeather();
        loadHubPreviews();
        loadGpxWidget();
        renderTodos();
        syncTodos();
        loadHubForecast();
        loadHubCalendar();
      }

      if (view === 'settings') renderSettings();
    }

    // hashchange- und Navigations-Handler: rendert das Geruest immer sofort;
    // die Datenlader laufen erst, wenn init() fertig ist (sonst lesen sie
    // Einstellungen, bevor der Store bereit ist).
    function handleRoute() {
      const view = renderRoute();
      if (view && appState.initDone) loadRouteData(view);
    }

    // Uhr, Datum & Begrüßung auf dem Hub-Homescreen
    function updateHubClock() {
      const clockEl = document.getElementById('hub-clock');
      const dateEl = document.getElementById('hub-date');
      const greetEl = document.getElementById('hub-greeting');
      if (!clockEl) return;

      const now = new Date();
      clockEl.innerText = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      if (dateEl) dateEl.innerText = now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

      if (greetEl) {
        const h = now.getHours();
        const greeting = h < 5 ? 'Gute Nacht' : h < 11 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend';
        const name = getProfileDisplayName();
        greetEl.innerText = name ? `${greeting}, ${name}` : greeting;
      }
    }

    // Anzeigename des aktiven Profils (aus Store, „default" wird nicht angezeigt)
    function getProfileDisplayName() {
      const p = (window.Store && Store.profile) || 'default';
      if (!p || p === 'default') return '';
      return p.charAt(0).toUpperCase() + p.slice(1);
    }

    // Abmelden (Punkt 28). Bei Cloudflare Access über dessen Logout-URL, sonst
    // per 401-Endpunkt (verwirft die gespeicherten Basic-Auth-Zugangsdaten).
    async function logout() {
      const ok = await modalConfirm({ title: 'Abmelden?', message: 'Du wirst abgemeldet und musst dich neu anmelden.', confirmLabel: 'Abmelden' });
      if (!ok) return;
      if (window.Store && Store.authMode === 'access') {
        location.href = '/cdn-cgi/access/logout';
        return;
      }
      try { await fetch('/api/logout', { cache: 'no-store' }); } catch (e) { /* offline — Cookie laeuft dann einfach ab */ }
      location.href = 'login.html';
    }

    // Theme umschalten (Punkt 10) — pro Profil im Store gespeichert
    function toggleTheme() {
      const next = getTheme() === 'light' ? 'dark' : 'light';
      applyTheme(next);
      Store.set('theme', next);
      renderSettings();
      showNotification(next === 'light' ? 'Heller Modus aktiv.' : 'Dunkler Modus aktiv.');
    }

    // Kleines Profil-Abzeichen im Hub-Header (Name + Abmelde-Hinweis)
    function updateProfileBadge() {
      const el = document.getElementById('profile-badge');
      if (!el) return;
      const name = getProfileDisplayName();
      if (!name) { el.classList.add('hidden'); return; }
      el.classList.remove('hidden');
      const nameEl = document.getElementById('profile-badge-name');
      if (nameEl) nameEl.innerText = name;
    }

    // Aktuelles Außenwetter für die Widget-Leiste auf dem Hub
    async function loadHubWeather() {
      const el = document.getElementById('hub-weather-text');
      if (!el || !appState.weatherConfig) return;
      try {
        const conf = appState.weatherConfig;
        // Gebuendelter Abruf (Plan4-8): teilt sich den Cache mit der Vorschau —
        // gleiche forecastDays wie das Vorschau-Widget nutzen (Plan4-11).
        const data = await getHubWeather(conf.lat, conf.lon, getWidgetPrefs().forecastDays);
        el.innerText = `${data.current.temperature_2m.toFixed(1)} °C · ${getWeatherDescription(data.current.weather_code)} · ${conf.name}`;
      } catch (err) {
        console.warn('Hub-Wetter fehlgeschlagen:', err);
        el.innerText = 'Wetter nicht verfügbar';
      }
    }

    // Kompakte Live-Vorschau beider Standorte auf der ClimateFlow-Kachel.
    // Lädt nur die letzten 400 Einträge pro Kanal und ist auf 2 Minuten gedrosselt.
    async function loadHubPreviews(force = false) {
      // Drossel-Abstand pro Profil einstellbar (Plan4-9, app_prefs.hubPreviewMin).
      if (!force && Date.now() - appState.hubPreviewAt < getAppPrefs().hubPreviewMin * 60 * 1000) return;
      appState.hubPreviewAt = Date.now();

      loadHubWeather();

      // Signale fuers Status-Briefing sammeln (pro Standort), am Ende gebuendelt
      // an renderBriefing. Rohe Werte kommen aus der ohnehin geladenen Vorschau.
      const signals = [];

      await Promise.all(LOCATIONS.map(async loc => {
        const el = suffix => document.getElementById(`hub-prev-${loc.id}-${suffix}`);
        const shortName = getLocationName(loc.id).replace('Schlafzimmer ', '');
        const nameEl = el('name');
        if (nameEl) nameEl.innerText = shortName;

        try {
          const data = await fetchFeeds(loc, { results: 400 });
          const processed = processRawFeeds((data && data.feeds) || [], loc.fields);
          processed.aligned = calibratedAligned(loc.id, processed.aligned); // Kalibrierung (P3-6)

          // Sensor-Status-Punkt: grün wenn beide Felder frisch, sonst rot
          const fresh = t => t instanceof Date && (Date.now() - t.getTime()) < SENSOR_STALE_MS;
          const ok = fresh(processed.lastTempTime) && fresh(processed.lastHumTime);
          const dot = el('dot');
          if (dot) {
            dot.className = `w-1.5 h-1.5 rounded-full inline-block ${ok ? 'bg-emerald-500' : 'bg-red-500 animate-pulse'}`;
            dot.title = ok ? 'Beide Sensoren liefern Daten' : 'Mindestens ein Sensor liefert keine aktuellen Daten';
          }
          if (!ok) signals.push({ severity: 'warn', text: `Sensor ${shortName} liefert keine aktuellen Daten`, target: '#climate' });

          if (processed.aligned.length > 0) {
            const last = processed.aligned[processed.aligned.length - 1];
            el('temp').innerText = `${last.temp.toFixed(1)} °C`;
            el('hum').innerText = `${last.humidity.toFixed(0)} %`;
            el('time').innerText = formatRelativeTime(last.time);

            // Schimmelrisiko braucht die Aussentemperatur → leichter Extra-Abruf.
            // Kritisch ab 80 % Wandfeuchte (wie in der ClimateFlow-Detailkarte).
            const th = getThresholds(loc.id);
            let outTemp = null;
            try {
              // Gebuendelter Wetterabruf (Plan4-8) statt eigenem fetch je Standort.
              const w = await getHubWeather(loc.defaultWeather.lat, loc.defaultWeather.lon);
              outTemp = w.current.temperature_2m;
            } catch (e) { /* Aussentemperatur optional */ }
            if (outTemp != null) {
              const { surfaceRhRaw, surfaceRh } = surfaceHumidity(last.temp, last.humidity, outTemp);
              if (surfaceRhRaw >= 80) {
                signals.push({ severity: 'warn', text: `Schimmelrisiko ${shortName} (Wandfeuchte ~${surfaceRh.toFixed(0)} %)`, target: '#climate' });
              } else if (last.humidity > th.humMax) {
                signals.push({ severity: 'info', text: `Hohe Luftfeuchte ${shortName} (${last.humidity.toFixed(0)} %) – lüften`, target: '#climate' });
              }
            } else if (last.humidity > th.humMax) {
              signals.push({ severity: 'info', text: `Hohe Luftfeuchte ${shortName} (${last.humidity.toFixed(0)} %) – lüften`, target: '#climate' });
            }
            // CO₂ (P2-12): nur wenn ein CO₂-Sensor konfiguriert ist und der Wert hoch
            if (last.co2 != null && th.co2Max && last.co2 > th.co2Max) {
              signals.push({ severity: 'warn', text: `CO₂ hoch ${shortName} (${Math.round(last.co2)} ppm) – lüften`, target: '#climate' });
            }
            // Fenster offen vergessen (P3-4)
            try {
              const ow = detectOpenWindow(processed.aligned);
              if (ow.open) signals.push({ severity: 'warn', text: `Fenster offen? ${shortName}: −${ow.dropC} °C in 45 min`, target: '#climate' });
            } catch (e) { /* optional */ }
          } else {
            el('temp').innerText = '–';
            el('time').innerText = 'keine Daten';
          }
        } catch (err) {
          console.warn(`Hub-Vorschau für ${loc.id} fehlgeschlagen:`, err);
          if (el('temp')) el('temp').innerText = '–';
          if (el('time')) el('time').innerText = 'offline';
        }
      }));

      // Ueberfaellige Aufgaben (gleiche Logik wie im To-do-Widget)
      try {
        const overdue = getTodos().filter(t => !t.deleted && !t.done && t.dueMs && t.dueMs < Date.now()).length;
        if (overdue > 0) signals.push({ severity: 'info', text: `${overdue} überfällige Aufgabe${overdue === 1 ? '' : 'n'}`, target: null });
      } catch (e) { /* To-dos optional */ }

      // Frost/Hitze der naechsten 24 h aus dem bereits geladenen Hub-Forecast (P2-12)
      try {
        const hw = appState.hourlyWeather;
        if (hw && hw.time && hw.temperature_2m) {
          const ext = forecastExtremes(hw.time, hw.temperature_2m, Date.now(), 24);
          if (ext) {
            const rules = getNotifyRules();
            const frostTh = (rules.types && rules.types.frost && rules.types.frost.threshold) ?? 0;
            const heatTh = (rules.types && rules.types.heat && rules.types.heat.threshold) ?? 30;
            if (ext.min <= frostTh) signals.push({ severity: 'warn', text: `Frost erwartet: ${Math.round(ext.min)} °C in den nächsten 24 h`, target: '#climate' });
            else if (ext.max >= heatTh) signals.push({ severity: 'warn', text: `Hitze erwartet: ${Math.round(ext.max)} °C in den nächsten 24 h`, target: '#climate' });
          }
        }
      } catch (e) { /* Forecast optional */ }

      // Amtliche Unwetterwarnung (P2-12, Daten aus P2-11 bereits geladen)
      try {
        const alerts = appState.dwdAlerts || [];
        if (alerts.length) {
          const a = alerts[0];
          signals.push({ severity: 'warn', text: `Wetterwarnung: ${a.event_de || a.headline_de || 'Unwetter'}`, target: '#climate' });
        }
      } catch (e) { /* DWD optional */ }

      // Heutige Kalendertermine aus dem bereits geladenen Kalender-Widget (P2-12)
      try {
        const evs = appState.calEvents || [];
        const now = new Date();
        const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const dayEnd = dayStart + 24 * 60 * 60 * 1000;
        const today = evs.filter(e => e.startMs >= dayStart && e.startMs < dayEnd).length;
        if (today > 0) signals.push({ severity: 'info', text: `${today} Termin${today === 1 ? '' : 'e'} heute`, target: null });
      } catch (e) { /* Kalender optional */ }

      // Cron-Totmannschalter (P2-1): meldet sich der Warn-Cron laenger als 3 h
      // nicht, ist das gesamte serverseitige Warnsystem still gestorben. Nur
      // warnen, wenn er ueberhaupt schon einmal lief (cronLastSeen != null) —
      // eine frische Installation ohne Cron soll nicht zugespammt werden.
      try {
        const puls = await apiFetch('/api/health?quick=1');
        if (puls && puls.cronLastSeen) {
          const ageH = (Date.now() - puls.cronLastSeen) / 3600000;
          if (ageH > 3) {
            signals.push({ severity: 'warn', text: `Warn-Cron meldet sich nicht mehr (letzter Lauf vor ${Math.round(ageH)} h)`, target: '#settings' });
          }
        }
      } catch (e) { /* Health/D1 evtl. nicht verfuegbar */ }

      renderBriefing(signals);
      appState.lastDataAt = Date.now(); // fuer den Rueckkehr-Refresh (Plan4-21)
    }

    // ============ Hub-Widget: Status-Briefing (Plan-Punkt 5) ============
    // Verdichtet die wichtigsten Alltagsfragen ("Sensor stumm? Schimmelrisiko?
    // ueberfaellige Aufgaben?") zu einer kurzen, verlinkten Liste. Priorisierung
    // und Begrenzung uebernimmt core.buildBriefing; Signale liefert loadHubPreviews.
    const BRIEF_ICON = { warn: 'alert-triangle', info: 'info', ok: 'check-circle-2' };
    const BRIEF_COLOR = { warn: 'text-red-300', info: 'text-amber-300', ok: 'text-emerald-300' };

    function renderBriefing(signals) {
      const list = document.getElementById('briefing-list');
      const badge = document.getElementById('briefing-badge');
      if (!list) return;
      const { status, allClear, items, overflow } = buildBriefing(signals, { max: 5 });

      if (badge) {
        const map = {
          warn: ['Handlungsbedarf', 'bg-red-500/15 text-red-300'],
          info: ['Hinweise', 'bg-amber-500/15 text-amber-300'],
          ok: ['Alles ok', 'bg-emerald-500/15 text-emerald-300']
        };
        const [label, cls] = map[status] || map.ok;
        badge.className = `ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full ${cls}`;
        badge.innerText = label;
      }

      list.innerHTML = '';
      items.forEach(it => {
        const row = document.createElement(it.target ? 'a' : 'div');
        if (it.target) { row.href = it.target; }
        row.className = `flex items-center gap-2 text-sm rounded-lg px-2 py-1.5 -mx-1 ${it.target ? 'hover:bg-slate-800/50 transition-colors' : ''}`;
        const icon = document.createElement('i');
        icon.setAttribute('data-lucide', BRIEF_ICON[it.severity] || 'circle');
        icon.className = `w-4 h-4 shrink-0 ${BRIEF_COLOR[it.severity] || 'text-slate-400'}`;
        const span = document.createElement('span');
        span.className = allClear ? 'text-slate-400' : 'text-slate-200';
        span.innerText = it.text;
        row.append(icon, span);
        list.appendChild(row);
      });
      if (overflow > 0) {
        const more = document.createElement('p');
        more.className = 'text-[11px] text-slate-500 px-2 pt-0.5';
        more.innerText = `+${overflow} weitere`;
        list.appendChild(more);
      }
      updateIcons();
    }

    // Die aktuell sichtbare View still auffrischen (Plan4-20: aus dem Auto-Refresh
    // extrahiert, damit auch die Netz-Rueckkehr und der App-Wiedereintritt sie nutzen).
    function refreshVisibleView(silent = true) {
      const climateView = document.getElementById('view-climate');
      const homeView = document.getElementById('view-home');
      if (appState.climateLoaded && climateView && !climateView.classList.contains('hidden')) {
        reloadData(silent);
      } else if (homeView && !homeView.classList.contains('hidden')) {
        loadHubPreviews(true);
      }
    }

    // Auto-Refresh-Timer (Plan4-9): still im Hintergrund, Intervall aus
    // app_prefs.refreshMin. Startet den Timer bei Bedarf neu (Intervall geaendert).
    function startAutoRefresh() {
      if (appState._refreshTimer) clearInterval(appState._refreshTimer);
      const ms = getAppPrefs().refreshMin * 60 * 1000;
      appState._refreshTimer = setInterval(() => {
        if (!navigator.onLine) return; // offline: nicht sinnlos abfragen (Plan4-20)
        if (window.Store) Store.pull();
        refreshVisibleView(true);
      }, ms);
    }

    // App Initialization
    async function init() {
      // Geruest SOFORT sichtbar machen — VOR jedem await, damit der Nutzer beim
      // mobilen Erststart nicht erst den Footer und dann ~5 s Leere sieht
      // (Plan4-2). Der hashchange-Handler ist bis initDone reines Rendern.
      window.addEventListener('hashchange', handleRoute);
      renderRoute();
      updateHubClock(); // Uhr/Begruessung ohne Profilnamen (Guard in getProfileDisplayName)

      // Profil/Einstellungen UND Zusatz-Standorte parallel laden (Plan4-3) —
      // loadDynamicLocations braucht den Store nicht (nur apiFetch), also kein
      // Grund, es hinter Store.init zu serialisieren.
      await Promise.all([Store.init(), loadDynamicLocations()]);
      updateProfileBadge();
      applyTheme(getTheme()); // profilbezogenes Theme anwenden
      // Sensor-Offsets laden (P3-6, best effort). Trifft die Kalibrierung erst
      // nach dem ersten Render ein, korrigiert der silente Reload die Anzeige.
      loadCalibrations().then(() => { if (appState.climateLoaded) reloadData(true); });

      updateIcons();
      initConfigs();
      updateNtfyButton();
      applyWidgetLayout();
      initWidgetDrag();

      // Einstellungs-Popover bei Klick außerhalb schließen (Hub + ClimateFlow)
      document.addEventListener('click', event => {
        [['widget-settings', 'toggleWidgetSettings', 'hub-widgets'], ['cf-settings', 'toggleClimateSettings', 'climate-cards']].forEach(([panelId, handler, containerId]) => {
          const panel = document.getElementById(panelId);
          if (panel && !panel.classList.contains('hidden') &&
              !panel.contains(event.target) && !event.target.closest(`button[data-onclick="${handler}"]`)) {
            panel.classList.add('hidden');
            // Bearbeiten-Modus mit beenden (Plan5-1: Griffe wieder ausblenden)
            const container = document.getElementById(containerId);
            if (container) container.classList.remove('layout-editing');
          }
        });
      });

      // Einstellungen sind jetzt geladen → Datenlader der aktuellen View starten.
      // (Der hashchange-Handler ist bereits ganz oben in init registriert.)
      appState.initDone = true;
      const currentView = renderRoute();
      if (currentView) loadRouteData(currentView);

      // Einstellungs-Sync auch während der Sitzung (Punkt 6): Änderungen vom
      // anderen Gerät kommen ohne Reload an — periodisch + bei Tab-Fokus.
      window.addEventListener('store-updated', () => {
        updateProfileBadge();
        applyWidgetLayout();
        startAutoRefresh(); // Intervall koennte per Sync geaendert worden sein (Plan4-9)
        handleRoute();
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (window.Store) Store.pull();
        // Nach laengerer Abwesenheit (> Refresh-Intervall) sofort auffrischen
        // statt bis zum naechsten Timer-Tick zu warten (Plan4-21).
        const maxAgeMs = getAppPrefs().refreshMin * 60 * 1000;
        if (navigator.onLine && Date.now() - appState.lastDataAt > maxAgeMs) refreshVisibleView(true);
      });

      // Netz-Rueckkehr (Plan4-20): sofort die sichtbare View auffrischen.
      window.addEventListener('net-online', () => refreshVisibleView(true));

      // Auto-Refresh still im Hintergrund (kein Lade-Overlay). Intervall pro
      // Profil einstellbar (Plan4-9, app_prefs.refreshMin).
      startAutoRefresh();

      // "vor X Min."-Labels laufend aktuell halten
      setInterval(updateTimestampLabels, 60 * 1000);

      // Hub-Uhr im Sekundentakt (günstig, nur DOM-Text)
      updateHubClock();
      setInterval(updateHubClock, 1000);

      // PWA: Service Worker registrieren (+ „Neue Version"-Hinweis)
      registerServiceWorker();
    }

    window.addEventListener('DOMContentLoaded', init);
