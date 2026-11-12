// Serves the demo: /media from the extension, /state.js built from fictional data, everything else from this folder.
//   node server.js [port]      (default 5190; the alert simulation page is /alert-demo.html)
const http = require('http');
const fs = require('fs');
const path = require('path');
const lib = require('../../lib.js');
const history = require('../../history.js');
const { build, ACCOUNTS } = require('./demo-data.js');

const media = path.resolve(__dirname, '..', '..', 'media');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

function stateScript() {
  const now = Date.now();
  const states = {};
  for (const sel of ACCOUNTS) for (const act of ACCOUNTS) states[`${sel.label}|${act.label}`] = build(sel.label, act.label, now);
  const keys = Object.fromEntries(ACCOUNTS.map((a) => [lib.normalizeDir(a.configDir), a.label]));
  // A made-up weekly alert for every account, used by the alert simulation page.
  const alert = history.weeklyAlert(history.demoPlan(now), 0.12, now, { sessionsPerDay: 1.2, avgUse: 30, learned: true });
  const alerts = Object.fromEntries(ACCOUNTS.map((a) => [a.label, { ...alert, simulated: true }]));
  return [
    `window.DEMO_ALERTS = ${JSON.stringify(alerts)};`,
    `window.DEMO_STATES = ${JSON.stringify(states).replace(/</g, '\\u003c')};`,
    `window.DEMO_KEYS = ${JSON.stringify(keys)};`,
  ].join('\n');
}

function start(port = 5190) {
  const script = stateScript();
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/state.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      return res.end(script);
    }
    const inMedia = url.startsWith('/media/');
    const base = inMedia ? media : __dirname;
    const file = path.resolve(base, inMedia ? url.slice(7) : url.slice(1) || 'stage.html');
    if (!file.startsWith(base)) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end('not found');
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

module.exports = { start };
if (require.main === module) {
  const port = Number(process.argv[2]) || 5190;
  start(port).then(() => console.log(`demo on http://127.0.0.1:${port}`));
}
