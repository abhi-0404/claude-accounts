// Records a scripted walk through the demo: a smooth cursor, real hovers and clicks, captions, one screenshot per tick.
const fs = require('fs');
const path = require('path');

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Recorder {
  /**
   * @param page      Playwright page showing /stage.html
   * @param name      output folder name
   * @param crop      {x,y,width,height} in CSS pixels
   */
  constructor(page, name, crop, outRoot, dpr = 1) {
    this.dpr = dpr;
    this.page = page;
    this.name = name;
    this.crop = crop;
    this.dir = path.join(outRoot, name);
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    this.frames = [];
    this.pos = { x: 640, y: 380 };
  }

  /** Starts the browser's own screencast: frames arrive at the screen's rate, so motion stays smooth. */
  async start() {
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', (f) => {
      this.frames.push({ t: f.metadata.timestamp * 1000, buf: Buffer.from(f.data, 'base64') });
      this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 94, maxWidth: Math.round(1280 * this.dpr), maxHeight: Math.round(720 * this.dpr), everyNthFrame: 1 });
  }

  async stop() {
    await sleep(250);
    await this.cdp.send('Page.stopScreencast').catch(() => {});
  }

  /** Frames come from the screencast; this only paces the script. */
  async shot() {
    await sleep(12);
  }

  /** Waits `ms`, recording frames the whole time. */
  async hold(ms) {
    const end = Date.now() + ms;
    do await this.shot();
    while (Date.now() < end);
  }

  async cursorTo(x, y) {
    this.pos = { x, y };
    await this.page.mouse.move(x, y);
    await this.page.evaluate(([a, b]) => window.stage.cursor(a, b), [x, y]);
  }

  /** Glides the cursor along a gentle arc to (x, y) in about `ms`, recording as it goes. */
  async moveTo(x, y, ms = 700) {
    const { x: x0, y: y0 } = this.pos;
    const dx = x - x0;
    const dy = y - y0;
    const dist = Math.hypot(dx, dy) || 1;
    const bend = Math.min(40, dist * 0.08);
    const cx = x0 + dx / 2 - (dy / dist) * bend;
    const cy = y0 + dy / 2 + (dx / dist) * bend;
    const start = Date.now();
    let p = 0;
    while (p < 1) {
      p = Math.min(1, (Date.now() - start) / ms);
      const e = ease(p);
      const px = (1 - e) * (1 - e) * x0 + 2 * (1 - e) * e * cx + e * e * x;
      const py = (1 - e) * (1 - e) * y0 + 2 * (1 - e) * e * cy + e * e * y;
      await this.cursorTo(px, py);
      await this.shot();
    }
  }

  /** Centre of an element (page coordinates). `frame` is the iframe id, or null for the stage itself. */
  async centre(selector, frame = 'panel', where = {}) {
    const loc = (frame ? this.page.frameLocator(`#${frame}`) : this.page).locator(selector).first();
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const b = await loc.boundingBox();
    if (!b) throw new Error(`not visible: ${selector}`);
    return { x: b.x + b.width * (where.fx ?? 0.5), y: b.y + b.height * (where.fy ?? 0.5), box: b };
  }

  async moveToEl(selector, frame = 'panel', ms = 700, where = {}) {
    const c = await this.centre(selector, frame, where);
    await this.moveTo(c.x, c.y, ms);
    return c;
  }

  async click() {
    await this.page.evaluate(([x, y]) => { window.stage.press(true); window.stage.ripple(x, y); }, [this.pos.x, this.pos.y]);
    await this.page.mouse.down();
    await this.shot();
    await sleep(60);
    await this.page.mouse.up();
    await this.page.evaluate(() => window.stage.press(false));
    await this.shot();
  }

  async clickEl(selector, frame = 'panel', ms = 650, where = {}) {
    await this.moveToEl(selector, frame, ms, where);
    await this.hold(120);
    await this.click();
  }

  async type(text, perChar = 70) {
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      await this.shot();
      await sleep(perChar);
    }
  }

  async caption(text, x, y) {
    await this.page.evaluate(([t, a, b]) => window.stage.caption(t, a, b), [text, x ?? null, y ?? null]);
  }

  /** Writes frames and a delays file the GIF builder reads. */
  save(lastHold = 1600) {
    const delays = this.frames.map((f, i) => Math.round(i + 1 < this.frames.length ? this.frames[i + 1].t - f.t : lastHold));
    this.frames.forEach((f, i) => fs.writeFileSync(path.join(this.dir, `${String(i).padStart(4, '0')}.jpg`), f.buf));
    fs.writeFileSync(path.join(this.dir, 'meta.json'), JSON.stringify({ delays, crop: this.crop, dpr: this.dpr }));
    return { frames: this.frames.length, seconds: Math.round(delays.reduce((a, b) => a + b, 0) / 100) / 10 };
  }
}

module.exports = { Recorder, sleep };
