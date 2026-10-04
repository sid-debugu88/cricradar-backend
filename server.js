// Sift backend — the "kitchen" that watches real cricket scores
// from around the world and pushes real alerts to subscribed devices,
// even when their browser tab is closed.

const express = require('express');
const webpush = require('web-push');
const app = express();
app.use(express.json());

// This line tells the browser "it's fine, Sift's frontend can ask me for data."
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---- CONFIG ----
// IMPORTANT: this key should never be pasted into chat again.
// On the real hosting service, this comes from an "environment variable" —
// a setting on the server's dashboard, not typed into the code itself.
const CRICAPI_KEY = process.env.CRICAPI_KEY || 'PUT_KEY_HERE_LOCALLY_ONLY';
const LIVE_POLL_MS = 10 * 60 * 1000;   // when something's live: check every 10 min
const QUIET_POLL_MS = 35 * 60 * 1000;  // when nothing's live: check every 35 min
// Worst case (something live all day): 144/day — over budget if sustained 24h,
// but a full day of continuous live cricket across all watched teams is rare.
// Typical mixed day (a few hours live, rest quiet) lands well under 100.
const SERIES_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000; // series/fixtures change slowly — every 4 hours is plenty and keeps us inside the 100/day budget

// Highlightly is our second data source — used only for rich match detail
// (scorecards, fall of wickets, best batsmen/bowlers, venue, predictions)
// when someone actually clicks a card. Separate free 100-requests/day budget
// from CricAPI, so neither source runs out because of the other.
const HIGHLIGHTLY_KEY = process.env.HIGHLIGHTLY_KEY || 'PUT_KEY_HERE_LOCALLY_ONLY';
const HIGHLIGHTLY_BASE = 'https://cricket.highlightly.net';

// ---- PUSH NOTIFICATION SETUP ----
// VAPID keys identify this server to browsers' push services (Chrome's,
// Firefox's, etc.) so they trust it to send notifications. Generate your
// own pair once with: npx web-push generate-vapid-keys
// Then set them as environment variables on Railway — never hardcode them.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('Push notifications: configured');
} else {
  console.log('Push notifications: NOT configured — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY');
}

// ---- PERSISTENT STORAGE ----
// Each subscriber's push credentials AND their chosen teams live here, in a
// real SQLite file on disk — not server memory. Memory was fine when "losing
// it on redeploy" only meant re-subscribing; once each person's team
// preferences are what's stored, silently resetting everyone on every
// deploy would be a real, confusing problem for actual users.
//
// IMPORTANT CAVEAT: on Railway's free tier, the filesystem itself can still
// reset on redeploy unless a persistent volume is attached to this service.
// This file survives normal server restarts (crashes, sleep/wake), but NOT
// necessarily a fresh deploy, until a volume is set up. Check Railway's
// "Volumes" tab for this service — attach one mounted at /data and update
// DB_PATH below to /data/sift.db to make this fully durable.
const Database = require('better-sqlite3');
const DB_PATH = process.env.DB_PATH || './sift.db';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS subscribers (
    endpoint TEXT PRIMARY KEY,
    subscription_json TEXT NOT NULL,
    teams_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

function dbGetAllSubscribers() {
  return db.prepare('SELECT endpoint, subscription_json, teams_json FROM subscribers').all()
    .map(row => ({
      subscription: JSON.parse(row.subscription_json),
      teams: JSON.parse(row.teams_json),
    }));
}
function dbUpsertSubscriber(subscriptionObj, teams) {
  const stmt = db.prepare(`
    INSERT INTO subscribers (endpoint, subscription_json, teams_json, updated_at)
    VALUES (@endpoint, @subJson, @teamsJson, datetime('now'))
    ON CONFLICT(endpoint) DO UPDATE SET
      subscription_json = @subJson,
      teams_json = @teamsJson,
      updated_at = datetime('now')
  `);
  stmt.run({
    endpoint: subscriptionObj.endpoint,
    subJson: JSON.stringify(subscriptionObj),
    teamsJson: JSON.stringify(teams || []),
  });
}
function dbRemoveSubscriber(endpoint) {
  db.prepare('DELETE FROM subscribers WHERE endpoint = ?').run(endpoint);
}
function dbCountSubscribers() {
  return db.prepare('SELECT COUNT(*) as c FROM subscribers').get().c;
}

// World cricket — international teams, major domestic leagues, and ICC events.
// A match counts as relevant if it involves one of these teams OR belongs to
// one of these tournaments. Later this becomes per-user picks.
const WATCHED_TEAMS = [
  'india', 'pakistan', 'australia', 'england', 'south africa',
  'new zealand', 'sri lanka', 'bangladesh', 'afghanistan', 'west indies',
  'ireland', 'zimbabwe', 'scotland', 'netherlands', 'nepal', 'uae'
];

const WATCHED_COMPETITIONS = [
  'ipl', 'indian premier league', 'psl', 'pakistan super league',
  'big bash', 'bbl', 'the hundred', 'cpl', 'caribbean premier league',
  'sa20', 'women\'s premier league', 'wpl', 'women\'s big bash',
  'world cup', 't20 world cup', 'champions trophy', 'world test championship',
  'the ashes', 'asia cup', 'asian games'
];

// ---- STATE ----
// This is our "memory" of what we've already seen, so we don't
// send the same alert twice. Simple in-memory store for the MVP —
// a real product would use a database, but this is enough to prove it works.
let lastKnownState = {}; // matchId -> { score summary we last saw }
let alertFeed = [];      // the list your frontend will display
let currentMatchesCache = []; // relevant matches from the latest poll, served to the frontend for free
let lastSuccessfulPoll = null; // when we last actually heard back from CricAPI — shown to users honestly
let activeSeries = [];   // ongoing/upcoming series we're tracking — fills "Series watch"
let lookaheadFixtures = []; // real fixtures found via Highlightly's date-based search, up to a week out
let upcomingFixtures = []; // scheduled matches not live yet — fills "no live match" gap

// ---------- ALERT WORDING ----------
// One place that decides how every alert reads, so notifications feel like one
// designed product instead of raw data. Rule: what happened -> the number that
// matters -> one line of context. Anything the data doesn't give us is skipped
// cleanly rather than guessed.

const TEAM_CODES = {
  'india': 'IND', 'pakistan': 'PAK', 'australia': 'AUS', 'england': 'ENG',
  'south africa': 'SA', 'new zealand': 'NZ', 'sri lanka': 'SL', 'bangladesh': 'BAN',
  'afghanistan': 'AFG', 'west indies': 'WI', 'ireland': 'IRE', 'zimbabwe': 'ZIM',
  'scotland': 'SCO', 'netherlands': 'NED', 'nepal': 'NEP', 'uae': 'UAE',
  'united arab emirates': 'UAE', 'usa': 'USA', 'oman': 'OMA', 'canada': 'CAN',
};

function teamCode(name) {
  const n = String(name || '').trim();
  const key = n.toLowerCase().replace(/\s+(women|w|u19|a)$/i, '').trim();
  const suffix = /\bwomen\b|\s+w$/i.test(n) ? ' W' : '';
  if (TEAM_CODES[key]) return TEAM_CODES[key] + suffix;
  // Unknown team: first 3 letters, uppercase, so we never show a giant name
  return n.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || '?';
}

function matchLabel(match) {
  const t = match && match.teams;
  if (Array.isArray(t) && t.length === 2) return `${teamCode(t[0])} v ${teamCode(t[1])}`;
  // Fall back to the part of the name before the first comma
  return String((match && match.name) || 'Match').split(',')[0].slice(0, 30);
}

function formatOvers(o) {
  return o == null ? '' : ` (${o})`;
}

// Score of the innings currently in progress, e.g. "WI 24/1 (3.2)"
function currentScoreText(match) {
  const sc = (match.score || []);
  if (!sc.length) return '';
  const cur = sc[sc.length - 1];
  const team = teamCode(String(cur.inning || '').replace(/ Inning.*/i, ''));
  return `${team} ${cur.r}/${cur.w}${formatOvers(cur.o)}`;
}

// If a second innings is under way we can say what the chase needs.
function chaseText(match) {
  const sc = (match.score || []);
  if (sc.length < 2) return '';
  const target = sc[0].r + 1;
  const cur = sc[sc.length - 1];
  const need = target - cur.r;
  if (need <= 0) return '';
  return `Chasing ${target} · needs ${need}`;
}

function isBigWin(status) { return /won by/i.test(status || ''); }

// CricAPI's matchStarted/matchEnded flags aren't always reliable on their
// own — a finished match can still come back with matchEnded left false.
// The status text itself is the more trustworthy signal, so we check both:
// a match reads as "ended" if either the flag says so, OR the status text
// clearly describes a finished result (won by, drawn, tied, abandoned, no result).
function isMatchOver(match) {
  if (match.matchEnded) return true;
  const status = match.status || '';
  return /won by|match drawn|match tied|no result|abandoned|match abandoned/i.test(status);
}

// Returns { title, body, tag }. `kind` is one of: live, wicket, innings, result, upcoming, update
function formatAlert(kind, match, extra) {
  const label = matchLabel(match);
  const teamsArr = Array.isArray(match && match.teams) && match.teams.length === 2 ? match.teams : null;
  const home = teamsArr ? teamCode(teamsArr[0]) : '';
  const away = teamsArr ? teamCode(teamsArr[1]) : '';
  const score = currentScoreText(match);
  const chase = chaseText(match);
  extra = extra || {};

  switch (kind) {
    case 'live':
      return {
        title: `🔴 LIVE · ${label}`,
        body: [match.status || 'Play is under way', match.venue ? match.venue.split(',')[0] : ''].filter(Boolean).join(' · '),
        home, away,
      };
    case 'wicket':
      return {
        title: `WICKET · ${label}`,
        body: [score, chase].filter(Boolean).join('\n') || 'A wicket has fallen',
        home, away,
      };
    case 'innings':
      return {
        title: `INNINGS BREAK · ${label}`,
        body: [score, chase].filter(Boolean).join('\n') || 'The innings has ended',
        home, away,
      };
    case 'result':
      return {
        title: `${isBigWin(match.status) ? '🏆 ' : ''}RESULT · ${label}`,
        body: match.status || 'The match has finished',
        home, away,
      };
    case 'upcoming':
      return {
        title: `STARTS ${extra.when ? extra.when.toUpperCase() : 'SOON'} · ${label}`,
        body: [match.venue ? match.venue.split(',')[0] : '', match.matchType ? String(match.matchType).toUpperCase() : ''].filter(Boolean).join(' · ') || 'Match coming up',
        home, away,
      };
    default:
      return { title: label, body: match.status || 'Update', home, away };
  }
}

function parseGMT(str) {
  if (!str) return null;
  const withZ = /Z$|[+-]\d\d:?\d\d$/.test(str) ? str : str + 'Z';
  const d = new Date(withZ);
  return isNaN(d.getTime()) ? null : d;
}

function pushAlert(alert) {
  alert.id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  alert.time = new Date().toISOString();
  alertFeed.unshift(alert); // newest first
  alertFeed = alertFeed.slice(0, 50); // keep the last 50 only
  console.log('[ALERT]', alert.headline);
  sendPushToAll(alert);
}

// A subscriber with an empty teams list hasn't set a preference yet (or is
// on an older version of the frontend that never sent one) — treat that as
// "send me everything" rather than silently going quiet on them. Once they
// do pick teams, they only get alerts for those.
function subscriberWantsThis(subscriberTeams, alertTeamsLower) {
  if (!subscriberTeams || subscriberTeams.length === 0) return true;
  if (!alertTeamsLower || alertTeamsLower.length === 0) return true; // alert has no team info — send to everyone rather than silently drop it
  return subscriberTeams.some(t => alertTeamsLower.includes(t));
}

// Actually deliver this alert, but only to subscribers who actually follow
// one of the teams involved — this is the real per-user filtering, not a
// global broadcast to everyone regardless of what they picked.
async function sendPushToAll(alert) {
  if (!VAPID_PUBLIC_KEY) return;
  const all = dbGetAllSubscribers();
  if (all.length === 0) return;

  const payload = JSON.stringify({
    title: alert.pushTitle || alert.tag,
    body: alert.pushBody || (alert.headline + (alert.sub ? ' — ' + alert.sub : '')),
    matchId: alert.matchId,
    home: alert.pushHome, away: alert.pushAway,
  });

  const alertTeamsLower = [alert.pushHome, alert.pushAway]
    .filter(Boolean)
    .map(t => t.toLowerCase());

  let sentCount = 0;
  for (const { subscription, teams } of all) {
    if (!subscriberWantsThis(teams, alertTeamsLower)) continue;
    try {
      await webpush.sendNotification(subscription, payload);
      sentCount++;
    } catch (err) {
      // A 410/404 means the browser unsubscribed or the device is gone —
      // remove them from storage instead of retrying forever.
      if (err.statusCode === 410 || err.statusCode === 404) {
        dbRemoveSubscriber(subscription.endpoint);
      } else {
        console.error('[push] failed to one subscriber:', err.message);
      }
    }
  }
  console.log(`[push] sent to ${sentCount} of ${all.length} subscribers (filtered by team)`);
}

// Highlightly's team names for domestic clubs, A-teams, and youth sides can
// contain a watched country's name as a substring — "India A", "India
// Under-19s", sponsor-named club sides — and a loose substring check was
// drowning the real internationals in noise. This requires the team name to
// be the country name itself (allowing a trailing "Women" for women's
// internationals, which we do want), nothing else attached.
const EXCLUDE_SUFFIX_PATTERN = /\b(A|XI|Under-?\d+|U\d+|Emerging|Invitation|Academy)\b/i;
function isSeniorInternationalTeam(name) {
  const n = (name || '').trim();
  if (!n) return false;
  if (EXCLUDE_SUFFIX_PATTERN.test(n)) return false;
  const nLower = n.toLowerCase().replace(/\s+women$/i, '').trim();
  return WATCHED_TEAMS.includes(nLower);
}
function isSeniorInternationalMatch(home, away) {
  return isSeniorInternationalTeam(home) || isSeniorInternationalTeam(away);
}

function involvesWatchedTeam(match) {
  const teams = (match.teams || []).map(t => t.toLowerCase());
  const name = (match.name || '').toLowerCase();
  const series = (match.series_id || match.matchType || '').toString().toLowerCase();
  const byTeam = WATCHED_TEAMS.some(w => teams.some(t => t.includes(w)));
  const byCompetition = WATCHED_COMPETITIONS.some(c => name.includes(c) || series.includes(c));
  return byTeam || byCompetition;
}

// The core "brain": compares new match data to what we saw last time
// and decides if anything alert-worthy happened.
function detectChanges(match) {
  const id = match.id;
  const prev = lastKnownState[id];

  const summary = {
    status: match.status || '',
    score: JSON.stringify(match.score || []),
  };

  if (!prev) {
    // First time we've seen this match since the backend last restarted.
    // Don't assume it just went live — it may have already finished before
    // we saw it (e.g. right after a redeploy), so check real state first.
    summary.wickets = totalWickets(match);
    summary.innings = (match.score || []).length;
    lastKnownState[id] = summary;

    const alreadyOver = isMatchOver(match);
    const notStartedYet = match.matchStarted === false && !alreadyOver;
    const kind = alreadyOver ? 'result' : (notStartedYet ? 'update' : 'live');
    const f = formatAlert(kind, match);
    const tag = alreadyOver ? 'Result' : (notStartedYet ? 'Upcoming' : 'Match live');
    const headline = alreadyOver
      ? (match.name || 'Match')
      : (notStartedYet ? (match.name || 'Match') : `${match.name || 'Match'} is live`);
    pushAlert({
      tag, headline,
      sub: match.status || 'In progress',
      matchId: id,
      pushTitle: f.title, pushBody: f.body, pushHome: f.home, pushAway: f.away,
    });
    return;
  }

  if (prev.status !== summary.status) {
    // Status changed — e.g. "Live" -> "Pakistan won by 6 wickets"
    const isResult = /won|beat|drawn|tied|no result/i.test(summary.status);
    const f = formatAlert(isResult ? 'result' : 'update', match);
    pushAlert({
      tag: isResult ? 'Result' : 'Update',
      headline: match.name || 'Match update',
      sub: match.status,
      matchId: id,
      pushTitle: f.title, pushBody: f.body, pushHome: f.home, pushAway: f.away,
    });
  } else if (prev.score !== summary.score) {
    // Score changed. A live ODI changes every ball, so alerting on every
    // change would be notification hell. Only alert when a wicket falls
    // or the innings changes; otherwise quietly update the stored state.
    const wicketsBefore = prev.wickets || 0;
    const wicketsNow = totalWickets(match);
    const inningsBefore = prev.innings || 0;
    const inningsNow = (match.score || []).length;

    if (wicketsNow > wicketsBefore || inningsNow > inningsBefore) {
      const isWicket = wicketsNow > wicketsBefore;
      const f = formatAlert(isWicket ? 'wicket' : 'innings', match);
      pushAlert({
        tag: isWicket ? 'Wicket' : 'Innings break',
        headline: match.name || 'Match',
        sub: summariseScore(match),
        matchId: id,
        pushTitle: f.title, pushBody: f.body, pushHome: f.home, pushAway: f.away,
      });
    }
  }

  summary.wickets = totalWickets(match);
  summary.innings = (match.score || []).length;
  lastKnownState[id] = summary;
}

function totalWickets(match) {
  const scores = match.score || [];
  if (!scores.length) return 0;
  return scores[scores.length - 1].w || 0; // wickets in the innings currently in progress
}

function summariseScore(match) {
  if (!match.score || !match.score.length) return match.status || 'Score updated';
  return match.score.map(s => `${s.inning || ''}: ${s.r}/${s.w} (${s.o} ov)`).join(' · ');
}

// ---- SERIES & UPCOMING FIXTURES ----
// Separate, slower poll — series schedules don't change minute to minute,
// so checking every 4 hours keeps the "what's coming up" data fresh without
// burning through the same daily request budget as the live-score poll.
// CricAPI's currentMatches can't see more than roughly a day ahead — that's
// exactly how we missed the Asian Games final. Highlightly's /matches
// endpoint takes a specific date, so we can ask it directly: "what's on
// this day?" for each of the next few days, and catch fixtures CricAPI
// simply can't see yet. This runs on the same slow cadence as the series
// check (every 4 hours) since fixture schedules don't change minute to
// minute, and it's a genuinely different lookup than the live-score poll.
async function checkLookaheadFixtures() {
  if (!HIGHLIGHTLY_KEY || HIGHLIGHTLY_KEY === 'PUT_KEY_HERE_LOCALLY_ONLY') {
    console.log('[lookahead] skipped — HIGHLIGHTLY_KEY not configured');
    return;
  }
  const DAYS_AHEAD = 6; // a one-week lookahead window — enough to catch "the final is in 2 days" without burning the whole daily budget
  const found = [];

  for (let i = 0; i <= DAYS_AHEAD; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);

    try {
      const res = await fetch(`${HIGHLIGHTLY_BASE}/matches?date=${dateStr}`, {
        headers: { 'x-rapidapi-key': HIGHLIGHTLY_KEY }
      });
      const data = await res.json();
      const matches = Array.isArray(data) ? data : (data.data || []);

      matches.forEach(m => {
        const home = (m.homeTeam && m.homeTeam.name) || '';
        const away = (m.awayTeam && m.awayTeam.name) || '';
        if (isSeniorInternationalMatch(home, away)) {
          found.push({
            id: 'hl-' + m.id, name: m.name || `${home} vs ${away}`,
            teams: [home, away], venue: m.location && m.location.name,
            dateTimeGMT: m.startDate, matchType: m.type,
            source: 'highlightly-lookahead',
          });
        }
      });
    } catch (err) {
      console.error(`[lookahead] failed for ${dateStr}:`, err.message);
      // one bad day shouldn't stop the rest of the week from being checked
    }
  }

  // The same fixture can legitimately appear on more than one day's query
  // (e.g. a match spanning midnight), so dedupe by ID before storing.
  const seen = {};
  lookaheadFixtures = found.filter(m => {
    if (seen[m.id]) return false;
    seen[m.id] = true;
    return true;
  });
  console.log(`[lookahead] found ${found.length} fixtures involving watched teams over the next ${DAYS_AHEAD} days`);

  // Anything found this way that's starting within 24 hours should trigger
  // the same "starts soon" alert as a CricAPI-discovered match would —
  // this is the actual fix for missing the Asian Games final notification.
  found.forEach(m => checkUpcomingReminder({ ...m, matchStarted: false }));
}

async function checkSeriesAndFixtures() {
  try {
    trackCricApiRequest();
    const page0 = await fetch(`https://api.cricapi.com/v1/series?apikey=${CRICAPI_KEY}&offset=0`).then(r => r.json());
    if (page0.status !== 'success') {
      console.error('CricAPI series error:', page0.status, page0.reason || '');
      return;
    }
    let allSeries = page0.data || [];

    // CricAPI paginates ~25 per page. This runs only a few times a day
    // (every 4 hours), so a second page costs very little against the daily
    // budget and meaningfully widens what "upcoming" can show — a single
    // page was quietly cutting off real series further down the list.
    trackCricApiRequest();
    const page1 = await fetch(`https://api.cricapi.com/v1/series?apikey=${CRICAPI_KEY}&offset=25`).then(r => r.json()).catch(() => null);
    if (page1 && page1.status === 'success' && Array.isArray(page1.data)) {
      allSeries = allSeries.concat(page1.data);
    }

    // Keep only series that plausibly involve a team or competition we watch,
    // matched by name since the series list doesn't break out team names directly.
    activeSeries = allSeries.filter(s => {
      const name = (s.name || '').toLowerCase();
      return WATCHED_TEAMS.some(w => name.includes(w)) ||
             WATCHED_COMPETITIONS.some(c => name.includes(c));
    }).slice(0, 14); // a bit more headroom now that we're pulling two pages

    console.log(`[series] tracked ${activeSeries.length} relevant series of ${allSeries.length} total across 2 pages`);
  } catch (err) {
    console.error('[series] failed:', err.message);
  }
}


let notifiedUpcoming = {}; // matchId -> true, so we only send the "starts soon" alert once per match

// Tracks how many CricAPI calls we've made today, so we can back off
// automatically instead of guessing and hoping the math holds up.
let requestCountToday = 0;
let requestCountDay = new Date().toISOString().slice(0, 10);
function trackCricApiRequest() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== requestCountDay) { requestCountDay = today; requestCountToday = 0; }
  requestCountToday++;
}

async function checkForUpdates() {
  trackCricApiRequest();
  try {
    const url = `https://api.cricapi.com/v1/currentMatches?apikey=${CRICAPI_KEY}&offset=0`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== 'success') {
      console.error('CricAPI error:', data.status, data.reason || '');
      return false;
    }

    const matches = data.data || [];
    const relevant = matches.filter(involvesWatchedTeam);
    // Keep a lightweight copy for the frontend. Costs no extra API hits.
    currentMatchesCache = relevant.map(m => ({
      id: m.id, name: m.name, status: m.status, venue: m.venue,
      date: m.date, dateTimeGMT: m.dateTimeGMT, matchType: m.matchType,
      teams: m.teams, score: m.score || [], matchStarted: !!m.matchStarted, matchEnded: isMatchOver(m),
    }));

    relevant.forEach(detectChanges);
    relevant.forEach(checkUpcomingReminder);
    lastSuccessfulPoll = new Date().toISOString();

    const anyLive = relevant.some(m => m.matchStarted && !isMatchOver(m));
    if (relevant.length === 0) {
      console.log(`[poll] checked ${matches.length} matches, none involve watched teams right now`);
    }
    return anyLive;
  } catch (err) {
    // Network hiccup, API down, etc. — log it and just try again next cycle.
    // This is exactly the kind of "boring but essential" error handling
    // that keeps a 24/7 bot from silently dying at 2am.
    console.error('[poll] failed:', err.message);
    return false;
  }
}

// CricAPI's currentMatches already includes near-future fixtures, not just
// live ones — so we don't need a separate schedule endpoint to give advance
// notice. If a watched match hasn't started and kicks off within 24 hours,
// send one "coming up" alert, then never repeat it for that match.
function checkUpcomingReminder(match) {
  if (match.matchStarted || notifiedUpcoming[match.id]) return;
  const start = parseGMT(match.dateTimeGMT);
  if (!start) return;

  const hoursUntil = (start.getTime() - Date.now()) / (1000 * 60 * 60);

  if (hoursUntil > 0 && hoursUntil <= 24) {
    notifiedUpcoming[match.id] = true;
    // Human-friendly: "in 3h" when close, otherwise the day, e.g. "tomorrow"
    const when = hoursUntil < 6 ? `in ${Math.max(1, Math.round(hoursUntil))}h` : (hoursUntil < 24 ? 'tomorrow' : 'soon');
    const f = formatAlert('upcoming', match, { when });
    const localTime = start.toUTCString().replace(' GMT', ' GMT');
    pushAlert({
      tag: 'Upcoming',
      headline: match.name || 'Match coming up',
      sub: `Starts ${localTime}${match.venue ? ' · ' + match.venue : ''}`,
      matchId: match.id,
      pushTitle: f.title, pushBody: f.body, pushHome: f.home, pushAway: f.away,
    });
  }
}

// ---- ROUTES your frontend will call ----
app.get('/api/feed', (req, res) => {
  res.json({ alerts: alertFeed });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true, lastPoll: new Date().toISOString(), matchesTracked: Object.keys(lastKnownState).length,
    subscribers: dbCountSubscribers(), seriesTracked: activeSeries.length,
    cricApiRequestsToday: requestCountToday, dailySafetyLimit: DAILY_SAFETY_LIMIT,
  });
});

// Raw current matches from the latest poll, so the frontend can render live
// scores and upcoming fixtures without spending any extra API hits.
app.get('/api/matches', (req, res) => {
  res.json({ matches: currentMatchesCache, lastChecked: lastSuccessfulPoll });
});

// Powers the "Series watch" card — real ongoing/upcoming series, not invented.
app.get('/api/series', (req, res) => {
  res.json({ series: activeSeries });
});

// Real upcoming fixtures found via Highlightly's date-based lookup — this is
// what catches tournaments like the Asian Games final that CricAPI's
// near-term-only view can't see yet.
app.get('/api/lookahead', (req, res) => {
  res.json({ fixtures: lookaheadFixtures });
});

// Real detail for a specific match, fetched on demand when a user clicks a
// card — we don't pre-fetch this for every match to stay inside the daily
// request budget, only when someone actually wants to see more.
// Highlightly's matchId is different from CricAPI's, so this route accepts
// team names + a rough date to search rather than requiring a Highlightly id.
app.get('/api/match-detail', async (req, res) => {
  const { home, away, date } = req.query;
  if (!home || !away) return res.status(400).json({ ok: false, error: 'Missing home/away team names' });

  try {
    // Step 1: find the match by team names (and date, if we have one)
    const searchParams = new URLSearchParams({ homeTeamName: home, awayTeamName: away });
    if (date) searchParams.set('date', date);
    const searchUrl = `${HIGHLIGHTLY_BASE}/matches?${searchParams}`;
    const searchRes = await fetch(searchUrl, {
      headers: { 'x-rapidapi-key': HIGHLIGHTLY_KEY }
    });
    const searchData = await searchRes.json();
    const found = (searchData.data || [])[0];
    if (!found) return res.status(404).json({ ok: false, error: 'Match not found in detail source yet' });

    // Step 2: fetch the full detail for that specific match — this is the
    // rich payload: scorecards, fall of wickets, best batsmen/bowlers, venue.
    const detailRes = await fetch(`${HIGHLIGHTLY_BASE}/matches/${found.id}`, {
      headers: { 'x-rapidapi-key': HIGHLIGHTLY_KEY }
    });
    const detailData = await detailRes.json();
    res.json({ ok: true, match: Array.isArray(detailData) ? detailData[0] : detailData });
  } catch (err) {
    console.error('[match-detail] failed:', err.message);
    res.status(500).json({ ok: false, error: 'Could not reach detail source' });
  }
});

// Sends a test notification to every subscribed device right now, so we can
// check that push delivery works without waiting for a real match event.
// Returns exactly what happened for each device so failures are visible.
app.get('/api/push/test', async (req, res) => {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return res.json({ ok: false, problem: 'VAPID keys are not loaded on the server' });
  }
  const allForTest = dbGetAllSubscribers();
  if (allForTest.length === 0) {
    return res.json({ ok: false, problem: 'No devices subscribed on the backend (subscribers = 0)' });
  }

  // This test endpoint intentionally ignores each subscriber's team filter —
  // it's for confirming delivery and wording on YOUR device, not simulating
  // real per-user targeting.
  // ?kind=wicket|live|result|upcoming|innings sends a realistic sample of that
  // alert so you can judge the wording and look without waiting for a real match.
  const sample = {
    name: 'India vs West Indies, 1st ODI', status: 'India won by 6 wickets', matchType: 'odi',
    venue: 'Narendra Modi Stadium, Ahmedabad', teams: ['India', 'West Indies'],
    score: [{ r: 286, w: 9, o: 50, inning: 'West Indies Inning 1' }, { r: 41, w: 2, o: 6.1, inning: 'India Inning 1' }],
  };
  const kind = ['live', 'wicket', 'innings', 'result', 'upcoming'].includes(req.query.kind) ? req.query.kind : 'wicket';
  if (kind === 'result') sample.score[1] = { r: 289, w: 4, o: 44.2, inning: 'India Inning 1' };
  if (kind === 'innings') sample.score = [sample.score[0]];
  if (kind === 'live') { sample.status = 'India opt to bowl'; sample.score = []; }
  if (kind === 'upcoming') { sample.status = 'Match not started'; sample.score = []; }
  const f = formatAlert(kind, sample, { when: 'tomorrow' });
  const payload = JSON.stringify({ title: f.title, body: f.body, matchId: 'sample-' + kind, home: f.home, away: f.away });

  const results = [];
  for (const { subscription } of allForTest) {
    try {
      await webpush.sendNotification(subscription, payload);
      results.push({ endpoint: subscription.endpoint.slice(0, 60) + '...', sent: true });
    } catch (err) {
      results.push({ endpoint: subscription.endpoint.slice(0, 60) + '...', sent: false, statusCode: err.statusCode, error: err.body || err.message });
    }
  }
  res.json({ ok: true, kind, preview: f, results });
});

// The frontend needs this public key to ask the browser for push permission.
app.get('/api/push/public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// The frontend calls this once the browser grants permission, handing us
// the subscription object we'll use to actually push to that device.
// Accepts either the raw push subscription (old frontend, no team filter —
// falls back to "send everything") or { subscription, teams: [...] } from
// an updated frontend that's telling us which teams this device follows.
app.post('/api/push/subscribe', (req, res) => {
  const body = req.body;
  const sub = body && body.subscription ? body.subscription : body;
  const teams = (body && Array.isArray(body.teams)) ? body.teams.map(t => String(t).toLowerCase()) : [];

  if (!sub || !sub.endpoint) return res.status(400).json({ ok: false, error: 'Invalid subscription' });

  dbUpsertSubscriber(sub, teams);
  res.json({ ok: true, subscribers: dbCountSubscribers() });
});

// ---- START ----
const PORT = process.env.PORT || 3000;
// Self-rescheduling loop: poll faster while something's live, slower when
// it's quiet, and back off hard if we're running close to CricAPI's
// 100-requests/day free cap — a real safety net instead of hoping the
// interval math holds up on a busy day.
const DAILY_SAFETY_LIMIT = 95; // leave a small buffer under CricAPI's 100/day cap
async function scheduleNextPoll() {
  if (requestCountToday >= DAILY_SAFETY_LIMIT) {
    console.log(`[poll] daily safety limit reached (${requestCountToday}/${DAILY_SAFETY_LIMIT}) — pausing until tomorrow`);
    setTimeout(scheduleNextPoll, 60 * 60 * 1000); // check again in an hour, in case the day rolled over
    return;
  }
  const wasLive = await checkForUpdates();
  const nextDelay = wasLive ? LIVE_POLL_MS : QUIET_POLL_MS;
  setTimeout(scheduleNextPoll, nextDelay);
}

app.listen(PORT, () => {
  console.log(`Sift backend running on port ${PORT}`);
  scheduleNextPoll(); // runs immediately, then reschedules itself based on live/quiet state and daily usage

  // Series data changes slowly, so don't spend a hit on every redeploy;
  // first check happens after 1 minute, then every 4 hours.
  setTimeout(checkSeriesAndFixtures, 60 * 1000);
  setInterval(checkSeriesAndFixtures, SERIES_POLL_INTERVAL_MS);

  // Staggered 30s after the series check so the two don't fire in the same
  // instant on startup — same 4-hour cadence, since fixtures don't change fast.
  setTimeout(checkLookaheadFixtures, 90 * 1000);
  setInterval(checkLookaheadFixtures, SERIES_POLL_INTERVAL_MS);
});
