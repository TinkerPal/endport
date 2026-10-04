#!/usr/bin/env node
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, chmod, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

type Config = { server?: string };
type ServiceIdentity = { endpointId: string; slug: string };
type Project = { version: 1 | 2; endpointId: string; slug: string; server: string; preferredName?: string; services?: Record<string, ServiceIdentity> };
type ServiceConfig = { name?: string; services: Record<string, { port: number; domain?: string }> };
type Message = { type: string; id: string; method?: string; path?: string; headers?: Record<string, string | string[]>; body?: string; originalHost?: string; data?: string; binary?: boolean };
const CONFIG_FILE = process.env.ENDPORT_CONFIG_FILE ?? path.join(homedir(), '.config', 'endport', 'config.json');
const IDENTITIES_DIR = path.join(path.dirname(CONFIG_FILE), 'identities');
const PROJECT_FILE = path.join(process.cwd(), '.endport.json');
const SERVICES_FILE = path.join(process.cwd(), 'endport.config.json');
const DEFAULT_SERVER = 'https://edge.endport.io';
const MAX_RESPONSE = 10 * 1024 * 1024;
const MAX_BUFFERED = 16 * 1024 * 1024;

async function config(): Promise<Config> {
  try { return JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as Config; }
  catch { return {}; }
}
async function saveCredential(endpointId: string, credential: string): Promise<void> {
  await mkdir(IDENTITIES_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(IDENTITIES_DIR, endpointId);
  await writeFile(file, credential, { flag: 'wx', mode: 0o600 });
  await chmod(file, 0o600);
}
async function project(): Promise<Project | null> {
  let raw: string;
  try { raw = await readFile(PROJECT_FILE, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: Partial<Project>;
  try { parsed = JSON.parse(raw) as Partial<Project>; }
  catch { throw new Error('.endport.json is invalid JSON'); }
  if ((parsed.version !== 1 && parsed.version !== 2) || typeof parsed.endpointId !== 'string' || typeof parsed.slug !== 'string' || typeof parsed.server !== 'string') throw new Error('.endport.json is invalid');
  return parsed as Project;
}
async function saveProject(current: Project): Promise<void> {
  const temporary = `${PROJECT_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o644 });
  await rename(temporary, PROJECT_FILE);
}
async function servicesConfig(): Promise<ServiceConfig> {
  let value: unknown;
  try { value = JSON.parse(await readFile(SERVICES_FILE, 'utf8')); }
  catch { throw new Error('Create endport.config.json with a services object before running endport start.'); }
  if (!value || typeof value !== 'object' || !('services' in value)) throw new Error('endport.config.json needs a services object.');
  const config = value as ServiceConfig;
  if (!config.services || typeof config.services !== 'object' || Array.isArray(config.services)) throw new Error('services must be an object.');
  const entries = Object.entries(config.services);
  if (entries.length < 1 || entries.length > 5) throw new Error('Configure between 1 and 5 services.');
  for (const [key, service] of entries) {
    if (!/^[a-z][a-z0-9-]{1,19}$/.test(key) || key.endsWith('-')) throw new Error(`Invalid service name: ${key}`);
    if (!service || !Number.isInteger(service.port) || service.port < 1 || service.port > 65535) throw new Error(`${key} needs a valid port.`);
    if (service.domain !== undefined && (typeof service.domain !== 'string' || !service.domain.includes('.'))) throw new Error(`${key} has an invalid domain.`);
  }
  return config;
}
function inferredName(): string {
  let name = path.basename(process.cwd()).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(name)) name = `app-${name}`;
  name = name.slice(0, 24).replace(/-+$/, '');
  return name.length >= 3 && !['www', 'app', 'api', 'admin', 'ingress', 'edge', 'status', 'mail', 'smtp', 'ftp', 'docs', 'support', 'logs', 'workspace'].includes(name) ? name : `app-${name || 'local'}`;
}
async function projectCredential(current: Project): Promise<string> {
  try { return (await readFile(path.join(IDENTITIES_DIR, current.endpointId), 'utf8')).trim(); }
  catch { throw new Error(`This machine has no owner credential for ${current.slug}. Restore ~/.config/endport/identities/ from your backup.`); }
}
function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function openBrowser(url: string): void {
  if (process.env.ENDPORT_NO_BROWSER === '1') return;
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => { /* URL is printed for manual use */ });
  child.unref();
}
async function api<T>(server: string, route: string, data: object, token?: string): Promise<T> {
  const response = await fetch(`${server}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}
async function newCode(args: string[]): Promise<void> {
  const current = await project();
  if (!current) throw new Error('Run endport 3000 in this project directory first.');
  const requested = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
  const selected = requested && current.services?.[requested] ? current.services[requested] : { endpointId: current.endpointId, slug: current.slug };
  if (requested && requested !== current.slug && !current.services?.[requested]) throw new Error(`Service ${requested} is not connected in this directory.`);
  const server = (option(args, '--server') ?? process.env.ENDPORT_SERVER ?? current.server).replace(/\/$/, '');
  if (server !== current.server) throw new Error(`This project belongs to ${current.server}; remove the other --server value.`);
  const credential = process.env.ENDPORT_CREDENTIAL ?? await projectCredential(current);
  const result = await api<{ code: string; logsUrl: string }>(server, '/api/cli/code', { name: selected.endpointId }, credential);
  console.log(`\n  Logs   ${result.logsUrl}\n  Code   ${result.code}  (valid for 10 minutes)\n`);
  openBrowser(result.logsUrl);
}
function send(ws: WebSocket, message: object): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > MAX_BUFFERED) { ws.terminate(); return; }
  ws.send(JSON.stringify(message));
}
function allowedHeaders(headers: Record<string, string | string[]> = {}): Record<string, string | string[]> {
  const excluded = new Set(['connection', 'transfer-encoding', 'content-length', 'host', 'upgrade', 'keep-alive']);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !excluded.has(key.toLowerCase())));
}
async function createInitialProject(server: string, preferredName: string): Promise<{ current: Project; credential: string }> {
  const initial = await api<{ credential: string; endpoint: { id: string; slug: string } }>(server, '/api/cli/init', { name: preferredName });
  const current: Project = { version: 1, endpointId: initial.endpoint.id, slug: initial.endpoint.slug, server, preferredName };
  await saveCredential(current.endpointId, initial.credential);
  await writeFile(PROJECT_FILE, `${JSON.stringify(current, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  console.log(`  ✓ This project is ${current.slug}. Back up ~/.config/endport/identities/ to keep ownership.`);
  return { current, credential: initial.credential };
}

async function expose(args: string[]): Promise<void> {
  const port = Number(args[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Specify a local port, for example: endport 3000');
  const settings = await config();
  let current = await project();
  const name = option(args, '--name'); const domain = option(args, '--domain'); const serviceName = option(args, '--service');
  const server = (option(args, '--server') ?? process.env.ENDPORT_SERVER ?? current?.server ?? settings.server ?? DEFAULT_SERVER).replace(/\/$/, '');
  if (current && current.server !== server) throw new Error(`This project belongs to ${current.server}; remove the other --server value.`);
  if (current && !serviceName && name && name !== current.slug && name !== current.preferredName) throw new Error(`This directory is already connected to ${current.slug}.`);
  if (serviceName && !current?.services?.[serviceName]) throw new Error(`Service ${serviceName} is not connected in this directory. Run endport start first.`);
  if (!current && domain) throw new Error('Connect this project before using a custom domain.');
  let credential: string;
  if (!current) {
    const preferredName = name ?? inferredName();
    ({ current, credential } = await createInitialProject(server, preferredName));
  } else credential = process.env.ENDPORT_CREDENTIAL ?? await projectCredential(current);
  const selected = serviceName ? current.services![serviceName] : { endpointId: current.endpointId, slug: current.slug };
  const connected = await api<{ endpoint: { id: string }; publicUrl: string; logsUrl: string }>(server, '/api/cli/connect', { name: selected.slug, domain }, credential);
  if (connected.endpoint.id !== selected.endpointId) throw new Error('Server returned a different app for this project.');
  const access = await api<{ code: string; logsUrl: string }>(server, '/api/cli/code', { name: connected.endpoint.id }, credential);
  console.log(`\n  Local   http://127.0.0.1:${port}\n  Public  ${connected.publicUrl}\n  Logs    ${connected.logsUrl}\n  Code    ${access.code}  (valid for 10 minutes)\n\n  Connecting…`);
  openBrowser(connected.logsUrl);
  const requests = new Map<string, ClientRequest>();
  const responses = new Map<string, IncomingMessage>();
  const sockets = new Map<string, { socket: WebSocket; queue: Message[] }>();
  let stopped = false; let attempts = 0; let activeWs: WebSocket | null = null;
  process.once('SIGINT', () => { stopped = true; activeWs?.close(); process.exit(0); });
  const connect = (): void => {
    const wsUrl = new URL(server);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.pathname = '/api/tunnel'; wsUrl.search = `endpoint=${encodeURIComponent(connected.endpoint.id)}`;
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${credential}` }, maxPayload: 4 * 1024 * 1024 });
    activeWs = ws;
    let awaitingPong = false;
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (awaitingPong) { ws.terminate(); return; }
      awaitingPong = true; ws.ping();
    }, 25_000);
    heartbeat.unref();
    ws.on('pong', () => { awaitingPong = false; });
    ws.on('open', () => { console.log('  Registering tunnel…'); });
    ws.on('message', (raw) => {
      let message: Message;
      try { message = JSON.parse(raw.toString()) as Message; } catch { return; }
      if (!message || typeof message.type !== 'string' || typeof message.id !== 'string') return;
      if (message.type === 'ready') { attempts = 0; console.log('  ✓ Tunnel connected'); return; }
      if (message.type === 'request') {
        const localStarted = performance.now();
        const headers = allowedHeaders(message.headers);
        headers['x-forwarded-host'] = message.originalHost ?? '';
        const local = httpRequest({ hostname: '127.0.0.1', port, method: message.method, path: message.path, headers }, (res) => {
          responses.set(message.id, res);
          const responseHeaders = allowedHeaders(res.headers as Record<string, string | string[]>);
          send(ws, { type: 'response-start', id: message.id, status: res.statusCode ?? 502, headers: responseHeaders });
          let size = 0;
          const streaming = String(res.headers['content-type'] ?? '').toLowerCase().includes('text/event-stream');
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (!streaming && size > MAX_RESPONSE) { res.destroy(); send(ws, { type: 'response-error', id: message.id }); return; }
            send(ws, { type: 'response-chunk', id: message.id, data: chunk.toString('base64') });
          });
          res.on('end', () => { requests.delete(message.id); responses.delete(message.id); send(ws, { type: 'response-end', id: message.id, originMs: Math.round(performance.now() - localStarted) }); });
          res.on('error', () => { requests.delete(message.id); responses.delete(message.id); send(ws, { type: 'response-error', id: message.id }); });
        });
        requests.set(message.id, local);
        local.on('error', () => { requests.delete(message.id); send(ws, { type: 'response-error', id: message.id }); });
        local.end(Buffer.from(message.body ?? '', 'base64'));
      } else if (message.type === 'cancel') {
        requests.get(message.id)?.destroy(); requests.delete(message.id);
        responses.get(message.id)?.destroy(); responses.delete(message.id);
      } else if (message.type === 'pause') {
        responses.get(message.id)?.pause();
      } else if (message.type === 'resume') {
        responses.get(message.id)?.resume();
      } else if (message.type === 'ws-open') {
        const local = new WebSocket(`ws://127.0.0.1:${port}${message.path ?? '/'}`, { headers: allowedHeaders(message.headers) });
        const state = { socket: local, queue: [] as Message[] }; sockets.set(message.id, state);
        local.on('open', () => { for (const queued of state.queue) local.send(Buffer.from(queued.data ?? '', 'base64'), { binary: !!queued.binary }); state.queue.length = 0; });
        local.on('message', (data, binary) => send(ws, { type: 'ws-data', id: message.id, data: Buffer.from(data as Buffer).toString('base64'), binary }));
        local.on('close', () => { sockets.delete(message.id); send(ws, { type: 'ws-close', id: message.id }); });
        local.on('error', () => { sockets.delete(message.id); send(ws, { type: 'ws-error', id: message.id }); });
      } else if (message.type === 'ws-data') {
        const state = sockets.get(message.id); if (!state) return;
        if (state.socket.readyState === WebSocket.OPEN) {
          if (state.socket.bufferedAmount > MAX_BUFFERED) { state.socket.close(1013, 'Connection is too slow'); return; }
          state.socket.send(Buffer.from(message.data ?? '', 'base64'), { binary: !!message.binary });
        }
        else if (state.queue.length < 16) state.queue.push(message);
      } else if (message.type === 'ws-close') {
        sockets.get(message.id)?.socket.close(); sockets.delete(message.id);
      }
    });
    ws.on('close', () => {
      clearInterval(heartbeat);
      if (activeWs === ws) activeWs = null;
      for (const request of requests.values()) request.destroy(); requests.clear();
      for (const response of responses.values()) response.destroy(); responses.clear();
      for (const state of sockets.values()) state.socket.close(); sockets.clear();
      if (!stopped) { const wait = Math.min(30_000, 1000 * 2 ** attempts++) + Math.floor(Math.random() * 400); console.log(`  Tunnel disconnected. Retrying in ${Math.ceil(wait / 1000)}s…`); setTimeout(connect, wait); }
    });
    ws.on('error', (error) => console.error(`  Connection error: ${error.message}`));
  };
  connect();
}

async function startServices(args: string[]): Promise<void> {
  const manifest = await servicesConfig();
  const services = Object.entries(manifest.services);
  const settings = await config();
  let current = await project();
  const server = (option(args, '--server') ?? process.env.ENDPORT_SERVER ?? current?.server ?? settings.server ?? DEFAULT_SERVER).replace(/\/$/, '');
  if (current && current.server !== server) throw new Error(`This project belongs to ${current.server}; remove the other --server value.`);
  let credential: string;
  if (!current) ({ current, credential } = await createInitialProject(server, manifest.name ?? inferredName()));
  else credential = process.env.ENDPORT_CREDENTIAL ?? await projectCredential(current);
  const assignments = { ...(current.services ?? {}) };
  if (!Object.keys(assignments).length) assignments[services[0][0]] = { endpointId: current.endpointId, slug: current.slug };
  for (const [key] of services) {
    if (assignments[key]) continue;
    const stem = current.slug.slice(0, Math.max(3, 30 - key.length)).replace(/-+$/, '');
    const result = await api<{ endpoint: { id: string; slug: string } }>(server, '/api/cli/service', { name: `${stem}-${key}` }, credential);
    assignments[key] = { endpointId: result.endpoint.id, slug: result.endpoint.slug };
  }
  current.services = assignments;
  current.version = 2;
  await saveProject(current);
  console.log(`\n  Endport project ${current.slug}\n`);
  const children = services.map(([key, service]) => {
    console.log(`  ${key.padEnd(12)} localhost:${service.port} → ${assignments[key].slug}.endport.io`);
    const child = spawn(process.execPath, [process.argv[1], String(service.port), '--service', key, '--server', server, ...(service.domain ? ['--domain', service.domain] : [])],
      { cwd: process.cwd(), env: { ...process.env, ENDPORT_NO_BROWSER: '1' }, stdio: 'inherit' });
    child.on('error', (error) => { console.error(`Endport: ${key}: ${error.message}`); for (const other of children) other.kill('SIGTERM'); });
    return child;
  });
  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    for (const child of children) if (child.exitCode === null) child.kill(signal);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  for (const child of children) child.on('exit', (code) => {
    if (!stopping) { stop('SIGTERM'); process.exitCode = code || 1; }
  });
  await new Promise<void>((resolve) => {
    let remaining = children.length;
    for (const child of children) child.on('exit', () => { if (--remaining === 0) resolve(); });
  });
}

function help(): void {
  console.log(`Endport — expose a local port\n\nRun these from your application directory:\n  endport 3000 [--name myapp]        Create or reconnect this app\n  endport start                     Connect services in endport.config.json\n  endport code [service]            Print a fresh logs code\n  endport 3000 --domain api.site.com Use a verified custom domain\n\nThe project marker is .endport.json. Private owner credentials are stored at ~/.config/endport/identities/. Back up that directory to keep ownership.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === 'code') await newCode(args.slice(1));
  else if (args[0] === 'start') await startServices(args.slice(1));
  else if (!args.length || args[0] === '--help' || args[0] === 'help') help();
  else await expose(args);
}
main().catch((error: unknown) => { console.error(`Endport: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
