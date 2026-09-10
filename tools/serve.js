/* -------------------------------------------------------------------------
   A static server for the test suites.

   The game reads its database out of data/*.json with fetch(), and fetch()
   refuses to touch a file:// URL. So every suite now runs against a real
   origin instead of opening the page off disk — which is also how you play it,
   since geolocation needs an origin too.

   Zero dependencies, one file, and it picks its own port so two suites can
   run at once without arguing.
   ------------------------------------------------------------------------- */
const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon'
};

/* A fixed port, so a suite can name its URLs at the top of the file, before
   anything has started. The suites run one after another, so nothing is ever
   competing for it. */
const PORT = Number(process.env.SS_PORT || 8123);
const BASE = 'http://127.0.0.1:' + PORT;

let running = null;

/**
 * Serve the repo on a given port and host. Used directly by the permission
 * suite, which needs the same files on a second origin to test what browsers
 * make of localhost versus a LAN address.
 */
function serveAt(port, host, root) {
  const base = root || ROOT;
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let rel = decodeURIComponent((req.url || '/').split('?')[0]);
      if (rel === '/') rel = '/index.html';
      // Nothing above the repo root, whatever the URL claims.
      const file = path.join(base, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(base)) { res.writeHead(403).end('no'); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('404 ' + rel); return; }
        res.writeHead(200, {
          'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-store'
        });
        res.end(buf);
      });
    });
    server.on('error', reject);
    // Never the reason node stays alive: a suite that forgets to close it
    // should still exit when its own work is done.
    server.unref();
    server.listen(port, host || '127.0.0.1', () => {
      resolve({
        url: 'http://' + (host === '0.0.0.0' ? 'localhost' : (host || '127.0.0.1')) + ':' + port,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

/** Start the shared server on PORT. Safe to call twice; the second is a no-op. */
function serve(root) {
  if (!running) running = serveAt(PORT, '127.0.0.1', root);
  return running;
}

module.exports = { serve, serveAt, ROOT, BASE, PORT };
