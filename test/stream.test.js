const test = require('node:test');
const assert = require('node:assert/strict');
const { LineReader, EventMapper, transcriptEvents, parseJsonl, toolSummary, userMessage, permissionAnswer, cliArgs, resultText } = require('../stream');

const se = (event, extra = {}) => ({ type: 'stream_event', event, parent_tool_use_id: null, ...extra });

test('LineReader joins split chunks and skips bad lines', () => {
  const r = new LineReader();
  assert.deepEqual(r.push('{"a":1}\n{"b"'), [{ a: 1 }]);
  assert.deepEqual(r.push(':2}\nnot json\n\n{"c":3}'), [{ b: 2 }]);
  assert.deepEqual(r.push('\n'), [{ c: 3 }]);
});

test('streamed text appears once, as block then deltas', () => {
  const m = new EventMapper();
  const ev = [
    se({ type: 'message_start', message: { id: 'msg1' } }),
    se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
    se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
    { type: 'assistant', message: { id: 'msg1', content: [{ type: 'text', text: 'Hello' }] } },
  ].flatMap((x) => m.map(x));
  assert.deepEqual(ev, [
    { t: 'block', id: 'b1', kind: 'text' },
    { t: 'delta', id: 'b1', text: 'Hel' },
    { t: 'delta', id: 'b1', text: 'lo' },
  ]);
});

test('thinking streams as its own block', () => {
  const m = new EventMapper();
  const ev = [
    se({ type: 'message_start', message: { id: 'm' } }),
    se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
    se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }),
    se({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'x' } }),
  ].flatMap((x) => m.map(x));
  assert.deepEqual(ev, [
    { t: 'block', id: 'b1', kind: 'thinking' },
    { t: 'delta', id: 'b1', text: 'hmm' },
  ]);
});

test('text that was not streamed comes from the full message', () => {
  const m = new EventMapper();
  const ev = m.map({ type: 'assistant', message: { id: 'x', content: [{ type: 'text', text: 'Hi' }] } });
  assert.deepEqual(ev, [
    { t: 'block', id: 'b1', kind: 'text' },
    { t: 'delta', id: 'b1', text: 'Hi' },
  ]);
});

test('tool calls and results', () => {
  const m = new EventMapper();
  const call = m.map({ type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'echo hi' } }] } });
  assert.deepEqual(call, [{ t: 'tool', id: 'tu1', name: 'Bash', input: { command: 'echo hi' } }]);
  const res = m.map({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'hi', is_error: false }] } });
  assert.deepEqual(res, [{ t: 'toolResult', id: 'tu1', text: 'hi', isError: false }]);
  const err = m.map({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: [{ type: 'text', text: 'boom' }], is_error: true }] } });
  assert.equal(err[0].isError, true);
  assert.equal(err[0].text, 'boom');
});

test('sub-agent messages are left out', () => {
  const m = new EventMapper();
  assert.deepEqual(m.map({ type: 'assistant', parent_tool_use_id: 'tu', message: { id: 'z', content: [{ type: 'text', text: 'inner' }] } }), []);
  assert.deepEqual(m.map(se({ type: 'message_start', message: { id: 'q' } }, { parent_tool_use_id: 'tu' })), []);
});

test('permission requests, cancels and control answers', () => {
  const m = new EventMapper();
  const [p] = m.map({
    type: 'control_request',
    request_id: 'r1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Write',
      display_name: 'Write',
      input: { file_path: 'a.txt', content: 'x' },
      description: 'a.txt',
      permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      tool_use_id: 'tu9',
    },
  });
  assert.equal(p.t, 'permission');
  assert.equal(p.requestId, 'r1');
  assert.equal(p.tool, 'Write');
  assert.equal(p.toolUseId, 'tu9');
  assert.equal(p.suggestions.length, 1);
  assert.deepEqual(m.map({ type: 'control_request', request_id: 'r2', request: { subtype: 'hook_callback' } }), []);
  assert.deepEqual(m.map({ type: 'control_cancel_request', request_id: 'r1' }), [{ t: 'permissionCancel', requestId: 'r1' }]);
  assert.deepEqual(m.map({ type: 'control_response', response: { subtype: 'success', request_id: 'i1', response: { models: [] } } }), [
    { t: 'control', requestId: 'i1', response: { models: [] }, error: null },
  ]);
  assert.equal(m.map({ type: 'control_response', response: { subtype: 'error', request_id: 'i2', error: 'nope' } })[0].error, 'nope');
});

test('init, status, usage, interrupt and result', () => {
  const m = new EventMapper();
  assert.deepEqual(m.map({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-x', cwd: 'D:\\p' }), [{ t: 'init', sessionId: 's1', model: 'claude-x', cwd: 'D:\\p' }]);
  assert.deepEqual(m.map({ type: 'system', subtype: 'status', status: 'requesting' }), [{ t: 'status', status: 'requesting' }]);
  assert.deepEqual(m.map({ type: 'system', subtype: 'task_summary' }), []);
  const rl = { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5 } } } };
  assert.deepEqual(m.map(rl), [{ t: 'usage', event: rl }]);
  assert.deepEqual(m.map({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }), [{ t: 'note', text: 'Interrupted' }]);
  assert.deepEqual(m.map({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 1200, result: 'ok' }), [
    { t: 'done', ok: true, subtype: 'success', cost: 0.01, durationMs: 1200, text: '' },
  ]);
  assert.equal(m.map({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'bad' })[0].text, 'bad');
  assert.deepEqual(m.map(null), []);
  assert.deepEqual(m.map({ type: 'weird' }), []);
});

test('transcriptEvents rebuilds a saved chat', () => {
  const text = [
    { type: 'queue-operation' },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Run echo hi' }] } },
    { type: 'user', isMeta: true, message: { content: 'hidden' } },
    { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
    { type: 'assistant', message: { id: 'a1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hi' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hi' }] } },
    { type: 'assistant', isSidechain: true, message: { id: 'side', content: [{ type: 'text', text: 'no' }] } },
    { type: 'assistant', message: { id: 'a2', content: [{ type: 'thinking', thinking: '', signature: 's' }] } },
    { type: 'assistant', message: { id: 'a2', content: [{ type: 'text', text: 'Done.' }] } },
  ]
    .map((o) => JSON.stringify(o))
    .join('\n');
  const ev = transcriptEvents(parseJsonl(`${text}\n{broken`));
  assert.deepEqual(ev, [
    { t: 'user', text: 'Run echo hi' },
    { t: 'tool', id: 't1', name: 'Bash', input: { command: 'echo hi' } },
    { t: 'toolResult', id: 't1', text: 'hi', isError: false },
    { t: 'block', id: 'b1', kind: 'text' },
    { t: 'delta', id: 'b1', text: 'Done.' },
  ]);
});

test('toolSummary picks the useful part', () => {
  assert.equal(toolSummary('Bash', { command: 'npm test', description: 'Run tests' }), 'Run tests');
  assert.equal(toolSummary('Bash', { command: 'ls' }), 'ls');
  assert.equal(toolSummary('Edit', { file_path: 'D:\\a\\b\\lib.js' }), 'lib.js');
  assert.equal(toolSummary('Read', { file_path: '/x/y.md' }), 'y.md');
  assert.equal(toolSummary('Grep', { pattern: 'foo' }), 'foo');
  assert.equal(toolSummary('TodoWrite', { todos: [1, 2] }), '2 items');
  assert.equal(toolSummary('mcp__x', { q: 'hello', n: 2 }), 'hello');
  assert.equal(toolSummary('Other', {}), '');
});

test('stdin messages', () => {
  assert.deepEqual(userMessage('hi', ['ctx', '']), {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'ctx' }, { type: 'text', text: 'hi' }] },
    parent_tool_use_id: null,
    session_id: '',
  });
  const sug = [{ type: 'setMode', mode: 'acceptEdits' }];
  assert.deepEqual(permissionAnswer('r', 'allow', { a: 1 }, sug).response.response, { behavior: 'allow', updatedInput: { a: 1 } });
  assert.deepEqual(permissionAnswer('r', 'always', { a: 1 }, sug).response.response.updatedPermissions, sug);
  assert.deepEqual(permissionAnswer('r', 'deny', {}, [], 'not now').response, { subtype: 'success', request_id: 'r', response: { behavior: 'deny', message: 'not now' } });
});

test('cliArgs', () => {
  const base = cliArgs();
  assert.ok(base.includes('stream-json') && base.includes('--permission-prompt-tool'));
  assert.ok(!base.includes('--resume') && !base.includes('--model'));
  const a = cliArgs({ resume: 'abc', model: 'sonnet', permissionMode: 'acceptEdits' });
  assert.deepEqual(a.slice(-6), ['--resume', 'abc', '--model', 'sonnet', '--permission-mode', 'acceptEdits']);
  assert.ok(!cliArgs({ model: 'default', permissionMode: 'default' }).includes('--model'));
});

test('resultText trims long output', () => {
  const long = 'x'.repeat(5000);
  assert.ok(resultText(long).length < 4100);
  assert.match(resultText(long), /more characters/);
  assert.equal(resultText([{ type: 'text', text: 'a' }, { type: 'image' }]), 'a\n[image]');
  assert.equal(resultText(undefined), '');
});
