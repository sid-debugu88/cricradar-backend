// CricRadar backend — the "kitchen" that watches real cricket scores
// and figures out what's worth alerting Pakistan cricket fans about.

const express = require('express');
const app = express();
app.use(express.json());

// ---- CONFIG ----
// IMPORTANT: this key should never be pasted into chat again.
// On the real hosting service, this comes from an "environment variable" —
// a setting on the server's dashboard, not typed into the code itself.
const CRICAPI_KEY = process.env.CRICAPI_KEY || 'PUT_KEY_HERE_LOCALLY_ONLY';
const POLL_INTERVAL_MS = 30 * 1000; // check every 30 seconds

// Teams/keywords this test build cares about. Later this becomes per-user.
const WATCHED_TEAMS = ['pakistan'];

// ---- STATE ----
// This is our "memory" of what we've already seen, so we don't
// send the same alert twice. Simple in-memory store for the MVP —
// a real product would use a database, but this is enough to prove it works.
let lastKnownState = {}; // matchId -> { score summary we last saw }
let alertFeed = [];      // the list your frontend will display

function pushAlert(alert) {
  alert.id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  alert.time = new Date().toISOString();
  alertFeed.unshift(alert); // newest first
  alertFeed = alertFeed.slice(0, 50); // keep the last 50 only
  console.log('[ALERT]', alert.headline);
  // Phase 2 will add: actually push this to people's phones.
  // For now it just lands in the feed your app reads.
}

function involvesWatchedTeam(match) {
  const teams = (match.teams || []).map(t => t.toLowerCase());
  return WATCHED_TEAMS.some(w => teams.some(t => t.includes(w)));
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

// ---- THE POLLING LOOP ----
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
  res.json({ ok: true, lastPoll: new Date().toISOString(), matchesTracked: Object.keys(lastKnownState).length });
});

// ---- START ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CricRadar backend running on port ${PORT}`);
  checkForUpdates(); // run once immediately
  setInterval(checkForUpdates, POLL_INTERVAL_MS); // then every 30s forever
});
