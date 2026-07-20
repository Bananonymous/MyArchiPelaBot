const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('../config.json');

const ROOT = '/opt/webclient';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
};

function start() {
  const port = config.webClientPort;
  if (!port) return null;
  if (!fs.existsSync(ROOT)) {
    console.warn(`[webclient] ${ROOT} not found — rebuild the image to include the web client.`);
    return null;
  }

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);

    // Static root only — reject any path that escapes it (e.g. via "..")
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not found');
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
      res.end(data);
    });
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[webclient] Serving Archipelago web client on port ${port}.`);
  });
  server.on('error', (e) => console.error(`[webclient] Server error: ${e.message}`));
  return server;
}

module.exports = { start };
