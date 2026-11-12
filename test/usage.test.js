const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../lib');

// Same shape Claude caches in .claude.json (trimmed).
const CACHED = {
  cachedUsageUtilization: {
    fetchedAtMs: 1794213602233,
    utilization: {
      five_hour: { utilization: 88, resets_at: '2026-11-09T10:00:00+00:00' },
      seven_day: { utilization: 24, resets_at: '2026-11-10T05:00:00+00:00' },
      limits: [
        { kind: 'session', group: 'session', percent: 88, severity: 'warning', resets_at: '2026-11-09T10:00:00+00:00' },
        { kind: 'weekly_all', group: 'weekly', percent: 24, severity: 'normal', resets_at: '2026-11-10T05:00:00+00:00' },
      ],
      spend: { enabled: true, percent: 4, used: { amount_minor: 1872, currency: 'USD', exponent: 2 }, limit: { amount_minor: 50000, exponent: 2 } },
      seven_day_breakdown: { rows: [{ key: 'claude_code', display_name: 'Claude Code', percent: 93 }, { key: 'chat', display_name: 'Chats', percent: 7 }, { key: 'other', display_name: 'Other', percent: 0 }] },
    },
  },
};

test('parsePlanUsage reads session, weekly, extra spend and breakdown', () => {
  const p = lib.parsePlanUsage(CACHED);
  assert.deepEqual(p.session, { percent: 88, resetsAt: '2026-11-09T10:00:00+00:00', severity: 'warning' });
  assert.equal(p.weekly.percent, 24);
  assert.deepEqual(p.extra, { used: 18.72, limit: 500, currency: 'USD', percent: 4 });
  assert.deepEqual(p.breakdown, [{ name: 'Claude Code', percent: 93 }, { name: 'Chats', percent: 7 }]);
  assert.equal(p.fetchedAt, 1794213602233);
});

test('parsePlanUsage falls back to five_hour / seven_day and handles missing data', () => {
  const p = lib.parsePlanUsage({ cachedUsageUtilization: { utilization: { five_hour: { utilization: 12 }, seven_day: { utilization: 3 }, spend: { enabled: false } } } });
  assert.equal(p.session.percent, 12);
  assert.equal(p.weekly.percent, 3);
  assert.equal(p.extra, null);
  assert.equal(lib.parsePlanUsage({}), null);
});

function reply(id, model, ts, usage) {
  return JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, usage } });
}

test('model usage counts each reply once, skips non-replies, and splits by time window', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-accounts-'));
  const project = path.join(dir, 'projects', 'D--work-demo');
  fs.mkdirSync(path.join(project, 'session-a', 'subagents'), { recursive: true });
  const now = Date.parse('2026-11-09T12:00:00Z');
  const u = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 20 };
  fs.writeFileSync(
    path.join(project, 'session-a.jsonl'),
    [
      JSON.stringify({ type: 'user', message: { content: 'hi "usage" "assistant"' } }),
      reply('m1', 'claude-opus-5-5', '2026-11-09T11:00:00Z', u),
      reply('m1', 'claude-opus-5-5', '2026-11-09T11:00:00Z', u), // same reply, second content block
      reply('m2', 'claude-sonnet-5-5', '2026-11-05T11:00:00Z', u),
      reply('m3', 'claude-opus-5-5', '2026-10-01T11:00:00Z', u),
      reply('m4', '<synthetic>', '2026-11-09T11:30:00Z', u),
      'not json',
    ].join('\n') + '\n'
  );
  fs.writeFileSync(path.join(project, 'session-a', 'subagents', 'agent-1.jsonl'), reply('s1', 'claude-haiku-4-5-20251001', '2026-11-09T11:10:00Z', u) + '\n');

  const usage = await lib.readModelUsage(dir, now);
  assert.equal(usage.sessions, 1, 'subagent transcripts are not separate chats');
  const fiveHour = Object.fromEntries(usage.last5h.map((r) => [r.model, r.replies]));
  assert.deepEqual(fiveHour, { 'claude-opus-5-5': 1, 'claude-haiku-4-5-20251001': 1 }, 'older replies and <synthetic> are left out');
  assert.equal(usage.last7d.find((r) => r.model === 'claude-sonnet-5-5').replies, 1);
  const opusAll = usage.allTime.find((r) => r.model === 'claude-opus-5-5');
  assert.equal(opusAll.replies, 2);
  assert.equal(opusAll.input, 30);
  assert.equal(opusAll.cacheRead, 200);
  assert.equal(opusAll.output, 40);
  assert.equal(opusAll.total, 270);

  // Appending a new reply is picked up without re-counting the old ones.
  fs.appendFileSync(path.join(project, 'session-a.jsonl'), reply('m5', 'claude-opus-5-5', '2026-11-09T11:50:00Z', u) + '\n');
  const again = await lib.readModelUsage(dir, now);
  assert.equal(again.allTime.find((r) => r.model === 'claude-opus-5-5').replies, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('formatting helpers', () => {
  assert.equal(lib.modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(lib.modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(lib.modelName('claude-sonnet-4-20250514'), 'Sonnet 4');
  assert.equal(lib.modelName('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(lib.fmtTokens(950), '950');
  assert.equal(lib.fmtTokens(12_400), '12K');
  assert.equal(lib.fmtTokens(3_450_000), '3.5M');
  assert.equal(lib.bar(80), '\u2588'.repeat(8) + '\u2591'.repeat(2));
  assert.equal(lib.bar(0), '\u2591'.repeat(10));
  assert.equal(lib.fmtAgo(Date.now() - 5 * 60000), '5 min ago');
});

test('real accounts on this machine report plan and model usage', { skip: !fs.existsSync('D:\\.claude-kaya') && 'no local accounts' }, async () => {
  const work = await lib.readPlanUsage('D:\\.claude-kaya');
  assert.ok(work && work.session && work.weekly, 'work plan usage present');
  const personal = await lib.readPlanUsage('');
  assert.ok(personal && personal.session, 'personal plan usage present');
  const models = await lib.readModelUsage('D:\\.claude-kaya');
  assert.ok(models.sessions >= 1);
  assert.ok(models.allTime.length >= 1 && models.allTime[0].replies > 0);
});
