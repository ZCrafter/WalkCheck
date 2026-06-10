# WalkCheck

A dark-mode walk advisory dashboard for iPad (landscape). Shows a Go/No-Go signal for your morning walks based on real-time weather from two free sources (Open-Meteo + NWS).

## Setup on TrueNAS Scale

### 1. Copy files to your TrueNAS server

Place the entire `walkcheck/` folder somewhere on your TrueNAS dataset, e.g.:

```
/mnt/pool/apps/walkcheck/
```

The folder should look like:
```
walkcheck/
├── docker-compose.yml
├── nginx.conf
└── app/
    ├── index.html
    ├── css/
    │   └── styles.css
    └── js/
        └── app.js
```

### 2. Start the container

```bash
cd /mnt/pool/apps/walkcheck
docker compose up -d
```

### 3. Access the app

Open Safari on your iPad and navigate to:

```
http://<your-truenas-ip>:8765
```

Add it to your home screen: Share → Add to Home Screen for a fullscreen experience.

### 4. Port (optional)

The default port is **8765**. To change it, edit `docker-compose.yml`:

```yaml
ports:
  - "YOUR_PORT:80"
```

---

## Weather Sources

| Source | Notes |
|--------|-------|
| **Open-Meteo** | Free, no API key, global coverage. Primary source. |
| **NWS (National Weather Service)** | Free, US-only, no API key. Secondary source. |

When both sources are available, temperature and precipitation are averaged. The source indicator dots in the current conditions card show which sources responded.

---

## Features

- **Go / Marginal / No Go** verdict — the header turns green, amber, or red at a glance
- **Clothing recommendations** based on feels-like temperature
- **Safety reminders**: sunscreen (10am–4pm), sunglasses (sunny days), bright clothing at night
- **12-hour hourly forecast** with per-slot Go/No-Go coloring
- **Walk schedules** — set your usual walk times to see a targeted verdict
- **Settings**: units (imperial/metric toggle), walk duration, temperature/precip/wind thresholds

---

## Updating

Just replace files in `app/` and hard-refresh Safari (`⌘ + Shift + R` or clear cache).

No container restart needed for static file changes — nginx serves from the mounted directory.
