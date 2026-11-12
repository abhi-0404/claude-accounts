const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../rating');

const T0 = Date.UTC(2026, 0, 1);
const later = (days) => T0 + days * r.DAY;
const used = (n = 3) => {
  let s = r.empty(T0);
  for (let i = 0; i < n; i += 1) s = r.record(s, 'switch', T0);
  return s;
};

test('never asks on day one, however much it was used', () => {
  assert.equal(r.shouldAsk(used(50), later(0.5)), false);
  assert.equal(r.shouldHint(used(50), later(2)), false);
});

test('never asks before it has clearly helped', () => {
  assert.equal(r.shouldAsk(r.record(r.empty(T0), 'switch', T0), later(10)), false);
  assert.equal(r.shouldAsk(r.empty(T0), later(30)), false);
});

test('asks after a few days and a few switches, or enough chats', () => {
  assert.equal(r.shouldAsk(used(3), later(3)), true);
  let s = r.empty(T0);
  for (let i = 0; i < 8; i += 1) s = r.record(s, 'chat', T0);
  assert.equal(r.shouldAsk(s, later(4)), true);
});

test('asks at most twice, a month apart', () => {
  let s = used(5);
  assert.equal(r.shouldAsk(s, later(5)), true);
  s = r.asked(s, later(5));
  assert.equal(r.shouldAsk(s, later(20)), false, 'too soon after the first ask');
  assert.equal(r.shouldAsk(s, later(36)), true, 'a month later is fine');
  s = r.asked(s, later(36));
  assert.equal(r.shouldAsk(s, later(200)), false, 'never a third time');
});

test('"Maybe Later" and closing the notification change nothing but the snooze', () => {
  let s = r.asked(used(5), later(5));
  s = r.choose(s, 'later');
  assert.equal(s.rated, false);
  assert.equal(s.optOut, false);
  assert.equal(r.shouldAsk(s, later(10)), false);
  assert.equal(r.shouldHint(s, later(10)), true, 'the quiet panel link is still there');
});

test('rating or "Don\'t Ask Again" stops everything for good', () => {
  const rated = r.choose(used(5), 'rate');
  assert.equal(r.shouldAsk(rated, later(400)), false);
  assert.equal(r.shouldHint(rated, later(400)), false);
  const never = r.choose(used(5), 'never');
  assert.equal(r.shouldAsk(never, later(400)), false);
  assert.equal(r.shouldHint(never, later(400)), false);
});

test('hiding the panel link keeps it hidden, and does not block the one notification', () => {
  const s = r.hideHint(used(5));
  assert.equal(r.shouldHint(s, later(10)), false);
  assert.equal(r.shouldAsk(s, later(10)), true);
});

test('old or partial saved state is repaired, not trusted', () => {
  assert.doesNotThrow(() => r.shouldAsk({}, later(10)));
  assert.doesNotThrow(() => r.shouldHint(undefined, later(10)));
  assert.equal(r.shouldAsk({ switches: 'x', firstRun: 'y' }, later(10)), false);
});
