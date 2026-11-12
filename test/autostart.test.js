const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('../autostart');
const history = require('../history');

const NOW = Date.UTC(2026, 0, 1, 12, 0);
const MIN = 60e3;
const H = 60 * MIN;

test('a schedule is added once, in time order, and only if it makes sense', () => {
  let { list, error } = a.add([], { key: 'k', start: NOW + 5 * H }, NOW);
  assert.equal(error, null);
  ({ list } = a.add(list, { key: 'k', start: NOW + 5 * H }, NOW));
  assert.equal(list.length, 1, 'the same one is not added twice');
  ({ list } = a.add(list, { key: 'k', start: NOW + 1 * H }, NOW));
  assert.deepEqual(list.map((x) => x.start), [NOW + H, NOW + 5 * H]);
  assert.equal(a.add(list, { key: 'k', start: NOW - 1 }, NOW).error, 'past');
  assert.equal(a.add(list, { key: 'k', start: NOW + 30 * 24 * H }, NOW).error, 'too far ahead');
  assert.equal(a.add(list, { start: NOW + H }, NOW).error, 'invalid');
  assert.equal(a.add(list, { key: 'k', start: 'soon' }, NOW).error, 'invalid');
});

test('there is a limit, so a stray click cannot queue dozens', () => {
  let list = [];
  for (let i = 1; i <= a.MAX_SCHEDULED; i += 1) ({ list } = a.add(list, { key: 'k', start: NOW + i * H }, NOW));
  assert.equal(a.add(list, { key: 'k', start: NOW + 20 * H }, NOW).error, 'too many');
});

test('a schedule runs once when due, and a long-missed one is dropped instead of run', () => {
  const list = [{ key: 'k', start: NOW - 2 * MIN }, { key: 'k', start: NOW - 30 * MIN }, { key: 'k', start: NOW + 3 * H }];
  assert.deepEqual(a.due(list, NOW).map((x) => x.start), [NOW - 2 * MIN]);
  assert.deepEqual(a.missed(list, NOW).map((x) => x.start), [NOW - 30 * MIN]);
  assert.equal(a.next(list, NOW).start, NOW + 3 * H);
  const after = a.remove(list, { key: 'k', start: NOW - 2 * MIN });
  assert.equal(a.due(after, NOW).length, 0, 'once it ran it is gone');
});

test('nothing is sent when a window is already running or the account is signed out', () => {
  const running = { session: { percent: 10, resetsAt: new Date(NOW + 2 * H).toISOString() } };
  assert.match(a.skipReason(running, true, NOW), /already running/);
  assert.equal(a.skipReason({ session: { percent: 0, resetsAt: null } }, true, NOW), null);
  assert.equal(a.skipReason({ session: { percent: 5, resetsAt: new Date(NOW - H).toISOString() } }, true, NOW), null);
  assert.equal(a.skipReason(null, true, NOW), null);
  assert.equal(a.skipReason(running, false, NOW), 'signed out');
});

test('the message is tiny, cheap and leaves no chat behind', () => {
  const args = a.messageArgs();
  assert.deepEqual(args.slice(0, 2), ['-p', 'hi']);
  assert.ok(args.includes('haiku'));
  assert.ok(args.includes('--no-session-persistence'));
});

test('session windows run back to back from now to the weekly reset', () => {
  // Session resets in 2h; the week resets in 26h: current window, then 5h windows from 2h on.
  const plan = {
    session: { percent: 51, resetsAt: new Date(NOW + 2 * H).toISOString() },
    weekly: { percent: 11, resetsAt: new Date(NOW + 26 * H).toISOString() },
  };
  const al = history.weeklyAlert(plan, 0.12, NOW, { sessionsPerDay: 1, avgUse: 30, learned: true });
  assert.ok(al, 'an alert is expected here');
  const s = al.slots;
  assert.equal(s[0].current, true);
  assert.equal(s[0].start, NOW);
  assert.equal(s[0].end, NOW + 2 * H);
  assert.equal(s[0].left, 49);
  assert.equal(s[1].start, NOW + 2 * H);
  assert.equal(s[1].end, NOW + 7 * H);
  assert.equal(s[2].start, NOW + 7 * H);
  for (let i = 1; i < s.length; i += 1) assert.equal(s[i].start, s[i - 1].end, 'windows are back to back');
  assert.ok(s.at(-1).end <= NOW + 26 * H, 'nothing runs past the reset');
  assert.ok(s.every((x) => x.end - x.start >= H), 'slivers under an hour are left out');
});

test('with no window running, slots start now', () => {
  const plan = {
    session: { percent: 0, resetsAt: null },
    weekly: { percent: 10, resetsAt: new Date(NOW + 30 * H).toISOString() },
  };
  const al = history.weeklyAlert(plan, 0.12, NOW, { sessionsPerDay: 1, avgUse: 20, learned: true });
  assert.ok(al);
  assert.equal(al.slots[0].start, NOW);
  assert.equal(al.slots[0].current, undefined);
});

test('a schedule matches its window even when the reset time drifts by seconds or minutes', () => {
  let { list } = a.add([], { key: 'k', start: NOW + 5 * H }, NOW);
  ({ list } = a.add(list, { key: 'k', start: NOW + 5 * H + 40e3 }, NOW));
  assert.equal(list.length, 1, 'a drifted start is the same window');
  assert.equal(a.remove(list, { key: 'k', start: NOW + 5 * H + 3 * MIN }).length, 0, 'cancelling uses the same tolerance');
  ({ list } = a.add(list, { key: 'k', start: NOW + 5 * H + 20 * MIN }, NOW));
  assert.equal(list.length, 2, 'a different window is kept');
  ({ list } = a.add(list, { key: 'other', start: NOW + 5 * H }, NOW));
  assert.equal(list.length, 3, 'another account is separate');
});

test('the demo plan always raises an alert with windows', () => {
  const al = history.weeklyAlert(history.demoPlan(NOW), 0.12, NOW, { sessionsPerDay: 1.2, avgUse: 30, learned: true });
  assert.ok(al);
  assert.ok(al.slots.length >= 4);
  assert.equal(al.slots[0].current, true);
});

test('a window listed twice by an older build is merged into one', () => {
  const messy = [
    { key: 'k', start: NOW + 5 * H },
    { key: 'k', start: NOW + 5 * H + MIN },
    { key: 'k', start: NOW + 10 * H },
    { key: 'k', start: NOW + 10 * H + MIN },
    { key: 'other', start: NOW + 5 * H },
    null,
    { key: 'k', start: 'x' },
  ];
  const clean = a.normalize(messy);
  assert.equal(clean.length, 3);
  assert.deepEqual(clean.filter((x) => x.key === 'k').map((x) => x.start), [NOW + 5 * H, NOW + 10 * H]);
  assert.deepEqual(a.normalize(undefined), []);
});

test('it fires just after the window opens, not before', () => {
  const list = [{ key: 'k', start: NOW }];
  assert.equal(a.due(list, NOW + 10e3).length, 0, 'not at the very start');
  assert.equal(a.due(list, NOW + a.FIRE_DELAY_MS).length, 1, 'once the short delay has passed');
  assert.equal(a.next(list, NOW + 10e3).start, NOW, 'still waiting during the delay');
  assert.equal(a.next(list, NOW + a.FIRE_DELAY_MS + 1), null);
});

test('window times are whole minutes and do not wobble between checks', () => {
  const mk = (jitterMs) => ({
    session: { percent: 61, resetsAt: new Date(NOW + 2 * H + jitterMs).toISOString() },
    weekly: { percent: 13, resetsAt: new Date(NOW + 26 * H + 30 * MIN + jitterMs).toISOString() },
  });
  const pace = { sessionsPerDay: 1, avgUse: 30, learned: true };
  const first = history.weeklyAlert(mk(-150), 0.12, NOW, pace).slots;
  const second = history.weeklyAlert(mk(+150), 0.12, NOW, pace).slots;
  assert.deepEqual(first.map((s) => [s.start, s.end]), second.map((s) => [s.start, s.end]));
  for (const s of first.slice(1)) assert.equal(s.start % 60000, 0);
});
