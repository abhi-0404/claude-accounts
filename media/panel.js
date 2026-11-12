// Claude Accounts panel (runs inside the VS Code web view).
(function () {
  const vscode = acquireVsCodeApi();
  const ACTIVE_MS = 2 * 60 * 1000; // a chat written to in the last 2 minutes is "active"
  const PAGE = 40;
  const PERIOD_LABEL = { '5h': 'last 5 hours', '7d': 'last 7 days', all: 'all time' };

  const saved = vscode.getState() || {};
  // Everything starts closed; `open` remembers what you opened. (Older saved state used `closed`.)
  const ui = Object.assign({ open: { 'g:Accounts': true }, scope: 'folder', q: '', limit: PAGE, range: 'w1', utab: 'history', hspan: 'week', details: false, kind: 'chats', who: 'mine', fold: {} }, saved.ui || {});
  if (ui.scope === 'projects') ui.kind = 'projects'; // older saved state
  delete ui.scope;
  delete ui.closed;
  const isOpen = (id) => Boolean(ui.open[id]);
  let state = saved.state || null;
  const save = () => vscode.setState({ ui, state });
  const send = (type, extra) => vscode.postMessage(Object.assign({ type }, extra || {}));

  const svg = (body) => `<svg viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
  const I = {
    chev: svg('<path d="M4 6l4 4 4-4"/>'),
    plus: svg('<path d="M8 3v10M3 8h10"/>'),
    minus: svg('<path d="M3 8h10"/>'),
    left: svg('<path d="M10 3L5 8l5 5"/>'),
    right: svg('<path d="M6 3l5 5-5 5"/>'),
    search: svg('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>'),
    users: svg('<circle cx="6" cy="5.5" r="2.3"/><path d="M1.8 13c0-2.4 1.9-4 4.2-4s4.2 1.6 4.2 4"/><path d="M10.5 3.5a2.2 2.2 0 010 4.3M12 9.3c1.5.4 2.5 1.7 2.5 3.7"/>'),
    bolt: svg('<path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z"/>'),
    terminal: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 6l2 2-2 2M8 10.5h3.5"/>'),
    copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 3.5v-1h-8v8h1"/>'),
    close: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
    folder: svg('<path d="M1.5 4.5a1 1 0 0 1 1-1h3.3l1.5 1.5h6.2a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>'),
    list: svg('<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/>'),
    bell: svg('<path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1.5H3z"/><path d="M6.5 14.5a1.5 1.5 0 0 0 3 0"/>'),
    trash: svg('<path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9M6.8 7v4.5M9.2 7v4.5"/>'),
    tab: svg('<rect x="1.5" y="3" width="13" height="10.5" rx="1.5"/><path d="M1.5 6.5h13M6 3v3.5"/>'),
    sync: svg('<path d="M13.5 8A5.5 5.5 0 0 1 3.6 11.3M2.5 8a5.5 5.5 0 0 1 9.9-3.3"/><path d="M12.6 2v2.9H9.7M3.4 14v-2.9h2.9"/>'),
  };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ctx = (o) => esc(JSON.stringify(Object.assign({ preventDefaultContextMenuItems: true }, o)));
  const $ = (sel) => document.querySelector(sel);
  const num = (n) => Number(n || 0).toLocaleString();
  const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));

  function ago(ms) {
    if (!ms) return '';
    const mins = Math.floor((Date.now() - ms) / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return days < 14 ? `${days}d` : `${Math.floor(days / 7)}w`;
  }
  const agoLong = (ms) => {
    if (!ms) return 'never';
    const secs = Math.floor((Date.now() - ms) / 1000);
    if (secs < 5) return 'just now';
    if (secs < 60) return `${secs}s ago`;
    return `${ago(ms)} ago`;
  };
  /** "Resets today at 11:40 PM", "Resets tomorrow at 9:00 AM", "Resets Sat, Nov 14 at 9:29 AM". */
  function resetText(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const today = new Date();
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    if (d.toDateString() === today.toDateString()) return `Resets today at ${time}`;
    if (d.toDateString() === tomorrow.toDateString()) return `Resets tomorrow at ${time}`;
    return `Resets ${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} at ${time}`;
  }
  const tokens = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));
  const money = (n) => (n == null ? '' : Number.isInteger(n) ? `$${n}` : `$${Number(n).toFixed(2)}`);

  // Organization name without email addresses (personal plans are named "<email>'s Organization").
  const orgName = (a) => (a.org && !a.org.includes('@') ? a.org : '');
  const accounts = () => (state ? state.groups.flatMap((g) => g.accounts) : []);

  /**
   * Text of each account's picture: one letter when unique; when letters clash, more of the name
   * (initials of two words, else 2 then 3 letters); identical names get a number (W, W2).
   * Same names always get the same text, so no two different accounts look alike.
   */
  function avatarTexts(labels) {
    const clean = labels.map((l) => (l || '?').trim() || '?');
    const forms = (t) => {
      const w = t.split(/[\s._-]+/).filter(Boolean);
      const ini = w.length > 1 ? w.slice(0, 3).map((x) => x.charAt(0)).join('') : t.slice(0, 2);
      return [t.slice(0, 1), ini, t.slice(0, 2), t.slice(0, 3)].map((x) => x.toUpperCase());
    };
    const clashes = (i, n) => clean.some((o, j) => j !== i && o !== clean[i] && forms(o)[n] === forms(clean[i])[n]);
    const out = [];
    const used = new Set();
    const firstText = new Map(); // identical names share the first one's text, numbered after it
    const count = new Map();
    clean.forEach((t, i) => {
      let pick = null;
      if (firstText.has(t)) {
        const n = (count.get(t) || 1) + 1;
        count.set(t, n);
        pick = firstText.get(t).charAt(0) + n;
        while (used.has(pick)) pick += '_';
      } else {
        const f = forms(t);
        let n = 0;
        while (n < f.length - 1 && clashes(i, n)) n += 1;
        pick = f.slice(n).find((x) => !used.has(x)) || null;
        for (let k = 2; !pick; k += 1) if (!used.has(f[0] + k)) pick = f[0] + k;
        firstText.set(t, pick);
      }
      used.add(pick);
      out.push(pick);
    });
    return out;
  }
  const avatarText = (label, acct) => {
    const list = accounts();
    const i = acct ? list.indexOf(acct) : list.findIndex((v) => v.label === label);
    return i < 0 ? String(label || '?').charAt(0).toUpperCase() : avatarTexts(list.map((v) => v.label))[i];
  };
  const selected = () => accounts().find((a) => a.key === state.selected) || accounts()[0];
  const historyOf = (a) => (a && state.histories[a.histKey]) || null;

  // ---------- Skeleton (built once; live updates only refill the parts inside) ----------

  const section = (id, title, actions = '') => `
    <section class="sec" id="sec-${id}">
      <div class="sec-head">
        <button class="toggle" data-toggle="${id}" aria-expanded="true">${I.chev}<span class="ellipsis">${title}</span></button>
        <div class="sec-actions">${actions}</div>
      </div>
      <div class="sec-body" id="${id}"></div>
    </section>`;

  document.body.innerHTML = `
    <main data-vscode-context='{"preventDefaultContextMenuItems":true}'>
      <div id="banner" role="status" aria-live="polite"></div>
      <div class="accounts" id="accounts" aria-label="Accounts"></div>
      ${section('sessions', 'Chats &amp; projects', '<span class="head-note" id="chats-note"></span>')}
      ${section('usage', 'Usage', '<span class="usage-head" id="usage-head"></span>')}
      <div class="rate" id="rate" hidden></div>
    </main>`;

  $('#sessions').innerHTML = `
    <button class="new-session" id="new-btn" data-act="newSession">${I.plus}<span class="ellipsis">New session</span></button>
    <div class="lists">
      <div class="tabs" id="kind" role="tablist" aria-label="Show">
        <button role="tab" data-kind="chats" title="Your chats; click one to continue it"><span>Chats</span><span class="n" id="n-chats"></span></button>
        <button role="tab" data-kind="projects" title="Folders you have chatted in; click one to open it in VS Code"><span>Projects</span><span class="n" id="n-projects"></span></button>
      </div>
      <button class="scope-btn" id="scope-btn" data-act="toggleScope" aria-pressed="false">${I.users}<span>All accounts</span></button>
    </div>
    <div class="toolbar">
      <label class="search" id="search">${I.search}<input id="q" type="text" placeholder="Search chats" aria-label="Search chats" spellcheck="false" autocomplete="off"><button class="icon-btn" data-act="clearQ" title="Clear" aria-label="Clear search">${I.close}</button></label>
    </div>
    <div class="scope-note" id="scope-note" aria-live="polite"></div>
    <div id="session-list" role="list"></div>`;

  $('#usage').innerHTML = `
    <div id="limits"></div>
    <button class="details-toggle" id="details-toggle" data-act="toggleDetails" aria-expanded="false">${I.chev}<span>History &amp; models</span></button>
    <div id="details" hidden>
      <div class="details-bar">
        <div class="seg seg-sm utab" id="utab" role="group" aria-label="Details">
          <button data-utab="history" title="5-hour sessions and the weekly limit over time">History</button>
          <button data-utab="models" title="Tokens and replies per model">Models</button>
        </div>
        <select id="details-range" class="mini-select" aria-label="Period"></select>
      </div>
      <div id="usage-more"></div>
    </div>`;

  const q = $('#q');
  q.value = ui.q;

  // Show the scrollbar thumb while scrolling (with the mouse or keyboard), hide it shortly after.
  let scrollTimer;
  window.addEventListener('scroll', () => {
    document.documentElement.classList.add('scrolling');
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => document.documentElement.classList.remove('scrolling'), 900);
  }, { passive: true });

  // Keep the panel still: a live update only redraws a part whose content really changed, so rows do
  // not flicker, hover and focus stay put, and the list keeps its scroll position.
  const innerHTMLProp = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  for (const el of [$('#banner'), $('#accounts'), $('#limits'), $('#usage-head'), $('#usage-more'), $('#session-list')]) {
    let last = null;
    Object.defineProperty(el, 'innerHTML', {
      get: () => innerHTMLProp.get.call(el),
      set: (html) => {
        if (html === last) return;
        last = html;
        innerHTMLProp.set.call(el, html);
      },
    });
  }

  // ---------- Accounts ----------

  function renderAccounts() {
    $('#accounts').innerHTML = state.groups
      .map((g) => {
        const closed = !isOpen(`g:${g.name}`);
        return `<div class="group ${closed ? 'closed' : ''}">
          <div class="group-head">
            <button class="toggle" data-toggle="g:${esc(g.name)}" aria-expanded="${!closed}">${I.chev}<span class="ellipsis">${esc(g.name)}</span><span class="count">${g.accounts.length}</span></button>
            <button class="icon-btn" data-act="add" data-group="${esc(g.name)}" title="Add an account to ${esc(g.name)}" aria-label="Add an account to ${esc(g.name)}">${I.plus}</button>
          </div>
          <div class="group-body" role="list">${g.accounts.length ? '<div class="acct-head" aria-hidden="true"><span class="name" title="Your Claude accounts">Account</span><span class="first" title="Session (5 hour) usage">5h</span><span title="Weekly (7 day) usage">Week</span><span class="use" title="The account Claude uses now, or a button to switch to another">Use</span></div>' : ''}${g.accounts.map(accountRow).join('')}${g.accounts.length === 1 ? '<div class="hint">Have another Claude account? <button class="link" data-act="add">Add it</button> to switch in one click.</div>' : ''}</div>
        </div>`;
      })
      .join('');
  }

  /**
   * Short alert wording, used by the card, the bell and its hover:
   *   title: the point in a few words; line: the key numbers; detail: the full reasoning (hover only).
   */
  function alertCopy(al) {
    const resets = `resets ${new Date(al.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric' })}`;
    const title = al.level === 'final' ? (al.maxReach < 100 ? `Max ${al.maxReach}% reachable` : 'Use every session fully') : `On pace for ${al.projected}%`;
    const line = `${al.unused}% left · ${resets} · ${al.need} of ${al.fit} sessions needed`;
    const detail = [
      al.level === 'final' ? 'Final alert' : 'Reminder',
      `Weekly used|${al.used}%`,
      `Your pace|${al.pace.sessionsPerDay}/day at ${al.pace.avgUse}%${al.pace.learned ? '' : ' (est.)'}`,
      `Reach at your pace|${al.projected}%`,
      `Reach at full use|${al.maxReach}%`,
      al.inSession ? `Current session left|${al.sessionLeft}%` : '',
    ].filter(Boolean).join('\n');
    return { title, line, detail };
  }

  /** Bell next to the account name when its weekly limit is at risk of going unused (icon + text, never color alone). */
  function alertIcon(a) {
    const al = a.weekly && a.weekly.alert;
    if (!al) return '';
    const c = alertCopy(al);
    const tip = `${al.level === 'final' ? 'Final alert' : 'Reminder'}: ${c.title}\n${c.line.split(' · ').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('\n')}`;
    return `<span class="acct-alert ${al.level}" role="img" aria-label="${esc(tip.replace(/\n/g, ', '))}" data-tip="${esc(tip)}">${I.bell}</span>`;
  }

  function accountRow(a) {
    const sel = a.key === state.selected;
    let side = '';
    if (a.status === 'error') side = '<span class="muted small" title="Claude Code was not found. Install Claude Code (the claude command), or set claudeAccounts.claudePath.">Not found</span>';
    else if (a.status === 'signedOut') side = `<button class="link" data-act="signIn" data-key="${esc(a.key)}">Sign in</button>`;
    else if (a.active) side = '<span class="badge">In use</span>';
    else if (a.status === 'signedIn') side = `<button class="pill" data-act="switch" data-key="${esc(a.key)}" title="Switch Claude to ${esc(a.label)}. VS Code, your project and chats stay as they are.">Switch</button>`;
    // Session (5-hour) and weekly usage, each in its own column so the numbers line up.
    const level = (p) => (p >= 100 ? 'full' : p >= 80 ? 'warn' : '');
    const col = (w, name) => `<span class="acct-col" title="${name} usage">${w ? `<span class="${level(w.percent)}">${w.percent}%</span>` : ''}</span>`;
    const use = `${col(a.usage && a.usage.session, 'Session (5hr)')}${col(a.usage && a.usage.weekly, 'Weekly (7 day)')}`;
    const tip = [
      a.label,
      a.status === 'signedIn' ? [a.email, a.plan, orgName(a)].filter(Boolean).join(' · ') : a.status === 'signedOut' ? 'Not signed in' : a.status === 'error' ? 'Claude Code not found' : 'Checking sign-in…',
      a.active ? 'In use: new sessions run with this account' : '',
      `Login folder: ${a.configDir}`,
      'Click for details · drag to reorder · right-click for more',
    ].filter(Boolean).join('\n');
    return `<div class="acct ${a.status} ${sel ? 'sel' : ''} ${a.active ? 'active' : ''}" role="listitem" tabindex="0" draggable="true" data-key="${esc(a.key)}" aria-current="${sel}" title="${esc(tip)}"
        data-vscode-context="${ctx({ webviewSection: 'account', accountKey: a.key, isActive: a.active, signedIn: a.status === 'signedIn', signedOut: a.status === 'signedOut' })}">
      <span class="avatar${avatarText(a.label, a).length > 1 ? ' two' : ''}">${esc(avatarText(a.label, a))}</span>
      <span class="acct-name ellipsis">${esc(a.label)}${alertIcon(a)}</span>
      ${use}
      <span class="acct-side">${side}</span>
    </div>`;
  }

  // ---------- Out-of-usage banner and projects ----------

  function renderBanner() {
    const b = state.banner;
    $('#banner').innerHTML = (!b
      ? ''
      : `<div class="banner">
          <div><strong>${esc(b.account)}</strong> is out of usage${b.until ? ` until ${esc(new Date(b.until).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}` : ''}.</div>
          ${b.suggestKey
            ? `<button class="btn" data-act="switch" data-key="${esc(b.suggestKey)}">Continue with ${esc(b.suggestLabel)}</button>`
            : '<div class="muted">No other signed-in account has usage left. Add one with +.</div>'}
        </div>`);
  }

  // ---------- Weekly plan ----------

  const shortTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dayTime = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });


  let chartModel = null; // what the chart shows, for the mouse tracker: { start, span, segs: [{ c (curve), lineStart, lineEnd }] }

  /** Mouse over the chart: the weekly line if the mouse is on it, else the session bar under it, else nothing. */
  function track(e) {
    const bar = e.target.closest && e.target.closest('.sbar');
    if (trackLine(e)) {
      markBar(null);
      return;
    }
    if (!bar) return untrack();
    // Over a session bar: highlight it and show how much of that session was used.
    const tr = $('#track');
    if (tr) tr.hidden = true;
    const plot = $('#plot');
    if (plot) plot.classList.remove('online');
    markBar(bar);
    showTip(bar);
  }
  function markBar(bar) {
    document.querySelectorAll('.sbar.hot').forEach((n) => n !== bar && n.classList.remove('hot'));
    if (bar) bar.classList.add('hot');
  }

  /** Shows the weekly value under the mouse, but only while the mouse is on the line itself. Returns true when it did. */
  function trackLine(e) {
    const plot = $('#plot');
    const tr = $('#track');
    const m = chartModel;
    if (!plot || !tr || !m) return false;
    const r = plot.getBoundingClientRect();
    const frac = (e.clientX - r.left) / r.width;
    const t = m.start + frac * m.span;
    const seg = m.segs.find((q) => t >= q.lineStart && t <= q.lineEnd);
    if (frac < 0 || frac > 1 || !seg) return false;
    const reach = (m.span / r.width) * 6; // 6 pixels either side, so steep parts of the line are easy to hit
    const v = curveAt(seg.c, t);
    const yOf = (val) => r.bottom - (r.height * clamp(val)) / 100;
    const low = yOf(curveAt(seg.c, Math.max(seg.lineStart, t - reach)));
    const high = yOf(curveAt(seg.c, Math.min(seg.lineEnd, t + reach)));
    if (e.clientY > low + 7 || e.clientY < high - 7) return false;
    plot.classList.add('online');
    tr.hidden = false;
    tr.style.left = `${frac * 100}%`;
    tr.firstElementChild.style.bottom = `${clamp(v)}%`;
    const rounded = Math.round(v * 10) / 10;
    const text = [`${fmtDay(t)} · ${shortTime(t)}`, `Week used|${rounded}%`, `Week left|${Math.round((100 - rounded) * 10) / 10}%`].join('\n');
    const y = yOf(v);
    showTip({ dataset: { tip: text }, getBoundingClientRect: () => ({ left: e.clientX, top: y - 6, bottom: y + 10, width: 0, height: 16 }) });
    return true;
  }
  function untrack() {
    markBar(null);
    const tr = $('#track');
    if (tr) tr.hidden = true;
    const plot = $('#plot');
    if (plot) plot.classList.remove('online');
    hideTip();
  }

  let chartAt = null; // how far the zoomed chart is scrolled (0..1), null = follow "now"
  /** Another week: delta 1 = the week before, -1 = the week after. Zoomed, it continues at the matching end. */
  function goWeek(delta) {
    weekBack = Math.max(0, weekBack + delta);
    chartAt = weekBack === 0 && delta < 0 ? null : delta > 0 ? 1 : 0;
    renderWeekly();
  }

  function placeChart() {
    const chart = $('#chart');
    if (!chart) return;
    const room = chart.scrollWidth - chart.clientWidth;
    if (room > 0) {
      const nowPct = chart.dataset.now === '' ? NaN : Number(chart.dataset.now);
      const follow = Number.isFinite(nowPct) ? Math.max(0, Math.min(room, (nowPct / 100) * chart.scrollWidth - chart.clientWidth * 0.7)) : 0;
      chart.scrollLeft = chartAt != null ? chartAt * room : follow;
    }
    if (chart.dataset.wired) return;
    chart.dataset.wired = '1';
    const inner = chart.firstElementChild;
    chart.addEventListener('scroll', () => {
      const r = chart.scrollWidth - chart.clientWidth;
      chartAt = r > 0 ? chart.scrollLeft / r : null;
      untrack();
    }, { passive: true });

    // Drag to move the chart. Zoomed in it slides inside the week; pulling past either edge (or dragging
    // the whole week) goes to the earlier or later week.
    let drag = null;
    const EDGE = 60;
    const overshoot = (dx) => {
      const room2 = chart.scrollWidth - chart.clientWidth;
      const want = drag.left - dx;
      return want < 0 ? want : want > room2 ? want - room2 : 0;
    };
    chart.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, left: chart.scrollLeft, moved: false };
      try {
        chart.setPointerCapture(e.pointerId);
      } catch {
        // not capturable: moves outside the chart are simply ignored
      }
    });
    chart.addEventListener('pointermove', (e) => {
      if (!drag) return e.target.closest('#plot') ? track(e) : untrack();
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 4) return undefined;
      if (!drag.moved) {
        drag.moved = true;
        untrack();
        chart.classList.add('dragging');
      }
      chart.scrollLeft = drag.left - dx;
      inner.style.transform = `translateX(${-overshoot(dx) * 0.5}px)`;
      return undefined;
    });
    const release = (e) => {
      if (!drag) return;
      const moved = drag.moved;
      const over = moved ? overshoot(e.clientX - drag.x) : 0;
      drag = null;
      chart.classList.remove('dragging');
      inner.style.transform = '';
      if (moved && over < -EDGE) goWeek(1);
      else if (moved && over > EDGE) goWeek(-1);
    };
    chart.addEventListener('pointerup', release);
    chart.addEventListener('pointercancel', release);
    chart.addEventListener('pointerleave', () => {
      if (!drag) untrack();
    });
    chart.addEventListener('dblclick', () => setZoom(ui.zoom >= 4 ? 1 : (ui.zoom || 1) * 2));
    chart.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') goWeek(1);
      else if (e.key === 'ArrowRight') goWeek(-1);
    });
  }

  function setZoom(z) {
    ui.zoom = Math.max(1, Math.min(4, z));
    if (ui.zoom === 1) chartAt = null;
    save();
    renderWeekly();
  }

  function renderWeekly() {
    const a = selected();
    const body = $('#usage-more');
    const w = a && a.weekly;
    if (!a || a.status !== 'signedIn' || !w) {
      body.innerHTML = '<p class="note">Sign in to see this account’s usage history.</p>';
      return;
    }
    body.innerHTML = historyView(a, w);
    placeChart();
  }

  // ---------- Usage history: timeline of 5-hour sessions and the weekly limit ----------

  const DAY = 864e5;
  const WEEK_MS = 7 * DAY;
  let weekBack = 0; // which weekly frame the chart shows: 0 = this week, 1 = the week before, and so on
  const fmtDay = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtShortDate = (ms) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const startOfDay = (ms) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

  /**
   * A smooth curve through points [{ t, v }] (t rising, v never falling). Monotone cubic (Fritsch and
   * Carlson): it passes through every point and never dips below or overshoots above its neighbours,
   * so a weekly limit that only climbs is drawn as a line that only climbs.
   */
  function makeCurve(P) {
    const n = P.length;
    const m = new Array(n).fill(0);
    if (n > 1) {
      const d = [];
      for (let i = 0; i < n - 1; i += 1) d.push((P[i + 1].v - P[i].v) / (P[i + 1].t - P[i].t));
      m[0] = d[0];
      m[n - 1] = d[n - 2];
      for (let i = 1; i < n - 1; i += 1) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
      for (let i = 0; i < n - 1; i += 1) {
        if (d[i] === 0) {
          m[i] = 0;
          m[i + 1] = 0;
          continue;
        }
        const a = m[i] / d[i];
        const b = m[i + 1] / d[i];
        const s = a * a + b * b;
        if (s > 9) {
          const k = 3 / Math.sqrt(s);
          m[i] = k * a * d[i];
          m[i + 1] = k * b * d[i];
        }
      }
    }
    return { P, m };
  }

  /** The curve's value at time t (flat before the first and after the last point). */
  function curveAt(c, t) {
    const { P, m } = c;
    const last = P.length - 1;
    if (t <= P[0].t) return P[0].v;
    if (t >= P[last].t) return P[last].v;
    let i = 0;
    while (i < last - 1 && P[i + 1].t <= t) i += 1;
    const h = P[i + 1].t - P[i].t;
    const u = (t - P[i].t) / h;
    const u2 = u * u;
    const u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * P[i].v + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * P[i + 1].v + (u3 - u2) * h * m[i + 1];
  }

  /** SVG path of the curve (X and Y map time and value to the drawing), then flat on to time endT. */
  function curvePath(c, X, Y, endT) {
    const { P, m } = c;
    const f = (n) => Math.round(n * 100) / 100;
    let d = `M${f(X(P[0].t))} ${f(Y(P[0].v))}`;
    for (let i = 0; i < P.length - 1; i += 1) {
      const h = P[i + 1].t - P[i].t;
      d += `C${f(X(P[i].t + h / 3))} ${f(Y(P[i].v + (m[i] * h) / 3))} ${f(X(P[i + 1].t - h / 3))} ${f(Y(P[i + 1].v - (m[i + 1] * h) / 3))} ${f(X(P[i + 1].t))} ${f(Y(P[i + 1].v))}`;
    }
    const tail = P[P.length - 1];
    if (endT > tail.t) d += `L${f(X(endT))} ${f(Y(tail.v))}`;
    return d;
  }

  /** The weekly-limit points of one cycle (reset to reset): 0% at the reset, each recorded value, and now when it is the current cycle. */
  function cyclePoints(series, cs, ce, now, isCurrent, cur) {
    const inCycle = series.weekly.filter((p) => p.at >= cs && p.at < ce && p.at <= now).sort((p, q) => p.at - q.at);
    const P = [];
    if (inCycle.length && series.weekly.some((p) => p.at < cs)) P.push({ t: cs, v: 0 });
    for (const p of inCycle) {
      const v = Math.max(P.length ? P[P.length - 1].v : 0, p.w); // a limit used never goes back down
      if (P.length && p.at <= P[P.length - 1].t) P[P.length - 1].v = v;
      else P.push({ t: p.at, v });
    }
    if (isCurrent && cur != null && P.length && cur >= P[P.length - 1].v && now > P[P.length - 1].t) P.push({ t: now, v: cur });
    return P;
  }

  /**
   * History for one frame: a week (reset to reset) or a calendar month. This week or month by default;
   * earlier ones with the arrows or by dragging. A month draws the weekly limit as a saw-tooth: each
   * week's curve climbs, then starts again from 0 at the dotted reset line.
   */
  function historyView(a, w) {
    const now = Date.now();
    const series = w.series || { slots: [], weekly: [] };
    const monthly = ui.hspan === 'month';
    const resetAt = w.weeklyReset ? Date.parse(w.weeklyReset) : NaN;
    const known = Number.isFinite(resetAt) && resetAt > now;
    const end0 = known ? resetAt : now; // the current weekly cycle ends at the next reset (or now when it is not known)
    const times = [...series.slots.map((q) => q.start), ...series.weekly.map((p) => p.at)];
    const earliest = times.length ? Math.min(...times) : now;
    let start;
    let end;
    let maxBack;
    let rangeText;
    let ago;
    if (monthly) {
      const base = new Date(now);
      const e = new Date(earliest);
      maxBack = Math.max(0, Math.min(24, (base.getFullYear() - e.getFullYear()) * 12 + base.getMonth() - e.getMonth()));
      weekBack = Math.max(0, Math.min(maxBack, weekBack));
      start = new Date(base.getFullYear(), base.getMonth() - weekBack, 1).getTime();
      end = new Date(base.getFullYear(), base.getMonth() - weekBack + 1, 1).getTime();
      rangeText = new Date(start).toLocaleDateString([], { month: 'long', year: 'numeric' });
      ago = weekBack === 0 ? 'this month' : weekBack === 1 ? 'last month' : `${weekBack} months ago`;
    } else {
      maxBack = Math.max(0, Math.min(26, Math.ceil((end0 - earliest) / WEEK_MS) - 1));
      weekBack = Math.max(0, Math.min(maxBack, weekBack));
      end = end0 - weekBack * WEEK_MS;
      start = end - WEEK_MS;
      rangeText = known || weekBack > 0 ? `${fmtShortDate(start)} to ${fmtShortDate(end)}` : 'Last 7 days';
      ago = weekBack === 0 ? 'this week' : weekBack === 1 ? 'last week' : `${weekBack} weeks ago`;
    }
    const span = end - start;
    const isNow = weekBack === 0;
    const unit = monthly ? 'month' : 'week';
    const x = (t) => Math.max(0, Math.min(100, ((t - start) / span) * 100));
    const slots = series.slots.filter((q) => q.end > start && q.start < end);
    const cur = a.usage && a.usage.weekly ? a.usage.weekly.percent : null;

    // The weekly cycles inside the frame: one for a week, about five for a month.
    const cycles = [];
    if (monthly) {
      for (let k = 0; k < 80; k += 1) {
        const ce = end0 - k * WEEK_MS;
        if (ce <= start) break;
        if (ce - WEEK_MS < end) cycles.push({ k, cs: ce - WEEK_MS, ce });
      }
    } else {
      cycles.push({ k: weekBack, cs: start, ce: end });
    }
    for (const c of cycles) {
      c.P = cyclePoints(series, c.cs, c.ce, now, c.k === 0, cur);
      c.lineEnd = c.k === 0 ? Math.min(now, c.ce) : c.ce;
      c.reached = c.P.length ? c.P[c.P.length - 1].v : null;
    }
    const reachedList = cycles.filter((c) => c.reached != null).map((c) => c.reached);
    const weekNum = monthly
      ? reachedList.length ? Math.round(reachedList.reduce((t, v) => t + v, 0) / reachedList.length) : null
      : isNow && cur != null ? cur : cycles[0].reached;

    // Numbers for this frame, each with a caption.
    const avg = slots.length ? Math.round(slots.reduce((t, s) => t + s.peak, 0) / slots.length) : null;
    const top = slots.length ? Math.max(...slots.map((s) => s.peak)) : null;
    const perSession = w.perSession == null ? '?' : `${w.perSession}%`;
    const since = w.summary && w.summary.trackingSince;
    const learnTip = `A full 5-hour session uses about ${perSession} of the week${w.share ? '' : ' (estimate until learned)'}.${since ? ` Tracking since ${new Date(since).toLocaleDateString([], { month: 'short', day: 'numeric' })}.` : ''}`;
    const fact = (num, label, tip) => `<div class="fact" title="${esc(tip)}"><b>${num}</b><span>${label}</span></div>`;
    const lastLabel = monthly ? 'avg week' : isNow ? 'of week' : 'reached';
    const lastTip = monthly ? 'The weekly limit you reached, on average, over the weeks of this month.' : isNow ? 'Weekly limit used so far this week.' : 'How much of the weekly limit you reached that week.';
    let html = `<div class="weeknav">
        <button class="icon-btn" data-act="weekPrev" title="Earlier ${unit}" aria-label="Earlier ${unit}"${weekBack >= maxBack ? ' disabled' : ''}>${I.left}</button>
        <span class="weeklabel" title="${monthly ? 'A calendar month. The dotted lines are the weekly resets.' : 'Weekly limit: from one reset to the next'}">${esc(rangeText)}<em>${ago}</em></span>
        <button class="icon-btn" data-act="weekNext" title="Later ${unit}" aria-label="Later ${unit}"${weekBack === 0 ? ' disabled' : ''}>${I.right}</button>
      </div>
      <div class="facts">
        ${fact(slots.length, 'sessions', `5-hour sessions you used in this ${unit}.\n${learnTip}`)}
        ${fact(avg == null ? '-' : `${avg}%`, 'avg used', 'How much of a 5-hour session you used, on average.')}
        ${fact(top == null ? '-' : `${top}%`, 'highest', `The most you used of a single 5-hour session this ${unit}.`)}
        ${fact(weekNum == null ? '-' : `${weekNum}%`, lastLabel, lastTip)}
      </div>`;

    // Day bands and labels across the frame.
    let bands = '';
    let labels = '';
    let i = 0;
    for (let d = startOfDay(start); d < end; i += 1) {
      const next = startOfDay(d + 1.5 * DAY); // safe across daylight saving changes
      const l = x(Math.max(d, start));
      const r = x(Math.min(next, end));
      if (monthly) {
        bands += `<div class="band ${Math.floor(i / 7) % 2 ? 'alt' : ''}" style="left:${l}%;width:${r - l}%"></div>`;
        if (i % 7 === 0) {
          const day = new Date(d);
          labels += `<span style="left:${l}%;width:${x(d + 7 * DAY) - l}%">${esc(i === 0 ? day.toLocaleDateString([], { month: 'short', day: 'numeric' }) : String(day.getDate()))}</span>`;
        }
      } else if (r > l) {
        bands += `<div class="band ${i % 2 ? 'alt' : ''}" style="left:${l}%;width:${r - l}%"></div>`;
        if (r - l >= 7) labels += `<span style="left:${l}%;width:${r - l}%">${esc(new Date(Math.max(d, start)).toLocaleDateString([], { weekday: 'short', day: 'numeric' }))}</span>`;
      }
      d = next;
    }
    // Dotted lines are the weekly resets (a week: both ends; a month: every reset inside it).
    let marks = '';
    if (monthly) {
      const resets = new Set(cycles.flatMap((c) => [c.cs, c.ce]).filter((t) => t > start && t < end));
      for (const t of resets) marks += `<div class="mark reset" style="left:${x(t)}%"></div>`;
    } else {
      marks = '<div class="mark reset"></div><div class="mark reset end"></div>';
    }
    if (now > start && now < end) marks += `<div class="mark now" style="left:${x(now)}%"></div><div class="future" style="left:${x(now)}%"></div>`;

    // Behind: each 5-hour session where it happened; height = how much of it was used.
    const bars = slots
      .map((q) => {
        const cp = now >= q.start && now < q.end;
        const spoken = `${shortTime(q.start)} to ${shortTime(q.end)}, ${fmtDay(q.start)}, session used ${q.peak}%`;
        const tip = [
          `${fmtDay(q.start)} · ${shortTime(q.start)} to ${shortTime(q.end)}${cp ? ' · now' : ''}`,
          `Session used|${q.peak}%`,
          `Session left|${Math.max(0, 100 - q.peak)}%`,
          q.weeklyUsed ? `Added to week|+${q.weeklyUsed}%` : '',
        ].filter(Boolean).join('\n');
        return `<div class="sbar ${cp ? 'current' : ''}" role="img" aria-label="${esc(spoken)}" data-tip="${esc(tip)}" style="left:${x(q.start)}%;width:${x(q.end) - x(q.start)}%;height:${Math.max(3, clamp(q.peak))}%"></div>`;
      })
      .join('');
    const sessionsPlot = `${bands}<div class="gl" style="bottom:50%"><i>50%</i></div><div class="gl" style="bottom:100%"><i>100%</i></div>${marks}${bars}`;

    // In front: the weekly limit, one smooth curve per cycle.
    const X = (t) => ((t - start) / span) * 1000;
    const Y = (v) => 100 - clamp(v);
    const segs = [];
    let path = '';
    let area = '';
    let nowDot = '';
    for (const c of cycles) {
      if (!c.P.length) continue;
      const curve = makeCurve(c.P);
      const p = curvePath(curve, X, Y, c.lineEnd);
      path += p;
      area += `${p}V100H${Math.round(X(c.P[0].t) * 100) / 100}Z`;
      segs.push({ c: curve, lineStart: c.P[0].t, lineEnd: c.lineEnd });
      if (c.k === 0 && c.lineEnd > start && c.lineEnd <= end) nowDot = `<div class="wdot nowdot" style="left:${x(c.lineEnd)}%;bottom:${clamp(c.reached)}%"></div>`;
    }
    chartModel = segs.length ? { start, span, segs } : null; // what the mouse tracker reads
    const zoom = [1, 2, 4].includes(ui.zoom) ? ui.zoom : 1;
    html += `<div class="chart z${zoom}" id="chart" tabindex="0" role="group" aria-label="Weekly limit and 5-hour sessions, ${esc(rangeText)}${weekNum != null ? `, ${weekNum}% ${monthly ? 'on average per week' : 'used'}` : ''}" data-now="${now > start && now <= end ? x(now) : ''}">
        <div class="chart-inner" style="width:${zoom * 100}%">
          <div class="plot sessions" id="plot">${sessionsPlot}${path ? `<svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="${area}"/><path class="halo" d="${path}" vector-effect="non-scaling-stroke"/><path d="${path}" vector-effect="non-scaling-stroke"/></svg>` : slots.length ? '' : `<div class="empty-plot">No usage recorded this ${unit}</div>`}${nowDot}<div class="track" id="track" hidden><i></i></div></div>
          <div class="xlabels">${labels}</div>
        </div>
      </div>
      <div class="legend"><span class="lg-week" title="How much of the weekly limit was used over time. Move the mouse onto the line to read it.">line: week used${isNow && cur != null ? ` ${cur}%` : ''}</span><span class="lg-bars" title="Each bar is one 5-hour session. Its height is how much of that session you used.">bars: session used</span>
        <span class="zoom" role="group" aria-label="Zoom"><button class="icon-btn" data-act="zoomOut" title="Zoom out" aria-label="Zoom out"${zoom === 1 ? ' disabled' : ''}>${I.minus}</button><button class="icon-btn" data-act="zoomIn" title="Zoom in. Drag the chart to move; drag past the edge for another ${unit}." aria-label="Zoom in"${zoom === 4 ? ' disabled' : ''}>${I.plus}</button></span>
      </div>`;

    // Tables: by day for this frame, and every recorded week.
    const days = new Map();
    for (const s of slots) {
      const d = startOfDay(s.start);
      const row = days.get(d) || { day: d, n: 0, sum: 0, week: null };
      row.n += 1;
      row.sum += s.peak;
      if (s.weekly != null) row.week = Math.max(row.week ?? 0, s.weekly);
      days.set(d, row);
    }
    const rows = [...days.values()].sort((p, q) => q.day - p.day);
    html += `<details class="more-table"><summary>By day</summary>${rows.length
      ? `<table class="tbl"><thead><tr><th>Day</th><th title="5-hour sessions">Sessions</th><th title="Average use per session">Avg</th><th title="Weekly limit reached by the end of the day">Week</th></tr></thead><tbody>${rows
          .map((r) => `<tr><td>${esc(fmtDay(r.day))}</td><td>${r.n}</td><td>${Math.round(r.sum / r.n)}%</td><td>${r.week == null ? '-' : `${r.week}%`}</td></tr>`)
          .join('')}</tbody></table>`
      : `<div class="muted small">No sessions this ${unit}.</div>`}</details>`;
    const cyc = w.cycles || [];
    html += `<details class="more-table"><summary>By week</summary>${cyc.length
      ? `<table class="tbl"><thead><tr><th>Week</th><th title="5-hour sessions">Sessions</th><th title="Average use per session">Avg</th><th title="Weekly limit reached">Reached</th></tr></thead><tbody>${cyc
          .map((c) => `<tr class="${c.current ? 'cur' : ''}"><td>${esc(fmtShortDate(c.start))} to ${esc(fmtShortDate(c.end))}${c.current ? ' (now)' : ''}</td><td>${c.sessions}</td><td>${c.avg == null ? '-' : `${c.avg}%`}</td><td>${c.reached == null ? '-' : `${c.reached}%`}</td></tr>`)
          .join('')}</tbody></table>`
      : '<div class="muted small">No weeks recorded yet.</div>'}</details>`;
    return html;
  }

  // One shared hover tip for chart marks (bars, resets, now).
  const tipEl = document.createElement('div');
  tipEl.className = 'tip';
  tipEl.setAttribute('role', 'tooltip');
  document.body.appendChild(tipEl);
  function showTip(el) {
    // First line is the title; "Label|Value" lines become rows with the value right-aligned.
    const [title, ...rows] = el.dataset.tip.split('\n');
    tipEl.textContent = '';
    const head = document.createElement('div');
    head.className = 'tip-title';
    head.textContent = title;
    tipEl.appendChild(head);
    for (const line of rows) {
      const [label, value] = line.split('|');
      const row = document.createElement('div');
      row.className = 'tip-row';
      const l = document.createElement('span');
      l.textContent = label;
      row.appendChild(l);
      if (value != null) {
        const v = document.createElement('b');
        v.textContent = value;
        row.appendChild(v);
      }
      tipEl.appendChild(row);
    }
    tipEl.style.display = 'block';
    const r = el.getBoundingClientRect();
    const w = tipEl.offsetWidth;
    const left = Math.max(4, Math.min(window.innerWidth - w - 4, r.left + r.width / 2 - w / 2));
    const top = r.top - tipEl.offsetHeight - 6;
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${top < 4 ? r.bottom + 6 : top}px`;
  }
  const hideTip = () => (tipEl.style.display = 'none');
  // One tooltip at a time. Our tip and the browser's own (title) used to show together when one
  // element sat inside the other (the bell inside an account row). The innermost one wins: while our
  // tip shows, titles on it and around it are put aside; a title inside a tipped element hides ours.
  let stashed = [];
  const restoreTitles = () => {
    for (const n of stashed) {
      if (n.dataset.heldTitle != null) {
        n.setAttribute('title', n.dataset.heldTitle);
        delete n.dataset.heldTitle;
      }
    }
    stashed = [];
  };
  document.addEventListener('mouseover', (e) => {
    const t = e.target;
    if (t.closest && t.closest('#plot')) return;
    const el = t.closest && t.closest('[data-tip]');
    const titled = t.closest && t.closest('[title]');
    restoreTitles();
    if (!el || (titled && titled !== el && el.contains(titled))) return hideTip();
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hasAttribute('title')) {
        n.dataset.heldTitle = n.getAttribute('title');
        n.removeAttribute('title');
        stashed.push(n);
      }
    }
    showTip(el);
  });
  document.addEventListener('mouseleave', () => {
    restoreTitles();
    hideTip();
  });
  document.addEventListener('focusin', (e) => (e.target.dataset && e.target.dataset.tip ? showTip(e.target) : hideTip()));
  window.addEventListener('scroll', hideTip, { passive: true });

  /** Small letter badges for the accounts a chat or project belongs to (shown in "All"). */
  const ownerTags = (labels) =>
    `<span class="owners" aria-label="${esc(labels.join(', '))}">${labels
      .slice(0, 3)
      .map((l) => `<span class="owner${avatarText(l).length > 1 ? ' two' : ''}">${esc(avatarText(l))}</span>`)
      .join('')}</span>`;

  function projectsHtml(projects, needle, tag) {
    const list = projects.filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.path.toLowerCase().includes(needle));
    return list.length
      ? list
          .map(
            (p) => `<div class="proj ${p.current ? 'current' : ''}" role="listitem" tabindex="0" data-path="${esc(p.path)}" title="${esc(`${p.path}\n${p.chats} chat${p.chats === 1 ? '' : 's'} · last ${new Date(p.last).toLocaleString()}${tag ? `\nAccounts: ${p.owners.join(', ')}` : ''}${p.current ? '\nOpen in this window' : '\nClick to open this project in VS Code'}`)}">
              ${I.folder}<span class="stitle ellipsis">${highlight(p.name)}</span>
              ${tag ? ownerTags(p.owners) : ''}
              <span class="pcount" title="Chats">${p.chats}</span>
              ${p.current ? '<span class="badge">Open</span>' : `<span class="sage" data-age="${p.last}">${ago(p.last)}</span>`}
            </div>`
          )
          .join('')
      : `<div class="empty">${needle ? 'No projects match.' : 'Projects appear here after their first chat.'}</div>`;
  }

  /**
   * Chats in scope: the ones the selected account ran, or every account's ("All"). Claude records the
   * account of every turn, so even with one shared history each chat knows its accounts. Older chats
   * without that record only show under All (or under the one account that owns the history).
   */
  function chatsInScope() {
    const a = selected();
    const all = ui.who === 'all';
    const views = accounts();
    const hks = all ? [...new Set(views.map((v) => v.histKey))] : a ? [a.histKey] : [];
    const out = [];
    let loading = false;
    let unlinked = 0;
    const seen = new Set();
    for (const hk of hks) {
      const h = state.histories[hk];
      if (!h) continue;
      if (!h.loaded) loading = true;
      const sharers = views.filter((v) => v.histKey === hk);
      for (const s of h.sessions) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        const owners = s.owners || [];
        const ran = sharers.filter((v) => v.accountId && owners.includes(v.accountId));
        if (!all) {
          const known = Boolean(a.accountId);
          const mine = !known || owners.includes(a.accountId) || (!owners.length && sharers.length === 1);
          if (!mine) {
            if (!owners.length) unlinked += 1;
            continue;
          }
        }
        const owner = (!all && a) || ran.find((v) => v.active) || ran[0] || sharers.find((v) => v.active) || sharers.find((v) => v.key === state.selected) || sharers.find((v) => v.status === 'signedIn') || sharers[0];
        out.push(Object.assign({}, s, { owner, owners: ran.map((v) => v.label) }));
      }
    }
    out.sort((x, y) => y.mtimeMs - x.mtimeMs);
    return { list: out, loading, unlinked };
  }

  function projectsOf(chats) {
    const byProject = new Map();
    for (const s of chats) {
      const k = s.projectKey.toLowerCase();
      const p = byProject.get(k) || { name: s.folder, path: s.cwd, chats: 0, last: 0, current: k === state.workspaceKey, owners: [] };
      p.chats += 1;
      p.last = Math.max(p.last, s.mtimeMs);
      for (const o of s.owners) if (!p.owners.includes(o)) p.owners.push(o);
      byProject.set(k, p);
    }
    return [...byProject.values()].sort((x, y) => Number(y.current) - Number(x.current) || y.last - x.last);
  }

  // ---------- Account & usage ----------


  /** "5:10 PM" today, "tomorrow 9 AM", else "Sat 9:30 AM". */
  function resetShort(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
    const today = new Date();
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    if (d.toDateString() === today.toDateString()) return time;
    if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
    return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  }

  /** "5 days left", "1 day left", "6h left", "under 1h left". */
  function leftText(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const days = Math.floor(ms / 864e5);
    if (days >= 1) return `${days} day${days === 1 ? '' : 's'} left`;
    const hours = Math.floor(ms / 36e5);
    return hours >= 1 ? `${hours}h left` : 'under 1h left';
  }

  function meter(label, limit, kind, extraTip) {
    if (!limit) return `<div class="meter"><div class="meter-top"><span>${label}</span><span class="pct muted">No data</span></div></div>`;
    const p = Number(limit.percent) || 0;
    const level = p >= 100 ? 'full' : p >= 80 || limit.severity === 'warning' ? 'warn' : '';
    const when = limit.resetsAt ? `resets ${resetShort(limit.resetsAt)}` : limit.resetAt ? 'just reset' : '';
    const tip = [
      limit.resetsAt ? resetText(limit.resetsAt) : limit.resetAt ? `Reset at ${new Date(limit.resetAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, starting fresh. Your next message confirms it.` : '',
      extraTip || '',
    ].filter(Boolean).join('\n');
    return `<div class="meter ${level}" title="${esc(tip)}">
      <div class="meter-top"><span class="ellipsis">${label}${when ? ` <span class="when" ${limit.resetsAt ? `data-reset-short="${esc(limit.resetsAt)}"` : ''}>${esc(when)}</span>` : ''}</span>${kind === 'weekly' && limit.resetsAt && leftText(limit.resetsAt) ? `<span class="left-pill" data-left="${esc(limit.resetsAt)}">${leftText(limit.resetsAt)}</span>` : ''}<span class="pct">${p}%</span></div>
      <div class="bar" role="progressbar" aria-label="${label}" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><i style="width:${clamp(p)}%"></i></div>
    </div>`;
  }

  /** When the bell shows: one box per 5-hour session that still fits before the weekly reset, filled for the ones needed to use what is left. */
  function sessionsGraph(a) {
    const al = a.weekly && a.weekly.alert;
    if (!al) return '';
    const total = Math.max(1, Math.min(28, Math.floor(al.fit)));
    const need = Math.min(total, Math.max(1, Math.ceil(al.need)));
    const boxes = Array.from({ length: total }, (_, i) => {
      const first = i === 0 && al.inSession;
      const use = i < need;
      const tip = first ? `Current session, ${al.sessionLeft}% left` : use ? 'Session worth starting' : 'Spare session';
      return `<i class="slot ${use ? 'use' : 'spare'}${first ? ' now' : ''}" title="${esc(tip)}"></i>`;
    }).join('');
    const nFit = Math.floor(al.fit);
    return `<div class="possible ${al.level}" title="${esc(alertCopy(al).detail.replace(/|/g, ': '))}">
      <div class="possible-top"><span>${I.bell} ${nFit} session${nFit === 1 ? '' : 's'} fit before reset</span><button class="btn tiny" data-act="newSession" data-key="${esc(a.key)}" title="Start a new session with ${esc(a.label)}">Start</button></div>
      <div class="slots" role="img" aria-label="${total} sessions fit, ${need} needed to use the ${al.unused}% left">${boxes}</div>
      <div class="possible-foot">${need} to use the ${al.unused}% left · ${esc(alertCopy(al).title.toLowerCase())}</div>
    </div>`;
  }

  function renderUsage() {
    const a = selected();
    const body = $('#limits');
    $('#usage-head').innerHTML = '';
    if (!a) {
      body.innerHTML = '<p class="note">Add an account with the + button.</p>';
      return;
    }
    let html = '';
    if (a.status === 'signedOut') {
      html += `<p class="note">Not signed in yet. Its login and chats are kept in ${esc(a.configDir)}.</p>
        <button class="btn" data-act="signIn" data-key="${esc(a.key)}">Sign in to ${esc(a.label)}</button>`;
      body.innerHTML = html;
      return;
    }
    if (a.status === 'error') {
      body.innerHTML = '<p class="note">Claude Code was not found on this computer. Install Claude Code (the claude command), or set claudeAccounts.claudePath, then reload the window.</p>';
      return;
    }
    if (a.status === 'checking') {
      body.innerHTML = `${html}<p class="note">Checking sign-in…</p>`;
      return;
    }

    const u = a.usage;
    const lv = a.live || {};
    const relayOn = state.relay === 'on' || state.relay === 'chatTab';
    const isLiveNow = Boolean(u && u.live && Date.now() - u.fetchedAt < 30 * 60 * 1000);
    const ageTip =
      (relayOn
        ? 'Updates within a second of every Claude reply, and about every 5 minutes while this panel is open.'
        : state.relay === 'foreign'
          ? 'Reply-by-reply updates are off because another tool already wraps Claude (claudeCode.claudeProcessWrapper). Usage still refreshes about every 5 minutes while this panel is open.'
          : state.relay === 'unsupported'
            ? 'Updates about every 5 minutes while this panel is open, or when you press refresh.'
            : 'Reply-by-reply updates are off. Usage still refreshes about every 5 minutes while this panel is open.') +
      (lv.checkedAt ? `
Last asked Claude: ${new Date(lv.checkedAt).toLocaleTimeString()}` : '');
    // Freshness and refresh live in the section header, so the body is only the numbers.
    $('#usage-head').innerHTML = `${isLiveNow ? '<span class="live-dot" aria-label="live" title="Live"></span>' : ''}${u && u.fetchedAt ? `<span class="age" data-ago-short="${u.fetchedAt}" title="${esc(`Updated ${agoLong(u.fetchedAt)}. ${ageTip}`)}">${ago(u.fetchedAt)}</span>` : ''}<button class="icon-btn sync ${lv.checking ? 'spin' : ''}" data-act="refreshUsage" data-key="${esc(a.key)}" title="Check usage now" aria-label="Check usage now"${lv.checking ? ' disabled' : ''}>${I.sync}</button>`;
    if (lv.error) html += `<p class="note warn-note" title="${esc(lv.error)}">Could not refresh just now. Showing the last saved numbers.</p>`;
    if (!u) {
      html += `<p class="note">${lv.checking ? 'Asking Claude for usage…' : 'No usage yet. It appears after your first message with this account.'}</p>`;
    } else {
      const split = u.breakdown && u.breakdown.length ? `This week: ${u.breakdown.map((b) => `${b.name} ${b.percent}%`).join(', ')}` : '';
      html += meter('Session', u.session, 'session', 'The 5-hour limit');
      html += meter('Week', u.weekly, 'weekly', ['The 7-day limit', split].filter(Boolean).join('\n'));
      html += sessionsGraph(a);
      if (u.extra) {
        const pct = u.extra.percent != null ? u.extra.percent : u.extra.limit ? (u.extra.used / u.extra.limit) * 100 : 0;
        html += `<div class="meter">
          <div class="meter-top"><span class="ellipsis">Extra</span><span class="pct">${money(u.extra.used)}${u.extra.limit != null ? ` <span class="muted">of ${money(u.extra.limit)}</span>` : ''}</span></div>
          <div class="bar"><i style="width:${clamp(pct)}%"></i></div>
        </div>`;
      }
    }
    body.innerHTML = html;
  }

  // ---------- Model usage ----------

  function renderModels() {
    const body = $('#usage-more');
    const head = '<div class="cap">Share of tokens by model</div>';
    const h = historyOf(selected());
    if (!h || !h.models) {
      body.innerHTML = `${head}<p class="note">Counting…</p>`;
      return;
    }
    const inPeriod = new Map((h.models[state.period] || []).map((r) => [r.name, r]));
    // Every model ever used is listed, so a model you have not touched this week still shows (at 0%).
    const everUsed = h.models.all || [];
    const rows = [...inPeriod.values(), ...everUsed.filter((r) => !inPeriod.has(r.name)).map((r) => ({ name: r.name, replies: 0, input: 0, cacheRead: 0, output: 0, total: 0, idle: true }))];
    if (!rows.length) {
      body.innerHTML = `${head}<p class="note">No replies yet. Models you use will be listed here.</p>`;
      return;
    }
    const total = rows.reduce((s, r) => s + r.total, 0) || 1;
    body.innerHTML = head + rows
      .map((r) => {
        const pct = (r.total / total) * 100;
        const share = r.idle ? '0%' : pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
        const tip = r.idle
          ? `${r.name}
Not used in the ${PERIOD_LABEL[state.period]}`
          : `${r.name}, ${PERIOD_LABEL[state.period]}
Input: ${num(r.input)} tokens
Cache reads: ${num(r.cacheRead)} tokens
Output: ${num(r.output)} tokens`;
        return `<div class="meter ${r.idle ? 'idle' : ''}" title="${esc(tip)}">
          <div class="meter-top"><span class="ellipsis">${esc(r.name)}</span><span class="pct">${share}</span></div>
          <div class="bar"><i style="width:${clamp(pct)}%"></i></div>
          <div class="meter-foot">${r.idle ? `Not used in the ${PERIOD_LABEL[state.period]}` : `${num(r.replies)} replies · ${tokens(r.total)} tokens`}</div>
        </div>`;
      })
      .join('');
  }

  // ---------- Session manager ----------

  const isLive = (s) => Date.now() - s.mtimeMs < ACTIVE_MS;

  function highlight(text) {
    const needle = ui.q.trim().toLowerCase();
    if (!needle) return esc(text);
    const lower = text.toLowerCase();
    let out = '';
    let i = 0;
    let hit;
    while ((hit = lower.indexOf(needle, i)) !== -1) {
      out += esc(text.slice(i, hit)) + `<mark>${esc(text.slice(hit, hit + needle.length))}</mark>`;
      i = hit + needle.length;
    }
    return out + esc(text.slice(i));
  }

  function sessionRow(a, s, tag) {
    const tip = `${s.title}\nFolder: ${s.cwd || s.projectKey}\nLast active: ${new Date(s.mtimeMs).toLocaleString()}${tag ? `\nAccount: ${s.owners.join(', ')}` : ''}`;
    return `<div class="sess" role="listitem" tabindex="0" data-id="${esc(s.id)}" data-key="${esc(a.key)}" data-mtime="${s.mtimeMs}" title="${esc(tip)}"
        data-vscode-context="${ctx({ webviewSection: 'session', accountKey: a.key, sessionId: s.id })}">
      <span class="sdot ${isLive(s) ? 'live' : ''}"></span>
      <span class="stitle ellipsis">${highlight(s.title)}</span>
      ${tag ? ownerTags(s.owners) : ''}
      <span class="sfolder ellipsis">${esc(s.folder)}</span>
      <span class="sage" data-age="${s.mtimeMs}">${ago(s.mtimeMs)}</span>
      <span class="sactions">
        <button class="icon-btn" data-act="openTab" data-key="${esc(a.key)}" data-id="${esc(s.id)}" title="Open in its own tab" aria-label="Open in its own tab">${I.tab}</button>
        <button class="icon-btn" data-act="deleteChat" data-key="${esc(a.key)}" data-id="${esc(s.id)}" title="Delete chat (you can restore it from the trash)" aria-label="Delete chat">${I.trash}</button>
      </span>
    </div>`;
  }

  function renderSessions() {
    const a = selected();
    const list = $('#session-list');
    const all = ui.who === 'all';
    const many = accounts().length > 1;
    const tag = all && many; // in All, each row shows which accounts ran it

    $('#new-btn').title = a ? `Start a new session in a chat tab${many ? ` with ${a.label}` : ''}` : 'Start a new session';
    document.querySelectorAll('#kind button').forEach((b) => {
      const on = b.dataset.kind === ui.kind;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
    const sb = $('#scope-btn');
    sb.hidden = !many;
    sb.classList.toggle('on', all);
    sb.setAttribute('aria-pressed', String(all));
    sb.title = all ? `Showing every account. Click to show only ${a ? a.label : 'the selected account'}.` : 'Click to show chats and projects from every account';
    const noun = ui.kind === 'projects' ? 'Projects' : 'Chats';
    $('#scope-note').textContent = many ? (all ? `${noun} from all accounts` : a ? `${noun} with ${a.label}` : '') : '';
    $('#search').classList.toggle('has-q', Boolean(ui.q));
    q.placeholder = ui.kind === 'projects' ? 'Search projects' : 'Search chats';

    if (!a) {
      list.innerHTML = '<div class="empty">Add an account to see its chats.</div>';
      return;
    }
    const { list: chats, loading, unlinked } = chatsInScope();
    const unlinkedNote = !all && unlinked ? `<div class="unlinked">${unlinked} older chat${unlinked === 1 ? ' is' : 's are'} not linked to an account. <button class="link" data-act="whoAll">Show all</button></div>` : '';
    const projects = projectsOf(chats);
    $('#n-chats').textContent = chats.length ? String(chats.length) : '';
    $('#n-projects').textContent = projects.length ? String(projects.length) : '';
    $('#chats-note').textContent = '';
    if (!chats.length && loading) {
      list.innerHTML = '<div class="empty">Loading chats…</div>';
      return;
    }
    const needle = ui.q.trim().toLowerCase();

    if (ui.kind === 'projects') {
      list.classList.add('flat');
      list.innerHTML = projectsHtml(projects, needle, tag) + unlinkedNote;
      return;
    }

    let rows = chats;
    if (needle) rows = rows.filter((s) => s.title.toLowerCase().includes(needle) || s.folder.toLowerCase().includes(needle));

    if (!rows.length) {
      let msg;
      if (needle) msg = `No chats match “${esc(ui.q.trim())}”.`;
      else if (!all && many) msg = `No chats with ${esc(a.label)} yet. <button class="link" data-act="whoAll">Show all accounts</button>`;
      else msg = 'No chats yet. Start one with New session.';
      list.innerHTML = `<div class="empty">${msg}</div>${unlinkedNote}`;
      return;
    }

    let html = '';
    let more = 0; // rows not drawn yet (load as you scroll)
    if (!needle) {
      // Grouped by project: the open folder first, then the most recent. Groups fold, so a long
      // history stays a short list of project names; the open folder and the 3 latest start open.
      const byFolder = new Map();
      for (const s of rows) {
        const k = s.projectKey.toLowerCase();
        if (!byFolder.has(k)) byFolder.set(k, { k, name: s.folder, path: s.cwd || s.projectKey, current: k === state.workspaceKey, items: [] });
        byFolder.get(k).items.push(s);
      }
      const groups = [...byFolder.values()].sort((x, y) => Number(y.current) - Number(x.current));
      let budget = ui.limit;
      groups.forEach((f, i) => {
        const open = ui.fold[f.k] != null ? !ui.fold[f.k] : f.current || i < 3;
        html += `<button class="folder-head ${f.current ? 'current' : ''} ${open ? '' : 'folded'}" data-fold="${esc(f.k)}" title="${esc(f.path)}" aria-expanded="${open}">${I.chev}<span class="ellipsis">${esc(f.name)}</span>${f.current ? '<span class="badge">Open</span>' : ''}<span class="count">${f.items.length}</span></button>`;
        if (!open) return;
        const take = f.items.slice(0, Math.max(0, budget));
        budget -= take.length;
        more += f.items.length - take.length;
        html += take.map((s) => sessionRow(s.owner, s, tag)).join('');
      });
      list.classList.remove('flat');
    } else {
      const shown = rows.slice(0, ui.limit);
      more = rows.length - shown.length;
      html = shown.map((s) => sessionRow(s.owner, s, tag)).join('');
      list.classList.add('flat');
    }
    if (more > 0) html += `<button class="link more" data-act="more">Show ${Math.min(PAGE, more)} more of ${more}</button>`;
    list.innerHTML = html + unlinkedNote;
  }

  function renderUsageMore() {
    const open = Boolean(ui.details);
    $('#details').hidden = !open;
    $('#details-toggle').setAttribute('aria-expanded', String(open));
    $('#details-toggle').classList.toggle('open', open);
    if (!open) return;
    document.querySelectorAll('#utab button').forEach((b) => b.classList.toggle('on', b.dataset.utab === ui.utab));
    const sel = $('#details-range');
    sel.setAttribute('aria-label', ui.utab === 'models' ? 'Period' : 'Frame');
    sel.title = ui.utab === 'models' ? 'Period' : 'Show a week or a month at a time';
    const opts = ui.utab === 'models'
      ? [['5h', 'Last 5 hours'], ['7d', 'Last 7 days'], ['all', 'All time']].map(([v, l]) => [v, l, v === state.period])
      : [['week', 'Weekly'], ['month', 'Monthly']].map(([v, l]) => [v, l, v === ui.hspan]);
    const html = opts.map(([v, l, on]) => `<option value="${v}"${on ? ' selected' : ''}>${l}</option>`).join('');
    if (sel.innerHTML !== html) sel.innerHTML = html;
    sel.value = (opts.find((o) => o[2]) || opts[0])[0];
    if (ui.utab === 'models') renderModels();
    else renderWeekly();
  }

  // ---------- Render and live clocks ----------

  function applyClosed() {
    document.querySelectorAll('.sec').forEach((sec) => {
      const id = sec.id.slice(4);
      sec.classList.toggle('closed', !isOpen(id));
      sec.querySelector('.toggle').setAttribute('aria-expanded', String(isOpen(id)));
    });
  }

  /** A quiet one-line invitation at the very bottom. Appears only after the extension has helped for a while; hides on request. */
  function renderRate() {
    const el = $('#rate');
    el.hidden = !state.rate;
    if (!state.rate) return;
    el.innerHTML = `<span class="rate-text">Enjoying Claude Accounts?</span>
      <button class="rate-stars" data-act="rate" title="Rate it on the Marketplace (opens in your browser)" aria-label="Rate Claude Accounts, 5 stars"><span aria-hidden="true">&#9733;&#9733;&#9733;&#9733;&#9733;</span></button>
      <button class="icon-btn" data-act="hideRate" title="Hide this" aria-label="Hide this">${I.close}</button>`;
  }

  function render() {
    if (!state) return;
    renderRate();
    renderBanner();
    renderAccounts();
    renderSessions();
    renderUsage();
    renderUsageMore();
    applyClosed();
  }

  /** Updates times and "active" dots in place, without redrawing (keeps hover and focus). */
  function tick() {
    document.querySelectorAll('[data-age]').forEach((el) => (el.textContent = ago(Number(el.dataset.age))));
    document.querySelectorAll('[data-ago]').forEach((el) => (el.textContent = `Updated ${agoLong(Number(el.dataset.ago))}`));
    document.querySelectorAll('[data-reset]').forEach((el) => (el.textContent = resetText(el.dataset.reset)));
    document.querySelectorAll('[data-reset-short]').forEach((el) => (el.textContent = `resets ${resetShort(el.dataset.resetShort)}`));
    document.querySelectorAll('[data-left]').forEach((el) => (el.textContent = leftText(el.dataset.left)));
    document.querySelectorAll('[data-ago-short]').forEach((el) => (el.textContent = ago(Number(el.dataset.agoShort))));
    document.querySelectorAll('.sess').forEach((el) => {
      const dot = el.querySelector('.sdot');
      dot.classList.toggle('live', Date.now() - Number(el.dataset.mtime) < ACTIVE_MS);
    });
  }
  setInterval(tick, 1000);

  // ---------- Events ----------

  function act(el) {
    const a = selected();
    const key = el.dataset.key || (a && a.key);
    switch (el.dataset.act) {
      case 'add': return send('addAccount', { group: el.dataset.group });
      case 'openUsage': return send('openUsage', { key });
      case 'switch': return send('switch', { key });
      case 'signIn': return send('signIn', { key });
      case 'newSession': return send('newSession', { key });
      case 'refreshUsage': {
        el.classList.add('spin');
        el.disabled = true;
        return send('refreshUsage', { key });
      }
      case 'openTab': return send('openSession', { key, id: el.dataset.id, newTab: true });
      case 'deleteChat': return send('deleteChat', { key, id: el.dataset.id });
      case 'copyId': {
        send('copyId', { id: el.dataset.id });
        el.title = 'Copied';
        return;
      }
      case 'weekPrev':
        return goWeek(1);
      case 'weekNext':
        return goWeek(-1);
      case 'zoomIn':
        return setZoom((ui.zoom || 1) * 2);
      case 'zoomOut':
        return setZoom((ui.zoom || 1) / 2);
      case 'toggleDetails':
        ui.details = !ui.details;
        save();
        return renderUsageMore();
      case 'rate':
        return send('rate');
      case 'hideRate':
        state.rate = false;
        renderRate();
        return send('hideRate');
      case 'toggleScope':
        ui.who = ui.who === 'all' ? 'mine' : 'all';
        ui.limit = PAGE;
        break;
      case 'whoAll':
        ui.who = 'all';
        break;
      case 'clearQ':
        ui.q = '';
        q.value = '';
        q.focus();
        break;
      case 'more':
        ui.limit += PAGE;
        break;
      default:
        return;
    }
    save();
    renderSessions();
  }

  function selectAccount(key) {
    if (!state || state.selected === key) return;
    state.selected = key;
    ui.limit = PAGE;
    weekBack = 0; // the chart starts at this week for the new account
    chartAt = null;
    save();
    render();
    send('select', { key });
  }

  function openChat(row) {
    const key = row.dataset.key || (selected() && selected().key);
    if (key) send('openSession', { key, id: row.dataset.id });
  }

  // Using the panel at all asks the extension to refresh usage if it is due (at most every few seconds here, and rate limited there).
  let lastActivity = 0;
  document.addEventListener('pointerdown', () => {
    const now = Date.now();
    if (now - lastActivity < 5000) return;
    lastActivity = now;
    send('activity');
  }, { passive: true });

  document.addEventListener('click', (e) => {
    const fold = e.target.closest('[data-fold]');
    if (fold) {
      const k = fold.dataset.fold;
      ui.fold[k] = fold.getAttribute('aria-expanded') === 'true';
      save();
      return renderSessions();
    }
    const el = e.target.closest('[data-act], [data-toggle], [data-period], [data-range], [data-kind], [data-who], [data-utab], .acct, .sess, .proj');
    if (!el) return;
    if (el.dataset.act) return act(el);
    if (el.dataset.toggle) {
      const id = el.dataset.toggle;
      ui.open[id] = !ui.open[id];
      save();
      if (id.startsWith('g:')) renderAccounts();
      else applyClosed();
      return;
    }
    if (el.dataset.utab) {
      ui.utab = el.dataset.utab;
      save();
      return renderUsageMore();
    }
    if (el.dataset.period) {
      state.period = el.dataset.period;
      save();
      renderModels();
      return send('period', { period: el.dataset.period });
    }
    if (el.dataset.kind || el.dataset.who) {
      if (el.dataset.kind) ui.kind = el.dataset.kind;
      if (el.dataset.who) ui.who = el.dataset.who;
      ui.limit = PAGE;
      $('#session-list').scrollTop = 0;
      save();
      return renderSessions();
    }
    if (el.classList.contains('acct')) return selectAccount(el.dataset.key);
    if (el.classList.contains('sess')) return openChat(el);
    if (el.classList.contains('proj')) return send('openProject', { path: el.dataset.path });
  });

  // ---------- Reorder accounts (drag and drop, or Alt+Up / Alt+Down) ----------

  const accountKeys = () => accounts().map((a) => a.key);
  function moveAccount(dragKey, targetKey, after) {
    const keys = accountKeys().filter((k) => k !== dragKey);
    let i = targetKey ? keys.indexOf(targetKey) : keys.length;
    if (i < 0) return;
    if (after) i += 1;
    keys.splice(i, 0, dragKey);
    if (keys.join('|') === accountKeys().join('|')) return;
    const byKey = new Map(accounts().map((a) => [a.key, a]));
    state.groups[0].accounts = keys.map((k) => byKey.get(k));
    save();
    renderAccounts();
    send('reorder', { keys });
    const row = document.querySelector(`.acct[data-key="${CSS.escape(dragKey)}"]`);
    if (row) row.focus();
  }

  let dragKey = null;
  const clearMarks = () => document.querySelectorAll('.drop-before, .drop-after, .dragging').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'dragging'));
  document.addEventListener('dragstart', (e) => {
    const row = e.target.closest && e.target.closest('.acct');
    if (!row) return;
    dragKey = row.dataset.key;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragKey);
  });
  document.addEventListener('dragover', (e) => {
    const row = dragKey && e.target.closest && e.target.closest('.acct');
    if (!row) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    document.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
    if (row.dataset.key !== dragKey) row.classList.add(after ? 'drop-after' : 'drop-before');
  });
  document.addEventListener('drop', (e) => {
    const row = dragKey && e.target.closest && e.target.closest('.acct');
    if (!row) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    const key = dragKey;
    clearMarks();
    dragKey = null;
    if (row.dataset.key !== key) moveAccount(key, row.dataset.key, e.clientY > r.top + r.height / 2);
  });
  document.addEventListener('dragend', () => {
    dragKey = null;
    clearMarks();
  });

  document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && el.classList && el.classList.contains('acct')) {
      e.preventDefault();
      const keys = accountKeys();
      const i = keys.indexOf(el.dataset.key);
      const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
      if (j >= 0 && j < keys.length) moveAccount(el.dataset.key, keys[j], e.key === 'ArrowDown');
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && el.classList && (el.classList.contains('acct') || el.classList.contains('sess') || el.classList.contains('proj'))) {
      e.preventDefault();
      if (el.classList.contains('acct')) selectAccount(el.dataset.key);
      else if (el.classList.contains('proj')) send('openProject', { path: el.dataset.path });
      else openChat(el);
    }
    if (e.key === 'Escape' && el === q && q.value) {
      ui.q = '';
      q.value = '';
      save();
      renderSessions();
    }
  });

  $('#details-range').addEventListener('change', (e) => {
    const v = e.target.value;
    if (ui.utab === 'models') {
      state.period = v;
      save();
      renderModels();
      send('period', { period: v });
    } else {
      ui.hspan = v === 'month' ? 'month' : 'week';
      weekBack = 0; // a new frame size starts at the current one
      chartAt = null;
      save();
      renderWeekly();
    }
  });

  const listEl = $('#session-list');
  let listTimer;
  listEl.addEventListener('scroll', () => {
    document.documentElement.classList.add('scrolling');
    clearTimeout(listTimer);
    listTimer = setTimeout(() => document.documentElement.classList.remove('scrolling'), 900);
    hideTip();
    const more = listEl.querySelector('.more');
    if (more && listEl.scrollTop + listEl.clientHeight > listEl.scrollHeight - 80) {
      ui.limit += PAGE;
      save();
      renderSessions();
    }
  }, { passive: true });

  q.addEventListener('input', () => {
    ui.q = q.value;
    ui.limit = PAGE;
    listEl.scrollTop = 0;
    save();
    renderSessions();
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg && msg.type === 'state') {
      state = msg.state;
      save();
      render();
    } else if (msg && msg.type === 'focusSearch') {
      ui.open.sessions = true;
      applyClosed();
      q.focus();
      q.select();
    }
  });

  render();
  send('ready');
})();
