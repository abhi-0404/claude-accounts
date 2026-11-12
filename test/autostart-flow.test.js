// The auto-start flow end to end, including what went wrong on 12 Nov: the window did start (Claude said
// "resets 8:40 PM"), but the panel kept showing "Session 0%" with no reset time, and two VS Code windows
// both sent the message.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const a = require('../autostart');
const live = require('../live');

const MIN = 60e3;
const H = 60 * MIN;
const T = Date.UTC(2026, 10, 12, 10, 10); // 3:40 PM in India, when the session reset
const iso = (ms) => new Date(ms).toISOString();

// ---------- the panel must show the window the auto-start opened ----------

test('a fresh check showing the new window beats the "just reset" placeholder', () => {
  // After the reset the panel shows 0% with no reset time (a placeholder made at the reset moment).
  const placeholder = { fetchedAt: T, session: { percent: 0, resetsAt: null, severity: 'normal', resetAt: iso(T) }, weekly: { percent: 16, resetsAt: iso(T + 20 * H) } };
  // Claude's saved copy on disk is older (from before the reset).
  const saved = { fetchedAt: T - 40e3, session: { percent: 0, resetsAt: null }, weekly: { percent: 16, resetsAt: iso(T + 20 * H) } };
  // The check after the auto-start: the window now runs until 8:40 PM.
  const livePlan = { fetchedAt: T + 2 * MIN, session: { percent: 0, resetsAt: iso(T + 5 * H) }, weekly: { percent: 16, resetsAt: iso(T + 20 * H) } };
  const merged = live.mergePlans(livePlan, saved, placeholder, T + 2 * MIN);
  const shown = live.choosePlan(placeholder, live.acceptLive(placeholder, merged, T + 2 * MIN));
  assert.equal(shown.session.resetsAt, iso(T + 5 * H), 'the new window (resets 8:40 PM) is shown');
});

test('a check that says nothing new keeps its honest age', () => {
  const current = { fetchedAt: T, session: { percent: 20, resetsAt: iso(T + H) }, weekly: { percent: 30, resetsAt: iso(T + 9 * H) } };
  const same = { ...current, fetchedAt: T - 5 * MIN };
  assert.equal(live.acceptLive(current, same, T + MIN).fetchedAt, T - 5 * MIN);
  assert.equal(live.acceptLive(null, same, T + MIN).fetchedAt, T + MIN, 'with nothing shown yet, it is news');
  assert.equal(live.acceptLive(current, null), null);
});

test('a check too early to see the window does not hide it later', () => {
  // 5 seconds after sending, Claude may not show the window yet; a later check does.
  const placeholder = { fetchedAt: T, session: { percent: 0, resetsAt: null, resetAt: iso(T) }, weekly: { percent: 16, resetsAt: iso(T + 20 * H) } };
  const early = live.acceptLive(placeholder, { fetchedAt: T - 40e3, session: { percent: 0, resetsAt: null }, weekly: placeholder.weekly }, T + 5e3);
  let shown = live.choosePlan(placeholder, early);
  assert.equal(shown.session.resetsAt, null);
  const later = live.acceptLive(shown, { fetchedAt: T + 60e3, session: { percent: 1, resetsAt: iso(T + 5 * H) }, weekly: placeholder.weekly }, T + 60e3);
  shown = live.choosePlan(shown, later);
  assert.equal(shown.session.resetsAt, iso(T + 5 * H));
  assert.ok(a.CONFIRM_DELAYS_MS.length >= 3 && a.CONFIRM_DELAYS_MS.at(-1) >= 60e3, 'it checks more than once, over at least a minute');
});

// ---------- only one window sends ----------

test('two VS Code windows: only the first one sends', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autostart-locks-'));
  const item = { key: 'd:\\.claude-work', start: T };
  assert.equal(a.claim(dir, item, T + 50e3), true, 'window 1 sends');
  assert.equal(a.claim(dir, item, T + 50e3 + 140), false, 'window 2 skips');
  assert.equal(a.claim(dir, { ...item, start: T + 20e3 }, T + 51e3), false, 'the same window a few seconds off is the same claim');
  assert.equal(a.claim(dir, { ...item, start: T + 5 * H }, T + 5 * H + 50e3), true, 'the next window is a new claim');
  assert.equal(a.claim(dir, { key: 'd:\\.claude-kaya', start: T }, T + 50e3), true, 'another account is separate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('old locks are cleared, and an unwritable lock folder does not block the send', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autostart-locks-'));
  const item = { key: 'k', start: T };
  a.claim(dir, item, T);
  const lock = fs.readdirSync(dir)[0];
  const old = (T - 2 * 24 * H) / 1000;
  fs.utimesSync(path.join(dir, lock), old, old);
  a.claim(dir, { key: 'other', start: T + H }, T + H);
  assert.ok(!fs.readdirSync(dir).includes(lock) || Date.now() - fs.statSync(path.join(dir, lock)).mtimeMs < 24 * H, 'stale lock removed');
  const file = path.join(dir, 'not-a-folder');
  fs.writeFileSync(file, 'x');
  assert.equal(a.claim(file, item, T), true, 'cannot lock: send anyway rather than miss the window');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- timing ----------

test('timeline of one auto-start: waits for the reset, fires once just after, then is gone', () => {
  let list = a.add([], { key: 'k', start: T }, T - 3 * H).list;
  const at = (ms) => ({ due: a.due(list, ms).length, missed: a.missed(list, ms).length });
  assert.deepEqual(at(T - MIN), { due: 0, missed: 0 }, 'before the reset: waiting');
  assert.deepEqual(at(T + 10e3), { due: 0, missed: 0 }, 'just after the reset: short safety delay');
  assert.deepEqual(at(T + a.FIRE_DELAY_MS), { due: 1, missed: 0 }, 'fires');
  list = a.remove(list, { key: 'k', start: T });
  assert.deepEqual(at(T + 2 * MIN), { due: 0, missed: 0 }, 'gone after firing');
});

test('VS Code closed over the start: dropped and reported, never sent late', () => {
  const list = a.add([], { key: 'k', start: T }, T - H).list;
  assert.equal(a.due(list, T + 30 * MIN).length, 0);
  assert.equal(a.missed(list, T + 30 * MIN).length, 1);
});

test('skip rules at fire time', () => {
  const running = { session: { percent: 3, resetsAt: iso(T + 4 * H) } };
  assert.match(a.skipReason(running, true, T + MIN), /already running/, 'you already started it yourself');
  assert.equal(a.skipReason({ session: { percent: 0, resetsAt: null, resetAt: iso(T) } }, true, T + MIN), null, 'just reset: send');
  assert.equal(a.skipReason({ session: { percent: 80, resetsAt: iso(T - 1) } }, true, T + MIN), null, 'reset time already passed: send');
  assert.equal(a.skipReason(running, false, T + MIN), 'signed out');
});
