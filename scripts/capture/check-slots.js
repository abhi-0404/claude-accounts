// Quick visual check of the session windows card (not part of the media build).
const { launch } = require('./browser.js');
const { start } = require('./server.js');
const path = require('path');

(async () => {
  const server = await start(5190);
  const b = await launch();
  const ctx = await b.browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto('http://127.0.0.1:5190/');
  const P = page.frameLocator('#panel');
  await P.locator('.acct').first().waitFor();
  await P.locator('.acct:has-text("Personal") .acct-name').click();
  await P.locator('[data-toggle="usage"]').click();
  await P.locator('[data-toggle="g:Accounts"]').click();
  await page.waitForTimeout(400);
  await P.locator('button.slot').nth(1).click();
  await P.locator('button.slot').nth(3).click();
  await page.waitForTimeout(300);
  await P.locator('button.slot').nth(2).hover();
  await page.waitForTimeout(400);
  const clip = { x: 0, y: 32, width: 368, height: 420 };
  await page.screenshot({ path: path.join(__dirname, 'out', 'slots-open.png'), clip });
  await P.locator('[data-act="toggleAlert"]').click();
  await page.mouse.move(900, 600);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, 'out', 'slots-shut.png'), clip });
  await b.close();
  server.close();
})();
