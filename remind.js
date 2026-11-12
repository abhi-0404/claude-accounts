// When the weekly reminder may pop up as a VS Code notification. Pure logic, so it can be tested.
//
// The card in the panel always shows the advice; a notification interrupts, so it is rare:
//  - at most once per account and weekly cycle for a reminder, and once more only if it becomes final
//    (little time left), so never more than twice a week per account;
//  - a "weekly cycle" is recognised by its reset time being within 3 hours of one already seen. The same
//    reset arrives with small differences from different sources (fractions of a second), and a reset at
//    11:30 sits exactly on an hour boundary, where rounding to the hour used to flip between two values and
//    made every refresh look like a new week;
//  - not while that account has a session running (you are using it, the reminder adds nothing);
//    it waits, and shows later if still true;
//  - not within 4 hours of another reminder notification (any account), so accounts never pile up,
//    except the final one, which may follow after 1 hour;
//  - only in a focused window.

const HOUR = 60 * 60 * 1000;
const GAP_MS = 4 * HOUR;
const FINAL_GAP_MS = HOUR;
const KEEP_MS = 21 * 24 * HOUR;
const SAME_CYCLE_MS = 3 * HOUR;

const empty = () => ({ cycles: {}, lastAt: 0 });
const rank = (level) => (level === 'final' ? 2 : level === 'reminder' ? 1 : 0);

/** Kept for callers that need a number per cycle (for lock names): the reset time in whole hours. */
const cycleOf = (resetsAt) => Math.floor(Date.parse(resetsAt) / HOUR);

/**
 * Should this alert notify now? Returns { notify, state, cycle } (state to save when notify is true;
 * cycle is the first reset time seen for this week, a stable name for it).
 * ctx: { focused, inSession } (inSession: the account has a session window running).
 */
function decide(state, accountKey, alert, now = Date.now(), ctx = {}) {
  const old = state && typeof state === 'object' ? state : {};
  const s = { cycles: { ...(old.cycles || {}) }, lastAt: Number(old.lastAt) || 0 };
  const reset = alert && alert.resetsAt ? Date.parse(alert.resetsAt) : NaN;
  if (!alert || !Number.isFinite(reset)) return { notify: false, state: s, cycle: null };

  const mine = (s.cycles[accountKey + (alert.simulated ? '|test' : '')] || []).filter((c) => now - c.at < KEEP_MS);
  const found = mine.find((c) => Math.abs(c.reset - reset) <= SAME_CYCLE_MS);
  const cycle = found ? found.reset : reset;
  const no = { notify: false, state: s, cycle };
  if (found && rank(found.level) >= rank(alert.level)) return no; // already said this (or more) this week
  if (!ctx.focused) return no;
  if (!alert.simulated) {
    if (ctx.inSession) return no; // you are using it right now
    const gap = alert.level === 'final' ? FINAL_GAP_MS : GAP_MS;
    if (now - (s.lastAt || 0) < gap) return no;
  }
  const entry = { reset: cycle, level: alert.level, at: now };
  s.cycles[accountKey + (alert.simulated ? '|test' : '')] = [...mine.filter((c) => c !== found), entry];
  s.lastAt = now;
  return { notify: true, state: s, cycle };
}

module.exports = { decide, empty, cycleOf, GAP_MS, FINAL_GAP_MS, SAME_CYCLE_MS };
