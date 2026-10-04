import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type WebSocket from 'ws';
import { pool, type Endpoint } from './db.js';
import { handlePublicRequest, handlePublicUpgrade, isOnline, replayLocal } from './tunnel.js';

const instanceUrl = process.env.INSTANCE_URL?.replace(/\/$/, '');
const internalSecret = process.env.INTERNAL_SHARED_SECRET;
if (!!instanceUrl !== !!internalSecret) throw new Error('INSTANCE_URL and INTERNAL_SHARED_SECRET must be set together');
if (instanceUrl) {
  const parsed = new URL(instanceUrl);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password || !internalSecret || internalSecret.length < 32 || internalSecret.startsWith('replace-')) throw new Error('Invalid cluster configuration');
}
function requestFor(target: URL): typeof http.request { return target.protocol === 'https:' ? https.request : http.request; }

async function activeNode(endpointId: string): Promise<string | null> {
  if (!instanceUrl) return isOnline(endpointId) ? 'local' : null;
  const found = await pool.query<{ instance_url: string }>('SELECT instance_url FROM tunnel_leases WHERE endpoint_id=$1 AND lease_expires_at>now()', [endpointId]);
  return found.rows[0]?.instance_url ?? null;
}

export async function endpointOnline(endpointId: string): Promise<boolean> { return !!await activeNode(endpointId); }

export async function replayEndpoint(endpoint: Endpoint, method: string, path: string): Promise<{ status: number; durationMs: number }> {
  const target = await activeNode(endpoint.id);
  if (!target) throw new Error('Endpoint is offline');
  if (target === 'local' || target === instanceUrl) return replayLocal(endpoint, method, path);
  const response = await fetch(`${target}/internal/replay/${endpoint.id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-endport-internal-secret': internalSecret!, 'x-endport-proxy-hop': '1' },
    body: JSON.stringify({ method, path }), signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error('Replay failed at the tunnel node');
  return await response.json() as { status: number; durationMs: number };
}

export async function claimTunnel(endpointId: string, socket: WebSocket): Promise<void> {
  if (!instanceUrl) return;
  const connectionId = randomUUID();
  await pool.query(`INSERT INTO tunnel_leases(endpoint_id,connection_id,instance_url,lease_expires_at)
    VALUES($1,$2,$3,now()+interval '45 seconds') ON CONFLICT(endpoint_id)
    DO UPDATE SET connection_id=excluded.connection_id,instance_url=excluded.instance_url,lease_expires_at=excluded.lease_expires_at`,
  [endpointId, connectionId, instanceUrl]);
  const renew = setInterval(() => {
    void pool.query("UPDATE tunnel_leases SET lease_expires_at=now()+interval '45 seconds' WHERE endpoint_id=$1 AND connection_id=$2", [endpointId, connectionId])
      .then((result) => { if (!result.rowCount) socket.close(4001, 'Replaced by another connection'); })
      .catch((error) => { console.error(error); socket.terminate(); });
  }, 10_000);
  renew.unref();
  socket.once('close', () => {
    clearInterval(renew);
    void pool.query('DELETE FROM tunnel_leases WHERE endpoint_id=$1 AND connection_id=$2', [endpointId, connectionId]).catch(console.error);
  });
}

function unavailable(res: ServerResponse): void {
  res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '5' });
  res.end('This Endport endpoint is offline.');
}

export async function routePublicRequest(req: IncomingMessage, res: ServerResponse, endpoint: Endpoint): Promise<void> {
  const target = await activeNode(endpoint.id);
  if (!target) { unavailable(res); return; }
  if (target === 'local' || target === instanceUrl) { await handlePublicRequest(req, res, endpoint); return; }
  const destination = new URL(`/internal/forward/${endpoint.id}${req.url ?? '/'}`, target);
  const upstream = requestFor(destination)(destination, { method: req.method, headers: { ...req.headers, 'x-endport-internal-secret': internalSecret!, 'x-endport-proxy-hop': '1' }, timeout: 65_000 }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('Gateway timed out')));
  upstream.on('error', () => { if (!res.headersSent) unavailable(res); else res.destroy(); });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

export async function routePublicUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, endpoint: Endpoint): Promise<void> {
  const target = await activeNode(endpoint.id);
  if (!target) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
  if (target === 'local' || target === instanceUrl) { handlePublicUpgrade(req, socket, head, endpoint); return; }
  const destination = new URL(`/internal/upgrade/${endpoint.id}${req.url ?? '/'}`, target);
  const upstreamRequest = requestFor(destination)(destination, { method: 'GET', headers: { ...req.headers, 'x-endport-internal-secret': internalSecret!, 'x-endport-proxy-hop': '1' } });
  upstreamRequest.on('upgrade', (response, upstream, upstreamHead) => {
    const headers = Object.entries(response.headers).map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value ?? ''}`).join('\r\n');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`);
    if (head.length) upstream.write(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    upstream.pipe(socket); socket.pipe(upstream);
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  upstreamRequest.on('response', (response) => {
    socket.end(`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? 'Bad Gateway'}\r\nConnection: close\r\n\r\n`);
    response.resume();
  });
  upstreamRequest.on('error', () => socket.destroy());
  upstreamRequest.end();
}

function internalAuthorized(req: IncomingMessage): boolean {
  return !!instanceUrl && req.headers['x-endport-internal-secret'] === internalSecret && req.headers['x-endport-proxy-hop'] === '1';
}

export async function routeInternalRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname.startsWith('/internal/replay/')) {
    if (!internalAuthorized(req) || req.method !== 'POST') { res.writeHead(403); res.end(); return true; }
    const match = /^\/internal\/replay\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (!match) { res.writeHead(404); res.end(); return true; }
    const found = await pool.query<Endpoint>('SELECT * FROM endpoints WHERE id=$1', [match[1]]);
    if (!found.rows[0]) { res.writeHead(404); res.end(); return true; }
    let raw = '';
    for await (const chunk of req) {
      raw += chunk.toString();
      if (raw.length > 1024) { res.writeHead(413); res.end(); return true; }
    }
    let data: { method?: string; path?: string };
    try { data = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return true; }
    if (!['GET', 'HEAD'].includes(data.method ?? '') || !/^\/(?!\/)[^\r\n]{0,2047}$/.test(data.path ?? '')) { res.writeHead(400); res.end(); return true; }
    try {
      const result = await replayLocal(found.rows[0], data.method!, data.path!);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result));
    } catch { res.writeHead(503); res.end(); }
    return true;
  }
  if (!url.pathname.startsWith('/internal/forward/')) return false;
  if (!internalAuthorized(req)) { res.writeHead(403); res.end(); return true; }
  const match = /^\/internal\/forward\/([0-9a-f-]{36})(\/.*)?$/.exec(url.pathname);
  if (!match) { res.writeHead(404); res.end(); return true; }
  const found = await pool.query<Endpoint>('SELECT * FROM endpoints WHERE id=$1', [match[1]]);
  const endpoint = found.rows[0];
  if (!endpoint) { res.writeHead(404); res.end(); return true; }
  req.url = `${match[2] ?? '/'}${url.search}`;
  await handlePublicRequest(req, res, endpoint);
  return true;
}

export async function routeInternalUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/internal/upgrade/')) return false;
  if (!internalAuthorized(req)) { socket.destroy(); return true; }
  const match = /^\/internal\/upgrade\/([0-9a-f-]{36})(\/.*)?$/.exec(url.pathname);
  if (!match) { socket.destroy(); return true; }
  const found = await pool.query<Endpoint>('SELECT * FROM endpoints WHERE id=$1', [match[1]]);
  const endpoint = found.rows[0];
  if (!endpoint) { socket.destroy(); return true; }
  req.url = `${match[2] ?? '/'}${url.search}`;
  handlePublicUpgrade(req, socket, head, endpoint);
  return true;
}
