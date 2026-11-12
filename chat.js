// The chat tab: runs the Claude CLI in stream-json mode and shows the conversation in an editor tab.
// Works without the Claude Code extension. One CLI process per tab; it stays open between messages.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const lib = require('./lib');
const stream = require('./stream');

const VIEW_TYPE = 'claudeAccounts.chat';
const STOP_GRACE_MS = 3000; // after Stop, how long the CLI gets before it is ended
const MODEL_KEY = 'chatModel';
const MODE_KEY = 'chatMode';

let host; // { ctx, log, claudeCommand, activeAccount, onUsage, onChatChanged }
const tabs = new Set();
let lastEditor;

function init(h) {
  host = h;
  lastEditor = vscode.window.activeTextEditor;
  host.ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e) lastEditor = e;
    }),
    { dispose: () => [...tabs].forEach((t) => t.dispose()) }
  );
}

/** The chat tab already showing this chat, if any. */
const findTab = (sessionId) => (sessionId ? [...tabs].find((t) => t.sessionId === sessionId) : null);
const isOpen = (sessionId) => Boolean(findTab(sessionId));

/**
 * Opens a chat in a tab: an old one (session, with its folder) or a new one (no session).
 * A chat already open is brought to the front instead of opening twice.
 */
function open({ session, cwd, account } = {}) {
  const existing = session && findTab(session.id);
  if (existing) {
    existing.panel.reveal();
    return existing;
  }
  const tab = new ChatTab({ session, cwd, account });
  tabs.add(tab);
  return tab;
}

class ChatTab {
  constructor({ session, cwd, account }) {
    // A chat kept in another account's history stays on that account; others follow the account in use.
    this.pinned = account || null;
    this.sessionId = session ? session.id : '';
    this.transcript = session ? session.file : '';
    this.cwd = cwd || (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath || require('os').homedir();
    this.title = session ? session.title : 'New chat';
    this.proc = null;
    this.procAccount = null;
    this.busy = false;
    this.models = host.ctx.globalState.get('chatModels', []);
    this.model = host.ctx.globalState.get(MODEL_KEY, 'default');
    this.mode = host.ctx.globalState.get(MODE_KEY, 'default');
    this.pending = new Map(); // control request id -> resolve
    this.permissions = new Map(); // permission request id -> { input, suggestions }
    this.queue = [];
    this.stderr = '';

    const media = vscode.Uri.joinPath(host.ctx.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, shortTitle(this.title), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    const res = (n) => vscode.Uri.joinPath(host.ctx.extensionUri, 'resources', n);
    this.panel.iconPath = { light: res('chat-light.svg'), dark: res('chat-dark.svg') };
    this.panel.webview.html = html(this.panel.webview, media);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.error(e.message)));
    this.panel.onDidDispose(() => this.dispose());
  }

  post(msg) {
    this.queue.push(msg);
    if (this.flushTimer) return;
    // Streamed text arrives in many tiny pieces; sending them together keeps the tab smooth.
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = this.queue;
      this.queue = [];
      if (!this.disposed) this.panel.webview.postMessage({ type: 'batch', items: batch });
    }, 16);
  }

  error(text) {
    host.log.warn(`chat: ${text}`);
    this.post({ type: 'error', text });
  }

  setBusy(busy) {
    this.busy = busy;
    clearTimeout(this.stopTimer);
    this.post({ type: 'busy', busy });
  }

  account() {
    return this.pinned || host.activeAccount();
  }

  setup() {
    const a = this.account();
    let history = [];
    if (this.transcript) {
      try {
        history = stream.transcriptEvents(stream.parseJsonl(fs.readFileSync(this.transcript, 'utf8')));
      } catch (e) {
        host.log.warn(`chat: could not read ${this.transcript}: ${e.message}`);
      }
    }
    this.post({
      type: 'setup',
      title: this.title,
      account: a ? a.label : '',
      folder: path.basename(this.cwd) || this.cwd,
      cwd: this.cwd,
      models: this.models,
      model: this.model,
      mode: this.mode,
      history,
      busy: this.busy,
    });
  }

  async onMessage(m) {
    switch (m.type) {
      case 'ready':
        return this.setup();
      case 'send':
        return this.send(String(m.text || ''), m.attachments || []);
      case 'stop':
        return this.stop();
      case 'permission':
        return this.answer(m.requestId, m.decision, m.note);
      case 'model':
        this.model = m.model || 'default';
        await host.ctx.globalState.update(MODEL_KEY, this.model);
        if (this.proc) this.request({ subtype: 'set_model', model: this.model === 'default' ? undefined : this.model }).catch((e) => this.error(`Model not changed: ${e.message}`));
        return undefined;
      case 'mode':
        this.mode = m.mode || 'default';
        await host.ctx.globalState.update(MODE_KEY, this.mode);
        if (this.proc) this.request({ subtype: 'set_permission_mode', mode: this.mode }).catch((e) => this.error(`Mode not changed: ${e.message}`));
        return undefined;
      case 'attach':
        return this.attach(m.what);
      case 'openFile':
        return openFile(m.path, this.cwd);
      case 'copy':
        await vscode.env.clipboard.writeText(String(m.text || ''));
        return vscode.window.setStatusBarMessage('Copied', 1500);
      default:
        return undefined;
    }
  }

  /** The open file, or its selection, as a chip in the input box. */
  attach(what) {
    const ed = lastEditor && !lastEditor.document.isClosed ? lastEditor : vscode.window.visibleTextEditors[0];
    if (!ed || ed.document.uri.scheme !== 'file') {
      this.post({ type: 'toast', text: 'Open a file first.' });
      return;
    }
    const file = ed.document.uri.fsPath;
    const rel = path.relative(this.cwd, file);
    const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
    const sel = ed.selection;
    if (what === 'selection' && sel && !sel.isEmpty) {
      const text = ed.document.getText(sel);
      const from = sel.start.line + 1;
      const to = sel.end.line + (sel.end.character === 0 ? 0 : 1);
      const lang = ed.document.languageId;
      this.post({
        type: 'attached',
        item: {
          label: `${path.basename(file)}:${from}${to > from ? `-${to}` : ''}`,
          text: `Selected lines ${from}-${to} of ${shown}:\n\`\`\`${lang}\n${text}\n\`\`\``,
        },
      });
    } else {
      this.post({ type: 'attached', item: { label: path.basename(file), text: `The user attached this file: ${shown}` } });
    }
  }

  /** Starts the CLI (or restarts it on the account in use now, when the chat is idle). */
  ensureProcess() {
    const a = this.account();
    if (!a) throw new Error('No Claude account is set up.');
    const sameAccount = this.procAccount && lib.normalizeDir(this.procAccount.configDir) === lib.normalizeDir(a.configDir);
    if (this.proc && (sameAccount || this.busy)) return;
    if (this.proc) {
      host.log.info(`chat: moving "${this.title}" to ${a.label}`);
      this.kill();
    }
    const env = { ...process.env };
    delete env[lib.ENV_KEY];
    delete env.CLAUDECODE;
    if (a.configDir) env[lib.ENV_KEY] = a.configDir;
    const args = stream.cliArgs({ resume: this.sessionId, model: this.model, permissionMode: this.mode });
    const cmd = host.claudeCommand();
    host.log.info(`chat: start ${cmd} ${args.join(' ')} in ${this.cwd} (${a.label})`);
    const proc = spawn(cmd, args, { cwd: this.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.procAccount = a;
    this.stderr = '';
    const reader = new stream.LineReader();
    const mapper = new stream.EventMapper();
    proc.stdout.on('data', (d) => {
      for (const msg of reader.push(d)) for (const ev of mapper.map(msg)) this.onEvent(ev);
    });
    proc.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d).slice(-2000);
    });
    proc.stdin.on('error', () => {}); // the process ended; the exit handler reports it
    proc.on('error', (e) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.setBusy(false);
      this.error(e.code === 'ENOENT' ? 'Claude Code was not found. Install it, or set claudeAccounts.claudePath.' : `Claude could not start: ${e.message}`);
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      for (const resolve of this.pending.values()) resolve({ error: 'Claude stopped' });
      this.pending.clear();
      if (this.busy) {
        this.setBusy(false);
        if (code && !this.stopping) this.error(`Claude stopped (exit ${code}). ${this.stderr.trim().split('\n').slice(-3).join(' ')}`.trim());
      }
      this.stopping = false;
    });
    this.request({ subtype: 'initialize' }).then((r) => {
      if (r && Array.isArray(r.models) && r.models.length) {
        this.models = r.models.map((x) => ({ value: x.value, label: x.displayName || x.value, description: x.description || '' }));
        host.ctx.globalState.update('chatModels', this.models);
        this.post({ type: 'models', models: this.models, model: this.model });
      }
    });
  }

  write(obj) {
    if (!this.proc) throw new Error('Claude is not running');
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  /** Sends a control request; resolves with its answer (or { error }). */
  request(req) {
    const id = `ca-${crypto.randomBytes(6).toString('hex')}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (r) => (r && r.error ? reject(new Error(r.error)) : resolve(r && r.response)));
      try {
        this.write({ type: 'control_request', request_id: id, request: req });
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  onEvent(ev) {
    switch (ev.t) {
      case 'control': {
        const resolve = this.pending.get(ev.requestId);
        if (resolve) {
          this.pending.delete(ev.requestId);
          resolve(ev.error ? { error: ev.error } : { response: ev.response });
        }
        return;
      }
      case 'init':
        if (ev.sessionId && ev.sessionId !== this.sessionId) {
          this.sessionId = ev.sessionId;
          host.onChatChanged();
        }
        break;
      case 'usage':
        host.onUsage(this.procAccount, ev.event);
        return;
      case 'permission':
        this.permissions.set(ev.requestId, { input: ev.input, suggestions: ev.suggestions });
        if (!this.panel.active) vscode.window.setStatusBarMessage(`$(shield) Claude is asking to use ${ev.tool}`, 6000);
        break;
      case 'permissionCancel':
        this.permissions.delete(ev.requestId);
        break;
      case 'done':
        this.setBusy(false);
        this.stopping = false;
        host.onChatChanged();
        break;
      default:
        break;
    }
    this.post({ type: 'event', ev });
  }

  send(text, attachments) {
    if (!text.trim() && !attachments.length) return;
    this.ensureProcess();
    if (this.title === 'New chat') {
      this.title = text.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat';
      this.panel.title = shortTitle(this.title);
    }
    this.write(stream.userMessage(text, attachments.map((a) => a.text)));
    this.setBusy(true);
  }

  /** Stop: asks Claude to interrupt; ends the process if it does not stop in a few seconds. */
  stop() {
    if (!this.proc || !this.busy) return;
    this.stopping = true;
    this.request({ subtype: 'interrupt' }).catch(() => {});
    for (const id of this.permissions.keys()) this.answer(id, 'deny', 'Stopped by the user.');
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      if (!this.busy) return;
      host.log.warn('chat: Claude did not stop in time; ending it');
      this.kill();
      this.setBusy(false);
      this.post({ type: 'event', ev: { t: 'note', text: 'Stopped' } });
    }, STOP_GRACE_MS);
  }

  answer(requestId, decision, note) {
    const p = this.permissions.get(requestId);
    if (!p) return;
    this.permissions.delete(requestId);
    try {
      this.write(stream.permissionAnswer(requestId, decision, p.input, p.suggestions, note));
    } catch (e) {
      this.error(e.message);
    }
    this.post({ type: 'answered', requestId, decision });
  }

  kill() {
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try {
      proc.stdin.end();
    } catch {
      // already closed
    }
    proc.kill();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.stopTimer);
    clearTimeout(this.flushTimer);
    this.kill();
    tabs.delete(this);
    try {
      this.panel.dispose();
    } catch {
      // already gone
    }
  }
}

const shortTitle = (t) => (t.length > 32 ? `${t.slice(0, 31)}...` : t);

async function openFile(p, cwd) {
  if (!p) return;
  const file = path.isAbsolute(p) ? p : path.join(cwd, p);
  if (!fs.existsSync(file)) return vscode.window.showWarningMessage(`${p} is not on disk.`);
  await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true, viewColumn: vscode.ViewColumn.Beside });
}

function html(webview, media) {
  const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js'));
  const mdJs = webview.asWebviewUri(vscode.Uri.joinPath(media, 'markdown.js'));
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Claude</title>
</head>
<body><script nonce="${nonce}" src="${mdJs}"></script><script nonce="${nonce}" src="${js}"></script></body>
</html>`;
}

module.exports = { init, open, isOpen, VIEW_TYPE };
