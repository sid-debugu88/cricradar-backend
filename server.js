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
const POLL_INTERVAL_MS = 15 * 60 * 1000; // live scores: every 15 minutes
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

// Every device that's enabled alerts gets stored here so we can push to
// them later. In-memory for the MVP — resets if the server restarts,
// which is fine for testing but a real launch needs a database.
let subscriptions = [];

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
  'the ashes', 'asia cup'
];

// ---- STATE ----
// This is our "memory" of what we've already seen, so we don't
// send the same alert twice. Simple in-memory store for the MVP —
// a real product would use a database, but this is enough to prove it works.
let lastKnownState = {}; // matchId -> { score summary we last saw }
let alertFeed = [];      // the list your frontend will display
let activeSeries = [];   // ongoing/upcoming series we're tracking — fills "Series watch"
let upcomingFixtures = []; // scheduled matches not live yet — fills "no live match" gap

function pushAlert(alert) {
  alert.id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  alert.time = new Date().toISOString();
  alertFeed.unshift(alert); // newest first
  alertFeed = alertFeed.slice(0, 50); // keep the last 50 only
  console.log('[ALERT]', alert.headline);
  sendPushToAll(alert);
}

// Actually deliver this alert to every subscribed device, even ones
// with the site closed right now — this is the real "wake your phone up."
async function sendPushToAll(alert) {
  if (!VAPID_PUBLIC_KEY || subscriptions.length === 0) return;

  const payload = JSON.stringify({
    title: alert.tag,
    body: alert.headline + (alert.sub ? ' — ' + alert.sub : ''),
  });

  const stillValid = [];
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
      stillValid.push(sub);
    } catch (err) {
      // A 410/404 means the browser unsubscribed or the device is gone —
      // drop it quietly instead of retrying forever.
      if (err.statusCode !== 410 && err.statusCode !== 404) {
        console.error('[push] failed to one subscriber:', err.message);
        stillValid.push(sub);
      }
    }
  }
  subscriptions = stillValid;
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
    // First time we've seen this match — announce it started, don't spam history.
    lastKnownState[id] = summary;
    pushAlert({
      tag: 'Match live',
      headline: `${match.name || 'Pakistan match'} is live`,
      sub: match.status || 'In progress',
      matchId: id,
    });
    return;
  }

  if (prev.status !== summary.status) {
    // Status changed — e.g. "Live" -> "Pakistan won by 6 wickets"
    pushAlert({
      tag: /won|beat/i.test(summary.status) ? 'Result' : 'Update',
      headline: match.name || 'Pakistan match update',
      sub: match.status,
      matchId: id,
    });
  } else if (prev.score !== summary.score) {
    // Score changed but match still going — wicket, milestone, etc.
    pushAlert({
      tag: 'Score update',
      headline: match.name || 'Pakistan match',
      sub: summariseScore(match),
      matchId: id,
    });
  }

  lastKnownState[id] = summary;
}

function summariseScore(match) {
  if (!match.score || !match.score.length) return match.status || 'Score updated';
  return match.score.map(s => `${s.inning || ''}: ${s.r}/${s.w} (${s.o} ov)`).join(' · ');
}

// ---- SERIES & UPCOMING FIXTURES ----
// Separate, slower poll — series schedules don't change minute to minute,
// so checking every 4 hours keeps the "what's coming up" data fresh without
// burning through the same daily request budget as the live-score poll.
async function checkSeriesAndFixtures() {
  try {
    const seriesUrl = `https://api.cricapi.com/v1/series?apikey=${CRICAPI_KEY}&offset=0`;
    const res = await fetch(seriesUrl);
    const data = await res.json();

    if (data.status !== 'success') {
      console.error('CricAPI series error:', data.status, data.reason || '');
      return;
    }

    const allSeries = data.data || [];
    // Keep only series that plausibly involve a team or competition we watch,
    // matched by name since the series list doesn't break out team names directly.
    activeSeries = allSeries.filter(s => {
      const name = (s.name || '').toLowerCase();
      return WATCHED_TEAMS.some(w => name.includes(w)) ||
             WATCHED_COMPETITIONS.some(c => name.includes(c));
    }).slice(0, 8);

    console.log(`[series] tracked ${activeSeries.length} relevant series of ${allSeries.length} total`);
  } catch (err) {
    console.error('[series] failed:', err.message);
  }
}


async function checkForUpdates() {
  try {
    const url = `https://api.cricapi.com/v1/currentMatches?apikey=${CRICAPI_KEY}&offset=0`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== 'success') {
      console.error('CricAPI error:', data.status, data.reason || '');
      return;
    }

    const matches = data.data || [];
    const relevant = matches.filter(involvesWatchedTeam);

    relevant.forEach(detectChanges);

    if (relevant.length === 0) {
      console.log(`[poll] checked ${matches.length} matches, none involve watched teams right now`);
    }
  } catch (err) {
    // Network hiccup, API down, etc. — log it and just try again next cycle.
    // This is exactly the kind of "boring but essential" error handling
    // that keeps a 24/7 bot from silently dying at 2am.
    console.error('[poll] failed:', err.message);
  }
}

// ---- ROUTES your frontend will call ----
app.get('/api/feed', (req, res) => {
  res.json({ alerts: alertFeed });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, lastPoll: new Date().toISOString(), matchesTracked: Object.keys(lastKnownState).length, subscribers: subscriptions.length, seriesTracked: activeSeries.length });
});

// Powers the "Series watch" card — real ongoing/upcoming series, not invented.
app.get('/api/series', (req, res) => {
  res.json({ series: activeSeries });
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

// The frontend needs this public key to ask the browser for push permission.
app.get('/api/push/public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// The frontend calls this once the browser grants permission, handing us
// the subscription object we'll use to actually push to that device.
app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ ok: false, error: 'Invalid subscription' });
  const exists = subscriptions.some(s => s.endpoint === sub.endpoint);
  if (!exists) subscriptions.push(sub);
  res.json({ ok: true, subscribers: subscriptions.length });
});

// ---- START ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sift backend running on port ${PORT}`);
  checkForUpdates(); // run once immediately
  setInterval(checkForUpdates, POLL_INTERVAL_MS); // then every 15 minutes forever

  checkSeriesAndFixtures(); // run once immediately
  setInterval(checkSeriesAndFixtures, SERIES_POLL_INTERVAL_MS); // then every 4 hours
});
