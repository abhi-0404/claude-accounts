const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../lib');

const line = (o) => JSON.stringify(o);

function makeAccount() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-'));
  const project = path.join(dir, 'projects', 'D--work-demo-app');
  fs.mkdirSync(path.join(project, 'bbbb', 'subagents'), { recursive: true });

  // Chat A: AI title that changes over time; the latest one wins.
  fs.writeFileSync(
    path.join(project, 'aaaa.jsonl'),
    [
      line({ type: 'user', cwd: 'D:\\work\\demo-app', message: { content: 'Fix the login bug' } }),
      line({ type: 'ai-title', aiTitle: 'Login bug', sessionId: 'aaaa' }),
      line({ type: 'ai-title', aiTitle: 'Login bug fix and tests', sessionId: 'aaaa' }),
    ].join('\n') + '\n'
  );
  // Chat B: user-set title beats the AI title; its subagent transcript is not a separate chat.
  fs.writeFileSync(
    path.join(project, 'bbbb.jsonl'),
    [
      line({ type: 'user', cwd: 'D:\\work\\demo-app', message: { content: [{ type: 'text', text: 'Write the README' }] } }),
      line({ type: 'custom-title', customTitle: 'Docs sprint', sessionId: 'bbbb' }),
      line({ type: 'ai-title', aiTitle: 'README writing', sessionId: 'bbbb' }),
    ].join('\n') + '\n'
  );
  fs.writeFileSync(path.join(project, 'bbbb', 'subagents', 'agent-1.jsonl'), line({ type: 'user', message: { content: 'sub' } }) + '\n');
  // Chat C: no titles at all, so the first real prompt is used (command echoes skipped).
  fs.writeFileSync(
    path.join(project, 'cccc.jsonl'),
    [
      line({ type: 'user', isMeta: true, message: { content: 'Caveat: system text' } }),
      line({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }),
      line({ type: 'user', message: { content: 'Plan the   database\nmigration' } }),
    ].join('\n') + '\n'
  );
  const now = Date.now() / 1000;
  fs.utimesSync(path.join(project, 'aaaa.jsonl'), now - 300, now - 300);
  fs.utimesSync(path.join(project, 'bbbb.jsonl'), now - 60, now - 60);
  fs.utimesSync(path.join(project, 'cccc.jsonl'), now - 900, now - 900);
  return dir;
}

test('listSessions returns real chats newest first with the right titles', async () => {
  const dir = makeAccount();
  const sessions = await lib.listSessions(dir);
  assert.deepEqual(sessions.map((s) => s.id), ['bbbb', 'aaaa', 'cccc']);
  assert.deepEqual(sessions.map((s) => s.title), ['Docs sprint', 'Login bug fix and tests', 'Plan the database migration']);
  assert.equal(sessions[0].cwd, 'D:\\work\\demo-app');
  assert.equal(sessions[0].projectKey, 'D--work-demo-app');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('desktop app side file title wins', async () => {
  const dir = makeAccount();
  const side = path.join(dir, 'projects', 'D--work-demo-app', 'aaaa');
  fs.mkdirSync(side, { recursive: true });
  fs.writeFileSync(path.join(side, 'custom-title.json'), JSON.stringify({ customTitle: 'Named in the app' }));
  const sessions = await lib.listSessions(dir);
  assert.equal(sessions.find((s) => s.id === 'aaaa').title, 'Named in the app');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('encodeProjectPath matches how Claude names history folders', () => {
  assert.equal(lib.encodeProjectPath('D:\\work\\shop-api'), 'D--work-shop-api');
  assert.equal(lib.encodeProjectPath('d:\\Shop API'), 'd--Shop-API');
  assert.equal(lib.encodeProjectPath('C:\\Users\\kumar\\.claude'), 'C--Users-kumar--claude');
});

test('resolveProjectDir finds a folder from its history name, even with hyphens in names', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-'));
  const target = path.join(base, 'my-app', 'api-v2');
  fs.mkdirSync(target, { recursive: true });
  const found = await lib.resolveProjectDir(lib.encodeProjectPath(target));
  assert.equal(found && found.toLowerCase(), target.toLowerCase());
  assert.equal(await lib.resolveProjectDir(lib.encodeProjectPath(target), [target]), target, 'a matching hint is used directly');
  assert.equal(await lib.resolveProjectDir('Z--definitely-not-here'), null);
  fs.rmSync(base, { recursive: true, force: true });
});

