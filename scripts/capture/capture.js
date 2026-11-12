// node capture.js [switch|chats|usage|chat|stills|all]
// Records the walkthroughs (frames in out/) and the still screenshots (docs/media). Uses Edge and fictional demo data.
const path = require('path');
const fs = require('fs');
const { launch } = require('./browser.js');
const { start } = require('./server.js');
const { Recorder, sleep } = require('./anim.js');

const OUT = path.join(__dirname, 'out');
const DOCS = path.resolve(__dirname, '..', '..', 'docs', 'media');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(DOCS, { recursive: true });

const PANEL_CROP = { x: 0, y: 32, width: 368, height: 666 };
const WIN = { x: 0, y: 0, width: 1280, height: 720 };

async function open(b, dpr, k = 1) {
  const ctx = await b.browser.newContext({ viewport: { width: Math.round(1280 * k), height: Math.round(720 * k) }, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto(`http://127.0.0.1:5190/?k=${k}`);
  await page.waitForSelector('#panel');
  await page.frameLocator('#panel').locator('.acct').first().waitFor();
  await sleep(500);
  return { ctx, page };
}

const frame = (page, name) => page.frames().find((f) => f.url().includes(name));
const panelFrame = (page) => frame(page, 'panel.html');
const chatFrame = (page) => frame(page, 'chat.html');
const P = (page) => page.frameLocator('#panel');

/** Opens or closes a panel section by clicking its header (like a user), recording. */
async function toggle(r, id) {
  await r.clickEl(`[data-toggle="${id}"]`, 'panel', 600, { fx: 0.12 });
  await r.hold(260);
}

// ---------------------------------------------------------------- 1. switch accounts
async function switchScenario(b) {
  const { ctx, page } = await open(b, 1, 1.5);
  const r = new Recorder(page, 'switch', { x: 0, y: 0, width: 640, height: 720 }, OUT, 1.5);
  await r.start();
  await r.cursorTo(420, 560);
  await r.caption('Every account, side by side', 330, 640);
  await r.hold(1300);
  // Move along the usage columns
  await r.moveToEl('.acct:has-text("Personal") .acct-col', 'panel', 900);
  await r.hold(700);
  await r.caption('Switch accounts in one click', 330, 640);
  await r.clickEl('.acct:has-text("Personal") .pill', 'panel', 800);
  await r.hold(1100);
  await r.caption('No reload. Chats, projects and memory stay put', 330, 640);
  await r.hold(1500);
  await r.caption('Pick an account to see its details', 330, 640);
  await r.clickEl('.acct:has-text("Studio") .acct-name', 'panel', 800, { fx: 0.3 });
  await r.hold(500);
  await toggle(r, 'usage');
  await r.hold(1800);
  await r.caption('A bell warns before a week of usage goes unused', 330, 640);
  await r.clickEl('.acct:has-text("Personal") .acct-name', 'panel', 800, { fx: 0.3 });
  await r.hold(2200);
  await r.caption(null);
  await r.stop();
  console.log('switch', r.save(1400));
  await ctx.close();
}

// ---------------------------------------------------------------- 2. chats and projects
async function chatsScenario(b) {
  const { ctx, page } = await open(b, 1, 1.5);
  const r = new Recorder(page, 'chats', PANEL_CROP, OUT, 1.5);
  await r.start();
  await r.cursorTo(250, 420);
  await toggle(r, 'g:Accounts'); // fold Accounts to give the list room
  await toggle(r, 'sessions');
  await r.caption('Your chats, grouped by project', 184);
  await r.hold(1700);
  await r.clickEl('.folder-head:nth-of-type(2)', 'panel', 700, { fx: 0.3 });
  await r.hold(800);
  await r.caption('Only the selected account at first', 184);
  await r.hold(1300);
  await r.caption('One switch shows every account', 184);
  await r.clickEl('#scope-btn', 'panel', 800);
  await r.hold(1900);
  await r.caption('Projects you have worked in', 184);
  await r.clickEl('#kind button[data-kind="projects"]', 'panel', 700, { fx: 0.5 });
  await r.hold(1700);
  await r.caption('Search all of it', 184);
  await r.clickEl('#search', 'panel', 700, { fx: 0.4 });
  await r.type('mobile', 90);
  await r.hold(1700);
  await r.caption(null);
  await r.stop();
  console.log('chats', r.save(1400));
  await ctx.close();
}

// ---------------------------------------------------------------- 3. usage and history
/** Screen position of a point along the weekly line (fraction f of its length). */
async function linePoint(page, f, k = 1) {
  const pf = panelFrame(page);
  const pos = await pf.evaluate((fr) => {
    const paths = [...document.querySelectorAll('#plot svg path:last-of-type')];
    const p = paths[paths.length - 1];
    const svg = p.ownerSVGElement;
    const pt = p.getPointAtLength(p.getTotalLength() * fr);
    const r = svg.getBoundingClientRect();
    return { x: r.left + (pt.x / 1000) * r.width, y: r.top + (pt.y / 100) * r.height };
  }, f);
  const off = await page.locator('#panel').boundingBox();
  return { x: pos.x * k + off.x, y: pos.y * k + off.y };
}

/** The top of the tallest session bar (above the weekly line), in page coordinates. */
async function tallBar(page, k = 1) {
  const pos = await panelFrame(page).evaluate(() => {
    const bars = [...document.querySelectorAll('#plot .sbar')].map((el) => el.getBoundingClientRect()).filter((b) => b.width > 3);
    const best = bars.sort((a, b) => b.height - a.height)[0];
    return { x: best.left + best.width / 2, y: best.top + 5 };
  });
  const off = await page.locator('#panel').boundingBox();
  return { x: pos.x * k + off.x, y: pos.y * k + off.y };
}

async function usageScenario(b) {
  const { ctx, page } = await open(b, 1, 1.5);
  const r = new Recorder(page, 'usage', PANEL_CROP, OUT, 1.5);
  await r.start();
  await r.cursorTo(250, 420);
  await toggle(r, 'g:Accounts');
  await toggle(r, 'usage');
  await r.caption('Session and weekly limits, with days left', 184);
  await r.moveToEl('.meter:nth-of-type(2) .bar', 'panel', 800);
  await r.hold(2200);
  await r.caption('History in one click', 184);
  await r.clickEl('#details-toggle', 'panel', 700, { fx: 0.3 });
  await r.hold(1600);
  await r.caption('Hover the line for the weekly number', 184);
  let pt = await linePoint(page, 0.55, 1.5);
  await r.moveTo(pt.x, pt.y, 900);
  await r.hold(1500);
  pt = await linePoint(page, 0.85, 1.5);
  await r.moveTo(pt.x, pt.y, 1100);
  await r.hold(1200);
  await r.caption('Hover a bar for that 5-hour session', 184);
  const bar = await tallBar(page, 1.5);
  await r.moveTo(bar.x, bar.y, 900);
  await r.hold(1800);
  await r.caption('Zoom in, drag, go back week by week', 184);
  await r.clickEl('[data-act="zoomIn"]', 'panel', 800);
  await r.hold(1000);
  await r.clickEl('[data-act="weekPrev"]', 'panel', 700);
  await r.hold(1500);
  await r.caption('Weekly or monthly', 184);
  await P(page).locator('#details-range').selectOption('month');
  await r.moveToEl('#details-range', 'panel', 700);
  await r.hold(1900);
  await r.caption('And which models you use', 184);
  await r.clickEl('#utab button[data-utab="models"]', 'panel', 800);
  await r.hold(2300);
  await r.caption(null);
  await r.stop();
  console.log('usage', r.save(1400));
  await ctx.close();
}

// ---------------------------------------------------------------- 4. chat tab
const words = (s) => s.split(/(?<=\s)/);

async function post(page, msg) {
  await chatFrame(page).evaluate((m) => window.postMessage(m, '*'), msg);
}

async function streamText(r, page, id, text, tick = 38) {
  await post(page, { type: 'event', ev: { t: 'block', id, kind: 'text' } });
  for (const w of words(text)) {
    await post(page, { type: 'event', ev: { t: 'delta', id, text: w } });
    await r.shot();
    await sleep(tick);
  }
}

async function chatScenario(b, stillsOnly = false) {
  const { ctx, page } = await open(b, stillsOnly ? 2 : 1, stillsOnly ? 1 : 1.5);
  const r = new Recorder(page, 'chat', { x: 0, y: 0, width: 1280, height: 720 }, OUT, 1.5);
  if (!stillsOnly) await r.start();
  await r.cursorTo(300, 500);
  await toggle(r, 'sessions');
  await r.caption('Chat in your own tab. No other extension needed', 950, 36);
  await r.hold(1400);
  await r.clickEl('#new-btn', 'panel', 800, { fx: 0.3 });
  await sleep(150);
  await post(page, {
    type: 'setup',
    history: [],
    models: [{ value: 'default', label: 'Default model' }, { value: 'opus', label: 'Opus 5.5' }, { value: 'sonnet', label: 'Sonnet 5.5' }],
    model: 'default',
    mode: 'default',
    folder: 'storefront-api',
    cwd: 'C:\\code\\storefront-api',
    account: 'Work',
    busy: false,
  });
  await r.hold(1100);
  await r.caption('Attach files, pick a model, choose how much to ask', 950, 36);
  const inputBox = await r.centre('#input', 'chat');
  await r.moveTo(inputBox.x, inputBox.y, 800);
  await r.click();
  await r.caption(null);
  await r.type('Checkout totals drift by a cent on big carts. Can you fix it?', 38);
  await r.hold(500);
  await page.keyboard.press('Enter');
  await r.hold(300);
  await post(page, { type: 'busy', busy: true });
  await sleep(600);
  await streamText(r, page, 'b1', "I'll start with the checkout handler, since that's where the total is added up.");
  await post(page, { type: 'event', ev: { t: 'tool', id: 't1', name: 'Read', input: { file_path: 'C:\\code\\storefront-api\\src\\orders.ts' } } });
  await r.hold(700);
  await post(page, { type: 'event', ev: { t: 'toolResult', id: 't1', text: 'export const orders = Router();\n...', isError: false } });
  await r.hold(400);
  await streamText(r, page, 'b2', 'Found it. It sums prices as floats, so a cart of many items drifts. I will add up whole cents instead.');
  await post(page, { type: 'event', ev: { t: 'tool', id: 't2', name: 'Edit', input: { file_path: 'C:\\code\\storefront-api\\src\\orders.ts', old_string: 'sum + i.price * i.qty', new_string: 'sum + Math.round(i.price * 100) * i.qty' } } });
  await post(page, { type: 'event', ev: { t: 'permission', requestId: 'r1', tool: 'Edit', toolName: 'Edit', input: { file_path: 'C:\\code\\storefront-api\\src\\orders.ts', old_string: 'sum + i.price * i.qty', new_string: 'sum + Math.round(i.price * 100) * i.qty' }, description: 'orders.ts', suggestions: [{ type: 'setMode', mode: 'acceptEdits' }] } });
  await r.caption('You stay in control of every edit', 950, 36);
  await r.hold(1700);
  await r.clickEl('.perm .btn.primary', 'chat', 900);
  await post(page, { type: 'answered', requestId: 'r1', decision: 'allow' });
  await post(page, { type: 'event', ev: { t: 'toolResult', id: 't2', text: 'Edited orders.ts', isError: false } });
  await r.caption(null);
  await r.hold(500);
  await post(page, { type: 'event', ev: { t: 'tool', id: 't3', name: 'Bash', input: { command: 'pnpm test --filter orders', description: 'Run the orders tests' } } });
  await r.hold(900);
  await post(page, { type: 'event', ev: { t: 'toolResult', id: 't3', text: 'PASS  orders.test.ts\n  checkout totals\n    ok adds up large carts exactly (4 ms)\n\nTests: 12 passed', isError: false } });
  await r.hold(400);
  await streamText(r, page, 'b3', 'Fixed. The total is now added up in whole cents, and the orders tests pass, including a new case for a large cart.');
  await post(page, { type: 'event', ev: { t: 'done', ok: true, durationMs: 21400, cost: 0.0731 } });
  await post(page, { type: 'busy', busy: false });
  await r.hold(1800);
  // The chat's history lives in the Chats list: finish on the whole window
  if (stillsOnly) {
    await r.cursorTo(1180, 600);
    await sleep(250);
    await page.screenshot({ path: path.join(DOCS, 'hero.png') });
    await page.screenshot({ path: path.join(DOCS, 'chat-tab.png'), clip: { x: 368, y: 32, width: 912, height: 666 } });
  }
  if (!stillsOnly) {
    await r.stop();
    console.log('chat', r.save(1800));
  }
  await ctx.close();
}

// ---------------------------------------------------------------- stills
async function stills(b) {
  const { ctx, page } = await open(b, 2);
  const shot = async (name, clip) => {
    await page.evaluate(() => window.stage.cursor(-100, -100));
    await page.mouse.move(1200, 650);
    await page.waitForTimeout(250);
    return page.screenshot({ path: path.join(DOCS, name), clip });
  };
  const rec = new Recorder(page, 'tmp', PANEL_CROP, OUT, 2);
  await rec.cursorTo(900, 600);
  await P(page).locator('#session-list').waitFor({ state: 'attached' }).catch(() => {});
  await page.waitForTimeout(300);
  await shot('accounts.png', PANEL_CROP);
  await toggle(rec, 'g:Accounts');
  await toggle(rec, 'sessions');
  await rec.moveTo(900, 600, 200);
  await page.waitForTimeout(400);
  await shot('chats.png', PANEL_CROP);
  await P(page).locator('#scope-btn').click();
  await page.waitForTimeout(300);
  await shot('chats-all.png', PANEL_CROP);
  await toggle(rec, 'sessions');
  await toggle(rec, 'usage');
  await P(page).locator('#details-toggle').click();
  await page.waitForTimeout(500);
  await shot('usage.png', PANEL_CROP);
  await ctx.close();
}

(async () => {
  const which = process.argv[2] || 'all';
  const server = await start(5190);
  const b = await launch();
  try {
    if (which === 'switch' || which === 'all') await switchScenario(b);
    if (which === 'chats' || which === 'all') await chatsScenario(b);
    if (which === 'usage' || which === 'all') await usageScenario(b);
    if (which === 'chat' || which === 'all') await chatScenario(b);
    if (which === 'stills' || which === 'all') {
      await stills(b);
      await chatScenario(b, true);
    }
  } finally {
    await b.close();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
