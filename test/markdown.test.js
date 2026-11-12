const test = require('node:test');
const assert = require('node:assert/strict');
const { render, inline } = require('../media/markdown');

test('escapes HTML so model text cannot inject markup', () => {
  assert.equal(render('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  assert.doesNotMatch(inline('[x](javascript:alert(1))'), /<a/);
});

test('inline marks', () => {
  assert.equal(inline('**b** and *i* and `a*b*`'), '<strong>b</strong> and <em>i</em> and <code>a*b*</code>');
  assert.equal(inline('[docs](https://x.dev/a?b=1&c=2)'), '<a href="https://x.dev/a?b=1&amp;c=2" title="https://x.dev/a?b=1&amp;c=2">docs</a>');
  assert.equal(inline('see https://x.dev.'), 'see <a href="https://x.dev">https://x.dev</a>.');
  assert.equal(inline('snake_case_name'), 'snake_case_name');
});

test('code blocks keep their text and report it for copying', () => {
  const out = { codes: [] };
  const html = render('Run:\n```js\nconst a = 1 < 2;\n```\nok', out);
  assert.match(html, /<span>js<\/span>/);
  assert.match(html, /const a = 1 &lt; 2;/);
  assert.deepEqual(out.codes, ['const a = 1 < 2;']);
  assert.match(render('```\nstill typing'), /class="code open"/);
});

test('headings, lists, quotes, tables and rules', () => {
  assert.equal(render('# Title'), '<h2>Title</h2>');
  assert.equal(render('- a\n- b\n  - c\n- d'), '<ul><li>a</li><li>b<ul><li>c</li></ul></li><li>d</li></ul>');
  assert.equal(render('3. x\n4. y'), '<ol start="3"><li>x</li><li>y</li></ol>');
  assert.match(render('- [x] done'), /checked/);
  assert.equal(render('> quoted'), '<blockquote><p>quoted</p></blockquote>');
  assert.match(render('| a | b |\n|---|--:|\n| 1 | 2 |'), /<th>a<\/th><th style="text-align:right">b<\/th>.*<td>1<\/td>/);
  assert.equal(render('---'), '<hr>');
  assert.equal(render('one\ntwo\n\nthree'), '<p>one<br>two</p><p>three</p>');
});
