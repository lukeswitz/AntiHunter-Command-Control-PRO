import { createServer, request as httpRequest } from 'node:http';

const UPSTREAM = new URL(process.env.SIGNAL_UPSTREAM || 'http://signal-api:8080');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.BIND || '0.0.0.0';

function allowed(method, path, body) {
  if (method === 'GET') {
    return (
      path === '/v1/about' ||
      path === '/v1/accounts' ||
      path.startsWith('/v1/qrcodelink') ||
      /^\/v1\/groups\/[^/]+$/.test(path)
    );
  }
  if (method === 'POST' && /^\/v1\/groups\/[^/]+$/.test(path)) {
    return true;
  }
  if (method === 'POST' && (path === '/v2/send' || path === '/v1/send')) {
    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      return false;
    }
    const recipients = parsed.recipients;
    return (
      Array.isArray(recipients) &&
      recipients.length > 0 &&
      recipients.every((r) => typeof r === 'string' && r.startsWith('group.'))
    );
  }
  return false;
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const path = req.url || '/';
    if (!allowed(req.method, path.split('?')[0], body.toString('utf8'))) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"error":"blocked by AntiHunter signal-proxy"}');
      return;
    }
    const upstream = httpRequest(
      {
        hostname: UPSTREAM.hostname,
        port: UPSTREAM.port,
        path,
        method: req.method,
        headers: { ...req.headers, host: UPSTREAM.host },
      },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"error":"signal upstream unreachable"}');
    });
    if (body.length) {
      upstream.write(body);
    }
    upstream.end();
  });
}).listen(PORT, HOST, () => {
  process.stdout.write(`signal-proxy on ${HOST}:${PORT} -> ${UPSTREAM.origin}\n`);
});
