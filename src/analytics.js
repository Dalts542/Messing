'use strict';
const db = require('./db');

function parseForm(formStr) {
  if (!formStr) return [];
  return formStr.replace(/\s/g, '').split(/[-\/]/).filter(Boolean);
}

function formScore(formStr) {
  const runs = parseForm(formStr);
  if (!runs.length) return { score: 0, recent: 0, sample: 0 };
  let total = 0;
  const weights = [5, 4, 3, 2, 1];
  const recent = runs.slice(0, 5);
  for (let i = 0; i < recent.length; i++) {
    const r = recent[i];
    const w = weights[i] || 1;
    const pos = parseInt(r);
    if (pos === 1) total += 10 * w;
    else if (pos === 2) total += 7 * w;
    else if (pos === 3) total += 5 * w;
    else if (pos >= 4 && pos <= 6) total += 3 * w;
    else if (!isNaN(pos)) total += 1 * w;
  }
  const maxPossible = weights.slice(0, recent.length).reduce((a, b) => a + b, 0) * 10;
  return {
    score: maxPossible > 0 ? Math.round((total / maxPossible) * 100) : 0,
    recent: recent.length,
    sample: runs.length
  };
}

function analyzeRunner(runner) {
  const form = formScore(runner.form);
  const or = runner.official_rating || 0;
  const daysOff = runner.days_since_run || null;
  let flags = [];
  if (form.score >= 70) flags.push('STRONG_FORM');
  if (form.score <= 20 && form.sample >= 3) flags.push('POOR_FORM');
  if (or >= 120) flags.push('HIGH_RATED');
  if (daysOff && daysOff > 180) flags.push('LONG_LAYOFF');
  if (daysOff && daysOff <= 14) flags.push('QUICK_RETURN');
  if (runner.is_non_runner) flags.push('NON_RUNNER');
  return { ...runner, form_score: form.score, form_sample: form.sample, flags };
}

function analyzeRace(race, runners) {
  const analyzed = runners.filter(r => !r.is_non_runner).map(analyzeRunner);
  analyzed.sort((a, b) => b.form_score - a.form_score);
  const avgRating = analyzed.reduce((s, r) => s + (r.official_rating || 0), 0) /
    (analyzed.filter(r => r.official_rating).length || 1);
  const strongForm = analyzed.filter(r => r.form_score >= 60);
  const highRated = analyzed.filter(r => (r.official_rating || 0) >= avgRating + 10);
  const classLabel = race.race_class ? `Class ${race.race_class}` : 'Unknown class';
  let competitiveness = 'OPEN';
  if (strongForm.length === 1) competitiveness = 'STANDOUT';
  else if (strongForm.length >= 4) competitiveness = 'COMPETITIVE';
  else if (analyzed.length <= 4) competitiveness = 'SMALL_FIELD';
  return {
    race_id: race.id, course: race.course, off_time: race.off_time,
    race_name: race.race_name, distance: race.distance, going: race.going,
    race_class: classLabel, field_size: analyzed.length,
    avg_rating: Math.round(avgRating), competitiveness,
    strong_form_count: strongForm.length,
    top_on_form: analyzed.slice(0, 3).map(r => ({
      horse: r.horse, form_score: r.form_score, or: r.official_rating,
      form: r.form, jockey: r.jockey, trainer: r.trainer
    })),
    high_rated: highRated.map(r => ({ horse: r.horse, or: r.official_rating })),
    runners: analyzed
  };
}

function trainerForm(trainerName) {
  const data = db.getTrainerStats(trainerName);
  return {
    trainer: trainerName,
    total_runners: data.total_runners,
    note: data.total_runners < 5
      ? 'Insufficient data for reliable statistics (n=' + data.total_runners + ')'
      : data.total_runners + ' runners in database'
  };
}

function jockeyForm(jockeyName) {
  const data = db.getJockeyStats(jockeyName);
  return {
    jockey: jockeyName,
    total_runners: data.total_runners,
    note: data.total_runners < 5
      ? 'Insufficient data for reliable statistics (n=' + data.total_runners + ')'
      : data.total_runners + ' runners in database'
  };
}

function todaySummary() {
  const meetings = db.getTodaysMeetings();
  const races = db.getTodaysRaces();
  const stats = db.getDbStats();
  const gbMeetings = meetings.filter(m => m.country !== 'IRE');
  const ireMeetings = meetings.filter(m => m.country === 'IRE');
  return {
    date: db.today(),
    total_meetings: meetings.length,
    gb_meetings: gbMeetings.length,
    ire_meetings: ireMeetings.length,
    total_races: stats.today_races,
    total_runners: stats.today_runners,
    non_runners: stats.today_non_runners,
    meetings: meetings.map(m => ({
      id: m.id, course: m.course, country: m.country,
      going: m.going, race_count: m.race_count,
      first_race: m.first_race, last_race: m.last_race,
      total_runners: m.total_runners
    }))
  };
}

module.exports = { formScore, analyzeRunner, analyzeRace, trainerForm, jockeyForm, todaySummary };
