// Winziger statischer Datei-Server für die E2E-Tests (kein Extra-Dependency).
// Dient das Projektwurzelverzeichnis auf Port 8123 aus. /api/* gibt es hier
// nicht → die App läuft im lokalen Modus (Profil „default"), was für UI-Tests
// ausreicht.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath.startsWith('/api/')) { res.writeHead(404); res.end('no api'); return; }
  const file = path.join(root, urlPath);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const port = process.env.PORT || 8123;
server.listen(port, () => console.log(`Test-Server auf http://localhost:${port}`));
