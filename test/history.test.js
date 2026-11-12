const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../history');

const HOUR = 3600e3;
const iso = (ms) => new Date(ms).toISOString();

test('records 5-hour slots with their peak and learns the weekly share of a session', () => {
  const store = h.emptyStore();
  const now = Date.UTC(2026, 10, 12, 12);
  const weekEnd = now + 40 * HOUR;
  const s1End = now + 2 * HOUR;
  // A session going 10% -> 50% moves the weekly limit 20% -> 25%: one full session = 12.5% of the week.
  h.record(store, 'k', { fetchedAt: now, session: { percent: 10, resetsAt: iso(s1End) }, weekly: { percent: 20, resetsAt: iso(weekEnd) } }, now);
  h.record(store, 'k', { fetchedAt: now + HOUR, session: { percent: 50, resetsAt: iso(s1End) }, weekly: { percent: 25, resetsAt: iso(weekEnd) } }, now + HOUR);
  assert.equal(store.accounts.k.windows[String(s1End)].peak, 50);
  assert.equal(h.learnedShare(store, 'k'), 0.125);
  // Same numbers again: nothing new.
  assert.equal(h.record(store, 'k', { fetchedAt: now + 2 * HOUR, session: { percent: 50, resetsAt: iso(s1End) }, weekly: { percent: 25, resetsAt: iso(weekEnd) } }, now + 2 * HOUR), false);

  const sum = h.weekSummary(store, 'k', iso(weekEnd), now + HOUR);
  assert.equal(sum.thisWeek.count, 1);
  assert.equal(sum.thisWeek.avg, 50);
  assert.equal(sum.thisWeek.slots[0].current, true);
  assert.equal(sum.lastWeek.count, 0);
});

test('series and cycles: sessions on a timeline, weekly % per session and per weekly cycle', () => {
  const store = h.emptyStore();
  const reset = Date.UTC(2026, 10, 14, 4); // weekly reset (end of this cycle)
  const t0 = reset - 6 * 24 * HOUR; // inside this cycle
  const plan = (at, sPct, sEnd, wPct, wEnd) => ({ fetchedAt: at, session: { percent: sPct, resetsAt: iso(sEnd) }, weekly: { percent: wPct, resetsAt: iso(wEnd) } });
  // Session 1: 30%, week goes 0 -> 9. Session 2: 42%, week 9 -> 15.
  h.record(store, 'k', plan(t0 + HOUR, 10, t0 + 5 * HOUR, 3, reset), t0 + HOUR);
  h.record(store, 'k', plan(t0 + 4 * HOUR, 30, t0 + 5 * HOUR, 9, reset), t0 + 4 * HOUR);
  h.record(store, 'k', plan(t0 + 9 * HOUR, 42, t0 + 10 * HOUR, 15, reset), t0 + 9 * HOUR);
  // A session in the previous cycle that reached 70% of that week.
  const prev = reset - 7 * 24 * HOUR;
  h.record(store, 'k', plan(prev - 3 * HOUR, 55, prev - HOUR, 70, prev), prev - 3 * HOUR);

  const s = h.series(store, 'k', reset - 14 * 24 * HOUR);
  assert.equal(s.slots.length, 3);
  const [old, a, b] = s.slots;
  assert.equal(old.peak, 55);
  assert.equal(a.peak, 30);
  assert.equal(a.weekly, 9, 'weekly % reached by the end of session 1');
  assert.equal(b.weekly, 15);
  assert.equal(a.weeklyUsed, 9, 'first session of a new week starts from 0%');
  assert.equal(b.weeklyUsed, 6, 'session 2 took the week from 9% to 15%');
  assert.equal(old.weeklyUsed, null, 'first session ever recorded: tracking began mid-week, so unknown');
  assert.deepEqual(s.weekly.map((x) => x.w), [70, 3, 9, 15]);

  const c = h.cycles(store, 'k', iso(reset), 4, t0 + 10 * HOUR);
  assert.equal(c.length, 2);
  assert.equal(c[0].current, true);
  assert.equal(c[0].sessions, 2);
  assert.equal(c[0].avg, 36);
  assert.equal(c[0].reached, 15);
  assert.equal(c[1].sessions, 1);
  assert.equal(c[1].reached, 70);
});

test('learnedShare waits for enough data', () => {
  const store = h.emptyStore();
  const t = Date.UTC(2026, 10, 12);
  h.record(store, 'k', { fetchedAt: t, session: { percent: 1, resetsAt: iso(t + HOUR) }, weekly: { percent: 1, resetsAt: iso(t + 100 * HOUR) } }, t);
  h.record(store, 'k', { fetchedAt: t + 1, session: { percent: 5, resetsAt: iso(t + HOUR) }, weekly: { percent: 2, resetsAt: iso(t + 100 * HOUR) } }, t + 1);
  assert.equal(h.learnedShare(store, 'k'), null);
});

test('weekly alert: reminder when your pace falls short, final when every session is needed', () => {
  const now = Date.UTC(2026, 10, 13, 9);
  const plan = (weeklyPct, hoursToReset, sessionPct = 0, sessionHours = 0) => ({
    weekly: { percent: weeklyPct, resetsAt: iso(now + hoursToReset * HOUR) },
    session: sessionHours ? { percent: sessionPct, resetsAt: iso(now + sessionHours * HOUR) } : null,
  });
  const pace = { sessionsPerDay: 3, avgUse: 50, learned: true };
  assert.equal(h.weeklyAlert(plan(40, 100), 0.125, now, pace), null, 'more than 3 days left');
  assert.equal(h.weeklyAlert(plan(95, 20), 0.125, now, pace), null, 'little left');
  // On track: a heavy pace (5 full sessions a day) uses the 60% left within 26h.
  assert.equal(h.weeklyAlert(plan(40, 26), 0.125, now, { sessionsPerDay: 5, avgUse: 100, learned: true }), null);
  // 60% left = 4.8 full sessions; 40h fits 8. Usual pace: 3/day * 50% -> about 5 sessions * 6.25% = 31% more -> 71%.
  const reminder = h.weeklyAlert(plan(40, 40), 0.125, now, pace);
  assert.equal(reminder.level, 'reminder');
  assert.equal(reminder.need, 4.8);
  assert.equal(reminder.fit, 8);
  assert.equal(reminder.projected, 71);
  assert.equal(reminder.maxReach, 100);
  // 26h left fits 5.2 sessions and 4.8 are needed: final.
  assert.equal(h.weeklyAlert(plan(40, 26), 0.125, now, pace).level, 'final');
  // 10h left: final; current session at 30% leaves 0.7 of it, then 7h = one full slot + a 2h part (0.4).
  const final = h.weeklyAlert(plan(40, 10, 30, 3), 0.125, now, pace);
  assert.equal(final.level, 'final');
  assert.equal(final.inSession, true);
  assert.equal(final.sessionLeft, 70);
  assert.equal(final.fit, 2.1);
  assert.equal(final.maxReach, 66, 'even using every remaining session fully it reaches only 66%');
  assert.equal(h.weeklyAlert(plan(40, 40), null, now, pace).estimated, true);
});

test('weekly line never steps back within a week (late reports from another source)', () => {
  const store = h.emptyStore();
  const t = Date.UTC(2026, 10, 10, 8);
  const reset = t + 3 * 24 * HOUR;
  const rec = (dt, w) => h.record(store, 'k', { fetchedAt: t + dt, session: { percent: 10, resetsAt: iso(t + 4 * HOUR) }, weekly: { percent: w, resetsAt: iso(reset) } }, t + dt);
  [27, 28, 27, 28, 29].forEach((w, i) => rec(i * 60000, w));
  assert.deepEqual(h.series(store, 'k').weekly.map((x) => x.w), [27, 28, 29]);
});

test('normalize merges one session recorded with slightly different reset times', () => {
  const store = h.emptyStore();
  const t = Date.UTC(2026, 10, 10, 6, 30);
  store.accounts.k = {
    windows: {
      a: { start: t - 5 * HOUR, end: t, peak: 53 },
      b: { start: t - 5 * HOUR + 400, end: t + 400, peak: 24 },
      c: { start: t - 5 * HOUR - 999, end: t - 999, peak: 51 },
    },
    samples: [
      { at: t - HOUR, s: 20, se: t + 400, w: 10, we: t + 86e6 },
      { at: t - HOUR / 2, s: 53, se: t - 999, w: 12, we: t + 86e6 + 600 },
    ],
  };
  assert.equal(h.normalize(store), true);
  const wins = Object.values(store.accounts.k.windows);
  assert.equal(wins.length, 1);
  assert.equal(wins[0].peak, 53);
  assert.equal(new Set(store.accounts.k.samples.map((x) => x.we)).size, 1);
  // New records with jittered reset times join the same session.
  h.record(store, 'k', { fetchedAt: t - 600000, session: { percent: 60, resetsAt: iso(t + 800) }, weekly: { percent: 13, resetsAt: iso(t + 86e6 - 300) } }, t - 600000);
  assert.equal(Object.values(store.accounts.k.windows).length, 1);
  assert.equal(Object.values(store.accounts.k.windows)[0].peak, 60);
});

test('pattern learns sessions per active day and average use across accounts', () => {
  const store = h.emptyStore();
  const now = Date.UTC(2026, 10, 13, 12);
  const add = (acc, daysAgo, hour, peak) => {
    const start = Date.UTC(2026, 10, 13 - daysAgo, hour);
    store.accounts[acc] = store.accounts[acc] || { windows: {}, samples: [] };
    store.accounts[acc].windows[String(start)] = { start, end: start + 5 * HOUR, peak };
  };
  assert.equal(h.pattern(store, now).learned, false, 'default until there is history');
  add('kaya', 1, 3, 80);
  add('kaya', 1, 9, 40);
  add('me', 1, 15, 60);
  add('me', 3, 4, 20);
  const p = h.pattern(store, now);
  assert.equal(p.learned, true);
  assert.equal(p.sessionsPerDay, 2, '4 sessions over 2 active days');
  assert.equal(p.avgUse, 50);
});
