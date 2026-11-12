// Pure helpers (no VS Code API) so they can be tested with plain Node.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV_KEY = 'CLAUDE_CONFIG_DIR';

/** Normalises a config folder path for comparison ('' means the default ~/.claude folder). */
function normalizeDir(dir) {
  return (dir || '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** Reads CLAUDE_CONFIG_DIR from the Claude extension's environmentVariables list ('' when unset). */
function activeDirFromEnvList(envList) {
  const hit = (envList || []).find((e) => e && e.name === ENV_KEY);
  return hit ? hit.value : '';
}

/** Returns a new environmentVariables list pointing Claude at `dir` ('' removes the override). */
function envListWithDir(envList, dir) {
  const rest = (envList || []).filter((e) => e && e.name !== ENV_KEY);
  return dir ? [...rest, { name: ENV_KEY, value: dir }] : rest;
}

/** Returns a new terminal env object pointing new terminals at `dir` ('' removes the override). */
function terminalEnvWithDir(envObj, dir) {
  const next = { ...(envObj || {}) };
  if (dir) next[ENV_KEY] = dir;
  else delete next[ENV_KEY];
  return next;
}

/** Parses the JSON printed by `claude auth status` (it exits 1 when signed out but still prints JSON). */
function parseStatus(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const j = JSON.parse(stdout.slice(start, end + 1));
    return {
      loggedIn: Boolean(j.loggedIn),
      email: j.email || '',
      orgName: j.orgName || '',
      plan: j.subscriptionType || '',
      configDirectory: j.configDirectory || '',
    };
  } catch {
    return null;
  }
}

/** Asks the Claude CLI which account a config folder is signed in to. Never reads credential files itself. */
function readStatus(dir, claudePath = 'claude', timeoutMs = 20000) {
  const env = { ...process.env };
  delete env[ENV_KEY];
  if (dir) env[ENV_KEY] = dir;
  return new Promise((resolve) => {
    execFile(claudePath, ['auth', 'status'], { env, timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      const parsed = parseStatus(String(stdout || ''));
      if (parsed) return resolve(parsed);
      resolve({ loggedIn: false, email: '', orgName: '', plan: '', error: err ? err.message : 'no status output' });
    });
  });
}

/** One-line summary shown next to an account, e.g. "abhishek@x.com · Team". */
function describe(status) {
  if (!status) return 'checking...';
  if (status.error) return 'could not read status';
  if (!status.loggedIn) return 'not signed in';
  const plan = status.plan ? status.plan.charAt(0).toUpperCase() + status.plan.slice(1) : '';
  return [status.email, plan].filter(Boolean).join(' · ');
}

// ---------- Plan usage (the same numbers as Claude's Account & Usage panel) ----------

/** Where Claude keeps an account's settings file: inside the login folder, or ~/.claude.json for the default. */
function claudeJsonPath(dir) {
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

/** Where Claude keeps an account's chat history. */
function projectsPath(dir) {
  return dir ? path.join(dir, 'projects') : path.join(os.homedir(), '.claude', 'projects');
}

/**
 * The folder whose projects/ really holds an account's chats. Accounts whose projects/ is a link
 * to the same shared folder get the same answer, so their history is read and watched once.
 */
function historyDir(dir) {
  const projects = projectsPath(dir);
  try {
    const real = fs.realpathSync.native(projects);
    if (path.basename(real).toLowerCase() === 'projects') return path.dirname(real);
  } catch {
    // no history yet
  }
  return path.dirname(projects);
}

/**
 * Extracts plan usage from Claude's cached copy (cachedUsageUtilization).
 * Only this one field is used; nothing else in the file is read or kept.
 */
function parsePlanUsage(claudeJson) {
  const cache = claudeJson && claudeJson.cachedUsageUtilization;
  if (!cache || !cache.utilization) return null;
  const u = cache.utilization;
  const limits = Array.isArray(u.limits) ? u.limits.filter(Boolean) : [];

  const limitFor = (kinds, group, fallbackKey) => {
    const hit = limits.find((l) => kinds.includes(l.kind)) || limits.find((l) => l.group === group);
    if (hit) return { percent: Number(hit.percent) || 0, resetsAt: hit.resets_at || null, severity: hit.severity || 'normal' };
    const f = u[fallbackKey];
    return f ? { percent: Number(f.utilization) || 0, resetsAt: f.resets_at || null, severity: 'normal' } : null;
  };

  let extra = null;
  const spend = u.spend;
  if (spend && spend.enabled && spend.used) {
    const money = (m) => (m ? m.amount_minor / 10 ** (m.exponent == null ? 2 : m.exponent) : null);
    extra = { used: money(spend.used), limit: money(spend.limit), currency: spend.used.currency || 'USD', percent: spend.percent == null ? null : spend.percent };
  }

  const rows = u.seven_day_breakdown && Array.isArray(u.seven_day_breakdown.rows) ? u.seven_day_breakdown.rows : [];
  const breakdown = rows.filter((r) => r && r.percent > 0).map((r) => ({ name: r.display_name || r.key, percent: r.percent }));

  return {
    fetchedAt: cache.fetchedAtMs || null,
    session: limitFor(['session'], 'session', 'five_hour'),
    weekly: limitFor(['weekly_all'], 'weekly', 'seven_day'),
    extra,
    breakdown,
  };
}

async function readPlanUsage(dir, attempts = 3) {
  // Claude rewrites this file often; a read can land mid-write, so retry briefly before giving up.
  for (let i = 0; i < attempts; i += 1) {
    try {
      const parsed = parsePlanUsage(JSON.parse(await fs.promises.readFile(claudeJsonPath(dir), 'utf8')));
      if (parsed) return parsed;
    } catch {
      // half-written or missing: try again
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** The account id Claude saved for a login folder (oauthAccount.accountUuid), or '' when signed out. */
async function readAccountId(dir) {
  try {
    const j = JSON.parse(await fs.promises.readFile(claudeJsonPath(dir), 'utf8'));
    const id = j && j.oauthAccount && j.oauthAccount.accountUuid;
    return typeof id === 'string' ? id.toLowerCase() : '';
  } catch {
    return '';
  }
}

// ---------- Model usage (counted from the account's local chat history) ----------

/** Turns one transcript line into a usage record, or null when it is not a model reply. */
function usageRecordFromLine(line) {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const m = o && o.type === 'assistant' ? o.message : null;
  if (!m || !m.usage || !m.model || m.model === '<synthetic>') return null;
  const u = m.usage;
  return {
    id: m.id || o.uuid,
    t: Date.parse(o.timestamp) || 0,
    model: m.model,
    input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    cacheRead: u.cache_read_input_tokens || 0,
    output: u.output_tokens || 0,
  };
}

// Transcripts only grow, so each file is read once and then only its new bytes are read.
const fileCache = new Map();

async function readFileRecords(file) {
  const st = await fs.promises.stat(file);
  let c = fileCache.get(file);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.records;
  if (!c || st.size < c.offset) c = { size: 0, mtimeMs: 0, offset: 0, ids: new Set(), records: [] };

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file, { start: c.offset });
    let pending = Buffer.alloc(0);
    stream.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0;
      let nl;
      while ((nl = pending.indexOf(10, start)) !== -1) {
        const rec = usageRecordFromLine(pending.toString('utf8', start, nl));
        // A reply split into several blocks repeats the same id and usage: count it once.
        if (rec && !c.ids.has(rec.id)) {
          c.ids.add(rec.id);
          c.records.push(rec);
        }
        start = nl + 1;
      }
      c.offset += start;
      pending = pending.subarray(start);
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  c.size = st.size;
  c.mtimeMs = st.mtimeMs;
  fileCache.set(file, c);
  return c.records;
}

async function listTranscripts(root) {
  const out = [];
  async function walk(dir, top) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      // Project folders may be links into the shared Personal history; links are followed only there.
      if (e.isDirectory() || (top && e.isSymbolicLink())) await walk(p, false);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  }
  await walk(root, true);
  return out;
}

/** Per-model totals for records at or after `sinceMs`, biggest first. */
function aggregate(records, sinceMs) {
  const byModel = new Map();
  for (const r of records) {
    if (r.t < sinceMs) continue;
    const a = byModel.get(r.model) || { model: r.model, replies: 0, input: 0, cacheRead: 0, output: 0 };
    a.replies += 1;
    a.input += r.input;
    a.cacheRead += r.cacheRead;
    a.output += r.output;
    byModel.set(r.model, a);
  }
  return [...byModel.values()].map((a) => ({ ...a, total: a.input + a.cacheRead + a.output })).sort((x, y) => y.total - x.total);
}

async function readModelUsage(dir, now = Date.now()) {
  const root = projectsPath(dir);
  const files = await listTranscripts(root);
  const records = [];
  let sessions = 0;
  for (const f of files) {
    if (path.relative(root, f).split(path.sep).length === 2) sessions += 1; // subagent transcripts live deeper
    try {
      for (const r of await readFileRecords(f)) records.push(r);
    } catch {
      // unreadable file: skip it
    }
  }
  return {
    sessions,
    last5h: aggregate(records, now - 5 * 3600 * 1000),
    last7d: aggregate(records, now - 7 * 24 * 3600 * 1000),
    allTime: aggregate(records, 0),
  };
}

// ---------- Sessions (past chats) ----------

/** Claude names a project's history folder after its path, with every non-alphanumeric character as '-'. */
function encodeProjectPath(p) {
  return String(p || '').replace(/[^a-zA-Z0-9]/g, '-');
}

function sameKey(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

async function readChunk(file, start, length) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

function promptText(message) {
  const c = message && message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((x) => x && x.type === 'text') || {}).text || '' : '';
  const clean = text.replace(/\s+/g, ' ').trim();
  // Skip slash-command echoes and system caveats that are not what the user typed.
  if (!clean || clean.startsWith('<') || clean.startsWith('Caveat:')) return '';
  return clean;
}

const metaCache = new Map();
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 1024 * 1024;

/** Title, folder and last activity of one chat, read from the start and end of its transcript only. */
async function readSessionMeta(file) {
  const st = await fs.promises.stat(file);
  const cached = metaCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.meta;

  const head = await readChunk(file, 0, Math.min(HEAD_BYTES, st.size));
  const tailStart = Math.max(0, st.size - TAIL_BYTES);
  const tail = tailStart > HEAD_BYTES ? await readChunk(file, tailStart, st.size - tailStart) : '';

  let cwd = '';
  let firstPrompt = '';
  let customTitle = '';
  let aiTitle = '';
  const owners = new Set(); // account ids that ran this chat (Claude writes a session-owner line per turn)
  const scan = (text, wantStart) => {
    for (const line of text.split('\n')) {
      const owner = line.includes('"session-owner"') && line.match(/"accountUuid":"([0-9a-f-]{8,})"/i);
      if (owner) owners.add(owner[1].toLowerCase());
      const wantTitle = line.includes('-title"');
      if (!wantTitle && !(wantStart && (!cwd || !firstPrompt))) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue; // partial line at a chunk edge
      }
      if (o.type === 'custom-title' && o.customTitle) customTitle = o.customTitle;
      else if (o.type === 'ai-title' && o.aiTitle) aiTitle = o.aiTitle;
      if (wantStart && !cwd && o.cwd) cwd = o.cwd;
      if (wantStart && !firstPrompt && o.type === 'user' && !o.isMeta) firstPrompt = promptText(o.message);
    }
  };
  scan(head, true);
  if (tail) scan(tail, false);

  // The desktop app also keeps a side file with the title the user gave the chat.
  const id = path.basename(file, '.jsonl');
  try {
    const side = JSON.parse(await fs.promises.readFile(path.join(path.dirname(file), id, 'custom-title.json'), 'utf8'));
    if (side && side.customTitle) customTitle = side.customTitle;
  } catch {
    // no side file
  }

  const title = (customTitle || aiTitle || firstPrompt || 'Untitled chat').replace(/\s+/g, ' ').trim();
  const meta = { id, file, title, cwd, owners: [...owners], mtimeMs: st.mtimeMs, size: st.size };
  metaCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, meta });
  return meta;
}

/** Every chat of an account, newest first (subagent transcripts are not separate chats). */
async function listSessions(dir) {
  const root = projectsPath(dir);
  let projects;
  try {
    projects = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const p of projects) {
    if (!p.isDirectory() && !p.isSymbolicLink()) continue; // links: shared Personal project folders
    const pdir = path.join(root, p.name);
    let files;
    try {
      files = await fs.promises.readdir(pdir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      try {
        out.push({ ...(await readSessionMeta(path.join(pdir, f.name))), projectKey: p.name });
      } catch {
        // unreadable transcript: skip
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Finds the folder a chat belongs to now. Claude resumes a chat only from the folder whose encoded
 * name matches its history folder, so this matches on that name (folders may have moved since).
 */
async function resolveProjectDir(projectKey, hints = []) {
  for (const h of hints) {
    if (h && sameKey(encodeProjectPath(h), projectKey) && fs.existsSync(h)) return h;
  }
  const m = /^([a-zA-Z])--(.*)$/.exec(projectKey || '');
  if (!m) return null;
  const root = `${m[1].toUpperCase()}:\\`;
  async function search(dir, remaining, depth) {
    if (!remaining) return dir;
    if (depth > 10) return null;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const enc = encodeProjectPath(e.name);
      if (sameKey(remaining, enc)) return path.join(dir, e.name);
      if (remaining.toLowerCase().startsWith(enc.toLowerCase() + '-')) {
        const found = await search(path.join(dir, e.name), remaining.slice(enc.length + 1), depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  return search(root, m[2], 0);
}

// ---------- Formatting ----------

/** claude-opus-5-5 -> "Opus 5.5", claude-haiku-4-5-20251001 -> "Haiku 4.5", claude-sonnet-4-20250514 -> "Sonnet 4". */
function modelName(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id || '');
  if (!m) return id || 'unknown';
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
}

function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(n);
}

function bar(percent, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function fmtReset(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? `resets ${time}` : `resets ${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

function fmtAgo(ms, now = Date.now()) {
  if (!ms) return 'unknown';
  const mins = Math.round((now - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Compact age for narrow rows: now, 5m, 3h, 2d, 6w. */
function fmtAgoShort(ms, now = Date.now()) {
  if (!ms) return '';
  const mins = Math.floor((now - ms) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 14 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

/** Compact reset time: "5:59 PM" today, "Fri 9:29 AM" later in the week, "Nov 20" further out. */
function fmtResetShort(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  if (d - now < 6 * 24 * 3600 * 1000) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** "$18.72", "$500" (drops .00). */
function fmtMoney(n) {
  if (n == null) return '';
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

module.exports = {
  historyDir,
  fmtAgoShort,
  fmtResetShort,
  fmtMoney,
  ENV_KEY,
  normalizeDir,
  activeDirFromEnvList,
  envListWithDir,
  terminalEnvWithDir,
  parseStatus,
  readStatus,
  describe,
  claudeJsonPath,
  projectsPath,
  parsePlanUsage,
  readPlanUsage,
  readAccountId,
  usageRecordFromLine,
  readFileRecords,
  aggregate,
  readModelUsage,
  encodeProjectPath,
  sameKey,
  readSessionMeta,
  listSessions,
  resolveProjectDir,
  modelName,
  fmtTokens,
  bar,
  fmtReset,
  fmtAgo,
};
