// Live plan usage, asked from the Claude CLI the same way the Claude extension does it:
// a long-running `claude -p` in stream-json mode answers `get_usage` control requests.
// No prompt is ever sent (no tokens used), no chat is saved, and credentials never leave the CLI.
const { spawn } = require('child_process');
const os = require('os');
const lib = require('./lib');

const ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config'];
const START_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = 15000;

class UsageClient {
  constructor(configDir, claudePath = 'claude') {
    this.configDir = configDir || '';
    this.claudePath = claudePath;
    this.child = null;
    this.ready = null;
    this.pending = new Map();
    this.nextId = 0;
    this.inFlight = null;
  }

  start() {
    if (this.ready) return this.ready;
    const env = { ...process.env };
    delete env[lib.ENV_KEY];
    if (this.configDir) env[lib.ENV_KEY] = this.configDir;
    const child = spawn(this.claudePath, ARGS, { env, cwd: os.tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this.onLine(line);
      }
    });
    const fail = (why) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      for (const p of this.pending.values()) p.reject(new Error(why));
      this.pending.clear();
    };
    child.on('error', (e) => fail(`could not start Claude (${e.message})`));
    child.on('exit', () => fail('Claude stopped'));
    child.stdin.on('error', () => fail('Claude stopped'));
    this.ready = this.send({ subtype: 'initialize' }, START_TIMEOUT_MS).then(() => undefined);
    this.ready.catch(() => this.dispose());
    return this.ready;
  }

  onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type !== 'control_response' || !msg.response) return;
    const p = this.pending.get(msg.response.request_id);
    if (!p) return;
    this.pending.delete(msg.response.request_id);
    if (msg.response.subtype === 'success') p.resolve(msg.response.response || {});
    else p.reject(new Error(msg.response.error || 'request failed'));
  }

  send(request, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.child) return Promise.reject(new Error('Claude is not running'));
    const id = `ca${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Claude did not answer in time'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: id, request })}\n`);
    });
  }

  /** Live usage. Calls made while one is running share its answer. */
  getUsage() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      await this.start();
      return this.send({ subtype: 'get_usage', skip_behaviors: true });
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  get running() {
    return Boolean(this.child);
  }

  dispose() {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (child) {
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      setTimeout(() => {
        if (child.exitCode === null) child.kill();
      }, 1500);
    }
  }
}

/** Converts a get_usage answer into the same shape the panel uses for Claude's saved numbers. */
function planFromLive(answer, now = Date.now()) {
  if (!answer || !answer.rate_limits) return null;
  return lib.parsePlanUsage({ cachedUsageUtilization: { fetchedAtMs: now, utilization: answer.rate_limits } });
}

/**
 * One check: start Claude, ask, stop it. A long-running process keeps answering from memory,
 * so every check starts a new one and gets what Claude knows right now.
 */
async function fetchUsageOnce(configDir, claudePath) {
  const client = new UsageClient(configDir, claudePath);
  try {
    return await client.getUsage();
  } finally {
    client.dispose();
  }
}

const sameLimit = (a, b) => Boolean(a) === Boolean(b) && (!a || (a.percent === b.percent && a.resetsAt === b.resetsAt));

/**
 * Combines a live answer with Claude's saved copy. The answer has no timestamp, so when it matches
 * the saved copy the saved fetch time is the honest age; a different answer is new, so it is "now".
 * Fields the answer leaves out (extra credits, weekly split) keep their last known values.
 */
function mergePlans(livePlan, savedPlan, previous, now = Date.now()) {
  if (!livePlan) return savedPlan || previous || null;
  const matchesSaved = savedPlan && sameLimit(livePlan.session, savedPlan.session) && sameLimit(livePlan.weekly, savedPlan.weekly);
  const known = savedPlan || previous || {};
  return {
    ...livePlan,
    fetchedAt: matchesSaved && savedPlan.fetchedAt ? savedPlan.fetchedAt : now,
    extra: livePlan.extra || known.extra || null,
    breakdown: livePlan.breakdown && livePlan.breakdown.length ? livePlan.breakdown : known.breakdown || [],
  };
}

// ---------- Per-reply usage from the relay ----------

const path = require('path');

/** Folder the relay (bin/claude-relay.exe) writes per-reply usage to. */
function liveDir(env = process.env) {
  return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'claude-accounts', 'live');
}

/** File name the relay uses for a login folder: same rule as the relay ('' = default login). */
function liveKey(configDir) {
  const d = lib.normalizeDir(configDir);
  return d ? d.replace(/[^a-z0-9]/g, '-') : 'default';
}

/**
 * Turns a relay record ({ at, configDir, event: rate_limit_event }) into the panel's plan shape.
 * Utilization arrives as a fraction (0.56 = 56%) and reset times as Unix seconds. A window that is
 * missing has reset, so it is not carried over from older numbers.
 */
function planFromEvent(record, previous) {
  const event = record && record.event;
  const info = event && event.type === 'rate_limit_event' ? event.rate_limit_info : null;
  const windows = info && info.unifiedWindows;
  if (!windows || !Number.isFinite(record.at)) return null;
  const limit = (w) =>
    w && Number.isFinite(w.utilization)
      ? {
          percent: Math.round(w.utilization * 100),
          resetsAt: Number.isFinite(w.resetsAt) ? new Date(w.resetsAt * 1000).toISOString() : null,
          severity: w.status && w.status !== 'allowed' ? 'warning' : 'normal',
        }
      : null;
  const session = limit(windows.five_hour);
  const weekly = limit(windows.seven_day);
  if (!session && !weekly) return null;
  const prev = previous || {};
  return { fetchedAt: record.at, session, weekly, extra: prev.extra || null, breakdown: prev.breakdown || [], live: true };
}

/**
 * Picks between the numbers the panel has and a new candidate: the newer one wins, and fields only
 * one side has (extra credits, weekly split) are kept.
 */
function choosePlan(current, candidate) {
  if (!candidate) return current || null;
  if (!current) return candidate;
  const newer = (candidate.fetchedAt || 0) >= (current.fetchedAt || 0) ? candidate : current;
  const older = newer === candidate ? current : candidate;
  return {
    ...newer,
    extra: newer.extra || older.extra || null,
    breakdown: newer.breakdown && newer.breakdown.length ? newer.breakdown : older.breakdown || [],
  };
}

/**
 * When a window's reset time has passed, its usage is back to 0% until the next reply says otherwise.
 * Returns the updated plan and which windows just reset (empty when nothing changed).
 */
function applyResets(plan, now = Date.now()) {
  if (!plan) return { plan, reset: [] };
  const reset = [];
  const next = { ...plan };
  for (const name of ['session', 'weekly']) {
    const w = plan[name];
    if (!w || !w.resetsAt || w.resetAt) continue;
    const at = new Date(w.resetsAt).getTime();
    if (Number.isFinite(at) && at <= now) {
      next[name] = { percent: 0, resetsAt: null, severity: 'normal', resetAt: w.resetsAt };
      reset.push(name);
    }
  }
  if (reset.length) next.fetchedAt = now;
  return { plan: reset.length ? next : plan, reset };
}

/** Earliest upcoming reset time (ms) across plans, or 0 when none. */
function nextReset(plans, now = Date.now()) {
  let soonest = 0;
  for (const p of plans) {
    for (const name of ['session', 'weekly']) {
      const at = p && p[name] && p[name].resetsAt ? new Date(p[name].resetsAt).getTime() : 0;
      if (at > now && (!soonest || at < soonest)) soonest = at;
    }
  }
  return soonest;
}

module.exports = { UsageClient, planFromLive, fetchUsageOnce, mergePlans, liveDir, liveKey, planFromEvent, choosePlan, applyResets, nextReset };
