const test = require('node:test');
const assert = require('node:assert/strict');
const { planFromLive, mergePlans, liveKey, planFromEvent, choosePlan, applyResets, nextReset } = require('../live');

test('applyResets drops a passed window to 0% and remembers when it reset', () => {
  const now = Date.UTC(2026, 10, 10, 18, 0, 0);
  const plan = {
    fetchedAt: now - 3600e3,
    session: { percent: 64, resetsAt: new Date(now - 1000).toISOString(), severity: 'normal' },
    weekly: { percent: 30, resetsAt: new Date(now + 86400e3).toISOString(), severity: 'normal' },
    extra: { used: 5 },
  };
  const { plan: after, reset } = applyResets(plan, now);
  assert.deepEqual(reset, ['session']);
  assert.equal(after.session.percent, 0);
  assert.equal(after.session.resetAt, plan.session.resetsAt);
  assert.equal(after.weekly.percent, 30, 'weekly not yet reset');
  assert.equal(after.extra.used, 5);
  assert.equal(after.fetchedAt, now);
  assert.deepEqual(applyResets(after, now + 1000).reset, [], 'only once');
  assert.equal(nextReset([plan], now), now + 86400e3);
  assert.equal(nextReset([after, null], now), now + 86400e3);
  assert.equal(nextReset([], now), 0);
});

test('liveKey matches the relay file names', () => {
  assert.equal(liveKey('D:\\.claude-kaya'), 'd---claude-kaya');
  assert.equal(liveKey('D:/.claude-personal/abhishek/'), 'd---claude-personal-abhishek');
  assert.equal(liveKey(''), 'default');
});

test('planFromEvent reads a per-reply usage message', () => {
  // The exact shape Claude sent in testing (utilization is a fraction, resetsAt is Unix seconds).
  const record = {
    at: 5000,
    configDir: '',
    event: {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        unifiedWindows: {
          five_hour: { utilization: 0.6, resetsAt: 1794247800, status: 'allowed' },
          seven_day: { utilization: 0.33, resetsAt: 1794286800, status: 'allowed_warning' },
        },
      },
    },
  };
  const prev = { extra: { used: 18.72, limit: 500 }, breakdown: [{ name: 'Opus', percent: 10 }] };
  const plan = planFromEvent(record, prev);
  assert.equal(plan.session.percent, 60);
  assert.equal(plan.session.resetsAt, new Date(1794247800 * 1000).toISOString());
  assert.equal(plan.weekly.percent, 33);
  assert.equal(plan.weekly.severity, 'warning');
  assert.equal(plan.fetchedAt, 5000);
  assert.equal(plan.live, true);
  assert.equal(plan.extra.used, 18.72, 'extra credits carry over');
  // A window that is gone has reset: it is not carried over.
  const reset = planFromEvent({ ...record, event: { ...record.event, rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.4 } } } } }, plan);
  assert.equal(reset.session, null);
  assert.equal(reset.weekly.percent, 40);
  assert.equal(planFromEvent({ at: 1, event: { type: 'assistant' } }), null);
  assert.equal(planFromEvent(null), null);
});

test('choosePlan keeps the newest numbers and fills missing fields', () => {
  const older = { fetchedAt: 100, session: { percent: 10 }, extra: { used: 5 }, breakdown: [{ name: 'x', percent: 1 }] };
  const newer = { fetchedAt: 200, session: { percent: 12 }, extra: null, breakdown: [] };
  const a = choosePlan(older, newer);
  assert.equal(a.session.percent, 12);
  assert.equal(a.extra.used, 5);
  assert.equal(a.breakdown.length, 1);
  const b = choosePlan(newer, older); // an older candidate never replaces newer numbers
  assert.equal(b.session.percent, 12);
  assert.equal(choosePlan(null, older), older);
  assert.equal(choosePlan(older, null), older);
});

// Shapes seen from `get_usage`: with a limits list, and without one (five_hour / seven_day only).
const withLimits = {
  rate_limits: {
    five_hour: { utilization: 18, resets_at: '2026-11-09T18:19:59Z' },
    seven_day: { utilization: 19, resets_at: '2026-11-14T03:59:59Z' },
    limits: [
      { kind: 'session', group: 'session', percent: 18, severity: 'normal', resets_at: '2026-11-09T18:19:59Z' },
      { kind: 'weekly_all', group: 'weekly', percent: 19, severity: 'normal', resets_at: '2026-11-14T03:59:59Z' },
    ],
    spend: { enabled: true, used: { amount_minor: 1872, exponent: 2 }, limit: { amount_minor: 50000, exponent: 2 }, percent: 4 },
  },
};
const withoutLimits = {
  rate_limits: {
    five_hour: { utilization: 21, resets_at: '2026-11-09T18:19:59Z' },
    seven_day: { utilization: 19, resets_at: '2026-11-14T03:59:59Z' },
  },
};

test('planFromLive reads both answer shapes', () => {
  const a = planFromLive(withLimits, 1000);
  assert.equal(a.session.percent, 18);
  assert.equal(a.weekly.percent, 19);
  assert.equal(a.extra.used, 18.72);
  assert.equal(a.extra.limit, 500);
  const b = planFromLive(withoutLimits, 1000);
  assert.equal(b.session.percent, 21);
  assert.equal(b.weekly.percent, 19);
  assert.equal(b.extra, null);
  assert.equal(planFromLive({ rate_limits: null }), null);
  assert.equal(planFromLive(undefined), null);
});

test('mergePlans keeps the honest age and fills fields the answer left out', () => {
  const saved = { ...planFromLive(withLimits, 5000), fetchedAt: 5000 };
  // Same numbers as Claude's saved copy: the age is the saved fetch time, not "now".
  const same = mergePlans(planFromLive(withLimits, 9000), saved, null, 9000);
  assert.equal(same.fetchedAt, 5000);
  // New numbers: they are fresh, and extra credits carry over from what was known.
  const fresh = mergePlans(planFromLive(withoutLimits, 9000), saved, null, 9000);
  assert.equal(fresh.fetchedAt, 9000);
  assert.equal(fresh.session.percent, 21);
  assert.equal(fresh.extra.used, 18.72);
  // No answer: keep what is known.
  assert.equal(mergePlans(null, saved, null), saved);
  assert.equal(mergePlans(null, null, null), null);
});
