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
            ? 'px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-teal-500 text-slate-950 shadow-md shadow-teal-500/10 transition-all'
            : 'px-3.5 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200 transition-all';
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
            defaultName: l.name || l.id,
            defaultWeather: { lat: l.lat, lon: l.lon, name: l.name || l.id },
            fields: l.fields || { temp: 'field1', humidity: 'field2', extra: [] }
          });
        });
      } catch (err) {
        // kein D1 / keine Zusatz-Standorte → nur die fest verdrahteten
      }
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

      try {
        const data = await fetchFeeds(activeLoc, { results: 8000, start });
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

        appState.feedCache[activeLoc.id] = { rawFeeds };
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
          appState.insideData = processed.aligned;
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
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP-Fehler: ${res.status}`);
        
        const data = await res.json();
        appState.outsideData = data;
      } catch (err) {
        console.warn('Open-Meteo laden fehlgeschlagen, generiere Wetter-Dummy:', err);
        appState.outsideData = generateMockWeather();
      }
    }

    // Außenluft-Qualität (Open-Meteo Air-Quality-API, kostenlos, ohne Key):
    // Europäischer AQI, Feinstaub, Ozon und Pollen. Best effort — ohne Daten
    // bleibt die Anzeige leer und der Lüftungsberater arbeitet wie bisher.
    async function loadAirQuality() {
      try {
        const conf = appState.weatherConfig;
        if (!conf) { appState.airQuality = null; return; }
        const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${conf.lat}&longitude=${conf.lon}&current=european_aqi,pm2_5,pm10,ozone,birch_pollen,grass_pollen&timezone=auto`;
        const res = await fetch(url);
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
        dot.className = 'w-2.5 h-2.5 rounded-full bg-teal-500 shadow-[0_0_8px_#14b8a6] animate-pulse';
        text.innerText = 'ThingSpeak API live';
      } else {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-amber-500 shadow-[0_0_8px_#f59e0b] animate-pulse-slow';
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
      else if (code >= 95) { icon = 'cloud-lightning'; colorClass = 'text-indigo-400'; }

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
          circle.className = 'w-28 h-28 rounded-full flex flex-col items-center justify-center border-4 border-emerald-500 bg-slate-950 shadow-[0_0_15px_rgba(16,185,129,0.3)] relative transition-all duration-500';
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
          circle.className = 'w-28 h-28 rounded-full flex flex-col items-center justify-center border-4 border-emerald-500 bg-slate-950 shadow-inner relative transition-all duration-500';
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
        circle.className = 'w-28 h-28 rounded-full flex flex-col items-center justify-center border-4 border-red-500 bg-slate-950 shadow-inner relative transition-all duration-500';
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
        circle.className = 'w-28 h-28 rounded-full flex flex-col items-center justify-center border-4 border-slate-700 bg-slate-950 shadow-inner relative transition-all duration-500';
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
      const barBase = 'h-full rounded-full transition-all duration-500 bg-gradient-to-r';

      if (surfaceRhRaw >= 100) {
        badge.className = `${badgeBase} bg-red-500/10 border border-red-500/20 text-red-400`;
        badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span><span>Kondensat!</span>';
        bar.className = `${barBase} from-red-500 to-red-400`;
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
        bar.className = `${barBase} from-orange-500 to-red-400`;
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
        bar.className = `${barBase} from-amber-500 to-orange-400`;
        desc.innerText = `Die Wandfeuchte liegt bei ca. ${surfaceRh.toFixed(0)} % – noch unkritisch, aber nicht weit von der 80-%-Schwelle. Regelmäßiges Stoßlüften hält das Risiko niedrig.`;
      } else {
        badge.className = `${badgeBase} bg-emerald-500/10 border border-emerald-500/20 text-emerald-400`;
        badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500"></span><span>Gering</span>';
        bar.className = `${barBase} from-emerald-500 to-emerald-400`;
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

    // ============ Komfort-Score (0–100) ============
    // Bewertet das aktuelle Raumklima über die getestete Kernfunktion
    // comfortScore (lib/core.js) — inkl. Schimmelrisiko-Abzug, falls Wetterdaten da.
    function renderComfortScore(inTemp, inRh, outTemp, hasWeather, th) {
      const valEl = document.getElementById('comfort-score-value');
      const labelEl = document.getElementById('comfort-score-label');
      const barEl = document.getElementById('comfort-score-bar');
      if (!valEl) return;

      let sRh = null;
      if (hasWeather) {
        const surf = surfaceHumidity(inTemp, inRh, outTemp);
        if (surf) sRh = surf.surfaceRhRaw;
      }
      const score = comfortScore(inTemp, inRh, sRh, th);
      if (score === null) {
        valEl.innerText = '--';
        if (labelEl) labelEl.innerText = 'keine Daten';
        return;
      }

      let label = 'Sehr gut', color = 'text-emerald-400', barColor = 'from-emerald-500 to-emerald-400';
      if (score < 40) { label = 'Schlecht'; color = 'text-red-400'; barColor = 'from-red-500 to-red-400'; }
      else if (score < 60) { label = 'Mäßig'; color = 'text-orange-400'; barColor = 'from-orange-500 to-orange-400'; }
      else if (score < 80) { label = 'Okay'; color = 'text-amber-400'; barColor = 'from-amber-500 to-amber-400'; }
      else if (score < 95) { label = 'Gut'; color = 'text-teal-400'; barColor = 'from-teal-500 to-teal-400'; }

      valEl.innerText = score;
      valEl.className = `text-sm font-bold mt-0.5 ${color}`;
      if (labelEl) {
        labelEl.innerText = label;
        labelEl.className = `font-semibold ${color}`;
      }
      if (barEl) {
        barEl.style.width = `${score}%`;
        barEl.className = `h-full rounded-full transition-all duration-500 bg-gradient-to-r ${barColor}`;
      }
    }

    // ============ Lüftungs-Erfolgskontrolle ============
    // Erkennt vergangenes Stoßlüften in den letzten 48 h (getestete Kernfunktion
    // detectVentilationEvents) und zeigt den Effekt des letzten Ereignisses.
    function renderVentilationSuccess(feeds) {
      const el = document.getElementById('vent-success');
      if (!el) return;

      const cutoff = Date.now() - 48 * 60 * 60 * 1000;
      const recent = feeds.filter(f => f.time.getTime() >= cutoff);
      const events = detectVentilationEvents(recent);

      if (events.length === 0) {
        el.innerHTML = `<span class="text-slate-500">In den letzten 48 h wurde kein Stoßlüften erkannt.</span>`;
        return;
      }

      const last = events[events.length - 1];
      const today = new Date().getDate();
      const dayLabel = last.start.getDate() === today ? 'heute' : 'gestern';
      const countNote = events.length > 1 ? ` · ${events.length}× gelüftet in 48 h` : '';
      el.innerHTML =
        `<span class="text-emerald-400 font-semibold">Zuletzt gelüftet ${dayLabel} ${formatTime(last.start)} Uhr:</span> ` +
        `Feuchte <strong class="text-white">−${last.humDrop.toFixed(0)} %</strong> (${last.humBefore.toFixed(0)} → ${last.humAfter.toFixed(0)} %), ` +
        `Temperatur −${last.tempDrop.toFixed(1)} °C${countNote}.`;
    }

    // Lüftungs-Tagebuch (P5): erkannte Stoßlüftungen der letzten 14 Tage als
    // Statistik + Tagesbalken (ventilationStats, lib/core.js).
    function renderVentilationDiary(feeds) {
      const barsEl = document.getElementById('vent-diary-bars');
      const statEl = document.getElementById('vent-diary-stat');
      if (!barsEl) return;

      const cutoff = Date.now() - 15 * 24 * 60 * 60 * 1000;
      const recent = feeds.filter(f => f.time.getTime() >= cutoff);
      const events = detectVentilationEvents(recent).map(e => ({ startMs: e.start.getTime(), humDrop: e.humDrop }));
      const stats = ventilationStats(events, { days: 14 });

      if (statEl) {
        statEl.innerText = stats.count === 0
          ? 'noch keine Lüftung erkannt'
          : `${stats.count}× · Ø ${stats.perDay.toFixed(1)}/Tag${stats.avgHumDrop ? ` · −${stats.avgHumDrop.toFixed(0)} %` : ''}${stats.topHour != null ? ` · meist ${stats.topHour}–${(stats.topHour + 1) % 24} Uhr` : ''}`;
      }

      const max = Math.max(1, ...stats.dailyCounts.map(d => d.count));
      barsEl.innerHTML = '';
      stats.dailyCounts.forEach(d => {
        const bar = document.createElement('div');
        const h = d.count === 0 ? 4 : Math.round((d.count / max) * 36) + 4;
        bar.className = `flex-1 rounded-t ${d.count > 0 ? 'bg-teal-500/70' : 'bg-slate-800'}`;
        bar.style.height = `${h}px`;
        const dd = new Date(`${d.day}T12:00:00`);
        bar.title = `${dd.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}: ${d.count}× gelüftet`;
        barsEl.appendChild(bar);
      });
    }

    // Feuchte-Trend-Prognose (P7): lineare Regression über die letzten ~3 h,
    // warnt, wann die obere Feuchte-Schwelle erreicht wird (trendForecast).
    function renderHumidityTrend(feeds, th) {
      const row = document.getElementById('vent-trend-row');
      const el = document.getElementById('vent-trend');
      if (!row || !el) return;

      const aligned = feeds.map(f => ({ time: f.time, humidity: f.humidity, temp: f.temp }));
      const threshold = (th && th.humMax) || 60;
      const tf = trendForecast(aligned, { field: 'humidity', threshold });
      if (!tf || Math.abs(tf.slopePerHour) < 0.3) { row.classList.add('hidden'); return; }

      const dir = tf.slopePerHour > 0 ? 'steigt' : 'fällt';
      let msg = `Feuchte ${dir} um ~${Math.abs(tf.slopePerHour).toFixed(1)} %/h (aktuell ${tf.current.toFixed(0)} %).`;
      if (tf.etaMs) {
        const hrs = (tf.etaMs - Date.now()) / 3600000;
        if (hrs > 0 && hrs < 12) {
          const when = new Date(tf.etaMs).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
          msg += ` Bei diesem Trend werden ${threshold} % gegen ${when} Uhr erreicht — vorher lüften.`;
        }
      }
      el.innerText = msg;
      row.classList.remove('hidden');
      updateIcons();
    }

    // ============ Heizaufwand-Indikator ============
    // Innen-/Außentemperatur-Paare der letzten 48 h bilden und den relativen
    // Heizaufwand heute vs. gestern anzeigen (heatingDemandIndex, lib/core.js).
    function buildInOutPairs(feeds, hourly) {
      if (!hourly || !hourly.time || hourly.time.length === 0) return [];
      const hourlyMs = hourly.time.map(t => typeof t === 'number' ? t * 1000 : new Date(t).getTime());
      const cutoff = Date.now() - 48 * 60 * 60 * 1000;
      const maxMatchDistMs = 45 * 60 * 1000;

      const pairs = [];
      feeds.forEach(f => {
        const ms = f.time.getTime();
        if (ms < cutoff) return;
        let minDiff = Infinity, closest = -1;
        for (let i = 0; i < hourlyMs.length; i++) {
          const diff = Math.abs(ms - hourlyMs[i]);
          if (diff < minDiff) { minDiff = diff; closest = i; }
        }
        pairs.push({
          ms,
          tin: f.temp,
          tout: closest !== -1 && minDiff <= maxMatchDistMs ? hourly.temperature_2m[closest] : null
        });
      });
      return pairs;
    }

    function renderHeatingIndicator(feeds) {
      const el = document.getElementById('stat-heating');
      if (!el) return;

      const hourly = appState.outsideData ? appState.outsideData.hourly : null;
      const { today, yesterday, changePct } = heatingDemandIndex(buildInOutPairs(feeds, hourly), Date.now());

      if (today === null) {
        el.innerHTML = '';
        return;
      }
      if (today < 0.5) {
        el.innerHTML = `<span class="font-medium text-slate-300">Heizaufwand:</span> aktuell praktisch keiner — draußen ist es ähnlich warm wie drinnen.`;
        return;
      }

      let compare = '';
      if (changePct !== null) {
        const pct = Math.abs(changePct).toFixed(0);
        if (changePct > 5) compare = ` — <span class="font-bold text-orange-400">~${pct} % höher</span> als gestern`;
        else if (changePct < -5) compare = ` — <span class="font-bold text-emerald-400">~${pct} % niedriger</span> als gestern`;
        else compare = ' — etwa wie gestern';
      }
      el.innerHTML = `<span class="font-medium text-slate-300">Heizaufwand (rel.):</span> Ø <span class="font-bold text-white">${today.toFixed(1)} °C</span> Differenz zur Außenluft heute${compare}.`;
    }

    // ============ Frost-/Hitzewarnung (Open-Meteo-Prognose) ============
    // Frost: Tiefstwert der nächsten 15 h ≤ 0 °C. Hitze: Höchstwert der
    // nächsten 36 h ≥ 30 °C. Anzeige in der Wetter-KPI-Karte + ntfy-Push
    // (gedrosselt auf 1×/18 h pro Warnungstyp und Standort).
    function checkWeatherWarnings() {
      const el = document.getElementById('weather-alert');
      if (!el) return;

      const hourly = appState.outsideData ? appState.outsideData.hourly : null;
      if (!hourly || !hourly.time) {
        el.classList.add('hidden');
        return;
      }

      const nowMs = Date.now();
      const night = forecastExtremes(hourly.time, hourly.temperature_2m, nowMs, 15);
      const heat = forecastExtremes(hourly.time, hourly.temperature_2m, nowMs, 36);
      const locName = getLocationName(appState.activeLocId);

      if (night && night.min <= 0) {
        el.innerHTML = `<i data-lucide="snowflake" class="w-3.5 h-3.5 inline"></i> Frost: Tiefstwert ${night.min.toFixed(1)} °C gegen ${formatTime(new Date(night.minAtMs))} Uhr`;
        el.className = 'mt-2 text-[11px] font-semibold text-sky-300 flex items-center gap-1';
        sendPush(
          'ClimateFlow Frost-Warnung',
          `Frost bei „${locName}": Tiefstwert ${night.min.toFixed(1)} °C gegen ${formatTime(new Date(night.minAtMs))} Uhr. Fenster schließen, empfindliche Pflanzen schützen.`,
          'snowflake',
          `frost_${appState.activeLocId}`,
          18 * 60 * 60 * 1000
        );
      } else if (heat && heat.max >= 30) {
        el.innerHTML = `<i data-lucide="sun" class="w-3.5 h-3.5 inline"></i> Hitze: bis ${heat.max.toFixed(1)} °C ${heat.maxAtMs - nowMs > 20 * 3600 * 1000 ? 'morgen' : 'heute'} ${formatTime(new Date(heat.maxAtMs))} Uhr`;
        el.className = 'mt-2 text-[11px] font-semibold text-orange-400 flex items-center gap-1';
        sendPush(
          'ClimateFlow Hitze-Warnung',
          `Hitze bei „${locName}": bis ${heat.max.toFixed(1)} °C erwartet (${formatTime(new Date(heat.maxAtMs))} Uhr). Morgens lüften, tagsüber Fenster und Rollos schließen.`,
          'sun',
          `heat_${appState.activeLocId}`,
          18 * 60 * 60 * 1000
        );
      } else {
        el.classList.add('hidden');
        return;
      }
      el.classList.remove('hidden');
      updateIcons();
    }

    // 24h stats
    function compute24hStats(feeds, curTempOut) {
      const now = new Date();
      const threshold = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const feeds24h = feeds.filter(f => f.time >= threshold);
      if (feeds24h.length === 0) return;

      const temps = feeds24h.map(f => f.temp);
      const hums = feeds24h.map(f => f.humidity);

      const tMin = Math.min(...temps), tMax = Math.max(...temps), tAvg = temps.reduce((a, b) => a + b, 0) / temps.length;
      const hMin = Math.min(...hums), hMax = Math.max(...hums), hAvg = hums.reduce((a, b) => a + b, 0) / hums.length;

      document.getElementById('stat-temp-min').innerText = `${tMin.toFixed(1)}°C`;
      document.getElementById('stat-temp-max').innerText = `${tMax.toFixed(1)}°C`;
      document.getElementById('stat-temp-avg').innerText = `${tAvg.toFixed(1)}°C`;

      document.getElementById('stat-hum-min').innerText = `${hMin.toFixed(0)}%`;
      document.getElementById('stat-hum-max').innerText = `${hMax.toFixed(0)}%`;
      document.getElementById('stat-hum-avg').innerText = `${hAvg.toFixed(0)}%`;

      const diff = Math.abs(tAvg - curTempOut);
      document.getElementById('stat-temp-diff-out').innerText = `${diff.toFixed(1)}°C`;
      document.getElementById('stat-temp-diff-desc').innerText = tAvg > curTempOut ? 'höher' : 'tiefer';
    }

    // Zeitraum-Filter + Ausdünnung für den Klimaverlauf (auch für Vergleichsdaten)
    function filterForTimeframe(data, timeframeHours) {
      let filtered = data || [];
      if (timeframeHours > 0) {
        const threshold = new Date(Date.now() - timeframeHours * 60 * 60 * 1000);
        filtered = filtered.filter(f => f.time >= threshold);
      }
      const maxPoints = 400;
      if (filtered.length > maxPoints) {
        const step = Math.ceil(filtered.length / maxPoints);
        filtered = filtered.filter((_, idx) => idx % step === 0);
      }
      return filtered;
    }

    // Draw Line Chart.js
    function drawChart() {
      const ctx = document.getElementById('climateChart').getContext('2d');
      const timeframeHours = appState.currentChartTimeframe;
      const filtered = filterForTimeframe(appState.insideData, timeframeHours);

      // Echte Zeitachse: Datenpunkte tragen ms-Zeitstempel als x-Wert, damit
      // zeitliche Lücken proportional dargestellt werden (statt Kategorie-Achse).
      const insideTemp = filtered.map(f => ({ x: f.time.getTime(), y: f.temp }));
      const insideHum = filtered.map(f => ({ x: f.time.getTime(), y: f.humidity }));

      // CO₂-Serie (P8): nur wenn der aktive Standort einen co2-Extra-Sensor hat
      // und tatsächlich Werte liefert — sonst bleibt der Chart unveraendert.
      const hasCo2 = (getLocationFields(appState.activeLocId).extra || []).some(e => e.key === 'co2');
      const co2Data = hasCo2 ? filtered.map(f => ({ x: f.time.getTime(), y: f.co2 != null ? f.co2 : null })) : [];
      const hasCo2Data = co2Data.some(p => p.y != null);

      // Outdoor weather alignment (zeitzonen-sicher über absolute Zeitstempel).
      // Pro Innen-Messpunkt wird die zeitlich nächste Open-Meteo-Stunde gesucht;
      // liegt keine Stunde nah genug (>45 Min), bleibt der Punkt leer (Lücke im Chart)
      // statt einen falschen Wert anzuzeigen.
      const outsideTemp = [];
      const hourly = appState.outsideData.hourly;
      if (hourly && hourly.time && hourly.time.length > 0) {
        // Unix-Sekunden (Live-API) oder ISO-Strings (Demo-Modus) → Millisekunden
        const hourlyMs = hourly.time.map(t => typeof t === 'number' ? t * 1000 : new Date(t).getTime());
        const maxMatchDistMs = 45 * 60 * 1000;

        filtered.forEach(feed => {
          const ms = feed.time.getTime();
          let minDiff = Infinity, closest = -1;
          for (let i = 0; i < hourlyMs.length; i++) {
            const diff = Math.abs(ms - hourlyMs[i]);
            if (diff < minDiff) { minDiff = diff; closest = i; }
          }
          outsideTemp.push(closest !== -1 && minDiff <= maxMatchDistMs ? hourly.temperature_2m[closest] : null);
        });
      } else {
        filtered.forEach(() => outsideTemp.push(null));
      }

      const tempGrad = ctx.createLinearGradient(0, 0, 0, 360);
      tempGrad.addColorStop(0, 'rgba(249, 115, 22, 0.15)');
      tempGrad.addColorStop(1, 'rgba(249, 115, 22, 0)');

      const humGrad = ctx.createLinearGradient(0, 0, 0, 360);
      humGrad.addColorStop(0, 'rgba(99, 102, 241, 0.05)');
      humGrad.addColorStop(1, 'rgba(99, 102, 241, 0)');

      const outsideTempData = filtered.map((f, i) => ({ x: f.time.getTime(), y: outsideTemp[i] }));

      // Datensätze: Standard (aktiver Standort + Außentemperatur) oder
      // Vergleichsmodus (beide Standorte übereinander, Außentemp. ausgeblendet)
      let datasets;
      if (appState.compareMode && appState.compareData) {
        const other = LOCATIONS.find(l => l.id === appState.compareLocId) || LOCATIONS.find(l => l.id !== appState.activeLocId);
        const activeName = getLocationName(appState.activeLocId).replace('Schlafzimmer ', '');
        const otherName = getLocationName(other.id).replace('Schlafzimmer ', '');
        const otherFiltered = filterForTimeframe(appState.compareData, timeframeHours);
        const otherTemp = otherFiltered.map(f => ({ x: f.time.getTime(), y: f.temp }));
        const otherHum = otherFiltered.map(f => ({ x: f.time.getTime(), y: f.humidity }));
        const common = { fill: false, tension: 0.35, pointRadius: 0, pointHoverRadius: 5 };
        datasets = [
          { label: `${activeName} · Temperatur (°C)`, data: insideTemp, borderColor: '#f97316', borderWidth: 2.5, backgroundColor: tempGrad, fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 5, yAxisID: 'yTemp' },
          { label: `${otherName} · Temperatur (°C)`, data: otherTemp, borderColor: '#a78bfa', borderWidth: 2, ...common, yAxisID: 'yTemp' },
          { label: `${activeName} · Feuchte (%)`, data: insideHum, borderColor: '#6366f1', borderDash: [5, 5], borderWidth: 2, ...common, yAxisID: 'yHum' },
          { label: `${otherName} · Feuchte (%)`, data: otherHum, borderColor: '#2dd4bf', borderDash: [5, 5], borderWidth: 2, ...common, yAxisID: 'yHum' }
        ];
      } else {
        datasets = [
          {
            label: 'Innentemperatur (°C)',
            data: insideTemp,
            borderColor: '#f97316',
            borderWidth: 2.5,
            backgroundColor: tempGrad,
            fill: true,
            tension: 0.35,
            pointRadius: filtered.length > 50 ? 0 : 2.5,
            pointHoverRadius: 5,
            yAxisID: 'yTemp'
          },
          {
            label: 'Außentemperatur (°C)',
            data: outsideTempData,
            borderColor: '#14b8a6',
            borderWidth: 2,
            backgroundColor: 'transparent',
            fill: false,
            tension: 0.35,
            pointRadius: filtered.length > 50 ? 0 : 2,
            pointHoverRadius: 5,
            yAxisID: 'yTemp'
          },
          {
            label: 'Innenfeuchtigkeit (%)',
            data: insideHum,
            borderColor: '#6366f1',
            borderWidth: 2,
            borderDash: [5, 5],
            backgroundColor: humGrad,
            fill: true,
            tension: 0.35,
            pointRadius: filtered.length > 50 ? 0 : 2.5,
            pointHoverRadius: 5,
            yAxisID: 'yHum'
          }
        ];
        if (hasCo2Data) {
          datasets.push({
            label: 'CO₂ (ppm)', data: co2Data, borderColor: '#eab308', borderWidth: 2,
            backgroundColor: 'transparent', fill: false, tension: 0.35,
            pointRadius: 0, pointHoverRadius: 5, spanGaps: true, yAxisID: 'yCo2'
          });
        }
      }

      const config = {
        type: 'line',
        data: { datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            // Im Vergleichsmodus zeigt Chart.js die Legende (4 Serien, 2 Standorte)
            legend: { display: appState.compareMode, labels: { color: '#94a3b8', font: { size: 10 }, boxWidth: 12 } },
            tooltip: {
              backgroundColor: 'rgba(15, 23, 42, 0.95)',
              titleColor: '#f8fafc',
              bodyColor: '#cbd5e1',
              borderColor: 'rgba(255,255,255,0.06)',
              borderWidth: 1,
              padding: 10,
              usePointStyle: true,
              callbacks: {
                title: items => {
                  if (!items.length) return '';
                  const d = new Date(items[0].parsed.x);
                  return `${formatDate(d)} ${formatTime(d)} Uhr`;
                },
                label: context => {
                  const name = context.dataset.label.replace(/ \([^)]*\)$/, '');
                  return context.parsed.y === null || context.parsed.y === undefined
                    ? `${name}: –`
                    : `${name}: ${context.parsed.y.toFixed(1)}`;
                }
              }
            },
            // Zoomen (Mausrad/Pinch) + Schwenken (Ziehen) auf der Zeitachse (Punkt 12)
            zoom: {
              zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
              pan: { enabled: true, mode: 'x' }
            }
          },
          scales: {
            x: {
              type: 'linear',
              min: filtered.length > 0 ? filtered[0].time.getTime() : undefined,
              // Achse läuft bis "jetzt": ein Sensor-Stillstand ist als leerer
              // Bereich am rechten Rand sofort sichtbar
              max: Date.now(),
              grid: { color: 'rgba(255, 255, 255, 0.02)' },
              ticks: {
                color: '#64748b',
                font: { size: 10 },
                maxTicksLimit: 7,
                callback: val => {
                  const d = new Date(val);
                  return (timeframeHours <= 24 && timeframeHours > 0)
                    ? formatTime(d)
                    : `${formatDate(d)} ${formatTime(d)}`;
                }
              }
            },
            yTemp: {
              type: 'linear',
              position: 'left',
              title: { display: true, text: 'Temperatur (°C)', color: '#64748b', font: { size: 10, weight: 'bold' } },
              grid: { color: 'rgba(255, 255, 255, 0.03)' },
              ticks: { color: '#94a3b8', callback: val => val.toFixed(1) + '°' }
            },
            yHum: {
              type: 'linear',
              position: 'right',
              title: { display: true, text: 'Luftfeuchtigkeit (%)', color: '#64748b', font: { size: 10, weight: 'bold' } },
              grid: { drawOnChartArea: false },
              min: 0, max: 100,
              ticks: { color: '#94a3b8', callback: val => val.toFixed(0) + '%' }
            }
          }
        }
      };

      // CO₂-Achse nur ergaenzen, wenn eine CO₂-Serie vorhanden ist
      if (hasCo2Data) {
        config.options.scales.yCo2 = {
          type: 'linear', position: 'right',
          title: { display: true, text: 'CO₂ (ppm)', color: '#a16207', font: { size: 10, weight: 'bold' } },
          grid: { drawOnChartArea: false },
          ticks: { color: '#eab308', callback: val => Math.round(val) }
        };
      }

      if (appState.chartInstance) appState.chartInstance.destroy();
      appState.chartInstance = new Chart(ctx, config);
    }

    function setChartTimeframe(hours) {
      appState.currentChartTimeframe = hours;
      const tfIds = { 24: 'btn-tf-24', 72: 'btn-tf-72', 168: 'btn-tf-168', '-1': 'btn-tf-all' };
      Object.keys(tfIds).forEach(k => {
        const btn = document.getElementById(tfIds[k]);
        if (btn) btn.className = 'px-3.5 py-1.5 rounded-xl border border-slate-800 hover:border-slate-700 text-slate-400 hover:text-slate-200 text-xs font-semibold transition-all';
      });
      const active = document.getElementById(tfIds[hours.toString()]);
      if (active) active.className = 'px-3.5 py-1.5 rounded-xl border border-teal-500/20 bg-teal-500/10 text-teal-400 text-xs font-semibold transition-all';

      drawChart();
    }

    // ============ Standort-Vergleichsmodus im Klimaverlauf ============
    // Legt die Messreihe des jeweils anderen Standorts als Overlay über den
    // Chart. Nutzt den Rohdaten-Cache; lädt sonst einmalig per fetchFeeds.
    async function loadCompareData() {
      const other = LOCATIONS.find(l => l.id === appState.compareLocId) || LOCATIONS.find(l => l.id !== appState.activeLocId);
      const cache = appState.feedCache[other.id];
      let rawFeeds = cache && cache.rawFeeds;
      if (!rawFeeds || rawFeeds.length === 0) {
        const data = await fetchFeeds(other, { results: 8000 });
        rawFeeds = (data && Array.isArray(data.feeds)) ? data.feeds : [];
        appState.feedCache[other.id] = { rawFeeds };
      }
      return processRawFeeds(rawFeeds, other.fields).aligned;
    }

    function updateCompareButton() {
      const btn = document.getElementById('btn-compare');
      if (!btn) return;
      btn.className = appState.compareMode
        ? 'px-3.5 py-1.5 rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-300 text-xs font-semibold transition-all'
        : 'px-3.5 py-1.5 rounded-xl border border-slate-800 hover:border-slate-700 text-slate-400 hover:text-slate-200 text-xs font-semibold transition-all';
      const staticLegend = document.getElementById('chart-legend-static');
      if (staticLegend) staticLegend.classList.toggle('hidden', appState.compareMode);
    }

    async function toggleCompareMode() {
      if (!appState.compareMode) {
        // Bei 3+ Standorten fragen, mit welchem verglichen werden soll (Punkt 5)
        const others = LOCATIONS.filter(l => l.id !== appState.activeLocId);
        if (others.length === 0) { showNotification('Kein zweiter Standort vorhanden.', 'error'); return; }
        if (others.length === 1) {
          appState.compareLocId = others[0].id;
        } else {
          const vals = await modalPrompt({
            title: 'Standort vergleichen',
            fields: [{ key: 'loc', label: 'Vergleichen mit', type: 'select', value: appState.compareLocId || others[0].id, options: others.map(l => ({ value: l.id, label: getLocationName(l.id) })) }]
          });
          if (!vals) return;
          appState.compareLocId = vals.loc;
        }
        try {
          const data = await loadCompareData();
          if (!data || data.length === 0) throw new Error('keine Daten');
          appState.compareData = data;
        } catch (err) {
          console.warn('Vergleichsdaten laden fehlgeschlagen:', err);
          showNotification('Vergleichsdaten konnten nicht geladen werden.', 'error');
          return;
        }
        appState.compareMode = true;
      } else {
        appState.compareMode = false;
      }
      updateCompareButton();
      drawChart();
    }

    // Chart-Zoom zurücksetzen / als PNG exportieren (Punkt 12)
    function resetChartZoom() {
      if (appState.chartInstance && appState.chartInstance.resetZoom) appState.chartInstance.resetZoom();
    }
    function exportChartImage() {
      if (!appState.chartInstance) return;
      const a = document.createElement('a');
      a.href = appState.chartInstance.toBase64Image('image/png', 1);
      a.download = `klimaverlauf_${getLocationName(appState.activeLocId).replace(/[^\wäöüÄÖÜß-]+/g, '_')}_${new Date().toISOString().substring(0, 10)}.png`;
      a.click();
      showNotification('Chart als Bild gespeichert.');
    }

    // ClimateFlow-Detailkarten einklappen (Plan-Punkt 6). Zustand profilbezogen
    // im Store (cf_collapsed); die Kernkarten (Messwerte, Analyse) bleiben immer
    // sichtbar. Kompakt-Modus klappt alle Detailkarten auf einmal ein.
    const CF_COLLAPSIBLE = {
      'cf-chart':   { body: 'chart-collapse-body', arrow: 'chart-arrow' },
      'cf-archive': { body: 'archive-container',   arrow: 'archive-arrow', onOpen: () => loadArchiveView() },
      'cf-table':   { body: 'table-container',     arrow: 'table-arrow' }
    };
    const CF_COLLAPSED_DEFAULT = ['cf-archive', 'cf-table']; // wie bisher: Archiv/Tabelle zu
    function getCfCollapsed() {
      const c = Store.getJSON('cf_collapsed', null);
      return Array.isArray(c) ? c : CF_COLLAPSED_DEFAULT.slice();
    }
    function applyCfCollapse() {
      const collapsed = new Set(getCfCollapsed());
      Object.entries(CF_COLLAPSIBLE).forEach(([id, cfg]) => {
        const body = document.getElementById(cfg.body);
        if (!body) return;
        const isCollapsed = collapsed.has(id);
        body.classList.toggle('hidden', isCollapsed);
        const arrow = document.getElementById(cfg.arrow);
        if (arrow) arrow.style.transform = isCollapsed ? 'rotate(0deg)' : 'rotate(180deg)';
        if (!isCollapsed && cfg.onOpen) cfg.onOpen();
      });
      const dt = document.getElementById('cf-density-toggle');
      if (dt) dt.checked = Store.get('cf_density') === 'compact';
    }
    function toggleCfCard(id) {
      const set = new Set(getCfCollapsed());
      if (set.has(id)) set.delete(id); else set.add(id);
      Store.setJSON('cf_collapsed', [...set]);
      applyCfCollapse();
    }
    function toggleCfCompact() {
      const compact = Store.get('cf_density') !== 'compact';
      Store.set('cf_density', compact ? 'compact' : 'full');
      Store.setJSON('cf_collapsed', compact ? Object.keys(CF_COLLAPSIBLE) : CF_COLLAPSED_DEFAULT.slice());
      applyCfCollapse();
    }
    // Header-Buttons in index.html rufen weiterhin diese Namen auf
    function toggleTableCollapse() { toggleCfCard('cf-table'); }

    // Populate data table (Extra-Felder aus dem Kanal-Schema erscheinen als eigene Spalten)
    function populateTable(feeds) {
      const tbody = document.getElementById('feed-table-body');
      tbody.innerHTML = '';
      const latest = feeds.slice(-10).reverse();
      const extras = getLocationFields(appState.activeLocId).extra || [];

      // Kopfzeile dynamisch aufbauen, damit konfigurierte Zusatz-Sensoren
      // (z. B. CO₂) ohne HTML-Änderung sichtbar werden
      const thead = document.getElementById('feed-table-head');
      if (thead) {
        const extraTh = extras.map(e => `<th class="p-3">${escapeHtml(e.label || e.key)}${e.unit ? ` (${escapeHtml(e.unit)})` : ''}</th>`).join('');
        thead.innerHTML = `
          <th class="p-3">Zeitstempel</th>
          <th class="p-3">Innentemp. (°C)</th>
          <th class="p-3">Innenfeuchte (%)</th>
          <th class="p-3">Abs. Feuchte (Drinnen)</th>
          ${extraTh}
          <th class="p-3 text-right">Eintrag-ID</th>
        `;
      }

      latest.forEach(feed => {
        const ah = getAbsoluteHumidity(feed.temp, feed.humidity);
        const extraTds = extras.map(e => {
          const v = feed[e.key];
          const dec = e.decimals !== undefined ? e.decimals : 0;
          return `<td class="p-3 text-slate-400">${v === null || v === undefined ? '–' : v.toFixed(dec)}</td>`;
        }).join('');
        const row = document.createElement('tr');
        row.className = 'hover:bg-slate-900/40 text-slate-300 transition-colors';
        row.innerHTML = `
          <td class="p-3 font-mono">${formatDate(feed.time)} ${formatTime(feed.time)}</td>
          <td class="p-3 text-orange-400 font-semibold">${feed.temp.toFixed(1)} °C</td>
          <td class="p-3 text-indigo-400 font-semibold">${feed.humidity.toFixed(0)} %</td>
          <td class="p-3 text-slate-400">${ah.toFixed(2)} g/m³</td>
          ${extraTds}
          <td class="p-3 text-right font-mono text-slate-500">${feed.id}</td>
        `;
        tbody.appendChild(row);
      });
    }

    function setUpdatedLabel(elementId, date) {
      const el = document.getElementById(elementId);
      if (!el) return;
      if (!(date instanceof Date) || isNaN(date.getTime())) {
        el.innerText = '--';
        el.title = '';
        el.classList.remove('text-amber-400');
        return;
      }
      el.innerText = `Aktualisiert ${formatRelativeTime(date)}`;
      el.title = `Letzte Aktualisierung: ${formatDate(date)} ${formatTime(date)} Uhr`;
      // Veraltete Werte optisch hervorheben
      el.classList.toggle('text-amber-400', Date.now() - date.getTime() > SENSOR_STALE_MS);
    }

    // Refresh the "Zuletzt aktualisiert" labels on the three KPI cards
    function updateTimestampLabels() {
      const upd = appState.lastSensorUpdate || {};
      setUpdatedLabel('kpi-temp-in-updated', upd.temp);
      setUpdatedLabel('kpi-humidity-in-updated', upd.humidity);

      const cur = appState.outsideData ? appState.outsideData.current : null;
      let weatherTime = null;
      if (cur && cur.time !== undefined && cur.time !== null) {
        weatherTime = typeof cur.time === 'number' ? new Date(cur.time * 1000) : new Date(cur.time);
      }
      setUpdatedLabel('kpi-temp-out-updated', weatherTime);

      updateSensorStaleBanner();
    }

    // Warnbanner, wenn ein Sensor-Kurzbefehl länger als SENSOR_STALE_MS keine echten Werte liefert
    function updateSensorStaleBanner() {
      const banner = document.getElementById('sensor-stale-banner');
      const textEl = document.getElementById('sensor-stale-text');
      if (!banner || !textEl) return;

      if (appState.isDemoMode) {
        banner.classList.add('hidden');
        return;
      }

      const upd = appState.lastSensorUpdate || {};
      const problems = [];
      const checkSensor = (label, date) => {
        if (date instanceof Date && !isNaN(date.getTime()) && Date.now() - date.getTime() > SENSOR_STALE_MS) {
          problems.push(`${label} (letzter Wert ${formatRelativeTime(date)})`);
        }
      };
      checkSensor('Temperatur', upd.temp);
      checkSensor('Luftfeuchtigkeit', upd.humidity);

      if (problems.length > 0) {
        textEl.innerHTML = `<strong>Sensor-Ausfall bei „${getLocationName(appState.activeLocId)}":</strong> ${problems.join(' · ')} – bitte den iPhone-Kurzbefehl prüfen.`;
        banner.classList.remove('hidden');
        updateIcons();

        // Push-Benachrichtigung (falls ntfy-Topic konfiguriert, max. 1×/6h pro Standort)
        sendPush(
          'ClimateFlow Sensor-Warnung',
          `Sensor-Ausfall bei „${getLocationName(appState.activeLocId)}": ${problems.join(' und ')}. Bitte iPhone-Kurzbefehl prüfen.`,
          'warning,thermometer',
          `stale_${appState.activeLocId}`
        );
      } else {
        banner.classList.add('hidden');
      }
    }

    // getWeatherDescription (Open-Meteo Weather-Codes) kommt aus shared.js —
    // wird auch vom GPX-Viewer (Start-Wetter pro Tour) genutzt.

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

        const todayKey = new Date().toISOString().substring(0, 10);
        const byDay = {};
        feeds.forEach(f => {
          const day = f.time.toISOString().substring(0, 10);
          if (day >= todayKey) return; // nur abgeschlossene Tage archivieren
          (byDay[day] = byDay[day] || []).push(f);
        });

        const days = Object.entries(byDay).map(([day, list]) => {
          const temps = list.map(f => f.temp);
          const hums = list.map(f => f.humidity);
          const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
          const entry = {
            day,
            tMin: Math.min(...temps), tMax: Math.max(...temps), tAvg: parseFloat(avg(temps).toFixed(2)),
            hMin: Math.min(...hums), hMax: Math.max(...hums), hAvg: parseFloat(avg(hums).toFixed(2)),
            samples: list.length
          };
          // CO₂-Aggregate nur, wenn an dem Tag ueberhaupt CO₂-Werte vorliegen
          const co2s = list.map(f => f.co2).filter(v => v != null && !isNaN(v));
          if (co2s.length) {
            entry.co2Avg = parseFloat(avg(co2s).toFixed(1));
            entry.co2Max = Math.max(...co2s);
          }
          return entry;
        });
        if (days.length === 0) return;

        await apiFetch('/api/climate', { method: 'POST', body: JSON.stringify({ loc: locId, days }) });
        localStorage.setItem(throttleKey, Date.now().toString());
        console.log(`[Archiv] ${days.length} Tages-Aggregate für ${locId} in D1 gesichert.`);
      } catch (err) {
        if (!err.unavailable) console.warn('Klima-Archiv fehlgeschlagen:', err);
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
    }

    function drawArchiveChart(rows) {
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
        </div>`;
      const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
      const onKey = e => { if (e.key === 'Escape') close(); };
      overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
      overlay.querySelector('[data-x]').onclick = close;
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
        const header = ['Tag', 'Temp Min (°C)', 'Temp Mittel (°C)', 'Temp Max (°C)', 'Feuchte Min (%)', 'Feuchte Mittel (%)', 'Feuchte Max (%)', 'Komfort-Score', 'Messwerte'];
        const lines = rows.map(r => [
          r.day,
          num(r.t_min), num(r.t_avg), num(r.t_max),
          num(r.h_min, 0), num(r.h_avg, 0), num(r.h_max, 0),
          comfortScore(r.t_avg, r.h_avg, null, th) ?? '',
          r.samples ?? ''
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
          <button onclick="toggleTheme()" class="px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-800 hover:border-slate-700 text-xs text-slate-200 transition-colors">${light ? 'Heller Modus' : 'Dunkler Modus'} · umschalten</button>
        </div>`;
        if (window.Store && Store.mode === 'server') {
          html += `<div class="mt-2 flex justify-end"><button onclick="logout()" class="px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-800 hover:border-red-500/40 text-xs text-slate-400 hover:text-red-300 transition-colors flex items-center gap-1.5"><i data-lucide="log-out" class="w-3.5 h-3.5"></i> Abmelden</button></div>`;
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
               <input type="number" id="nr-th-${t.key}" value="${cfg.threshold ?? t.thDef}" class="w-16 bg-slate-900 border border-slate-800 rounded px-1.5 py-0.5 text-slate-200" onchange="saveNotifyRulesFromUI()"></span>`
          : '';
        row.innerHTML = `
          <label class="flex items-center gap-2 text-sm text-slate-200 cursor-pointer min-w-0">
            <input type="checkbox" id="nr-on-${t.key}" class="accent-teal-500 shrink-0" ${cfg.on ? 'checked' : ''} onchange="saveNotifyRulesFromUI()">
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
          <div class="flex gap-2"><button onclick="configureNtfy(); setTimeout(renderOnboardingStep, 100)" class="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200">Topic setzen</button>
          <button onclick="sendTestPush()" class="px-3 py-1.5 rounded-lg bg-teal-500/15 border border-teal-500/30 text-teal-200 text-xs">Test-Push</button></div>`,
        thresholds: `<p class="font-semibold text-white mb-1">2 · Wohlfühlband</p>
          <p class="text-slate-400 mb-3">Lege pro Standort den Temperatur- und Feuchtebereich fest — er steuert Komfort-Score und Warnungen.</p>
          <div class="flex flex-wrap gap-2">${LOCATIONS.map(l => `<button onclick="editLocationThresholds('${l.id}'); setTimeout(renderOnboardingStep,100)" class="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200">${escapeHtml(getLocationName(l.id))}</button>`).join('')}</div>`,
        calendar: `<p class="font-semibold text-white mb-1">3 · Kalender (optional)</p>
          <p class="text-slate-400 mb-3">Verbinde einen .ics-Feed (z. B. Google Kalender „geheime Adresse"), um Termine auf dem Hub zu sehen.</p>
          <button onclick="configureIcal(); setTimeout(renderOnboardingStep,100)" class="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200">Kalender verbinden</button>`,
        goals: `<p class="font-semibold text-white mb-1">4 · GPX-Ziele (optional)</p>
          <p class="text-slate-400 mb-3">Setze ein Wochen-/Jahresziel in km für den GPX-Viewer.</p>
          <button onclick="editHubGoals(); setTimeout(renderOnboardingStep,100)" class="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200">Ziele setzen</button>`,
        done: `<p class="font-semibold text-white mb-1">Fertig! 🎉</p>
          <p class="text-slate-400">Du kannst alles jederzeit in den Einstellungen anpassen. Viel Freude mit deinem Smart Home Hub!</p>`
      };
      body.innerHTML = contents[step] || '';
      updateIcons();
    }

    // ============ HUB NAVIGATION (Hash-Routing) ============
    const HUB_VIEWS = ['home', 'climate', 'settings'];

    function navigateTo(view) {
      if (location.hash === `#${view}`) {
        handleRoute();
      } else {
        location.hash = view;
      }
    }

    function handleRoute() {
      let view = (location.hash || '').replace('#', '');

      // Der GPX-Viewer ist eine eigenständige Seite (alte #gpx-Links umleiten)
      if (view === 'gpx') {
        location.replace('gpx.html');
        return;
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

      // Klimadaten erst beim ersten Öffnen des Dashboards laden (Performance)
      if (view === 'climate') {
        applyClimateLayout(); // gespeicherte Karten-Reihenfolge/-Sichtbarkeit
        applyCfCollapse();    // gespeicherter Einklapp-/Kompakt-Zustand
        if (!appState.climateLoaded) {
          appState.climateLoaded = true;
          reloadData();
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
        greetEl.innerText = name ? `${greeting}, ${name} 👋` : `${greeting} 👋`;
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
      try { await fetch('/api/logout', { cache: 'no-store' }); } catch (e) { /* 401 erwartet */ }
      showNotification('Abgemeldet. Zugangsdaten werden neu abgefragt…');
      setTimeout(() => location.reload(), 800);
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
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${conf.lat}&longitude=${conf.lon}&current=temperature_2m,weather_code&timezone=auto`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP-Fehler: ${res.status}`);
        const data = await res.json();
        el.innerText = `${data.current.temperature_2m.toFixed(1)} °C · ${getWeatherDescription(data.current.weather_code)} · ${conf.name}`;
      } catch (err) {
        console.warn('Hub-Wetter fehlgeschlagen:', err);
        el.innerText = 'Wetter nicht verfügbar';
      }
    }

    // Kompakte Live-Vorschau beider Standorte auf der ClimateFlow-Kachel.
    // Lädt nur die letzten 400 Einträge pro Kanal und ist auf 2 Minuten gedrosselt.
    async function loadHubPreviews(force = false) {
      if (!force && Date.now() - appState.hubPreviewAt < 2 * 60 * 1000) return;
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
              const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.defaultWeather.lat}&longitude=${loc.defaultWeather.lon}&current=temperature_2m&timezone=auto`);
              if (w.ok) outTemp = (await w.json()).current.temperature_2m;
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

      renderBriefing(signals);
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

    // App Initialization
    async function init() {
      // Profil + Einstellungen laden, bevor irgendetwas gelesen wird
      await Store.init();
      updateProfileBadge();
      applyTheme(getTheme()); // profilbezogenes Theme anwenden
      // Zusatz-Standorte aus D1 ergänzen, bevor Tabs/Configs rendern
      await loadDynamicLocations();

      updateIcons();
      initConfigs();
      updateNtfyButton();
      applyWidgetLayout();
      initWidgetDrag();

      // Einstellungs-Popover bei Klick außerhalb schließen (Hub + ClimateFlow)
      document.addEventListener('click', event => {
        [['widget-settings', 'toggleWidgetSettings()'], ['cf-settings', 'toggleClimateSettings()']].forEach(([panelId, handler]) => {
          const panel = document.getElementById(panelId);
          if (panel && !panel.classList.contains('hidden') &&
              !panel.contains(event.target) && !event.target.closest(`button[onclick="${handler}"]`)) {
            panel.classList.add('hidden');
          }
        });
      });

      window.addEventListener('hashchange', handleRoute);
      handleRoute();

      // Einstellungs-Sync auch während der Sitzung (Punkt 6): Änderungen vom
      // anderen Gerät kommen ohne Reload an — periodisch + bei Tab-Fokus.
      window.addEventListener('store-updated', () => {
        updateProfileBadge();
        applyWidgetLayout();
        handleRoute();
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && window.Store) Store.pull();
      });

      // Auto-refresh every 5 minutes: still im Hintergrund (kein Lade-Overlay),
      // im Klima-Dashboard inkl. Wetter, auf dem Hub nur die Kachel-Vorschau
      setInterval(() => {
        if (window.Store) Store.pull();
        const climateView = document.getElementById('view-climate');
        const homeView = document.getElementById('view-home');
        if (appState.climateLoaded && climateView && !climateView.classList.contains('hidden')) {
          console.log('[Interval] Auto-refresh data (silent)...');
          reloadData(true);
        } else if (homeView && !homeView.classList.contains('hidden')) {
          loadHubPreviews(true);
        }
      }, 5 * 60 * 1000);

      // "vor X Min."-Labels laufend aktuell halten
      setInterval(updateTimestampLabels, 60 * 1000);

      // Hub-Uhr im Sekundentakt (günstig, nur DOM-Text)
      updateHubClock();
      setInterval(updateHubClock, 1000);

      // PWA: Service Worker registrieren (+ „Neue Version"-Hinweis)
      registerServiceWorker();
    }

    window.addEventListener('DOMContentLoaded', init);
