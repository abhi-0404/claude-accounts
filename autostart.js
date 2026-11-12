// One-shot "auto-start" of a 5-hour session window. Pure logic (no VS Code), so it can be tested.
//
// Claude's 5-hour window begins with the first message after the previous one ended. If you forget, the
// window starts late and part of the week goes unused. An auto-start sends one tiny message with the
// cheapest model at the chosen time, so the window begins on schedule, and then removes itself.

const GRACE_MS = 10 * 60 * 1000; // a schedule that is more than this late is dropped, not run
const MAX_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_SCHEDULED = 8;
const FIRE_DELAY_MS = 45 * 1000; // sent just after the window opens, so the previous one has surely ended
const SAME_WINDOW_MS = 5 * 60 * 1000; // two starts this close are the same window (reset times drift by seconds)

/** The command line of the tiny message: the cheapest model, nothing saved to the chat list. */
const messageArgs = () => ['-p', 'hi', '--model', 'haiku', '--no-session-persistence', '--output-format', 'json'];

const same = (a, b) => a.key === b.key && Math.abs(a.start - b.start) <= SAME_WINDOW_MS;

/** Adds a schedule if it is valid and not a duplicate. Returns { list, error }. */
function add(list, item, now = Date.now()) {
  const cur = Array.isArray(list) ? list : [];
  if (!item || !item.key || !Number.isFinite(item.start)) return { list: cur, error: 'invalid' };
  if (item.start <= now) return { list: cur, error: 'past' };
  if (item.start - now > MAX_AHEAD_MS) return { list: cur, error: 'too far ahead' };
  if (cur.some((x) => same(x, item))) return { list: cur, error: null };
  if (cur.length >= MAX_SCHEDULED) return { list: cur, error: 'too many' };
  return { list: [...cur, { key: item.key, start: item.start }].sort((a, b) => a.start - b.start), error: null };
}

const remove = (list, item) => (Array.isArray(list) ? list : []).filter((x) => !same(x, item));

/** Schedules whose time has come (and is not long past). */
const due = (list, now = Date.now()) => (Array.isArray(list) ? list : []).filter((x) => x.start + FIRE_DELAY_MS <= now && now - x.start <= GRACE_MS);

/** Schedules that were missed (for example VS Code was closed). */
const missed = (list, now = Date.now()) => (Array.isArray(list) ? list : []).filter((x) => now - x.start > GRACE_MS);

/** Next schedule still in the future. */
const next = (list, now = Date.now()) => (Array.isArray(list) ? list : []).filter((x) => x.start + FIRE_DELAY_MS > now).sort((a, b) => a.start - b.start)[0] || null;

/** One entry per window: starts within a few minutes of each other are the same window (the earliest is kept). */
function normalize(list) {
  const out = [];
  for (const x of (Array.isArray(list) ? list : []).filter((y) => y && y.key && Number.isFinite(y.start)).sort((a, b) => a.start - b.start)) {
    if (!out.some((y) => same(y, x))) out.push({ key: x.key, start: x.start });
  }
  return out;
}

/**
 * Why a due schedule should not send anything, or null to go ahead. A window that is already running
 * needs no help (sending would only spend usage).
 */
function skipReason(plan, signedIn, now = Date.now()) {
  if (!signedIn) return 'signed out';
  const s = plan && plan.session;
  const end = s && s.resetsAt ? new Date(s.resetsAt).getTime() : NaN;
  if (Number.isFinite(end) && end > now) return 'a session window is already running';
  return null;
}

/**
 * Only one VS Code window may send a given auto-start: every open window runs the scheduler, so the first
 * to create the lock file sends and the others skip. Locks older than a day are cleared.
 */
function claim(dir, item, now = Date.now()) {
  const fsx = require('fs');
  const pathx = require('path');
  try {
    fsx.mkdirSync(dir, { recursive: true });
  } catch {
    return true; // the lock folder cannot be made: better to send than to miss the window
  }
  try {
    for (const f of fsx.readdirSync(dir)) {
      if (!f.startsWith('autostart-')) continue;
      const p = pathx.join(dir, f);
      try {
        if (now - fsx.statSync(p).mtimeMs > 24 * 60 * 60 * 1000) fsx.unlinkSync(p);
      } catch {
        // another window cleared it
      }
    }
    const id = String(item.key).replace(/[^a-z0-9]/gi, '-').slice(-60);
    const minute = Math.round(item.start / 60000);
    fsx.writeFileSync(pathx.join(dir, `autostart-${id}-${minute}.lock`), String(now), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    return true; // the lock folder is not writable: better to send than to miss the window
  }
}

/** After sending, ask for usage a few times: the new window shows up on Claude's side after a short delay. */
const CONFIRM_DELAYS_MS = [5000, 20000, 60000, 180000];

module.exports = { claim, CONFIRM_DELAYS_MS, FIRE_DELAY_MS, normalize, SAME_WINDOW_MS, GRACE_MS, MAX_AHEAD_MS, MAX_SCHEDULED, messageArgs, add, remove, due, missed, next, skipReason };
