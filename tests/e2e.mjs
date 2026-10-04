import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';

const base = 'http://127.0.0.1:8080';
const slug = `test-${randomBytes(5).toString('hex')}`;
const configFile = path.join(await mkdtemp(path.join(tmpdir(), 'endport-e2e-')), 'config.json');
const projectDir = await mkdtemp(path.join(tmpdir(), 'endport-project-'));
const secondProjectDir = await mkdtemp(path.join(tmpdir(), 'endport-project-'));
const cliScript = path.resolve('packages/cli/dist/index.js');
let cli;
let secondCli;
let servicesCli;
let remoteCli;

async function post(route, data, cookie) {
  const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8080', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
  const result = await response.json();
  return { response, result };
}

async function getOnHost(route, hostname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${route}`, { headers: { Host: hostname, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

const local = createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: first\n\n');
    setTimeout(() => { res.write('data: second\n\n'); res.end(); }, 60);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ path: req.url, method: req.method }));
});
const localWs = new WebSocketServer({ noServer: true });
local.on('upgrade', (req, socket, head) => localWs.handleUpgrade(req, socket, head, (ws) => ws.on('message', (data) => ws.send(data))));

try {
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  const website = await fetch(base); assert.equal(website.status, 200);
  const websiteHtml = await website.text(); assert(websiteHtml.includes('Localhost'));
  assert(websiteHtml.includes('href="/get-started"'));
  assert(websiteHtml.includes('Open Workspace'));
  const guide = await fetch(`${base}/get-started`); assert.equal(guide.status, 200);
  const guideHtml = await guide.text();
  assert(guideHtml.includes('Point Endport at the port'));
  assert(guideHtml.includes('href="/get-started" aria-current="page"'));
  assert(guideHtml.includes('>Documentation</a><a href="/get-started" aria-current="page">Get Started</a>'));
  assert(guideHtml.includes('aria-label="Footer navigation"'));
  const localLogsHome = await fetch(`${base}/logs`); assert.equal(localLogsHome.status, 200);
  assert.equal((await fetch(`${base}/log`, { redirect: 'manual' })).headers.get('location'), '/logs');
  assert((await localLogsHome.text()).includes('TERMINAL CODE'));
  const centralLogsHome = await getOnHost('/', 'workspace.endport.io'); assert.equal(centralLogsHome.status, 200);
  assert(centralLogsHome.body.includes('Open your logs'));
  const portalAsset = /src="(\/assets\/logsHome-[^"]+\.js)"/.exec(centralLogsHome.body)?.[1];
  assert(portalAsset);
  assert.equal((await getOnHost(portalAsset, 'workspace.endport.io')).status, 200);
  const legacyWorkspace = await getOnHost('/old-app', 'logs.endport.io');
  assert.equal(legacyWorkspace.status, 308);
  assert.equal(legacyWorkspace.headers.location, 'https://workspace.endport.io/old-app');
  const docs = await fetch(`${base}/docs`); assert.equal(docs.status, 200); assert((await docs.text()).includes('Troubleshooting'));
  assert.equal((await fetch(`${base}/internal/tls-check?domain=edge.endport.io`)).status, 200);
  assert.equal((await fetch(`${base}/internal/tls-check?domain=workspace.endport.io`)).status, 403);
  assert.equal((await fetch(`${base}/downloads/endport-cli-0.1.0.tgz`)).status, 200);
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  const localPort = local.address().port;

  cli = spawn(process.execPath, [cliScript, String(localPort), '--name', slug, '--server', base], {
    cwd: projectDir, env: { ...process.env, ENDPORT_CONFIG_FILE: configFile, ENDPORT_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI did not connect: ${output}`)), 15000);
    cli.stdout.on('data', (chunk) => { output += chunk.toString(); if (output.includes('Tunnel connected')) { clearTimeout(timer); resolve(); } });
    cli.stderr.on('data', (chunk) => process.stderr.write(chunk));
    cli.on('exit', (code) => { clearTimeout(timer); reject(new Error(`CLI exited ${code}: ${output}`)); });
  });
  const code = /Code\s+([A-Z0-9]{5}-[A-Z0-9]{5})/.exec(output)?.[1];
  assert(code, output);
  assert(output.includes(`https://${slug}.endport.io`));
  assert(output.includes('http://localhost:8080/logs'));
  const marker = JSON.parse(await readFile(path.join(projectDir, '.endport.json'), 'utf8'));
  assert.equal(marker.slug, slug);
  const credential = await readFile(path.join(path.dirname(configFile), 'identities', marker.endpointId), 'utf8');
  assert(credential.length > 30);
  assert(!JSON.stringify(marker).includes(credential));

  secondCli = spawn(process.execPath, [cliScript, String(localPort), '--name', slug, '--server', base], {
    cwd: secondProjectDir, env: { ...process.env, ENDPORT_CONFIG_FILE: configFile, ENDPORT_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let secondOutput = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Second CLI did not connect: ${secondOutput}`)), 15000);
    secondCli.stdout.on('data', (chunk) => { secondOutput += chunk.toString(); if (secondOutput.includes('Tunnel connected')) { clearTimeout(timer); resolve(); } });
    secondCli.stderr.on('data', (chunk) => process.stderr.write(chunk));
    secondCli.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Second CLI exited ${code}: ${secondOutput}`)); });
  });
  const secondMarker = JSON.parse(await readFile(path.join(secondProjectDir, '.endport.json'), 'utf8'));
  assert.match(secondMarker.slug, new RegExp(`^${slug}-[a-f0-9]{4}$`));
  assert(secondOutput.includes(`https://${secondMarker.slug}.endport.io`));
  assert.notEqual(secondMarker.endpointId, marker.endpointId);
  const secondCredential = await readFile(path.join(path.dirname(configFile), 'identities', secondMarker.endpointId), 'utf8');
  assert.notEqual(secondCredential, credential);
  const secondCode = /Code\s+([A-Z0-9]{5}-[A-Z0-9]{5})/.exec(secondOutput)?.[1];
  assert(secondCode);
  assert.equal((await post(`/api/logs/${slug}/login`, { code: secondCode })).response.status, 401);
  const secondLogin = await post(`/api/logs/${secondMarker.slug}/login`, { code: secondCode });
  assert.equal(secondLogin.response.status, 200);
  const secondCookie = secondLogin.response.headers.get('set-cookie')?.split(';')[0];
  assert(secondCookie?.startsWith(`endport_logs_${secondMarker.slug}=`));

  const logPage = await fetch(`${base}/logs/${slug}`); assert.equal(logPage.status, 200);
  assert((await logPage.text()).includes('One-time terminal code'));
  const centralPage = await getOnHost(`/${slug}`, 'workspace.endport.io');
  assert.equal(centralPage.status, 200, `${slug}: ${centralPage.body}`);
  const centralHtml = centralPage.body;
  const asset = /src="(\/assets\/app-[^"]+\.js)"/.exec(centralHtml)?.[1];
  assert(asset);
  assert.equal((await getOnHost(asset, 'workspace.endport.io')).status, 200);
  assert.equal((await fetch(`${base}/api/logs/${slug}/session`)).status, 401);
  const wrong = await post('/api/logs/login', { code: 'AAAAA-AAAAA' }); assert.equal(wrong.response.status, 401);
  const login = await post('/api/logs/login', { code }); assert.equal(login.response.status, 200);
  assert.equal(login.result.workspaceUrl, `http://localhost:8080/logs/${slug}`);
  const cookie = login.response.headers.get('set-cookie')?.split(';')[0]; assert(cookie);
  assert(cookie.startsWith(`endport_logs_${slug}=`));
  assert.equal((await fetch(`${base}/api/logs/${slug}/session`, { headers: { Cookie: secondCookie } })).status, 401);
  const reused = await post('/api/logs/login', { code }); assert.equal(reused.response.status, 401);

  const publicResponse = await new Promise((resolve, reject) => {
    const req = request(`${base}/api/check?secret=query-value`, { method: 'POST', headers: { Host: `${slug}.endport.io` } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end('body');
  });
  assert.equal(publicResponse.status, 200);
  assert.deepEqual(JSON.parse(publicResponse.body), { path: '/api/check?secret=query-value', method: 'POST' });

  const events = await new Promise((resolve, reject) => {
    const req = request(`${base}/events`, { headers: { Host: `${slug}.endport.io` } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    }); req.on('error', reject); req.end();
  });
  assert(events.includes('data: first') && events.includes('data: second'));
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:8080/echo`, { headers: { Host: `${slug}.endport.io` } });
    const timer = setTimeout(() => reject(new Error('WebSocket timed out')), 10000);
    ws.on('open', () => ws.send('echo-me'));
    ws.on('message', (data) => { assert.equal(data.toString(), 'echo-me'); clearTimeout(timer); ws.close(); resolve(); });
    ws.on('error', reject);
  });

  const session = await fetch(`${base}/api/logs/${slug}/session`, { headers: { Cookie: cookie } }).then((res) => res.json());
  assert(session.endpoint.online);
  const logs = await fetch(`${base}/api/logs/${slug}/requests`, { headers: { Cookie: cookie } }).then((res) => res.json());
  assert(logs.requests.some((item) => item.path === '/api/check' && item.status === 200));
  assert(logs.requests.some((item) => item.path === '/api/check' && Number.isInteger(item.origin_ms)));
  assert(!JSON.stringify(logs).includes('query-value'));
  const filtered = await fetch(`${base}/api/logs/${slug}/requests?q=api%2Fcheck&status=2xx`, { headers: { Cookie: cookie } }).then((res) => res.json());
  assert(filtered.requests.some((item) => item.path === '/api/check'));
  assert(filtered.requests.every((item) => item.status >= 200 && item.status < 300));
  assert.equal((await post(`/api/logs/${slug}/capture`, { enabled: true }, cookie)).response.status, 200);
  await new Promise((resolve, reject) => {
    const req = request(`${base}/capture-check`, { method: 'POST', headers: { Host: `${slug}.endport.io`, 'Content-Type': 'application/json' } }, (res) => {
      res.resume(); res.on('end', resolve);
    }); req.on('error', reject); req.end(JSON.stringify({ password: 'hidden-value', note: 'safe-value' }));
  });
  assert.equal((await getOnHost('/replay-source', `${slug}.endport.io`)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const captured = await fetch(`${base}/api/logs/${slug}/requests`, { headers: { Cookie: cookie } }).then((res) => res.json());
  const preview = captured.requests.find((item) => item.path === '/capture-check');
  assert.equal(preview.request_preview.password, '[REDACTED]');
  assert.equal(preview.request_preview.note, 'safe-value');
  assert(!JSON.stringify(preview).includes('hidden-value'));
  const replaySource = captured.requests.find((item) => item.path === '/replay-source');
  assert(replaySource);
  const replayed = await post(`/api/logs/${slug}/replay`, { id: replaySource.id }, cookie);
  assert.equal(replayed.response.status, 200);
  assert.equal(replayed.result.replay.status, 200);
  assert.equal((await post(`/api/logs/${slug}/replay`, { id: preview.id }, cookie)).response.status, 400);
  assert.equal((await post(`/api/logs/${slug}/capture`, { enabled: false }, cookie)).response.status, 200);
  for (let index = 0; index < 101; index++) assert.equal((await getOnHost(`/page-${index}`, `${slug}.endport.io`)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const firstPage = await fetch(`${base}/api/logs/${slug}/requests`, { headers: { Cookie: cookie } }).then((res) => res.json());
  assert.equal(firstPage.requests.length, 100);
  assert(firstPage.nextBefore);
  const olderPage = await fetch(`${base}/api/logs/${slug}/requests?before=${encodeURIComponent(firstPage.nextBefore)}`, { headers: { Cookie: cookie } }).then((res) => res.json());
  assert(olderPage.requests.length > 0);
  assert(!olderPage.requests.some((item) => firstPage.requests.some((first) => first.id === item.id)));
  const restricted = await post(`/api/logs/${slug}/access`, { mode: 'restricted' }, cookie);
  assert.equal(restricted.response.status, 200);
  assert.equal((await getOnHost('/private', `${slug}.endport.io`)).status, 403);
  const createdShare = await post(`/api/logs/${slug}/shares`, { label: 'QA', hours: 1 }, cookie);
  assert.equal(createdShare.response.status, 201);
  const shareUrl = new URL(createdShare.result.link);
  assert.equal(shareUrl.hostname, `${slug}.endport.io`);
  const redeemed = await getOnHost(shareUrl.pathname + shareUrl.search, shareUrl.hostname);
  assert.equal(redeemed.status, 303);
  assert.equal(redeemed.headers.location, '/');
  const visitorCookie = redeemed.headers['set-cookie']?.[0]?.split(';')[0];
  assert(visitorCookie);
  assert.equal((await getOnHost('/private', shareUrl.hostname, { Cookie: visitorCookie })).status, 200);
  const revoked = await post(`/api/logs/${slug}/revoke-share`, { id: createdShare.result.share.id }, cookie);
  assert.equal(revoked.response.status, 200);
  assert.equal((await getOnHost('/private', shareUrl.hostname, { Cookie: visitorCookie })).status, 403);
  assert.equal((await post(`/api/logs/${slug}/access`, { mode: 'public' }, cookie)).response.status, 200);
  const stats = await fetch(`${base}/api/logs/${slug}/stats`, { headers: { Cookie: cookie } }).then((res) => res.json());
  assert(stats.stats.requests >= 1);
  const analytics = await fetch(`${base}/api/logs/${slug}/analytics`, { headers: { Cookie: cookie } }).then((res) => res.json());
  assert(analytics.routes.some((item) => item.path === '/api/check'));
  const domain = await post(`/api/logs/${slug}/domain`, { domain: `api.${slug}.example.com` }, cookie);
  assert.equal(domain.response.status, 200); assert(domain.result.dns.cname.includes('ingress.endport.io'));
  const premature = await post(`/api/logs/${slug}/verify`, {}, cookie); assert.equal(premature.response.status, 400);

  const codeCommand = spawn(process.execPath, [cliScript, 'code', '--server', base], {
    cwd: projectDir, env: { ...process.env, ENDPORT_CONFIG_FILE: configFile, ENDPORT_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let fresh = ''; for await (const chunk of codeCommand.stdout) fresh += chunk.toString();
  assert(/Code\s+[A-Z0-9]{5}-[A-Z0-9]{5}/.test(fresh));
  assert(fresh.includes('http://localhost:8080/logs'));
  const unbound = spawn(process.execPath, [cliScript, 'code', '--server', base], {
    cwd: await mkdtemp(path.join(tmpdir(), 'endport-unbound-')),
    env: { ...process.env, ENDPORT_CONFIG_FILE: configFile, ENDPORT_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let unboundError = ''; for await (const chunk of unbound.stderr) unboundError += chunk.toString();
  assert.match(unboundError, /Run endport 3000 in this project directory first/);
  const serviceDir = await mkdtemp(path.join(tmpdir(), 'endport-services-'));
  await writeFile(path.join(serviceDir, 'endport.config.json'), JSON.stringify({ name: `${slug}-multi`, services: { web: { port: localPort }, api: { port: localPort } } }));
  servicesCli = spawn(process.execPath, [cliScript, 'start', '--server', base], {
    cwd: serviceDir, env: { ...process.env, ENDPORT_CONFIG_FILE: configFile, ENDPORT_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serviceOutput = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Services did not connect: ${serviceOutput}`)), 20000);
    servicesCli.stdout.on('data', (chunk) => { serviceOutput += chunk.toString(); if ((serviceOutput.match(/Tunnel connected/g) ?? []).length >= 2) { clearTimeout(timer); resolve(); } });
    servicesCli.stderr.on('data', (chunk) => process.stderr.write(chunk));
    servicesCli.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Services exited ${code}: ${serviceOutput}`)); });
  });
  const multi = JSON.parse(await readFile(path.join(serviceDir, '.endport.json'), 'utf8'));
  assert.equal(multi.version, 2);
  assert.notEqual(multi.services.web.endpointId, multi.services.api.endpointId);
  assert.equal((await getOnHost('/web', `${multi.services.web.slug}.endport.io`)).status, 200);
  assert.equal((await getOnHost('/api', `${multi.services.api.slug}.endport.io`)).status, 200);
  assert.equal((await fetch('http://127.0.0.1:8081/api/health')).status, 200);
  const remoteDir = await mkdtemp(path.join(tmpdir(), 'endport-remote-'));
  remoteCli = spawn(process.execPath, [cliScript, String(localPort), '--name', `${slug}-remote`, '--server', 'http://127.0.0.1:8081'], {
    cwd: remoteDir, env: { ...process.env, ENDPORT_CONFIG_FILE: configFile, ENDPORT_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let remoteOutput = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Remote CLI did not connect: ${remoteOutput}`)), 15000);
    remoteCli.stdout.on('data', (chunk) => { remoteOutput += chunk.toString(); if (remoteOutput.includes('Tunnel connected')) { clearTimeout(timer); resolve(); } });
    remoteCli.stderr.on('data', (chunk) => process.stderr.write(chunk));
    remoteCli.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Remote CLI exited ${code}: ${remoteOutput}`)); });
  });
  const remote = JSON.parse(await readFile(path.join(remoteDir, '.endport.json'), 'utf8'));
  const remoteHost = `${remote.slug}.endport.io`;
  const remoteResponse = await getOnHost('/across-nodes', remoteHost);
  assert.equal(remoteResponse.status, 200, remoteResponse.body);
  assert.equal(JSON.parse(remoteResponse.body).path, '/across-nodes');
  const remoteCode = /Code\s+([A-Z0-9]{5}-[A-Z0-9]{5})/.exec(remoteOutput)?.[1];
  assert(remoteCode);
  const remoteLogin = await post('/api/logs/login', { code: remoteCode });
  assert.equal(remoteLogin.response.status, 200);
  assert.equal(remoteLogin.result.workspaceUrl, `http://localhost:8080/logs/${remote.slug}`);
  const remoteCookie = remoteLogin.response.headers.get('set-cookie')?.split(';')[0];
  assert(remoteCookie);
  const remoteLogs = await fetch(`${base}/api/logs/${remote.slug}/requests`, { headers: { Cookie: remoteCookie } }).then((res) => res.json());
  const remoteSource = remoteLogs.requests.find((item) => item.path === '/across-nodes');
  assert(remoteSource);
  assert.equal((await post(`/api/logs/${remote.slug}/replay`, { id: remoteSource.id }, remoteCookie)).response.status, 200);
  await new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:8080/cross-node-ws', { headers: { Host: remoteHost } });
    const timer = setTimeout(() => reject(new Error('Cross-node WebSocket timed out')), 10000);
    ws.on('open', () => ws.send('cross-node'));
    ws.on('message', (data) => { assert.equal(data.toString(), 'cross-node'); clearTimeout(timer); ws.close(); resolve(); });
    ws.on('error', reject);
  });
  console.log('PASS: identities, name collision, logs codes, share links, two services, timing, filters, redacted capture, replay, HTTP, SSE, WebSocket, cross-node routing, domains');
} finally {
  cli?.kill('SIGINT'); secondCli?.kill('SIGINT'); servicesCli?.kill('SIGINT'); remoteCli?.kill('SIGINT'); localWs.close(); local.close();
}
