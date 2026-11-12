// Runs once after the extension is uninstalled (VS Code's "vscode:uninstall" hook, plain Node, no VS Code API).
// Removes what Claude Accounts set up outside its own folder, so Claude Code keeps working without it:
//  - claudeCode.claudeProcessWrapper, when it points to our relay
//  - the status line in Claude's settings.json files, when it is ours
// Nothing else is touched: logins, chats and settings you made yourself stay as they are.
const fs = require('fs');
const os = require('os');
const path = require('path');

const RELAY = /claude-relay(-[\w.]+)?\.exe/i;

function userDirs() {
  const products = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf'];
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const dirs = [];
  for (const product of products) {
    const user = path.join(base, product, 'User');
    if (!fs.existsSync(user)) continue;
    dirs.push(user);
    const profiles = path.join(user, 'profiles');
    for (const p of safeList(profiles)) dirs.push(path.join(profiles, p));
  }
  return dirs;
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Strips comments and trailing commas so VS Code's settings.json (JSON with comments) can be read. */
function parseJsonc(text) {
  const noComments = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '');
  return JSON.parse(noComments.replace(/,(\s*[}\]])/g, '$1'));
}

const claudeFolders = new Set([path.join(os.homedir(), '.claude')]);

// 1. VS Code settings: drop our wrapper line, and collect the accounts' login folders.
for (const dir of userDirs()) {
  const file = path.join(dir, 'settings.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  try {
    const settings = parseJsonc(text);
    for (const a of settings['claudeAccounts.accounts'] || []) if (a && a.configDir) claudeFolders.add(a.configDir);
    if (settings['claudeAccounts.homeDir']) claudeFolders.add(settings['claudeAccounts.homeDir']);
  } catch {
    // unreadable; still try the line edit below
  }
  const line = /\n?[ \t]*"claudeCode\.claudeProcessWrapper"\s*:\s*"([^"]*)"\s*,?/;
  const m = text.match(line);
  if (m && RELAY.test(m[1])) {
    try {
      fs.writeFileSync(file, text.replace(line, ''));
    } catch {
      // read-only; nothing more we can do
    }
  }
}

// 2. Claude settings: remove our status line (only ours).
for (const folder of claudeFolders) {
  const file = path.join(folder, 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cmd = settings.statusLine && settings.statusLine.command;
    if (typeof cmd === 'string' && RELAY.test(cmd) && /--statusline/.test(cmd)) {
      delete settings.statusLine;
      fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
    }
  } catch {
    // no settings file, or not ours
  }
}
