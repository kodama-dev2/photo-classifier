#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'src', 'renderer');
const port = Number(process.env.PORT || 5179);

const shim = `
window.api = {
  pickDir: async () => null,
  getModelsStatus: async () => ({ state: 'ready', message: 'Preview browser (mock)' }),
  mediaUrl: (filePath) => filePath,
  onModelsStatus: (cb) => { cb({ state: 'ready', message: 'Preview browser (mock)' }); return () => {}; },
  onProgress: () => () => {},
  scan: async () => ({ ok: false, error: 'Preview browser: pindai hanya di app Electron' }),
  reclassify: async () => ({ ok: false, error: 'Preview browser' }),
  mergeClusters: async () => ({ ok: false, error: 'Preview browser' }),
  renameCluster: async () => ({ ok: false, error: 'Preview browser' }),
  cancel: async () => true,
  apply: async () => ({ ok: false, error: 'Preview browser' }),
  undo: async () => ({ ok: false, error: 'Preview browser' }),
  reveal: async () => false
};
`;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/preview-shim.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(shim);
    return;
  }

  let filePath = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') {
      let html = data.toString('utf8');
      if (!html.includes('preview-shim.js')) {
        html = html.replace(
          '<script src="renderer.js"></script>',
          '<script src="/preview-shim.js"></script>\n    <script src="renderer.js"></script>'
        );
      }
      res.writeHead(200, { 'Content-Type': types['.html'] });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${port}`);
});
