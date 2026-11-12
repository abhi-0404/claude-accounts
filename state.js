// Builds the plain data the panel draws. No VS Code APIs here, so it can be tested on its own.
const os = require('os');
const path = require('path');
const lib = require('./lib');

const MAX_SESSIONS = 400;
const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

const baseName = (p) => {
  const full = String(p || '').replace(/[\\/]+$/, '');
  return path.win32.basename(full) || full;
};

/**
 * Short folder name for a chat, e.g. "shop-api" for D:\work\shop-api, "D:" for D:\. A chat started before
 * its folder was moved still records the old path, so an open folder with the same history name wins.
 */
function folderLabel(session, knownFolders = [], resolved = new Map()) {
  const current =
    knownFolders.find((f) => lib.sameKey(lib.encodeProjectPath(f), session.projectKey)) ||
    resolved.get(String(session.projectKey).toLowerCase());
  if (current) return baseName(current);
  return session.cwd ? baseName(session.cwd) : session.projectKey || '';
}

/** Full path for a chat's folder: where it is now if known, else where it started. */
function folderPath(session, resolved = new Map()) {
  return resolved.get(String(session.projectKey).toLowerCase()) || session.cwd || session.projectKey;
}

/** One row per model name (dated ids of the same model merge); Claude's internal placeholder entries are left out. */
function modelRows(rows) {
  const byName = new Map();
  for (const r of rows || []) {
    if (!r.model || /^<.*>$/.test(r.model)) continue;
    const name = lib.modelName(r.model);
    const m = byName.get(name) || { name, replies: 0, input: 0, cacheRead: 0, output: 0, total: 0 };
    m.replies += r.replies;
    m.input += r.input;
    m.cacheRead += r.cacheRead;
    m.output += r.output;
    m.total += r.total;
    byName.set(name, m);
  }
  return [...byName.values()].sort((x, y) => y.total - x.total);
}

/**
 * @param {object} input
 * @param {{label:string, group:string, configDir:string}[]} input.accounts
 * @param {string[]} input.groups
 * @param {string} input.activeDir     CLAUDE_CONFIG_DIR the Claude extension uses ('' = default)
 * @param {string} input.selectedKey   account the panel shows details for
 * @param {string} input.period        '5h' | '7d' | 'all'
 * @param {string[]} input.workspaceFolders
 * @param {Map} input.status  account key -> claude auth status
 * @param {Map} input.plans   account key -> plan usage
 * @param {Map} input.chats   history key -> sessions
 * @param {Map} input.models  history key -> model usage
 */
function buildState(input) {
  const { accounts, groups, activeDir, period, workspaceFolders, status, plans, chats, models } = input;
  const folders = input.folders || new Map(); // lower-case history name -> folder on disk
  const liveInfo = input.live || new Map(); // account key -> { checking, checkedAt, error }
  const key = (a) => lib.normalizeDir(a.configDir);
  const histDirs = new Map(accounts.map((a) => [key(a), lib.historyDir(a.configDir)]));
  const histKey = (a) => lib.normalizeDir(histDirs.get(key(a)));
  const active = lib.normalizeDir(activeDir);

  const views = accounts.map((a) => {
    const s = status.get(key(a));
    return {
      key: key(a),
      label: a.label,
      group: a.group,
      configDir: a.configDir || path.join(os.homedir(), '.claude'),
      active: key(a) === active,
      // 'error': Claude Code could not be run at all (signed-out accounts still answer with JSON).
      status: !s ? 'checking' : s.loggedIn ? 'signedIn' : s.error ? 'error' : 'signedOut',
      email: (s && s.email) || '',
      org: (s && s.orgName) || '',
      plan: capitalize(s && s.plan),
      histKey: histKey(a),
      accountId: (input.accountIds && input.accountIds.get(key(a))) || '',
      usage: plans.get(key(a)) || null,
      live: liveInfo.get(key(a)) || { checking: false, checkedAt: 0, error: null },
      weekly: (input.weekly && input.weekly.get(key(a))) || null,
    };
  });

  const histories = {};
  for (const a of accounts) {
    const hk = histKey(a);
    if (histories[hk]) continue;
    const list = chats.get(hk);
    const usage = models.get(hk);
    histories[hk] = {
      loaded: Boolean(list),
      dir: lib.projectsPath(histDirs.get(key(a))),
      sharedWith: accounts.filter((x) => histKey(x) === hk).map((x) => x.label),
      total: list ? list.length : 0,
      sessions: (list || []).slice(0, MAX_SESSIONS).map((s) => ({
        id: s.id,
        title: s.title,
        mtimeMs: s.mtimeMs,
        projectKey: s.projectKey,
        owners: s.owners || [],
        cwd: folderPath(s, folders),
        folder: folderLabel(s, workspaceFolders, folders),
      })),
      models: usage ? { '5h': modelRows(usage.last5h), '7d': modelRows(usage.last7d), all: modelRows(usage.allTime) } : null,
    };
  }

  const keys = new Set(views.map((v) => v.key));
  const selected = keys.has(input.selectedKey) ? input.selectedKey : (views.find((v) => v.active) || views[0] || {}).key || '';
  const workspaceKey = workspaceFolders.length ? lib.encodeProjectPath(workspaceFolders[0]).toLowerCase() : '';

  // Projects ("compartments"): one row per project folder that has chats, newest first.
  const activeView = views.find((v) => v.active);
  const homeHistory = activeView ? histories[activeView.histKey] : Object.values(histories)[0];
  const byProject = new Map();
  for (const s of (homeHistory && homeHistory.sessions) || []) {
    const k = s.projectKey.toLowerCase();
    const p = byProject.get(k) || { key: s.projectKey, name: s.folder, path: s.cwd, chats: 0, last: 0, current: k === workspaceKey };
    p.chats += 1;
    p.last = Math.max(p.last, s.mtimeMs);
    byProject.set(k, p);
  }
  const projects = [...byProject.values()].sort((x, y) => Number(y.current) - Number(x.current) || y.last - x.last);

  // The account in use is out of usage: suggest the next signed-in account (list order) that is not.
  const out = (v) => Boolean(v && v.usage && ((v.usage.session && v.usage.session.percent >= 100) || (v.usage.weekly && v.usage.weekly.percent >= 100)));
  let banner = null;
  if (out(activeView)) {
    const u = activeView.usage;
    const limit = u.weekly && u.weekly.percent >= 100 ? u.weekly : u.session;
    const next = views.find((v) => !v.active && v.status === 'signedIn' && !out(v));
    banner = { account: activeView.label, until: limit.resetsAt || null, suggestKey: next ? next.key : '', suggestLabel: next ? next.label : '' };
  }

  return {
    now: Date.now(),
    relay: input.relay || 'off',
    period: ['5h', '7d', 'all'].includes(period) ? period : '7d',
    selected,
    // Claude opens chats of the first folder in the window; that one is "this folder".
    workspaceKey,
    projects,
    banner,
    workspaceName: workspaceFolders.length ? path.win32.basename(workspaceFolders[0].replace(/[\\/]+$/, '')) || workspaceFolders[0] : '',
    groups: groups.map((name) => ({ name, accounts: views.filter((v) => v.group === name) })),
    histories,
  };
}

module.exports = { buildState, folderLabel, folderPath, MAX_SESSIONS };
