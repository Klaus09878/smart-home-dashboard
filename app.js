// ClimateFlow Dashboard + Hub-Navigation.
// Ausgelagert aus index.html; nutzt lib/core.js (getestete Kernlogik) und shared.js.

// Configuration for both locations.
    // fields: generalisiertes Kanal-Schema (siehe processRawFeeds in lib/core.js).
    // Ein späterer Zusatz-Sensor (z. B. CO₂ auf field3) wird rein per Konfiguration
    // ergänzt: extra: [{ key: 'co2', field: 'field3', label: 'CO₂', unit: 'ppm', decimals: 0 }]
    // → Wert erscheint automatisch in aligned-Einträgen, Rohdaten-Tabelle und CSV-Export.
    const LOCATIONS = [
      {
        id: 'gillian',
        defaultName: 'Schlafzimmer Gillian',
        thingspeakUrl: 'https://api.thingspeak.com/channels/3417815/feeds.json?api_key=79KYAS8DHBA01ZO2&results=8000',
        defaultWeather: { lat: 48.7758, lon: 9.1829, name: 'Stuttgart, DE' },
        fields: { temp: 'field1', humidity: 'field2', extra: [] }
      },
      {
        id: 'sean',
        defaultName: 'Schlafzimmer Sean',
        thingspeakUrl: 'https://api.thingspeak.com/channels/3417935/feeds.json?api_key=CTMDY1UODSQK7OJN&results=8000',
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
      activeLocId: localStorage.getItem('selected_location') || 'gillian',
      isDemoMode: false,
      insideData: [],
      outsideData: {},
      airQuality: null,
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
      compareData: null
    };

    // Sensor gilt als ausgefallen, wenn länger keine echten Werte kamen als:
    const SENSOR_STALE_MS = 2 * 60 * 60 * 1000;

    // Feeds über die API-Schicht laden (/api/feeds/{loc}, Cloudflare Function
    // mit verstecktem Key + Edge-Cache). Solange die Env-Keys nicht eingerichtet
    // sind, fällt der Aufruf automatisch auf den direkten ThingSpeak-Zugriff zurück.
    async function fetchFeeds(loc, { results = 8000, start = null } = {}) {
      const q = new URLSearchParams({ results: results.toString() });
      if (start) q.set('start', start);
      try {
        return await apiFetch(`/api/feeds/${loc.id}?${q.toString()}`);
      } catch (err) {
        if (!err.unavailable) throw err;
        // HINWEIS: Dieser Direktzugriff (Read-Key im Client) ist nur die
        // Übergangslösung, bis TS_KEY_* als Env-Vars gesetzt sind. Danach:
        // Fallback samt thingspeakUrl aus LOCATIONS entfernen (siehe README).
        console.warn(`[fetchFeeds] API-Proxy nicht verfügbar – Direktzugriff für "${loc.id}".`);
        let url = loc.thingspeakUrl.replace('results=8000', `results=${results}`);
        if (start) url += `&start=${encodeURIComponent(start)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP-Fehler: ${res.status}`);
        return res.json();
      }
    }

    // Load custom names and weather configs from localStorage
    function initConfigs() {
      // Safety check for selected location
      if (!LOCATIONS.some(l => l.id === appState.activeLocId)) {
        appState.activeLocId = 'gillian';
        localStorage.setItem('selected_location', 'gillian');
      }

      // Restore weather configs
      const savedWeather = localStorage.getItem(`loc_weather_${appState.activeLocId}`);
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
      return localStorage.getItem(`loc_name_${locId}`) || (loc ? loc.defaultName : '');
    }

    function renameActiveLocation() {
      const locId = appState.activeLocId;
      const currentName = getLocationName(locId);
      const newName = prompt(`Neuen Namen für diesen Standort eingeben:`, currentName);
      
      if (newName !== null && newName.trim() !== '') {
        localStorage.setItem(`loc_name_${locId}`, newName.trim());
        document.getElementById('detail-loc-title').innerText = newName.trim();
        updateTabLabels();
        showNotification('Name erfolgreich geändert!');
      }
    }

    // ============ Konfigurierbare Ziel-/Schwellwerte pro Standort ============
    // Bestimmen die Comfort-Bewertungen (KPI-Karten), den Komfort-Score und die
    // Feuchte-Schwelle des Lüftungsberaters. Gespeichert in localStorage.
    const THRESHOLD_DEFAULTS = { tempMin: 19, tempMax: 24, humMin: 40, humMax: 60 };

    function getThresholds(locId = appState.activeLocId) {
      try {
        const saved = JSON.parse(localStorage.getItem(`loc_thresholds_${locId}`) || 'null');
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
      localStorage.removeItem(`loc_thresholds_${appState.activeLocId}`);
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
      localStorage.setItem(`loc_thresholds_${appState.activeLocId}`, JSON.stringify(th));
      closeThresholdSettings();
      showNotification('Schwellwerte gespeichert.');
      renderActiveView();
      // Archiv-Komfortkurve mit neuen Schwellwerten neu zeichnen (falls geöffnet)
      appState.archiveLoadedFor = null;
      loadArchiveView();
    }

    function updateTabLabels() {
      const tabG = document.getElementById('tab-gillian');
      const tabS = document.getElementById('tab-sean');
      if (tabG) tabG.innerText = getLocationName('gillian').replace('Schlafzimmer ', '');
      if (tabS) tabS.innerText = getLocationName('sean').replace('Schlafzimmer ', '');
      document.getElementById('detail-loc-title').innerText = getLocationName(appState.activeLocId);
    }

    function highlightActiveTab() {
      const tabG = document.getElementById('tab-gillian');
      const tabS = document.getElementById('tab-sean');
      
      if (appState.activeLocId === 'gillian') {
        tabG.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-teal-500 text-slate-950 shadow-md shadow-teal-500/10 transition-all';
        tabS.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200 transition-all';
      } else {
        tabS.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-teal-500 text-slate-950 shadow-md shadow-teal-500/10 transition-all';
        tabG.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200 transition-all';
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
      localStorage.setItem(`loc_weather_${appState.activeLocId}`, JSON.stringify(weatherObj));
      
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
          console.warn('ThingSpeak laden fehlgeschlagen, aktiviere Demo-Modus:', err);
          activateDemoMode();
        }
      }
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
      localStorage.setItem('selected_location', locId);
      
      const savedWeather = localStorage.getItem(`loc_weather_${locId}`);
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
          computeVentilationAdvisor(curTempIn, curHumIn, curTempOut, curHumOut);
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
    function computeVentilationAdvisor(inTemp, inRh, outTemp, outRh) {
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
        const other = LOCATIONS.find(l => l.id !== appState.activeLocId);
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
      const other = LOCATIONS.find(l => l.id !== appState.activeLocId);
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

    function toggleTableCollapse() {
      const container = document.getElementById('table-container');
      const arrow = document.getElementById('table-arrow');
      container.classList.toggle('hidden');
      arrow.style.transform = container.classList.contains('hidden') ? 'rotate(0deg)' : 'rotate(180deg)';
    }

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
          return {
            day,
            tMin: Math.min(...temps), tMax: Math.max(...temps), tAvg: parseFloat(avg(temps).toFixed(2)),
            hMin: Math.min(...hums), hMax: Math.max(...hums), hAvg: parseFloat(avg(hums).toFixed(2)),
            samples: list.length
          };
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
    function toggleArchiveCollapse() {
      const container = document.getElementById('archive-container');
      const arrow = document.getElementById('archive-arrow');
      container.classList.toggle('hidden');
      arrow.style.transform = container.classList.contains('hidden') ? 'rotate(0deg)' : 'rotate(180deg)';
      if (!container.classList.contains('hidden')) loadArchiveView();
    }

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
      } catch (err) {
        appState.archiveLoadedFor = null;
        if (err.unavailable) {
          showMessage('Cloud-Datenbank (D1) noch nicht eingerichtet — siehe README, Abschnitt „Einrichtung Cloud-Funktionen". Danach erscheinen hier die täglichen Langzeit-Werte.');
        } else {
          showMessage(`Archiv konnte nicht geladen werden: ${err.message}`);
        }
      }
    }

    function drawArchiveChart(rows) {
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

    // ============ Push-Benachrichtigungen (ntfy.sh) ============
    function configureNtfy() {
      const current = getNtfyTopic();
      const topic = prompt(
        'ntfy.sh-Topic für Push-Benachrichtigungen (leer lassen = deaktivieren).\n\n' +
        'Einrichtung: Die kostenlose ntfy-App aufs Handy laden und dort dasselbe Topic abonnieren. ' +
        'Der Name sollte geheim sein (wie ein Passwort).',
        current || 'smarthub-' + Math.random().toString(36).substring(2, 8)
      );
      if (topic === null) return;
      if (topic.trim() === '') {
        localStorage.removeItem('ntfy_topic');
        showNotification('Push-Benachrichtigungen deaktiviert.');
      } else {
        localStorage.setItem('ntfy_topic', topic.trim());
        showNotification('Push aktiviert – Test-Nachricht gesendet.');
        sendPush('Smart Home Hub', 'Push-Benachrichtigungen sind eingerichtet ✔', 'tada');
      }
      updateNtfyButton();
    }

    function updateNtfyButton() {
      const btn = document.getElementById('ntfy-btn');
      if (btn) btn.classList.toggle('text-teal-400', !!getNtfyTopic());
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

      // BOM voranstellen, damit Excel die UTF-8-Umlaute korrekt erkennt
      const csv = '﻿' + [header.join(';'), ...rows].join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const safeName = getLocationName(appState.activeLocId).replace(/[^\wäöüÄÖÜß-]+/g, '_');
      const stamp = new Date().toISOString().substring(0, 10);
      const a = document.createElement('a');
      a.href = url;
      a.download = `climateflow_${safeName}_${stamp}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      showNotification(`${feeds.length} Messwerte als CSV exportiert.`);
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
          };
        };
        req.onerror = () => {};
      } catch (e) { /* Widget optional */ }
    }

    // ============ HUB NAVIGATION (Hash-Routing) ============
    const HUB_VIEWS = ['home', 'climate'];

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
      }
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
        greetEl.innerText = `${greeting} 👋`;
      }
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

      await Promise.all(LOCATIONS.map(async loc => {
        const el = suffix => document.getElementById(`hub-prev-${loc.id}-${suffix}`);
        const nameEl = el('name');
        if (nameEl) nameEl.innerText = getLocationName(loc.id).replace('Schlafzimmer ', '');

        try {
          const data = await fetchFeeds(loc, { results: 400 });
          const processed = processRawFeeds((data && data.feeds) || [], loc.fields);

          // Sensor-Status-Punkt: grün wenn beide Felder frisch, sonst rot
          const dot = el('dot');
          if (dot) {
            const fresh = t => t instanceof Date && (Date.now() - t.getTime()) < SENSOR_STALE_MS;
            const ok = fresh(processed.lastTempTime) && fresh(processed.lastHumTime);
            dot.className = `w-1.5 h-1.5 rounded-full inline-block ${ok ? 'bg-emerald-500' : 'bg-red-500 animate-pulse'}`;
            dot.title = ok ? 'Beide Sensoren liefern Daten' : 'Mindestens ein Sensor liefert keine aktuellen Daten';
          }

          if (processed.aligned.length > 0) {
            const last = processed.aligned[processed.aligned.length - 1];
            el('temp').innerText = `${last.temp.toFixed(1)} °C`;
            el('hum').innerText = `${last.humidity.toFixed(0)} %`;
            el('time').innerText = formatRelativeTime(last.time);
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
    }

    // App Initialization
    function init() {
      updateIcons();
      initConfigs();
      updateNtfyButton();

      window.addEventListener('hashchange', handleRoute);
      handleRoute();

      // Auto-refresh every 5 minutes: still im Hintergrund (kein Lade-Overlay),
      // im Klima-Dashboard inkl. Wetter, auf dem Hub nur die Kachel-Vorschau
      setInterval(() => {
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

      // PWA: Service Worker registrieren (macht die App installierbar & offlinefähig)
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service Worker Registrierung fehlgeschlagen:', err));
      }
    }

    window.addEventListener('DOMContentLoaded', init);
