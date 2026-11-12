// Release-quality checks that are not about one feature: the manifest, the wording users read,
// accessibility of the markup we generate, account pictures, and robustness against bad input.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { LineReader, EventMapper } = require('../stream');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json'));
const ext = read('extension.js');
const chatHost = read('chat.js');
const panel = read('media/panel.js');
const chatView = read('media/chat.js');

// ---------- Manifest ----------

test('every command is declared once, titled uniquely and registered in the extension', () => {
  const cmds = pkg.contributes.commands;
  const ids = cmds.map((c) => c.command);
  assert.equal(new Set(ids).size, ids.length, 'duplicate command ids');
  const titles = cmds.map((c) => c.title);
  assert.equal(new Set(titles).size, titles.length, 'two commands share a title in the palette');
  for (const id of ids) assert.ok(ext.includes(`'${id}'`), `${id} is declared but never registered`);
  for (const c of cmds) assert.match(c.title, /^[A-Z]/, `${c.command} title should start with a capital`);
});

test('menus only use declared commands', () => {
  const ids = new Set(pkg.contributes.commands.map((c) => c.command));
  for (const [menu, items] of Object.entries(pkg.contributes.menus)) {
    for (const it of items) assert.ok(ids.has(it.command), `${menu} uses unknown command ${it.command}`);
  }
});

test('every setting the code reads is declared, with a description', () => {
  const props = (pkg.contributes.configuration.properties || pkg.contributes.configuration[0].properties);
  const used = new Set([...ext.matchAll(/cfg\(\)\.get\('([A-Za-z]+)'/g)].map((m) => `claudeAccounts.${m[1]}`));
  for (const k of used) assert.ok(props[k], `${k} is read but not declared in package.json`);
  for (const [k, v] of Object.entries(props)) {
    assert.ok(v.description && v.description.length > 20, `${k} needs a real description`);
    assert.ok('default' in v, `${k} needs a default`);
  }
});

test('marketplace essentials are present', () => {
  for (const f of ['name', 'displayName', 'description', 'version', 'publisher', 'license', 'icon', 'categories', 'keywords', 'engines']) {
    assert.ok(pkg[f], `package.json is missing ${f}`);
  }
  assert.ok(fs.existsSync(path.join(root, pkg.icon)), 'icon file is missing');
  for (const f of ['README.md', 'CHANGELOG.md', 'LICENSE']) assert.ok(fs.existsSync(path.join(root, f)), `${f} is missing`);
  assert.match(read('CHANGELOG.md'), new RegExp(`## ${pkg.version.replace(/\./g, '\\.')}`), 'CHANGELOG has no entry for this version');
  assert.ok(pkg.description.length <= 250, 'description is too long for the marketplace card');
});

// ---------- Wording ----------

const shipped = ['README.md', 'CHANGELOG.md', 'package.json', 'extension.js', 'chat.js', 'media/panel.js', 'media/chat.js', 'media/panel.css', 'media/chat.css'];

test('no long dashes anywhere users or maintainers read', () => {
  for (const f of shipped) assert.doesNotMatch(read(f), /[–—]/, `${f} contains an en or em dash`);
});

/** Every string passed to a notification call, with its button labels. */
function notifications(src) {
  const out = [];
  const re = /show(Information|Warning|Error)Message\(\s*([`'"])((?:\\.|(?!\2)[^\\])*)\2/g;
  for (const m of src.matchAll(re)) out.push({ kind: m[1], text: m[3] });
  return out;
}
function buttons(src) {
  const out = [];
  for (const m of src.matchAll(/show(?:Information|Warning|Error)Message\([\s\S]*?\)(?:\.then|;|\s*\n)/g)) {
    for (const b of m[0].matchAll(/,\s*['"]([A-Z][A-Za-z' ]{2,20})['"]/g)) out.push(b[1]);
  }
  return out;
}

test('notifications read as complete, plain sentences', () => {
  const list = [...notifications(ext), ...notifications(chatHost)];
  assert.ok(list.length > 15, 'expected to find the notifications');
  for (const { text } of list) {
    const flat = text.replace(/\$\{[^}]*\}/g, 'X');
    // A sentence, or a sentence that ends with a detail filled in at run time (shown as X).
    assert.match(flat, /[.?:X]$|[.?]"$|\)\.$/, `should end like a sentence or a detail: ${text}`);
    assert.ok(flat.length <= 200, `too long for a notification (${flat.length}): ${text}`);
    assert.doesNotMatch(flat, /\b(undefined|null|NaN|TODO|e\.message)\b/, `leaks internals: ${text}`);
    assert.doesNotMatch(flat, /!!|\?\?/, `shouting: ${text}`);
  }
});

test('notification buttons use Title Case, short verbs', () => {
  const labels = [...new Set(buttons(ext))];
  assert.ok(labels.length >= 6, `expected buttons, found ${labels.join(', ')}`);
  for (const l of labels) {
    assert.match(l, /^[A-Z][a-z']*( [A-Z][a-z']*)*$/, `button "${l}" should be Title Case`);
    assert.ok(l.split(' ').length <= 3, `button "${l}" is too long`);
  }
  assert.ok(!labels.includes('Sign in'), 'use "Sign In" everywhere');
});

test('the panel no longer mentions things that were removed', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /card appears at the top/i);
  assert.doesNotMatch(panel, /data-act="openUsage"/, 'claude.ai button was removed from the panel');
  assert.doesNotMatch(panel, /activeOnly|toggleActive/, 'the Active filter was removed');
});

// ---------- Accessibility of generated markup ----------

/** Buttons with no visible text must carry a label. */
function unlabeledButtons(src) {
  const bad = [];
  for (const m of src.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const attrs = m[1];
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\$\{\s*I\.\w+\s*\}/g, '').replace(/\$\{[^}]*\}/g, 'x').trim();
    if (!text && !/aria-label=|title=/.test(attrs)) bad.push(m[0].slice(0, 90));
  }
  return bad;
}

test('icon-only buttons have an accessible name', () => {
  assert.deepEqual(unlabeledButtons(panel), []);
  assert.deepEqual(unlabeledButtons(chatView), []);
});

test('icon buttons in the chat tab have aria-label, not only a tooltip', () => {
  for (const m of chatView.matchAll(/<button class="icon-btn"[^>]*>/g)) assert.match(m[0], /aria-label=/, m[0]);
});

test('motion and focus are handled in the stylesheets', () => {
  for (const f of ['media/panel.css', 'media/chat.css']) {
    const css = read(f);
    assert.match(css, /prefers-reduced-motion/, `${f} ignores reduced motion`);
    assert.match(css, /:focus/, `${f} has no focus styles`);
  }
});

test('colors come from the VS Code theme, not fixed hex values', () => {
  const css = read('media/panel.css') + read('media/chat.css');
  const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  // fallbacks inside var(--vscode-..., #xxx) are fine; count only bare hex values outside var()
  const bare = css.split('\n').filter((l) => /#[0-9a-fA-F]{3,8}\b/.test(l) && !/var\(--vscode-[^)]*#|fallback/i.test(l) && !/--[a-z-]+:\s*#/.test(l) && !/^\s*\/\*/.test(l));
  assert.ok(bare.length <= 8, `too many hard coded colors (${bare.length} of ${hex.length}):\n${bare.slice(0, 6).join('\n')}`);
});

// ---------- Account pictures ----------

function loadAvatarTexts() {
  const a = panel.indexOf('function avatarTexts');
  const b = panel.indexOf('const avatarText =');
  assert.ok(a > 0 && b > a, 'avatarTexts not found');
  return new Function(`${panel.slice(a, b)}; return avatarTexts;`)();
}

test('account pictures: unique names get one letter', () => {
  const av = loadAvatarTexts();
  assert.deepEqual(av(['Kira', 'Alex', 'Sam']), ['K', 'A', 'S']);
  assert.deepEqual(av(['Work']), ['W']);
});

test('account pictures: clashing initials get more letters, identical names get numbers', () => {
  const av = loadAvatarTexts();
  assert.deepEqual(av(['Kaya', 'Karan']), ['KAY', 'KAR']);
  assert.deepEqual(av(['Work', 'Work']), ['W', 'W2']);
  assert.deepEqual(av(['Personal Pro', 'Personal Team']), ['PP', 'PT']);
});

test('account pictures: never two different accounts alike (random names)', () => {
  const av = loadAvatarTexts();
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const pool = ['Kaya', 'Karan', 'Kavya', 'Work', 'Personal', 'Pro', 'Team', 'Abhishek', 'Anil', 'Alpha', 'Beta', 'Bob', 'ACME Ltd', 'ACME Inc', 'x', 'X Y', 'X Z'];
  for (let run = 0; run < 200; run += 1) {
    const names = [...new Set(Array.from({ length: 2 + rnd(6) }, () => pool[rnd(pool.length)]))];
    const texts = av(names);
    assert.equal(new Set(texts).size, names.length, `clash for ${names.join(', ')}: ${texts.join(', ')}`);
    for (const t of texts) assert.ok(t.length >= 1 && t.length <= 4);
  }
  assert.deepEqual(av(['', ' ']).length, 2); // blank names do not crash
});

// ---------- Robustness ----------

test('stream parser survives garbage, huge lines and every event shape', () => {
  const r = new LineReader();
  const m = new EventMapper();
  const junk = ['', '{', '[]', 'null', '{"type":1}', '{"type":"stream_event"}', '{"type":"stream_event","event":{"type":"content_block_delta"}}', '{"type":"assistant","message":null}', '{"type":"user","message":{"content":"x"}}', '{"type":"control_request"}', '{"type":"rate_limit_event"}', '\u0000\u0001', 'x'.repeat(200000)];
  for (const line of junk) {
    assert.doesNotThrow(() => {
      for (const obj of r.push(`${line}\n`)) m.map(obj);
    }, line.slice(0, 40));
  }
});

test('stream parser handles a long chat quickly', () => {
  const r = new LineReader();
  const m = new EventMapper();
  const line = JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'hello world '.repeat(20) }] } });
  const start = Date.now();
  let n = 0;
  for (let i = 0; i < 20000; i += 1) for (const o of r.push(`${line}\n`)) n += m.map(o).length;
  assert.ok(n > 0);
  assert.ok(Date.now() - start < 3000, 'parsing 20,000 lines took too long');
});

// ---------- Listing media ----------

test('README images all exist, and animations stay a reasonable size', () => {
  const readme = read('README.md');
  const urls = [...readme.matchAll(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/(docs\/media\/[A-Za-z0-9._-]+)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 5, 'the README should show screenshots and animations');
  for (const rel of new Set(urls)) {
    const file = path.join(root, rel);
    assert.ok(fs.existsSync(file), `${rel} is referenced but missing`);
    assert.ok(fs.statSync(file).size < 6 * 1024 * 1024, `${rel} is over 6 MB`);
  }
  for (const m of readme.matchAll(/<img [^>]*>/g)) assert.match(m[0], /alt="[^"]{12,}"/, `image needs a real alt text: ${m[0].slice(0, 60)}`);
});

test('repository links are present and the packaged extension leaves out the capture tools', () => {
  assert.match(pkg.repository.url, /github\.com\/abhi-0404\/claude-accounts/);
  assert.ok(pkg.bugs && pkg.homepage);
  const ignore = read('.vscodeignore');
  for (const p of ['docs/**', 'scripts/**', 'test/**']) assert.ok(ignore.includes(p), `${p} should not ship in the extension`);
});

test('demo data used for the media is fictional', () => {
  const demo = read('scripts/capture/demo-data.js');
  assert.match(demo, /\.example/);
  assert.doesNotMatch(demo, /@(gmail|outlook|hotmail|yahoo|example|ds\.study)/i);
});

test('one accent colour: no chart or git colours, and the accent is defined once per stylesheet', () => {
  for (const f of ['media/panel.css', 'media/chat.css']) {
    const css = read(f);
    assert.doesNotMatch(css, /--vscode-charts-|--vscode-gitDecoration-|--vscode-testing-iconPassed/, `${f} uses an extra colour`);
    assert.match(css, /--accent: var\(--vscode-focusBorder/, `${f} defines the accent`);
  }
});

test('every visible colour comes from the VS Code theme (three roles: text, accent, error)', () => {
  for (const f of ['media/panel.css', 'media/chat.css']) {
    const bare = read(f)
      .split('\n')
      .filter((l) => !/^\s*\/?\*/.test(l) && !/mask-image/.test(l))
      .map((l) => l.replace(/var\(--vscode-[\w-]+,\s*(var\(--vscode-[\w-]+,\s*)?(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))\)?\)/g, ''))
      .filter((l) => /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(l));
    assert.deepEqual(bare, [], `${f} has colours that are not from the theme`);
  }
});

test('accounts are ordered by the soonest weekly reset, then by less limit left, unless you chose your own order', () => {
  const a = panel.indexOf('function orderedAccounts');
  const b = panel.indexOf('function renderAccounts');
  assert.ok(a > 0 && b > a, 'orderedAccounts not found');
  const fn = new Function('ui', `${panel.slice(a, b)}; return orderedAccounts;`);
  const H = 3600e3;
  const at = (h) => new Date(Date.now() + h * H).toISOString();
  const acct = (label, weekly, resetH, status = 'signedIn') => ({ label, status, usage: weekly == null ? null : { weekly: { percent: weekly, resetsAt: resetH == null ? null : at(resetH) } } });
  const list = [acct('Four', 10, 96), acct('One', 80, 24), acct('Out', null, null, 'signedOut'), acct('Two', 30, 24), acct('Nine', 50, 9), acct('NoReset', 20, null)];
  const byReset = fn({ sortAccounts: 'reset' })(list).map((x) => x.label);
  assert.deepEqual(byReset, ['Nine', 'One', 'Two', 'Four', 'Out', 'NoReset'], 'soonest reset first; same reset: less left first; unknown last in your order');
  assert.deepEqual(fn({ sortAccounts: 'manual' })(list).map((x) => x.label), list.map((x) => x.label), 'your own order is untouched');
});
