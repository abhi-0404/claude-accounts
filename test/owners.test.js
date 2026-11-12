const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../lib');

const line = (o) => JSON.stringify(o);

test('each chat knows which accounts ran it, and each login folder its account id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-owners-'));
  const project = path.join(dir, 'projects', 'D--work-app');
  fs.mkdirSync(project, { recursive: true });
  const owner = (id) => line({ type: 'session-owner', accountUuid: id, organizationUuid: 'org', sessionId: 's' });
  fs.writeFileSync(path.join(project, 'one.jsonl'), [owner('AAAA1111-0000'), line({ type: 'user', cwd: 'D:\\work\\app', message: { content: 'hi' } }), owner('aaaa1111-0000')].join('\n') + '\n');
  fs.writeFileSync(path.join(project, 'two.jsonl'), [owner('aaaa1111-0000'), line({ type: 'user', message: { content: 'x' } }), owner('bbbb2222-0000')].join('\n') + '\n');
  fs.writeFileSync(path.join(project, 'old.jsonl'), line({ type: 'user', message: { content: 'from before' } }) + '\n');
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'AAAA1111-0000', emailAddress: 'x' } }));
  try {
    const byId = Object.fromEntries((await lib.listSessions(dir)).map((s) => [s.id, s.owners.sort()]));
    assert.deepEqual(byId, { one: ['aaaa1111-0000'], two: ['aaaa1111-0000', 'bbbb2222-0000'], old: [] });
    assert.equal(await lib.readAccountId(dir), 'aaaa1111-0000');
    assert.equal(await lib.readAccountId(path.join(dir, 'missing')), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
