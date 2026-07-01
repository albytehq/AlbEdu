// AlbEdu dev server v2.1.0 — serves source on http://localhost:8765 for local testing.
// v2.1.0: Landing page is now at root index.html (no redirect to /pages/).
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 8765;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json',
  '.ts':   'text/plain; charset=utf-8',
  '.md':   'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  // Security: prevent path traversal
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // If URL doesn't have .html extension and the file with .html exists, serve it
      if (!urlPath.endsWith('.html')) {
        const htmlPath = filePath + '.html';
        if (fs.existsSync(htmlPath)) {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
          });
          fs.createReadStream(htmlPath).pipe(res);
          return;
        }
      }
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🚀 AlbEdu dev server running!`);
  console.log(`   Local:    http://127.0.0.1:${PORT}`);
  console.log(`   Landing:  http://127.0.0.1:${PORT}/`);
  console.log(`   Login:    http://127.0.0.1:${PORT}/pages/login.html`);
  console.log(`   Admin:    http://127.0.0.1:${PORT}/pages/admin/index.html`);
  console.log(`\n   Press Ctrl+C to stop.\n`);
});
