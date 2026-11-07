// Minimal static server for the assembled Cloudflare bundle.
//
// Serves ONLY pokeemerald-3d/dist so a temporary tunnel never exposes the
// repository, and proxies presence and run WebSockets on the same origin so a
// single URL works for every player (no separate service URL needed).
//
//   node deploy/serve-dist.mjs [port] [relayPort]

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', 'pokeemerald-3d', 'dist');
const port = Number(process.argv[2] || process.env.PORT || 8090);
const relayPort = Number(process.argv[3] || process.env.RELAY_PORT || 8787);
const relayHost = '127.0.0.1';

const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.png', 'image/png'],
  ['.json', 'application/json; charset=utf-8'],
  ['.woff', 'font/woff'],
]);

function safePathname(url) {
  try {
    return new URL(url || '/', 'http://localhost').pathname;
  } catch {
    return null;
  }
}

function fileFor(url) {
  try {
    const pathname = safePathname(url);
    if (!pathname) return null;
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = resolve(root, normalize(relative));
    if (file !== root && !file.startsWith(root + sep)) return null;
    return file;
  } catch {
    return null;
  }
}

function proxyHealth(request, response) {
  const upstream = httpRequest({
    host: relayHost,
    port: relayPort,
    path: '/health',
    method: 'GET',
  }, (res) => {
    response.writeHead(res.statusCode ?? 502, res.headers);
    res.pipe(response);
    res.on('error', () => response.destroy());
  });
  upstream.on('error', () => {
    if (!response.headersSent) {
      response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end('{"ok":false,"relay":"unreachable"}');
    }
  });
  response.on('error', () => upstream.destroy());
  upstream.end();
}

const server = createServer((request, response) => {
  const pathname = safePathname(request.url);
  if (!pathname) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('bad request');
    return;
  }

  if (pathname === '/health') {
    proxyHealth(request, response);
    return;
  }

  if (pathname === '/presence' || pathname === '/run') {
    // WebSocket upgrades are handled below; a plain GET is a client mistake.
    response.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('upgrade required\n');
    return;
  }

  const file = fileFor(request.url);
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
    return;
  }
  response.writeHead(200, {
    'Content-Type': types.get(extname(file)) || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  const stream = createReadStream(file);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
});

// Forward the raw WebSocket handshake to the relay and pipe both directions.
server.on('upgrade', (request, socket, head) => {
  const pathname = safePathname(request.url);
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

server.on('clientError', (err, socket) => {
  if (err.code === 'ECONNRESET' || !socket.writable) {
    socket.destroy();
    return;
  }
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

process.on('uncaughtException', (err) => {
  console.error('serve-dist uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('serve-dist unhandledRejection:', reason);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`dist server: http://127.0.0.1:${port} (presence + run -> ${relayHost}:${relayPort})`);
});
