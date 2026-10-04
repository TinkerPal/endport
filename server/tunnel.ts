import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { pool, type Endpoint } from './db.js';
import { jsonPreview } from './preview.js';

const MAX_REQUEST = 2 * 1024 * 1024;
const MAX_RESPONSE = 10 * 1024 * 1024;
const REQUEST_TIMEOUT = 60_000;
const MAX_ACTIVE = 100;
const MAX_PUBLIC_SOCKETS = 50;
const MAX_REQUESTS_PER_MINUTE = 120;
const MAX_BUFFERED = 16 * 1024 * 1024;
const tunnels = new Map<string, WebSocket>();
const tokenBySocket = new WeakMap<WebSocket, string>();
const trafficRate = new Map<string, { count: number; until: number }>();
const pending = new Map<string, {
  endpointId: string; res: ServerResponse; timer: NodeJS.Timeout;
  started: number; method: string; path: string; bytesIn: number;
  bytesOut: number; status: number; headersSent: boolean; streaming: boolean; originMs: number | null;
  requestPreview: unknown | null; responseParts: Buffer[] | null; responseContentType: string | string[] | undefined; responseComplete: boolean;
}>();
const publicSockets = new Map<string, { socket: WebSocket; endpointId: string }>();
const replayPending = new Map<string, { endpointId: string; method: string; path: string; started: number; status: number; originMs: number | null; timer: NodeJS.Timeout; resolve: (value: { status: number; durationMs: number }) => void; reject: (reason: Error) => void }>();
const publicWsServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

type TunnelMessage = { type: string; id: string; status?: number; headers?: Record<string, string | string[]>; data?: string; binary?: boolean; originMs?: number };

export function isOnline(endpointId: string): boolean {
  return tunnels.get(endpointId)?.readyState === WebSocket.OPEN;
}

export function registerTunnel(endpointId: string, ws: WebSocket, cliTokenHash: string): void {
  if (tunnels.has(endpointId)) {
    for (const [id, item] of pending) if (item.endpointId === endpointId) finishRequest(id, 502);
    for (const [id, entry] of publicSockets) if (entry.endpointId === endpointId) { entry.socket.close(1012, 'Tunnel reconnecting'); publicSockets.delete(id); }
  }
  tunnels.get(endpointId)?.close(4001, 'Replaced by a new connection');
  tunnels.set(endpointId, ws);
  tokenBySocket.set(ws, cliTokenHash);
  ws.send(JSON.stringify({ type: 'ready', id: endpointId }));
  let awaitingPong = false;
  const heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (awaitingPong) { ws.terminate(); return; }
    awaitingPong = true; ws.ping();
  }, 25_000);
  heartbeat.unref();
  ws.on('pong', () => { awaitingPong = false; });
  ws.on('message', (raw) => {
    let message: TunnelMessage;
    try { message = JSON.parse(raw.toString()) as TunnelMessage; } catch { ws.close(1003, 'Invalid message'); return; }
    if (!message || typeof message.type !== 'string' || typeof message.id !== 'string' || !message.id) { ws.close(1003, 'Invalid message'); return; }
    if (message.type.startsWith('ws-')) { forwardWebSocket(message, endpointId); return; }
    const replay = replayPending.get(message.id);
    if (replay && replay.endpointId === endpointId) {
      if (message.type === 'response-start') replay.status = Number.isInteger(message.status) ? message.status! : 502;
      if (message.type === 'response-end') {
        if (Number.isInteger(message.originMs)) replay.originMs = message.originMs!;
        finishReplay(message.id);
      }
      if (message.type === 'response-error') finishReplay(message.id, new Error('Replay failed at the local server'));
      return;
    }
    const item = pending.get(message.id);
    if (!item || item.endpointId !== endpointId) return;
    if (message.type === 'response-start' && !item.headersSent) {
      item.status = Number.isInteger(message.status) && message.status! >= 200 && message.status! <= 599 ? message.status! : 502;
      item.streaming = String(message.headers?.['content-type'] ?? '').toLowerCase().includes('text/event-stream');
      item.responseContentType = message.headers?.['content-type'];
      item.res.writeHead(item.status, cleanResponseHeaders(message.headers ?? {}));
      item.headersSent = true;
      clearTimeout(item.timer);
      item.timer = setTimeout(() => finishRequest(message.id, 504), REQUEST_TIMEOUT);
    } else if (message.type === 'response-chunk' && item.headersSent && message.data) {
      const chunk = Buffer.from(message.data, 'base64');
      item.bytesOut += chunk.length;
      if (item.responseParts) {
        if (item.bytesOut <= 8192) item.responseParts.push(chunk);
        else item.responseParts = null;
      }
      if (!item.streaming && item.bytesOut > MAX_RESPONSE) { sendTunnel(ws, { type: 'cancel', id: message.id }); finishRequest(message.id, 502); return; }
      if (!item.res.write(chunk)) {
        sendTunnel(ws, { type: 'pause', id: message.id });
        item.res.once('drain', () => sendTunnel(ws, { type: 'resume', id: message.id }));
      }
      clearTimeout(item.timer);
      item.timer = setTimeout(() => finishRequest(message.id, 504), REQUEST_TIMEOUT);
    } else if (message.type === 'response-end') {
      if (Number.isInteger(message.originMs) && message.originMs! >= 0 && message.originMs! < 86_400_000) item.originMs = message.originMs!;
      item.responseComplete = true;
      finishRequest(message.id, item.status);
    } else if (message.type === 'response-error') {
      finishRequest(message.id, 502);
    }
  });
  ws.on('close', () => {
    clearInterval(heartbeat);
    if (tunnels.get(endpointId) !== ws) return;
    tunnels.delete(endpointId);
    for (const [id, item] of pending) if (item.endpointId === endpointId) finishRequest(id, 502);
    for (const [id, item] of replayPending) if (item.endpointId === endpointId) finishReplay(id, new Error('Tunnel disconnected'));
    for (const [id, entry] of publicSockets) if (entry.endpointId === endpointId) { entry.socket.close(1011, 'Tunnel disconnected'); publicSockets.delete(id); }
  });
  ws.on('error', () => ws.terminate());
}

function finishReplay(id: string, error?: Error): void {
  const item = replayPending.get(id);
  if (!item) return;
  replayPending.delete(id); clearTimeout(item.timer);
  if (error) { item.reject(error); return; }
  const duration = Date.now() - item.started;
  let path = '/';
  try { path = new URL(item.path, 'http://local').pathname.slice(0, 2048); } catch { /* keep default */ }
  void pool.query('INSERT INTO request_logs(id,endpoint_id,method,path,status,duration_ms,origin_ms,bytes_in,bytes_out) VALUES($1,$2,$3,$4,$5,$6,$7,0,0)',
    [id, item.endpointId, item.method, path, item.status, duration, item.originMs]).catch(console.error);
  item.resolve({ status: item.status, durationMs: duration });
}

export function replayLocal(endpoint: Endpoint, method: string, path: string): Promise<{ status: number; durationMs: number }> {
  const tunnel = tunnels.get(endpoint.id);
  if (!tunnel || tunnel.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Endpoint is offline'));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { sendTunnel(tunnel, { type: 'cancel', id }); finishReplay(id, new Error('Replay timed out')); }, 20_000);
    replayPending.set(id, { endpointId: endpoint.id, method, path, started: Date.now(), status: 502, originMs: null, timer, resolve, reject });
    if (!sendTunnel(tunnel, { type: 'request', id, method, path, headers: { 'x-endport-replay': '1' }, body: '', originalHost: `${endpoint.slug}.endport.io` })) finishReplay(id, new Error('Tunnel disconnected'));
  });
}
function sendTunnel(ws: WebSocket, message: object): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  if (ws.bufferedAmount > MAX_BUFFERED) { ws.terminate(); return false; }
  ws.send(JSON.stringify(message));
  return true;
}

export function revokeTunnels(cliTokenHash: string): void {
  for (const ws of tunnels.values()) if (tokenBySocket.get(ws) === cliTokenHash) ws.close(4003, 'CLI token revoked');
}

function cleanResponseHeaders(headers: Record<string, string | string[]>): Record<string, string | string[]> {
  const excluded = new Set(['connection', 'transfer-encoding', 'content-length', 'keep-alive', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'trailer']);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !excluded.has(key.toLowerCase())));
}

function cleanRequestHeaders(req: IncomingMessage, endpoint: Endpoint): Record<string, string | string[]> {
  const excluded = new Set(['host', 'connection', 'transfer-encoding', 'content-length', 'keep-alive', 'upgrade', 'proxy-authorization', 'x-endport-access-token', 'x-endport-internal-secret', 'x-endport-proxy-hop']);
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([key, value]) => !excluded.has(key.toLowerCase()) && value !== undefined)) as Record<string, string | string[]>;
  if (typeof headers.cookie === 'string') {
    const kept = headers.cookie.split(';').map((part) => part.trim()).filter((part) => !part.startsWith(`endport_access_${endpoint.slug}=`));
    if (kept.length) headers.cookie = kept.join('; '); else delete headers.cookie;
  }
  return headers;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST) throw new Error('Request body exceeds 2 MB');
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}

export async function handlePublicRequest(req: IncomingMessage, res: ServerResponse, endpoint: Endpoint): Promise<void> {
  const tunnel = tunnels.get(endpoint.id);
  if (!tunnel || tunnel.readyState !== WebSocket.OPEN) { res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '5' }); res.end('This Endport endpoint is offline.'); return; }
  const visitor = String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? 'unknown');
  const rateKey = `${endpoint.id}:${visitor}`;
  const now = Date.now(); const rate = trafficRate.get(rateKey);
  if (!rate || rate.until < now) trafficRate.set(rateKey, { count: 1, until: now + 60_000 });
  else if (++rate.count > MAX_REQUESTS_PER_MINUTE) { res.writeHead(429, { 'Retry-After': '60' }); res.end('Too many requests.'); return; }
  const activeCount = [...pending.values()].filter((item) => item.endpointId === endpoint.id).length;
  if (activeCount >= MAX_ACTIVE) { res.writeHead(429); res.end('Endpoint is busy.'); return; }
  let body: Buffer;
  try { body = await readBody(req); } catch { res.writeHead(413); res.end('Request body exceeds 2 MB.'); return; }
  const id = randomUUID();
  const item = {
    endpointId: endpoint.id, res, timer: setTimeout(() => finishRequest(id, 504), REQUEST_TIMEOUT),
    started: Date.now(), method: req.method ?? 'GET', path: req.url ?? '/',
    bytesIn: body.length, bytesOut: 0, status: 502, headersSent: false, streaming: false, originMs: null as number | null,
    requestPreview: endpoint.capture_bodies ? jsonPreview(body, req.headers['content-type']) : null,
    responseParts: endpoint.capture_bodies ? [] as Buffer[] : null,
    responseContentType: undefined as string | string[] | undefined, responseComplete: false,
  };
  pending.set(id, item);
  res.on('close', () => {
    if (pending.has(id)) {
      sendTunnel(tunnel, { type: 'cancel', id });
      finishRequest(id, 499);
    }
  });
  sendTunnel(tunnel, { type: 'request', id, method: item.method, path: item.path,
    headers: cleanRequestHeaders(req, endpoint), body: body.toString('base64'), originalHost: req.headers.host ?? '' });
}

function finishRequest(id: string, status: number): void {
  const item = pending.get(id);
  if (!item) return;
  pending.delete(id);
  clearTimeout(item.timer);
  if (item.headersSent && status >= 500) item.res.destroy();
  else {
    if (!item.res.headersSent) item.res.writeHead(status, { 'Content-Type': 'text/plain' });
    if (!item.res.writableEnded) item.res.end(status >= 500 && !item.headersSent ? 'Upstream request failed.' : undefined);
  }
  let safePath = '/';
  try { safePath = new URL(item.path, 'http://local').pathname.slice(0, 2048); } catch { /* keep default */ }
  const responsePreview = item.responseComplete && item.responseParts ? jsonPreview(Buffer.concat(item.responseParts), item.responseContentType) : null;
  void pool.query('INSERT INTO request_logs(id,endpoint_id,method,path,status,duration_ms,origin_ms,bytes_in,bytes_out,request_preview,response_preview) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)',
    [id, item.endpointId, item.method, safePath, status, Date.now() - item.started, item.originMs, item.bytesIn, item.bytesOut,
      item.requestPreview === null ? null : JSON.stringify(item.requestPreview), responsePreview === null ? null : JSON.stringify(responsePreview)]).catch(console.error);
}

export function handlePublicUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, endpoint: Endpoint): void {
  const tunnel = tunnels.get(endpoint.id);
  if (!tunnel || tunnel.readyState !== WebSocket.OPEN) { socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  if ([...publicSockets.values()].filter((entry) => entry.endpointId === endpoint.id).length >= MAX_PUBLIC_SOCKETS) { socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  publicWsServer.handleUpgrade(req, socket, head, (publicWs) => {
    const id = randomUUID();
    publicSockets.set(id, { socket: publicWs, endpointId: endpoint.id });
    sendTunnel(tunnel, { type: 'ws-open', id, path: req.url ?? '/', headers: cleanRequestHeaders(req, endpoint) });
    publicWs.on('message', (data, binary) => {
      sendTunnel(tunnel, { type: 'ws-data', id, data: Buffer.from(data as Buffer).toString('base64'), binary });
    });
    publicWs.on('close', () => {
      publicSockets.delete(id);
      sendTunnel(tunnel, { type: 'ws-close', id });
    });
    publicWs.on('error', () => publicWs.terminate());
  });
}

const cleanup = setInterval(() => { for (const [key, state] of trafficRate) if (state.until < Date.now()) trafficRate.delete(key); }, 60_000);
cleanup.unref();

function forwardWebSocket(message: TunnelMessage, endpointId: string): void {
  const entry = publicSockets.get(message.id);
  if (!entry || entry.endpointId !== endpointId) return;
  const socket = entry.socket;
  if (message.type === 'ws-data' && socket.readyState === WebSocket.OPEN && message.data) {
    if (socket.bufferedAmount > MAX_BUFFERED) { socket.close(1013, 'Connection is too slow'); return; }
    socket.send(Buffer.from(message.data, 'base64'), { binary: !!message.binary });
  } else if (message.type === 'ws-close' || message.type === 'ws-error') {
    socket.close(message.type === 'ws-error' ? 1011 : 1000);
    publicSockets.delete(message.id);
  }
}
