/* ═══════════════════════════════════════════════════
   WalkCheck — Main App Logic
   Sources: Open-Meteo (primary) + NWS (US secondary)
═══════════════════════════════════════════════════ */

'use strict';

// ── Default Settings ────────────────────────────────
const DEFAULTS = {
  units: 'imperial',
  walkDuration: 30,        // minutes
  tempMin: 32,             // °F
  tempMax: 95,             // °F
  precipThreshold: 40,     // %
  windThreshold: 25,       // mph
  sunscreenReminder: true,
  sunglassesReminder: true,
  brightClothingReminder: true,
  schedules: []
};

// ── Day label helpers ───────────────────────────────
const DAY_NAMES  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DAY_SHORT  = ['S','M','T','W','T','F','S'];
const FULL_DAYS  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// ── App State ───────────────────────────────────────
let state = {
  settings: loadSettings(),
  coords: null,
  locationName: 'Unknown',
  weatherData: null,      // merged forecast
  lastUpdated: null,
  editingScheduleIndex: null
};

// ── DOM refs ────────────────────────────────────────
const $ = id => document.getElementById(id);

// ══════════════════════════════════════════════════════
// SETTINGS PERSISTENCE
// ══════════════════════════════════════════════════════
function loadSettings() {
  try {
    const raw = localStorage.getItem('walkcheck_settings');
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (_) {}
  return { ...DEFAULTS };
}
function saveSettings() {
  localStorage.setItem('walkcheck_settings', JSON.stringify(state.settings));
}

// ══════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  applySettingsToUI();
  bindEvents();
  await init();
});

async function init() {
  showLoading(true);
  try {
    state.coords = await getLocation();
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

// ══════════════════════════════════════════════════════
// GEOLOCATION
// ══════════════════════════════════════════════════════
function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation not supported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      err => {
        // Fallback: Mason, OH
        console.warn('Geolocation failed, using fallback coordinates');
        resolve({ lat: 39.3601, lon: -84.3099 });
      },
      { timeout: 8000, maximumAge: 600000 }
    );
  });
}

async function fetchLocationName({ lat, lon }) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const data = await res.json();
    const addr = data.address || {};
    state.locationName = addr.city || addr.town || addr.village || addr.county || 'Your Location';
    $('location-name').textContent = state.locationName;
  } catch (_) {
    state.locationName = 'Your Location';
    $('location-name').textContent = state.locationName;
  }
}

// ══════════════════════════════════════════════════════
// WEATHER FETCHING — Open-Meteo + NWS
// ══════════════════════════════════════════════════════
async function fetchAndMergeWeather({ lat, lon }) {
  const results = await Promise.allSettled([
    fetchOpenMeteo(lat, lon),
    fetchNWS(lat, lon)
  ]);

  const openMeteo = results[0].status === 'fulfilled' ? results[0].value : null;
  const nws       = results[1].status === 'fulfilled' ? results[1].value : null;

  const sourcesAvailable = [openMeteo, nws].filter(Boolean).length;

  if (!openMeteo && !nws) throw new Error('All weather sources failed');

  state.weatherData = mergeForecasts(openMeteo, nws, sourcesAvailable);

  // Update source indicator
  renderSourceDots(openMeteo, nws);

  state.lastUpdated = new Date();
  $('last-updated').textContent = 'Updated ' + formatTime(state.lastUpdated);
}

// ── Open-Meteo ──────────────────────────────────────
async function fetchOpenMeteo(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: [
      'temperature_2m',
      'apparent_temperature',
      'precipitation_probability',
      'precipitation',
      'weathercode',
      'windspeed_10m',
      'relativehumidity_2m',
      'is_day'
    ].join(','),
    daily: [
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_probability_max',
      'weathercode',
      'sunrise',
      'sunset'
    ].join(','),
    temperature_unit: 'fahrenheit',
    windspeed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'auto',
    forecast_days: 3
  });

  const res  = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  const data = await res.json();
  if (data.error) throw new Error(data.reason || 'Open-Meteo error');
  return parseOpenMeteo(data);
}

function parseOpenMeteo(data) {
  const h = data.hourly;
  const d = data.daily;

  const hourly = h.time.map((t, i) => ({
    time: new Date(t),
    temp: Math.round(h.temperature_2m[i]),
    feelsLike: Math.round(h.apparent_temperature[i]),
    precipChance: h.precipitation_probability[i] ?? 0,
    precip: h.precipitation[i] ?? 0,
    windSpeed: Math.round(h.windspeed_10m[i]),
    humidity: h.relativehumidity_2m[i],
    code: h.weathercode[i],
    isDay: h.is_day[i]
  }));

  const daily = d.time.map((t, i) => ({
    date: new Date(t + 'T12:00:00'),
    high: Math.round(d.temperature_2m_max[i]),
    low: Math.round(d.temperature_2m_min[i]),
    precipChance: d.precipitation_probability_max[i] ?? 0,
    code: d.weathercode[i],
    sunrise: d.sunrise[i] ? new Date(d.sunrise[i]) : null,
    sunset: d.sunset[i] ? new Date(d.sunset[i]) : null
  }));

  return { hourly, daily, timezone: data.timezone };
}

// ── NWS ─────────────────────────────────────────────
async function fetchNWS(lat, lon) {
  const pointsRes = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, {
    headers: { 'User-Agent': 'WalkCheck/1.0 (personal-use)' }
  });
  if (!pointsRes.ok) throw new Error('NWS points failed');
  const points = await pointsRes.json();

  const forecastUrl = points.properties?.forecastHourly;
  if (!forecastUrl) throw new Error('NWS no hourly forecast URL');

  const forecastRes = await fetch(forecastUrl, {
    headers: { 'User-Agent': 'WalkCheck/1.0 (personal-use)' }
  });
  if (!forecastRes.ok) throw new Error('NWS forecast failed');
  const forecast = await forecastRes.json();

  return parseNWS(forecast);
}

function parseNWS(data) {
  const periods = data.properties?.periods || [];
  const hourly = periods.slice(0, 36).map(p => {
    const tempF = p.temperatureUnit === 'F'
      ? p.temperature
      : p.temperature * 9/5 + 32;

    // Extract precip from probabilityOfPrecipitation
    const precip = p.probabilityOfPrecipitation?.value ?? 0;
    const wind   = parseFloat((p.windSpeed || '0').replace(/[^\d.]/g, '')) || 0;

    return {
      time: new Date(p.startTime),
      temp: Math.round(tempF),
      feelsLike: Math.round(tempF), // NWS hourly doesn't reliably provide feelsLike
      precipChance: precip,
      windSpeed: wind,
      humidity: null, // NWS hourly doesn't always include
      shortForecast: p.shortForecast || '',
      isDaytime: p.isDaytime
    };
  });

  return { hourly };
}

// ── Merge Sources ────────────────────────────────────
function mergeForecasts(omData, nwsData, sourceCount) {
  const merged = [];
  const base   = omData || nwsData;
  const now    = new Date();

  // Build NWS lookup by hour
  const nwsMap = {};
  if (nwsData) {
    nwsData.hourly.forEach(h => {
      const key = roundToHour(h.time).toISOString();
      nwsMap[key] = h;
    });
  }

  base.hourly.forEach(omHour => {
    const key = roundToHour(omHour.time).toISOString();
    const nws = nwsMap[key];

    let temp, precip, wind, feelsLike;

    if (omData && nws) {
      // Average both sources
      temp      = Math.round((omHour.temp + nws.temp) / 2);
      precip    = Math.round((omHour.precipChance + nws.precipChance) / 2);
      wind      = Math.round((omHour.windSpeed + nws.windSpeed) / 2);
      feelsLike = omHour.feelsLike; // Use OM for feels-like (NWS hourly often omits it)
    } else if (omData) {
      ({ temp, precipChance: precip, windSpeed: wind, feelsLike } = omHour);
    } else {
      ({ temp, precipChance: precip, windSpeed: wind, feelsLike: feelsLike } = nws);
      feelsLike = temp;
    }

    merged.push({
      time: omHour.time,
      temp,
      feelsLike,
      precipChance: precip,
      windSpeed: wind,
      humidity: omHour.humidity,
      code: omHour.code,
      isDay: omHour.isDay !== undefined ? omHour.isDay : (nws?.isDaytime ? 1 : 0),
      sourceCount
    });
  });

  const daily  = omData?.daily || [];
  const sunInfo = omData?.daily?.find(d => isSameDay(d.date, now));

  return { hourly: merged, daily, sunInfo, sourceCount };
}

function roundToHour(date) {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d;
}
function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

// ══════════════════════════════════════════════════════
// WEATHER CODE → EMOJI + DESCRIPTION
// ══════════════════════════════════════════════════════
function weatherEmoji(code, isDay) {
  if (code === undefined || code === null) return isDay ? '🌤' : '🌙';
  if (code === 0)               return isDay ? '☀️'  : '🌙';
  if (code <= 2)                return isDay ? '🌤️' : '🌙';
  if (code <= 3)                return '☁️';
  if (code <= 49)               return '🌫️';
  if (code <= 55)               return '🌦️';
  if (code <= 65)               return '🌧️';
  if (code <= 75)               return '❄️';
  if (code <= 77)               return '🌨️';
  if (code <= 82)               return '🌧️';
  if (code <= 86)               return '🌨️';
  if (code <= 99)               return '⛈️';
  return '🌡️';
}

function weatherDesc(code) {
  if (code === undefined || code === null) return 'Unknown';
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

// ══════════════════════════════════════════════════════
// GO/NO-GO LOGIC
// ══════════════════════════════════════════════════════
function evaluateConditions(hourData) {
  if (!hourData) return { verdict: 'unknown', reasons: [] };
  const s = state.settings;
  const reasons = [];
  let isGo = true;

  const tempToCheck = hourData.feelsLike ?? hourData.temp;

  if (tempToCheck < s.tempMin) {
    isGo = false;
    reasons.push(`Feels like ${tempToCheck}° — below your ${s.tempMin}° limit`);
  }
  if (tempToCheck > s.tempMax) {
    isGo = false;
    reasons.push(`Feels like ${tempToCheck}° — above your ${s.tempMax}° limit`);
  }
  if (hourData.precipChance >= s.precipThreshold) {
    isGo = false;
    reasons.push(`${hourData.precipChance}% precip chance — above your ${s.precipThreshold}% limit`);
  }
  if (hourData.windSpeed >= s.windThreshold) {
    isGo = false;
    reasons.push(`Wind ${hourData.windSpeed} mph — above your ${s.windThreshold} mph limit`);
  }

  // Marginal: within 20% of thresholds
  let isMarginal = false;
  if (isGo) {
    if (tempToCheck < s.tempMin + 10 || tempToCheck > s.tempMax - 10) isMarginal = true;
    if (hourData.precipChance >= s.precipThreshold * 0.7)             isMarginal = true;
    if (hourData.windSpeed    >= s.windThreshold  * 0.75)             isMarginal = true;
  }

  const verdict = !isGo ? 'nogo' : isMarginal ? 'warn' : 'go';
  return { verdict, reasons };
}

// ══════════════════════════════════════════════════════
// GEAR RECOMMENDATIONS
// ══════════════════════════════════════════════════════
function getGearRecommendations(hourData, verdict) {
  if (!hourData) return [];
  const now  = new Date();
  const hour = now.getHours();
  const s    = state.settings;
  const temp = hourData.feelsLike ?? hourData.temp;
  const gear = [];

  // Temperature layering
  if (temp < 20)  gear.push({ emoji: '🧥', text: 'Heavy coat + thermal underlayer', type: 'normal' });
  else if (temp < 32) gear.push({ emoji: '🧥', text: 'Heavy coat, hat, and gloves', type: 'normal' });
  else if (temp < 45) gear.push({ emoji: '🧣', text: 'Winter coat and scarf', type: 'normal' });
  else if (temp < 55) gear.push({ emoji: '🧥', text: 'Light jacket or fleece', type: 'normal' });
  else if (temp < 65) gear.push({ emoji: '👕', text: 'Light layer on top', type: 'normal' });
  else if (temp < 80) gear.push({ emoji: '👕', text: 'T-shirt weather', type: 'normal' });
  else if (temp < 90) gear.push({ emoji: '😅', text: 'Light breathable clothing', type: 'normal' });
  else               gear.push({ emoji: '🥵', text: 'Minimal clothing — serious heat', type: 'alert' });

  // Footwear
  if (temp < 32 || hourData.precipChance > 30) {
    gear.push({ emoji: '👟', text: 'Waterproof or grippy shoes', type: 'normal' });
  }

  // Rain
  if (hourData.precipChance >= 20 && hourData.precipChance < s.precipThreshold) {
    gear.push({ emoji: '☂️', text: `Bring an umbrella (${hourData.precipChance}% chance)`, type: 'alert' });
  }

  // Wind
  if (hourData.windSpeed >= 15 && hourData.windSpeed < s.windThreshold) {
    gear.push({ emoji: '💨', text: `Windy — consider a windbreaker (${hourData.windSpeed} mph)`, type: 'alert' });
  }

  // Sunscreen: 10am–4pm
  if (s.sunscreenReminder && hour >= 10 && hour <= 16 && hourData.isDay) {
    gear.push({ emoji: '🧴', text: 'Apply sunscreen before heading out', type: 'safety' });
  }

  // Sunglasses: daytime + clear-ish
  if (s.sunglassesReminder && hourData.isDay && (hourData.code <= 3)) {
    gear.push({ emoji: '🕶️', text: 'Grab your sunglasses', type: 'safety' });
  }

  // Night visibility
  const sunInfo = state.weatherData?.sunInfo;
  const isNight = sunInfo
    ? (now < sunInfo.sunrise || now > sunInfo.sunset)
    : (!hourData.isDay);

  if (s.brightClothingReminder && isNight) {
    gear.push({ emoji: '🔆', text: 'Wear bright or reflective clothing — low visibility', type: 'safety' });
  }

  // Hydration in heat
  if (temp >= 80) {
    gear.push({ emoji: '💧', text: 'Bring water — stay hydrated', type: 'normal' });
  }

  return gear;
}

// ══════════════════════════════════════════════════════
// RENDER FUNCTIONS
// ══════════════════════════════════════════════════════
function renderAll() {
  if (!state.weatherData) return;

  const now        = new Date();
  const currentIdx = findCurrentHourIndex(state.weatherData.hourly, now);
  const current    = state.weatherData.hourly[currentIdx] || state.weatherData.hourly[0];

  renderHeader(current);
  renderConditions(current);
  renderGear(current);
  renderHourly(state.weatherData.hourly, currentIdx);
  renderDailySummary(state.weatherData.daily);
  renderWalkWindows();
}

// ── Header ───────────────────────────────────────────
function renderHeader(current) {
  const { verdict, reasons } = evaluateConditions(current);
  const header = $('verdict-header');

  header.className = `verdict-header state-${verdict}`;

  const labelMap  = { go: 'GO', warn: 'MARGINAL', nogo: 'NO GO', unknown: '—' };
  const iconMap   = { go: '✓', warn: '!', nogo: '✕', unknown: '?' };
  const subMap    = {
    go:      `Good conditions for ${state.settings.walkDuration} min`,
    warn:    reasons[0] || 'Conditions are borderline',
    nogo:    reasons[0] || 'Conditions not suitable for a walk',
    unknown: 'Loading conditions...'
  };

  $('verdict-label').textContent   = labelMap[verdict] || '—';
  $('verdict-icon').textContent    = iconMap[verdict]  || '?';
  $('verdict-sublabel').textContent = subMap[verdict]  || '';
}

// ── Current Conditions ───────────────────────────────
function renderConditions(current) {
  if (!current) return;
  const s = state.settings;

  $('current-temp').textContent = current.temp + '°';
  $('temp-unit-display').textContent = s.units === 'metric' ? '°C' : '°F';

  $('precip-chance').textContent = (current.precipChance ?? '--') + '%';
  $('wind-speed').textContent    = current.windSpeed + (s.units === 'metric' ? ' km/h' : ' mph');
  $('humidity').textContent      = current.humidity != null ? current.humidity + '%' : '--';
  $('sky-condition').textContent = weatherDesc(current.code);

  const fl = current.feelsLike ?? current.temp;
  $('feels-like').textContent = fl + (s.units === 'metric' ? '°C' : '°F');
}

// ── Gear ─────────────────────────────────────────────
function renderGear(current) {
  const { verdict } = evaluateConditions(current);
  const items = getGearRecommendations(current, verdict);
  const list  = $('gear-list');

  if (verdict === 'nogo') {
    list.innerHTML = `<div class="gear-item" style="border-color:var(--nogo);background:var(--nogo-dim);">
      <span class="gear-emoji">⛔</span>
      <span class="gear-text">Conditions are not suitable — consider skipping today</span>
    </div>`;
    return;
  }

  if (items.length === 0) {
    list.innerHTML = `<div class="gear-item"><span class="gear-emoji">👍</span><span class="gear-text">No special gear needed</span></div>`;
    return;
  }

  list.innerHTML = items.map(item => `
    <div class="gear-item${item.type === 'alert' ? ' gear-alert' : item.type === 'safety' ? ' gear-safety' : ''}">
      <span class="gear-emoji">${item.emoji}</span>
      <span class="gear-text">${item.text}</span>
    </div>
  `).join('');
}

// ── Hourly Slots ─────────────────────────────────────
function renderHourly(hourly, currentIdx) {
  const scroll = $('hourly-scroll');

  // Show current + next 11 hours = 12 slots
  const slots = hourly.slice(currentIdx, currentIdx + 12);
  const now   = new Date();

  scroll.innerHTML = slots.map((h, i) => {
    const { verdict } = evaluateConditions(h);
    const isNow = i === 0;

    const timeLabel = isNow ? 'Now' : formatHour(h.time);
    const emoji     = weatherEmoji(h.code, h.isDay);

    return `
      <div class="hourly-slot slot-${verdict}${isNow ? ' is-now' : ''}">
        <div class="slot-time">${timeLabel}</div>
        <div class="slot-emoji">${emoji}</div>
        <div class="slot-temp">${h.temp}°</div>
        <div class="slot-precip">💧${h.precipChance}%</div>
        <div class="slot-status-dot"></div>
      </div>
    `;
  }).join('');
}

// ── Daily Summary Bars ───────────────────────────────
function renderDailySummary(daily) {
  const container = $('daily-summary');
  if (!daily || daily.length === 0) { container.innerHTML = ''; return; }

  const allHighs = daily.map(d => d.high).filter(Boolean);
  const maxTemp  = Math.max(...allHighs);
  const minTemp  = Math.min(...daily.map(d => d.low).filter(n => n !== undefined));
  const range    = maxTemp - minTemp || 1;

  container.innerHTML = daily.slice(0, 3).map(d => {
    const dayLabel = isSameDay(d.date, new Date()) ? 'Today' : DAY_NAMES[d.date.getDay()];
    const barPct   = Math.max(10, ((d.high - minTemp) / range) * 100);

    return `
      <div class="daily-row">
        <div class="daily-day">${dayLabel}</div>
        <div class="daily-bar-track">
          <div class="daily-bar-fill" style="width:${barPct}%"></div>
        </div>
        <div class="daily-hi">${d.high}°</div>
      </div>
    `;
  }).join('');
}

// ── Walk Windows ─────────────────────────────────────
function renderWalkWindows() {
  const container = $('walk-windows');
  const schedules = state.settings.schedules;

  if (!schedules || schedules.length === 0) {
    container.innerHTML = `<div class="no-schedule">No schedules set — add them in Settings</div>`;
    return;
  }

  const today   = new Date().getDay(); // 0=Sun
  const todaySchedules = schedules.filter(s => s.days.includes(today));

  if (todaySchedules.length === 0) {
    container.innerHTML = `<div class="no-schedule">No walks scheduled for today</div>`;
    return;
  }

  container.innerHTML = todaySchedules.map(sched => {
    const [hh, mm]   = sched.time.split(':').map(Number);
    const walkDate   = new Date();
    walkDate.setHours(hh, mm, 0, 0);

    const hourData   = getHourlyForTime(walkDate);
    const { verdict } = evaluateConditions(hourData);
    const labelMap   = { go: 'GO', warn: 'MARGINAL', nogo: 'NO GO', unknown: '—' };
    const timeStr    = formatHour(walkDate);

    return `
      <div class="walk-window-item ww-${verdict}">
        <div class="ww-left">
          <div class="ww-time">${timeStr}</div>
          <div class="ww-label">${sched.label || 'Walk'} · ${state.settings.walkDuration} min</div>
        </div>
        <div class="ww-status">${labelMap[verdict] || '—'}</div>
      </div>
    `;
  }).join('');
}

// ── Source Dots ──────────────────────────────────────
function renderSourceDots(om, nws) {
  const container = $('source-dots');
  const sources   = ['Open-Meteo', 'NWS'];
  const avail     = [om, nws];

  container.innerHTML = sources.map((s, i) => {
    const cls = avail[i] ? 'source-dot active' : 'source-dot';
    return `<div class="${cls}" title="${s}"></div>`;
  }).join('');

  const count = avail.filter(Boolean).length;
  $('source-label').textContent = count === 2
    ? 'Averaged from 2 sources'
    : count === 1
      ? 'Single source (one unavailable)'
      : 'No sources';
}

// ══════════════════════════════════════════════════════
// SETTINGS UI
// ══════════════════════════════════════════════════════
function applySettingsToUI() {
  const s = state.settings;

  // Units toggle
  document.querySelectorAll('#units-toggle .toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.val === s.units);
  });

  // Duration
  updateDurationDisplay();

  // Sliders
  $('temp-min-slider').value  = s.units === 'metric' ? fToC(s.tempMin) : s.tempMin;
  $('temp-max-slider').value  = s.units === 'metric' ? fToC(s.tempMax) : s.tempMax;
  $('precip-slider').value    = s.precipThreshold;
  $('wind-slider').value      = s.units === 'metric' ? mphToKmh(s.windThreshold) : s.windThreshold;

  updateSliderDisplays();

  // Toggles
  $('sunscreen-toggle').checked       = s.sunscreenReminder;
  $('sunglasses-toggle').checked      = s.sunglassesReminder;
  $('bright-clothing-toggle').checked = s.brightClothingReminder;

  // Schedules
  renderSchedulesList();
}

function updateDurationDisplay() {
  const d = state.settings.walkDuration;
  $('duration-display').textContent = d < 60
    ? `${d} min`
    : d === 60
      ? '1 hr'
      : `${Math.floor(d/60)}h ${d%60>0 ? d%60+'m' : ''}`.trim();
}

function updateSliderDisplays() {
  const s    = state.settings;
  const isM  = s.units === 'metric';

  $('temp-min-display').textContent = isM
    ? `${fToC(s.tempMin)}°C`
    : `${s.tempMin}°F`;
  $('temp-max-display').textContent = isM
    ? `${fToC(s.tempMax)}°C`
    : `${s.tempMax}°F`;
  $('precip-display').textContent   = `${s.precipThreshold}%`;
  $('wind-display').textContent     = isM
    ? `${mphToKmh(s.windThreshold)} km/h`
    : `${s.windThreshold} mph`;
}

function renderSchedulesList() {
  const list = $('schedules-list');
  const schedules = state.settings.schedules;

  if (schedules.length === 0) {
    list.innerHTML = `<div style="font-size:12px;color:var(--text-muted);padding:4px 0">No schedules yet.</div>`;
    return;
  }

  list.innerHTML = schedules.map((s, i) => {
    const [hh, mm] = s.time.split(':').map(Number);
    const date     = new Date();
    date.setHours(hh, mm, 0, 0);
    const timeStr  = formatHour(date);
    const daysStr  = s.days.sort().map(d => DAY_SHORT[d]).join(' ');

    return `
      <div class="schedule-item">
        <div class="schedule-item-info">
          <div class="schedule-item-time">${timeStr}</div>
          <div class="schedule-item-days">${daysStr}</div>
        </div>
        <button class="schedule-delete" data-index="${i}" aria-label="Delete schedule">×</button>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.schedule-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      state.settings.schedules.splice(idx, 1);
      saveSettings();
      renderSchedulesList();
      renderWalkWindows();
    });
  });
}

// ══════════════════════════════════════════════════════
// EVENTS
// ══════════════════════════════════════════════════════
function bindEvents() {

  // Refresh
  $('refresh-btn').addEventListener('click', async () => {
    $('refresh-btn').classList.add('spinning');
    try {
      await fetchAndMergeWeather(state.coords);
      renderAll();
    } catch (err) {
      showError('Refresh failed: ' + err.message);
    } finally {
      $('refresh-btn').classList.remove('spinning');
    }
  });

  // Settings open/close
  $('settings-btn').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-overlay').addEventListener('click', closeSettings);

  // Units toggle
  document.querySelectorAll('#units-toggle .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.settings.units = btn.dataset.val;
      document.querySelectorAll('#units-toggle .toggle-btn').forEach(b => {
        b.classList.toggle('active', b === btn);
      });
      // Adjust stored thresholds if switching
      saveSettings();
      applySettingsToUI();
      renderAll();
    });
  });

  // Duration stepper
  $('duration-stepper').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const step = 15;
    if (btn.dataset.action === 'inc') {
      state.settings.walkDuration = Math.min(180, state.settings.walkDuration + step);
    } else {
      state.settings.walkDuration = Math.max(15, state.settings.walkDuration - step);
    }
    updateDurationDisplay();
    saveSettings();
    renderWalkWindows();
  });

  // Sliders
  $('temp-min-slider').addEventListener('input', e => {
    const val = parseInt(e.target.value);
    state.settings.tempMin = state.settings.units === 'metric' ? cToF(val) : val;
    updateSliderDisplays();
  });
  $('temp-min-slider').addEventListener('change', () => { saveSettings(); renderAll(); });

  $('temp-max-slider').addEventListener('input', e => {
    const val = parseInt(e.target.value);
    state.settings.tempMax = state.settings.units === 'metric' ? cToF(val) : val;
    updateSliderDisplays();
  });
  $('temp-max-slider').addEventListener('change', () => { saveSettings(); renderAll(); });

  $('precip-slider').addEventListener('input', e => {
    state.settings.precipThreshold = parseInt(e.target.value);
    updateSliderDisplays();
  });
  $('precip-slider').addEventListener('change', () => { saveSettings(); renderAll(); });

  $('wind-slider').addEventListener('input', e => {
    const val = parseInt(e.target.value);
    state.settings.windThreshold = state.settings.units === 'metric' ? kmhToMph(val) : val;
    updateSliderDisplays();
  });
  $('wind-slider').addEventListener('change', () => { saveSettings(); renderAll(); });

  // Safety toggles
  $('sunscreen-toggle').addEventListener('change', e => {
    state.settings.sunscreenReminder = e.target.checked;
    saveSettings(); renderAll();
  });
  $('sunglasses-toggle').addEventListener('change', e => {
    state.settings.sunglassesReminder = e.target.checked;
    saveSettings(); renderAll();
  });
  $('bright-clothing-toggle').addEventListener('change', e => {
    state.settings.brightClothingReminder = e.target.checked;
    saveSettings(); renderAll();
  });

  // Schedule modal
  $('add-schedule-btn').addEventListener('click', () => {
    state.editingScheduleIndex = null;
    $('modal-title').textContent = 'Add Walk Schedule';
    $('schedule-time').value     = '07:00';
    $('schedule-label').value    = '';
    // Reset day picker to weekdays
    document.querySelectorAll('.day-btn').forEach(btn => {
      const d = parseInt(btn.dataset.day);
      btn.classList.toggle('active', d >= 1 && d <= 5);
    });
    openModal();
  });

  document.querySelectorAll('.day-btn').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('active'));
  });

  $('modal-close').addEventListener('click', closeModal);
  $('modal-cancel').addEventListener('click', closeModal);
  $('schedule-modal-overlay').addEventListener('click', closeModal);

  $('modal-save').addEventListener('click', () => {
    const time  = $('schedule-time').value;
    const label = $('schedule-label').value.trim();
    const days  = [...document.querySelectorAll('.day-btn.active')]
      .map(b => parseInt(b.dataset.day));

    if (!time || days.length === 0) {
      showError('Please set a time and select at least one day');
      return;
    }

    const schedule = { time, label, days };

    if (state.editingScheduleIndex !== null) {
      state.settings.schedules[state.editingScheduleIndex] = schedule;
    } else {
      state.settings.schedules.push(schedule);
    }

    saveSettings();
    renderSchedulesList();
    renderWalkWindows();
    closeModal();
  });

  // Error dismiss
  $('error-dismiss').addEventListener('click', () => $('error-toast').classList.add('hidden'));
}

function openSettings() {
  $('settings-overlay').classList.remove('hidden');
  $('settings-drawer').classList.remove('hidden');
  requestAnimationFrame(() => $('settings-drawer').classList.add('open'));
}
function closeSettings() {
  $('settings-drawer').classList.remove('open');
  setTimeout(() => {
    $('settings-drawer').classList.add('hidden');
    $('settings-overlay').classList.add('hidden');
  }, 300);
}
function openModal() {
  $('schedule-modal-overlay').classList.remove('hidden');
  $('schedule-modal').classList.remove('hidden');
}
function closeModal() {
  $('schedule-modal').classList.add('hidden');
  $('schedule-modal-overlay').classList.add('hidden');
}

// ══════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════
function showLoading(show) {
  if (show) {
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
  setTimeout(() => $('error-toast').classList.add('hidden'), 6000);
}

function findCurrentHourIndex(hourly, now) {
  // Find the closest hour index to now
  let best = 0;
  let bestDiff = Infinity;
  hourly.forEach((h, i) => {
    const diff = Math.abs(h.time - now);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  });
  return best;
}

function getHourlyForTime(targetDate) {
  if (!state.weatherData?.hourly) return null;
  return state.weatherData.hourly.reduce((best, h) => {
    const diff     = Math.abs(h.time - targetDate);
    const bestDiff = best ? Math.abs(best.time - targetDate) : Infinity;
    return diff < bestDiff ? h : best;
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

// Unit conversions
function fToC(f)        { return Math.round((f - 32) * 5/9); }
function cToF(c)        { return Math.round(c * 9/5 + 32); }
function mphToKmh(mph)  { return Math.round(mph * 1.60934); }
function kmhToMph(kmh)  { return Math.round(kmh / 1.60934); }
