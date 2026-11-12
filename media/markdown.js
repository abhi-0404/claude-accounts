// Small markdown renderer for the chat tab: enough for Claude's replies, no dependencies.
// Everything is escaped first, so model text can never inject HTML.
(function (root) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const safeUrl = (u) => (/^(https?:|mailto:)/i.test(u) ? u : '');

  /** Inline marks: code, bold, italic, strike, links. Code spans are kept apart so marks inside stay literal. */
  function inline(text) {
    const codes = [];
    let s = String(text).replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => {
      codes.push(`<code>${esc(code.trim())}</code>`);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = esc(s);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, label, url) => {
      const u = safeUrl(url.replace(/&amp;/g, '&'));
      return u ? `<a href="${esc(u)}" title="${esc(u)}">${label}</a>` : label;
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (m, pre, url) => `${pre}<a href="${url}">${url}</a>`);
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
  }

  const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

  /**
   * Renders markdown to HTML. Code blocks get a header with the language and a copy button
   * (data-copy holds the index into `out.codes`, which the caller reads for the copy text).
   */
  function render(src, out) {
    const codes = (out && out.codes) || [];
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    let html = '';
    let i = 0;
    let para = [];
    const flush = () => {
      if (para.length) html += `<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`;
      para = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/);
      if (fence) {
        flush();
        const close = new RegExp(`^\\s*${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
        const body = [];
        i += 1;
        while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
        const open = i >= lines.length; // still streaming
        i += 1;
        const code = body.join('\n');
        codes.push(code);
        html += `<div class="code${open ? ' open' : ''}"><div class="code-head"><span>${esc(fence[2] || 'text')}</span><button class="code-copy" data-copy="${codes.length - 1}" title="Copy">Copy</button></div><pre><code>${esc(code)}</code></pre></div>`;
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) {
        flush();
        const level = Math.min(6, h[1].length + 1); // h1 in a reply is too loud; start at h2
        html += `<h${level}>${inline(h[2])}</h${level}>`;
        i += 1;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flush();
        html += '<hr>';
        i += 1;
        continue;
      }
      if (/^\s*>/.test(line)) {
        flush();
        const body = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
        html += `<blockquote>${render(body.join('\n'), { codes })}</blockquote>`;
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flush();
        const head = cells(line);
        const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
        const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</${tag}>`;
        html += `<div class="table"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, k) => td('td', r[k] || '', k)).join('')}</tr>`)
          .join('')}</tbody></table></div>`;
        continue;
      }
      const li = line.match(listItem);
      if (li) {
        flush();
        html += list(lines, i, (next) => (i = next), codes);
        continue;
      }
      if (!line.trim()) {
        flush();
        i += 1;
        continue;
      }
      para.push(line);
      i += 1;
    }
    flush();
    return html;
  }

  /** A list starting at line `start`; nested lists are items indented further. */
  function list(lines, start, setNext, codes) {
    const first = lines[start].match(listItem);
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const startNum = ordered ? parseInt(first[2], 10) : 1;
    let i = start;
    const items = [];
    while (i < lines.length) {
      const m = lines[i].match(listItem);
      if (m && m[1].length === indent && /\d/.test(m[2]) === ordered) {
        const task = m[3].match(/^\[([ xX])\]\s+(.*)$/);
        items.push({ text: [task ? task[2] : m[3]], task: task ? task[1] !== ' ' : null });
        i += 1;
        continue;
      }
      if (m && m[1].length > indent) {
        const cur = items[items.length - 1];
        cur.sub = (cur.sub || '') + list(lines, i, (n) => (i = n), codes);
        continue;
      }
      if (!m && lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
        items[items.length - 1].text.push(lines[i].trim());
        i += 1;
        continue;
      }
      break;
    }
    setNext(i);
    const tag = ordered ? 'ol' : 'ul';
    const attr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
    return `<${tag}${attr}>${items
      .map((it) => `<li${it.task != null ? ' class="task"' : ''}>${it.task != null ? `<input type="checkbox" disabled${it.task ? ' checked' : ''}> ` : ''}${inline(it.text.join(' '))}${it.sub || ''}</li>`)
      .join('')}</${tag}>`;
  }

  const api = { render, inline, esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.md = api;
})(this);
