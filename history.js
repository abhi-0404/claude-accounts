// Usage history per account: every 5-hour session window ("slot") and how far it was used, plus samples
// of session/weekly percentages to learn how much of the weekly limit one full 5-hour session uses.
// Anthropic keeps no readable history, so this is recorded locally from every usage update.
const HOUR = 3600 * 1000;
const FIVE_H = 5 * HOUR;
const WEEK = 7 * 24 * HOUR;
const DAY = 24 * HOUR;
const KEEP = 100 * DAY; // enough for the 3-month view
const DETAIL = 14 * DAY; // older samples keep only weekly changes, to stay small
// Until enough is learned: one full 5-hour session uses about this share of the weekly limit.
const DEFAULT_SHARE = 0.125;

const emptyStore = () => ({ version: 1, accounts: {} });
const time = (iso) => (iso ? Date.parse(iso) : NaN);
// The same reset time arrives with small differences from different sources (whole seconds, ms, µs).
const SAME_SESSION = 15 * 60 * 1000;
const SAME_WEEK = HOUR;

/** An already known session end within 15 minutes of `end`, else `end` itself. */
function sessionEnd(acc, end) {
  for (const w of Object.values(acc.windows)) if (Math.abs(w.end - end) <= SAME_SESSION) return w.end;
  return end;
}

/** An already known weekly reset within an hour of `end`, else `end` itself. */
function weekEnd(acc, end) {
  if (end == null) return null;
  for (let i = acc.samples.length - 1; i >= 0; i -= 1) {
    const we = acc.samples[i].we;
    if (we != null && Math.abs(we - end) <= SAME_WEEK) return we;
  }
  return end;
}

/**
 * Merges entries recorded before reset times were matched loosely: one session stored several times
 * becomes one (highest use kept), and weekly reset times are unified. Returns true when it changed anything.
 */
function normalize(store) {
  let changed = false;
  for (const acc of Object.values(store.accounts)) {
    const merged = {};
    for (const w of Object.values(acc.windows).sort((a, b) => a.end - b.end)) {
      const hit = Object.values(merged).find((m) => Math.abs(m.end - w.end) <= SAME_SESSION);
      if (hit) {
        hit.peak = Math.max(hit.peak, w.peak);
        changed = true;
      } else merged[String(w.end)] = { ...w };
    }
    acc.windows = merged;
    const weeks = [];
    for (const x of acc.samples) {
      if (x.se != null) {
        const hit = Object.values(merged).find((m) => Math.abs(m.end - x.se) <= SAME_SESSION);
        if (hit && hit.end !== x.se) {
          x.se = hit.end;
          changed = true;
        }
      }
      if (x.we != null) {
        const hit = weeks.find((we) => Math.abs(we - x.we) <= SAME_WEEK);
        if (hit == null) weeks.push(x.we);
        else if (hit !== x.we) {
          x.we = hit;
          changed = true;
        }
      }
    }
  }
  return changed;
}

/** Records a plan update. Returns true when something new was stored. */
function record(store, accountKey, plan, now = Date.now()) {
  if (!plan || (!plan.session && !plan.weekly)) return false;
  const acc = (store.accounts[accountKey] = store.accounts[accountKey] || { windows: {}, samples: [] });
  let changed = false;

  const s = plan.session;
  const rawEnd = s ? time(s.resetsAt) : NaN;
  const sEnd = Number.isFinite(rawEnd) ? sessionEnd(acc, rawEnd) : NaN;
  if (Number.isFinite(sEnd)) {
    const id = String(sEnd);
    const w = acc.windows[id] || { start: sEnd - FIVE_H, end: sEnd, peak: 0 };
    if (!acc.windows[id] || s.percent > w.peak) changed = true;
    w.peak = Math.max(w.peak, s.percent);
    acc.windows[id] = w;
  }

  const sample = {
    at: plan.fetchedAt || now,
    s: s && Number.isFinite(s.percent) ? s.percent : null,
    se: Number.isFinite(sEnd) ? sEnd : null,
    w: plan.weekly && Number.isFinite(plan.weekly.percent) ? plan.weekly.percent : null,
    we: plan.weekly && Number.isFinite(time(plan.weekly.resetsAt)) ? weekEnd(acc, time(plan.weekly.resetsAt)) : null,
  };
  const last = acc.samples[acc.samples.length - 1];
  if (!last || last.s !== sample.s || last.w !== sample.w || last.se !== sample.se || last.we !== sample.we) {
    acc.samples.push(sample);
    changed = true;
  }

  const cutoff = now - KEEP;
  const detail = now - DETAIL;
  let prev = null;
  acc.samples = acc.samples.filter((x) => {
    if (x.at < cutoff) return false;
    const keep = x.at >= detail || !prev || prev.w !== x.w || prev.we !== x.we;
    if (keep) prev = x;
    return keep;
  }).slice(-20000);
  for (const id of Object.keys(acc.windows)) if (acc.windows[id].end < cutoff) delete acc.windows[id];
  return changed;
}

/**
 * Everything the history charts need for one account, oldest first:
 *  slots:  each 5-hour session { start, end, peak, weekly } (weekly = weekly % reached by its end)
 *  weekly: the weekly % over time { at, w, we }, only where it changed
 */
function series(store, accountKey, from = 0) {
  const acc = store.accounts[accountKey] || { windows: {}, samples: [] };
  // Within one weekly cycle usage only goes up; a lower number is a late report from another source,
  // so each sample is lifted to the highest value seen so far in its cycle.
  const raw = acc.samples.filter((x) => x.w != null).sort((a, b) => a.at - b.at);
  const samples = [];
  const top = new Map(); // weekly reset time -> highest % so far
  for (const x of raw) {
    const k = x.we == null ? 'none' : x.we;
    const w = Math.max(top.get(k) ?? 0, x.w);
    top.set(k, w);
    samples.push({ ...x, w });
  }
  const weekly = [];
  for (const x of samples) {
    const last = weekly[weekly.length - 1];
    if (!last || last.w !== x.w || last.we !== x.we) weekly.push({ at: x.at, w: x.w, we: x.we });
  }
  // The weekly cycle a moment belongs to: the reset time of a sample whose week contains it.
  const cycleAt = (t) => {
    for (const x of samples) if (x.we != null && x.we - WEEK <= t && t < x.we) return x.we;
    return null;
  };
  const slots = Object.values(acc.windows)
    .filter((w) => w.end > from)
    .sort((a, b) => a.start - b.start)
    .map((w) => {
      // weekly: % of its week reached by the end of the session. weeklyUsed: how much of the week this
      // session consumed (weekly at the end minus weekly just before it started, within the same week).
      const cycle = cycleAt(w.start);
      const inCycle = (x) => cycle == null || x.we == null || Math.abs(x.we - cycle) < HOUR;
      let weeklyAt = null;
      for (const x of samples) if (x.at >= w.start && x.at <= w.end && inCycle(x)) weeklyAt = Math.max(weeklyAt ?? 0, x.w);
      let before = null;
      let anyEarlier = false;
      for (const x of samples) {
        if (x.at >= w.start) break;
        anyEarlier = true;
        if (inCycle(x)) before = x;
      }
      // No earlier sample at all: tracking began mid-week, so the starting point is unknown.
      // Earlier samples only from an older week: this week started at 0%.
      const weeklyBefore = before ? before.w : anyEarlier ? 0 : null;
      return {
        start: w.start,
        end: w.end,
        peak: w.peak,
        weekly: weeklyAt,
        weeklyUsed: weeklyAt == null || weeklyBefore == null ? null : Math.max(0, weeklyAt - weeklyBefore),
      };
    });
  return { slots, weekly: weekly.filter((x) => x.at >= from - WEEK) };
}

/**
 * Per weekly cycle (reset to reset), newest first: sessions, average use, and the weekly % reached.
 * Cycles are counted back from the current weekly reset.
 */
function cycles(store, accountKey, weeklyResetsAt, count = 13, now = Date.now()) {
  const acc = store.accounts[accountKey] || { windows: {}, samples: [] };
  const end = Number.isFinite(time(weeklyResetsAt)) ? time(weeklyResetsAt) : now;
  const out = [];
  for (let k = 0; k < count; k += 1) {
    const cEnd = end - k * WEEK;
    const cStart = cEnd - WEEK;
    const slots = Object.values(acc.windows).filter((w) => w.start >= cStart && w.start < cEnd);
    let reached = null;
    for (const x of acc.samples) {
      if (x.w == null) continue;
      const inCycle = x.we != null ? Math.abs(x.we - cEnd) < HOUR : x.at >= cStart && x.at < cEnd;
      if (inCycle) reached = Math.max(reached ?? 0, x.w);
    }
    if (!slots.length && reached == null) continue;
    out.push({
      start: cStart,
      end: cEnd,
      current: now >= cStart && now < cEnd,
      sessions: slots.length,
      avg: slots.length ? Math.round(slots.reduce((t, w) => t + w.peak, 0) / slots.length) : null,
      reached,
    });
  }
  return out;
}

/**
 * Share of the weekly limit that one full (100%) 5-hour session uses, learned from consecutive samples in
 * the same windows. Null until at least 20 session-percent points of growth were seen.
 */
function learnedShare(store, accountKey) {
  const acc = store.accounts[accountKey];
  if (!acc) return null;
  let ds = 0;
  let dw = 0;
  for (let i = 1; i < acc.samples.length; i += 1) {
    const a = acc.samples[i - 1];
    const b = acc.samples[i];
    if (a.se !== b.se || a.we !== b.we || a.s == null || b.s == null || a.w == null || b.w == null) continue;
    if (b.s > a.s && b.w >= a.w) {
      ds += b.s - a.s;
      dw += b.w - a.w;
    }
  }
  return ds >= 20 && dw > 0 ? Math.min(1, dw / ds) : null;
}

/** 5-hour slots of this week and last week (weeks end at the weekly reset), with average use. */
function weekSummary(store, accountKey, weeklyResetsAt, now = Date.now()) {
  const acc = store.accounts[accountKey] || { windows: {}, samples: [] };
  const end = Number.isFinite(time(weeklyResetsAt)) ? time(weeklyResetsAt) : now;
  const thisStart = end - WEEK;
  const lastStart = thisStart - WEEK;
  const wins = Object.values(acc.windows).sort((a, b) => a.start - b.start);
  const pick = (from, to) => wins.filter((w) => w.end > from && w.start < to).map((w) => ({ start: w.start, end: w.end, peak: w.peak, current: w.start <= now && now < w.end }));
  const sum = (slots) => ({ slots, count: slots.length, avg: slots.length ? Math.round(slots.reduce((t, w) => t + w.peak, 0) / slots.length) : null });
  const lastWeekly = acc.samples.filter((x) => x.we === thisStart && x.w != null).reduce((m, x) => Math.max(m, x.w), -1);
  const first = acc.samples.length ? acc.samples[0].at : null;
  return {
    thisWeek: sum(pick(thisStart, end)),
    lastWeek: { ...sum(pick(lastStart, thisStart)), weeklyUsed: lastWeekly >= 0 ? lastWeekly : null },
    trackingSince: first,
    weekStart: thisStart,
    weekEnd: end,
  };
}

// Until enough history exists: a typical pace of 3 sessions a day, each half used.
const DEFAULT_PACE = { sessionsPerDay: 3, avgUse: 50, learned: false };

/**
 * Your usage pattern across all accounts over the last 14 days: how many 5-hour sessions you start per
 * active day and how much of each you use. Active days only, so days off do not drag the pace down.
 */
function pattern(store, now = Date.now()) {
  const from = now - 14 * DAY;
  const wins = [];
  for (const acc of Object.values(store.accounts)) for (const w of Object.values(acc.windows)) if (w.start >= from && w.start < now) wins.push(w);
  if (wins.length < 3) return { ...DEFAULT_PACE, sessions: wins.length };
  const days = new Set(wins.map((w) => Math.floor(w.start / DAY)));
  return {
    sessionsPerDay: Math.round((wins.length / days.size) * 10) / 10,
    avgUse: Math.round(wins.reduce((t, w) => t + w.peak, 0) / wins.length),
    learned: true,
    sessions: wins.length,
    activeDays: days.size,
  };
}

/**
 * Will this week's limit be used before it resets? Within 3 days of the weekly reset, projects how much
 * more your usual pace would use, and how much is possible at most (every remaining 5-hour session used
 * fully). Two phases:
 *   reminder: at your usual pace part of the week goes unused, but you can still use it all.
 *   final:    you need (nearly) every remaining session at full use, or under 12 hours are left.
 * Returns null when you are on track or little is left.
 */
function weeklyAlert(plan, share, now = Date.now(), pace = DEFAULT_PACE) {
  const w = plan && plan.weekly;
  const end = w ? time(w.resetsAt) : NaN;
  if (!Number.isFinite(end)) return null;
  const hoursLeft = (end - now) / HOUR;
  const unused = Math.max(0, 100 - w.percent);
  if (hoursLeft <= 0 || hoursLeft > 72 || unused < 10) return null;

  const perSession = (share || DEFAULT_SHARE) * 100; // weekly % one full 5-hour session uses
  const need = unused / perSession; // full sessions needed to use it all
  const s = plan.session;
  const sEnd = s ? time(s.resetsAt) : NaN;
  const inSession = Number.isFinite(sEnd) && sEnd > now;
  const currentLeft = inSession ? Math.max(0, 100 - s.percent) / 100 : 0;
  const freeTime = Math.max(0, end - Math.max(now, inSession ? sEnd : now));
  const fit = currentLeft + Math.floor(freeTime / FIVE_H) + ((freeTime % FIVE_H) >= HOUR ? (freeTime % FIVE_H) / FIVE_H : 0);

  const p = pace || DEFAULT_PACE;
  const expectedSessions = Math.min(fit, p.sessionsPerDay * (hoursLeft / 24));
  const projected = Math.min(100, w.percent + expectedSessions * (p.avgUse / 100) * perSession);
  const maxReach = Math.min(100, w.percent + fit * perSession);
  if (projected >= 97) return null; // on track

  const level = hoursLeft <= 12 || need >= fit * 0.85 ? 'final' : 'reminder';
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    level,
    unused: Math.round(unused),
    used: Math.round(w.percent),
    hoursLeft: r1(hoursLeft),
    resetsAt: w.resetsAt,
    need: r1(need),
    fit: r1(fit),
    projected: Math.round(projected),
    maxReach: Math.round(maxReach),
    perSession: r1(perSession),
    pace: { sessionsPerDay: p.sessionsPerDay, avgUse: p.avgUse, learned: p.learned },
    estimated: !share,
    inSession,
    sessionLeft: inSession ? Math.round(currentLeft * 100) : 0,
    sessionEndsAt: inSession ? s.resetsAt : null,
  };
}

module.exports = { emptyStore, record, normalize, pattern, learnedShare, weekSummary, weeklyAlert, series, cycles, DEFAULT_SHARE, FIVE_H, WEEK };
