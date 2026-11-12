const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../remind');

const H = 3600e3;
const T = Date.UTC(2026, 10, 12, 10, 0);
const alert = (level = 'reminder', resetsAt = '2026-11-13T06:00:00.095510+00:00') => ({ level, resetsAt });
const on = { focused: true, inSession: false };

test('refreshing does not repeat the notification (reset times arrive with tiny differences)', () => {
  let { notify, state } = r.decide(r.empty(), 'k', alert(), T, on);
  assert.equal(notify, true);
  for (const variant of ['2026-11-13T06:00:00Z', '2026-11-13T05:59:59.836Z', '2026-11-13T06:00:00.1+00:00']) {
    for (let i = 1; i <= 50; i += 1) {
      const d = r.decide(state, 'k', alert('reminder', variant), T + i * 30e3 + 5 * H, on);
      assert.equal(d.notify, false, `refresh ${i} with ${variant}`);
    }
  }
});

test('a reset exactly on a half hour (11:30) does not look like a new week on every refresh', () => {
  // Rounding to the hour flipped between two values at xx:30:00 with sub-second jitter: this was the bug.
  const base = Date.UTC(2026, 10, 13, 6, 0); // 11:30 India time
  let state = r.empty();
  let shown = 0;
  for (let i = 0; i < 400; i += 1) {
    const jitter = (i % 2 ? 1 : -1) * (200 + (i % 7) * 100); // +-0.2 to 0.8 seconds
    const resetsAt = new Date(base + jitter).toISOString();
    const d = r.decide(state, 'work', alert('reminder', resetsAt), T + i * 30e3 + 6 * H, on);
    if (d.notify) {
      shown += 1;
      state = d.state;
    }
  }
  assert.equal(shown, 1, 'exactly one notification over 400 refreshes');
});

test('the stable cycle name does not change between refreshes (so lock files match across windows)', () => {
  const base = Date.UTC(2026, 10, 13, 6, 0);
  const first = r.decide(r.empty(), 'k', alert('reminder', new Date(base - 400).toISOString()), T, on);
  const again = r.decide(first.state, 'k', alert('reminder', new Date(base + 700).toISOString()), T + 60e3, on);
  assert.equal(again.cycle, first.cycle);
});

test('a reminder can become final once, never more than twice a week', () => {
  let { state } = r.decide(r.empty(), 'k', alert('reminder'), T, on);
  let d = r.decide(state, 'k', alert('final'), T + 30 * 60e3, on);
  assert.equal(d.notify, false, 'too soon after the reminder');
  d = r.decide(state, 'k', alert('final'), T + 2 * H, on);
  assert.equal(d.notify, true, 'the escalation shows');
  state = d.state;
  assert.equal(r.decide(state, 'k', alert('final'), T + 30 * H, on).notify, false);
  assert.equal(r.decide(state, 'k', alert('reminder'), T + 30 * H, on).notify, false, 'never back down to a reminder');
});

test('a new week starts fresh', () => {
  const { state } = r.decide(r.empty(), 'k', alert(), T, on);
  assert.equal(r.decide(state, 'k', alert('reminder', '2026-11-20T06:00:00Z'), T + 7 * 24 * H, on).notify, true);
});

test('not while you are using that account, and not in an unfocused window: it waits', () => {
  assert.equal(r.decide(r.empty(), 'k', alert(), T, { focused: true, inSession: true }).notify, false);
  assert.equal(r.decide(r.empty(), 'k', alert(), T, { focused: false, inSession: false }).notify, false);
  assert.equal(r.decide(r.empty(), 'k', alert(), T + H, on).notify, true, 'shows later once you are free');
});

test('several accounts do not pile up: one reminder per 4 hours', () => {
  let { state } = r.decide(r.empty(), 'a', alert(), T, on);
  assert.equal(r.decide(state, 'b', alert(), T + H, on).notify, false);
  const d = r.decide(state, 'b', alert(), T + 4 * H, on);
  assert.equal(d.notify, true);
  state = d.state;
  assert.equal(r.decide(state, 'c', alert('final'), T + 4.5 * H, on).notify, false, 'even final waits an hour');
  assert.equal(r.decide(state, 'c', alert('final'), T + 5.1 * H, on).notify, true);
});

test('a test alert always shows once, and bad input never throws', () => {
  const { state } = r.decide(r.empty(), 'k', alert(), T, on);
  assert.equal(r.decide(state, 'k', { ...alert(), simulated: true }, T + 60e3, on).notify, true);
  assert.equal(r.decide(undefined, 'k', null, T, on).notify, false);
  assert.equal(r.decide({ cycles: null, lastAt: 'x' }, 'k', { level: 'reminder', resetsAt: 'soon' }, T, on).notify, false);
  assert.doesNotThrow(() => r.decide({ shown: { a: 1 }, lastAt: 5 }, 'k', alert(), T + 9 * H, on), 'state saved by an older build is accepted');
});
