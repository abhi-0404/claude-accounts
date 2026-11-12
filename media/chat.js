// Claude Accounts chat tab (runs inside the web view). Talks to chat.js in the extension.
(function () {
  const vscode = acquireVsCodeApi();
  const { render: renderMd, esc } = window.md;
  const send = (type, extra) => vscode.postMessage(Object.assign({ type }, extra || {}));
  const $ = (sel, el) => (el || document).querySelector(sel);

  const svg = (body) => `<svg viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
  const I = {
    chev: svg('<path d="M6 4l4 4-4 4"/>'),
    send: svg('<path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/>'),
    stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" class="solid"/></svg>',
    file: svg('<path d="M4 1.5h5l3.5 3.5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5z"/><path d="M9 1.5V5h3.5"/>'),
    sel: svg('<path d="M2.5 4h11M2.5 8h7M2.5 12h9"/>'),
    close: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
    shield: svg('<path d="M8 1.5l5.5 2v4c0 3.3-2.3 5.9-5.5 7-3.2-1.1-5.5-3.7-5.5-7v-4z"/>'),
  };

  const ui = { busy: false, attachments: [], blocks: new Map(), tools: new Map(), started: 0 };
  const saved = vscode.getState() || {};
  let draft = saved.draft || '';

  document.body.innerHTML = `
    <main id="scroll">
      <div id="log" class="log" role="log" aria-live="polite"></div>
    </main>
    <footer class="composer-wrap">
      <div id="working" class="working" hidden><span class="spinner" aria-hidden="true"></span><span id="working-text">Working</span><span id="elapsed" class="muted"></span></div>
      <div class="composer" id="composer">
        <div id="chips" class="chips"></div>
        <textarea id="input" rows="1" placeholder="Ask Claude. Enter sends, Shift+Enter adds a line." aria-label="Message Claude" spellcheck="true"></textarea>
        <div class="bar">
          <button class="icon-btn" data-act="attachFile" title="Attach the open file" aria-label="Attach the open file">${I.file}</button>
          <button class="icon-btn" data-act="attachSel" title="Attach the selected lines" aria-label="Attach the selected lines">${I.sel}</button>
          <select id="model" class="pick" title="Model" aria-label="Model"><option value="default">Default model</option></select>
          <select id="mode" class="pick" title="Choose whether Claude asks before editing files" aria-label="Permission mode">
            <option value="default">Ask before edits</option>
            <option value="acceptEdits">Edit without asking</option>
          </select>
          <span class="spacer"></span>
          <span id="who" class="who muted ellipsis"></span>
          <button id="go" class="go" data-act="go" title="Send (Enter)" aria-label="Send">${I.send}</button>
        </div>
      </div>
    </footer>`;

  const log = $('#log');
  const scroller = $('#scroll');
  const input = $('#input');
  input.value = draft;

  // ---------- Scrolling: follow the reply only while you are at the bottom ----------

  let stick = true;
  scroller.addEventListener('scroll', () => {
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
  }, { passive: true });
  let scrollQueued = false;
  function follow() {
    if (!stick || scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      scroller.scrollTop = scroller.scrollHeight;
    });
  }

  // ---------- Building the log ----------

  function add(html, cls) {
    const el = document.createElement('div');
    el.className = cls;
    el.innerHTML = html;
    $('.empty', log)?.remove();
    log.appendChild(el);
    follow();
    return el;
  }

  function userRow(text, chips) {
    const chipHtml = (chips || []).map((c) => `<span class="chip small">${esc(c)}</span>`).join('');
    add(`${chipHtml ? `<div class="chips">${chipHtml}</div>` : ''}<div class="utext">${esc(text)}</div>`, 'msg user');
  }

  // Text blocks re-render their markdown at most once per frame while streaming.
  const dirty = new Set();
  let paintQueued = false;
  function paint() {
    paintQueued = false;
    for (const b of dirty) {
      if (b.kind === 'thinking') $('.think-body', b.el).textContent = b.text;
      else {
        const codes = [];
        b.el.innerHTML = renderMd(b.text, { codes });
        b.el.codes = codes; // copy buttons read their code from here
      }
    }
    dirty.clear();
    follow();
  }
  function markDirty(b) {
    dirty.add(b);
    if (!paintQueued) {
      paintQueued = true;
      requestAnimationFrame(paint);
    }
  }

  function startBlock(id, kind) {
    const el =
      kind === 'thinking'
        ? add(`<button class="row-head" data-toggle>${I.chev}<span class="row-name">Thinking</span></button><div class="think-body row-body"></div>`, 'row thinking collapsed')
        : add('', 'msg md');
    ui.blocks.set(id, { el, kind, text: '' });
  }

  function delta(id, text) {
    const b = ui.blocks.get(id);
    if (!b) return;
    b.text += text;
    markDirty(b);
  }

  const toolSummary = (name, i) => {
    i = i || {};
    const base = (p) => String(p || '').split(/[\\/]/).pop();
    if (name === 'Bash' || name === 'PowerShell') return i.description || i.command || '';
    if (i.file_path || i.notebook_path) return base(i.file_path || i.notebook_path);
    if (i.pattern) return i.pattern;
    if (i.url) return i.url;
    if (i.query) return i.query;
    if (i.description) return i.description;
    if (Array.isArray(i.todos)) return `${i.todos.length} items`;
    const first = Object.values(i).find((v) => typeof v === 'string');
    return first ? first.slice(0, 80) : '';
  };

  /** The readable part of a tool's input: the command, the edit, or plain JSON. */
  function toolInput(name, i) {
    i = i || {};
    if ((name === 'Bash' || name === 'PowerShell') && i.command) return `<pre class="cmd">${esc(i.command)}</pre>`;
    if (name === 'Edit' && (i.old_string != null || i.new_string != null)) {
      const lines = (s, sign) => String(s || '').split('\n').map((l) => `<span class="${sign === '-' ? 'del' : 'ins'}">${sign} ${esc(l)}</span>`).join('\n');
      return `<pre class="diff">${lines(i.old_string, '-')}\n${lines(i.new_string, '+')}</pre>`;
    }
    if (name === 'Write' && i.content != null) return `<pre>${esc(String(i.content).slice(0, 3000))}</pre>`;
    if (name === 'TodoWrite' && Array.isArray(i.todos)) {
      return `<ul class="todos">${i.todos.map((t) => `<li class="${esc(t.status)}">${t.status === 'completed' ? '&#10003;' : t.status === 'in_progress' ? '&#9675;' : '&#183;'} ${esc(t.content)}</li>`).join('')}</ul>`;
    }
    const keys = Object.keys(i);
    if (!keys.length) return '';
    return `<pre>${esc(JSON.stringify(i, null, 2))}</pre>`;
  }

  const fileOf = (i) => (i && (i.file_path || i.notebook_path)) || '';

  function toolRow(id, name, input) {
    const file = fileOf(input);
    const summary = toolSummary(name, input);
    const el = add(
      `<button class="row-head" data-toggle>${I.chev}<span class="dot run" aria-label="running"></span><span class="row-name">${esc(name)}</span>${
        file ? `<a class="row-sum file" data-open="${esc(file)}" title="${esc(file)}">${esc(summary)}</a>` : `<span class="row-sum ellipsis" title="${esc(summary)}">${esc(summary)}</span>`
      }</button><div class="row-body"><div class="tool-in">${toolInput(name, input)}</div><div class="tool-out"></div></div>`,
      'row tool collapsed'
    );
    ui.tools.set(id, el);
    if (name === 'TodoWrite') el.classList.remove('collapsed');
  }

  function toolResult(id, text, isError) {
    const el = ui.tools.get(id);
    if (!el) return;
    const dot = $('.dot', el);
    dot.className = `dot ${isError ? 'err' : 'ok'}`;
    dot.setAttribute('aria-label', isError ? 'failed' : 'done');
    if (text && text.trim()) $('.tool-out', el).innerHTML = `<pre class="${isError ? 'errtext' : ''}">${esc(text)}</pre>`;
    if (isError) el.classList.add('failed');
  }

  function permissionCard(ev) {
    const el = add(
      `<div class="perm-head">${I.shield}<span>Allow Claude to use <b>${esc(ev.tool)}</b>${ev.description ? `: <span class="muted">${esc(ev.description)}</span>` : ''}?</span></div>
       <div class="perm-body">${toolInput(ev.toolName || ev.tool, ev.input)}</div>
       <div class="perm-actions">
         <button class="btn primary" data-perm="allow">Allow</button>
         ${ev.suggestions && ev.suggestions.length ? `<button class="btn" data-perm="always" title="${esc(suggestionText(ev.suggestions))}">Always allow</button>` : ''}
         <button class="btn" data-perm="deny">Deny</button>
         <input class="perm-note" type="text" placeholder="or tell Claude what to do instead" aria-label="Tell Claude what to do instead">
       </div>`,
      'perm'
    );
    el.dataset.request = ev.requestId;
    $('.btn.primary', el).focus({ preventScroll: true });
  }

  function suggestionText(list) {
    return list
      .map((s) => {
        if (s.type === 'setMode') return s.mode === 'acceptEdits' ? 'Auto-accept edits for this chat' : `Switch to ${s.mode} mode`;
        if (s.type === 'addRules' && Array.isArray(s.rules)) return `Allow ${s.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(', ')}${s.destination === 'session' ? ' for this chat' : ''}`;
        return 'Remember this choice';
      })
      .join('\n');
  }

  function settle(requestId, decision) {
    const el = log.querySelector(`.perm[data-request="${CSS.escape(requestId)}"]`);
    if (!el) return;
    el.classList.add('answered');
    $('.perm-actions', el).innerHTML = `<span class="muted">${decision === 'deny' ? 'Denied' : decision === 'always' ? 'Always allowed' : decision === 'cancel' ? 'No longer needed' : 'Allowed'}</span>`;
    if (decision === 'mode') $('#mode').value = 'acceptEdits';
  }

  function note(text, cls) {
    add(esc(text), `note ${cls || ''}`);
  }

  function doneRow(ev) {
    const parts = [];
    if (ev.durationMs != null) parts.push(ev.durationMs < 60000 ? `${(ev.durationMs / 1000).toFixed(1)}s` : `${Math.floor(ev.durationMs / 60000)}m ${Math.round((ev.durationMs % 60000) / 1000)}s`);
    if (ev.cost != null) parts.push(`$${ev.cost < 0.01 ? ev.cost.toFixed(4) : ev.cost.toFixed(2)}`);
    if (!ev.ok && ev.text) note(ev.text, 'error');
    if (parts.length) add(esc(parts.join(' · ')), 'done');
  }

  function onEvent(ev) {
    switch (ev.t) {
      case 'user': return userRow(ev.text);
      case 'block': return startBlock(ev.id, ev.kind);
      case 'delta': return delta(ev.id, ev.text);
      case 'tool': return toolRow(ev.id, ev.name, ev.input);
      case 'toolResult': return toolResult(ev.id, ev.text, ev.isError);
      case 'permission': return permissionCard(ev);
      case 'permissionCancel': return settle(ev.requestId, 'cancel');
      case 'note': return note(ev.text);
      case 'status':
        $('#working-text').textContent = ev.status === 'compacting' ? 'Compacting' : 'Working';
        return undefined;
      case 'done': return doneRow(ev);
      default: return undefined;
    }
  }

  // ---------- State from the extension ----------

  function setBusy(busy) {
    ui.busy = busy;
    const go = $('#go');
    go.classList.toggle('stop', busy);
    go.innerHTML = busy ? I.stop : I.send;
    go.title = busy ? 'Stop (Esc)' : 'Send (Enter)';
    go.setAttribute('aria-label', busy ? 'Stop' : 'Send');
    $('#working').hidden = !busy;
    if (busy) {
      ui.started = Date.now();
      $('#working-text').textContent = 'Working';
    }
    // Anything still running when a turn ends will not finish: mark it.
    if (!busy) log.querySelectorAll('.dot.run').forEach((d) => (d.className = 'dot idle'));
  }
  setInterval(() => {
    if (ui.busy) $('#elapsed').textContent = `${Math.floor((Date.now() - ui.started) / 1000)}s`;
  }, 500);

  function setModels(models, model) {
    const sel = $('#model');
    const list = models && models.length ? models : [{ value: 'default', label: 'Default model' }];
    sel.innerHTML = list.map((m) => `<option value="${esc(m.value)}" title="${esc(m.description || '')}">${esc(m.label)}</option>`).join('');
    if (model && !list.some((m) => m.value === model)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(model)}">${esc(model)}</option>`);
    sel.value = model || 'default';
  }

  function setup(m) {
    log.innerHTML = '';
    ui.blocks.clear();
    ui.tools.clear();
    for (const ev of m.history || []) onEvent(ev);
    paint();
    if (!(m.history || []).length) {
      add(`<div class="empty-title">What should we work on?</div><div class="muted">in ${esc(m.folder)}${m.account ? ` with ${esc(m.account)}` : ''}</div>`, 'empty');
    }
    setModels(m.models, m.model);
    $('#mode').value = m.mode === 'acceptEdits' ? 'acceptEdits' : 'default';
    $('#who').textContent = m.account || '';
    $('#who').title = `${m.cwd}${m.account ? `\nAccount: ${m.account}` : ''}`;
    setBusy(Boolean(m.busy));
    stick = true;
    follow();
    input.focus();
  }

  function handle(m) {
    switch (m.type) {
      case 'setup': return setup(m);
      case 'event': return onEvent(m.ev);
      case 'busy': return setBusy(m.busy);
      case 'models': return setModels(m.models, m.model);
      case 'answered': return settle(m.requestId, m.decision);
      case 'attached':
        ui.attachments.push(m.item);
        return drawChips();
      case 'error': return note(m.text, 'error');
      case 'toast': return note(m.text);
      default: return undefined;
    }
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'batch') m.items.forEach(handle);
    else handle(m);
  });

  // ---------- Composer ----------

  function drawChips() {
    $('#chips').innerHTML = ui.attachments
      .map((a, i) => `<span class="chip">${esc(a.label)}<button class="chip-x" data-unattach="${i}" title="Remove" aria-label="Remove ${esc(a.label)}">${I.close}</button></span>`)
      .join('');
  }

  function grow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
  }

  function submit() {
    const text = input.value.trim();
    if (!text && !ui.attachments.length) return;
    userRow(text, ui.attachments.map((a) => a.label));
    send('send', { text, attachments: ui.attachments });
    ui.attachments = [];
    drawChips();
    input.value = '';
    vscode.setState({ draft: '' });
    grow();
    stick = true;
    follow();
  }

  input.addEventListener('input', () => {
    grow();
    vscode.setState({ draft: input.value });
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.busy) {
      e.preventDefault();
      send('stop');
    }
  });

  $('#model').addEventListener('change', (e) => send('model', { model: e.target.value }));
  $('#mode').addEventListener('change', (e) => send('mode', { mode: e.target.value }));

  document.addEventListener('click', (e) => {
    const t = e.target;
    const open = t.closest('[data-open]');
    if (open) {
      e.stopPropagation();
      return send('openFile', { path: open.dataset.open });
    }
    const copy = t.closest('[data-copy]');
    if (copy) {
      const owner = copy.closest('.md');
      send('copy', { text: (owner && owner.codes && owner.codes[Number(copy.dataset.copy)]) || '' });
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1200);
      return undefined;
    }
    const tog = t.closest('[data-toggle]');
    if (tog) return tog.parentElement.classList.toggle('collapsed');
    const perm = t.closest('[data-perm]');
    if (perm) {
      const card = perm.closest('.perm');
      const noteText = $('.perm-note', card).value.trim();
      const decision = perm.dataset.perm === 'deny' || noteText ? 'deny' : perm.dataset.perm;
      return send('permission', { requestId: card.dataset.request, decision, note: noteText || undefined });
    }
    const un = t.closest('[data-unattach]');
    if (un) {
      ui.attachments.splice(Number(un.dataset.unattach), 1);
      drawChips();
      return input.focus();
    }
    const act = t.closest('[data-act]');
    if (!act) return undefined;
    if (act.dataset.act === 'go') return ui.busy && !input.value.trim() ? send('stop') : submit();
    if (act.dataset.act === 'attachFile') return send('attach', { what: 'file' });
    if (act.dataset.act === 'attachSel') return send('attach', { what: 'selection' });
    return undefined;
  });

  // Enter in a permission note denies with that note.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('perm-note') && e.target.value.trim()) {
      const card = e.target.closest('.perm');
      send('permission', { requestId: card.dataset.request, decision: 'deny', note: e.target.value.trim() });
    }
  });

  grow();
  send('ready');
})();
