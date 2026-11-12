// Serves the demo: /media from the extension, /state.js built from fictional data, everything else from this folder.
const http = require('http');
const fs = require('fs');
const path = require('path');
const lib = require('../../lib.js');
const { build, ACCOUNTS } = require('./demo-data.js');

const media = path.resolve(__dirname, '..', '..', 'media');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

function stateScript() {
  const now = Date.now();
  const states = {};
  for (const sel of ACCOUNTS) for (const act of ACCOUNTS) states[`${sel.label}|${act.label}`] = build(sel.label, act.label, now);
  const keys = Object.fromEntries(ACCOUNTS.map((a) => [lib.normalizeDir(a.configDir), a.label]));
  return `window.DEMO_STATES = ${JSON.stringify(states).replace(/</g, '\\u003c')};\nwindow.DEMO_KEYS = ${JSON.stringify(keys)};`;
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
if (require.main === module) start().then(() => console.log('demo on http://127.0.0.1:5190'));
