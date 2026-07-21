// ClimateFlow Dashboard + Hub-Navigation.
// Ausgelagert aus index.html; nutzt lib/core.js (getestete Kernlogik) und shared.js.
//
// ── Modul-Übersicht (Abschnitte in dieser Datei) ────────────────────────────
//   1. Konfiguration & Zustand      LOCATIONS, appState, Store-Zugriffe
//   2. Standort & Schwellwerte       initConfigs, getThresholds, Tabs
//   3. Daten laden                   fetchFeeds, reloadData, loadIndoorData,
//                                    Offline-Snapshot, loadOutdoorWeather, AQI
//   4. Klima-Auswertung/Render       KPIs, Lüftungsberater/-tagebuch/-trend,
//                                    Schimmel, Komfort, Heizindikator, Chart
//   5. Langzeit-Archiv               loadArchiveView, Rekorde, Tagesdetail
//   6. Push (ntfy)                   configureNtfy, checkWeatherWarnings
//   7. Einstellungsseite (P1)        renderSettings, Theme, Profil, Logout
//   8. Benachrichtigungs-Center (P4) NOTIFY_TYPES, notify_rules
//   9. Hub-Widgets                   Uhr, Wetter/Vorschau, To-dos, Kalender
//  10. Layout-Factory               createLayout (Hub + ClimateFlow), Onboarding
//  11. Navigation & init            HUB_VIEWS, handleRoute, init
// Anmerkung: Ein physisches Aufteilen in mehrere Dateien scheitert daran, dass
// klassische <script>-Dateien ihre top-level const/let NICHT teilen (kein
// Bundler); der gemeinsame Zustand (appState etc.) müsste sonst global werden.
// ────────────────────────────────────────────────────────────────────────────

// Configuration for both locations.
    // fields: generalisiertes Kanal-Schema (siehe processRawFeeds in lib/core.js).
    // Ein späterer Zusatz-Sensor (z. B. CO₂ auf field3) wird rein per Konfiguration
    // ergänzt: extra: [{ key: 'co2', field: 'field3', label: 'CO₂', unit: 'ppm', decimals: 0 }]
    // → Wert erscheint automatisch in aligned-Einträgen, Rohdaten-Tabelle und CSV-Export.
    const LOCATIONS = [
      {
        id: 'gillian',
        defaultName: 'Schlafzimmer Gillian',
        defaultWeather: { lat: 48.7758, lon: 9.1829, name: 'Stuttgart, DE' },
        fields: { temp: 'field1', humidity: 'field2', extra: [] }
      },
      {
        id: 'sean',
        defaultName: 'Schlafzimmer Sean',
        defaultWeather: { lat: 52.5200, lon: 13.4050, name: 'Berlin, DE' },
        fields: { temp: 'field1', humidity: 'field2', extra: [] }
      }
    ];

    function getLocationFields(locId) {
      const loc = LOCATIONS.find(l => l.id === locId);
      return (loc && loc.fields) || {};
    }

    // Global State
    const appState = {
      activeLocId: 'gillian', // wird in initConfigs aus dem aktiven Profil gesetzt
      isDemoMode: false,
      insideData: [],
      outsideData: {},
      airQuality: null,
      hourlyWeather: null,
      weatherConfig: null,
      chartInstance: null,
      archiveChart: null,
      archiveLoadedFor: null,
      currentChartTimeframe: 24, // hours
      climateLoaded: false,
      initDone: false, // true, sobald init() Store+Standorte geladen hat (Plan4-2)
      lastDataAt: 0,   // Zeitpunkt der letzten erfolgreichen Datenauffrischung (Plan4-21)
      // Zeitpunkte der letzten ECHTEN Messwerte (nicht forward-filled)
      lastSensorUpdate: { temp: null, humidity: null },
      // Rohdaten-Cache pro Standort für inkrementelles Nachladen (statt jedes Mal 8000 Einträge)
      feedCache: {},
      hubPreviewAt: 0,
      // Standort-Vergleichsmodus im Klimaverlauf-Chart
      compareMode: false,
      compareData: null,
      compareLocId: null
    };

    // Sensor gilt als ausgefallen, wenn länger keine echten Werte kamen als:
    const SENSOR_STALE_MS = 2 * 60 * 60 * 1000;

    // Feeds über die API-Schicht laden (/api/feeds/{loc}, Cloudflare Function
    // mit verstecktem TS_KEY_* aus Env-Vars + Edge-Cache).
    async function fetchFeeds(loc, { results = 8000, start = null } = {}) {
      const q = new URLSearchParams({ results: results.toString() });
      if (start) q.set('start', start);
      return await apiFetch(`/api/feeds/${loc.id}?${q.toString()}`);
    }

    // Load custom names and weather configs (profilbezogen über Store)
    function initConfigs() {
      appState.activeLocId = Store.get('selected_location') || 'gillian';
      // Safety check for selected location
      if (!LOCATIONS.some(l => l.id === appState.activeLocId)) {
        appState.activeLocId = 'gillian';
        Store.set('selected_location', 'gillian');
      }

      // Restore weather configs
      const savedWeather = Store.get(`loc_weather_${appState.activeLocId}`);
      if (savedWeather) {
        appState.weatherConfig = JSON.parse(savedWeather);
      } else {
        const activeLoc = LOCATIONS.find(l => l.id === appState.activeLocId);
        appState.weatherConfig = { ...activeLoc.defaultWeather };
      }

      updateTabLabels();
      updateWeatherButtonName();
      highlightActiveTab();
    }

    function getLocationName(locId) {
      const loc = LOCATIONS.find(l => l.id === locId);
      return Store.get(`loc_name_${locId}`) || (loc ? loc.defaultName : '');
    }

    async function renameActiveLocation() {
      const locId = appState.activeLocId;
      const currentName = getLocationName(locId);
      const vals = await modalPrompt({
        title: 'Standort umbenennen',
        fields: [{ key: 'name', label: 'Name', value: currentName }],
        submitLabel: 'Speichern'
      });
      if (vals && vals.name.trim() !== '') {
        Store.set(`loc_name_${locId}`, vals.name.trim());
        document.getElementById('detail-loc-title').innerText = vals.name.trim();
        updateTabLabels();
        showNotification('Name erfolgreich geändert!');
      }
    }

    // ============ Konfigurierbare Ziel-/Schwellwerte pro Standort ============
    // Bestimmen die Comfort-Bewertungen (KPI-Karten), den Komfort-Score und die
    // Feuchte-Schwelle des Lüftungsberaters. Gespeichert in localStorage.
    const THRESHOLD_DEFAULTS = { tempMin: 19, tempMax: 24, humMin: 40, humMax: 60, co2Max: 1000 };

    function getThresholds(locId = appState.activeLocId) {
      try {
        const saved = Store.getJSON(`loc_thresholds_${locId}`, null);
        if (saved && typeof saved === 'object') return { ...THRESHOLD_DEFAULTS, ...saved };
      } catch (e) { /* defekte gespeicherte Daten → Defaults */ }
      return { ...THRESHOLD_DEFAULTS };
    }

    function openThresholdSettings() {
      const th = getThresholds();
      document.getElementById('th-temp-min').value = th.tempMin;
      document.getElementById('th-temp-max').value = th.tempMax;
      document.getElementById('th-hum-min').value = th.humMin;
      document.getElementById('th-hum-max').value = th.humMax;
      document.getElementById('threshold-loc-name').innerText = getLocationName(appState.activeLocId);
      document.getElementById('threshold-modal').classList.remove('hidden');
      updateIcons();
    }

    function closeThresholdSettings() {
      document.getElementById('threshold-modal').classList.add('hidden');
    }

    function resetThresholdSettings() {
      Store.remove(`loc_thresholds_${appState.activeLocId}`);
      openThresholdSettings(); // Felder mit Defaults neu befüllen
      showNotification('Schwellwerte auf Standard zurückgesetzt.');
      renderActiveView();
    }

    function saveThresholdSettings() {
      const read = id => parseFloat(document.getElementById(id).value.toString().replace(',', '.'));
      const th = {
        tempMin: read('th-temp-min'), tempMax: read('th-temp-max'),
        humMin: read('th-hum-min'), humMax: read('th-hum-max')
      };
      if (Object.values(th).some(v => isNaN(v))) {
        showNotification('Bitte gültige Zahlen eingeben.', 'error');
        return;
      }
      if (th.tempMin >= th.tempMax || th.humMin >= th.humMax) {
        showNotification('Minimum muss kleiner als Maximum sein.', 'error');
        return;
      }
      if (th.humMin < 0 || th.humMax > 100) {
        showNotification('Feuchte-Werte müssen zwischen 0 und 100 % liegen.', 'error');
        return;
      }
      Store.setJSON(`loc_thresholds_${appState.activeLocId}`, th);
      closeThresholdSettings();
      showNotification('Schwellwerte gespeichert.');
      renderActiveView();
      // Archiv-Komfortkurve mit neuen Schwellwerten neu zeichnen (falls geöffnet)
      appState.archiveLoadedFor = null;
      loadArchiveView();
    }

    // Standort-Tabs dynamisch aus LOCATIONS rendern (unterstützt beliebig viele
    // Standorte, auch die über die Oberfläche angelegten aus D1).
    function renderLocationTabs() {
      const wrap = document.getElementById('nav-location-tabs');
      if (wrap) {
        wrap.innerHTML = '';
        LOCATIONS.forEach(loc => {
          const active = loc.id === appState.activeLocId;
          const btn = document.createElement('button');
          btn.id = `tab-${loc.id}`;
          btn.className = active
            ? 'px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-teal-500 text-slate-950 shadow-md shadow-teal-500/10 transition-colors'
            : 'px-3.5 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors';
          btn.innerText = getLocationName(loc.id).replace('Schlafzimmer ', '');
          btn.onclick = () => switchLocation(loc.id);
          wrap.appendChild(btn);
        });
      }
      const titleEl = document.getElementById('detail-loc-title');
      if (titleEl) titleEl.innerText = getLocationName(appState.activeLocId);
    }

    // Alte Aufrufer bleiben gültig (Rendern deckt beides ab)
    function updateTabLabels() { renderLocationTabs(); }
    function highlightActiveTab() { renderLocationTabs(); }

    // Über die Oberfläche angelegte Standorte (D1) beim Start ergänzen (P8).
    async function loadDynamicLocations() {
      try {
        const data = await apiFetch('/api/locations');
        (data.locations || []).forEach(l => {
          if (LOCATIONS.some(x => x.id === l.id)) return;
          LOCATIONS.push({
            id: l.id,
            dynamic: true, // ueber die Oberflaeche angelegt (bearbeitbar, P3-3)
            defaultName: l.name || l.id,
            defaultWeather: { lat: l.lat, lon: l.lon, name: l.name || l.id },
            fields: l.fields || { temp: 'field1', humidity: 'field2', extra: [] }
          });
        });
      } catch (err) {
        // kein D1 / keine Zusatz-Standorte → nur die fest verdrahteten
      }
    }

    // Sensor-Kalibrierung (P3-6): Offsets je Standort aus app_config laden und
    // anwenden. appState.calib[locId] = { tempOffset, humOffset }.
    async function loadCalibrations() {
      appState.calib = appState.calib || {};
      await Promise.all(LOCATIONS.map(async loc => {
        try {
          const r = await apiFetch(`/api/config?key=calib_${loc.id}`);
          if (r && r.value && (Number(r.value.tempOffset) || Number(r.value.humOffset))) {
            appState.calib[loc.id] = { tempOffset: Number(r.value.tempOffset) || 0, humOffset: Number(r.value.humOffset) || 0 };
          }
        } catch (e) { /* kein D1 / kein Offset */ }
      }));
    }
    function calibratedAligned(locId, aligned) {
      const c = appState.calib && appState.calib[locId];
      return (c && (c.tempOffset || c.humOffset)) ? applyCalibration(aligned, c) : aligned;
    }

    // Toggle Location Search Panel
    function toggleLocationModal() {
      const dropdown = document.getElementById('location-dropdown');
      dropdown.classList.toggle('hidden');
    }

    // Close dropdown on outside click
    document.addEventListener('click', (event) => {
      const dropdown = document.getElementById('location-dropdown');
      const locationBtn = document.getElementById('location-btn');
      if (dropdown && !dropdown.classList.contains('hidden') && 
          locationBtn && !locationBtn.contains(event.target) && !dropdown.contains(event.target)) {
        dropdown.classList.add('hidden');
      }
    });

    // Request Geolocation
    function requestGeolocation() {
      const dropdown = document.getElementById('location-dropdown');
      dropdown.classList.add('hidden');

      const nameEl = document.getElementById('current-location-name');
      nameEl.innerText = 'Orte Standort...';

      if (!navigator.geolocation) {
        showNotification('Ortung nicht unterstützt.', 'error');
        updateWeatherButtonName();
        return;
      }

      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const lat = position.coords.latitude;
          const lon = position.coords.longitude;
          
          nameEl.innerText = 'Benenne Standort...';
          
          let cityName = 'Mein Standort';
          try {
            const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=de`);
            if (res.ok) {
              const data = await res.json();
              cityName = data.address.city || data.address.town || data.address.village || 'Mein Standort';
              if (data.address.country_code) {
                cityName += `, ${data.address.country_code.toUpperCase()}`;
              }
            }
          } catch (e) {
            console.warn('Reverse geocoding failed', e);
          }

          setWeatherCoords(lat, lon, cityName);
        },
        (error) => {
          console.error('Geolocation error:', error);
          showNotification('Ortung fehlgeschlagen.', 'error');
          updateWeatherButtonName();
        },
        { timeout: 6000 }
      );
    }

    // Search Cities using Open-Meteo Geocoding
    async function searchCity(event) {
      const query = event.target.value.trim();
      const resultsDiv = document.getElementById('search-results');

      if (query.length < 2) return;

      try {
        const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=de&format=json`);
        if (!res.ok) throw new Error('Geocoding API failed');
        
        const data = await res.json();
        if (!data.results || data.results.length === 0) return;

        resultsDiv.innerHTML = '<span class="px-2 py-1 font-semibold text-slate-500 uppercase tracking-wider">Suchergebnisse</span>';
        
        data.results.forEach(city => {
          const countryCode = city.country_code ? city.country_code.toUpperCase() : '';
          const state = city.admin1 ? `, ${city.admin1}` : '';
          const name = `${city.name}${state} (${countryCode})`;
          const shortName = `${city.name}, ${countryCode}`;

          const btn = document.createElement('button');
          btn.className = 'w-full text-left px-2 py-1.5 rounded-lg hover:bg-slate-800/80 hover:text-white transition-colors flex items-center justify-between text-[11px]';
          btn.innerHTML = `
            <span class="truncate pr-1">${city.name}<span class="text-slate-500 text-[10px]"> ${state}</span></span>
            <span class="text-[9px] bg-slate-850 border border-slate-800 px-1 py-0.5 rounded text-slate-400">${countryCode}</span>
          `;
          btn.onclick = () => {
            setWeatherCoords(city.latitude, city.longitude, shortName);
            document.getElementById('location-dropdown').classList.add('hidden');
          };
          resultsDiv.appendChild(btn);
        });
      } catch (err) {
        console.error('Error fetching city search:', err);
      }
    }

    // Set coordinates for the active weather
    function setWeatherCoords(lat, lon, name) {
      const weatherObj = { lat, lon, name };
      appState.weatherConfig = weatherObj;
      Store.setJSON(`loc_weather_${appState.activeLocId}`, weatherObj);

      // Koordinaten auch serverseitig hinterlegen (D1 app_config), damit
      // check-alerts/weekly-report mit demselben Ort rechnen (best effort)
      apiFetch('/api/config', {
        method: 'POST',
        body: JSON.stringify({ key: `weather_${appState.activeLocId}`, value: weatherObj })
      }).catch(() => { /* ohne D1 bleibt es bei den Server-Defaults */ });

      updateWeatherButtonName();
      showNotification(`Wetter-Standort geändert: ${name}`);
      reloadData();
    }

    function updateWeatherButtonName() {
      const btnName = document.getElementById('current-location-name');
      if (btnName && appState.weatherConfig) {
        btnName.innerText = appState.weatherConfig.name;
      }
    }

    function showNotification(msg, type = 'success') {
      showToast(msg, type === 'success' ? 'success' : 'error');
    }

    // Wrapper fuer die Event-Delegation (P2-8): ersetzen fruehere Inline-Handler
    // mit mehreren Anweisungen bzw. Ausdruecken (CSP ohne unsafe-inline).
    function goToGpx() { location.href = 'gpx.html'; }
    function refreshHubCalendar() { loadHubCalendar(true); showNotification('Kalender aktualisiert.'); }
    function obConfigureNtfy() { configureNtfy(); setTimeout(renderOnboardingStep, 100); }
    function obConfigureIcal() { configureIcal(); setTimeout(renderOnboardingStep, 100); }
    function obEditGoals() { editHubGoals(); setTimeout(renderOnboardingStep, 100); }
    function obEditThresholds(id) { editLocationThresholds(id); setTimeout(renderOnboardingStep, 100); }

    // Magnus-Formeln (satVaporPressure, getAbsoluteHumidity, getDewPoint)
    // und processRawFeeds kommen aus lib/core.js (getestet via npm test).

    // Show / Hide Loading Screen
    function toggleLoadingOverlay(show) {
      const overlay = document.getElementById('loading-overlay');
      if (show) {
        overlay.classList.remove('hidden', 'opacity-0');
      } else {
        overlay.classList.add('opacity-0');
        setTimeout(() => {
          overlay.classList.add('hidden');
        }, 300);
      }
    }

    // Master reload data (loads active location automatically).
    // silent = true: Hintergrund-Refresh ohne Lade-Overlay — die bisherigen
    // Werte bleiben sichtbar und werden still ersetzt.
    async function reloadData(silent = false) {
      const reloadIcon = document.getElementById('reload-icon');
      if (reloadIcon) reloadIcon.classList.add('animate-spin');
      if (!silent) toggleLoadingOverlay(true);

      // Skeleton-Pulsieren beim allerersten Laden (noch keine Werte) — Punkt 11
      const firstLoad = appState.insideData.length === 0;
      const kpiCard = document.querySelector('[data-widget="cf-kpi"]');
      if (firstLoad && kpiCard) kpiCard.classList.add('animate-pulse');

      try {
        await Promise.all([
          loadIndoorData(),
          loadOutdoorWeather(),
          loadAirQuality()
        ]);

        renderActiveView();
        appState.lastDataAt = Date.now(); // fuer den Rueckkehr-Refresh (Plan4-21)
      } catch (error) {
        console.error('Error reloading data:', error);
        showNotification('Fehler beim Abrufen der Live-Daten.', 'error');
      } finally {
        if (!silent) toggleLoadingOverlay(false);
        if (kpiCard) kpiCard.classList.remove('animate-pulse');
        if (reloadIcon) {
          setTimeout(() => {
            reloadIcon.classList.remove('animate-spin');
          }, 800);
        }
      }
    }

    function retryLoadingData() {
      appState.isDemoMode = false;
      document.getElementById('demo-banner').classList.add('hidden');
      reloadData();
    }

    // Fetch ThingSpeak indoor feeds for the active location.
    // Nutzt einen Rohdaten-Cache pro Standort: Nach dem ersten Voll-Load werden
    // per ThingSpeak-"start"-Parameter nur noch neue Einträge nachgeladen.
    async function loadIndoorData() {
      const activeLoc = LOCATIONS.find(l => l.id === appState.activeLocId);
      const cache = appState.feedCache[activeLoc.id];
      const hasCache = !!(cache && cache.rawFeeds && cache.rawFeeds.length > 0);

      let start = null;
      if (hasCache) {
        const lastMs = new Date(cache.rawFeeds[cache.rawFeeds.length - 1].created_at).getTime();
        // +1s, damit der letzte bekannte Eintrag nicht doppelt kommt (ThingSpeak erwartet UTC)
        start = new Date(lastMs + 1000).toISOString().replace('T', ' ').substring(0, 19);
      }

      // Erst-Load bewusst nur ~14 Tage (4032 Eintraege im 5-min-Takt) statt 8000
      // — kleinerer Download/Parse auf dem Handy. Deckt Lueftungs-Tagebuch (14 d)
      // ab; die komplette Historie holt ensureFullHistory erst bei "Alle" im Chart
      // (Plan4-6). Der inkrementelle Refresh (start) laedt danach nur Neues.
      const results = hasCache ? 8000 : 4032;

      try {
        const data = await fetchFeeds(activeLoc, { results, start });
        const newFeeds = (data && Array.isArray(data.feeds)) ? data.feeds : [];

        let rawFeeds;
        if (hasCache) {
          const knownIds = new Set(cache.rawFeeds.map(f => f.entry_id));
          rawFeeds = cache.rawFeeds.concat(newFeeds.filter(f => !knownIds.has(f.entry_id)));
          if (rawFeeds.length > 8000) rawFeeds = rawFeeds.slice(-8000);
        } else {
          rawFeeds = newFeeds;
        }

        if (rawFeeds.length === 0) throw new Error('Keine Daten empfangen');

        const processed = processRawFeeds(rawFeeds, activeLoc.fields);
        if (processed.aligned.length === 0) throw new Error('Keine gültigen abgeglichenen Daten gefunden');
        processed.aligned = calibratedAligned(activeLoc.id, processed.aligned); // Kalibrierung (P3-6)

        // Vollstaendigkeits-Flag erhalten: nach einem ensureFullHistory-Lauf
        // (full=true) darf ein inkrementeller Refresh es nicht zuruecksetzen.
        appState.feedCache[activeLoc.id] = { rawFeeds, full: hasCache ? !!cache.full : false };
        appState.insideData = processed.aligned;
        appState.lastSensorUpdate = { temp: processed.lastTempTime, humidity: processed.lastHumTime };
        appState.isDemoMode = false;
        document.getElementById('demo-banner').classList.add('hidden');
        updateStatusText(true);
        saveOfflineSnapshot(activeLoc.id, processed.aligned); // für Offline-Start (Punkt 13)

        // Tages-Aggregate ins D1-Langzeit-Archiv schreiben (asynchron, best effort)
        archiveClimateDaily();
      } catch (err) {
        if (hasCache) {
          // Aktualisierung fehlgeschlagen, aber Daten vorhanden → weiter mit Cache statt Demo-Modus
          console.warn('ThingSpeak-Refresh fehlgeschlagen, verwende zwischengespeicherte Daten:', err);
          const processed = processRawFeeds(cache.rawFeeds, activeLoc.fields);
          appState.insideData = calibratedAligned(activeLoc.id, processed.aligned);
          appState.lastSensorUpdate = { temp: processed.lastTempTime, humidity: processed.lastHumTime };
          showNotification('Aktualisierung fehlgeschlagen – zeige letzte bekannte Daten.', 'error');
        } else {
          // Frischer Offline-Start: persistierten Snapshot nutzen (Punkt 13)
          const snap = loadOfflineSnapshot(activeLoc.id);
          if (snap && snap.length > 0) {
            console.warn('Offline – zeige gespeicherten Stand:', err);
            appState.insideData = snap;
            const last = snap[snap.length - 1];
            appState.lastSensorUpdate = { temp: last.time, humidity: last.time };
            appState.isDemoMode = false;
            const ageMin = Math.round((Date.now() - last.time.getTime()) / 60000);
            const ageTxt = ageMin < 60 ? `vor ${ageMin} Min.` : `vor ${Math.round(ageMin / 60)} Std.`;
            showNotification(`Offline – Stand: ${ageTxt}.`, 'info');
          } else {
            console.warn('ThingSpeak laden fehlgeschlagen, aktiviere Demo-Modus:', err);
            activateDemoMode();
          }
        }
      }
    }

    // Volle ThingSpeak-Historie (bis 8000 Eintraege) nachladen — nur wenn der
    // Nutzer wirklich "Alle" im Klimaverlauf waehlt (Plan4-6). Ersetzt den
    // 14-Tage-Cache des aktiven Standorts und aktualisiert die Anzeige-Daten.
    async function ensureFullHistory() {
      const activeLoc = LOCATIONS.find(l => l.id === appState.activeLocId);
      const cache = appState.feedCache[activeLoc.id];
      if (cache && cache.full) return; // schon vollstaendig geladen
      showToast('Lade vollständige Historie …', 'info');
      try {
        const data = await fetchFeeds(activeLoc, { results: 8000 });
        const rawFeeds = (data && Array.isArray(data.feeds)) ? data.feeds : [];
        if (rawFeeds.length === 0) return;
        const processed = processRawFeeds(rawFeeds, activeLoc.fields);
        if (processed.aligned.length === 0) return;
        appState.feedCache[activeLoc.id] = { rawFeeds, full: true };
        appState.insideData = calibratedAligned(activeLoc.id, processed.aligned);
        saveOfflineSnapshot(activeLoc.id, appState.insideData);
      } catch (err) {
        console.warn('Volle Historie laden fehlgeschlagen:', err);
      }
    }

    // Kompakter Offline-Snapshot (letzte ~1000 Messpaare) im localStorage —
    // gerätelokal, nicht profil-synchron. Ermöglicht KPI/Chart auch offline.
    function saveOfflineSnapshot(locId, aligned) {
      try {
        const slim = aligned.slice(-1000).map(a => ({ t: a.time.getTime(), te: a.temp, h: a.humidity }));
        localStorage.setItem(`climate_offline_${locId}`, JSON.stringify(slim));
      } catch (e) { /* Quota o. Ä. → ignorieren */ }
    }
    function loadOfflineSnapshot(locId) {
      try {
        const raw = localStorage.getItem(`climate_offline_${locId}`);
        if (!raw) return null;
        return JSON.parse(raw).map(a => ({ time: new Date(a.t), temp: a.te, humidity: a.h }));
      } catch (e) { return null; }
    }

    // Fetch local weather from Open-Meteo for active coordinates
    async function loadOutdoorWeather() {
      try {
        const conf = appState.weatherConfig;
        if (!conf) return;

        // timeformat=unixtime: liefert absolute Epoch-Zeitstempel statt lokaler
        // Zeit-Strings — das macht den Abgleich mit den ThingSpeak-Zeiten
        // zeitzonen-sicher. past_days=7: sonst gäbe es keine Stundenwerte für
        // die 3-Tage-/7-Tage-Chart-Ansicht (API liefert sonst erst ab heute 00:00).
        // forecast_days=2: nötig, damit die Lüftungsfenster-Prognose immer
        // volle 24h in die Zukunft schauen kann.
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${conf.lat}&longitude=${conf.lon}&current=temperature_2m,relative_humidity_2m,weather_code&hourly=temperature_2m,relative_humidity_2m&timezone=auto&timeformat=unixtime&past_days=7&forecast_days=2`;
        const res = await fetchWithTimeout(url, {}, 10000);
        if (!res.ok) throw new Error(`HTTP-Fehler: ${res.status}`);
        
        const data = await res.json();
        appState.outsideData = data;
      } catch (err) {
        console.warn('Open-Meteo laden fehlgeschlagen, generiere Wetter-Dummy:', err);
        appState.outsideData = generateMockWeather();
      }
      // Amtliche Unwetterwarnungen fuer die ClimateFlow-Wetterkarte (P2-11); gecacht (Plan4-8)
      if (appState.weatherConfig) {
        getDwdAlerts(appState.weatherConfig.lat, appState.weatherConfig.lon)
          .then(alerts => { appState.dwdAlerts = alerts; renderDwdBanner(document.getElementById('cf-dwd'), alerts); });
      }
    }

    // ---- Amtliche Unwetterwarnungen (DWD via BrightSky, P2-11) ----
    // Kostenlos, ohne Key. Ausserhalb Deutschlands leere Liste. Best effort.
    async function fetchDwdAlerts(lat, lon) {
      try {
        const res = await fetchWithTimeout(`https://api.brightsky.dev/alerts?lat=${lat}&lon=${lon}`, {}, 10000);
        if (!res.ok) return [];
        return (((await res.json()) || {}).alerts || []).filter(a => a && a.severity && a.severity !== 'minor');
      } catch (e) { return []; }
    }

    // Ein gebuendelter Open-Meteo-Abruf je Koordinate fuer ALLE Hub-Widgets
    // (Uhr-Wetter, 3-Tage-Vorschau, Schimmel-Aussentemperatur) statt bis zu vier
    // Einzelabrufe (Plan4-8). Promise-Cache mit 10-min-TTL dedupliziert gleiche
    // Koordinaten automatisch. NICHT fuer loadOutdoorWeather (braucht past_days=7,
    // eigenes Format). forecastDays gehoert in den Cache-Key (Plan4-11).
    const _hubWeatherCache = new Map();
    function getHubWeather(lat, lon, forecastDays = 3) {
      const key = `${(+lat).toFixed(3)},${(+lon).toFixed(3)},${forecastDays}`;
      const hit = _hubWeatherCache.get(key);
      if (hit && Date.now() - hit.ts < 10 * 60 * 1000) return hit.p;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code&hourly=temperature_2m,precipitation_probability,weather_code&forecast_days=${forecastDays}&timezone=auto&timeformat=unixtime`;
      const p = fetchWithTimeout(url, {}, 10000).then(res => {
        if (!res.ok) throw new Error(`HTTP-Fehler: ${res.status}`);
        return res.json();
      }).catch(err => { _hubWeatherCache.delete(key); throw err; }); // Fehler nicht cachen
      _hubWeatherCache.set(key, { ts: Date.now(), p });
      return p;
    }

    // TTL-Cache-Wrapper fuer die DWD-Warnungen (Plan4-8): eine Abfrage je
    // Koordinate statt je Widget. fetchDwdAlerts liefert bei Fehlern [] (resolved).
    const _dwdCache = new Map();
    function getDwdAlerts(lat, lon) {
      const key = `${(+lat).toFixed(3)},${(+lon).toFixed(3)}`;
      const hit = _dwdCache.get(key);
      if (hit && Date.now() - hit.ts < 10 * 60 * 1000) return hit.p;
      const p = fetchDwdAlerts(lat, lon);
      _dwdCache.set(key, { ts: Date.now(), p });
      return p;
    }
    // Chart.js-Stack (Chart + Hammer + Zoom-Plugin) erst bei Bedarf laden (P2-19).
    // Reihenfolge zwingend: Chart + Hammer als Globals, dann registriert sich das
    // Zoom-Plugin selbst am globalen Chart. Promise-gecacht → nur einmal geladen.
    let _chartJsReady = null;
    async function ensureChartJs() {
      if (typeof Chart !== 'undefined') return;
      if (!_chartJsReady) {
        _chartJsReady = (async () => {
          await loadScript('vendor/chart.umd.js');
          await loadScript('vendor/hammer.min.js');
          await loadScript('vendor/chartjs-plugin-zoom.min.js');
        })();
      }
      await _chartJsReady;
    }

    function renderDwdBanner(el, alerts) {
      if (!el) return;
      if (!alerts || !alerts.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
      const worst = alerts.some(a => a.severity === 'extreme' || a.severity === 'severe');
      const cls = worst ? 'bg-red-500/10 border-red-500/30 text-red-300' : 'bg-amber-500/10 border-amber-500/30 text-amber-300';
      const a = alerts[0];
      el.className = `mb-3 px-3 py-2 rounded-xl border text-xs flex items-start gap-2 ${cls}`;
      el.innerHTML = `<i data-lucide="cloud-lightning" class="w-4 h-4 shrink-0 mt-0.5"></i><span><strong>${escapeHtml(a.event_de || 'Wetterwarnung')}:</strong> ${escapeHtml(a.headline_de || '')}${alerts.length > 1 ? ` (+${alerts.length - 1} weitere)` : ''}</span>`;
      el.classList.remove('hidden');
      updateIcons();
    }

    // Außenluft-Qualität (Open-Meteo Air-Quality-API, kostenlos, ohne Key):
    // Europäischer AQI, Feinstaub, Ozon und Pollen. Best effort — ohne Daten
    // bleibt die Anzeige leer und der Lüftungsberater arbeitet wie bisher.
    async function loadAirQuality() {
      try {
        const conf = appState.weatherConfig;
        if (!conf) { appState.airQuality = null; return; }
        const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${conf.lat}&longitude=${conf.lon}&current=european_aqi,pm2_5,pm10,ozone,birch_pollen,grass_pollen&timezone=auto`;
        const res = await fetchWithTimeout(url, {}, 10000);
        if (!res.ok) throw new Error(`HTTP-Fehler: ${res.status}`);
        const data = await res.json();
        appState.airQuality = data && data.current ? data.current : null;
      } catch (err) {
        console.warn('Luftqualität laden fehlgeschlagen:', err);
        appState.airQuality = null;
      }
    }

    // Europäische AQI-Skala (https://airindex.eea.europa.eu): 0–20 gut … >100 extrem
    function classifyAqi(aqi) {
      if (aqi <= 20) return { label: 'Gut', cls: 'text-emerald-400' };
      if (aqi <= 40) return { label: 'Okay', cls: 'text-teal-400' };
      if (aqi <= 60) return { label: 'Mäßig', cls: 'text-amber-400' };
      if (aqi <= 80) return { label: 'Schlecht', cls: 'text-orange-400' };
      return { label: 'Sehr schlecht', cls: 'text-red-400' };
    }

    function renderAirQuality() {
      const el = document.getElementById('air-quality-line');
      if (!el) return;
      const aq = appState.airQuality;
      if (!aq || aq.european_aqi === null || aq.european_aqi === undefined) {
        el.classList.add('hidden');
        return;
      }

      const cls = classifyAqi(aq.european_aqi);
      const pollenMax = Math.max(aq.birch_pollen || 0, aq.grass_pollen || 0);
      const pollen = pollenMax >= 50 ? ' · Pollen: hoch' : pollenMax >= 20 ? ' · Pollen: mittel' : pollenMax > 0 ? ' · Pollen: niedrig' : '';
      el.innerHTML = `<i data-lucide="leaf" class="w-3.5 h-3.5 inline"></i> Luftqualität: <span class="font-semibold ${cls.cls}">${cls.label}</span> (AQI ${Math.round(aq.european_aqi)})${pollen}`;
      el.title = `Feinstaub PM2,5: ${aq.pm2_5 != null ? aq.pm2_5.toFixed(0) : '–'} µg/m³ · PM10: ${aq.pm10 != null ? aq.pm10.toFixed(0) : '–'} µg/m³ · Ozon: ${aq.ozone != null ? aq.ozone.toFixed(0) : '–'} µg/m³`;
      el.classList.remove('hidden');
      updateIcons();
    }

    function generateMockWeather() {
      const isSean = appState.activeLocId === 'sean';
      const baseTemp = isSean ? 14.5 : 18.0;
      
      const hourlyTimes = [];
      const hourlyTemp = [];
      const hourlyHum = [];
      const now = new Date();
      
      // 7 Tage Vergangenheit + 24h "Prognose" für die Lüftungsfenster-Vorschau
      for (let i = 168; i >= -24; i--) {
        const time = new Date(now.getTime() - i * 60 * 60 * 1000);
        const hour = time.getHours();
        const tempOffset = Math.sin((hour - 8) / 24 * 2 * Math.PI) * 4.5;
        hourlyTimes.push(time.toISOString());
        hourlyTemp.push(parseFloat((baseTemp + tempOffset).toFixed(1)));
        hourlyHum.push(parseFloat((68 - tempOffset * 1.8).toFixed(0)));
      }

      return {
        current: {
          time: Math.floor(now.getTime() / 1000),
          temperature_2m: baseTemp + (Math.random() * 2 - 1),
          relative_humidity_2m: 68,
          weather_code: 2
        },
        hourly: {
          time: hourlyTimes,
          temperature_2m: hourlyTemp,
          relative_humidity_2m: hourlyHum
        }
      };
    }

    function activateDemoMode() {
      appState.isDemoMode = true;
      document.getElementById('demo-banner').classList.remove('hidden');
      updateStatusText(false);

      const mockFeeds = [];
      const now = new Date();
      const totalFeeds = 1000;
      const isSean = appState.activeLocId === 'sean';
      
      let baseTemp = isSean ? 20.2 : 22.1;
      let baseHum = isSean ? 54.0 : 45.0;

      for (let i = totalFeeds; i > 0; i--) {
        const time = new Date(now.getTime() - i * 8 * 60 * 1000);
        const hour = time.getHours();
        
        const dailyOsc = Math.sin((hour - 10) / 24 * 2 * Math.PI) * 0.7;
        const randomFluct = (Math.random() * 2 - 1) * 0.04;
        let windowEffect = 0;
        if (hour === 8 && time.getMinutes() < 24) windowEffect = -0.5;

        const temp = parseFloat((baseTemp + dailyOsc + windowEffect + randomFluct).toFixed(1));
        const humOsc = -Math.sin((hour - 10) / 24 * 2 * Math.PI) * 3.5;
        const humRandom = (Math.random() * 2 - 1) * 0.25;
        const humidity = parseFloat((baseHum + humOsc + (windowEffect * -5) + humRandom).toFixed(1));

        mockFeeds.push({
          time: time,
          temp: temp,
          humidity: humidity,
          id: (isSean ? 200000 : 100000) + (totalFeeds - i)
        });
      }

      appState.insideData = mockFeeds;
      const lastMockTime = mockFeeds[mockFeeds.length - 1].time;
      appState.lastSensorUpdate = { temp: lastMockTime, humidity: lastMockTime };
    }

    function updateStatusText(isLive) {
      const dot = document.getElementById('status-dot');
      const text = document.getElementById('status-text');
      
      if (isLive && !appState.isDemoMode) {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-teal-500 animate-pulse';
        text.innerText = 'ThingSpeak API live';
      } else {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse-slow';
        text.innerText = 'Demo-Modus aktiv';
      }
    }

    // Switch location selection & reload
    async function switchLocation(locId) {
      if (appState.activeLocId === locId) return;

      appState.activeLocId = locId;
      Store.set('selected_location', locId);

      const savedWeather = Store.get(`loc_weather_${locId}`);
      if (savedWeather) {
        appState.weatherConfig = JSON.parse(savedWeather);
      } else {
        const loc = LOCATIONS.find(l => l.id === locId);
        appState.weatherConfig = { ...loc.defaultWeather };
      }

      highlightActiveTab();
      updateWeatherButtonName();
      updateTabLabels();

      // Vergleichsmodus zurücksetzen — der Bezugsstandort hat sich geändert
      appState.compareMode = false;
      appState.compareData = null;
      updateCompareButton();

      // Automatically load the new location's datasets!
      await reloadData();

      // Archiv-Ansicht (falls geöffnet) auf den neuen Standort umschalten
      loadArchiveView(true);
    }

    // Render detailed dashboard metrics
    function renderActiveView() {
      try {
        const feeds = appState.insideData;
        const weather = appState.outsideData.current;
        const locId = appState.activeLocId;

        document.getElementById('detail-loc-title').innerText = getLocationName(locId);

        if (!feeds || feeds.length === 0) {
          console.warn('Keine Feeds zum Zeichnen vorhanden.');
          return;
        }

        const latest = feeds[feeds.length - 1];
        const curTempIn = latest.temp;
        const curHumIn = latest.humidity;

        // 1. Inside metrics
        document.getElementById('kpi-temp-in').innerText = curTempIn.toFixed(1);
        document.getElementById('kpi-humidity-in').innerText = curHumIn.toFixed(0);

        // Comfort Temp index (Schwellwerte konfigurierbar, siehe getThresholds)
        const th = getThresholds();
        let tempComfort = 'Behaglich';
        let tempComfortClass = 'text-teal-400';
        if (curTempIn < th.tempMin) {
          tempComfort = 'Kühl';
          tempComfortClass = 'text-blue-400';
        } else if (curTempIn > th.tempMax) {
          tempComfort = 'Warm';
          tempComfortClass = 'text-orange-400';
        }
        const tComfortEl = document.getElementById('kpi-temp-comfort');
        if (tComfortEl) {
          tComfortEl.innerText = tempComfort;
          tComfortEl.className = `font-semibold ${tempComfortClass}`;
        }

        // Comfort Hum index
        let humComfort = 'Optimal';
        let humComfortClass = 'text-emerald-400';
        if (curHumIn < th.humMin) {
          humComfort = 'Trocken';
          humComfortClass = 'text-amber-500';
        } else if (curHumIn > th.humMax) {
          humComfort = 'Feucht';
          humComfortClass = 'text-red-400';
        }
        const hComfortEl = document.getElementById('kpi-humidity-comfort');
        if (hComfortEl) {
          hComfortEl.innerText = humComfort;
          hComfortEl.className = `font-semibold ${humComfortClass}`;
        }

        // „Soll"-Labels der 24h-Statistik folgen den konfigurierten Schwellwerten
        const tTargetEl = document.getElementById('stat-temp-target');
        if (tTargetEl) tTargetEl.innerText = `Soll: ${th.tempMin} – ${th.tempMax} °C`;
        const hTargetEl = document.getElementById('stat-hum-target');
        if (hTargetEl) hTargetEl.innerText = `Soll: ${th.humMin} – ${th.humMax} %`;

        // Calculate Trends
        try {
          calculateTrends(feeds);
        } catch (e) {
          console.error('Fehler bei der Trendberechnung:', e);
        }

        // 2. Weather metrics
        let curTempOut = 0;
        let curHumOut = 0;
        
        if (weather) {
          curTempOut = weather.temperature_2m;
          curHumOut = weather.relative_humidity_2m;
          
          document.getElementById('kpi-temp-out').innerText = curTempOut.toFixed(1);
          document.getElementById('kpi-humidity-out').innerText = curHumOut.toFixed(0) + '%';
          document.getElementById('weather-desc').innerText = getWeatherDescription(weather.weather_code);
          
          updateWeatherIcon(weather.weather_code);
        }

        // "Zuletzt aktualisiert" labels on the KPI cards
        updateTimestampLabels();
        updateIcons();

        // 3. Ventilation Advice
        try {
          computeVentilationAdvisor(curTempIn, curHumIn, curTempOut, curHumOut, latest.co2 ?? null, getThresholds().co2Max);
        } catch (e) {
          console.error('Fehler beim Lüftungsberater:', e);
        }

        // 3b. Schimmelrisiko & Lüftungsfenster-Prognose
        try {
          computeMoldRisk(curTempIn, curHumIn, curTempOut, !!weather);
        } catch (e) {
          console.error('Fehler bei der Schimmelrisiko-Berechnung:', e);
        }
        try {
          renderVentilationForecast();
        } catch (e) {
          console.error('Fehler bei der Lüftungsfenster-Prognose:', e);
        }

        // 3c. Komfort-Score, Lüftungs-Erfolgskontrolle, Heizindikator, Wetterwarnungen
        try {
          renderComfortScore(curTempIn, curHumIn, curTempOut, !!weather, th);
        } catch (e) {
          console.error('Fehler beim Komfort-Score:', e);
        }
        try {
          renderVentilationSuccess(feeds);
        } catch (e) {
          console.error('Fehler bei der Lüftungs-Erfolgskontrolle:', e);
        }
        try {
          renderVentilationDiary(feeds);
        } catch (e) {
          console.error('Fehler beim Lüftungs-Tagebuch:', e);
        }
        try {
          renderHumidityTrend(feeds, th);
        } catch (e) {
          console.error('Fehler bei der Trend-Prognose:', e);
        }
        try {
          renderHeatingIndicator(feeds);
        } catch (e) {
          console.error('Fehler beim Heizindikator:', e);
        }
        try {
          renderHourlyPattern(); // Wochen-Muster (Plan4-16)
        } catch (e) {
          console.error('Fehler beim Wochen-Muster:', e);
        }
        try {
          checkWeatherWarnings();
        } catch (e) {
          console.error('Fehler bei den Wetterwarnungen:', e);
        }
        try {
          renderAirQuality();
        } catch (e) {
          console.error('Fehler bei der Luftqualität:', e);
        }

        // 4. Statistics 24h
        try {
          compute24hStats(feeds, curTempOut);
        } catch (e) {
          console.error('Fehler bei den 24h Statistiken:', e);
        }

        // 5. Draw lines
        try {
          drawChart();
        } catch (e) {
          console.error('Fehler beim Zeichnen des Diagramms:', e);
        }

        // 6. Table
        try {
          populateTable(feeds);
        } catch (e) {
          console.error('Fehler beim Befüllen der Tabelle:', e);
        }
      } catch (err) {
        console.error('Fataler Fehler in renderActiveView:', err);
      }
    }

    // Trend calculator
    function calculateTrends(feeds) {
      if (feeds.length < 15) return;

      const recent = feeds.slice(-3);
      const avgRecentTemp = recent.reduce((acc, f) => acc + f.temp, 0) / 3;
      const avgRecentHum = recent.reduce((acc, f) => acc + f.humidity, 0) / 3;

      const indexBack = Math.max(0, feeds.length - 20);
      const past = feeds.slice(indexBack, indexBack + 3);
      const avgPastTemp = past.reduce((acc, f) => acc + f.temp, 0) / 3;
      const avgPastHum = past.reduce((acc, f) => acc + f.humidity, 0) / 3;

      const tempDelta = avgRecentTemp - avgPastTemp;
      const humDelta = avgRecentHum - avgPastHum;

      // DOM updates
      const tTrend = document.getElementById('kpi-temp-in-trend');
      let tArrow = 'move-right', tColor = 'text-slate-400', tSign = tempDelta > 0.05 ? '+' : '';
      if (tempDelta > 0.08) { tArrow = 'trending-up'; tColor = 'text-orange-400'; }
      else if (tempDelta < -0.08) { tArrow = 'trending-down'; tColor = 'text-blue-400'; }
      tTrend.className = `flex items-center gap-0.5 font-medium ${tColor}`;
      tTrend.innerHTML = `<i data-lucide="${tArrow}" class="w-3.5 h-3.5 inline"></i> ${tSign}${tempDelta.toFixed(1)}°C/h`;

      const hTrend = document.getElementById('kpi-humidity-in-trend');
      let hArrow = 'move-right', hColor = 'text-slate-400', hSign = humDelta > 0.5 ? '+' : '';
      if (humDelta > 1) { hArrow = 'trending-up'; hColor = 'text-blue-400'; }
      else if (humDelta < -1) { hArrow = 'trending-down'; hColor = 'text-emerald-400'; }
      hTrend.className = `flex items-center gap-0.5 font-medium ${hColor}`;
      hTrend.innerHTML = `<i data-lucide="${hArrow}" class="w-3.5 h-3.5 inline"></i> ${hSign}${humDelta.toFixed(0)}%/h`;
    }

    // Weather icon mapping
    function updateWeatherIcon(code) {
      const container = document.getElementById('weather-icon-container');
      let icon = 'cloud-sun', colorClass = 'text-teal-400';
      if (code === 0) { icon = 'sun'; colorClass = 'text-amber-400'; }
      else if (code >= 1 && code <= 3) { icon = 'cloud-sun'; colorClass = 'text-teal-400'; }
      else if (code === 45 || code === 48) { icon = 'cloud-fog'; colorClass = 'text-slate-400'; }
      else if (code >= 51 && code <= 82) { icon = 'cloud-rain'; colorClass = 'text-blue-400'; }
      else if (code >= 71 && code <= 75) { icon = 'snowflake'; colorClass = 'text-sky-300'; }
      else if (code >= 95) { icon = 'cloud-lightning'; colorClass = 'text-blue-400'; }

      container.className = `w-12 h-12 rounded-xl bg-teal-500/10 border border-teal-500/20 flex items-center justify-center ${colorClass}`;
      container.innerHTML = `<i data-lucide="${icon}" class="w-6 h-6"></i>`;
    }

    // Ventilation recommendation advisor
    function computeVentilationAdvisor(inTemp, inRh, outTemp, outRh, co2 = null, co2Max = null) {
      const ahIn = getAbsoluteHumidity(inTemp, inRh);
      const ahOut = getAbsoluteHumidity(outTemp, outRh);
      const diff = ahIn - ahOut;

      document.getElementById('abs-hum-in').innerText = `${ahIn.toFixed(1)} g/m³`;
      document.getElementById('abs-hum-out').innerText = `${ahOut.toFixed(1)} g/m³`;

      const widthIn = Math.min(100, (ahIn / 20) * 100);
      const widthOut = Math.min(100, (ahOut / 20) * 100);
      document.getElementById('bar-abs-hum-in').style.width = `${widthIn}%`;
      document.getElementById('bar-abs-hum-out').style.width = `${widthOut}%`;

      const badge = document.getElementById('ventilation-badge');
      const circle = document.getElementById('ventilation-circle');
      const icon = document.getElementById('ventilation-icon');
      const verdict = document.getElementById('ventilation-verdict');
      const title = document.getElementById('ventilation-title');
      const desc = document.getElementById('ventilation-short-desc');
      const expl = document.getElementById('ventilation-explanation');
      const tip = document.getElementById('ventilation-tip');

      if (diff > 0.8) {
        // „Dringend"-Schwelle folgt dem konfigurierten Feuchte-Maximum (knapp darunter)
        if (inRh > getThresholds().humMax - 2) {
          badge.className = 'px-2.5 py-1 rounded-full text-xs font-semibold tracking-wider flex items-center gap-1 bg-red-500/10 border border-red-500/20 text-red-400';
          badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span><span>Wichtig!</span>';
          circle.className = 'w-28 h-28 rounded-full flex flex-col items-center justify-center border-4 border-emerald-500 bg-slate-950 shadow-[0_0_15px_rgba(16,185,129,0.3)] relative transition-[width] duration-500';
          icon.className = 'w-8 h-8 text-emerald-400 transition-colors duration-500';
          icon.setAttribute('data-lucide', 'wind');
          verdict.innerText = 'LÜFTEN';
          verdict.className = 'text-xs font-bold mt-1 text-emerald-400';
          title.innerText = 'Dringend lüften';
          desc.innerText = 'Erhöhte Schimmelgefahr im Zimmer.';
          expl.innerText = `Die Außenluft ist wesentlich trockener (${ahOut.toFixed(1)} g/m³) als drinnen (${ahIn.toFixed(1)} g/m³). Durch Lüften wird die Feuchte rasch gesenkt.`;
          tip.innerText = outTemp < 6 ? 'Tipp: Stoßlüften für 3-5 Minuten (nicht dauerhaft kippen, um Wände nicht auszukühlen).' : 'Tipp: Fenster für 10-15 Minuten weit öffnen.';
        } else {
          badge.className = 'px-2.5 py-1 rounded-full text-xs font-semibold tracking-wider flex items-center gap-1 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400';
          badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500"></span><span>Empfohlen</span>';
          circle.className = 'w-28 h-28 rounded-full flex flex-col items-center justify-center border-4 border-emerald-500 bg-slate-950 shadow-inner relative transition-[width] duration-500';
          icon.className = 'w-8 h-8 text-emerald-400 transition-colors duration-500';
          icon.setAttribute('data-lucide', 'wind');
          verdict.innerText = 'LÜFTEN';
          verdict.className = 'text-xs font-bold mt-1 text-emerald-400';
          title.innerText = 'Lüften empfohlen';
          desc.innerText = 'Entfeuchtet den Raum effizient.';
          expl.innerText = `Lüften führt dem Raum trockene Außenluft zu (Außen: ${ahOut.toFixed(1)} g/m³ | Innen: ${ahIn.toFixed(1)} g/m³).`;
          tip.innerText = 'Tipp: Regelmäßiger Luftaustausch verbessert auch den CO2-Wert im Raum.';
        }
      } else if (diff < -0.4) {
        badge.className = 'px-2.5 py-1 rounded-full text-xs font-semibold tracking-wider flex items-center gap-1 bg-red-500/10 border border-red-500/20 text-red-400';
        badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-red-500"></span><span>Geschlossen</span>';
        circle.className = 'w-28 h-28 rounded-full flex flex-col items-center justify-center border-4 border-red-500 bg-slate-950 shadow-inner relative transition-[width] duration-500';
        icon.className = 'w-8 h-8 text-red-400 transition-colors duration-500';
        icon.setAttribute('data-lucide', 'lock');
        verdict.innerText = 'SCHLIESSEN';
        verdict.className = 'text-xs font-bold mt-1 text-red-400';
        title.innerText = 'Fenster geschlossen halten';
        desc.innerText = 'Außenluft ist zu feucht.';
        expl.innerText = `Die Außenluft trägt mehr Feuchte (${ahOut.toFixed(1)} g/m³) als drinnen (${ahIn.toFixed(1)} g/m³). Das Öffnen der Fenster würde die Raumfeuchte ansteigen lassen.`;
        tip.innerText = inTemp > 24 ? 'Tipp: Fenster tagsüber geschlossen halten, um sommerliche Schwüle auszusperren.' : 'Tipp: Warte auf trockenere Stunden am Abend/Morgen.';
      } else {
        badge.className = 'px-2.5 py-1 rounded-full text-xs font-semibold tracking-wider flex items-center gap-1 bg-slate-900 border border-slate-800 text-slate-400';
        badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-slate-500"></span><span>Neutral</span>';
        circle.className = 'w-28 h-28 rounded-full flex flex-col items-center justify-center border-4 border-slate-700 bg-slate-950 shadow-inner relative transition-[width] duration-500';
        icon.className = 'w-8 h-8 text-slate-400 transition-colors duration-500';
        icon.setAttribute('data-lucide', 'minus');
        verdict.innerText = 'EGAL';
        verdict.className = 'text-xs font-bold mt-1 text-slate-400';
        title.innerText = 'Lüften optional';
        desc.innerText = 'Nahezu identische Feuchtigkeitswerte.';
        expl.innerText = `Die absolute Feuchtigkeit ist drinnen (${ahIn.toFixed(1)} g/m³) und draußen (${ahOut.toFixed(1)} g/m³) fast gleich. Lüften hat keinen Einfluss auf Feuchte.`;
        tip.innerText = 'Tipp: Lüfte bei Bedarf, um verbrauchte Luft gegen Frischluft auszutauschen.';
      }

      // Luftqualitäts-Hinweis (P8): Bei belasteter Außenluft ans knappe Lüften erinnern
      const aq = appState.airQuality;
      if (aq && aq.european_aqi !== null && aq.european_aqi !== undefined && aq.european_aqi > 60) {
        tip.innerText += ` ⚠ Außenluft aktuell belastet (AQI ${Math.round(aq.european_aqi)}, ${classifyAqi(aq.european_aqi).label}) – nur kurz stoßlüften.`;
      }

      // CO₂-Kopplung (P8): ist ein CO₂-Sensor konfiguriert und der Wert hoch,
      // ist Lüften unabhängig vom Feuchtevergleich zum Luftaustausch ratsam.
      if (co2 != null && co2Max && co2 > co2Max) {
        tip.innerText += ` 🫁 CO₂ erhöht (${Math.round(co2)} ppm) – zum Luftaustausch kurz stoßlüften.`;
      }
    }

    // Taupunkt & Schimmelrisiko: schätzt die Oberflächentemperatur der kältesten
    // Wandstelle über den Temperaturfaktor fRsi (DIN 4108-2: Mindeststandard 0,7)
    // und berechnet daraus die relative Feuchte direkt an der Wandoberfläche.
    // Ab ~80 % Oberflächenfeuchte kann Schimmel wachsen, ab 100 % kondensiert Wasser.
    function computeMoldRisk(inTemp, inRh, outTemp, hasWeather) {
      const badge = document.getElementById('mold-badge');
      const desc = document.getElementById('mold-desc');
      if (!badge || !desc) return;

      if (!hasWeather || [inTemp, inRh, outTemp].some(v => v === null || v === undefined || isNaN(v))) {
        desc.innerText = 'Keine Wetterdaten verfügbar – Risiko kann nicht berechnet werden.';
        return;
      }

      const dewPoint = getDewPoint(inTemp, inRh);
      // Wandoberflächen-Feuchte via getestete Kernfunktion (lib/core.js)
      const { surfaceTemp, surfaceRhRaw, surfaceRh } = surfaceHumidity(inTemp, inRh, outTemp);

      document.getElementById('mold-dewpoint').innerText = dewPoint === null ? '--.-°C' : `${dewPoint.toFixed(1)}°C`;
      document.getElementById('mold-surface-temp').innerText = `${surfaceTemp.toFixed(1)}°C`;
      document.getElementById('mold-surface-rh').innerText = `${surfaceRh.toFixed(0)}%`;
      document.getElementById('mold-bar-label').innerText = `${surfaceRh.toFixed(0)}%`;

      const bar = document.getElementById('mold-bar');
      bar.style.width = `${surfaceRh}%`;

      const badgeBase = 'px-2.5 py-1 rounded-full text-xs font-semibold tracking-wider flex items-center gap-1';
      const barBase = 'h-full rounded-full transition-[width] duration-500';

      if (surfaceRhRaw >= 100) {
        badge.className = `${badgeBase} bg-red-500/10 border border-red-500/20 text-red-400`;
        badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span><span>Kondensat!</span>';
        bar.className = `${barBase} bg-red-500`;
        desc.innerText = `Achtung: Der Taupunkt der Raumluft (${dewPoint.toFixed(1)} °C) liegt über der geschätzten Temperatur kalter Wandstellen (${surfaceTemp.toFixed(1)} °C) – dort schlägt sich aktuell Wasser nieder. Feuchte dringend senken (siehe Lüftungsberater) und den Raum stärker heizen.`;
        sendPush(
          'ClimateFlow Kondensat-Warnung',
          `Kondensatgefahr bei „${getLocationName(appState.activeLocId)}": Taupunkt ${dewPoint.toFixed(1)} °C über Wandtemperatur ${surfaceTemp.toFixed(1)} °C. Dringend lüften/heizen!`,
          'rotating_light,droplet',
          `mold_${appState.activeLocId}`,
          12 * 60 * 60 * 1000
        );
      } else if (surfaceRhRaw >= 80) {
        badge.className = `${badgeBase} bg-orange-500/10 border border-orange-500/20 text-orange-400`;
        badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-orange-500 animate-pulse"></span><span>Erhöht</span>';
        bar.className = `${barBase} bg-orange-500`;
        desc.innerText = `An kalten Wandstellen liegt die Luftfeuchte bei ca. ${surfaceRh.toFixed(0)} % – ab 80 % kann Schimmel wachsen. Raumfeuchte senken (Lüftungsberater beachten) und Außenwände nicht durch Möbel verdecken.`;
        sendPush(
          'ClimateFlow Schimmel-Warnung',
          `Erhöhtes Schimmelrisiko bei „${getLocationName(appState.activeLocId)}": ca. ${surfaceRh.toFixed(0)} % Feuchte an kalten Wandstellen. Lüften/heizen empfohlen.`,
          'warning,droplet',
          `mold_${appState.activeLocId}`,
          12 * 60 * 60 * 1000
        );
      } else if (surfaceRhRaw >= 70) {
        badge.className = `${badgeBase} bg-amber-500/10 border border-amber-500/20 text-amber-400`;
        badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-amber-500"></span><span>Beobachten</span>';
        bar.className = `${barBase} bg-amber-500`;
        desc.innerText = `Die Wandfeuchte liegt bei ca. ${surfaceRh.toFixed(0)} % – noch unkritisch, aber nicht weit von der 80-%-Schwelle. Regelmäßiges Stoßlüften hält das Risiko niedrig.`;
      } else {
        badge.className = `${badgeBase} bg-emerald-500/10 border border-emerald-500/20 text-emerald-400`;
        badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500"></span><span>Gering</span>';
        bar.className = `${barBase} bg-emerald-500`;
        desc.innerText = `Alles im grünen Bereich: Selbst an kalten Wandstellen bleibt die Luftfeuchte mit ca. ${surfaceRh.toFixed(0)} % deutlich unter der Schimmelschwelle von 80 %.`;
      }
    }

    // Lüftungsfenster-Prognose: bewertet jede Stunde der nächsten 24h danach,
    // wie viel trockener die Außenluft (absolute Feuchte) als die Raumluft ist.
    function renderVentilationForecast() {
      const strip = document.getElementById('vent-forecast-strip');
      const labels = document.getElementById('vent-forecast-labels');
      const summary = document.getElementById('vent-forecast-summary');
      if (!strip || !summary) return;

      const hourly = appState.outsideData ? appState.outsideData.hourly : null;
      const feeds = appState.insideData;
      if (!hourly || !hourly.time || !feeds || feeds.length === 0) {
        summary.innerText = 'Keine Prognosedaten verfügbar.';
        return;
      }

      const latest = feeds[feeds.length - 1];
      const ahIn = getAbsoluteHumidity(latest.temp, latest.humidity);

      const nowMs = Date.now();
      const horizonMs = nowMs + 24 * 60 * 60 * 1000;
      const hours = [];
      for (let i = 0; i < hourly.time.length; i++) {
        const ms = typeof hourly.time[i] === 'number' ? hourly.time[i] * 1000 : new Date(hourly.time[i]).getTime();
        if (ms < nowMs - 30 * 60 * 1000 || ms > horizonMs) continue;
        const t = hourly.temperature_2m[i];
        const rh = hourly.relative_humidity_2m[i];
        if (t === null || t === undefined || rh === null || rh === undefined) continue;
        const ahOut = getAbsoluteHumidity(t, rh);
        hours.push({ ms, date: new Date(ms), temp: t, ahOut, diff: ahIn - ahOut });
      }

      if (hours.length === 0) {
        summary.innerText = 'Keine Prognosedaten für die nächsten 24 Stunden verfügbar.';
        return;
      }

      strip.innerHTML = '';
      hours.forEach(h => {
        const cell = document.createElement('div');
        let colorClass = 'bg-slate-600/70';
        if (h.diff > 0.8) colorClass = 'bg-emerald-500';
        else if (h.diff < 0) colorClass = 'bg-red-500/80';
        cell.className = `flex-1 h-full rounded-sm ${colorClass} transition-colors`;
        cell.title = `${formatTime(h.date)} Uhr · außen ${h.ahOut.toFixed(1)} g/m³ bei ${h.temp.toFixed(0)} °C · ${h.diff >= 0 ? 'trockener' : 'feuchter'} als innen (${Math.abs(h.diff).toFixed(1)} g/m³)`;
        strip.appendChild(cell);
      });

      if (labels) {
        labels.innerHTML = `<span>${formatTime(hours[0].date)}</span><span>${formatTime(hours[Math.floor(hours.length / 2)].date)}</span><span>${formatTime(hours[hours.length - 1].date)}</span>`;
      }

      // Bestes zusammenhängendes Fenster wirksamer Stunden (niedrigste mittlere Außenfeuchte)
      let best = null;
      let run = null;
      const closeRun = () => {
        if (run && (!best || run.sum / run.n < best.sum / best.n)) best = run;
        run = null;
      };
      hours.forEach(h => {
        if (h.diff > 0.8) {
          if (!run) run = { start: h, end: h, sum: 0, n: 0 };
          run.end = h;
          run.sum += h.ahOut;
          run.n++;
        } else {
          closeRun();
        }
      });
      closeRun();

      if (best) {
        const today = new Date().getDate();
        const startDay = best.start.date.getDate() === today ? 'heute' : 'morgen';
        const endDate = new Date(best.end.ms + 60 * 60 * 1000);
        // Fenster über Mitternacht: Endzeit mit eigenem Tages-Label kennzeichnen
        const endDay = endDate.getDate() === best.start.date.getDate() ? '' : (endDate.getDate() === today ? 'heute ' : 'morgen ');
        const windowLabel = `${startDay} ${formatTime(best.start.date)} – ${endDay}${formatTime(endDate)} Uhr`;
        summary.innerHTML = `Bestes Lüftungsfenster: <strong class="text-teal-300">${windowLabel.charAt(0).toUpperCase()}${windowLabel.slice(1)}</strong> – Außenluft dann im Schnitt ${(best.sum / best.n).toFixed(1)} g/m³ (Raumluft aktuell ${ahIn.toFixed(1)} g/m³).`;
      } else {
        summary.innerText = `In den nächsten 24 Stunden bringt Lüften kaum Entfeuchtung – die Außenluft ist durchgehend ähnlich feucht oder feuchter als die Raumluft (aktuell ${ahIn.toFixed(1)} g/m³ innen).`;
      }
    }
