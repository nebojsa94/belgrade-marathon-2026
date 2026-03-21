#!/usr/bin/env node

/**
 * Strava Sync — Pull latest runs and update the dashboard
 * Usage: node scripts/strava-sync.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'strava-config.json');
const TOKENS_PATH = path.join(__dirname, '..', 'data', 'strava-tokens.json');
const RUNS_PATH = path.join(__dirname, '..', 'data', 'runs.json');
const HTML_PATH = path.join(__dirname, '..', 'index.html');

// Training plan start date
const PLAN_START = new Date('2026-03-14');
const RACE_DATE = new Date('2026-04-19');

// Week boundaries
const WEEKS = [
  { num: 1, start: '2026-03-14', end: '2026-03-20', targetKm: 18, longRun: '—' },
  { num: 2, start: '2026-03-21', end: '2026-03-27', targetKm: 33, longRun: '14km' },
  { num: 3, start: '2026-03-28', end: '2026-04-03', targetKm: 40, longRun: '21km' },
  { num: 4, start: '2026-04-04', end: '2026-04-10', targetKm: 41, longRun: '28–30km' },
  { num: 5, start: '2026-04-11', end: '2026-04-19', targetKm: 20, longRun: 'RACE' },
];

function getWeekNum(dateStr) {
  const d = new Date(dateStr);
  for (const w of WEEKS) {
    if (d >= new Date(w.start) && d <= new Date(w.end + 'T23:59:59')) return w.num;
  }
  return 0;
}

function httpsRequest(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(JSON.parse(data));
        else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function refreshToken(config, tokens) {
  const now = Math.floor(Date.now() / 1000);
  if (tokens.expires_at > now + 300) return tokens;

  console.log('Refreshing access token...');
  const postData = JSON.stringify({
    client_id: config.client_id,
    client_secret: config.client_secret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  });

  const result = await httpsRequest({
    hostname: 'www.strava.com',
    path: '/oauth/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    body: postData,
  });

  tokens.access_token = result.access_token;
  tokens.refresh_token = result.refresh_token;
  tokens.expires_at = result.expires_at;
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
  console.log('Token refreshed.');
  return tokens;
}

async function getActivities(accessToken, after) {
  const afterEpoch = Math.floor(after.getTime() / 1000);
  const result = await httpsRequest({
    hostname: 'www.strava.com',
    path: `/api/v3/athlete/activities?after=${afterEpoch}&per_page=100`,
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return result;
}

function formatPace(metersPerSec) {
  if (!metersPerSec || metersPerSec === 0) return '—';
  const secPerKm = 1000 / metersPerSec;
  const min = Math.floor(secPerKm / 60);
  const sec = Math.round(secPerKm % 60);
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function updateHTML(runs) {
  let html = fs.readFileSync(HTML_PATH, 'utf8');

  // Build JS runs array
  const runsJS = runs.map(r => {
    return `    { date: '${r.date}', distance: ${r.distance}, time: '${r.time}', pace: '${r.pace}', hr: ${r.hr || 0}, notes: '${(r.notes || '').replace(/'/g, "\\'")}', week: ${r.week} }`;
  }).join(',\n');

  // Determine week statuses
  const weekStatuses = WEEKS.map(w => {
    const weekRuns = runs.filter(r => r.week === w.num);
    const totalKm = weekRuns.reduce((sum, r) => sum + r.distance, 0);
    const now = new Date();
    const start = new Date(w.start);
    const end = new Date(w.end + 'T23:59:59');

    let status;
    if (now > end) status = 'done';
    else if (now >= start && now <= end) status = 'current';
    else status = 'todo';

    return `    { num: ${w.num}, dates: '${w.start.slice(5)} – ${w.end.slice(5)}', targetKm: ${w.targetKm}, actualKm: ${totalKm.toFixed(1)}, longRun: '${w.longRun}', status: '${status}', runs: [] }`;
  }).join(',\n');

  // Replace the runs array in HTML
  html = html.replace(
    /const runs = \[[\s\S]*?\];/,
    `const runs = [\n${runsJS}\n  ];`
  );

  // Replace week statuses
  html = html.replace(
    /const weeks = \[[\s\S]*?\];/,
    `const weeks = [\n${weekStatuses}\n  ];`
  );

  fs.writeFileSync(HTML_PATH, html);
  console.log('Dashboard updated.');
}

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('Missing strava-config.json. Run strava-auth.js first.');
    process.exit(1);
  }
  if (!fs.existsSync(TOKENS_PATH)) {
    console.error('Missing strava-tokens.json. Run strava-auth.js first.');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  let tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));

  // Refresh token if needed
  tokens = await refreshToken(config, tokens);

  // Pull activities since plan start
  console.log('Fetching activities from Strava...');
  const activities = await getActivities(tokens.access_token, PLAN_START);

  // Filter to runs only
  const runActivities = activities.filter(a => a.type === 'Run');
  console.log(`Found ${runActivities.length} runs since ${PLAN_START.toISOString().slice(0, 10)}.`);

  // Convert to our format
  const runs = runActivities.map(a => {
    const date = a.start_date_local.slice(0, 10);
    return {
      date,
      distance: parseFloat((a.distance / 1000).toFixed(2)),
      time: formatTime(a.moving_time),
      pace: formatPace(a.average_speed),
      hr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
      notes: a.name || '',
      week: getWeekNum(date),
    };
  }).sort((a, b) => a.date.localeCompare(b.date));

  // Save runs data
  const runsData = JSON.parse(fs.readFileSync(RUNS_PATH, 'utf8'));
  runsData.runs = runs;

  // Calculate weekly summaries
  runsData.weekly_summary = WEEKS.map(w => {
    const weekRuns = runs.filter(r => r.week === w.num);
    return {
      week: w.num,
      dates: `${w.start} to ${w.end}`,
      target_km: w.targetKm,
      actual_km: parseFloat(weekRuns.reduce((sum, r) => sum + r.distance, 0).toFixed(2)),
      num_runs: weekRuns.length,
      long_run_target: w.longRun,
    };
  });

  fs.writeFileSync(RUNS_PATH, JSON.stringify(runsData, null, 2));
  console.log('Runs data saved.');

  // Update HTML dashboard
  updateHTML(runs);

  // Summary
  const totalKm = runs.reduce((sum, r) => sum + r.distance, 0);
  console.log(`\n--- Summary ---`);
  console.log(`Total runs: ${runs.length}`);
  console.log(`Total distance: ${totalKm.toFixed(1)} km`);
  runs.forEach(r => {
    console.log(`  ${r.date} | ${r.distance}km | ${r.time} | ${r.pace}/km | ${r.hr || '—'}bpm | ${r.notes}`);
  });
  console.log(`\nDashboard updated! Commit and push to go live.`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
