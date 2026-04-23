require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const https   = require('https');
const { fetchFreshToken } = require('./auto-token');

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  next();
});
app.use(express.static('public'));

// ── Konfig ─────────────────────────────────────────────────────────────────
const BASE_URL  = 'https://bot.eu.gausium-robot.com';
const ROBOTS    = ['GS40D-6290-TCR-4000', 'GS438-6160-H1R-2000', 'GS401-6210-29R-C000'];
const FROM_DATE = '2026-01-10';
const TO_DATE   = '2026-04-07';

const ROBOT_NAMES = {
  'GS40D-6290-TCR-4000': 'Robot A',
  'GS438-6160-H1R-2000': 'Robot B',
  'GS401-6210-29R-C000': 'Robot C',
};

let currentToken  = process.env.GS_TOKEN || '';
const GS_USERNAME = process.env.GS_USERNAME;
const GS_PASSWORD = process.env.GS_PASSWORD;
let tokenRefreshing = false;

// ── Token ──────────────────────────────────────────────────────────────────
function tokenExpiresInMs() {
  if (!currentToken) return 0;
  try {
    const payload = JSON.parse(Buffer.from(currentToken.split('.')[1], 'base64url').toString());
    return (payload.exp * 1000) - Date.now();
  } catch { return 0; }
}

async function refreshToken() {
  if (tokenRefreshing) return;
  if (!GS_USERNAME || !GS_PASSWORD) return;
  tokenRefreshing = true;
  try {
    currentToken = await fetchFreshToken(GS_USERNAME, GS_PASSWORD);
    cache = { data: null, fetchedAt: 0 };
    console.log('[token] ✓ Fornyet');
  } catch (err) {
    console.error('[token] Feil:', err.message);
  } finally {
    tokenRefreshing = false;
  }
}

setInterval(async () => {
  if (tokenExpiresInMs() < 2 * 60 * 60 * 1000) await refreshToken();
}, 30 * 60 * 1000);

// ── HTTP-hjelper ───────────────────────────────────────────────────────────
function gsGet(path) {
  return new Promise((resolve, reject) => {
    const url  = new URL(BASE_URL + path);
    const opts = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'GET',
      headers: {
        'authorization': `Bearer ${currentToken}`,
        'origin':        'https://service-us.gs-robot.com',
        'gs-user-agent': 'CloudTBPR; os=Server; browser=Node; locale=en-US',
        'accept':        'application/json',
      },
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('TOKEN_EXPIRED'));
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Ugyldig JSON')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Cache ──────────────────────────────────────────────────────────────────
let cache = { data: null, fetchedAt: 0 };
const CACHE_TTL = 30 * 60 * 1000; // 30 min (statisk periode)

// ── Statistikk-hjelper ─────────────────────────────────────────────────────
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - avg) ** 2, 0) / arr.length);
}

// ── Bygg rapport ───────────────────────────────────────────────────────────
async function buildReport() {
  const results = await Promise.all(ROBOTS.map(async sn => {
    const [allTime, period] = await Promise.all([
      gsGet(`/robot-task/robot/details/${sn}`),
      gsGet(`/robot-task/robot/details/statistics/${sn}?fromDate=${FROM_DATE}&toDate=${TO_DATE}`),
    ]);
    return { sn, allTime: allTime.data, period: period.data };
  }));

  // Per-robot stats
  const perRobot = results.map(r => {
    const m = r.period?.monitoringData || {};
    const days = r.period?.statisticsData || [];
    const activeDays = days.filter(d => (d.coverageArea || 0) > 0);
    const areaDays   = activeDays.map(d => d.coverageArea || 0);
    const durDays    = activeDays.map(d => (d.duration    || 0) / 3600);

    const totalArea  = m.totalCoverageArea || 0;
    const totalHours = (m.totalDuration   || 0) / 3600;
    const totalKm    = (m.totalMileage    || 0) / 1000;
    const totalWater = m.totalWaterUsage  || 0;

    return {
      sn,
      name:              ROBOT_NAMES[sn] || sn,
      totalAreaM2:       Math.round(totalArea),
      totalHours:        Math.round(totalHours * 10) / 10,
      totalKm:           Math.round(totalKm * 10) / 10,
      totalWaterL:       Math.round(totalWater * 10) / 10,
      activeDays:        activeDays.length,
      avgAreaPerDay:     activeDays.length ? Math.round(totalArea / activeDays.length) : 0,
      medianAreaPerDay:  Math.round(median(areaDays)),
      stddevAreaPerDay:  Math.round(stddev(areaDays)),
      effM2PerHour:      totalHours > 0 ? Math.round(totalArea / totalHours) : 0,
      avgWaterPerM2:     totalArea > 0  ? Math.round((totalWater / totalArea) * 1000) / 1000 : 0,
      allTimeHours:      Math.round((r.allTime?.totalDuration || 0) / 3600 * 10) / 10,
      allTimeKm:         Math.round((r.allTime?.totalMileage  || 0) / 1000 * 10) / 10,
      dailyData: days.map(d => ({
        date:        d.statDay,
        areaM2:      Math.round(d.coverageArea || 0),
        durationMin: Math.round((d.duration    || 0) / 60),
      })).sort((a, b) => a.date.localeCompare(b.date)),
    };
  });

  // Samlet på tvers
  const allAreas  = perRobot.map(r => r.totalAreaM2);
  const allHours  = perRobot.map(r => r.totalHours);
  const allEff    = perRobot.map(r => r.effM2PerHour);
  const allWpM2   = perRobot.filter(r => r.avgWaterPerM2 > 0).map(r => r.avgWaterPerM2);

  return {
    updatedAt:   new Date().toISOString(),
    period:      { from: FROM_DATE, to: TO_DATE },
    robots:      ROBOTS.length,

    aggregate: {
      totalAreaM2:        perRobot.reduce((s, r) => s + r.totalAreaM2, 0),
      totalHours:         Math.round(perRobot.reduce((s, r) => s + r.totalHours, 0) * 10) / 10,
      totalKm:            Math.round(perRobot.reduce((s, r) => s + r.totalKm, 0) * 10) / 10,
      totalWaterL:        Math.round(perRobot.reduce((s, r) => s + r.totalWaterL, 0) * 10) / 10,
      medianEffM2PerHour: Math.round(median(allEff)),
      avgEffM2PerHour:    Math.round(allEff.reduce((s, v) => s + v, 0) / allEff.length),
      avgWaterPerM2:      allWpM2.length ? Math.round(allWpM2.reduce((s, v) => s + v, 0) / allWpM2.length * 1000) / 1000 : 0,
      medianDailyArea:    Math.round(median(perRobot.flatMap(r => r.dailyData.filter(d => d.areaM2 > 0).map(d => d.areaM2)))),
    },

    perRobot,
  };
}

// ── Endepunkter ────────────────────────────────────────────────────────────
app.get('/api/report', async (req, res) => {
  if (!currentToken)
    return res.status(401).json({ ok: false, error: 'TOKEN_MISSING' });
  try {
    if (tokenExpiresInMs() < 60000) await refreshToken();
    const force = req.query.refresh === '1';
    if (!force && cache.data && Date.now() - cache.fetchedAt < CACHE_TTL)
      return res.json({ ok: true, cached: true, ...cache.data });
    cache.data      = await buildReport();
    cache.fetchedAt = Date.now();
    res.json({ ok: true, cached: false, ...cache.data });
  } catch (err) {
    if (err.message === 'TOKEN_EXPIRED')
      return res.status(401).json({ ok: false, error: 'TOKEN_EXPIRED' });
    console.error(err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/token', (req, res) => {
  const { token } = req.body;
  if (!token || token.length < 20) return res.status(400).json({ ok: false });
  currentToken = token.trim();
  cache = { data: null, fetchedAt: 0 };
  res.json({ ok: true });
});

app.get('/health', (_, res) => res.json({ ok: true }));

// Keep-alive
setInterval(() => {
  https.get('https://gausium-report-production.up.railway.app/health', r => r.resume()).on('error', () => {});
}, 4 * 60 * 1000);

app.listen(PORT, async () => {
  console.log(`✓ Gausium Report kjører på http://localhost:${PORT}`);
  if (!currentToken && GS_USERNAME && GS_PASSWORD) await refreshToken();
});
