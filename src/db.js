'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'racing.db');

let db;
function initDb() {
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY, course TEXT NOT NULL, country TEXT DEFAULT 'GB',
      date TEXT NOT NULL, going TEXT, meeting_type TEXT,
      source TEXT, fetched_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS races (
      id TEXT PRIMARY KEY, meeting_id TEXT, course TEXT NOT NULL,
      date TEXT NOT NULL, off_time TEXT, race_name TEXT, distance TEXT,
      going TEXT, race_class TEXT, race_type TEXT, prize TEXT,
      num_runners INTEGER DEFAULT 0, field_size INTEGER DEFAULT 0,
      source TEXT, fetched_at TEXT DEFAULT (datetime('now')),
      ai_summary TEXT, ai_summary_hash TEXT,
      FOREIGN KEY (meeting_id) REFERENCES meetings(id)
    );
    CREATE TABLE IF NOT EXISTS runners (
      id TEXT PRIMARY KEY, race_id TEXT NOT NULL, number INTEGER,
      draw INTEGER, horse TEXT NOT NULL, age TEXT, sex TEXT,
      jockey TEXT, trainer TEXT, form TEXT, weight TEXT,
      lbs INTEGER, official_rating INTEGER, odds TEXT,
      is_non_runner INTEGER DEFAULT 0, headgear TEXT, comment TEXT,
      days_since_run INTEGER, source TEXT,
      fetched_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (race_id) REFERENCES races(id)
    );
    CREATE TABLE IF NOT EXISTS results (
      id TEXT PRIMARY KEY, race_id TEXT, date TEXT, course TEXT,
      off_time TEXT, race_name TEXT, distance TEXT, going TEXT,
      race_class TEXT, positions TEXT, source TEXT,
      fetched_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ai_cache (
      cache_key TEXT PRIMARY KEY, data_hash TEXT,
      content TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS source_log (
      name TEXT PRIMARY KEY, healthy INTEGER DEFAULT 1,
      last_success TEXT, last_error TEXT, last_error_msg TEXT,
      record_count INTEGER DEFAULT 0, cost TEXT DEFAULT 'Free',
      url TEXT, description TEXT, rate_limit TEXT,
      refresh_seconds INTEGER DEFAULT 300
    );
    CREATE INDEX IF NOT EXISTS idx_races_date ON races(date);
    CREATE INDEX IF NOT EXISTS idx_races_course ON races(course);
    CREATE INDEX IF NOT EXISTS idx_runners_race ON runners(race_id);
    CREATE INDEX IF NOT EXISTS idx_runners_horse ON runners(horse COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_runners_trainer ON runners(trainer COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_runners_jockey ON runners(jockey COLLATE NOCASE);
  `);
  return db;
}

function makeId(...parts) {
  return parts.map(p => String(p || '').toLowerCase().replace(/[^a-z0-9]/g, '_')).join('_');
}
function hash(data) {
  return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

function upsertMeeting(m) {
  const id = m.id || makeId(m.date || today(), m.course);
  db.prepare(`INSERT OR REPLACE INTO meetings(id,course,country,date,going,meeting_type,source,fetched_at)
    VALUES(?,?,?,?,?,?,?,datetime('now'))`).run(
    id, m.course, m.country || 'GB', m.date || today(),
    m.going || null, m.meeting_type || null, m.source || 'racing-api'
  );
  return id;
}

function upsertRace(r, meetingId) {
  const id = r.id || makeId(r.date || today(), r.course, r.off_time);
  const runners = r.runners || [];
  db.prepare(`INSERT OR REPLACE INTO races(id,meeting_id,course,date,off_time,race_name,
    distance,going,race_class,race_type,prize,num_runners,field_size,source,fetched_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`).run(
    id, meetingId, r.course, r.date || today(), r.off_time || null,
    r.race_name || null, r.distance || null, r.going || null,
    r.race_class || null, r.race_type || null, r.prize || null,
    runners.length, r.field_size || runners.length,
    r.source || 'racing-api'
  );
  if (runners.length) upsertRunners(id, runners, r.source);
  return id;
}

function upsertRunners(raceId, runners, source) {
  db.prepare('DELETE FROM runners WHERE race_id = ?').run(raceId);
  const ins = db.prepare(`INSERT INTO runners(id,race_id,number,draw,horse,age,sex,
    jockey,trainer,form,weight,lbs,official_rating,odds,is_non_runner,
    headgear,comment,days_since_run,source,fetched_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`);
  for (const h of runners) {
    ins.run(
      makeId(raceId, h.horse || h.name), raceId,
      h.number || null, h.draw || null,
      h.horse || h.name || '?', h.age || null, h.sex || null,
      h.jockey || null, h.trainer || null, h.form || null,
      h.weight || null, h.lbs || null,
      h.official_rating || h.or || null, h.odds || null,
      h.is_non_runner ? 1 : 0, h.headgear || null,
      h.comment || null, h.days_since_run || null,
      source || 'racing-api'
    );
  }
}

function getTodaysMeetings() {
  const d = today();
  const meetings = db.prepare(
    `SELECT m.*, COUNT(r.id) as race_count,
     MIN(r.off_time) as first_race, MAX(r.off_time) as last_race,
     SUM(r.num_runners) as total_runners
     FROM meetings m LEFT JOIN races r ON r.meeting_id = m.id
     WHERE m.date = ? GROUP BY m.id ORDER BY m.course`
  ).all(d);
  return meetings;
}

function getTodaysRaces() {
  return db.prepare(
    'SELECT * FROM races WHERE date = ? ORDER BY course, off_time'
  ).all(today());
}

function getMeetingRaces(meetingId) {
  return db.prepare(
    'SELECT * FROM races WHERE meeting_id = ? ORDER BY off_time'
  ).all(meetingId);
}

function getRace(raceId) {
  return db.prepare('SELECT * FROM races WHERE id = ?').get(raceId);
}

function getRaceRunners(raceId) {
  return db.prepare(
    'SELECT * FROM runners WHERE race_id = ? ORDER BY number, horse'
  ).all(raceId);
}

function searchAll(query) {
  const q = '%' + query + '%';
  const horses = db.prepare(
    `SELECT DISTINCT horse, trainer, jockey, race_id FROM runners
     WHERE horse LIKE ? COLLATE NOCASE LIMIT 20`
  ).all(q);
  const trainers = db.prepare(
    `SELECT DISTINCT trainer, COUNT(*) as cnt FROM runners
     WHERE trainer LIKE ? COLLATE NOCASE GROUP BY trainer LIMIT 10`
  ).all(q);
  const jockeys = db.prepare(
    `SELECT DISTINCT jockey, COUNT(*) as cnt FROM runners
     WHERE jockey LIKE ? COLLATE NOCASE GROUP BY jockey LIMIT 10`
  ).all(q);
  const courses = db.prepare(
    `SELECT DISTINCT course, COUNT(*) as cnt FROM races
     WHERE course LIKE ? COLLATE NOCASE GROUP BY course LIMIT 10`
  ).all(q);
  return { horses, trainers, jockeys, courses };
}

function getHorseHistory(name) {
  return db.prepare(
    `SELECT r.horse, r.form, r.jockey, r.trainer, r.official_rating, r.odds,
     ra.course, ra.date, ra.off_time, ra.race_name, ra.distance, ra.going, ra.race_class
     FROM runners r JOIN races ra ON r.race_id = ra.id
     WHERE r.horse LIKE ? COLLATE NOCASE ORDER BY ra.date DESC, ra.off_time DESC LIMIT 50`
  ).all('%' + name + '%');
}

function getTrainerStats(name) {
  const runners = db.prepare(
    `SELECT r.*, ra.course, ra.date, ra.going, ra.race_class, ra.distance
     FROM runners r JOIN races ra ON r.race_id = ra.id
     WHERE r.trainer LIKE ? COLLATE NOCASE ORDER BY ra.date DESC LIMIT 100`
  ).all('%' + name + '%');
  return { trainer: name, total_runners: runners.length, runners };
}

function getJockeyStats(name) {
  const runners = db.prepare(
    `SELECT r.*, ra.course, ra.date, ra.going, ra.race_class, ra.distance
     FROM runners r JOIN races ra ON r.race_id = ra.id
     WHERE r.jockey LIKE ? COLLATE NOCASE ORDER BY ra.date DESC LIMIT 100`
  ).all('%' + name + '%');
  return { jockey: name, total_runners: runners.length, runners };
}

function getAiCache(key) {
  return db.prepare('SELECT * FROM ai_cache WHERE cache_key = ?').get(key);
}
function setAiCache(key, dataHash, content) {
  db.prepare(`INSERT OR REPLACE INTO ai_cache(cache_key,data_hash,content,created_at)
    VALUES(?,?,?,datetime('now'))`).run(key, dataHash, content);
}

function updateSourceStatus(name, status) {
  db.prepare(`INSERT OR REPLACE INTO source_log(name,healthy,last_success,last_error,
    last_error_msg,record_count,cost,url,description,rate_limit,refresh_seconds)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    name, status.healthy ? 1 : 0,
    status.last_success || null, status.last_error || null,
    status.last_error_msg || null, status.record_count || 0,
    status.cost || 'Free', status.url || null,
    status.description || null, status.rate_limit || null,
    status.refresh_seconds || 300
  );
}
function getSourceStatus() {
  return db.prepare('SELECT * FROM source_log ORDER BY name').all();
}

function getDbStats() {
  const meetings = db.prepare('SELECT COUNT(*) as c FROM meetings WHERE date = ?').get(today());
  const races = db.prepare('SELECT COUNT(*) as c FROM races WHERE date = ?').get(today());
  const runners = db.prepare('SELECT COUNT(*) as c FROM runners r JOIN races ra ON r.race_id = ra.id WHERE ra.date = ?').get(today());
  const nonRunners = db.prepare('SELECT COUNT(*) as c FROM runners r JOIN races ra ON r.race_id = ra.id WHERE ra.date = ? AND r.is_non_runner = 1').get(today());
  const totalRecords = db.prepare('SELECT (SELECT COUNT(*) FROM meetings) + (SELECT COUNT(*) FROM races) + (SELECT COUNT(*) FROM runners) as c').get();
  return {
    today_meetings: meetings.c, today_races: races.c,
    today_runners: runners.c, today_non_runners: nonRunners.c,
    total_records: totalRecords.c
  };
}

function clearToday() {
  const d = today();
  db.prepare('DELETE FROM runners WHERE race_id IN (SELECT id FROM races WHERE date = ?)').run(d);
  db.prepare('DELETE FROM races WHERE date = ?').run(d);
  db.prepare('DELETE FROM meetings WHERE date = ?').run(d);
}

module.exports = {
  initDb, upsertMeeting, upsertRace, upsertRunners,
  getTodaysMeetings, getTodaysRaces, getMeetingRaces, getRace, getRaceRunners,
  searchAll, getHorseHistory, getTrainerStats, getJockeyStats,
  getAiCache, setAiCache, updateSourceStatus, getSourceStatus,
  getDbStats, clearToday, hash, today
};
