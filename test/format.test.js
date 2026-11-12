const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../lib');

test('fmtAgoShort gives compact ages for narrow rows', () => {
  const now = Date.UTC(2026, 10, 9, 12, 0, 0);
  const min = 60 * 1000;
  assert.equal(lib.fmtAgoShort(0, now), '');
  assert.equal(lib.fmtAgoShort(now - 20 * 1000, now), 'now');
  assert.equal(lib.fmtAgoShort(now - 5 * min, now), '5m');
  assert.equal(lib.fmtAgoShort(now - 3 * 60 * min, now), '3h');
  assert.equal(lib.fmtAgoShort(now - 2 * 24 * 60 * min, now), '2d');
  assert.equal(lib.fmtAgoShort(now - 21 * 24 * 60 * min, now), '3w');
});

test('fmtResetShort shows a time today, a weekday soon, a date later', () => {
  const now = new Date(2026, 10, 9, 9, 0, 0); // local time, Monday 9 Nov 2026
  const today = lib.fmtResetShort(new Date(2026, 10, 9, 17, 59).toISOString(), now);
  assert.doesNotMatch(today, /Mon|Nov/, 'today shows only the time');
  assert.match(today, /5:59/);
  assert.match(lib.fmtResetShort(new Date(2026, 10, 13, 9, 29).toISOString(), now), /^Fri\b.*9:29/);
  assert.match(lib.fmtResetShort(new Date(2026, 10, 20, 9, 0).toISOString(), now), /Nov\s*20|20\s*Nov/);
  assert.equal(lib.fmtResetShort(null, now), '');
  assert.equal(lib.fmtResetShort('not a date', now), '');
});

test('fmtMoney drops .00 and keeps cents', () => {
  assert.equal(lib.fmtMoney(500), '$500');
  assert.equal(lib.fmtMoney(18.72), '$18.72');
  assert.equal(lib.fmtMoney(0.5), '$0.50');
  assert.equal(lib.fmtMoney(null), '');
});

test('historyDir follows a linked projects folder so shared history is read once', { skip: process.platform !== 'win32' && 'uses a Windows junction' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'history-'));
  const shared = path.join(base, 'shared');
  const one = path.join(base, 'one');
  const two = path.join(base, 'two');
  const solo = path.join(base, 'solo');
  for (const d of [path.join(shared, 'projects'), one, two, path.join(solo, 'projects')]) fs.mkdirSync(d, { recursive: true });
  for (const d of [one, two]) execFileSync('cmd', ['/c', 'mklink', '/J', path.join(d, 'projects'), path.join(shared, 'projects')], { stdio: 'ignore' });

  const norm = (p) => lib.normalizeDir(p);
  assert.equal(norm(lib.historyDir(one)), norm(shared));
  assert.equal(norm(lib.historyDir(two)), norm(shared));
  assert.equal(norm(lib.historyDir(solo)), norm(solo), 'a normal folder is its own history');
  assert.equal(norm(lib.historyDir(path.join(base, 'missing'))), norm(path.join(base, 'missing')), 'no history yet');
  fs.rmSync(base, { recursive: true, force: true });
});
