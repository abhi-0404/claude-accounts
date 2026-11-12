const test = require('node:test');
const assert = require('node:assert/strict');
const history = require('../history');

const NOW = Date.UTC(2026, 0, 10, 12, 0);
const H = 3600e3;
const MIN = 60e3;

function storeWithSessions() {
  const store = history.emptyStore();
  const plan = (sPct, sEnd, wPct, wEnd, at) => ({ fetchedAt: at, session: { percent: sPct, resetsAt: new Date(sEnd).toISOString() }, weekly: { percent: wPct, resetsAt: new Date(wEnd).toISOString() } });
  const wEnd = NOW + 3 * 24 * H;
  history.record(store, 'k', plan(20, NOW - 40 * H + 5 * H, 5, wEnd, NOW - 39 * H), NOW - 39 * H);
  history.record(store, 'k', plan(60, NOW - 40 * H + 5 * H, 11, wEnd, NOW - 38 * H), NOW - 38 * H);
  history.record(store, 'k', plan(50, NOW - 20 * H + 5 * H, 17, wEnd, NOW - 19 * H), NOW - 19 * H);
  return store;
}

test('sessions and weekly samples are kept for years, not months', () => {
  const store = history.emptyStore();
  const old = NOW - 2.5 * 365 * 24 * H;
  history.record(store, 'k', { fetchedAt: old, session: { percent: 30, resetsAt: new Date(old + 2 * H).toISOString() }, weekly: { percent: 10, resetsAt: new Date(old + 3 * 24 * H).toISOString() } }, old);
  history.record(store, 'k', { fetchedAt: NOW, session: { percent: 5, resetsAt: new Date(NOW + 4 * H).toISOString() }, weekly: { percent: 1, resetsAt: new Date(NOW + 6 * 24 * H).toISOString() } }, NOW);
  assert.equal(Object.keys(store.accounts.k.windows).length, 2, 'a session from two and a half years ago is still there');
  assert.ok(store.accounts.k.samples.some((x) => x.at === old));
});

test('the model mix of a session counts replies and tokens per model, inside its window only', () => {
  const rec = (t, model, n) => ({ t, model, input: n, cacheRead: n * 10, output: n });
  const records = [rec(100, 'claude-opus-5-5', 1), rec(150, 'claude-opus-5-5-20260101', 2), rec(160, 'claude-haiku-5-5', 1), rec(999, 'claude-opus-5-5', 5), rec(120, '<synthetic>', 9), rec(50, 'claude-opus-5-5', 7)];
  const name = (m) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  const mix = history.modelMix(records, 100, 200, name);
  assert.deepEqual(mix, { 'opus-5-5': { replies: 2, tokens: 12 + 24 }, 'haiku-5-5': { replies: 1, tokens: 12 } });
});

test('export gives one row per session with its peak, what it added to the week, and its models', () => {
  const store = storeWithSessions();
  const first = Object.values(store.accounts.k.windows).sort((a, b) => a.start - b.start)[0];
  first.models = { 'Opus 5.5': { replies: 4, tokens: 1000 } };
  const rows = history.exportRows(store, { k: 'Work' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].account, 'Work');
  assert.equal(rows[0].sessionPeakPercent, 60);
  assert.equal(rows[0].weeklyPercentAtEnd, 11);
  assert.deepEqual(rows[0].models, { 'Opus 5.5': { replies: 4, tokens: 1000 } });
  assert.equal(rows[1].models, null, 'sessions without a recorded mix are null, not empty');
  assert.ok('effort' in rows[0], 'effort is reserved for later');
  assert.ok(rows[0].start < rows[1].start);
});

test('CSV escapes commas and quotes and lists the models', () => {
  const csv = history.toCsv([{ account: 'Work, Inc', start: 's', end: 'e', sessionPeakPercent: 50, weeklyPercentAtEnd: 10, weeklyPercentAdded: 4, models: { 'Opus 5.5': { replies: 2, tokens: 30 } }, effort: null }]);
  const [head, row] = csv.split('\n');
  assert.match(head, /^account,start,end,sessionPeakPercent/);
  assert.match(row, /^"Work, Inc",s,e,50,10,4,Opus 5.5 2 replies 30 tokens,$/);
});

test('the alert says how much of each window to use to finish the week', () => {
  // 87% of the week left, a session running (49% left) and 5 more windows before the reset.
  const plan = {
    session: { percent: 51, resetsAt: new Date(NOW + 2 * H).toISOString() },
    weekly: { percent: 13, resetsAt: new Date(NOW + 27 * H).toISOString() },
  };
  const al = history.weeklyAlert(plan, 0.12, NOW, { sessionsPerDay: 1, avgUse: 30, learned: true });
  assert.ok(al);
  assert.equal(al.slots[0].aim, al.aim, 'every window gets the same aim');
  assert.ok(al.aim > 0 && al.aim <= 100);
  const gain = al.slots.reduce((sum, s) => sum + s.gain, 0);
  assert.ok(Math.abs(gain - Math.min(al.unused, gain)) < 0.01 || gain <= al.unused + 1, 'the windows do not promise more than what is left');
  // With little time left, even full use cannot finish the week: aim is 100%.
  const tight = history.weeklyAlert({ session: { percent: 0, resetsAt: null }, weekly: { percent: 10, resetsAt: new Date(NOW + 8 * H).toISOString() } }, 0.12, NOW, { sessionsPerDay: 1, avgUse: 30, learned: true });
  assert.equal(tight.aim, 100);
});
