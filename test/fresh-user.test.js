// A brand-new user: empty home folder, no settings, no `claude` command on PATH, no Claude Code extension.
// Loads the real extension.js inside a small fake VS Code and checks what the panel shows and what is written to disk.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeVscode(settings) {
  const events = { terminals: [], messages: [], posted: [], provider: null, commands: new Map(), configListeners: [] };
  const section = (name) => ({
    get: (k, d) => {
      const v = settings[`${name}.${k}`];
      return v === undefined ? d : v;
    },
    inspect: (k) => ({ globalValue: settings[`${name}.${k}`] }),
    update: async (k, v) => {
      if (v === undefined) delete settings[`${name}.${k}`];
      else settings[`${name}.${k}`] = v;
      for (const l of events.configListeners) l({ affectsConfiguration: (s) => `${name}.${k}`.startsWith(s) });
    },
  });
  const uri = (p) => ({ fsPath: p, toString: () => p });
  const disposable = { dispose() {} };
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    StatusBarAlignment: { Right: 2 },
    QuickPickItemKind: { Separator: -1 },
    Uri: { file: uri, parse: uri, joinPath: (u, ...p) => uri(path.join(u.fsPath, ...p)) },
    ThemeIcon: class {},
    TreeItem: class {},
    env: { clipboard: { writeText: async () => {} }, openExternal: async () => true },
    extensions: { getExtension: (id) => (id === 'anthropic.claude-code' ? { extensionPath: path.join(os.tmpdir(), 'no-claude-ext') } : undefined), onDidChange: () => disposable },
    commands: {
      registerCommand: (id, fn) => {
        events.commands.set(id, fn);
        return disposable;
      },
      executeCommand: async () => undefined,
    },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: section,
      onDidChangeConfiguration: (l) => {
        events.configListeners.push(l);
        return disposable;
      },
      onDidChangeWorkspaceFolders: () => disposable,
      fs: { delete: async () => {} },
    },
    window: {
      terminals: [],
      tabGroups: { all: [] },
      createOutputChannel: () => ({ info() {}, warn() {}, error() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      registerWebviewViewProvider: (_id, p) => {
        events.provider = p;
        return disposable;
      },
      registerTreeDataProvider: () => disposable,
      onDidChangeActiveTextEditor: () => disposable,
      onDidChangeWindowState: () => disposable,
      state: { focused: true },
      createTerminal: (opts) => {
        events.terminals.push(opts);
        return { show() {}, sendText() {} };
      },
      showInformationMessage: async (m) => events.messages.push(m),
      showWarningMessage: async (m) => events.messages.push(m),
      showErrorMessage: async (m) => events.messages.push(m),
      setStatusBarMessage: () => disposable,
      showQuickPick: async () => undefined,
      showInputBox: async () => undefined,
    },
  };
  return { vscode, events };
}

test('a new user sees the default Claude login as one account, and nothing outside Claude Accounts is changed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-fresh-'));
  const home = path.join(root, 'home');
  const storage = path.join(root, 'storage');
  fs.mkdirSync(home, { recursive: true });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH, LOCALAPPDATA: process.env.LOCALAPPDATA };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  process.env.PATH = path.join(root, 'empty-bin'); // no claude anywhere

  const settings = {};
  const { vscode, events } = fakeVscode(settings);
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : load.call(this, request, ...rest);
  };
  const extPath = path.join(__dirname, '..');
  for (const k of Object.keys(require.cache)) if (k.startsWith(extPath) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const ext = require('../extension');
  const subs = [];
  const state = new Map();
  const context = {
    subscriptions: subs,
    extensionPath: extPath,
    extensionUri: { fsPath: extPath },
    globalStorageUri: { fsPath: storage },
    extension: { packageJSON: require('../package.json') },
    globalState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => state.set(k, v) },
  };

  t.after(() => {
    for (const s of subs) s && s.dispose && s.dispose();
    Module._load = load;
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });

  ext.activate(context);
  const view = {
    visible: true,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (u) => u.fsPath,
      onDidReceiveMessage(cb) {
        this.receive = cb;
      },
      postMessage: async (m) => events.posted.push(m),
    },
    onDidChangeVisibility: () => {},
    onDidDispose: () => {},
  };
  events.provider.resolveWebviewView(view);
  await view.webview.receive({ type: 'ready' });

  // Wait for the sign-in check (fails fast: no claude) and the first state.
  let s;
  for (let i = 0; i < 100; i += 1) {
    await sleep(100);
    s = events.posted.length && events.posted[events.posted.length - 1].state;
    if (s && s.groups[0].accounts[0].status !== 'checking') break;
  }
  const accounts = s.groups[0].accounts;
  assert.equal(accounts.length, 1, 'one account: the default login');
  assert.equal(accounts[0].label, 'Claude');
  assert.equal(accounts[0].configDir, path.join(home, '.claude'), 'default folder is in the user folder (C: for most people)');
  assert.equal(accounts[0].active, true);
  assert.equal(accounts[0].status, 'error', 'Claude Code missing is shown as such, not as "signed out"');

  // No shared home: no links or folders made anywhere.
  assert.equal(fs.existsSync(path.join(home, '.claude', 'projects')), false, 'nothing created in ~/.claude/projects');
  assert.equal(settings['claudeAccounts.accounts'], undefined, 'no accounts written to settings on start');

  if (process.platform === 'win32') {
    // Live usage on Windows: one fixed relay file, the wrapper setting, and the terminal status line.
    for (let i = 0; i < 50 && !settings['claudeCode.claudeProcessWrapper']; i += 1) await sleep(100);
    const relay = path.join(storage, 'claude-relay.exe');
    assert.equal(settings['claudeCode.claudeProcessWrapper'], relay);
    assert.equal(fs.readdirSync(storage).filter((f) => /^claude-relay-/.test(f)).length, 0, 'no per-version copies');
    const claudeSettings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    assert.match(claudeSettings.statusLine.command, /claude-relay\.exe --statusline$/);

    // Uninstall clean-up removes both again.
    const vsUser = path.join(root, 'AppData', 'Code', 'User');
    fs.mkdirSync(vsUser, { recursive: true });
    fs.writeFileSync(
      path.join(vsUser, 'settings.json'),
      `{\n  // my settings\n  "editor.fontSize": 14,\n  "claudeCode.claudeProcessWrapper": ${JSON.stringify(relay)},\n  "files.autoSave": "off",\n}\n`
    );
    execFileSync(process.execPath, [path.join(extPath, 'uninstall.js')], { env: { ...process.env, APPDATA: path.join(root, 'AppData') } });
    const after = fs.readFileSync(path.join(vsUser, 'settings.json'), 'utf8');
    assert.doesNotMatch(after, /claudeProcessWrapper/);
    assert.match(after, /"editor.fontSize": 14/);
    assert.match(after, /"files.autoSave": "off"/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).statusLine, undefined);
  }

  // Signing in runs Claude directly in a terminal (works in any shell), on the default login.
  await events.commands.get('claudeAccounts.signIn')({ accountKey: '' });
  const term = events.terminals[events.terminals.length - 1];
  assert.deepEqual(term.shellArgs, ['auth', 'login', '--claudeai']);
  assert.equal(term.env.CLAUDE_CONFIG_DIR, null, 'default login: no CLAUDE_CONFIG_DIR');
});
