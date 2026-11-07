import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';

const cwd = resolve(process.cwd());
const gameRoot = existsSync(join(cwd, 'web', 'index.html'))
  ? cwd
  : resolve(cwd, 'pokeemerald-3d');
const repoRoot = resolve(gameRoot, '..');
const requestedPort = Number(process.env.PORT || 8000);
const relayPort = Number(process.env.PRESENCE_PORT || 8787);
const relayHost = '127.0.0.1';
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.json', 'application/json; charset=utf-8'],
  ['.woff', 'font/woff'],
]);

function within(base, file) {
  return file === base || file.startsWith(base + sep);
}

function fileFor(url) {
  const pathname = new URL(url, `http://localhost:${requestedPort}`).pathname;
  const clean = normalize(decodeURIComponent(pathname)).replaceAll('\\', '/');

  if (clean === '/' || clean === '\\') return join(gameRoot, 'web', 'index.html');
  if (clean.startsWith('/web/')) return resolve(gameRoot, `.${clean}`);
  if (clean.startsWith('/graphics/')) return resolve(gameRoot, `.${clean}`);
  if (clean.startsWith('/build/')) return resolve(gameRoot, `.${clean}`);
  if (clean.startsWith('/game-packs/')) return resolve(repoRoot, `.${clean}`);
  return null;
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url, `http://localhost:${requestedPort}`).pathname;

  // The browser connects to presence on the same origin it loaded from, so the
  // dev server must forward it to the relay. Without this a page served here
  // retries "Reconnecting…" forever against a 404.
  if (pathname === '/health') {
    const upstream = httpRequest({ host: relayHost, port: relayPort, path: '/health', method: 'GET' }, (relayRes) => {
      res.writeHead(relayRes.statusCode ?? 502, relayRes.headers);
      relayRes.pipe(res);
    });
    upstream.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{"ok":false,"relay":"unreachable"}');
    });
    upstream.end();
    return;
  }

  if (pathname === '/presence' || pathname === '/run') {
    res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('upgrade required\n');
    return;
  }

  const file = fileFor(req.url);
  if (!file
    || (!within(gameRoot, file) && !within(repoRoot, file))
    || !existsSync(file)
    || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': types.get(extname(file)) || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(file).pipe(res);
});

// Forward the WebSocket handshake verbatim so the relay sees the same request.
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname !== '/presence' && pathname !== '/run') {
    socket.destroy();
    return;
  }

  const upstream = connect(relayPort, relayHost, () => {
    const headers = Object.entries(request.headers)
      .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
      .join('\r\n');
    upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
});

server.listen(requestedPort, function () {
  const { port } = this.address();
  console.log(`pokeemerald-3d server: http://localhost:${port} (presence -> ${relayHost}:${relayPort}/presence)`);
});
