// When to gently ask for a rating. Pure logic (no VS Code), so it can be tested.
//
// Principles: ask only after the extension has clearly helped (a few account switches or chats), never in the
// first days, never twice in a month, at most twice ever, never again after a rating or "Don't Ask Again",
// and keep a quiet link in the panel that never interrupts.

const DAY = 24 * 60 * 60 * 1000;
const MIN_AGE_DAYS = 3;
const SNOOZE_DAYS = 30;
const MAX_ASKS = 2;
const SWITCHES_NEEDED = 3;
const CHATS_NEEDED = 8;

const empty = (now = Date.now()) => ({ firstRun: now, switches: 0, chats: 0, asks: 0, lastAsk: 0, rated: false, optOut: false, hidden: false });

/** A new state with the event counted. Events: 'switch', 'chat'. */
function record(state, event, now = Date.now()) {
  const s = { ...empty(now), ...state };
  if (event === 'switch') s.switches += 1;
  if (event === 'chat') s.chats += 1;
  return s;
}

/** The extension has been used enough, for long enough, to deserve a thought about rating. */
function earned(state, now = Date.now()) {
  const s = { ...empty(now), ...state };
  const old = now - s.firstRun >= MIN_AGE_DAYS * DAY;
  return old && (s.switches >= SWITCHES_NEEDED || s.chats >= CHATS_NEEDED);
}

/** Show the one-time notification now? */
function shouldAsk(state, now = Date.now()) {
  const s = { ...empty(now), ...state };
  if (s.rated || s.optOut || s.asks >= MAX_ASKS) return false;
  if (!earned(s, now)) return false;
  return now - s.lastAsk >= SNOOZE_DAYS * DAY;
}

/** Show the quiet link in the panel? (Never a popup; the user can hide it.) */
function shouldHint(state, now = Date.now()) {
  const s = { ...empty(now), ...state };
  return !s.rated && !s.optOut && !s.hidden && earned(s, now);
}

const asked = (state, now = Date.now()) => ({ ...empty(now), ...state, asks: (state.asks || 0) + 1, lastAsk: now });

/** What the user chose: 'rate', 'never' (Don't Ask Again) or 'later' (also what closing the notification means). */
function choose(state, choice) {
  const s = { ...empty(), ...state };
  if (choice === 'rate') return { ...s, rated: true };
  if (choice === 'never') return { ...s, optOut: true };
  return s;
}

const hideHint = (state) => ({ ...empty(), ...state, hidden: true });

module.exports = { empty, record, earned, shouldAsk, shouldHint, asked, choose, hideHint, DAY, MIN_AGE_DAYS, SNOOZE_DAYS, MAX_ASKS };
