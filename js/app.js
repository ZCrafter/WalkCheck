/* ═══════════════════════════════════════════════════
   WalkCheck v2 — app.js
   Sources: Open-Meteo · NWS · wttr.in · OpenWeatherMap
═══════════════════════════════════════════════════ */
'use strict';

const DEFAULTS = {
  units: 'imperial',
  tempMin: 32,             // °F feels-like no-go
  tempMax: 95,             // °F feels-like no-go
  precipThreshold: 40,     // % no-go
  windThreshold: 25,       // mph no-go
  sunscreenReminder: true,
  sunglassesReminder: true,
  brightClothingReminder: true,
  owmKey: '',
  // Clothing thresholds °F (feels-like)
  topT1: 45,   // heavy coat → jacket
  topT2: 60,   // jacket → light layer
  topT3: 72,   // light layer → t-shirt
  botT1: 40,   // sweatpants → joggers
  botT2: 65,   // joggers → shorts
  schedules: []
};

const DAY_SHORT = ['S','M','T','W','T','F','S'];
const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

let state = {
  settings: loadSettings(),
  coords: null,
  locationName: 'Your Location',
  weatherData: null,
  rawSources: {},          // raw parsed data per source for debug
  lastUpdated: null,
  editingScheduleIndex: null,
  sourceDotsClicks: 0,
  sourceDotsTimer: null,
  refreshTimer: null,
  modalDuration: 30
};

const $ = id => document.getElementById(id);

// ══════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════
function loadSettings() {
  try {
    const raw = localStorage.getItem('walkcheck_v2');
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (_) {}
  return { ...DEFAULTS };
}
function saveSettings() {
  localStorage.setItem('walkcheck_v2', JSON.stringify(state.settings));
}

// ══════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  applySettingsToUI();
  bindEvents();
  await init();
  scheduleAutoRefresh();
});

async function init() {
  showLoading(true, 'Getting your location...');
  try {
    state.coords = await getLocation();
    showLoading(true, 'Fetching forecasts...');
    await Promise.all([
      fetchLocationName(state.coords),
      fetchAndMergeWeather(state.coords)
    ]);
    renderAll();
  } catch (err) {
    showError('Could not load weather: ' + err.message);
    console.error(err);
  } finally {
    showLoading(false);
  }
}

function scheduleAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(async () => {
    if (!state.coords) return;
    try {
      await fetchAndMergeWeather(state.coords);
      renderAll();
    } catch (e) {
      console.warn('Auto-refresh failed:', e);
    }
  }, 15 * 60 * 1000); // 15 minutes
}

// ══════════════════════════════════════════════════
// GEOLOCATION
// ══════════════════════════════════════════════════
function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('Geolocation not supported')); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      _err => resolve({ lat: 39.3601, lon: -84.3099 }), // fallback
      { timeout: 8000, maximumAge: 600000 }
    );
  });
}

async function fetchLocationName({ lat, lon }) {
  try {
    const res  = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`, { headers: { 'Accept-Language': 'en' } });
    const data = await res.json();
    const a    = data.address || {};
    state.locationName = a.city || a.town || a.village || a.county || 'Your Location';
  } catch (_) {}
  $('location-name').textContent = state.locationName;
}

// ══════════════════════════════════════════════════
// WEATHER SOURCES
// ══════════════════════════════════════════════════
async function fetchAndMergeWeather({ lat, lon }) {
  const fetchJobs = [
    fetchOpenMeteo(lat, lon).then(d => ({ key: 'openMeteo', data: d })).catch(e => ({ key: 'openMeteo', err: e.message })),
    fetchNWS(lat, lon)      .then(d => ({ key: 'nws',       data: d })).catch(e => ({ key: 'nws',       err: e.message })),
    fetchWttrIn(lat, lon)   .then(d => ({ key: 'wttr',      data: d })).catch(e => ({ key: 'wttr',      err: e.message })),
  ];

  const owmKey = state.settings.owmKey?.trim();
  if (owmKey) {
    fetchJobs.push(fetchOWM(lat, lon, owmKey).then(d => ({ key: 'owm', data: d })).catch(e => ({ key: 'owm', err: e.message })));
  }

  const results = await Promise.all(fetchJobs);
  state.rawSources = {};
  results.forEach(r => { state.rawSources[r.key] = r; });

  const good = results.filter(r => r.data);
  if (good.length === 0) throw new Error('All weather sources failed');

  state.weatherData = mergeForecasts(good.map(r => ({ key: r.key, data: r.data })));
  renderSourceDots(results);

  state.lastUpdated = new Date();
  $('last-updated').textContent = 'Updated ' + formatTime(state.lastUpdated);
}

// ── Open-Meteo ──────────────────────────────────
async function fetchOpenMeteo(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat, longitude: lon,
    hourly: ['temperature_2m','apparent_temperature','precipitation_probability','weathercode','windspeed_10m','relativehumidity_2m','is_day'].join(','),
    daily:  ['temperature_2m_max','temperature_2m_min','precipitation_probability_max','weathercode','sunrise','sunset'].join(','),
    temperature_unit: 'fahrenheit', windspeed_unit: 'mph',
    precipitation_unit: 'inch', timezone: 'auto', forecast_days: 3
  });
  const res  = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  const data = await res.json();
  if (data.error) throw new Error(data.reason || 'Open-Meteo error');

  const h = data.hourly;
  const hourly = h.time.map((t, i) => ({
    time: new Date(t),
    temp: Math.round(h.temperature_2m[i]),
    feelsLike: Math.round(h.apparent_temperature[i]),
    precipChance: h.precipitation_probability[i] ?? 0,
    windSpeed: Math.round(h.windspeed_10m[i]),
    humidity: h.relativehumidity_2m[i],
    code: h.weathercode[i],
    isDay: h.is_day[i]
  }));

  const d = data.daily;
  const daily = d.time.map((t, i) => ({
    date: new Date(t + 'T12:00:00'),
    high: Math.round(d.temperature_2m_max[i]),
    low:  Math.round(d.temperature_2m_min[i]),
    precipChance: d.precipitation_probability_max[i] ?? 0,
    code: d.weathercode[i],
    sunrise: d.sunrise[i] ? new Date(d.sunrise[i]) : null,
    sunset:  d.sunset[i]  ? new Date(d.sunset[i])  : null
  }));

  return { hourly, daily, timezone: data.timezone };
}

// ── NWS ─────────────────────────────────────────
async function fetchNWS(lat, lon) {
  const pRes = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { headers: { 'User-Agent': 'WalkCheck/2.0 (personal-use)' } });
  if (!pRes.ok) throw new Error(`NWS points ${pRes.status}`);
  const pData = await pRes.json();
  const url   = pData.properties?.forecastHourly;
  if (!url) throw new Error('NWS: no hourly URL');

  const fRes  = await fetch(url, { headers: { 'User-Agent': 'WalkCheck/2.0 (personal-use)' } });
  if (!fRes.ok) throw new Error(`NWS forecast ${fRes.status}`);
  const fData = await fRes.json();

  const hourly = (fData.properties?.periods || []).slice(0, 36).map(p => {
    const tempF = p.temperatureUnit === 'F' ? p.temperature : p.temperature * 9/5 + 32;
    return {
      time: new Date(p.startTime),
      temp: Math.round(tempF),
      feelsLike: Math.round(tempF),
      precipChance: p.probabilityOfPrecipitation?.value ?? 0,
      windSpeed: parseFloat((p.windSpeed || '0').replace(/[^\d.]/g, '')) || 0,
      humidity: null,
      code: null,
      isDay: p.isDaytime ? 1 : 0,
      shortForecast: p.shortForecast || ''
    };
  });
  return { hourly, daily: [] };
}

// ── wttr.in ──────────────────────────────────────
async function fetchWttrIn(lat, lon) {
  const res  = await fetch(`https://wttr.in/${lat},${lon}?format=j1`);
  if (!res.ok) throw new Error(`wttr.in ${res.status}`);
  const data = await res.json();

  const hourly = [];
  const now    = new Date();

  (data.weather || []).forEach((day, di) => {
    const dateStr = day.date; // YYYY-MM-DD
    (day.hourly || []).forEach(h => {
      const hNum  = parseInt(h.time) / 100;
      const dt    = new Date(`${dateStr}T${String(hNum).padStart(2,'0')}:00:00`);
      const tempF = parseFloat(h.tempF);
      const flF   = parseFloat(h.FeelsLikeF);
      hourly.push({
        time: dt,
        temp: Math.round(tempF),
        feelsLike: Math.round(flF),
        precipChance: parseFloat(h.chanceofrain || 0),
        windSpeed: parseFloat(h.windspeedMiles || 0),
        humidity: parseFloat(h.humidity || 0),
        code: null,
        isDay: (hNum >= 6 && hNum <= 20) ? 1 : 0,
        desc: (h.weatherDesc?.[0]?.value || '')
      });
    });
  });

  const daily = (data.weather || []).map(day => ({
    date: new Date(day.date + 'T12:00:00'),
    high: parseFloat(day.maxtempF),
    low:  parseFloat(day.mintempF),
    precipChance: parseFloat(day.hourly?.[0]?.chanceofrain || 0),
    code: null
  }));

  return { hourly, daily };
}

// ── OpenWeatherMap ───────────────────────────────
async function fetchOWM(lat, lon, key) {
  const res  = await fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${key}&units=imperial&cnt=40`);
  if (!res.ok) throw new Error(`OWM ${res.status}`);
  const data = await res.json();
  if (data.cod !== '200') throw new Error(`OWM: ${data.message}`);

  const hourly = (data.list || []).map(item => ({
    time: new Date(item.dt * 1000),
    temp: Math.round(item.main.temp),
    feelsLike: Math.round(item.main.feels_like),
    precipChance: Math.round((item.pop || 0) * 100),
    windSpeed: Math.round(item.wind?.speed || 0),
    humidity: item.main.humidity,
    code: null,
    isDay: item.sys?.pod === 'd' ? 1 : 0,
    desc: item.weather?.[0]?.description || ''
  }));

  return { hourly, daily: [] };
}

// ══════════════════════════════════════════════════
// MERGE SOURCES
// ══════════════════════════════════════════════════
function mergeForecasts(sources) {
  // Build a map: ISO-hour → array of readings
  const byHour = {};

  sources.forEach(({ key, data }) => {
    data.hourly.forEach(h => {
      const iso = roundToHour(h.time).toISOString();
      if (!byHour[iso]) byHour[iso] = [];
      byHour[iso].push({ ...h, _source: key });
    });
  });

  // For each hour slot, average available values
  const merged = Object.entries(byHour)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([iso, readings]) => {
      const avg = (field) => {
        const vals = readings.map(r => r[field]).filter(v => v != null && !isNaN(v));
        return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
      };
      const first = readings[0];
      return {
        time: new Date(iso),
        temp: avg('temp'),
        feelsLike: avg('feelsLike') ?? avg('temp'),
        precipChance: avg('precipChance') ?? 0,
        windSpeed: avg('windSpeed') ?? 0,
        humidity: avg('humidity'),
        code: readings.find(r => r.code != null)?.code ?? null,
        isDay: first.isDay,
        sourceCount: readings.length
      };
    });

  // Daily — prefer Open-Meteo or wttr.in
  const omSource  = sources.find(s => s.key === 'openMeteo');
  const wttrSource = sources.find(s => s.key === 'wttr');
  const daily     = omSource?.data?.daily || wttrSource?.data?.daily || [];

  // Sun info for today
  const today   = new Date();
  const sunInfo = omSource?.data?.daily?.find(d => isSameDay(d.date, today)) || null;

  return { hourly: merged, daily, sunInfo };
}

function roundToHour(date) {
  const d = new Date(date); d.setMinutes(0,0,0); return d;
}
function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// ══════════════════════════════════════════════════
// WEATHER CODE HELPERS
// ══════════════════════════════════════════════════
function weatherEmoji(code, isDay) {
  if (code == null) return isDay ? '🌤️' : '🌙';
  if (code === 0)   return isDay ? '☀️'  : '🌙';
  if (code <= 2)    return isDay ? '🌤️' : '🌙';
  if (code <= 3)    return '☁️';
  if (code <= 49)   return '🌫️';
  if (code <= 55)   return '🌦️';
  if (code <= 65)   return '🌧️';
  if (code <= 75)   return '❄️';
  if (code <= 77)   return '🌨️';
  if (code <= 82)   return '🌧️';
  if (code <= 86)   return '🌨️';
  if (code <= 99)   return '⛈️';
  return '🌡️';
}
function weatherDesc(code) {
  if (code == null) return 'Unknown';
  if (code === 0)  return 'Clear';
  if (code <= 2)   return 'Partly cloudy';
  if (code <= 3)   return 'Overcast';
  if (code <= 49)  return 'Foggy';
  if (code <= 51)  return 'Light drizzle';
  if (code <= 55)  return 'Drizzle';
  if (code <= 57)  return 'Freezing drizzle';
  if (code <= 61)  return 'Light rain';
  if (code <= 65)  return 'Rain';
  if (code <= 67)  return 'Freezing rain';
  if (code <= 71)  return 'Light snow';
  if (code <= 75)  return 'Snow';
  if (code <= 77)  return 'Snow grains';
  if (code <= 82)  return 'Rain showers';
  if (code <= 86)  return 'Snow showers';
  if (code <= 99)  return 'Thunderstorm';
  return 'Unknown';
}

// ══════════════════════════════════════════════════
// GO / NO-GO LOGIC
// ══════════════════════════════════════════════════
function evaluateHour(hourData) {
  if (!hourData) return { verdict: 'unknown', reasons: [] };
  const s = state.settings;
  const temp = hourData.feelsLike ?? hourData.temp;
  const reasons = [];
  let isGo = true;

  if (temp < s.tempMin) { isGo = false; reasons.push(`Feels like ${temp}° — below ${s.tempMin}° limit`); }
  if (temp > s.tempMax) { isGo = false; reasons.push(`Feels like ${temp}° — above ${s.tempMax}° limit`); }
  if (hourData.precipChance >= s.precipThreshold) { isGo = false; reasons.push(`${hourData.precipChance}% precip — above ${s.precipThreshold}% limit`); }
  if (hourData.windSpeed   >= s.windThreshold)    { isGo = false; reasons.push(`Wind ${hourData.windSpeed} mph — above ${s.windThreshold} mph limit`); }

  let isMarginal = false;
  if (isGo) {
    if (temp < s.tempMin + 10 || temp > s.tempMax - 10)    isMarginal = true;
    if (hourData.precipChance >= s.precipThreshold * 0.65) isMarginal = true;
    if (hourData.windSpeed    >= s.windThreshold  * 0.70)  isMarginal = true;
  }

  return { verdict: !isGo ? 'nogo' : isMarginal ? 'warn' : 'go', reasons };
}

// Evaluate an entire walk window (start time + duration in minutes)
function evaluateWalkWindow(startTime, durationMin) {
  if (!state.weatherData?.hourly) return { verdict: 'unknown', reasons: [], shortMinutes: null, trend: null };

  const endTime  = new Date(startTime.getTime() + durationMin * 60000);
  const relevant = state.weatherData.hourly.filter(h => h.time >= startTime && h.time <= endTime);
  if (relevant.length === 0) {
    // Use closest hour
    const closest = getHourlyForTime(startTime);
    if (!closest) return { verdict: 'unknown', reasons: [], shortMinutes: null, trend: null };
    const { verdict, reasons } = evaluateHour(closest);
    return { verdict, reasons, shortMinutes: null, trend: null };
  }

  let firstBadIdx = -1;
  const verdicts  = relevant.map((h, i) => {
    const ev = evaluateHour(h);
    if (ev.verdict === 'nogo' && firstBadIdx === -1) firstBadIdx = i;
    return ev;
  });

  const allGo    = verdicts.every(v => v.verdict === 'go');
  const anyNogo  = verdicts.some(v => v.verdict === 'nogo');
  const anyWarn  = verdicts.some(v => v.verdict === 'warn');

  // Trend: compare first half vs second half avg feelsLike
  let trend = null;
  if (relevant.length >= 2) {
    const mid   = Math.floor(relevant.length / 2);
    const first = relevant.slice(0, mid).reduce((a,h) => a + (h.feelsLike ?? h.temp), 0) / mid;
    const last  = relevant.slice(mid).reduce((a,h) => a + (h.feelsLike ?? h.temp), 0) / (relevant.length - mid);
    const diff  = last - first;
    if (Math.abs(diff) >= 3) trend = diff > 0 ? 'warming' : 'cooling';

    // Also check precip trend
    const firstPrecip = relevant.slice(0, mid).reduce((a,h) => a + h.precipChance, 0) / mid;
    const lastPrecip  = relevant.slice(mid).reduce((a,h) => a + h.precipChance, 0) / (relevant.length - mid);
    const precipDiff  = lastPrecip - firstPrecip;
    if (precipDiff > 10) trend = (trend || '') + (trend ? ', ' : '') + 'precip building';
    else if (precipDiff < -10) trend = (trend || '') + (trend ? ', ' : '') + 'precip clearing';
  }

  if (allGo)   return { verdict: 'go',   reasons: [], shortMinutes: null, trend };
  if (anyWarn && !anyNogo) {
    const worstReason = verdicts.find(v => v.verdict === 'warn')?.reasons[0] || '';
    return { verdict: 'warn', reasons: [worstReason], shortMinutes: null, trend };
  }

  // Partial go: how long until it goes bad?
  let shortMinutes = null;
  if (firstBadIdx > 0) {
    shortMinutes = firstBadIdx * 60; // each slot is ~1 hour
  }

  const badHour  = verdicts.find(v => v.verdict === 'nogo');
  const reasons  = badHour?.reasons || [];
  return { verdict: 'nogo', reasons, shortMinutes, trend };
}

// ══════════════════════════════════════════════════
// GEAR RECOMMENDATIONS
// ══════════════════════════════════════════════════
function getGearItems(hourData) {
  if (!hourData) return [];
  const s    = state.settings;
  const now  = new Date();
  const hour = now.getHours();
  const temp = hourData.feelsLike ?? hourData.temp;
  const gear = [];

  // ── Top layer ──
  if (temp < s.topT1) {
    gear.push({ emoji: '🧥', text: 'Heavy coat', type: 'normal' });
    if (temp < 25) gear.push({ emoji: '🧤', text: 'Hat and gloves', type: 'normal' });
  } else if (temp < s.topT2) {
    gear.push({ emoji: '🧥', text: 'Jacket or fleece', type: 'normal' });
  } else if (temp < s.topT3) {
    gear.push({ emoji: '👕', text: 'Light layer on top', type: 'normal' });
  } else {
    gear.push({ emoji: '👕', text: 'T-shirt weather', type: 'normal' });
  }

  // ── Bottom layer ──
  if (temp < s.botT1) {
    gear.push({ emoji: '🩱', text: 'Sweatpants or thermals', type: 'normal' });
  } else if (temp < s.botT2) {
    gear.push({ emoji: '👖', text: 'Joggers or pants', type: 'normal' });
  } else {
    gear.push({ emoji: '🩳', text: 'Shorts', type: 'normal' });
  }

  // ── Footwear ──
  if (temp < 32 || hourData.precipChance > 30) {
    gear.push({ emoji: '👟', text: 'Waterproof or grippy shoes', type: 'normal' });
  }

  // ── Rain ──
  if (hourData.precipChance >= 20 && hourData.precipChance < s.precipThreshold) {
    gear.push({ emoji: '☂️', text: `Bring an umbrella (${hourData.precipChance}% chance)`, type: 'alert' });
  }

  // ── Wind ──
  if (hourData.windSpeed >= s.windThreshold * 0.65 && hourData.windSpeed < s.windThreshold) {
    gear.push({ emoji: '💨', text: `Windbreaker — ${hourData.windSpeed} mph wind`, type: 'alert' });
  }

  // ── Heat warning ──
  if (temp >= 90) gear.push({ emoji: '🥵', text: 'Serious heat — shorten or skip', type: 'alert' });

  // ── Hydration ──
  if (temp >= 75) gear.push({ emoji: '💧', text: 'Bring water', type: 'normal' });

  // ── Sunscreen: 10am–4pm ──
  if (s.sunscreenReminder && hour >= 10 && hour <= 16 && hourData.isDay) {
    gear.push({ emoji: '🧴', text: 'Apply sunscreen before heading out', type: 'safety' });
  }

  // ── Sunglasses: sunny ──
  if (s.sunglassesReminder && hourData.isDay && hourData.code != null && hourData.code <= 3) {
    gear.push({ emoji: '🕶️', text: 'Sunglasses', type: 'safety' });
  }

  // ── Night visibility ──
  const sunInfo = state.weatherData?.sunInfo;
  const isNight = sunInfo
    ? (now < sunInfo.sunrise || now > sunInfo.sunset)
    : !hourData.isDay;

  if (s.brightClothingReminder && isNight) {
    gear.push({ emoji: '🔆', text: 'Bright or reflective clothing — low visibility', type: 'safety' });
  }

  return gear;
}

// ══════════════════════════════════════════════════
// RENDER
// ══════════════════════════════════════════════════
function renderAll() {
  if (!state.weatherData) return;
  const now     = new Date();
  const curIdx  = findCurrentHourIndex(state.weatherData.hourly, now);
  const current = state.weatherData.hourly[curIdx] || state.weatherData.hourly[0];

  renderHeader(current);
  renderConditions(current);
  renderGear(current);
  renderHourly(state.weatherData.hourly, curIdx);
  renderDailySummary(state.weatherData.daily);
  renderWalkWindows();
}

function renderHeader(current) {
  const { verdict, reasons } = evaluateHour(current);
  const header = $('verdict-header');
  header.className = `verdict-header state-${verdict}`;

  const labelMap = { go: 'GO', warn: 'MARGINAL', nogo: 'NO GO', unknown: '—' };
  const iconMap  = { go: '✓', warn: '!', nogo: '✕', unknown: '?' };
  const subMap   = {
    go:      `Good conditions for your walk right now`,
    warn:    reasons[0] || 'Borderline conditions — check hourly',
    nogo:    reasons[0] || 'Not suitable for a walk right now',
    unknown: 'Loading...'
  };

  $('verdict-label').textContent    = labelMap[verdict] || '—';
  $('verdict-icon').textContent     = iconMap[verdict]  || '?';
  $('verdict-sublabel').textContent = subMap[verdict]   || '';
}

function renderConditions(current) {
  if (!current) return;
  const isM = state.settings.units === 'metric';
  const u   = isM ? '°C' : '°F';
  const wu  = isM ? 'km/h' : 'mph';

  $('current-temp').textContent  = current.temp + '°';
  $('temp-unit-display').textContent = u;
  $('feels-like').textContent    = (current.feelsLike ?? current.temp) + u;
  $('precip-chance').textContent = (current.precipChance ?? '--') + '%';
  $('wind-speed').textContent    = current.windSpeed + ' ' + wu;
  $('humidity').textContent      = current.humidity != null ? current.humidity + '%' : '--';
  $('sky-condition').textContent = weatherDesc(current.code);
}

function renderGear(current) {
  const { verdict } = evaluateHour(current);
  const list = $('gear-list');

  if (verdict === 'nogo') {
    list.innerHTML = `<div class="gear-item" style="border-color:var(--nogo);background:var(--nogo-dim);color:var(--nogo)">
      <span class="gear-emoji">⛔</span><span>Conditions are not suitable — consider skipping today</span>
    </div>`;
    return;
  }

  const items = getGearItems(current);
  if (!items.length) {
    list.innerHTML = `<div class="gear-item"><span class="gear-emoji">👍</span><span>No special gear needed</span></div>`;
    return;
  }
  list.innerHTML = items.map(item => `
    <div class="gear-item${item.type === 'alert' ? ' gear-alert' : item.type === 'safety' ? ' gear-safety' : ''}">
      <span class="gear-emoji">${item.emoji}</span><span>${item.text}</span>
    </div>`).join('');
}

function renderHourly(hourly, currentIdx) {
  const slots  = hourly.slice(currentIdx, currentIdx + 12);
  const scroll = $('hourly-scroll');

  scroll.innerHTML = slots.map((h, i) => {
    const { verdict } = evaluateHour(h);
    const isNow = i === 0;
    const emoji = weatherEmoji(h.code, h.isDay);
    const time  = formatHour(h.time);

    return `<div class="hourly-slot slot-${verdict}${isNow ? ' is-now' : ''}">
      ${isNow ? '<div class="slot-now-label">NOW</div>' : '<div class="slot-now-label" style="visibility:hidden">·</div>'}
      <div class="slot-time">${isNow ? '' : time}</div>
      <div class="slot-emoji">${emoji}</div>
      <div class="slot-temp">${h.temp}°</div>
      <div class="slot-precip">💧${h.precipChance}%</div>
      <div class="slot-status-dot"></div>
    </div>`;
  }).join('');
}

function renderDailySummary(daily) {
  const container = $('daily-summary');
  if (!daily?.length) { container.innerHTML = ''; return; }

  const highs  = daily.map(d => d.high).filter(Boolean);
  const lows   = daily.map(d => d.low).filter(n => n != null);
  const maxT   = Math.max(...highs);
  const minT   = Math.min(...lows);
  const range  = maxT - minT || 1;

  container.innerHTML = daily.slice(0, 3).map(d => {
    const label  = isSameDay(d.date, new Date()) ? 'Today' : DAY_NAMES[d.date.getDay()];
    const barPct = Math.max(10, ((d.high - minT) / range) * 100);
    return `<div class="daily-row">
      <div class="daily-day">${label}</div>
      <div class="daily-bar-track"><div class="daily-bar-fill" style="width:${barPct}%"></div></div>
      <div class="daily-hi">${d.high}°</div>
    </div>`;
  }).join('');
}

function renderWalkWindows() {
  const container = $('walk-windows');
  const schedules = state.settings.schedules;

  if (!schedules?.length) {
    container.innerHTML = `<div class="no-schedule">No schedules set — add them in Settings</div>`;
    return;
  }

  const today = new Date().getDay();
  // Show ALL schedules that include today, regardless of time overlap
  const todaySchedules = schedules.filter(s => s.days.includes(today));

  if (!todaySchedules.length) {
    container.innerHTML = `<div class="no-schedule">No walks scheduled for today</div>`;
    return;
  }

  container.innerHTML = todaySchedules.map(sched => {
    const [hh, mm] = sched.time.split(':').map(Number);
    const walkStart = new Date(); walkStart.setHours(hh, mm, 0, 0);
    const dur = sched.duration || 30;

    const { verdict, reasons, shortMinutes, trend } = evaluateWalkWindow(walkStart, dur);

    const labelMap = { go: 'GO', warn: 'MARGINAL', nogo: 'NO GO', unknown: '—' };

    let statusExtra = '';
    if (verdict === 'nogo' && shortMinutes > 0) {
      statusExtra = `Good for ~${shortMinutes} min`;
    }

    let trendStr = '';
    if (verdict === 'warn' || verdict === 'go') {
      if (trend) trendStr = trend.charAt(0).toUpperCase() + trend.slice(1) + ' during your walk';
    }

    let reasonHtml = '';
    if (verdict === 'nogo' && reasons.length) {
      reasonHtml = `<div class="ww-reason reason-nogo">⛔ ${reasons[0]}${shortMinutes > 0 ? ` — safe for first ~${shortMinutes} min` : ''}</div>`;
    } else if (verdict === 'warn' && reasons.length) {
      reasonHtml = `<div class="ww-reason reason-warn">⚠️ ${reasons[0]}</div>`;
    }

    return `<div class="walk-window-item ww-${verdict}">
      <div class="ww-top">
        <div class="ww-time-label">
          <div class="ww-time">${formatHour(walkStart)}</div>
          <div class="ww-label">${sched.label || 'Walk'} · ${dur} min</div>
        </div>
        <div class="ww-right">
          <div class="ww-status">${labelMap[verdict] || '—'}</div>
          ${trendStr ? `<div class="ww-trend">${trendStr}</div>` : ''}
        </div>
      </div>
      ${reasonHtml}
    </div>`;
  }).join('');
}

function renderSourceDots(results) {
  const sourceNames = { openMeteo: 'Open-Meteo', nws: 'NWS', wttr: 'wttr.in', owm: 'OpenWeatherMap' };
  const container   = $('source-dots');
  const label       = $('source-label');

  container.innerHTML = results.map(r => {
    const cls = r.data ? 'source-dot active' : 'source-dot failed';
    return `<div class="${cls}" title="${sourceNames[r.key] || r.key}: ${r.data ? 'OK' : r.err}"></div>`;
  }).join('');

  const good = results.filter(r => r.data).length;
  label.textContent = good === results.length
    ? `${good} sources agree`
    : `${good}/${results.length} sources`;
}

// ══════════════════════════════════════════════════
// DEBUG PANEL
// ══════════════════════════════════════════════════
function openDebugPanel() {
  $('debug-overlay').classList.remove('hidden');
  $('debug-panel').classList.remove('hidden');

  const body   = $('debug-body');
  const raw    = state.rawSources;
  const sourceNames = { openMeteo: 'Open-Meteo', nws: 'NWS', wttr: 'wttr.in', owm: 'OpenWeatherMap' };

  if (!Object.keys(raw).length) {
    body.textContent = 'No data yet.';
    return;
  }

  let html = '';

  // Summary table
  html += `<div class="debug-source-block">`;
  html += `<div class="debug-source-title">Source Summary</div>`;

  Object.entries(raw).forEach(([key, r]) => {
    const name   = sourceNames[key] || key;
    const status = r.data ? '<span class="debug-ok">✓ OK</span>' : `<span class="debug-err">✗ ${r.err}</span>`;

    if (r.data) {
      const now      = new Date();
      const curHour  = findCurrentHourIndex(r.data.hourly, now);
      const curData  = r.data.hourly[curHour];
      const temp     = curData?.temp ?? 'n/a';
      const fl       = curData?.feelsLike ?? 'n/a';
      const precip   = curData?.precipChance ?? 'n/a';
      const wind     = curData?.windSpeed ?? 'n/a';
      const desc     = curData?.desc || weatherDesc(curData?.code);
      html += `<div style="margin-bottom:10px">`;
      html += `<span class="debug-key">${name}</span>: ${status}\n`;
      html += `  <span class="debug-key">Temp:</span> <span class="debug-val">${temp}°F</span>  `;
      html += `<span class="debug-key">Feels:</span> <span class="debug-val">${fl}°F</span>  `;
      html += `<span class="debug-key">Precip:</span> <span class="debug-val">${precip}%</span>  `;
      html += `<span class="debug-key">Wind:</span> <span class="debug-val">${wind}mph</span>\n`;
      if (desc) html += `  <span class="debug-key">Desc:</span> <span class="debug-val">${desc}</span>\n`;
      html += `</div>`;
    } else {
      html += `<div style="margin-bottom:6px"><span class="debug-key">${name}</span>: ${status}</div>`;
    }
  });
  html += `</div>`;

  // Merged current
  if (state.weatherData) {
    const now    = new Date();
    const curIdx = findCurrentHourIndex(state.weatherData.hourly, now);
    const cur    = state.weatherData.hourly[curIdx];
    html += `<div class="debug-source-block">`;
    html += `<div class="debug-source-title">Merged Current Hour</div>`;
    html += `<span class="debug-key">Temp:</span> <span class="debug-val">${cur?.temp}°F</span>  `;
    html += `<span class="debug-key">Feels:</span> <span class="debug-val">${cur?.feelsLike}°F</span>  `;
    html += `<span class="debug-key">Precip:</span> <span class="debug-val">${cur?.precipChance}%</span>  `;
    html += `<span class="debug-key">Wind:</span> <span class="debug-val">${cur?.windSpeed}mph</span>\n`;
    html += `<span class="debug-key">Sources contributing this hour:</span> <span class="debug-val">${cur?.sourceCount}</span>\n`;
    html += `<span class="debug-key">Sky code:</span> <span class="debug-val">${cur?.code} (${weatherDesc(cur?.code)})</span>`;
    html += `</div>`;
  }

  // Next 6 hours merged
  if (state.weatherData) {
    const now    = new Date();
    const curIdx = findCurrentHourIndex(state.weatherData.hourly, now);
    const next   = state.weatherData.hourly.slice(curIdx, curIdx + 6);
    html += `<div class="debug-source-block">`;
    html += `<div class="debug-source-title">Next 6 Hours (Merged)</div>`;
    next.forEach(h => {
      const { verdict } = evaluateHour(h);
      const vColor = { go: 'debug-ok', warn: 'debug-val', nogo: 'debug-err', unknown: '' }[verdict] || '';
      html += `${formatHour(h.time).padEnd(6)}: <span class="debug-key">T</span><span class="debug-val">${h.temp}°</span> `;
      html += `<span class="debug-key">FL</span><span class="debug-val">${h.feelsLike}°</span> `;
      html += `<span class="debug-key">P</span><span class="debug-val">${h.precipChance}%</span> `;
      html += `<span class="debug-key">W</span><span class="debug-val">${h.windSpeed}mph</span> `;
      html += `→ <span class="${vColor}">${verdict.toUpperCase()}</span>\n`;
    });
    html += `</div>`;
  }

  body.innerHTML = html;
}

// ══════════════════════════════════════════════════
// SETTINGS UI
// ══════════════════════════════════════════════════
function applySettingsToUI() {
  const s   = state.settings;
  const isM = s.units === 'metric';

  document.querySelectorAll('#units-toggle .toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.val === s.units);
  });

  // Thresholds
  $('temp-min-slider').value = isM ? fToC(s.tempMin) : s.tempMin;
  $('temp-max-slider').value = isM ? fToC(s.tempMax) : s.tempMax;
  $('precip-slider').value   = s.precipThreshold;
  $('wind-slider').value     = isM ? mphToKmh(s.windThreshold) : s.windThreshold;

  // Clothing sliders
  $('top-t1-slider').value = isM ? fToC(s.topT1) : s.topT1;
  $('top-t2-slider').value = isM ? fToC(s.topT2) : s.topT2;
  $('top-t3-slider').value = isM ? fToC(s.topT3) : s.topT3;
  $('bot-t1-slider').value = isM ? fToC(s.botT1) : s.botT1;
  $('bot-t2-slider').value = isM ? fToC(s.botT2) : s.botT2;

  updateAllSliderDisplays();

  $('sunscreen-toggle').checked       = s.sunscreenReminder;
  $('sunglasses-toggle').checked      = s.sunglassesReminder;
  $('bright-clothing-toggle').checked = s.brightClothingReminder;

  $('owm-key-input').value = s.owmKey || '';

  renderSchedulesList();
}

function updateAllSliderDisplays() {
  const s   = state.settings;
  const isM = s.units === 'metric';
  const u   = isM ? '°C' : '°F';
  const wu  = isM ? 'km/h' : 'mph';

  $('temp-min-display').textContent = (isM ? fToC(s.tempMin) : s.tempMin) + u;
  $('temp-max-display').textContent = (isM ? fToC(s.tempMax) : s.tempMax) + u;
  $('precip-display').textContent   = s.precipThreshold + '%';
  $('wind-display').textContent     = (isM ? mphToKmh(s.windThreshold) : s.windThreshold) + ' ' + wu;

  $('top-t1-display').textContent = (isM ? fToC(s.topT1) : s.topT1) + u;
  $('top-t2-display').textContent = (isM ? fToC(s.topT2) : s.topT2) + u;
  $('top-t3-display').textContent = (isM ? fToC(s.topT3) : s.topT3) + u;
  $('bot-t1-display').textContent = (isM ? fToC(s.botT1) : s.botT1) + u;
  $('bot-t2-display').textContent = (isM ? fToC(s.botT2) : s.botT2) + u;
}

function renderSchedulesList() {
  const list = $('schedules-list');
  const schedules = state.settings.schedules;

  if (!schedules.length) {
    list.innerHTML = `<div style="font-size:12px;color:var(--text-muted);padding:4px 0">No schedules yet.</div>`;
    return;
  }

  list.innerHTML = schedules.map((s, i) => {
    const [hh, mm] = s.time.split(':').map(Number);
    const d = new Date(); d.setHours(hh, mm, 0, 0);
    const daysStr  = s.days.sort().map(d => DAY_SHORT[d]).join(' ');
    const durLabel = s.duration < 60 ? `${s.duration} min` : `${Math.floor(s.duration/60)}h${s.duration%60>0?' '+s.duration%60+'m':''}`;

    return `<div class="schedule-item">
      <div class="schedule-item-info">
        <div class="schedule-item-time">${formatHour(d)}</div>
        <div class="schedule-item-meta">${daysStr} · ${durLabel}${s.label ? ' · ' + s.label : ''}</div>
      </div>
      <button class="schedule-delete" data-index="${i}" aria-label="Delete">×</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.schedule-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      state.settings.schedules.splice(parseInt(btn.dataset.index), 1);
      saveSettings();
      renderSchedulesList();
      renderWalkWindows();
    });
  });
}

// ══════════════════════════════════════════════════
// EVENT BINDING
// ══════════════════════════════════════════════════
function bindEvents() {

  // Refresh
  $('refresh-btn').addEventListener('click', async () => {
    $('refresh-btn').classList.add('spinning');
    try {
      await fetchAndMergeWeather(state.coords);
      renderAll();
    } catch (e) { showError('Refresh failed: ' + e.message); }
    finally { $('refresh-btn').classList.remove('spinning'); }
  });

  // Settings
  $('settings-btn').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-overlay').addEventListener('click', closeSettings);

  // Source dots → debug (5 taps within 3s)
  $('source-confidence-row').addEventListener('click', () => {
    state.sourceDotsClicks++;
    if (state.sourceDotsTimer) clearTimeout(state.sourceDotsTimer);
    state.sourceDotsTimer = setTimeout(() => { state.sourceDotsClicks = 0; }, 3000);
    if (state.sourceDotsClicks >= 5) {
      state.sourceDotsClicks = 0;
      openDebugPanel();
    }
  });
  $('debug-close').addEventListener('click', () => {
    $('debug-panel').classList.add('hidden');
    $('debug-overlay').classList.add('hidden');
  });
  $('debug-overlay').addEventListener('click', () => {
    $('debug-panel').classList.add('hidden');
    $('debug-overlay').classList.add('hidden');
  });

  // Units toggle
  document.querySelectorAll('#units-toggle .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.settings.units = btn.dataset.val;
      document.querySelectorAll('#units-toggle .toggle-btn').forEach(b => b.classList.toggle('active', b === btn));
      saveSettings();
      applySettingsToUI();
      renderAll();
    });
  });

  // Threshold sliders
  const sliderMap = [
    ['temp-min-slider', v => { state.settings.tempMin = state.settings.units === 'metric' ? cToF(v) : v; }],
    ['temp-max-slider', v => { state.settings.tempMax = state.settings.units === 'metric' ? cToF(v) : v; }],
    ['precip-slider',   v => { state.settings.precipThreshold = v; }],
    ['wind-slider',     v => { state.settings.windThreshold = state.settings.units === 'metric' ? kmhToMph(v) : v; }],
    ['top-t1-slider',   v => { state.settings.topT1 = state.settings.units === 'metric' ? cToF(v) : v; }],
    ['top-t2-slider',   v => { state.settings.topT2 = state.settings.units === 'metric' ? cToF(v) : v; }],
    ['top-t3-slider',   v => { state.settings.topT3 = state.settings.units === 'metric' ? cToF(v) : v; }],
    ['bot-t1-slider',   v => { state.settings.botT1 = state.settings.units === 'metric' ? cToF(v) : v; }],
    ['bot-t2-slider',   v => { state.settings.botT2 = state.settings.units === 'metric' ? cToF(v) : v; }],
  ];
  sliderMap.forEach(([id, setter]) => {
    const el = $(id);
    el.addEventListener('input', e => { setter(parseInt(e.target.value)); updateAllSliderDisplays(); });
    el.addEventListener('change', () => { saveSettings(); renderAll(); });
  });

  // Safety toggles
  [['sunscreen-toggle','sunscreenReminder'],['sunglasses-toggle','sunglassesReminder'],['bright-clothing-toggle','brightClothingReminder']].forEach(([id, key]) => {
    $(id).addEventListener('change', e => { state.settings[key] = e.target.checked; saveSettings(); renderAll(); });
  });

  // OWM key
  $('owm-key-input').addEventListener('change', e => {
    state.settings.owmKey = e.target.value.trim();
    saveSettings();
  });

  // Schedule modal
  $('add-schedule-btn').addEventListener('click', () => {
    state.editingScheduleIndex = null;
    state.modalDuration = 30;
    $('modal-title').textContent  = 'Add Walk Schedule';
    $('schedule-time').value      = '07:00';
    $('schedule-label').value     = '';
    $('modal-duration-display').textContent = '30 min';
    document.querySelectorAll('.day-btn').forEach(btn => {
      const d = parseInt(btn.dataset.day);
      btn.classList.toggle('active', d >= 1 && d <= 5);
    });
    openModal();
  });

  $('modal-duration-stepper').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'inc') state.modalDuration = Math.min(180, state.modalDuration + 15);
    else                              state.modalDuration = Math.max(15,  state.modalDuration - 15);
    $('modal-duration-display').textContent = formatDuration(state.modalDuration);
  });

  document.querySelectorAll('.day-btn').forEach(btn => btn.addEventListener('click', () => btn.classList.toggle('active')));

  $('modal-close').addEventListener('click', closeModal);
  $('modal-cancel').addEventListener('click', closeModal);
  $('schedule-modal-overlay').addEventListener('click', closeModal);

  $('modal-save').addEventListener('click', () => {
    const time  = $('schedule-time').value;
    const label = $('schedule-label').value.trim();
    const days  = [...document.querySelectorAll('.day-btn.active')].map(b => parseInt(b.dataset.day));

    if (!time || days.length === 0) { showError('Set a time and select at least one day'); return; }

    const sched = { time, label, days, duration: state.modalDuration };
    if (state.editingScheduleIndex !== null) state.settings.schedules[state.editingScheduleIndex] = sched;
    else state.settings.schedules.push(sched);

    saveSettings();
    renderSchedulesList();
    renderWalkWindows();
    closeModal();
  });

  $('error-dismiss').addEventListener('click', () => $('error-toast').classList.add('hidden'));
}

function openSettings()  {
  $('settings-overlay').classList.remove('hidden');
  $('settings-drawer').classList.remove('hidden');
  requestAnimationFrame(() => $('settings-drawer').classList.add('open'));
}
function closeSettings() {
  $('settings-drawer').classList.remove('open');
  setTimeout(() => { $('settings-drawer').classList.add('hidden'); $('settings-overlay').classList.add('hidden'); }, 300);
}
function openModal()  { $('schedule-modal-overlay').classList.remove('hidden'); $('schedule-modal').classList.remove('hidden'); }
function closeModal() { $('schedule-modal').classList.add('hidden'); $('schedule-modal-overlay').classList.add('hidden'); }

// ══════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════
function showLoading(show, msg) {
  if (show) {
    if (msg) $('loading-sub').textContent = msg;
    $('loading-screen').classList.remove('hidden');
    $('app').classList.add('hidden');
  } else {
    $('loading-screen').classList.add('hidden');
    $('app').classList.remove('hidden');
  }
}
function showError(msg) {
  $('error-msg').textContent = msg;
  $('error-toast').classList.remove('hidden');
  setTimeout(() => $('error-toast').classList.add('hidden'), 7000);
}
function findCurrentHourIndex(hourly, now) {
  if (!hourly?.length) return 0;
  return hourly.reduce((best, h, i) => Math.abs(h.time - now) < Math.abs(hourly[best].time - now) ? i : best, 0);
}
function getHourlyForTime(target) {
  if (!state.weatherData?.hourly) return null;
  return state.weatherData.hourly.reduce((best, h) => {
    const diff = Math.abs(h.time - target);
    return (!best || diff < Math.abs(best.time - target)) ? h : best;
  }, null);
}
function formatHour(date) {
  let h = date.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}${ampm}`;
}
function formatTime(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function formatDuration(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function fToC(f)       { return Math.round((f - 32) * 5/9); }
function cToF(c)       { return Math.round(c * 9/5 + 32); }
function mphToKmh(mph) { return Math.round(mph * 1.60934); }
function kmhToMph(kmh) { return Math.round(kmh / 1.60934); }
