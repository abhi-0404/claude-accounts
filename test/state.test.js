const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildState, folderLabel } = require('../state');

test('folderLabel shows the last folder name, or the drive for a root', () => {
  assert.equal(folderLabel({ cwd: 'D:\\work\\shop-api', projectKey: 'D--work-shop-api' }), 'shop-api');
  assert.equal(folderLabel({ cwd: 'D:\\', projectKey: 'D--' }), 'D:');
  assert.equal(folderLabel({ cwd: '', projectKey: 'E--x' }), 'E--x');
  // Started at D:\Shop API, folder later moved to D:\work\shop-api (and its history renamed to match).
  assert.equal(folderLabel({ cwd: 'd:\\Shop API', projectKey: 'D--work-shop-api' }, ['D:\\work\\shop-api']), 'shop-api');
});

test('buildState groups accounts, marks the active one and shares one history', { skip: process.platform !== 'win32' && 'uses a Windows junction' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'state-'));
  const shared = path.join(base, 'shared');
  const one = path.join(base, 'one');
  const two = path.join(base, 'two');
  const work = path.join(base, 'work');
  for (const d of [path.join(shared, 'projects'), one, two, path.join(work, 'projects')]) fs.mkdirSync(d, { recursive: true });
  for (const d of [one, two]) execFileSync('cmd', ['/c', 'mklink', '/J', path.join(d, 'projects'), path.join(shared, 'projects')], { stdio: 'ignore' });

  const accounts = [
    { label: 'One', group: 'Personal', configDir: one },
    { label: 'Two', group: 'Personal', configDir: two },
    { label: 'Studio', group: 'Work', configDir: work },
  ];
  const k = (d) => d.toLowerCase();
  const sharedKey = k(shared);
  const state = buildState({
    accounts,
    groups: ['Personal', 'Work'],
    activeDir: work,
    selectedKey: 'not-there',
    period: 'bogus',
    workspaceFolders: ['D:\\work\\shop-api'],
    status: new Map([[k(one), { loggedIn: true, email: 'a@b.c', plan: 'pro' }], [k(work), { loggedIn: true, email: 'w@k.co', plan: 'team', orgName: 'Shop API' }]]),
    plans: new Map([[k(work), { session: { percent: 3 }, weekly: { percent: 16 } }]]),
    chats: new Map([[sharedKey, [{ id: 's1', title: 'Hello', mtimeMs: 1, projectKey: 'D--', cwd: 'D:\\' }]]]),
    models: new Map(),
  });

  assert.deepEqual(state.groups.map((g) => [g.name, g.accounts.map((a) => a.label)]), [['Personal', ['One', 'Two']], ['Work', ['Studio']]]);
  assert.equal(state.selected, k(work), 'falls back to the active account');
  assert.equal(state.period, '7d');
  assert.equal(state.workspaceKey, 'd--work-shop-api');
  assert.equal(state.workspaceName, 'shop-api');
  const [oneView, twoView] = state.groups[0].accounts;
  assert.equal(oneView.status, 'signedIn');
  assert.equal(oneView.plan, 'Pro');
  assert.equal(twoView.status, 'checking');
  assert.equal(oneView.histKey, twoView.histKey, 'Personal accounts share one history');
  assert.deepEqual(state.histories[oneView.histKey].sharedWith, ['One', 'Two']);
  assert.equal(state.histories[oneView.histKey].sessions[0].folder, 'D:');
  const kaya = state.groups[1].accounts[0];
  assert.equal(kaya.active, true);
  assert.equal(kaya.usage.weekly.percent, 16);
  assert.notEqual(kaya.histKey, oneView.histKey, 'Work history stays separate');
  assert.equal(state.histories[kaya.histKey].loaded, false);
  fs.rmSync(base, { recursive: true, force: true });
});

test('model usage lists every model once, merging dated ids and dropping placeholders', () => {
  const row = (model, total) => ({ model, replies: 1, input: total, cacheRead: 0, output: 0, total });
  const usage = {
    last5h: [row('claude-opus-5-5', 10)],
    last7d: [row('claude-opus-5-5-20260301', 5), row('claude-opus-5-5', 5), row('<synthetic>', 99)],
    allTime: [row('claude-opus-5-5', 20), row('claude-sonnet-5-5', 8), row('claude-haiku-5-5', 2), row('<synthetic>', 99)],
  };
  const dir = 'C:\demo\acct';
  const key = require('../lib').normalizeDir(dir);
  const hk = require('../lib').normalizeDir(require('../lib').historyDir(dir));
  const state = buildState({
    accounts: [{ label: 'A', group: 'G', configDir: dir }],
    groups: ['G'],
    activeDir: dir,
    selectedKey: key,
    period: '7d',
    workspaceFolders: [],
    status: new Map(),
    plans: new Map(),
    chats: new Map([[hk, []]]),
    models: new Map([[hk, usage]]),
  });
  const m = Object.values(state.histories)[0].models;
  assert.deepEqual(m['7d'].map((r) => [r.name, r.total]), [['Opus 5.5', 10]]);
  assert.deepEqual(m.all.map((r) => r.name), ['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']);
});
