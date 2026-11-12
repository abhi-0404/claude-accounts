// Starts Edge on its own temporary profile and connects to it (works while your own Edge is open).
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));

async function launch(port = 9333) {
  if (!EDGE) throw new Error('Microsoft Edge was not found.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-capture-'));
  const proc = spawn(EDGE, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });
  let browser = null;
  for (let i = 0; i < 40 && !browser; i += 1) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!browser) {
    proc.kill();
    throw new Error('Could not connect to Edge.');
  }
  return {
    browser,
    async close() {
      await browser.close().catch(() => {});
      proc.kill();
    },
  };
}

module.exports = { launch };
