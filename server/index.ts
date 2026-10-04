import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { resolveCname, resolveTxt } from 'node:dns/promises';
import { WebSocketServer } from 'ws';
import { pool, migrate, type Agent, type Endpoint } from './db.js';
import { registerTunnel } from './tunnel.js';
import { enforceVisitorAccess, visitorAuthorized } from './access.js';
import { claimTunnel, endpointOnline, replayEndpoint, routeInternalRequest, routeInternalUpgrade, routePublicRequest, routePublicUpgrade } from './cluster.js';

const PORT = Number(process.env.PORT ?? 8080);
const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const PUBLIC_DOMAIN = (process.env.PUBLIC_DOMAIN ?? 'endport.io').toLowerCase();
const WORKSPACE_DOMAIN = `workspace.${PUBLIC_DOMAIN}`;
const GATEWAY_DOMAIN = `api.${PUBLIC_DOMAIN}`;
const LEGACY_LOGS_DOMAIN = `logs.${PUBLIC_DOMAIN}`;
const LOCAL = BASE_URL.startsWith('http://localhost') || BASE_URL.startsWith('http://127.0.0.1');
const DIST = path.resolve(process.cwd(), 'dist');
const RESERVED = new Set(['www', 'app', 'api', 'admin', 'ingress', 'edge', 'status', 'mail', 'smtp', 'ftp', 'docs', 'support', 'logs', 'workspace']);
const rates = new Map<string, { count: number; until: number }>();
const tunnelServer = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function token(): string { return randomBytes(32).toString('base64url'); }
function loginCode(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = randomBytes(10);
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}
function normalizeCode(value: string): string { return value.toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function value(input: unknown): string { return typeof input === 'string' ? input.trim() : ''; }
function host(req: IncomingMessage): string { return (req.headers.host ?? '').split(':')[0].toLowerCase(); }
function ip(req: IncomingMessage): string {
  const forwarded = req.headers['x-real-ip'];
  return typeof forwarded === 'string' && /^[a-fA-F0-9:.]+$/.test(forwarded) ? forwarded : req.socket.remoteAddress ?? 'unknown';
}
function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now(); const state = rates.get(key);
  if (!state || state.until < now) { rates.set(key, { count: 1, until: now + windowMs }); return false; }
  return ++state.count > max;
}
function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function fail(res: ServerResponse, status: number, error: string): void { json(res, status, { error }); }
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += chunk.length; if (length > 64 * 1024) throw new Error('Request is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; }
  catch { throw new Error('Invalid JSON'); }
}
function slugFrom(raw: string): string | null {
  const slug = raw.toLowerCase();
  return /^[a-z][a-z0-9-]{2,30}$/.test(slug) && !slug.endsWith('-') && !RESERVED.has(slug) ? slug : null;
}
function domainFrom(raw: string): string | null {
  const name = domainToASCII(raw.toLowerCase().replace(/\.$/, ''));
  return name && name.length <= 253 && name.split('.').length >= 3 && !name.endsWith(`.${PUBLIC_DOMAIN}`) &&
    /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name) && name.split('.').every((part) => part.length <= 63 && !part.startsWith('-') && !part.endsWith('-')) ? name : null;
}
function logsUrl(): string { return LOCAL ? `${BASE_URL}/logs` : `https://${WORKSPACE_DOMAIN}/`; }
function workspaceUrl(slug: string): string { return LOCAL ? `${BASE_URL}/logs/${slug}` : `https://${WORKSPACE_DOMAIN}/${slug}`; }
async function endpointView(endpoint: Endpoint): Promise<object> {
  return { id: endpoint.id, slug: endpoint.slug, publicUrl: `https://${endpoint.slug}.${PUBLIC_DOMAIN}`,
    logsUrl: logsUrl(), customDomain: endpoint.custom_domain, domainVerified: endpoint.domain_verified,
    verificationToken: endpoint.verification_token, accessMode: endpoint.access_mode, captureBodies: endpoint.capture_bodies, online: await endpointOnline(endpoint.id) };
}
async function agent(req: IncomingMessage): Promise<Agent | null> {
  const bearer = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (!bearer) return null;
  const found = await pool.query<Agent>('SELECT id FROM agents WHERE token_hash=$1', [hash(bearer)]);
  return found.rows[0] ?? null;
}
async function ownedEndpoint(ownerId: string, nameOrId: string): Promise<Endpoint | null> {
  const found = await pool.query<Endpoint>('SELECT * FROM endpoints WHERE owner_id=$1 AND (id=$2 OR slug=$2)', [ownerId, nameOrId]);
  return found.rows[0] ?? null;
}
async function publicEndpoint(hostname: string): Promise<Endpoint | null> {
  if (hostname.endsWith(`.${PUBLIC_DOMAIN}`)) {
    const slug = hostname.slice(0, -PUBLIC_DOMAIN.length - 1);
    if (!slug.includes('.')) {
      const found = await pool.query<Endpoint>('SELECT * FROM endpoints WHERE slug=$1 AND owner_id IS NOT NULL', [slug]);
      return found.rows[0] ?? null;
    }
  }
  const found = await pool.query<Endpoint>('SELECT * FROM endpoints WHERE custom_domain=$1 AND domain_verified=true AND owner_id IS NOT NULL', [hostname]);
  return found.rows[0] ?? null;
}
async function logsEndpoint(hostname: string, url: URL): Promise<Endpoint | null> {
  let slug: string | null = null;
  if (hostname === WORKSPACE_DOMAIN || hostname === GATEWAY_DOMAIN) slug = /^\/api\/logs\/([a-z0-9-]+)(?:\/|$)/.exec(url.pathname)?.[1] ?? (hostname === WORKSPACE_DOMAIN ? /^\/([a-z0-9-]+)(?:\/|$)/.exec(url.pathname)?.[1] : null) ?? null;
  if (LOCAL && (hostname === 'localhost' || hostname === '127.0.0.1')) slug = /^\/logs\/([a-z0-9-]+)(?:\/|$)/.exec(url.pathname)?.[1] ?? /^\/api\/logs\/([a-z0-9-]+)(?:\/|$)/.exec(url.pathname)?.[1] ?? null;
  if (!slug || !slugFrom(slug)) return null;
  const found = await pool.query<Endpoint>('SELECT * FROM endpoints WHERE slug=$1 AND owner_id IS NOT NULL', [slug]);
  return found.rows[0] ?? null;
}
async function createEndpoint(ownerId: string, slug: string): Promise<Endpoint> {
  const created = await pool.query<Endpoint>('INSERT INTO endpoints(id,owner_id,slug) VALUES($1,$2,$3) RETURNING *', [randomUUID(), ownerId, slug]);
  return created.rows[0];
}
async function issueCode(endpoint: Endpoint): Promise<{ code: string; expiresIn: number; logsUrl: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = loginCode();
    try {
      await pool.query("INSERT INTO dashboard_codes(endpoint_id,code_hash,expires_at) VALUES($1,$2,now()+interval '10 minutes') ON CONFLICT(endpoint_id) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at", [endpoint.id, hash(normalizeCode(code))]);
      return { code, expiresIn: 600, logsUrl: logsUrl() };
    } catch (error) { if ((error as { code?: string }).code !== '23505') throw error; }
  }
  throw new Error('Could not issue a unique login code');
}
async function routeCli(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET'; const pathname = url.pathname;
  if (pathname === '/api/cli/init' && method === 'POST') {
    if (limited(`init:${ip(req)}`, 10, 60 * 60_000)) { fail(res, 429, 'Too many new connections'); return; }
    const data = await body(req); const rawName = value(data.name);
    const preferred = rawName ? slugFrom(rawName) : `dev-${randomBytes(4).toString('hex')}`;
    if (!preferred) { fail(res, 400, 'Invalid app name'); return; }
    const credential = token(); const ownerId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO agents(id,token_hash) VALUES($1,$2)', [ownerId, hash(credential)]);
      let endpoint: Endpoint | null = null;
      for (let attempt = 0; attempt < 12 && !endpoint; attempt++) {
        const suffix = attempt === 0 ? '' : `-${randomBytes(2).toString('hex')}`;
        const slug = `${preferred.slice(0, 31 - suffix.length).replace(/-+$/, '')}${suffix}`;
        const created = await client.query<Endpoint>('INSERT INTO endpoints(id,owner_id,slug) VALUES($1,$2,$3) ON CONFLICT(slug) DO NOTHING RETURNING *', [randomUUID(), ownerId, slug]);
        endpoint = created.rows[0] ?? null;
      }
      if (!endpoint) throw new Error('Could not assign an app name');
      await client.query('COMMIT');
      json(res, 201, { credential, endpoint: await endpointView(endpoint) });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    return;
  }
  const owner = await agent(req);
  if (!owner) { fail(res, 401, 'CLI credential required'); return; }
  if (pathname === '/api/cli/service' && method === 'POST') {
    const data = await body(req); const preferred = slugFrom(value(data.name));
    if (!preferred) { fail(res, 400, 'Invalid service name'); return; }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [owner.id]);
      const count = await client.query<{ count: string }>('SELECT count(*) FROM endpoints WHERE owner_id=$1', [owner.id]);
      if (Number(count.rows[0].count) >= 5) { await client.query('ROLLBACK'); fail(res, 403, 'Limit: 5 services per project'); return; }
      let endpoint: Endpoint | null = null;
      for (let attempt = 0; attempt < 12 && !endpoint; attempt++) {
        const suffix = attempt === 0 ? '' : `-${randomBytes(2).toString('hex')}`;
        const slug = `${preferred.slice(0, 31 - suffix.length).replace(/-+$/, '')}${suffix}`;
        const found = await client.query<Endpoint>('INSERT INTO endpoints(id,owner_id,slug) VALUES($1,$2,$3) ON CONFLICT(slug) DO NOTHING RETURNING *', [randomUUID(), owner.id, slug]);
        endpoint = found.rows[0] ?? null;
      }
      if (!endpoint) throw new Error('Could not assign a service name');
      await client.query('COMMIT');
      json(res, 201, { endpoint: await endpointView(endpoint) });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return;
  }
  if (pathname === '/api/cli/connect' && method === 'POST') {
    const data = await body(req); const name = value(data.name); const domain = value(data.domain).toLowerCase();
    let endpoint: Endpoint | null = null;
    if (domain) {
      const found = await pool.query<Endpoint>('SELECT * FROM endpoints WHERE owner_id=$1 AND custom_domain=$2 AND domain_verified=true', [owner.id, domain]);
      endpoint = found.rows[0] ?? null;
      if (!endpoint) { fail(res, 404, 'Custom domain is not verified'); return; }
    } else if (name) {
      const slug = slugFrom(name); if (!slug) { fail(res, 400, 'Invalid app name'); return; }
      endpoint = await ownedEndpoint(owner.id, slug);
      if (!endpoint) {
        const count = await pool.query<{ count: string }>('SELECT count(*) FROM endpoints WHERE owner_id=$1', [owner.id]);
        if (Number(count.rows[0].count) >= 5) { fail(res, 403, 'Limit: 5 apps per CLI identity'); return; }
        try { endpoint = await createEndpoint(owner.id, slug); }
        catch (error) { if ((error as { code?: string }).code === '23505') { fail(res, 409, 'App name is already taken'); return; } throw error; }
      }
    } else {
      const found = await pool.query<Endpoint>('SELECT * FROM endpoints WHERE owner_id=$1 ORDER BY created_at LIMIT 1', [owner.id]);
      endpoint = found.rows[0] ?? null;
      if (!endpoint) { fail(res, 404, 'No app found'); return; }
    }
    json(res, 200, { endpoint: await endpointView(endpoint), publicUrl: domain ? `https://${domain}` : `https://${endpoint.slug}.${PUBLIC_DOMAIN}`, logsUrl: logsUrl() }); return;
  }
  if (pathname === '/api/cli/code' && method === 'POST') {
    const data = await body(req);
    let endpoint: Endpoint | null;
    if (value(data.name)) endpoint = await ownedEndpoint(owner.id, value(data.name));
    else {
      const found = await pool.query<Endpoint>('SELECT * FROM endpoints WHERE owner_id=$1 ORDER BY created_at LIMIT 1', [owner.id]);
      endpoint = found.rows[0] ?? null;
    }
    if (!endpoint) { fail(res, 404, 'App not found'); return; }
    json(res, 200, await issueCode(endpoint)); return;
  }
  fail(res, 404, 'Not found');
}

function cookieName(endpoint: Endpoint): string { return `endport_logs_${endpoint.slug}`; }
function dashboardCookie(req: IncomingMessage, endpoint: Endpoint): string | null {
  const name = cookieName(endpoint);
  return (req.headers.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}
async function dashboardAuthorized(req: IncomingMessage, endpoint: Endpoint): Promise<boolean> {
  const cookie = dashboardCookie(req, endpoint); if (!cookie) return false;
  const found = await pool.query('SELECT 1 FROM dashboard_sessions WHERE token_hash=$1 AND endpoint_id=$2 AND expires_at>now()', [hash(cookie), endpoint.id]);
  return !!found.rowCount;
}
function validLogsOrigin(req: IncomingMessage): boolean {
  const allowed = LOCAL ? [BASE_URL, `http://127.0.0.1:${PORT}`] : [`https://${WORKSPACE_DOMAIN}`];
  return typeof req.headers.origin === 'string' && allowed.includes(req.headers.origin);
}
async function routeCentralLogsLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') { fail(res, 405, 'Method not allowed'); return; }
  if (!validLogsOrigin(req)) { fail(res, 403, 'Invalid request origin'); return; }
  if (limited(`logs-global:${ip(req)}`, 20, 10 * 60_000)) { fail(res, 429, 'Too many attempts. Try again later.'); return; }
  const data = await body(req);
  const code = normalizeCode(value(data.code));
  if (code.length !== 10) { fail(res, 401, 'Invalid or expired code'); return; }
  const client = await pool.connect();
  let endpoint: Endpoint;
  let session: string;
  try {
    await client.query('BEGIN');
    const used = await client.query<{ endpoint_id: string }>('DELETE FROM dashboard_codes WHERE code_hash=$1 AND expires_at>now() RETURNING endpoint_id', [hash(code)]);
    if (!used.rows[0]) { await client.query('ROLLBACK'); fail(res, 401, 'Invalid or expired code'); return; }
    const found = await client.query<Endpoint>('SELECT * FROM endpoints WHERE id=$1 AND owner_id IS NOT NULL', [used.rows[0].endpoint_id]);
    if (!found.rows[0]) { await client.query('ROLLBACK'); fail(res, 401, 'Invalid or expired code'); return; }
    endpoint = found.rows[0];
    session = token();
    await client.query("INSERT INTO dashboard_sessions(token_hash,endpoint_id,expires_at) VALUES($1,$2,now()+interval '24 hours')", [hash(session), endpoint.id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  res.setHeader('Set-Cookie', `${cookieName(endpoint)}=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${LOCAL ? '' : '; Secure'}`);
  json(res, 200, { workspaceUrl: workspaceUrl(endpoint.slug) });
}
async function routeLogs(req: IncomingMessage, res: ServerResponse, url: URL, endpoint: Endpoint): Promise<void> {
  const method = req.method ?? 'GET';
  const action = /^\/api\/logs\/[^/]+\/([^/]+)$/.exec(url.pathname)?.[1];
  if (!action) { fail(res, 404, 'Not found'); return; }
  if (method === 'POST' && req.headers.origin && !validLogsOrigin(req)) { fail(res, 403, 'Invalid request origin'); return; }
  if (action === 'login' && method === 'POST') {
    if (limited(`logs:${endpoint.id}:${ip(req)}`, 5, 10 * 60_000)) { fail(res, 429, 'Too many attempts. Try again later.'); return; }
    const data = await body(req); const code = normalizeCode(value(data.code));
    if (code.length !== 10) { fail(res, 401, 'Invalid or expired code'); return; }
    const used = await pool.query('DELETE FROM dashboard_codes WHERE endpoint_id=$1 AND code_hash=$2 AND expires_at>now() RETURNING endpoint_id', [endpoint.id, hash(code)]);
    if (!used.rowCount) { fail(res, 401, 'Invalid or expired code'); return; }
    const session = token();
    await pool.query("INSERT INTO dashboard_sessions(token_hash,endpoint_id,expires_at) VALUES($1,$2,now()+interval '24 hours')", [hash(session), endpoint.id]);
    res.setHeader('Set-Cookie', `${cookieName(endpoint)}=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${LOCAL ? '' : '; Secure'}`);
    json(res, 200, { endpoint: await endpointView(endpoint) }); return;
  }
  if (!await dashboardAuthorized(req, endpoint)) { fail(res, 401, 'Enter the code printed by your CLI'); return; }
  if (method === 'POST' && !validLogsOrigin(req)) { fail(res, 403, 'Invalid request origin'); return; }
  if (action === 'session' && method === 'GET') { json(res, 200, { endpoint: await endpointView(endpoint) }); return; }
  if (action === 'logout' && method === 'POST') {
    const cookie = dashboardCookie(req, endpoint)!;
    await pool.query('DELETE FROM dashboard_sessions WHERE token_hash=$1', [hash(cookie)]);
    res.setHeader('Set-Cookie', `${cookieName(endpoint)}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${LOCAL ? '' : '; Secure'}`);
    json(res, 200, { ok: true }); return;
  }
  if (action === 'access' && method === 'POST') {
    const data = await body(req);
    if (data.mode !== 'public' && data.mode !== 'restricted') { fail(res, 400, 'Choose public or restricted access'); return; }
    const changed = await pool.query<Endpoint>('UPDATE endpoints SET access_mode=$1 WHERE id=$2 RETURNING *', [data.mode, endpoint.id]);
    json(res, 200, { endpoint: await endpointView(changed.rows[0]) }); return;
  }
  if (action === 'capture' && method === 'POST') {
    const data = await body(req);
    if (typeof data.enabled !== 'boolean') { fail(res, 400, 'Choose whether to capture JSON previews'); return; }
    const changed = await pool.query<Endpoint>('UPDATE endpoints SET capture_bodies=$1 WHERE id=$2 RETURNING *', [data.enabled, endpoint.id]);
    json(res, 200, { endpoint: await endpointView(changed.rows[0]) }); return;
  }
  if (action === 'shares' && method === 'GET') {
    const found = await pool.query('SELECT id,label,expires_at,revoked_at,created_at,last_used_at FROM share_links WHERE endpoint_id=$1 ORDER BY created_at DESC LIMIT 100', [endpoint.id]);
    json(res, 200, { shares: found.rows }); return;
  }
  if (action === 'shares' && method === 'POST') {
    if (limited(`shares:${endpoint.id}`, 20, 60 * 60_000)) { fail(res, 429, 'Too many access links created'); return; }
    const data = await body(req); const label = value(data.label).slice(0, 80) || 'Visitor';
    const hours = Number(data.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) { fail(res, 400, 'Choose an expiry from 1 to 168 hours'); return; }
    const secret = token(); const id = randomUUID();
    const client = await pool.connect();
    let share: Record<string, unknown>;
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM endpoints WHERE id=$1 FOR UPDATE', [endpoint.id]);
      const active = await client.query<{ count: string }>('SELECT count(*) FROM share_links WHERE endpoint_id=$1 AND revoked_at IS NULL AND expires_at>now()', [endpoint.id]);
      if (Number(active.rows[0].count) >= 25) { await client.query('ROLLBACK'); fail(res, 403, 'Limit: 25 active access links per app'); return; }
      const found = await client.query('INSERT INTO share_links(id,endpoint_id,token_hash,label,expires_at) VALUES($1,$2,$3,$4,now()+($5::int * interval \'1 hour\')) RETURNING id,label,expires_at,created_at', [id, endpoint.id, hash(secret), label, hours]);
      share = found.rows[0];
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    const link = `https://${endpoint.slug}.${PUBLIC_DOMAIN}/?endport_share=${secret}`;
    json(res, 201, { share, link }); return;
  }
  if (action === 'revoke-share' && method === 'POST') {
    const data = await body(req);
    const found = await pool.query('UPDATE share_links SET revoked_at=now() WHERE id=$1 AND endpoint_id=$2 AND revoked_at IS NULL RETURNING id', [value(data.id), endpoint.id]);
    if (!found.rowCount) { fail(res, 404, 'Access link not found'); return; }
    json(res, 200, { ok: true }); return;
  }
  if (action === 'requests' && method === 'GET') {
    const search = value(url.searchParams.get('q')).slice(0, 120);
    const status = value(url.searchParams.get('status'));
    const before = value(url.searchParams.get('before'));
    if (status && !/^[2-5]xx$/.test(status)) { fail(res, 400, 'Invalid status filter'); return; }
    let cursor: { at: string; id: string } | null = null;
    if (before) {
      try {
        if (before.length > 200) throw new Error();
        cursor = JSON.parse(Buffer.from(before, 'base64url').toString('utf8')) as { at: string; id: string };
        if (!cursor || Number.isNaN(Date.parse(cursor.at)) || !/^[0-9a-f-]{36}$/.test(cursor.id)) throw new Error();
      } catch { fail(res, 400, 'Invalid pagination cursor'); return; }
    }
    const args: unknown[] = [endpoint.id];
    const conditions = ['endpoint_id=$1'];
    if (search) { args.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`); conditions.push(`(path ILIKE $${args.length} ESCAPE '\\' OR method ILIKE $${args.length} ESCAPE '\\')`); }
    if (status) { args.push(Number(status[0]) * 100); conditions.push(`status >= $${args.length} AND status < $${args.length}+100`); }
    if (cursor) { args.push(new Date(cursor.at).toISOString(), cursor.id); conditions.push(`(created_at,id) < ($${args.length - 1}::timestamptz,$${args.length})`); }
    const found = await pool.query(`SELECT id,method,path,status,duration_ms,origin_ms,bytes_in,bytes_out,request_preview,response_preview,created_at FROM request_logs WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT 101`, args);
    const rows = found.rows.slice(0, 100);
    const last = rows.at(-1);
    const nextBefore = found.rows.length > 100 && last ? Buffer.from(JSON.stringify({ at: last.created_at, id: last.id })).toString('base64url') : null;
    json(res, 200, { requests: rows, nextBefore }); return;
  }
  if (action === 'replay' && method === 'POST') {
    if (limited(`replay:${endpoint.id}`, 30, 60 * 60_000)) { fail(res, 429, 'Replay limit reached'); return; }
    const data = await body(req);
    const found = await pool.query<{ method: string; path: string }>('SELECT method,path FROM request_logs WHERE id=$1 AND endpoint_id=$2', [value(data.id), endpoint.id]);
    const original = found.rows[0];
    if (!original) { fail(res, 404, 'Request not found'); return; }
    if (!['GET', 'HEAD'].includes(original.method)) { fail(res, 400, 'Only bodyless GET and HEAD requests can be replayed'); return; }
    try { json(res, 200, { replay: await replayEndpoint(endpoint, original.method, original.path) }); }
    catch (error) { fail(res, 503, error instanceof Error ? error.message : 'Replay failed'); }
    return;
  }
  if (action === 'stats' && method === 'GET') {
    const found = await pool.query("SELECT count(*)::int AS requests, count(*) FILTER (WHERE status>=500)::int AS errors, coalesce(round(avg(duration_ms)),0)::int AS avg_ms, coalesce(sum(bytes_in+bytes_out),0)::bigint AS bytes FROM request_logs WHERE endpoint_id=$1 AND created_at>now()-interval '24 hours'", [endpoint.id]);
    json(res, 200, { stats: found.rows[0] }); return;
  }
  if (action === 'analytics' && method === 'GET') {
    const [hourly, routes] = await Promise.all([
      pool.query("SELECT date_trunc('hour',created_at) AS hour,count(*)::int AS requests,count(*) FILTER (WHERE status>=500)::int AS errors FROM request_logs WHERE endpoint_id=$1 AND created_at>now()-interval '24 hours' GROUP BY 1 ORDER BY 1", [endpoint.id]),
      pool.query("SELECT path,count(*)::int AS requests,coalesce(round(avg(duration_ms)),0)::int AS avg_ms FROM request_logs WHERE endpoint_id=$1 AND created_at>now()-interval '24 hours' GROUP BY path ORDER BY requests DESC,path LIMIT 8", [endpoint.id]),
    ]);
    json(res, 200, { hourly: hourly.rows, routes: routes.rows }); return;
  }
  if (action === 'domain' && method === 'POST') {
    const data = await body(req); const domain = domainFrom(value(data.domain));
    if (!domain) { fail(res, 400, 'Use a subdomain such as api.example.com'); return; }
    try {
      const verification = token().slice(0, 24);
      const found = await pool.query<Endpoint>('UPDATE endpoints SET custom_domain=$1,verification_token=$2,domain_verified=false WHERE id=$3 RETURNING *', [domain, verification, endpoint.id]);
      json(res, 200, { endpoint: await endpointView(found.rows[0]), dns: { cname: `CNAME ${domain} ingress.${PUBLIC_DOMAIN}`, txt: `TXT _endport.${domain} ${verification}` } });
    } catch (error) { if ((error as { code?: string }).code === '23505') fail(res, 409, 'Domain already in use'); else throw error; }
    return;
  }
  if (action === 'verify' && method === 'POST') {
    if (!endpoint.custom_domain || !endpoint.verification_token) { fail(res, 400, 'Add a domain first'); return; }
    let cname: string[] = []; let txt: string[][] = [];
    try { cname = await resolveCname(endpoint.custom_domain); } catch { /* DNS may not have propagated */ }
    try { txt = await resolveTxt(`_endport.${endpoint.custom_domain}`); } catch { /* DNS may not have propagated */ }
    if (!cname.some((item) => item.toLowerCase().replace(/\.$/, '') === `ingress.${PUBLIC_DOMAIN}`) || !txt.some((parts) => parts.join('') === endpoint.verification_token)) { fail(res, 400, 'DNS records are not visible yet'); return; }
    const found = await pool.query<Endpoint>('UPDATE endpoints SET domain_verified=true WHERE id=$1 RETURNING *', [endpoint.id]);
    json(res, 200, { endpoint: await endpointView(found.rows[0]) }); return;
  }
  fail(res, 404, 'Not found');
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
  if (file.includes('..') || file.startsWith('.')) { fail(res, 404, 'Not found'); return; }
  const filename = path.join(DIST, file);
  try {
    const info = await stat(filename); if (!info.isFile()) { fail(res, 404, 'Not found'); return; }
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.tgz': 'application/gzip' };
    const ext = path.extname(filename);
    res.writeHead(200, { 'Content-Type': types[ext] ?? 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable' });
    res.end(req.method === 'HEAD' ? undefined : await readFile(filename));
  } catch { fail(res, 404, 'Not found'); }
}
function securityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if (!LOCAL) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', BASE_URL); const hostname = host(req);
    if (url.pathname === '/internal/tls-check') {
      const domain = value(url.searchParams.get('domain')).toLowerCase();
      const valid = domain === GATEWAY_DOMAIN || domain === `ingress.${PUBLIC_DOMAIN}` || domain === LEGACY_LOGS_DOMAIN || !!await publicEndpoint(domain);
      res.writeHead(valid ? 200 : 403); res.end(); return;
    }
    if (url.pathname === '/api/health') { await pool.query('SELECT 1'); json(res, 200, { ok: true }); return; }
    if (await routeInternalRequest(req, res, url)) return;
    if (hostname === LEGACY_LOGS_DOMAIN) {
      if (req.method === 'GET' || req.method === 'HEAD') res.writeHead(308, { Location: `https://${WORKSPACE_DOMAIN}${req.url ?? '/'}`, 'Cache-Control': 'no-store' });
      else res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'GET' || req.method === 'HEAD' ? undefined : `Open https://${WORKSPACE_DOMAIN}/ and enter a fresh terminal code.`);
      return;
    }
    if (url.pathname === '/log' && (hostname === WORKSPACE_DOMAIN || (LOCAL && (hostname === 'localhost' || hostname === '127.0.0.1')))) {
      res.writeHead(308, { Location: LOCAL ? '/logs' : '/', 'Cache-Control': 'no-store' }); res.end(); return;
    }
    if (url.pathname === '/api/logs/login' && (hostname === WORKSPACE_DOMAIN || hostname === GATEWAY_DOMAIN || (LOCAL && (hostname === 'localhost' || hostname === '127.0.0.1')))) { securityHeaders(res); await routeCentralLogsLogin(req, res); return; }
    if ((hostname === WORKSPACE_DOMAIN && url.pathname === '/') || (LOCAL && (hostname === 'localhost' || hostname === '127.0.0.1') && url.pathname === '/logs')) {
      securityHeaders(res);
      if (req.method !== 'GET' && req.method !== 'HEAD') { fail(res, 405, 'Method not allowed'); return; }
      await serveStatic(req, res, 'logs-home.html'); return;
    }
    if (hostname === WORKSPACE_DOMAIN && url.pathname.startsWith('/assets/')) { securityHeaders(res); await serveStatic(req, res, url.pathname.slice(1)); return; }
    const logs = await logsEndpoint(hostname, url);
    if (logs) {
      securityHeaders(res);
      if (url.pathname.startsWith('/api/logs/')) { await routeLogs(req, res, url, logs); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { fail(res, 405, 'Method not allowed'); return; }
      if (url.pathname === `/${logs.slug}` || url.pathname === `/logs/${logs.slug}` || url.pathname === '/') { await serveStatic(req, res, 'app.html'); return; }
      if (url.pathname.startsWith('/assets/')) { await serveStatic(req, res, url.pathname.slice(1)); return; }
      fail(res, 404, 'Not found'); return;
    }
    if (hostname === GATEWAY_DOMAIN && url.pathname.startsWith('/api/cli/')) { securityHeaders(res); await routeCli(req, res, url); return; }
    if (hostname !== PUBLIC_DOMAIN && hostname !== GATEWAY_DOMAIN && hostname !== 'localhost' && hostname !== '127.0.0.1') {
      const endpoint = await publicEndpoint(hostname);
      if (!endpoint) { fail(res, 404, 'Unknown endpoint'); return; }
      if (!await enforceVisitorAccess(req, res, endpoint, LOCAL)) return;
      await routePublicRequest(req, res, endpoint); return;
    }
    securityHeaders(res);
    if (url.pathname.startsWith('/api/cli/')) { await routeCli(req, res, url); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { fail(res, 405, 'Method not allowed'); return; }
    await serveStatic(req, res, url.pathname === '/' ? 'index.html' : url.pathname === '/docs' ? 'docs.html' : url.pathname === '/get-started' ? 'get-started.html' : url.pathname.slice(1));
  } catch (error) {
    console.error(error);
    const bad = error instanceof Error && ['Invalid JSON', 'Request is too large'].includes(error.message);
    if (!res.headersSent) fail(res, bad ? 400 : 500, bad ? (error as Error).message : 'Internal server error');
    else res.end();
  }
});

server.on('upgrade', async (req, socket, head) => {
  try {
    const url = new URL(req.url ?? '/', BASE_URL);
    if (await routeInternalUpgrade(req, socket, head, url)) return;
    if (url.pathname === '/api/tunnel') {
      const owner = await agent(req); if (!owner) { socket.destroy(); return; }
      const endpoint = await ownedEndpoint(owner.id, value(url.searchParams.get('endpoint')));
      if (!endpoint) { socket.destroy(); return; }
      const bearer = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')![1];
      tunnelServer.handleUpgrade(req, socket, head, (ws) => {
        void claimTunnel(endpoint.id, ws).then(() => registerTunnel(endpoint.id, ws, hash(bearer)))
          .catch((error) => { console.error(error); ws.close(1011, 'Could not register tunnel'); });
      }); return;
    }
    const endpoint = await publicEndpoint(host(req));
    if (!endpoint) { socket.destroy(); return; }
    if (!await visitorAuthorized(req, endpoint)) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    await routePublicUpgrade(req, socket, head, endpoint);
  } catch (error) { console.error(error); socket.destroy(); }
});

await migrate();
server.listen(PORT, '0.0.0.0', () => console.log(`Endport listening on ${PORT}`));
const cleanup = setInterval(() => {
  void pool.query("DELETE FROM dashboard_sessions WHERE expires_at<now(); DELETE FROM dashboard_codes WHERE expires_at<now(); DELETE FROM share_links WHERE expires_at<now()-interval '7 days'; DELETE FROM tunnel_leases WHERE lease_expires_at<now(); DELETE FROM request_logs WHERE created_at<now()-interval '7 days'").catch(console.error);
  for (const [key, state] of rates) if (state.until < Date.now()) rates.delete(key);
}, 60 * 60_000);
cleanup.unref();
process.on('SIGTERM', () => server.close(() => { void pool.end().then(() => process.exit(0)); }));
