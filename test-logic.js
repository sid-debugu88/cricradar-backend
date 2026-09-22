// This simulates 3 "snapshots" of the same match over time —
// like the real API would return if we polled it every 30 seconds —
// to prove the alert-detection logic actually catches the right moments.
// No real internet needed for this test.

let lastKnownState = {};
let alertFeed = [];

function pushAlert(alert) {
  alertFeed.unshift(alert);
  console.log(`\n🔔 ALERT FIRED: [${alert.tag}] ${alert.headline}`);
  console.log(`   ${alert.sub}`);
}

function detectChanges(match) {
  const id = match.id;
  const prev = lastKnownState[id];
  const summary = { status: match.status || '', score: JSON.stringify(match.score || []) };

  if (!prev) {
    lastKnownState[id] = summary;
    pushAlert({ tag: 'Match live', headline: `${match.name} is live`, sub: match.status });
    return;
  }
  if (prev.status !== summary.status) {
    pushAlert({ tag: /won|beat/i.test(summary.status) ? 'Result' : 'Update', headline: match.name, sub: match.status });
  } else if (prev.score !== summary.score) {
    const scoreStr = match.score.map(s => `${s.inning}: ${s.r}/${s.w} (${s.o} ov)`).join(' · ');
    pushAlert({ tag: 'Score update', headline: match.name, sub: scoreStr });
  }
  lastKnownState[id] = summary;
}

console.log('--- Simulating poll #1: match just started ---');
detectChanges({
  id: 'm1', name: 'Pakistan vs Australia, 3rd ODI', status: 'Pakistan elected to bowl',
  score: []
});

console.log('\n--- Simulating poll #2: 20 minutes later, same status, new score (should fire "score update") ---');
detectChanges({
  id: 'm1', name: 'Pakistan vs Australia, 3rd ODI', status: 'Pakistan elected to bowl',
  score: [{ inning: 'Australia', r: 88, w: 2, o: 14.3 }]
});

console.log('\n--- Simulating poll #3: no change at all (should NOT fire anything) ---');
detectChanges({
  id: 'm1', name: 'Pakistan vs Australia, 3rd ODI', status: 'Pakistan elected to bowl',
  score: [{ inning: 'Australia', r: 88, w: 2, o: 14.3 }]
});

console.log('\n--- Simulating poll #4: a wicket falls (score changes, should fire) ---');
detectChanges({
  id: 'm1', name: 'Pakistan vs Australia, 3rd ODI', status: 'Pakistan elected to bowl',
  score: [{ inning: 'Australia', r: 91, w: 3, o: 15.1 }]
});

console.log('\n--- Simulating poll #5: match ends (status changes, should fire as Result) ---');
detectChanges({
  id: 'm1', name: 'Pakistan vs Australia, 3rd ODI', status: 'Pakistan won by 6 wickets',
  score: [{ inning: 'Australia', r: 240, w: 10, o: 48.2 }, { inning: 'Pakistan', r: 241, w: 4, o: 45.0 }]
});

console.log(`\n\nTotal alerts fired: ${alertFeed.length} (expected 4 — start, first score, wicket, result. Poll #3 correctly fired nothing.)`);
