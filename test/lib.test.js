const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const lib = require('../lib');

test('envListWithDir sets, replaces and removes CLAUDE_CONFIG_DIR, keeping other variables', () => {
  const start = [{ name: 'FOO', value: '1' }];
  const work = lib.envListWithDir(start, 'D:\\.claude-kaya');
  assert.deepEqual(work, [{ name: 'FOO', value: '1' }, { name: 'CLAUDE_CONFIG_DIR', value: 'D:\\.claude-kaya' }]);
  const other = lib.envListWithDir(work, 'D:\\.claude-personal\\doli');
  assert.deepEqual(other, [{ name: 'FOO', value: '1' }, { name: 'CLAUDE_CONFIG_DIR', value: 'D:\\.claude-personal\\doli' }]);
  assert.deepEqual(lib.envListWithDir(other, ''), [{ name: 'FOO', value: '1' }]);
  assert.deepEqual(lib.envListWithDir(undefined, ''), []);
});

test('activeDirFromEnvList reads the current folder, or empty for the default', () => {
  assert.equal(lib.activeDirFromEnvList([{ name: 'CLAUDE_CONFIG_DIR', value: 'D:\\.claude-kaya' }]), 'D:\\.claude-kaya');
  assert.equal(lib.activeDirFromEnvList([]), '');
  assert.equal(lib.activeDirFromEnvList(undefined), '');
});

test('terminalEnvWithDir sets and removes the variable without touching others', () => {
  assert.deepEqual(lib.terminalEnvWithDir({ A: 'x' }, 'D:\\.claude-kaya'), { A: 'x', CLAUDE_CONFIG_DIR: 'D:\\.claude-kaya' });
  assert.deepEqual(lib.terminalEnvWithDir({ A: 'x', CLAUDE_CONFIG_DIR: 'D:\\old' }, ''), { A: 'x' });
});

test('normalizeDir treats slashes, case and trailing separators as the same folder', () => {
  assert.equal(lib.normalizeDir('D:/.claude-kaya/'), lib.normalizeDir('d:\\.CLAUDE-KAYA'));
  assert.equal(lib.normalizeDir(''), lib.normalizeDir(undefined));
});

test('parseStatus handles signed-in, signed-out and garbage output', () => {
  const signedIn = lib.parseStatus('{"loggedIn":true,"email":"a@b.co","orgName":"Shop API","subscriptionType":"team"}');
  assert.deepEqual(signedIn, { loggedIn: true, email: 'a@b.co', orgName: 'Shop API', plan: 'team', configDirectory: '' });
  assert.equal(lib.parseStatus('{"loggedIn":false,"authMethod":"none"}').loggedIn, false);
  assert.equal(lib.parseStatus('not json'), null);
  assert.equal(lib.describe(signedIn), 'a@b.co · Team');
  assert.equal(lib.describe({ loggedIn: false }), 'not signed in');
});

let hasClaude = true;
try {
  execFileSync('claude', ['--version'], { stdio: 'ignore', windowsHide: true });
} catch {
  hasClaude = false;
}

test('readStatus reports a login folder that was never signed in as signed out', { skip: !hasClaude && 'claude CLI not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'never-signed-in-'));
  try {
    const status = await lib.readStatus(dir);
    assert.equal(status.loggedIn, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
