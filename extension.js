// Claude Accounts: all your Claude Code accounts in one panel, with live plan usage, chats, projects and model usage.
// Chats open in its own chat tab (or the Claude extension's view, by setting); switching accounts is one click and needs no reload.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const lib = require('./lib');
const live = require('./live');
const { buildState } = require('./state');
const history = require('./history');
const chat = require('./chat');

const VIEW_ID = 'claudeAccounts.panel';
const DEBOUNCE_MS = 250; // let Claude finish a write before re-reading
const TICK_MS = 60 * 1000; // safety net: re-attach watchers, re-read if an event was missed
const STATUS_MS = 5 * 60 * 1000; // sign-in status rarely changes
const PENDING_KEY = 'pendingOpen'; // a chat to open after a reload or in a new window
const PENDING_TTL = 3 * 60 * 1000;
const CLAUDE_OPEN = 'claude-vscode.editor.open';
const USAGE_URL = 'https://claude.ai/settings/usage';
const rating = require('./rating');
const autostart = require('./autostart');
const remind = require('./remind');

const statusCache = new Map(); // account key -> claude auth status
const planCache = new Map(); // account key -> plan usage
const chatsCache = new Map(); // history key -> chats
const modelsCache = new Map(); // history key -> model usage
const folderCache = new Map(); // lower-case history name -> folder on disk (null = not found)
const liveInfo = new Map(); // account key -> { checking, checkedAt, error }
const accountIds = new Map(); // account key -> Claude account id (to know which account ran a chat)
let relayState = 'starting'; // on | off | foreign (another wrapper is set) | failed | starting

let ctx;
let view;
let statusBar;
let autoBar; // shows scheduled auto-starts
let simulation = null; // { key, at, until } while a test alert is on
let periodId = '7d';
let selectedKey = '';

// ---------- Accounts ----------

const cfg = () => vscode.workspace.getConfiguration('claudeAccounts');

const IS_WINDOWS = process.platform === 'win32';
const TRASH = IS_WINDOWS ? 'Recycle Bin' : 'Trash';
const TERMINAL_ENV = `env.${IS_WINDOWS ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'}`;
// With nothing set up yet, the panel shows the default Claude login (~/.claude) as one account.
const DEFAULT_ACCOUNT = { label: 'Claude', configDir: '' };

/** Accounts as saved in settings (no implicit default). The list order is the order you use them in. */
function savedAccounts() {
  return (cfg().get('accounts') || []).filter((a) => a && a.label);
}

function accounts() {
  const list = savedAccounts();
  return (list.length ? list : [DEFAULT_ACCOUNT]).map((a) => ({ label: a.label, configDir: a.configDir || '', group: 'Accounts' }));
}

function groups() {
  return ['Accounts'];
}

/** Writes the account list; the implicit default account is kept when the first real one is added. */
const saveAccounts = (list) => cfg().update('accounts', list.map((a) => ({ label: a.label, configDir: a.configDir || '' })), vscode.ConfigurationTarget.Global);

// Optional shared home: when set, every account links its projects, memory, skills and rules to it.
// Off by default; each account then keeps its own Claude folder exactly as Claude made it.
const homeDir = () => String(cfg().get('homeDir') || '').trim();
const SHARED_DIRS = ['projects', 'skills', 'agents', 'commands', 'plugins', 'file-history'];
const SHARED_FILES = ['CLAUDE.md', 'settings.json'];

/** The Claude command: the setting, else `claude` on PATH, else the copy inside the Claude Code extension. */
let claudeCmd = null;
function claudeCommand() {
  const set = String(cfg().get('claudePath') || '').trim();
  if (set && set !== 'claude') return set;
  if (claudeCmd) return claudeCmd;
  const exe = IS_WINDOWS ? 'claude.exe' : 'claude';
  const onPath = (process.env.PATH || '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, exe)));
  if (onPath) return (claudeCmd = 'claude');
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  const bundled = ext && path.join(ext.extensionPath, 'resources', 'native-binary', exe);
  claudeCmd = bundled && fs.existsSync(bundled) ? bundled : 'claude';
  return claudeCmd;
}

/**
 * Makes sure an account's folder uses the shared home: missing or empty folders become links to it.
 * Folders that already hold data are left alone and reported. Only when a shared home is set.
 */
function ensureAccountLinks(account) {
  const home = homeDir();
  if (!home || !account.configDir || !fs.existsSync(home)) return;
  fs.mkdirSync(account.configDir, { recursive: true });
  for (const d of SHARED_DIRS) {
    const p = path.join(account.configDir, d);
    const target = path.join(home, d);
    try {
      const st = fs.lstatSync(p, { throwIfNoEntry: false });
      if (st && st.isSymbolicLink()) continue;
      if (st && st.isDirectory()) {
        if (fs.readdirSync(p).length) {
          log.warn(`${account.label}: ${p} has its own data, so it is not linked to the shared home`);
          continue;
        }
        fs.rmdirSync(p);
      }
      fs.mkdirSync(target, { recursive: true });
      fs.symlinkSync(target, p, 'junction');
      log.info(`${account.label}: linked ${p} -> ${target}`);
    } catch (e) {
      log.warn(`${account.label}: could not link ${p}: ${e.message}`);
    }
  }
  for (const f of SHARED_FILES) {
    const p = path.join(account.configDir, f);
    const target = path.join(home, f);
    try {
      if (fs.lstatSync(p, { throwIfNoEntry: false }) || !fs.existsSync(target)) continue;
      fs.symlinkSync(target, p, 'file');
      log.info(`${account.label}: linked ${p} -> ${target}`);
    } catch (e) {
      log.warn(`${account.label}: could not link ${p}: ${e.message}`);
    }
  }
}

const key = (a) => lib.normalizeDir(a.configDir);
const histKey = (a) => lib.normalizeDir(lib.historyDir(a.configDir));
const ACTIVE_KEY = 'activeDir';
const claudeExtDir = () => lib.activeDirFromEnvList(vscode.workspace.getConfiguration('claudeCode').get('environmentVariables'));
/** Login folder in use. With the Claude extension installed its setting decides (it may be changed there too). */
const activeDir = () => (hasClaudeExtension() || !ctx ? claudeExtDir() : ctx.globalState.get(ACTIVE_KEY, claudeExtDir()));
const isActive = (a) => key(a) === lib.normalizeDir(activeDir());
const workspaceFolders = () => (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
const hasClaudeExtension = () => Boolean(vscode.extensions.getExtension('anthropic.claude-code'));
const signedOut = (a) => statusCache.has(key(a)) && !statusCache.get(key(a)).loggedIn;
const findAccount = (k) => accounts().find((a) => key(a) === lib.normalizeDir(k)) || null;
const oncePerHistory = () => [...new Map(accounts().map((a) => [histKey(a), a])).values()];

/** Accepts an account, { account }, { accountKey } (panel messages and right-click menus). */
function accountFrom(arg) {
  if (!arg) return null;
  if (arg.accountKey !== undefined) return findAccount(arg.accountKey);
  if (arg.account) return arg.account;
  if (arg.label !== undefined && arg.configDir !== undefined) return arg;
  return null;
}

function sessionFrom(arg, account) {
  if (!arg || !account) return null;
  if (arg.session) return arg.session;
  return (chatsCache.get(histKey(account)) || []).find((s) => s.id === arg.sessionId) || null;
}

// ---------- Panel ----------

function panelHtml(webview) {
  const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Claude Accounts</title>
</head>
<body><script nonce="${nonce}" src="${js}"></script></body>
</html>`;
}

// ---------- Auto-start of a session window (one tiny message, then the schedule removes itself) ----------

let autoTimer;
const autoList = () => autostart.normalize(ctx.globalState.get('autoStarts') || []); // older builds could hold a window twice
const saveAuto = (list) => ctx.globalState.update('autoStarts', list);
const clock = (ms) => new Date(Math.round(ms / 60000) * 60000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** A status bar entry that shows while any auto-start is set: the next time, with all of them in the hover. */
function updateAutoBar() {
  if (!autoBar) return;
  const list = autoList();
  if (!list.length) return autoBar.hide();
  const when = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  autoBar.text = `$(clock) ${clock(list[0].start)}${list.length > 1 ? ` +${list.length - 1}` : ''}`;
  autoBar.tooltip = ['Auto-start set (one tiny message starts the session window)', ...list.map((x) => `${(findAccount(x.key) || { label: 'Account' }).label}: ${when(x.start)}`), 'Click to see or cancel'].join('\n');
  autoBar.show();
}

async function manageAutoStarts() {
  const list = autoList();
  if (!list.length) return vscode.window.showInformationMessage('No auto-starts are set. Click a session window in the Usage section to add one.');
  const items = list.map((x) => ({
    label: `$(clock) ${(findAccount(x.key) || { label: 'Account' }).label}`,
    description: new Date(x.start).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
    detail: 'Pick to cancel this auto-start.',
    item: x,
  }));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Scheduled auto-starts. Pick one to cancel it.' });
  if (!pick) return undefined;
  await saveAuto(autostart.remove(autoList(), pick.item));
  armAutoStarts();
  post();
  return vscode.window.setStatusBarMessage('$(check) Auto-start cancelled.', 4000);
}

/** For testing: a real auto-start one minute from now for the selected account. */
async function testAutoStart() {
  const account = selectedAccount();
  if (!account) return undefined;
  const r = autostart.add(autoList(), { key: key(account), start: Date.now() + 15 * 1000 });
  await saveAuto(r.list);
  armAutoStarts();
  post();
  return vscode.window.showInformationMessage(`Auto-start test set for ${account.label} in about a minute. If no session window is running then, one tiny message is sent. Watch the clock in the status bar.`);
}

/** For testing: shows a made-up weekly alert for the selected account for 15 minutes (or stops it). */
async function simulateAlert() {
  const account = selectedAccount();
  if (!account) return undefined;
  if (simulation) {
    simulation = null;
    post();
    return vscode.window.showInformationMessage('The test alert is off.');
  }
  simulation = { key: key(account), at: Date.now(), until: Date.now() + 15 * 60 * 1000 };
  post(); // draws the bell and card, and shows the notification
  return vscode.window.showInformationMessage(`Test alert on for ${account.label} for 15 minutes. Open the Claude Accounts panel to see the bell and the session windows. Run this command again to turn it off.`);
}

/** Wakes up at the next schedule (the one-minute tick is the safety net). */
function armAutoStarts() {
  clearTimeout(autoTimer);
  updateAutoBar();
  const next = autostart.next(autoList());
  if (next) autoTimer = setTimeout(() => runAutoStarts().catch((e) => log.warn(`auto-start: ${e.message}`)), Math.min(next.start + autostart.FIRE_DELAY_MS - Date.now() + 500, 2 ** 31 - 1));
}

async function runAutoStarts() {
  let list = autoList();
  for (const item of autostart.missed(list)) {
    const account = findAccount(item.key);
    vscode.window.showInformationMessage(`The auto-start for ${account ? account.label : 'an account'} at ${clock(item.start)} was skipped because VS Code was not open then.`);
    list = autostart.remove(list, item);
  }
  for (const item of autostart.due(list)) {
    list = autostart.remove(list, item); // one-shot: gone whether it runs or not
    await saveAuto(list);
    // Every open window runs this; only the first one to claim it sends the message.
    if (!autostart.claim(path.join(ctx.globalStorageUri.fsPath, 'locks'), item)) {
      log.info('auto-start left to another window');
      continue;
    }
    await sendAutoStart(item);
  }
  await saveAuto(list);
  armAutoStarts();
  post();
}

/** The tiny message: the cheapest model, no chat saved. Skipped when a window is already running. */
function sendAutoStart(item) {
  const account = findAccount(item.key);
  if (!account) return Promise.resolve();
  const why = autostart.skipReason(planCache.get(item.key), signedIn(account));
  if (why) {
    vscode.window.setStatusBarMessage(`$(clock) Auto-start skipped for ${account.label}: ${why}.`, 8000);
    return Promise.resolve();
  }
  const env = { ...process.env };
  delete env[lib.ENV_KEY];
  if (account.configDir) env[lib.ENV_KEY] = account.configDir;
  return new Promise((resolve) => {
    execFile(claudeCommand(), autostart.messageArgs(), { env, timeout: 90000, windowsHide: true }, (err) => {
      if (err) {
        log.warn(`auto-start for ${account.label} failed: ${err.message}`);
        vscode.window.showWarningMessage(`The auto-start for ${account.label} could not run: ${err.message}`);
      } else {
        log.info(`auto-start sent for ${account.label}`);
        vscode.window.setStatusBarMessage(`$(check) Auto-start: the next 5-hour window of ${account.label} has begun.`, 10000);
        for (const d of autostart.CONFIRM_DELAYS_MS) setTimeout(() => checkUsage(account), d); // the new window appears after a short delay
      }
      resolve();
    });
  });
}

// ---------- Asking for a rating, gently ----------

const ratingState = () => ({ ...rating.empty(), ...(ctx.globalState.get('rating') || {}) });
const saveRating = (s) => ctx.globalState.update('rating', s);
const reviewUrl = () => {
  const p = ctx.extension.packageJSON;
  return `https://marketplace.visualstudio.com/items?itemName=${p.publisher}.${p.name}&ssr=false#review-details`;
};

/** Counts a moment where the extension helped, and (rarely) asks for a rating a few seconds after. */
function noteUse(event) {
  const first = ctx.globalState.get('rating');
  saveRating(rating.record(first || rating.empty(), event));
  setTimeout(() => maybeAskForRating().catch(() => {}), 6000);
}

async function maybeAskForRating() {
  const s = ratingState();
  if (!vscode.window.state.focused || !rating.shouldAsk(s)) return;
  await saveRating(rating.asked(s)); // counted when shown, so a crash or a close never causes a second ask
  const pick = await vscode.window.showInformationMessage(
    'Glad Claude Accounts is helping. A quick rating helps other developers find it, and takes a few seconds.',
    'Rate It',
    'Maybe Later',
    "Don't Ask Again"
  );
  if (pick === 'Rate It') return rateNow();
  await saveRating(rating.choose(ratingState(), pick === "Don't Ask Again" ? 'never' : 'later'));
  post();
}

async function rateNow() {
  await saveRating(rating.choose(ratingState(), 'rate'));
  await vscode.env.openExternal(vscode.Uri.parse(reviewUrl()));
  post();
}

function currentState() {
  const weekly = weeklyInfo();
  notifyWeeklyAlerts(weekly);
  return { ...currentStateBase(weekly), rate: rating.shouldHint(ratingState()), autoStarts: autoList().map(({ key: k, start }) => ({ key: k, start })) };
}

function currentStateBase(weekly) {
  return buildState({
    weekly,
    accounts: accounts(),
    groups: groups(),
    activeDir: activeDir(),
    selectedKey,
    period: periodId,
    workspaceFolders: workspaceFolders(),
    status: statusCache,
    plans: planCache,
    chats: chatsCache,
    models: modelsCache,
    folders: new Map([...folderCache].filter(([, v]) => v)),
    live: liveInfo,
    accountIds,
    relay: relayState,
  });
}

// ---------- Usage resets ----------

let resetTimer;
const RESET_CONFIRM_MS = 60 * 1000;

/** A window whose reset time passed is back to 0%; one check a minute later confirms it with Claude. */
function handleResets() {
  let changed = false;
  for (const a of accounts()) {
    const k = key(a);
    const { plan, reset } = live.applyResets(planCache.get(k));
    if (!reset.length) continue;
    planCache.set(k, plan);
    changed = true;
    log.info(`${a.label}: ${reset.join(' and ')} usage reset`);
    if (signedIn(a)) setTimeout(() => checkUsage(a), RESET_CONFIRM_MS); // one request per reset
  }
  if (changed) post();
  armResetTimer();
}

/** Wakes up exactly when the next window resets, instead of waiting for the next minute. */
function armResetTimer() {
  clearTimeout(resetTimer);
  const at = live.nextReset([...planCache.values()]);
  if (!at) return;
  resetTimer = setTimeout(handleResets, Math.min(at - Date.now() + 500, 2 ** 31 - 1));
}

/** Keeps whichever numbers are newest: relay (per reply), Claude's saved copy, or a usage check. */
function offerPlan(k, candidate) {
  const next = live.choosePlan(planCache.get(k), candidate);
  if (next) planCache.set(k, next);
  handleResets(); // numbers can arrive with a reset time already passed; also re-arms the timer
  if (next && history.record(usageHistory, k, planCache.get(k))) saveHistorySoon();
}

// ---------- Usage history, weekly plan and "use it before it resets" alerts ----------

let usageHistory = history.emptyStore();
let historySaveTimer;
const historyFile = () => path.join(ctx.globalStorageUri.fsPath, 'usage-history.json');

function loadUsageHistory() {
  try {
    usageHistory = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    if (!usageHistory || !usageHistory.accounts) usageHistory = history.emptyStore();
    if (history.normalize(usageHistory)) {
      log.info('usage history: merged sessions recorded more than once');
      saveHistorySoon();
    }
  } catch {
    usageHistory = history.emptyStore();
  }
}

function saveHistorySoon() {
  clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
      fs.writeFileSync(historyFile(), JSON.stringify(usageHistory));
    } catch (e) {
      log.warn(`usage history not saved: ${e.message}`);
    }
  }, 2000);
}

/** Weekly plan for every account: this/last week's 5-hour slots, the learned session share and any alert. */
/** The account's real alert, or a made-up one while a test (Simulate Weekly Alert) is running for it. */
function alertFor(k, plan, share, pace) {
  if (simulation && Date.now() > simulation.until) simulation = null;
  if (simulation && simulation.key === k) {
    const demo = history.weeklyAlert(history.demoPlan(simulation.at), 0.12, Date.now(), { sessionsPerDay: 1.2, avgUse: 30, learned: true });
    if (demo) return { ...demo, simulated: true };
  }
  return history.weeklyAlert(plan, share, Date.now(), pace);
}

function weeklyInfo() {
  const info = new Map();
  const pace = history.pattern(usageHistory); // your usual pace, learned across all accounts
  for (const a of accounts()) {
    const k = key(a);
    const plan = planCache.get(k);
    const share = history.learnedShare(usageHistory, k);
    const weeklyReset = plan && plan.weekly && plan.weekly.resetsAt;
    info.set(k, {
      series: history.series(usageHistory, k, Date.now() - 92 * 24 * 3600 * 1000),
      cycles: history.cycles(usageHistory, k, weeklyReset),
      weeklyReset: weeklyReset || null,
      summary: history.weekSummary(usageHistory, k, weeklyReset),
      share,
      perSession: Math.round((share || history.DEFAULT_SHARE) * 1000) / 10,
      alert: signedIn(a) ? alertFor(k, plan, share, pace) : null,
    });
  }
  return info;
}

/**
 * The weekly reminder as a VS Code notification, rarely (see remind.js): at most a reminder and one
 * final alert per account and week, never while you are using that account, never within hours of
 * another, and only from one window. The card in the panel always shows the advice anyway.
 */
function notifyWeeklyAlerts(info) {
  if (!cfg().get('weeklyReminders', true)) return;
  let state = ctx.globalState.get('reminders') || remind.empty();
  for (const a of accounts()) {
    const alert = info.get(key(a)) && info.get(key(a)).alert;
    if (!alert) continue;
    const d = remind.decide(state, key(a), alert, Date.now(), { focused: vscode.window.state.focused, inSession: Boolean(alert.inSession) });
    if (!d.notify) continue;
    state = d.state;
    ctx.globalState.update('reminders', state);
    // Every open window gets here: only the first one to claim it shows the notification.
    const lock = { key: `notify-${key(a)}-${alert.level}${alert.simulated ? '-test' : ''}`, start: d.cycle };
    if (!alert.simulated && !autostart.claim(path.join(ctx.globalStorageUri.fsPath, 'locks'), lock)) continue;
    const when = new Date(alert.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric' });
    const test = alert.simulated ? 'Test: ' : '';
    const msg = test + (alert.level === 'final'
      ? `${a.label} has ${alert.unused}% of this week's limit left and it resets ${when}. ${alert.maxReach < 100 ? `Even with every session used, only ${alert.maxReach}% can be reached.` : 'Use every remaining session to make the most of it.'}`
      : `${a.label} is on pace to use ${alert.projected}% of this week's limit. ${alert.unused}% is left until it resets ${when}.`);
    const show = alert.level === 'final' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    show(msg, 'Start Session', 'Mute Reminders').then(async (pick) => {
      if (pick === 'Start Session') return newSession(a);
      if (pick === 'Mute Reminders') {
        await cfg().update('weeklyReminders', false, vscode.ConfigurationTarget.Global);
        vscode.window.setStatusBarMessage('$(bell-slash) Weekly reminders are off. Turn them back on with the setting claudeAccounts.weeklyReminders.', 8000);
      }
      return undefined;
    });
    break; // one notification at a time
  }
}

// ---------- Per-reply usage through the relay ----------

const RELAY_SETTING = 'claudeProcessWrapper';
// Older versions used one copy per version (claude-relay-0.13.2.exe) and deleted the others, so two
// windows on different versions deleted each other's copy while Claude was starting it ("This
// application could not be started"). Now there is one fixed file that every version shares.
const OLD_RELAY_NAME = /^claude-relay-[\w.-]+\.exe$/i;
const relayPath = () => path.join(ctx.globalStorageUri.fsPath, 'claude-relay.exe');
const sameFile = (a, b) => {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
};

/**
 * Puts the bundled relay at its fixed path. A running copy can't be overwritten on Windows but can be
 * renamed, so a changed relay goes in by renaming the old file aside, never by deleting a file Claude
 * may be starting this very moment. Returns the path, or '' if it is not there.
 */
function installRelay() {
  const target = relayPath();
  const source = path.join(ctx.extensionPath, 'bin', 'claude-relay.exe');
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!sameFile(source, target)) {
      const temp = `${target}.${process.pid}.new`;
      fs.copyFileSync(source, temp);
      if (fs.existsSync(target)) fs.renameSync(target, `${target}.${Date.now()}.old`);
      fs.renameSync(temp, target);
      log.info(`relay updated: ${target}`);
    }
  } catch (e) {
    log.warn(`relay not updated: ${e.message}`);
  }
  // Leftovers that nothing points at any more; a file still running just stays until next time.
  for (const f of safeReaddir(path.dirname(target))) {
    if (/\.old$|\.new$/i.test(f)) tryUnlink(path.join(path.dirname(target), f));
  }
  return fs.existsSync(target) ? target : '';
}

const safeReaddir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};
const tryUnlink = (file) => {
  try {
    fs.unlinkSync(file);
  } catch {
    // in use
  }
};

/** Our relay, at the fixed path or an older per-version copy in our storage. */
function isOurRelay(file) {
  if (!file) return false;
  const inStorage = lib.normalizeDir(path.dirname(file)) === lib.normalizeDir(ctx.globalStorageUri.fsPath);
  return inStorage && (path.basename(file).toLowerCase() === 'claude-relay.exe' || OLD_RELAY_NAME.test(path.basename(file)));
}

/**
 * Points the Claude extension at our relay (claudeCode.claudeProcessWrapper), so every chat reply's
 * usage reaches this panel. Windows only (the relay is a Windows program). Never replaces a wrapper
 * set by someone else; claudeAccounts.liveUsage = false removes ours.
 */
async function setupRelay() {
  const claudeCfg = vscode.workspace.getConfiguration('claudeCode');
  const current = claudeCfg.get(RELAY_SETTING) || '';
  const ours = isOurRelay(current);
  const wanted = cfg().get('liveUsage', true) && IS_WINDOWS;
  if (!hasClaudeExtension()) {
    // Running on its own: chat tabs report usage after every reply; terminals use the status line.
    syncStatusLines(wanted ? installRelay() : '');
    relayState = 'chatTab';
    return post();
  }
  if (!wanted) {
    syncStatusLines('');
    if (ours) await claudeCfg.update(RELAY_SETTING, undefined, vscode.ConfigurationTarget.Global);
    relayState = IS_WINDOWS ? 'off' : 'unsupported';
    return post();
  }
  if (current && !ours) {
    relayState = 'foreign';
    log.info(`live usage relay not set: claudeCode.${RELAY_SETTING} already points to ${current}`);
    syncStatusLines(installRelay());
    return post();
  }
  const target = installRelay();
  syncStatusLines(target);
  const ok =
    Boolean(target) &&
    (await new Promise((resolve) =>
      execFile(target, ['--relay-selftest'], { timeout: 8000, windowsHide: true }, (err, out) => resolve(!err && String(out).includes('claude-relay ok')))
    ));
  if (!ok) {
    relayState = 'failed';
    log.error('live usage relay failed its self-test; Claude starts without it');
    // Only drop the setting when the file is really gone; a busy moment must not undo it.
    if (ours && !fs.existsSync(current)) await claudeCfg.update(RELAY_SETTING, undefined, vscode.ConfigurationTarget.Global);
    return post();
  }
  if (lib.normalizeDir(current) !== lib.normalizeDir(target)) await claudeCfg.update(RELAY_SETTING, target, vscode.ConfigurationTarget.Global);
  relayState = 'on';
  log.info(`live usage relay on: ${target}`);
  if (!current) {
    // First time on: chats already open in Claude started without the relay.
    vscode.window
      .showInformationMessage('Live usage is on. Reload the window once so chats that are already open can report their usage.', 'Reload Window')
      .then((pick) => pick && vscode.commands.executeCommand('workbench.action.reloadWindow'));
  }
  // Per-version copies from older versions are left alone: a window still on an old version may be
  // starting one, and deleting it then is exactly what caused "This application could not be started".
  post();
}

/**
 * Terminal chats do not go through the relay, but Claude runs the status line command after every
 * reply with the current limits. Each account's settings.json gets our relay in status-line mode,
 * unless it already has a status line of its own. An empty `relay` removes ours again.
 */
function syncStatusLines(relay) {
  const on = Boolean(relay);
  const command = on ? `${relay.replace(/\\/g, '/')} --statusline` : ''; // forward slashes work in cmd and bash
  const done = new Set();
  for (const a of accounts()) {
    const file = path.join(a.configDir || path.join(os.homedir(), '.claude'), 'settings.json');
    let real = file;
    try {
      real = fs.realpathSync.native(file);
    } catch {
      // not there yet
    }
    if (done.has(real.toLowerCase())) continue; // accounts share one settings file
    done.add(real.toLowerCase());
    try {
      const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8') || '{}') : {};
      const current = settings.statusLine && settings.statusLine.command;
      const ours = typeof current === 'string' && /claude-relay(-[\w.]+)?\.exe["']?\s+--statusline/i.test(current);
      if (on && (!current || (ours && current !== command))) settings.statusLine = { type: 'command', command, padding: 0 };
      else if (!on && ours) delete settings.statusLine;
      else continue;
      fs.mkdirSync(path.dirname(file), { recursive: true }); // a login folder Claude has not created yet
      fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`); // follows the link to the shared settings
      log.info(`${on ? 'set' : 'removed'} status line in ${real}`);
    } catch (e) {
      log.warn(`status line not set in ${file}: ${e.message}`);
    }
  }
}

/** With a shared home set, every account uses it; new accounts get linked as soon as they appear. */
function linkAllAccounts() {
  if (!homeDir()) return;
  accounts().forEach(ensureAccountLinks);
  linkDefaultProjects();
}

/**
 * The Claude extension lists chats from the default folder (~/.claude/projects) until the Claude
 * program reports the account's own folder. So that every chat opens with any account, each project
 * in the shared home also gets a link there. Links hold no data. Skipped when that folder is itself a link.
 */
function linkDefaultProjects() {
  const home = path.join(homeDir(), 'projects');
  const defDir = path.join(os.homedir(), '.claude');
  const defProjects = path.join(defDir, 'projects');
  try {
    if (!fs.existsSync(home) || !fs.existsSync(defProjects)) return;
    if (fs.lstatSync(defDir).isSymbolicLink() || fs.lstatSync(defProjects).isSymbolicLink()) return;
    const have = new Set(fs.readdirSync(defProjects).map((n) => n.toLowerCase()));
    for (const e of fs.readdirSync(home, { withFileTypes: true })) {
      if (!e.isDirectory() || have.has(e.name.toLowerCase())) continue;
      fs.symlinkSync(path.join(home, e.name), path.join(defProjects, e.name), 'junction');
      log.info(`linked ${path.join(defProjects, e.name)} -> shared home`);
    }
  } catch (e) {
    log.warn(`could not link projects into ${defProjects}: ${e.message}`);
  }
}

/** Reads one relay file and applies it to every account using that login folder. */
function applyRelayFile(file) {
  const base = path.basename(file, '.json');
  const targets = accounts().filter((a) => live.liveKey(a.configDir) === base);
  if (!targets.length) return;
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return; // mid-replace; the next event reads it
  }
  for (const a of targets) offerPlan(key(a), live.planFromEvent(record, planCache.get(key(a))));
  post();
}

const relayTimers = new Map();
function watchRelayFiles() {
  const dir = live.liveDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) applyRelayFile(path.join(dir, f));
    watch('relay', dir, {}, (file) => {
      if (!file.endsWith('.json')) return;
      clearTimeout(relayTimers.get(file));
      relayTimers.set(file, setTimeout(() => applyRelayFile(path.join(dir, file)), 30));
    });
  } catch (e) {
    log.warn(`cannot watch ${dir}: ${e.message}`);
  }
}

// ---------- Live plan usage ----------

const signedIn = (a) => Boolean((statusCache.get(key(a)) || {}).loggedIn);
const selectedAccount = () => findAccount(selectedKey) || accounts().find(isActive) || accounts()[0];

/**
 * Asks Claude's usage server for the account's plan usage now. Only the refresh button (and one
 * confirmation after a reset) does this: the server is tightly rate limited, and live numbers arrive
 * through the relay after every reply anyway.
 */
async function checkUsage(account) {
  if (!account || !signedIn(account)) return;
  const k = key(account);
  const info = liveInfo.get(k) || { checking: false, checkedAt: 0, error: null };
  if (info.checking) return;
  liveInfo.set(k, { ...info, checking: true });
  post();
  try {
    const answer = await live.fetchUsageOnce(account.configDir, claudeCommand());
    const livePlan = live.planFromLive(answer);
    if (!livePlan) throw new Error('Claude has no usage numbers right now');
    const saved = await lib.readPlanUsage(account.configDir);
    offerPlan(k, live.acceptLive(planCache.get(k), live.mergePlans(livePlan, saved, planCache.get(k))));
    liveInfo.set(k, { checking: false, checkedAt: Date.now(), error: null });
  } catch (e) {
    log.warn(`usage check for ${account.label} failed: ${e.message}`);
    liveInfo.set(k, { checking: false, checkedAt: Date.now(), error: e.message });
  }
  post();
}

const AUTO_RETRY_MS = 5 * 60 * 1000; // after a failed check, wait this long
const AUTO_FRESH_MS = 10 * 1000; // numbers a reply just updated need no check

/** Seconds between automatic checks (setting claudeAccounts.refreshSeconds, 15 to 600, default 30). */
const refreshMs = () => Math.min(600, Math.max(15, Number(cfg().get('refreshSeconds', 30)) || 30)) * 1000;

/**
 * Keeps the numbers fresh without a click: while the panel is showing and the window is focused, asks
 * Claude for the account's usage every refreshSeconds (30 by default), unless a reply just updated it.
 * "soon" is for moments the user just looked (picking an account, coming back to the window): it uses
 * the shorter of the interval and 15 seconds. A failed check waits 5 minutes.
 */
function autoRefresh(account, soon) {
  if (!account || !cfg().get('autoRefresh', true) || !view || !view.visible || !vscode.window.state.focused || !signedIn(account)) return;
  const k = key(account);
  const info = liveInfo.get(k) || {};
  const plan = planCache.get(k);
  if (Date.now() - ((plan && plan.fetchedAt) || 0) < AUTO_FRESH_MS) return; // a reply just updated it
  const wait = info.error ? AUTO_RETRY_MS : soon ? Math.min(refreshMs(), 15000) : refreshMs();
  if (Date.now() - (info.checkedAt || 0) < wait) return;
  checkUsage(account);
}

/** The account the panel shows and the one in use (the status bar shows it): both stay fresh. */
function autoRefreshVisible(soon) {
  const shown = selectedAccount();
  autoRefresh(shown, soon);
  const used = accounts().find(isActive);
  if (used && used !== shown) autoRefresh(used, soon);
}

/** Finds where each chat's folder is now (it may have moved since the chat started). Once per folder. */
async function resolveFolders(chats) {
  let found = false;
  for (const s of chats) {
    const k = String(s.projectKey).toLowerCase();
    if (folderCache.has(k)) continue;
    folderCache.set(k, null); // mark as in progress so it is looked up once
    const dir = await lib.resolveProjectDir(s.projectKey, [s.cwd, ...workspaceFolders()]).catch(() => null);
    folderCache.set(k, dir || null);
    if (dir) found = true;
  }
  if (found) post();
}

let postTimer;
/** Sends fresh data to the panel (coalesced, so a burst of updates draws once). */
function post() {
  updateStatusBar();
  clearTimeout(postTimer);
  postTimer = setTimeout(() => {
    if (view) view.webview.postMessage({ type: 'state', state: currentState() });
  }, 40);
}

const panelProvider = {
  resolveWebviewView(webviewView) {
    view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] };
    webviewView.webview.html = panelHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg) => onMessage(msg).catch((e) => vscode.window.showErrorMessage(`Claude Accounts could not finish that: ${e.message}`)));
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        post();
        autoRefreshVisible(true);
      }
    });
    webviewView.onDidDispose(() => {
      view = null;
    });
  },
};

async function onMessage(msg) {
  const account = msg.key !== undefined ? findAccount(msg.key) : null;
  switch (msg.type) {
    case 'ready':
      log.info('panel ready');
      return post();
    case 'select':
      selectedKey = lib.normalizeDir(msg.key);
      post(); // draw the new account right away, then save the choice
      autoRefresh(account || selectedAccount(), true);
      return ctx.globalState.update('selected', selectedKey);
    case 'refreshUsage':
      return checkUsage(account);
    case 'activity':
      // Any use of the panel counts as "looking": refresh if the numbers are due (rate limited inside).
      return autoRefreshVisible(true);
    case 'period':
      periodId = msg.period;
      await ctx.globalState.update('period', periodId);
      return post();
    case 'switch':
      return switchTo(account);
    case 'signIn':
      return signIn(account);
    case 'newSession':
      return newSession(account);
    case 'openProject':
      return openProject(msg.path);
    case 'reorder': {
      // Saves the new account order (drag and drop in the panel). Accounts not in the message keep their place at the end.
      const order = new Map((msg.keys || []).map((k, i) => [lib.normalizeDir(k), i]));
      const sorted = accounts().sort((x, y) => (order.get(key(x)) ?? 1e9) - (order.get(key(y)) ?? 1e9));
      await saveAccounts(sorted);
      log.info(`account order: ${sorted.map((a) => a.label).join(', ')}`);
      return post();
    }
    case 'openSession':
      return openSession({ account, sessionId: msg.id, newTab: Boolean(msg.newTab) });
    case 'resume':
      return resumeInTerminal({ account, sessionId: msg.id });
    case 'deleteChat':
      return deleteSession({ account, sessionId: msg.id });
    case 'copyId':
      await vscode.env.clipboard.writeText(msg.id);
      return vscode.window.setStatusBarMessage('Chat ID copied', 2000);
    case 'addAccount':
      return addAccount(msg.group);
    case 'openUsage':
      return vscode.env.openExternal(vscode.Uri.parse(USAGE_URL));
    case 'autoStart': {
      if (!account) return undefined;
      let list = autoList();
      if (msg.on) {
        const r = autostart.add(list, { key: key(account), start: Number(msg.start) });
        list = r.list;
        if (r.error) vscode.window.showWarningMessage(`That window cannot be scheduled: ${{ past: 'its start time has passed', 'too far ahead': 'it is too far ahead', 'too many': 'there are already too many scheduled' }[r.error] || r.error}.`);
      } else {
        list = autostart.remove(list, { key: key(account), start: Number(msg.start) });
      }
      await saveAuto(list);
      armAutoStarts();
      return post();
    }
    case 'rate':
      return rateNow();
    case 'hideRate':
      await saveRating(rating.hideHint(ratingState()));
      return post();
    default:
      return undefined;
  }
}

// ---------- Live data ----------

const pending = new Map(); // job key -> { timer, parts }
const watchers = new Map(); // watch key -> FSWatcher
const historyRuns = new Map(); // history key -> { again }

async function load(account, parts) {
  const k = key(account);
  const jobs = [];
  if (parts.has('status')) {
    jobs.push(lib.readStatus(account.configDir, claudeCommand()).then((s) => statusCache.set(k, s)));
  }
  if (parts.has('plan')) {
    jobs.push(lib.readAccountId(account.configDir).then((id) => accountIds.set(k, id)));
    jobs.push(
      lib.readPlanUsage(account.configDir).then((p) => {
        if (p) offerPlan(k, p); // Claude's saved copy, used if it is newer than what the panel has
      })
    );
  }
  if (parts.has('history')) jobs.push(loadHistory(account));
  await Promise.allSettled(jobs);
  post();
}

/** Reads chats and model usage from the real history folder, one read at a time per folder. */
/**
 * Keeps what each finished 5-hour session used: replies and tokens per model, read from the chat
 * transcripts and stored with the session in the usage history (kept for three years). Together with the
 * session peaks and weekly samples this is the data for learning how you use your limits. Sessions are
 * matched by time, so with accounts used at the same moment a session can include the other's replies.
 */
let archivedAt = 0;
async function archiveModels(account) {
  if (Date.now() - archivedAt < 10 * 60 * 1000) return;
  archivedAt = Date.now();
  const closed = Date.now() - 10 * 60 * 1000;
  const sharing = accounts().filter((a) => histKey(a) === histKey(account));
  const pending = [];
  for (const a of sharing) {
    const acc = usageHistory.accounts[key(a)];
    if (!acc) continue;
    for (const w of Object.values(acc.windows)) if (w.models === undefined && w.end < closed) pending.push(w);
  }
  if (!pending.length) return;
  const records = await lib.readReplyRecords(lib.historyDir(account.configDir), Math.min(...pending.map((w) => w.start)));
  for (const w of pending) w.models = history.modelMix(records, w.start, w.end, lib.modelName);
  saveHistorySoon();
}

/** Saves every recorded session (and what it used) as JSON or CSV, for your own analysis. */
async function exportUsage() {
  const labels = Object.fromEntries(accounts().map((a) => [key(a), a.label]));
  const rows = history.exportRows(usageHistory, labels);
  if (!rows.length) return vscode.window.showInformationMessage('No sessions are recorded yet. They appear as you use Claude with the panel open.');
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(os.homedir(), 'claude-usage-history.json')),
    filters: { JSON: ['json'], CSV: ['csv'] },
    saveLabel: 'Export Usage History',
  });
  if (!target) return undefined;
  const text = /\.csv$/i.test(target.fsPath) ? history.toCsv(rows) : JSON.stringify(rows, null, 2);
  await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
  return vscode.window.showInformationMessage(`Exported ${rows.length} sessions to ${path.basename(target.fsPath)}.`);
}

async function loadHistory(account) {
  const hk = histKey(account);
  const run = historyRuns.get(hk);
  if (run) {
    run.again = true; // a read is in progress; repeat once it finishes
    return;
  }
  const state = { again: false };
  historyRuns.set(hk, state);
  try {
    do {
      state.again = false;
      const dir = lib.historyDir(account.configDir);
      const [chats, models] = await Promise.allSettled([lib.listSessions(dir), lib.readModelUsage(dir)]);
      if (chats.status === 'fulfilled') {
        chatsCache.set(hk, chats.value);
        resolveFolders(chats.value); // runs in the background; the panel redraws when names are found
      }
      if (models.status === 'fulfilled') modelsCache.set(hk, models.value);
      archiveModels(account).catch((e) => log.warn(`usage archive: ${e.message}`));
      if (state.again) post();
    } while (state.again);
  } finally {
    historyRuns.delete(hk);
  }
}

/** Coalesces bursts of file events into one re-read; a shared history is read once for all its accounts. */
function schedule(account, ...parts) {
  for (const part of parts) {
    const jobKey = part === 'history' ? `h:${histKey(account)}` : `a:${key(account)}`;
    const entry = pending.get(jobKey) || { parts: new Set() };
    entry.parts.add(part);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      pending.delete(jobKey);
      load(account, entry.parts);
    }, DEBOUNCE_MS);
    pending.set(jobKey, entry);
  }
}

function watch(watchKey, target, options, onFile) {
  if (watchers.has(watchKey)) return;
  try {
    const w = fs.watch(target, options, (_e, file) => onFile(String(file || '')));
    w.on('error', () => {
      w.close();
      watchers.delete(watchKey); // folder removed; re-attached on the next tick if it comes back
    });
    watchers.set(watchKey, w);
  } catch {
    // folder does not exist yet; re-attached on the next tick
  }
}

function watchAll() {
  const wanted = new Set(['relay']);
  for (const account of accounts()) {
    // Every reply, new chat and title change lands in the history folder.
    const hk = `h:${histKey(account)}`;
    wanted.add(hk);
    watch(hk, lib.projectsPath(lib.historyDir(account.configDir)), { recursive: true }, (file) => {
      if (!file || /\.jsonl?$/i.test(file)) schedule(account, 'history');
    });
    // Claude rewrites .claude.json when it refreshes plan usage; signing in writes .credentials.json.
    const settingsFile = lib.claudeJsonPath(account.configDir);
    const ak = `a:${key(account)}`;
    wanted.add(ak);
    watch(ak, path.dirname(settingsFile), {}, (file) => {
      const name = file.toLowerCase();
      if (name === path.basename(settingsFile).toLowerCase()) schedule(account, 'plan');
      if (name === '.credentials.json') schedule(account, 'status', 'plan', 'history');
    });
  }
  for (const [k, w] of watchers) {
    if (!wanted.has(k)) {
      w.close();
      watchers.delete(k);
    }
  }
}

function loadAll() {
  return Promise.allSettled([
    ...accounts().map((a) => load(a, new Set(['status', 'plan']))),
    ...oncePerHistory().map((a) => load(a, new Set(['history']))),
  ]);
}

function updateStatusBar() {
  if (!statusBar) return;
  const current = accounts().find(isActive);
  const plan = current && planCache.get(key(current));
  const status = current && statusCache.get(key(current));
  statusBar.text = current ? `$(account) ${current.label}${plan && plan.session ? ` · ${plan.session.percent}%` : ''}` : '$(account) Claude';
  statusBar.tooltip = current
    ? `Claude account: ${current.label}${status && status.plan ? ` (${status.plan})` : ''}` +
      (plan && plan.session ? `\nSession ${plan.session.percent}% · weekly ${plan.weekly ? plan.weekly.percent : '?'}%` : '') +
      '\nClick to switch account'
    : 'Claude is using a login folder that is not in your list. Click to switch.';
  statusBar.show();
}

// ---------- Where chats open: our own chat tab, or the Claude extension ----------

/** Our chat tab unless the setting asks for the Claude extension (and it is installed). */
const useChatTab = () => cfg().get('openChatsIn', 'tab') !== 'claudeCode' || !hasClaudeExtension();

// ---------- Opening chats in the Claude extension ----------

/**
 * Opens a chat in the Claude extension. Normally the same way a click in Claude's own chat list does
 * (sidebar or tab, as you set Claude to open); newTab always uses an editor tab, like Claude's
 * "Open in New Tab" command. A chat already open in a tab is brought to the front instead.
 */
async function openInClaude(sessionId, newTab = false) {
  try {
    if (newTab) await vscode.commands.executeCommand(CLAUDE_OPEN, sessionId);
    else await vscode.commands.executeCommand(CLAUDE_OPEN, sessionId, undefined, undefined, undefined, true, { programmatic: 'honor-preferred-location' });
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(`Could not open the chat in the Claude Code extension: ${e.message}. Check that it is installed and enabled.`);
    return false;
  }
}

async function applyAccountSettings(account) {
  const dir = account.configDir || '';
  await ctx.globalState.update(ACTIVE_KEY, dir);
  if (hasClaudeExtension()) {
    // Only with the Claude extension installed: its setting can't be written when it is not registered.
    const claudeCfg = vscode.workspace.getConfiguration('claudeCode');
    const nextEnv = lib.envListWithDir(claudeCfg.get('environmentVariables'), dir);
    await claudeCfg.update('environmentVariables', nextEnv.length ? nextEnv : undefined, vscode.ConfigurationTarget.Global);
  }
  const termCfg = vscode.workspace.getConfiguration('terminal.integrated');
  const nextTerm = lib.terminalEnvWithDir(termCfg.get(TERMINAL_ENV), dir);
  await termCfg.update(TERMINAL_ENV, Object.keys(nextTerm).length ? nextTerm : undefined, vscode.ConfigurationTarget.Global);
  selectedKey = key(account);
  await ctx.globalState.update('selected', selectedKey);
}

const remember = (account, folder, sessionId, newTab = false) =>
  ctx.globalState.update(PENDING_KEY, { sessionId: sessionId || null, newTab, folder: lib.normalizeDir(folder || ''), configDir: key(account), at: Date.now() });

/** After a reload or in a new window: open the chat that was asked for, once Claude is ready. */
async function openPending() {
  const p = ctx.globalState.get(PENDING_KEY);
  if (!p) return;
  if (!hasClaudeExtension()) {
    await ctx.globalState.update(PENDING_KEY, undefined);
    return;
  }
  const fresh = Date.now() - p.at < PENDING_TTL;
  const here = workspaceFolders()[0] ? lib.normalizeDir(workspaceFolders()[0]) : '';
  const rightPlace = (!p.folder || p.folder === here) && p.configDir === lib.normalizeDir(activeDir());
  if (!fresh) {
    await ctx.globalState.update(PENDING_KEY, undefined);
    return;
  }
  if (!rightPlace) return; // meant for another window that is still starting
  await ctx.globalState.update(PENDING_KEY, undefined);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      if (p.newTab) await vscode.commands.executeCommand(CLAUDE_OPEN, p.sessionId || undefined);
      else await vscode.commands.executeCommand(CLAUDE_OPEN, p.sessionId || undefined, undefined, undefined, undefined, true, { programmatic: 'honor-preferred-location' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1500)); // Claude is still starting
    }
  }
}

const terminalName = (session) => `Claude: ${session.title.slice(0, 32)}`;

async function openSession(arg) {
  // History is shared, so a chat always continues with the account Claude is using now.
  const picked = accountFrom(arg);
  const session = sessionFrom(arg, picked);
  const account = accounts().find(isActive) || picked;
  if (!account || !session) return;
  if (signedOut(account)) {
    const pick = await vscode.window.showWarningMessage(`Sign in to ${account.label} to open this chat.`, 'Sign In');
    if (pick) signIn(account);
    return;
  }
  // Two Claude processes writing one chat can mix up its messages: warn if it runs in a terminal.
  const running = vscode.window.terminals.find((t) => t.name === terminalName(session) && t.exitStatus === undefined);
  if (running) {
    const pick = await vscode.window.showWarningMessage(
      `"${session.title}" is running in a terminal.`,
      { modal: true, detail: 'Opening it in a Claude tab as well means two Claude processes write to the same chat. Finish there first (type /exit), then open it here.' },
      'Show Terminal',
      'Open Anyway'
    );
    if (pick === 'Show Terminal') running.show();
    if (pick !== 'Open Anyway') return;
  }
  const here = workspaceFolders()[0];
  const inThisFolder = Boolean(here) && lib.sameKey(lib.encodeProjectPath(here), session.projectKey);
  if (useChatTab()) {
    // The chat tab runs Claude in the chat's own folder, so no project has to be opened first.
    const dir = inThisFolder ? here : folderCache.get(String(session.projectKey).toLowerCase()) || (await lib.resolveProjectDir(session.projectKey, [session.cwd, ...workspaceFolders()]));
    if (!dir) {
      vscode.window.showWarningMessage(`This chat ran in ${session.cwd || session.projectKey}, which no longer exists, so it cannot continue.`);
      return;
    }
    // Accounts with separate histories: the chat only exists in its own account's folder.
    const own = picked && histKey(picked) !== histKey(account) ? picked : null;
    if (own && signedOut(own)) {
      const pick = await vscode.window.showWarningMessage(`This chat belongs to ${own.label}, which is not signed in.`, 'Sign In');
      if (pick) signIn(own);
      return;
    }
    chat.open({ session, cwd: dir, account: own });
    noteUse('chat');
    return;
  }
  if (inThisFolder) {
    await openInClaude(session.id, Boolean(arg.newTab));
    return;
  }

  const folder = inThisFolder
    ? here
    : folderCache.get(String(session.projectKey).toLowerCase()) || (await lib.resolveProjectDir(session.projectKey, [session.cwd, ...workspaceFolders()]));
  if (!folder) {
    const pick = await vscode.window.showWarningMessage(
      `This chat ran in ${session.cwd || session.projectKey}, which no longer exists, so Claude cannot open it.`,
      'Show Chat File'
    );
    if (pick) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(session.file));
    return;
  }
  const name = path.basename(folder) || folder;

  // A chat from another project: open that project (its folder, chats and context); the chat opens by itself.
  const pick = await vscode.window.showInformationMessage(
    `Open project ${name} to continue this chat?`,
    { modal: true, detail: `"${session.title}" belongs to ${folder}. VS Code opens that project, then the chat opens in Claude with ${account.label}.` },
    'This Window',
    'New Window'
  );
  if (!pick) return;
  await remember(account, folder, session.id, Boolean(arg.newTab));
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: pick === 'New Window' });
}

/** Opens a project in VS Code (this window), with its own chats and context. */
async function openProject(folder) {
  if (!folder || !fs.existsSync(folder)) {
    vscode.window.showWarningMessage(`${folder || 'That project'} is not on this PC any more.`);
    return;
  }
  const here = workspaceFolders()[0];
  if (here && lib.normalizeDir(here) === lib.normalizeDir(folder)) return;
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: false });
}

// ---------- Other actions ----------

async function switchTo(arg) {
  const account = accountFrom(arg);
  if (!account) return;
  if (isActive(account)) {
    vscode.window.setStatusBarMessage(`$(account) Claude is already using ${account.label}.`, 3000);
    return;
  }
  if (signedOut(account)) {
    const pick = await vscode.window.showWarningMessage(`${account.label} is not signed in yet.`, 'Sign In');
    if (pick === 'Sign In') signIn(account);
    return;
  }
  // No reload: the Claude extension notices the new login folder by itself. Chats, projects, memory,
  // skills and rules are shared, so only the engine changes.
  await applyAccountSettings(account);
  post();
  autoRefresh(account, true);
  noteUse('switch');
  vscode.window.setStatusBarMessage(`$(account) Claude now uses ${account.label}. Open chats move over after their current reply.`, 8000);
  log.info(`switched to ${account.label}`);
  moveOpenChatsToActiveAccount().catch((e) => log.warn(`moving open chats: ${e.message}`));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let moving = 0;

/**
 * A Claude chat tab keeps the account it started with. After a switch, each open Claude tab is
 * reopened on the new account once its chat is idle (nothing written for a few seconds): same chat,
 * same place, a fresh Claude process. A message you typed but did not send is not kept.
 */
async function moveOpenChatsToActiveAccount() {
  if (!hasClaudeExtension()) return; // chat tabs move over by themselves on their next message
  const run = ++moving;
  const isClaudeTab = (t) => t.input && typeof t.input.viewType === 'string' && /claudeVSCodePanel/i.test(t.input.viewType);
  const active = accounts().find(isActive);
  if (!active) return;
  await loadHistory(active);
  const chats = chatsCache.get(histKey(active)) || [];
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(isClaudeTab);
  for (const tab of tabs) {
    const label = String(tab.label || '').replace(/[.…]+$/, '').trim();
    const session = label && chats.find((s) => s.title === label || s.title.startsWith(label) || label.startsWith(s.title));
    if (!session) {
      log.info(`left Claude tab "${tab.label}" as it is (new chat, or title not matched)`);
      continue;
    }
    for (let i = 0; i < 900; i += 1) {
      if (run !== moving) return; // switched again meanwhile
      let busy = false;
      try {
        busy = Date.now() - fs.statSync(session.file).mtimeMs < 5000;
      } catch {
        // file gone
      }
      if (!busy) break;
      await sleep(2000);
    }
    const column = tab.group.viewColumn;
    const still = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t === tab || (isClaudeTab(t) && t.label === tab.label));
    if (!still) continue; // closed meanwhile
    await vscode.window.tabGroups.close(still, true);
    await sleep(300);
    await vscode.commands.executeCommand(CLAUDE_OPEN, session.id, undefined, column);
    log.info(`reopened "${session.title}" on ${active.label}`);
  }
}

/** Signs an account out (Claude's own `auth logout` for that login folder). Chats, memory and skills stay. */
async function signOut(arg) {
  const account = accountFrom(arg);
  if (!account) return;
  const ok = await vscode.window.showWarningMessage(
    `Sign out ${account.label}?`,
    { modal: true, detail: `${isActive(account) ? 'Claude in VS Code is using this account right now, so it will stop working until you sign in again or switch. ' : ''}Chats, memory and skills are kept; you can sign in again any time.` },
    'Sign Out'
  );
  if (ok !== 'Sign Out') return;
  const env = { ...process.env };
  delete env[lib.ENV_KEY];
  if (account.configDir) env[lib.ENV_KEY] = account.configDir;
  await new Promise((resolve) => {
    execFile(claudeCommand(), ['auth', 'logout'], { env, timeout: 30000, windowsHide: true }, (err) => {
      if (err) vscode.window.showErrorMessage(`Could not sign out ${account.label}: ${err.message}`);
      else log.info(`signed out ${account.label}`);
      resolve();
    });
  });
  planCache.delete(key(account));
  await load(account, new Set(['status', 'plan']));
}

function signIn(arg) {
  const account = accountFrom(arg);
  if (!account) return;
  if (account.configDir) fs.mkdirSync(account.configDir, { recursive: true });
  // Claude runs directly in the terminal (no shell), so it works the same in PowerShell, cmd, bash or zsh.
  // `auth login` opens the browser sign-in; the panel notices the new login by itself.
  claudeTerminal(`Sign in: ${account.label}`, account, ['auth', 'login', '--claudeai']);
  vscode.window.setStatusBarMessage(`Sign in to ${account.label} in the browser that opened. The panel updates by itself.`, 15000);
}

function claudeTerminal(name, account, args, cwd) {
  const term = vscode.window.createTerminal({ name, cwd, shellPath: claudeCommand(), shellArgs: args, env: { [lib.ENV_KEY]: account.configDir || null } });
  term.show();
  return term;
}

async function newSession(arg) {
  const account = accountFrom(arg) || accounts().find(isActive);
  if (!account) return;
  if (signedOut(account)) return signIn(account);
  if (!isActive(account)) {
    // Another account: switch (no reload), then start the chat on it.
    await switchTo(account);
    await sleep(useChatTab() ? 0 : 800);
  }
  if (useChatTab()) chat.open({});
  else await openInClaude(undefined);
  noteUse('chat');
}

/**
 * Deletes a chat from this PC: its transcript, its attachment folder and its edit history move to the
 * Recycle Bin / Trash (restorable there). Refuses while the chat is running.
 */
async function deleteSession(arg) {
  const account = accountFrom(arg);
  const session = sessionFrom(arg, account);
  if (!account || !session) return;
  const running = vscode.window.terminals.find((t) => t.name === terminalName(session) && t.exitStatus === undefined);
  if (running || chat.isOpen(session.id) || Date.now() - session.mtimeMs < 2 * 60 * 1000) {
    vscode.window.showWarningMessage(`"${session.title}" is running right now. Finish it (or wait a couple of minutes) before deleting it.`);
    return;
  }
  const shared = accounts().filter((a) => histKey(a) === histKey(account)).length > 1;
  const ok = await vscode.window.showWarningMessage(
    `Delete "${session.title}"?`,
    {
      modal: true,
      detail: `It moves to the ${TRASH}, so you can restore it from there.${shared ? ' Chats are shared, so it disappears for every account.' : ''}`,
    },
    'Delete'
  );
  if (ok !== 'Delete') return;
  const dir = path.dirname(session.file);
  const targets = [
    session.file,
    path.join(dir, session.id),
    path.join(lib.historyDir(account.configDir), 'file-history', session.id),
    account.configDir ? path.join(account.configDir, 'file-history', session.id) : '',
  ].filter((p, i, all) => p && all.indexOf(p) === i && fs.existsSync(p));
  try {
    for (const p of targets) await vscode.workspace.fs.delete(vscode.Uri.file(p), { recursive: true, useTrash: true });
    log.info(`deleted chat ${session.id} (${targets.length} items to the ${TRASH})`);
    vscode.window.setStatusBarMessage(`Deleted "${session.title}" (in the ${TRASH})`, 5000);
  } catch (e) {
    vscode.window.showErrorMessage(`Could not delete the chat: ${e.message}`);
  }
  schedule(account, 'history');
}

/** Kept as a right-click option: continue a chat in a terminal without switching the Claude panel. */
async function resumeInTerminal(arg) {
  const account = accountFrom(arg);
  const session = sessionFrom(arg, account);
  if (!account || !session) return;
  const folder = await lib.resolveProjectDir(session.projectKey, [session.cwd, ...workspaceFolders()]);
  if (!folder) {
    vscode.window.showWarningMessage(`This chat ran in ${session.cwd || session.projectKey}, which no longer exists.`);
    return;
  }
  claudeTerminal(terminalName(session), account, ['--resume', session.id], folder);
}

async function searchAllChats() {
  const items = [];
  for (const a of oncePerHistory()) {
    const set = accounts().filter((x) => histKey(x) === histKey(a));
    const owner = set.find(isActive) || set.find((x) => !signedOut(x)) || a;
    for (const session of chatsCache.get(histKey(a)) || []) {
      const folder = path.basename((session.cwd || session.projectKey).replace(/[\\/]+$/, '')) || session.cwd;
      items.push({ label: session.title, description: `${folder} · ${lib.fmtAgoShort(session.mtimeMs)}`, account: owner, session });
    }
  }
  if (!items.length) return vscode.window.showInformationMessage('No chats yet. Start one with New Session.');
  const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Search chats in all accounts', matchOnDescription: true });
  if (choice) await openSession({ account: choice.account, session: choice.session });
}

async function addAccount() {
  const how = await vscode.window.showQuickPick(
    [
      { id: 'new', label: '$(sign-in) Sign in with another Claude account', detail: 'Opens the Claude sign-in in your browser. Each account gets its own login folder.' },
      { id: 'existing', label: '$(folder-opened) Use a login folder already on this computer', detail: 'For a Claude account that is already signed in (a folder used as CLAUDE_CONFIG_DIR).' },
    ],
    { placeHolder: 'Add an account' }
  );
  if (!how) return;

  let label;
  let dir;
  if (how.id === 'existing') {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      openLabel: 'Use this login folder',
      defaultUri: vscode.Uri.file(os.homedir()),
    });
    if (!picked || !picked[0]) return;
    dir = picked[0].fsPath;
    const guess = path.basename(dir).replace(/^\.?claude-?/i, '');
    label = await vscode.window.showInputBox({ prompt: 'Name to show for this account', validateInput: (v) => (!v.trim() ? 'Enter a name' : accounts().some((a) => a.label.toLowerCase() === v.trim().toLowerCase()) ? 'Another account already has this name. Pick a different one.' : null), value: guess ? guess.charAt(0).toUpperCase() + guess.slice(1) : '', ignoreFocusOut: true });
  } else {
    label = await vscode.window.showInputBox({
      prompt: 'Name for the new account',
      placeHolder: 'For example: Work',
      ignoreFocusOut: true,
      validateInput: (v) => (!v.trim() ? 'Enter a name' : accounts().some((a) => a.label.toLowerCase() === v.trim().toLowerCase()) ? 'Another account already has this name. Pick a different one.' : null),
    });
    if (label) {
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'account';
      // Next to the shared home when one is set (keeps everything on one drive), else in your user folder.
      const base = homeDir() ? path.dirname(homeDir()) : os.homedir();
      dir = path.join(base, '.claude-accounts', slug);
    }
  }
  if (!label || !dir) return;
  label = label.trim();
  if (accounts().some((a) => key(a) === lib.normalizeDir(dir))) {
    vscode.window.showWarningMessage(`That login folder is already in the list: ${dir}`);
    return;
  }
  const account = { label, group: 'Accounts', configDir: dir };
  ensureAccountLinks(account); // with a shared home: same projects, chats, memory, skills and rules
  await saveAccounts([...accounts(), account]); // keeps the default account when this is the first one added
  selectedKey = lib.normalizeDir(dir);
  await ctx.globalState.update('selected', selectedKey);
  post();
  if (how.id === 'new') signIn(account);
}

async function removeAccount(arg) {
  const account = accountFrom(arg);
  if (!account) return;
  if (isActive(account)) return vscode.window.showWarningMessage('Switch to another account before removing this one.');
  const ok = await vscode.window.showWarningMessage(`Remove ${account.label} from the list?`, { modal: true, detail: 'Its login and chats stay on disk.' }, 'Remove');
  if (ok !== 'Remove') return;
  await saveAccounts(accounts().filter((a) => key(a) !== key(account)));
}

async function pickAccount() {
  const items = accounts().map((a) => {
    const s = statusCache.get(key(a));
    const plan = planCache.get(key(a));
    return {
      label: `${isActive(a) ? '$(pass-filled)' : '$(circle-large-outline)'} ${a.label}`,
      description: s && !s.loggedIn ? 'not signed in' : [s && s.plan, plan && plan.session ? `5h ${plan.session.percent}%` : '', plan && plan.weekly ? `week ${plan.weekly.percent}%` : ''].filter(Boolean).join(' · '),
      account: a,
    };
  });
  const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Which account should Claude use?' });
  if (choice && choice.account) await switchTo(choice.account);
}

let log = { info() {}, warn() {}, error() {} };

function activate(context) {
  ctx = context;
  log = vscode.window.createOutputChannel('Claude Accounts', { log: true });
  context.subscriptions.push(log);
  log.info(`activated v${context.extension ? context.extension.packageJSON.version : '?'}`);
  periodId = context.globalState.get('period', '7d');
  selectedKey = context.globalState.get('selected', '') || lib.normalizeDir(activeDir());
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'claudeAccounts.pick';
  autoBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  autoBar.command = 'claudeAccounts.autoStarts';

  chat.init({
    ctx: context,
    log,
    claudeCommand,
    activeAccount: () => accounts().find(isActive) || accounts()[0],
    // A chat tab gets the usage line with every reply, so the panel updates without the relay.
    onUsage: (account, event) => {
      if (!account) return;
      offerPlan(key(account), live.planFromEvent({ at: Date.now(), event }, planCache.get(key(account))));
      post();
    },
    onChatChanged: () => oncePerHistory().forEach((a) => schedule(a, 'history')),
  });

  const tick = setInterval(() => {
    linkAllAccounts();
    watchAll();
    accounts().forEach((a) => schedule(a, 'plan'));
    oncePerHistory().forEach((a) => schedule(a, 'history'));
    // Every minute: re-read Claude's saved usage and chats (above), apply any reset, redraw.
    handleResets();
    post();
    autoRefreshVisible();
    if (autostart.due(autoList()).length || autostart.missed(autoList()).length) runAutoStarts().catch(() => {});
    else armAutoStarts();
  }, TICK_MS);
  const refreshTick = setInterval(() => autoRefreshVisible(), 10 * 1000); // checks the interval, so the cadence is refreshSeconds
  const statusTick = setInterval(() => accounts().forEach((a) => schedule(a, 'status')), STATUS_MS);
  const reg = (id, fn) => vscode.commands.registerCommand(id, fn);

  context.subscriptions.push(
    statusBar,
    autoBar,
    {
      dispose: () => {
        clearInterval(tick);
        clearInterval(statusTick);
        clearInterval(refreshTick);
        clearTimeout(resetTimer);
        watchers.forEach((w) => w.close());
      },
    },
    vscode.window.onDidChangeWindowState((w) => w.focused && autoRefreshVisible(true)),
    vscode.window.registerWebviewViewProvider(VIEW_ID, panelProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    reg('claudeAccounts.refreshUsage', () => checkUsage(selectedAccount())),
    reg('claudeAccounts.switch', switchTo),
    reg('claudeAccounts.pick', pickAccount),
    reg('claudeAccounts.signIn', signIn),
    reg('claudeAccounts.signOut', signOut),
    reg('claudeAccounts.newSession', newSession),
    reg('claudeAccounts.openChat', () => chat.open({})),
    reg('claudeAccounts.openSession', openSession),
    reg('claudeAccounts.resumeInTerminal', resumeInTerminal),
    reg('claudeAccounts.deleteSession', deleteSession),
    reg('claudeAccounts.copySessionId', (arg) => arg && arg.sessionId && vscode.env.clipboard.writeText(arg.sessionId)),
    reg('claudeAccounts.searchSessions', searchAllChats),
    reg('claudeAccounts.rate', rateNow),
    reg('claudeAccounts.exportUsage', exportUsage),
    reg('claudeAccounts.autoStarts', manageAutoStarts),
    reg('claudeAccounts.testAutoStart', testAutoStart),
    reg('claudeAccounts.simulateAlert', simulateAlert),
    reg('claudeAccounts.openUsagePage', () => vscode.env.openExternal(vscode.Uri.parse(USAGE_URL))),
    reg('claudeAccounts.refresh', () => {
      loadAll();
      checkUsage(selectedAccount());
    }),
    reg('claudeAccounts.add', () => addAccount()),
    reg('claudeAccounts.remove', removeAccount),
    reg('claudeAccounts.toggleLiveUsage', async () => {
      const on = cfg().get('liveUsage', true);
      await cfg().update('liveUsage', !on, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        on ? 'Live usage is off. Usage now updates when Claude saves it or when you press refresh.' : 'Live usage is on. It starts with the next message in a newly opened Claude chat.'
      );
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeAccounts.liveUsage') || e.affectsConfiguration(`claudeCode.${RELAY_SETTING}`)) setupRelay();
      if (e.affectsConfiguration('claudeAccounts')) {
        watchAll();
        loadAll();
      } else if (e.affectsConfiguration('claudeCode.environmentVariables')) {
        post();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => post()),
    // The Claude extension installed or removed: relay and account setting follow.
    vscode.extensions.onDidChange(() => {
      setupRelay();
      post();
    })
  );
  updateStatusBar();
  watchAll();
  loadUsageHistory();
  watchRelayFiles();
  linkAllAccounts();
  loadAll();
  setupRelay();
  setTimeout(() => openPending(), 1500);
  setTimeout(() => runAutoStarts().catch(() => {}), 4000); // missed or due schedules from before a restart
}

function deactivate() {}

module.exports = { activate, deactivate };
