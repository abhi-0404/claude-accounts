// Fictional accounts, chats and usage for the screenshots and animations. No real data is used anywhere.
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const lib = require(path.join(root, 'lib.js'));
const h = require(path.join(root, 'history.js'));
const { buildState } = require(path.join(root, 'state.js'));

const H = 3600e3;
const MIN = 60e3;

const ACCOUNTS = [
  { label: 'Work', configDir: 'C:\\demo\\work', email: 'sam@northwind.example', org: 'Northwind', plan: 'team', id: 'id-work' },
  { label: 'Personal', configDir: 'C:\\demo\\personal', email: 'sam.rivera@mail.example', org: 'Personal', plan: 'pro', id: 'id-personal' },
  { label: 'Studio', configDir: 'C:\\demo\\studio', email: 'sam@pixelstudio.example', org: 'Pixel Studio', plan: 'max', id: 'id-studio' },
];

const PROJECTS = {
  storefront: 'C:\\code\\storefront-api',
  mobile: 'C:\\code\\mobile-app',
  docs: 'C:\\code\\docs-site',
  pipeline: 'C:\\code\\data-pipeline',
  portfolio: 'C:\\code\\portfolio',
};

// [title, project, minutes ago, owners]
const CHATS = [
  ['Fix checkout total rounding', 'storefront', 18, ['id-work']],
  ['Add rate limiting to the orders endpoint', 'storefront', 95, ['id-work']],
  ['Write migration for the invoices table', 'storefront', 26 * 60, ['id-work', 'id-studio']],
  ['Why does the cart test fail on CI?', 'storefront', 3 * 24 * 60, ['id-work']],
  ['Dark mode for the settings screen', 'mobile', 42, ['id-personal']],
  ['Crash when the app resumes from background', 'mobile', 5 * 60, ['id-personal']],
  ['Push notification permissions flow', 'mobile', 2 * 24 * 60, ['id-personal', 'id-work']],
  ['Rewrite the getting started guide', 'docs', 3 * 60, ['id-studio']],
  ['Broken links report', 'docs', 28 * 60, ['id-studio']],
  ['Speed up the nightly ETL job', 'pipeline', 7 * 60, ['id-work']],
  ['Dedupe events from the webhook feed', 'pipeline', 4 * 24 * 60, ['id-work']],
  ['Case study layout ideas', 'portfolio', 9 * 60, ['id-studio']],
  ['Optimise hero images', 'portfolio', 6 * 24 * 60, ['id-studio']],
];

/** 3 weeks of 5-hour sessions run through the real history code, so the chart is the real thing. */
function weeklyInfo(now, { resetInHours, plan, share = 0.12 }) {
  const reset = now + resetInHours * H;
  const store = h.emptyStore();
  let cycleEnd = reset - 3 * 7 * 24 * H;
  plan.forEach((sessions) => {
    const cEnd = cycleEnd + 7 * 24 * H;
    const cStart = cEnd - 7 * 24 * H;
    let weekly = 0;
    for (const [hrs, peak] of sessions) {
      const start = cStart + hrs * H;
      if (start > now) break;
      const end = start + 5 * H;
      for (let step = 1; step <= 4; step += 1) {
        const at = Math.min(start + step * H, now);
        const pct = Math.round((peak * step) / 4);
        weekly = Math.min(100, weekly + Math.round((peak / 4) * share));
        h.record(store, 'k', { fetchedAt: at, session: { percent: pct, resetsAt: new Date(end).toISOString() }, weekly: { percent: weekly, resetsAt: new Date(cEnd).toISOString() } }, at);
      }
    }
    cycleEnd = cEnd;
  });
  const resetIso = new Date(reset).toISOString();
  return {
    series: h.series(store, 'k', now - 92 * 24 * H),
    cycles: h.cycles(store, 'k', resetIso, 13, now),
    weeklyReset: resetIso,
    summary: h.weekSummary(store, 'k', resetIso, now),
    perSession: Math.round(share * 100),
    share,
    alert: null,
  };
}

const PLAN_A = [
  [[10, 55], [30, 70], [52, 40], [80, 85], [100, 60], [130, 35], [150, 50]],
  [[8, 25], [33, 60], [60, 45], [77, 90], [105, 20], [128, 70], [155, 30], [160, 40]],
  [[6, 45], [14, 60], [30, 38], [38, 52], [56, 62], [74, 35], [82, 40], [98, 23], [104, 25]],
];
const PLAN_B = [
  [[20, 35], [60, 55], [100, 30], [140, 40]],
  [[16, 40], [52, 50], [90, 35], [135, 60]],
  [[12, 30], [44, 40], [70, 20]],
];
const PLAN_C = [
  [[5, 60], [26, 80], [50, 70], [76, 90], [100, 85], [128, 60]],
  [[4, 70], [30, 85], [55, 75], [82, 80], [110, 90], [140, 70]],
  [[8, 40], [20, 55], [34, 30]],
];

function build(selectedLabel, activeLabel = 'Work', now = Date.now()) {
  const accounts = ACCOUNTS.map((a) => ({ label: a.label, group: 'Accounts', configDir: a.configDir }));
  const status = new Map();
  const plans = new Map();
  const weekly = new Map();
  const accountIds = new Map();
  const defs = {
    Work: { session: [18, 2 * H + 10 * MIN], week: [34, 2.4 * 24 * H], extra: { used: 18.72, limit: 200, currency: 'USD', percent: 9 }, plan: PLAN_A, resetH: 2.4 * 24 },
    Personal: { session: [72, 3 * H + 5 * MIN], week: [31, 26 * H], extra: null, plan: PLAN_B, resetH: 26, alert: true },
    Studio: { session: [0, null], week: [64, 4.6 * 24 * H], extra: null, plan: PLAN_C, resetH: 4.6 * 24 },
  };
  for (const a of ACCOUNTS) {
    const k = lib.normalizeDir(a.configDir);
    const d = defs[a.label];
    status.set(k, { loggedIn: true, email: a.email, orgName: a.org, plan: a.plan });
    accountIds.set(k, a.id);
    plans.set(k, {
      fetchedAt: now - 40e3,
      live: true,
      session: { percent: d.session[0], resetsAt: d.session[1] ? new Date(now + d.session[1]).toISOString() : null, severity: 'normal' },
      weekly: { percent: d.week[0], resetsAt: new Date(now + d.week[1]).toISOString(), severity: 'normal' },
      extra: d.extra,
      breakdown: [],
    });
    const info = weeklyInfo(now, { resetInHours: d.resetH, plan: d.plan });
    if (d.alert) {
      info.alert = h.weeklyAlert({ session: plans.get(k).session, weekly: plans.get(k).weekly }, 0.12, now, { sessionsPerDay: 1.6, avgUse: 38, learned: true });
    }
    weekly.set(k, info);
  }
  const folders = new Map(Object.values(PROJECTS).map((d) => [lib.encodeProjectPath(d).toLowerCase(), d]));
  const sessions = CHATS.map(([title, proj, mins, owners], i) => ({
    id: `demo-${i}`,
    title,
    mtimeMs: now - mins * MIN,
    projectKey: lib.encodeProjectPath(PROJECTS[proj]),
    cwd: PROJECTS[proj],
    owners,
  }));
  const histKey = 'shared';
  const chats = new Map();
  const models = new Map();
  const usageRows = (n) => [
    { model: 'claude-opus-5-5', replies: n * 3, input: n * 2100, cacheRead: n * 90000, output: n * 700, total: n * 92800 },
    { model: 'claude-sonnet-5-5', replies: n * 2, input: n * 1400, cacheRead: n * 60000, output: n * 500, total: n * 61900 },
    { model: 'claude-haiku-5-5', replies: n, input: n * 400, cacheRead: n * 9000, output: n * 200, total: n * 9600 },
  ];
  for (const a of accounts) {
    const hk = lib.normalizeDir(lib.historyDir(a.configDir));
    chats.set(hk, sessions);
    models.set(hk, { last5h: usageRows(2), last7d: usageRows(40), allTime: usageRows(160) });
  }
  const st = buildState({
    accounts,
    groups: ['Accounts'],
    activeDir: ACCOUNTS.find((a) => a.label === activeLabel).configDir,
    selectedKey: lib.normalizeDir(ACCOUNTS.find((a) => a.label === selectedLabel).configDir),
    period: '7d',
    workspaceFolders: [PROJECTS.storefront],
    status,
    plans,
    chats,
    models,
    folders,
    weekly,
    accountIds,
    relay: 'on',
  });
  // One shared history for every account, like the shared home option.
  const first = Object.values(st.histories)[0];
  st.histories = { [histKey]: { ...first, sharedWith: ACCOUNTS.map((a) => a.label) } };
  for (const g of st.groups) for (const v of g.accounts) v.histKey = histKey;
  return st;
}

module.exports = { build, ACCOUNTS, PROJECTS };
if (require.main === module) {
  const s = build('Work');
  console.log(s.groups[0].accounts.map((a) => `${a.label} ${a.usage.session.percent}/${a.usage.weekly.percent} alert:${a.weekly && a.weekly.alert ? a.weekly.alert.level : '-'}`).join(' | '), s.projects.length, 'projects');
}
