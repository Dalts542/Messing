'use strict';
const https = require('https');
const db = require('./db');

const RACING_USER = process.env.RACING_USER || '';
const RACING_PASS = process.env.RACING_PASS || '';
const PROXY_TIMEOUT = 20000;

let refreshTimer = null;
let lastRefresh = null;
let refreshing = false;

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname, port: 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'PaddockIntelligence/2.0', ...headers }
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); }
          catch { resolve(body); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(PROXY_TIMEOUT, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function authHeader() {
  if (!RACING_USER || !RACING_PASS) return {};
  return { 'Authorization': 'Basic ' + Buffer.from(RACING_USER + ':' + RACING_PASS).toString('base64') };
}

async function fetchRacingAPI(endpoint) {
  const url = 'https://api.theracingapi.com' + endpoint;
  return httpsGet(url, authHeader());
}

function normalizeRace(raw) {
  return {
    course: raw.course || raw.racecourse || '',
    date: raw.date || db.today(),
    off_time: raw.off_time || raw.time || raw.off || '',
    race_name: raw.race_name || raw.name || '',
    distance: raw.distance || raw.dist || '',
    going: raw.going || '',
    race_class: raw.race_class || raw.class || '',
    race_type: raw.race_type || raw.type || '',
    prize: raw.prize || raw.prize_money || '',
    field_size: raw.field_size || (raw.runners || []).length,
    runners: (raw.runners || []).map(normalizeRunner),
    source: 'racing-api'
  };
}

function normalizeRunner(raw) {
  return {
    horse: raw.horse || raw.name || raw.horse_name || '?',
    number: parseInt(raw.number || raw.cloth || raw.saddlecloth) || null,
    draw: parseInt(raw.draw || raw.stall) || null,
    age: raw.age || null,
    sex: raw.sex || raw.sex_code || null,
    jockey: raw.jockey || raw.jockey_name || null,
    trainer: raw.trainer || raw.trainer_name || null,
    form: raw.form || raw.recent_form || null,
    weight: raw.weight || raw.wgt || null,
    lbs: parseInt(raw.lbs || raw.weight_lbs) || null,
    official_rating: parseInt(raw.official_rating || raw.or || raw.rating) || null,
    odds: raw.odds || raw.sp || raw.starting_price || null,
    is_non_runner: raw.is_non_runner || raw.non_runner || false,
    headgear: raw.headgear || null,
    comment: raw.comment || raw.spotlight || null,
    days_since_run: parseInt(raw.days_since_run || raw.last_run) || null,
    source: 'racing-api'
  };
}

async function fetchTodaysRaces() {
  const endpoints = [
    '/v1/racecards?day=today',
    '/v1/racecards/free?day=today',
    '/v1/races?day=today',
    '/v1/racecards/search?day=today'
  ];
  for (const ep of endpoints) {
    try {
      const data = await fetchRacingAPI(ep);
      let races = [];
      if (data.racecards && data.racecards.length) races = data.racecards;
      else if (Array.isArray(data) && data.length) races = data;
      if (races.length) return { races, endpoint: ep };
    } catch (e) {
      console.log(`  [sources] ${ep}: ${e.message}`);
    }
  }
  return { races: [], endpoint: null };
}

async function fetchResults() {
  try {
    const data = await fetchRacingAPI('/v1/results?day=today');
    let results = [];
    if (data.results && data.results.length) results = data.results;
    else if (Array.isArray(data) && data.length) results = data;
    return results;
  } catch (e) {
    console.log(`  [sources] results: ${e.message}`);
    return [];
  }
}

async function ingestTodaysData() {
  if (refreshing) return { ok: false, reason: 'already refreshing' };
  refreshing = true;
  const t0 = Date.now();
  console.log('  [sources] Refreshing racing data...');

  let raceCount = 0;
  let meetingCount = 0;
  let runnerCount = 0;
  let errorMsg = null;

  try {
    const { races, endpoint } = await fetchTodaysRaces();
    if (!races.length) {
      errorMsg = 'No races returned from Racing API';
      db.updateSourceStatus('racing-api', {
        healthy: false, last_error: new Date().toISOString(),
        last_error_msg: errorMsg, cost: 'Free',
        url: 'api.theracingapi.com',
        description: 'UK/IRE racecards, runners, results',
        rate_limit: '100 req/day (free tier)',
        refresh_seconds: 300
      });
      return { ok: false, reason: errorMsg };
    }

    const normalized = races.map(normalizeRace);
    const meetingMap = {};
    for (const race of normalized) {
      const courseKey = race.course;
      if (!meetingMap[courseKey]) {
        meetingMap[courseKey] = {
          course: courseKey,
          country: courseKey.match(/Curragh|Dundalk|Fairyhouse|Galway|Killarney|Leopardstown|Limerick|Listowel|Navan|Punchestown|Tipperary|Tramore|Wexford|Cork|Down Royal|Downpatrick|Ballinrobe|Bellewstown|Clonmel|Gowran|Kilbeggan|Laytown|Naas|Roscommon|Sligo|Thurles/) ? 'IRE' : 'GB',
          date: race.date,
          going: race.going || null,
          source: 'racing-api'
        };
      }
      if (race.going && !meetingMap[courseKey].going) {
        meetingMap[courseKey].going = race.going;
      }
    }

    for (const m of Object.values(meetingMap)) {
      db.upsertMeeting(m);
      meetingCount++;
    }

    for (const race of normalized) {
      const meetingId = db.hash(race.date + '_' + race.course).slice(0, 16);
      const mid = (race.date || db.today()) + '_' + race.course.toLowerCase().replace(/[^a-z0-9]/g, '_');
      db.upsertRace(race, mid);
      raceCount++;
      runnerCount += race.runners.length;
    }

    lastRefresh = new Date().toISOString();
    db.updateSourceStatus('racing-api', {
      healthy: true, last_success: lastRefresh,
      record_count: raceCount,
      cost: 'Free', url: 'api.theracingapi.com',
      description: 'UK/IRE racecards, runners, going, form',
      rate_limit: '100 req/day (free tier)',
      refresh_seconds: 300
    });
    const elapsed = Date.now() - t0;
    console.log(`  [sources] Done: ${meetingCount} meetings, ${raceCount} races, ${runnerCount} runners (${elapsed}ms)`);
    return { ok: true, meetings: meetingCount, races: raceCount, runners: runnerCount };

  } catch (e) {
    errorMsg = e.message;
    db.updateSourceStatus('racing-api', {
      healthy: false, last_error: new Date().toISOString(),
      last_error_msg: errorMsg, cost: 'Free',
      url: 'api.theracingapi.com',
      description: 'UK/IRE racecards, runners, going, form',
      rate_limit: '100 req/day (free tier)',
      refresh_seconds: 300
    });
    console.log(`  [sources] Error: ${errorMsg}`);
    return { ok: false, reason: errorMsg };
  } finally {
    refreshing = false;
  }
}

function startBackgroundRefresh(intervalMs = 300000) {
  if (refreshTimer) clearInterval(refreshTimer);
  ingestTodaysData();
  refreshTimer = setInterval(ingestTodaysData, intervalMs);
  console.log(`  [sources] Background refresh every ${intervalMs / 1000}s`);
}

function stopBackgroundRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

function getRefreshStatus() {
  return { last_refresh: lastRefresh, refreshing, configured: !!(RACING_USER && RACING_PASS) };
}

module.exports = {
  ingestTodaysData, fetchResults, startBackgroundRefresh,
  stopBackgroundRefresh, getRefreshStatus, httpsGet
};
