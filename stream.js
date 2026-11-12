// Reads the Claude CLI's stream-json output and turns it into small UI events for the chat tab.
// Pure Node (no VS Code API) so it can be tested with `node --test`.

const MAX_RESULT = 4000; // characters of a tool result kept for the tab

/** Splits a byte stream into complete JSON lines. Bad lines are skipped, partial lines wait for more. */
class LineReader {
  constructor() {
    this.buf = '';
  }

  /** Returns the parsed objects from all complete lines in `chunk`. */
  push(chunk) {
    this.buf += String(chunk);
    const out = [];
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // not JSON (a stray log line): ignore
      }
    }
    return out;
  }
}

/** Plain text of a tool result's content (a string, or text and image blocks). */
function resultText(content) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.map((c) => (c && c.type === 'text' ? c.text : c && c.type === 'image' ? '[image]' : '')).join('\n');
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n... (${text.length - MAX_RESULT} more characters)` : text;
}

/** User-typed text of a message, or '' for tool results and system notes. */
function userText(message) {
  const c = message && message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;

/**
 * Turns CLI messages into UI events. Keeps a little state so text streamed word by word is not shown
 * a second time when the complete message arrives.
 *
 * Events:
 *   { t: 'init', sessionId, model, cwd }
 *   { t: 'block', id, kind: 'text' | 'thinking' }   a new text or thinking block starts
 *   { t: 'delta', id, text }                        more text for that block
 *   { t: 'tool', id, name, input }                  a tool call (input complete)
 *   { t: 'toolResult', id, text, isError }
 *   { t: 'note', text }                             e.g. "Interrupted"
 *   { t: 'permission', requestId, tool, input, description, suggestions, toolUseId }
 *   { t: 'permissionCancel', requestId }
 *   { t: 'status', status }                         'requesting', 'compacting' or null
 *   { t: 'usage', event }                           the rate_limit_event, for the panel
 *   { t: 'done', ok, subtype, cost, durationMs, text }
 *   { t: 'control', requestId, response, error }    answer to a control request we sent
 */
class EventMapper {
  constructor() {
    this.streamed = new Set(); // message ids whose text came through stream events
    this.blocks = new Map(); // `${messageId}:${index}` -> block id
    this.messageId = '';
    this.n = 0;
  }

  /** Returns the UI events for one CLI message. */
  map(m) {
    if (!m || typeof m !== 'object') return [];
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') return [{ t: 'init', sessionId: m.session_id || '', model: m.model || '', cwd: m.cwd || '' }];
        if (m.subtype === 'status') return [{ t: 'status', status: m.status || null }];
        if (m.subtype === 'compact_boundary') return [{ t: 'note', text: 'Conversation compacted' }];
        return [];
      case 'stream_event':
        return this.streamEvent(m.event || {}, m.parent_tool_use_id);
      case 'assistant':
        return this.assistant(m);
      case 'user':
        return this.user(m);
      case 'result':
        return [
          {
            t: 'done',
            ok: !m.is_error,
            subtype: m.subtype || '',
            cost: Number.isFinite(m.total_cost_usd) ? m.total_cost_usd : null,
            durationMs: Number.isFinite(m.duration_ms) ? m.duration_ms : null,
            text: m.is_error && typeof m.result === 'string' ? m.result : '',
          },
        ];
      case 'rate_limit_event':
        return [{ t: 'usage', event: m }];
      case 'control_request': {
        const r = m.request || {};
        if (r.subtype !== 'can_use_tool') return [];
        return [
          {
            t: 'permission',
            requestId: m.request_id,
            tool: r.display_name || r.tool_name || 'Tool',
            toolName: r.tool_name || '',
            input: r.input || {},
            description: r.description || '',
            suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
            toolUseId: r.tool_use_id || '',
          },
        ];
      }
      case 'control_cancel_request':
        return [{ t: 'permissionCancel', requestId: m.request_id }];
      case 'control_response': {
        const r = m.response || {};
        return [{ t: 'control', requestId: r.request_id, response: r.response || null, error: r.subtype === 'error' ? r.error || 'failed' : null }];
      }
      default:
        return [];
    }
  }

  streamEvent(e, parent) {
    if (parent) return []; // sub-agent output: shown through its tool row only
    if (e.type === 'message_start') {
      this.messageId = (e.message && e.message.id) || `m${++this.n}`;
      return [];
    }
    if (e.type === 'content_block_start') {
      const kind = e.content_block && e.content_block.type;
      if (kind !== 'text' && kind !== 'thinking') return [];
      const id = `b${++this.n}`;
      this.blocks.set(`${this.messageId}:${e.index}`, id);
      this.streamed.add(this.messageId);
      return [{ t: 'block', id, kind }];
    }
    if (e.type === 'content_block_delta') {
      const id = this.blocks.get(`${this.messageId}:${e.index}`);
      const d = e.delta || {};
      const text = d.type === 'text_delta' ? d.text : d.type === 'thinking_delta' ? d.thinking : '';
      return id && text ? [{ t: 'delta', id, text }] : [];
    }
    return [];
  }

  assistant(m) {
    if (m.parent_tool_use_id) return [];
    const msg = m.message || {};
    const wasStreamed = this.streamed.has(msg.id);
    const out = [];
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (!b) continue;
      if (b.type === 'tool_use') out.push({ t: 'tool', id: b.id, name: b.name, input: b.input || {} });
      else if (!wasStreamed && b.type === 'text' && b.text) {
        const id = `b${++this.n}`;
        out.push({ t: 'block', id, kind: 'text' }, { t: 'delta', id, text: b.text });
      } else if (!wasStreamed && b.type === 'thinking' && b.thinking) {
        const id = `b${++this.n}`;
        out.push({ t: 'block', id, kind: 'thinking' }, { t: 'delta', id, text: b.thinking });
      }
    }
    return out;
  }

  user(m) {
    if (m.parent_tool_use_id) return [];
    const c = m.message && m.message.content;
    const out = [];
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b && b.type === 'tool_result') out.push({ t: 'toolResult', id: b.tool_use_id, text: resultText(b.content), isError: Boolean(b.is_error) });
      }
    }
    const text = userText(m.message).trim();
    if (INTERRUPTED.test(text)) out.push({ t: 'note', text: 'Interrupted' });
    return out;
  }
}

/**
 * Events for a saved chat (its .jsonl transcript), so a resumed chat shows what was said before.
 * Adds { t: 'user', text } for your own messages. Side chains, notes and system lines are skipped.
 */
function transcriptEvents(lines) {
  const mapper = new EventMapper();
  const out = [];
  for (const o of lines) {
    if (!o || o.isSidechain || o.isMeta) continue;
    if (o.type === 'user') {
      const c = o.message && o.message.content;
      const isToolResult = Array.isArray(c) && c.some((b) => b && b.type === 'tool_result');
      const text = userText(o.message).trim();
      if (!isToolResult && text && !text.startsWith('<') && !text.startsWith('Caveat:') && !INTERRUPTED.test(text)) out.push({ t: 'user', text });
      else out.push(...mapper.user(o));
    } else if (o.type === 'assistant') {
      out.push(...mapper.assistant(o));
    } else if (o.type === 'system' && o.subtype === 'compact_boundary') {
      out.push({ t: 'note', text: 'Conversation compacted' });
    }
  }
  return out;
}

/** Parses a transcript file's text into objects (bad lines skipped). */
function parseJsonl(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partial line
    }
  }
  return out;
}

/** One-line summary of a tool call for its row, e.g. "Bash  npm test" or "Edit  lib.js". */
function toolSummary(name, input) {
  const i = input || {};
  const base = (p) => String(p || '').split(/[\\/]/).pop();
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return i.description || i.command || '';
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return base(i.file_path || i.notebook_path);
    case 'Glob':
    case 'Grep':
      return i.pattern || '';
    case 'WebFetch':
      return i.url || '';
    case 'WebSearch':
      return i.query || '';
    case 'Task':
    case 'Agent':
      return i.description || '';
    case 'TodoWrite':
      return Array.isArray(i.todos) ? `${i.todos.length} items` : '';
    default: {
      const first = Object.values(i).find((v) => typeof v === 'string');
      return first ? first.slice(0, 80) : '';
    }
  }
}

/** The stdin line for a user message (text plus optional extra text blocks such as attachments). */
function userMessage(text, extras = []) {
  const content = [...extras.filter(Boolean).map((t) => ({ type: 'text', text: t })), { type: 'text', text }];
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' };
}

/** The stdin line answering a permission request. */
function permissionAnswer(requestId, decision, input, suggestions, note) {
  let response;
  if (decision === 'deny') response = { behavior: 'deny', message: note || 'The user declined this.' };
  else {
    response = { behavior: 'allow', updatedInput: input || {} };
    if (decision === 'always' && suggestions && suggestions.length) response.updatedPermissions = suggestions;
  }
  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } };
}

/** CLI arguments for a chat process. */
function cliArgs({ resume, model, permissionMode } = {}) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio'];
  if (resume) args.push('--resume', resume);
  if (model && model !== 'default') args.push('--model', model);
  if (permissionMode && permissionMode !== 'default') args.push('--permission-mode', permissionMode);
  return args;
}

module.exports = { LineReader, EventMapper, transcriptEvents, parseJsonl, toolSummary, userMessage, permissionAnswer, cliArgs, resultText };
