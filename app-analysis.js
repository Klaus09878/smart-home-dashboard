// app-analysis.js — Teil des ClimateFlow-Hub (aus app.js zerlegt, Plan2-9).
// Komfort-Score, Lueftungsstatistik, Frost/Hitze, Chart, Vergleich
// Klassische Skripte teilen den globalen Scope; Reihenfolge in index.html
// entspricht der urspruenglichen Dateireihenfolge (app-main.js zuletzt).

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

      let label = 'Sehr gut', color = 'text-emerald-400', barColor = 'bg-emerald-500';
      if (score < 40) { label = 'Schlecht'; color = 'text-red-400'; barColor = 'bg-red-500'; }
      else if (score < 60) { label = 'Mäßig'; color = 'text-orange-400'; barColor = 'bg-orange-500'; }
      else if (score < 80) { label = 'Okay'; color = 'text-amber-400'; barColor = 'bg-amber-500'; }
      else if (score < 95) { label = 'Gut'; color = 'text-teal-400'; barColor = 'bg-teal-500'; }

      valEl.innerText = score;
      valEl.className = `text-sm font-bold mt-0.5 ${color}`;
      if (labelEl) {
        labelEl.innerText = label;
        labelEl.className = `font-semibold ${color}`;
      }
      if (barEl) {
        barEl.style.width = `${score}%`;
        barEl.className = `h-full rounded-full transition-[width] duration-500 ${barColor}`;
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

      // Wirkungsanalyse (Plan4-14): was bringt das Lueften typischerweise?
      const impactEl = document.getElementById('vent-impact');
      if (impactEl) {
        const imp = ventilationImpact(recent);
        if (imp) {
          impactEl.classList.remove('hidden');
          impactEl.innerHTML = `<i data-lucide="trending-down" class="w-3.5 h-3.5 text-teal-400 shrink-0"></i> Ø −${imp.avgDropRh.toFixed(1).replace('.', ',')} % Feuchte pro Stoßlüften · ~${Math.round(imp.avgDurationMin)} min · meist ${imp.bestHourFrom}–${imp.bestHourTo} Uhr`;
          updateIcons();
        } else {
          impactEl.classList.add('hidden');
        }
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
    async function drawChart() {
      await ensureChartJs(); // Chart-Stack bei Bedarf nachladen (P2-19)
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
      tempGrad.addColorStop(0, viz.warm(0.15));
      tempGrad.addColorStop(1, viz.warm(0));

      const humGrad = ctx.createLinearGradient(0, 0, 0, 360);
      humGrad.addColorStop(0, viz.cool(0.05));
      humGrad.addColorStop(1, viz.cool(0));

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
          { label: `${activeName} · Temperatur (°C)`, data: insideTemp, borderColor: viz.warm(), borderWidth: 2.5, backgroundColor: tempGrad, fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 5, yAxisID: 'yTemp' },
          { label: `${otherName} · Temperatur (°C)`, data: otherTemp, borderColor: viz.sky(), borderWidth: 2, ...common, yAxisID: 'yTemp' },
          { label: `${activeName} · Feuchte (%)`, data: insideHum, borderColor: viz.cool(), borderDash: [5, 5], borderWidth: 2, ...common, yAxisID: 'yHum' },
          { label: `${otherName} · Feuchte (%)`, data: otherHum, borderColor: viz.accent(), borderDash: [5, 5], borderWidth: 2, ...common, yAxisID: 'yHum' }
        ];
      } else {
        datasets = [
          {
            label: 'Innentemperatur (°C)',
            data: insideTemp,
            borderColor: viz.warm(),
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
            borderColor: viz.accent(),
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
            borderColor: viz.cool(),
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
            label: 'CO₂ (ppm)', data: co2Data, borderColor: viz.warn(), borderWidth: 2,
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
            legend: { display: appState.compareMode, labels: { color: chartToken('--sh-ink-3'), font: { size: 10 }, boxWidth: 12 } },
            tooltip: {
              backgroundColor: chartToken('--sh-surface', 0.96),
              titleColor: chartToken('--sh-ink'),
              bodyColor: chartToken('--sh-ink-2'),
              borderColor: chartToken('--sh-rule'),
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
            // Zoomen (Strg+Mausrad/Pinch) + Schwenken (Ziehen) auf der Zeitachse
            // (Punkt 12). modifierKey verhindert versehentliches Zoomen beim
            // Scrollen ueber dem Chart (Plan5-2, Test-Feedback).
            zoom: {
              zoom: { wheel: { enabled: true, modifierKey: 'ctrl' }, pinch: { enabled: true }, mode: 'x' },
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
              grid: { color: chartToken('--sh-rule', 0.35) },
              ticks: {
                color: chartToken('--sh-ink-4'),
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
              title: { display: true, text: 'Temperatur (°C)', color: chartToken('--sh-ink-4'), font: { size: 10, weight: 'bold' } },
              grid: { color: chartToken('--sh-rule', 0.4) },
              ticks: { color: chartToken('--sh-ink-3'), callback: val => val.toFixed(1) + '°' }
            },
            yHum: {
              type: 'linear',
              position: 'right',
              title: { display: true, text: 'Luftfeuchtigkeit (%)', color: chartToken('--sh-ink-4'), font: { size: 10, weight: 'bold' } },
              grid: { drawOnChartArea: false },
              min: 0, max: 100,
              ticks: { color: chartToken('--sh-ink-3'), callback: val => val.toFixed(0) + '%' }
            }
          }
        }
      };

      // CO₂-Achse nur ergaenzen, wenn eine CO₂-Serie vorhanden ist
      if (hasCo2Data) {
        config.options.scales.yCo2 = {
          type: 'linear', position: 'right',
          title: { display: true, text: 'CO₂ (ppm)', color: chartToken('--sh-warn-strong'), font: { size: 10, weight: 'bold' } },
          grid: { drawOnChartArea: false },
          ticks: { color: chartToken('--sh-warn'), callback: val => Math.round(val) }
        };
      }

      if (appState.chartInstance) appState.chartInstance.destroy();
      appState.chartInstance = new Chart(ctx, config);
    }

    // Aktiven Zeitraum-Button hervorheben (aus setChartTimeframe extrahiert,
    // Plan4-10 — wird auch beim Anwenden der Voreinstellung genutzt).
    function highlightTfButton(hours) {
      const tfIds = { 24: 'btn-tf-24', 72: 'btn-tf-72', 168: 'btn-tf-168', '-1': 'btn-tf-all' };
      Object.keys(tfIds).forEach(k => {
        const btn = document.getElementById(tfIds[k]);
        if (btn) btn.className = 'px-3.5 py-1.5 rounded-xl border border-slate-800 hover:border-slate-700 text-slate-400 hover:text-slate-200 text-xs font-semibold transition-colors';
      });
      const active = document.getElementById(tfIds[hours.toString()]);
      if (active) active.className = 'px-3.5 py-1.5 rounded-xl border border-teal-500/20 bg-teal-500/10 text-teal-400 text-xs font-semibold transition-colors';
    }

    async function setChartTimeframe(hours) {
      appState.currentChartTimeframe = hours;
      highlightTfButton(hours);

      // Zuletzt gewaehlten Zeitraum merken (Plan4-10), wenn aktiviert.
      if (getChartPrefs().rememberLast) {
        const p = getChartPrefs(); p.lastTf = hours; Store.setJSON('chart_prefs', p);
      }

      // "Alle" braucht die komplette Historie — der Erst-Load holt nur 14 Tage
      // (Plan4-6). Erst nachladen, dann zeichnen.
      if (hours === -1) await ensureFullHistory();
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
        ? 'px-3.5 py-1.5 rounded-xl border border-blue-500/30 bg-blue-500/10 text-blue-300 text-xs font-semibold transition-colors'
        : 'px-3.5 py-1.5 rounded-xl border border-slate-800 hover:border-slate-700 text-slate-400 hover:text-slate-200 text-xs font-semibold transition-colors';
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
      'cf-pattern': { body: 'pattern-collapse-body', arrow: 'pattern-arrow', onOpen: () => renderHourlyPattern() },
      'cf-chart':   { body: 'chart-collapse-body', arrow: 'chart-arrow' },
      'cf-archive': { body: 'archive-container',   arrow: 'archive-arrow', onOpen: () => loadArchiveView() },
      'cf-table':   { body: 'table-container',     arrow: 'table-arrow' }
    };
    const CF_COLLAPSED_DEFAULT = ['cf-pattern', 'cf-archive', 'cf-table']; // Muster/Archiv/Tabelle starten zu
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

    // ============ Wochen-Muster-Heatmap (Plan4-16) ============
    let _patternField = 'humidity';
    function setPatternField(field) { _patternField = field === 'temp' ? 'temp' : 'humidity'; renderHourlyPattern(); }
    function renderHourlyPattern() {
      const el = document.getElementById('pattern-grid');
      if (!el) return;
      // Umschalter-Status
      ['temp', 'humidity'].forEach(f => {
        const b = document.getElementById(`pattern-btn-${f}`);
        if (b) b.className = f === _patternField
          ? 'px-2 py-0.5 rounded text-[10px] font-semibold bg-teal-500/15 text-teal-300 border border-teal-500/30'
          : 'px-2 py-0.5 rounded text-[10px] font-semibold text-slate-400 border border-slate-800 hover:text-slate-200';
      });
      const pat = hourlyPattern(appState.insideData, _patternField);
      if (!pat) { el.innerHTML = '<p class="text-xs text-slate-500">Noch keine Daten für das Wochen-Muster.</p>'; return; }
      const days = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
      const unit = _patternField === 'temp' ? ' °C' : ' %';
      const cellStyle = v => {
        if (v == null) return 'background:rgba(30,41,59,0.4)';
        const t = pat.max > pat.min ? (v - pat.min) / (pat.max - pat.min) : 0.5;
        if (_patternField === 'temp') {
          const r = Math.round(59 + t * (239 - 59)), g = Math.round(130 - t * 70), b = Math.round(246 - t * 200);
          return `background:rgb(${r},${g},${b})`;
        }
        return `background:rgba(59,130,246,${(0.12 + t * 0.75).toFixed(2)})`;
      };
      const cols = 'grid-template-columns:1.6rem repeat(24,1fr)';
      let html = `<div class="grid gap-0.5" style="${cols}">`;
      pat.grid.forEach((rowVals, ri) => {
        html += `<span class="text-[9px] text-slate-500 flex items-center">${days[ri]}</span>`;
        rowVals.forEach((v, hi) => {
          const title = v == null ? `${days[ri]} ${hi}:00 – keine Daten`
            : `${days[ri]} ${hi}:00 – ${v.toFixed(1).replace('.', ',')}${unit}`;
          html += `<span class="rounded-sm" style="${cellStyle(v)};height:12px" title="${title}"></span>`;
        });
      });
      html += '</div>';
      // Stunden-Achse (0/6/12/18)
      html += `<div class="grid gap-0.5 mt-1" style="${cols}"><span></span>`
        + Array.from({ length: 24 }, (_, h) => `<span class="text-[8px] text-slate-600 text-center">${h % 6 === 0 ? h : ''}</span>`).join('')
        + '</div>';
      el.innerHTML = html;
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
          <td class="p-3 text-blue-400 font-semibold">${feed.humidity.toFixed(0)} %</td>
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
