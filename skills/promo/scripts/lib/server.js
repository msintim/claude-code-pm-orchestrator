import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
};

const normalizePrefix = (p) => (p === '/' ? '' : `/${p.replace(/^\/+|\/+$/g, '')}`);

function resolveMount(mounts, pathname) {
  let best = null;
  for (const m of mounts) {
    const prefix = normalizePrefix(m.prefix);
    const hit = prefix === '' || pathname === prefix || pathname.startsWith(`${prefix}/`);
    if (hit && (!best || prefix.length > best.prefix.length)) best = { prefix, root: m.root };
  }
  return best;
}

// Returns the real file path for a URL path, or null when it escapes the mount root or does not exist.
function resolveFile(mount, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname.slice(mount.prefix.length));
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  const root = fs.realpathSync(mount.root);
  let file = path.resolve(root, `.${rel.startsWith('/') ? rel : `/${rel}`}`);
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    file = fs.realpathSync(file);
  } catch {
    return null;
  }
  const inside = file === root || file.startsWith(root + path.sep);
  return inside && fs.statSync(file).isFile() ? file : null;
}

export function serveDirs(mounts, { host = '127.0.0.1', port = 0, handlers = {} } = {}) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const handler = handlers[pathname];
    if (handler) return handler(req, res);
    const mount = resolveMount(mounts, pathname);
    const file = mount && resolveFile(mount, pathname);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    const size = fs.statSync(file).size;
    const headers = {
      'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'accept-ranges': 'bytes',
    };
    // A video element can only seek a file the server answers byte ranges for; without them it is stuck at 0.
    const range = /^bytes=(d*)-(d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      const start = range[1] === '' ? Math.max(size - Number(range[2]), 0) : Number(range[1]);
      const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
      if (start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    }
    res.writeHead(200, { ...headers, 'content-length': size });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const { port: bound } = server.address();
      resolve({
        origin: `http://${host}:${bound}`,
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}
