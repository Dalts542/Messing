'use strict';
const http = require('http');
const db = require('./db');
const analytics = require('./analytics');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';

let ollamaOnline = false;
let ollamaModel = null;
let ollamaModels = [];

async function ollamaRequest(path, body, stream = false) {
  const url = new URL(path, OLLAMA_HOST);
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname, port: url.port || 11434,
      path: url.pathname, method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {}
    };
    const req = http.request(opts, res => {
      if (stream) return resolve(res);
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Ollama timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function checkOllama() {
  try {
    const data = await ollamaRequest('/api/tags');
    ollamaModels = (data.models || []).map(m => m.name || m.model);
    ollamaModel = ollamaModels.find(m => m.startsWith(OLLAMA_MODEL.split(':')[0])) || ollamaModels[0] || null;
    ollamaOnline = ollamaModels.length > 0;
    return { online: ollamaOnline, model: ollamaModel, models: ollamaModels };
  } catch {
    ollamaOnline = false; ollamaModel = null; ollamaModels = [];
    return { online: false, model: null, models: [] };
  }
}

function getAiStatus() {
  return { online: ollamaOnline, model: ollamaModel, models: ollamaModels, cost: '£0' };
}

const TOOLS = [
  { name: 'get_todays_meetings', desc: 'Get all of today\'s racing meetings with race counts and going',
    fn: () => analytics.todaySummary() },
  { name: 'get_meeting_races', desc: 'Get all races at a specific meeting. Param: meeting_id',
    fn: (p) => db.getMeetingRaces(p.meeting_id) },
  { name: 'get_race', desc: 'Get full race details including runners. Param: race_id',
    fn: (p) => {
      const race = db.getRace(p.race_id);
      if (!race) return { error: 'Race not found' };
      const runners = db.getRaceRunners(p.race_id);
      return analytics.analyzeRace(race, runners);
    }},
  { name: 'search_horses', desc: 'Search for a horse by name. Param: query',
    fn: (p) => db.getHorseHistory(p.query) },
  { name: 'get_trainer_stats', desc: 'Get trainer recent form and statistics. Param: name',
    fn: (p) => analytics.trainerForm(p.name) },
  { name: 'get_jockey_stats', desc: 'Get jockey recent form and statistics. Param: name',
    fn: (p) => analytics.jockeyForm(p.name) },
  { name: 'search_all', desc: 'Search horses, trainers, jockeys, courses. Param: query',
    fn: (p) => db.searchAll(p.query) },
];

function buildSystemPrompt() {
  const summary = analytics.todaySummary();
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return `You are Paddock Intelligence, an expert UK and Irish horse racing analyst.
Today is ${today}. You have access to a local racing database with live data.

CURRENT DATA: ${summary.total_meetings} meetings today (${summary.gb_meetings} GB, ${summary.ire_meetings} IRE), ${summary.total_races} races, ${summary.total_runners} runners.
${summary.meetings.map(m => `${m.course} (${m.country}): ${m.race_count} races, going: ${m.going || 'UNKNOWN'}, first: ${m.first_race || '?'}, last: ${m.last_race || '?'}`).join('\n')}

RULES:
- Ground answers in actual retrieved data. Do NOT invent race times, runners, or results.
- If data is missing, say UNKNOWN or NOT AVAILABLE. Never hallucinate.
- Use the current date (${today}) for "today" questions.
- Separate FACTS (from data) from ANALYSIS (your interpretation).
- Do not present AI output as guaranteed betting advice.
- Show form figures, ratings, and statistics where available.
- Note small sample sizes when statistics are limited.

AVAILABLE TOOLS: ${TOOLS.map(t => t.name + ' - ' + t.desc).join('; ')}

When asked about races, meetings, or horses, use the available data.
Format responses clearly with structure when listing multiple items.`;
}

function contextForQuestion(question) {
  const q = question.toLowerCase();
  let context = [];
  const summary = analytics.todaySummary();

  if (q.includes('today') || q.includes('meeting') || q.includes('racing') || q.includes('race')) {
    context.push({ type: 'meetings', data: summary });
  }

  if (q.includes('race') || q.includes('runner') || q.includes('horse') || q.includes('card')) {
    const races = db.getTodaysRaces();
    for (const race of races.slice(0, 20)) {
      const runners = db.getRaceRunners(race.id);
      if (runners.length) {
        context.push({
          type: 'race', data: {
            course: race.course, time: race.off_time, name: race.race_name,
            class: race.race_class, distance: race.distance, going: race.going,
            runners: runners.map(r => ({
              horse: r.horse, form: r.form, jockey: r.jockey, trainer: r.trainer,
              or: r.official_rating, age: r.age, weight: r.weight, draw: r.draw,
              odds: r.odds, nr: r.is_non_runner
            }))
          }
        });
      }
    }
  }

  const courseNames = summary.meetings.map(m => m.course.toLowerCase());
  for (const c of courseNames) {
    if (q.includes(c)) {
      const meeting = summary.meetings.find(m => m.course.toLowerCase() === c);
      if (meeting) {
        const races = db.getMeetingRaces(meeting.id);
        for (const race of races) {
          const runners = db.getRaceRunners(race.id);
          context.push({ type: 'race_detail', data: analytics.analyzeRace(race, runners) });
        }
      }
    }
  }

  return context;
}

async function chat(messages, res) {
  if (!ollamaOnline) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    const msg = 'Local AI is offline. Install Ollama (free) from https://ollama.com and pull a model:\n\n  ollama pull llama3.1:8b\n\nThen restart the server.';
    res.write(`data: ${JSON.stringify({ type: 'text', content: msg })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const lastMsg = messages[messages.length - 1]?.content || '';
  const ctx = contextForQuestion(lastMsg);
  let systemPrompt = buildSystemPrompt();
  if (ctx.length) {
    const ctxStr = JSON.stringify(ctx).slice(0, 8000);
    systemPrompt += '\n\nRELEVANT DATA FOR THIS QUERY:\n' + ctxStr;
  }

  const ollamaMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.slice(-20)
  ];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*'
  });

  try {
    const stream = await ollamaRequest('/api/chat', {
      model: ollamaModel, messages: ollamaMessages, stream: true
    }, true);

    stream.on('data', chunk => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          if (data.message?.content) {
            res.write(`data: ${JSON.stringify({ type: 'text', content: data.message.content })}\n\n`);
          }
          if (data.done) {
            res.write('data: [DONE]\n\n');
          }
        } catch {}
      }
    });
    stream.on('end', () => { if (!res.writableEnded) res.end(); });
    stream.on('error', () => {
      res.write(`data: ${JSON.stringify({ type: 'error', content: 'Stream error' })}\n\n`);
      res.end();
    });
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'error', content: e.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

async function generateSummary(raceId) {
  if (!ollamaOnline) return null;
  const race = db.getRace(raceId);
  if (!race) return null;
  const runners = db.getRaceRunners(raceId);
  if (!runners.length) return null;

  const dataHash = db.hash({ race, runners });
  const cached = db.getAiCache('summary_' + raceId);
  if (cached && cached.data_hash === dataHash) return cached.content;

  const analysis = analytics.analyzeRace(race, runners);
  const prompt = `Briefly summarize this horse race (3-4 paragraphs max):

${race.off_time} ${race.course} - ${race.race_name}
${race.distance || '?'} | ${race.going || 'Going unknown'} | ${analysis.race_class} | ${analysis.field_size} runners

Top on form: ${analysis.top_on_form.map(r => `${r.horse} (form score ${r.form_score}, OR ${r.or || '?'})`).join(', ')}
Competitiveness: ${analysis.competitiveness}

Runners: ${analysis.runners.map(r =>
  `${r.horse} - Form: ${r.form || 'none'}, OR: ${r.official_rating || '?'}, J: ${r.jockey || '?'}, T: ${r.trainer || '?'}, Score: ${r.form_score}`
).join('; ')}

Separate: FACTS (what data shows), DERIVED STATS (calculated metrics), AI INTERPRETATION (your analysis). State unknowns clearly. Do not present as betting advice.`;

  try {
    const result = await ollamaRequest('/api/chat', {
      model: ollamaModel,
      messages: [{ role: 'user', content: prompt }],
      stream: false
    });
    const content = result.message?.content || '';
    if (content) db.setAiCache('summary_' + raceId, dataHash, content);
    return content;
  } catch (e) {
    console.log(`  [ai] Summary error: ${e.message}`);
    return null;
  }
}

module.exports = { checkOllama, getAiStatus, chat, generateSummary };
