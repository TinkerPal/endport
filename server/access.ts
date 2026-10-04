import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pool, type Endpoint } from './db.js';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const shareCookieName = (endpoint: Endpoint): string => `endport_access_${endpoint.slug}`;

function cookie(req: IncomingMessage, name: string): string | null {
  return (req.headers.cookie ?? '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}

async function activeShare(endpoint: Endpoint, token: string): Promise<{ expires_at: Date } | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const found = await pool.query<{ expires_at: Date }>(
    'SELECT expires_at FROM share_links WHERE endpoint_id=$1 AND token_hash=$2 AND revoked_at IS NULL AND expires_at>now()',
    [endpoint.id, hash(token)],
  );
  return found.rows[0] ?? null;
}

export async function visitorAuthorized(req: IncomingMessage, endpoint: Endpoint): Promise<boolean> {
  if (endpoint.access_mode === 'public') return true;
  const header = req.headers['x-endport-access-token'];
  const candidate = typeof header === 'string' ? header : cookie(req, shareCookieName(endpoint));
  return !!candidate && !!await activeShare(endpoint, candidate);
}

export async function enforceVisitorAccess(req: IncomingMessage, res: ServerResponse, endpoint: Endpoint, local: boolean): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://endport.local');
  const supplied = url.searchParams.get('endport_share');
  if (supplied && req.method === 'GET') {
    const share = await activeShare(endpoint, supplied);
    if (share) {
      const lifetime = Math.max(1, Math.floor((new Date(share.expires_at).getTime() - Date.now()) / 1000));
      url.searchParams.delete('endport_share');
      const destination = `${url.pathname}${url.search}${url.hash}`;
      res.writeHead(303, {
        Location: destination,
        'Set-Cookie': `${shareCookieName(endpoint)}=${supplied}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${lifetime}${local ? '' : '; Secure'}`,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      res.end();
      void pool.query('UPDATE share_links SET last_used_at=now() WHERE endpoint_id=$1 AND token_hash=$2', [endpoint.id, hash(supplied)]).catch(console.error);
      return false;
    }
    url.searchParams.delete('endport_share');
    res.writeHead(303, { Location: `${url.pathname}${url.search}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
    return false;
  }
  if (endpoint.access_mode === 'public') return true;
  if (await visitorAuthorized(req, endpoint)) return true;
  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('This Endport preview is private. Ask the owner for an access link.');
  return false;
}
