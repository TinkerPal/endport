type Endpoint = { id: string; slug: string; publicUrl: string; logsUrl: string; customDomain: string | null; domainVerified: boolean; verificationToken: string | null; accessMode: 'public' | 'restricted'; captureBodies: boolean; online: boolean };
type Share = { id: string; label: string; expires_at: string; revoked_at: string | null; created_at: string; last_used_at: string | null };
type RequestLog = { id: string; method: string; path: string; status: number; duration_ms: number; origin_ms: number | null; bytes_in: number; bytes_out: number; request_preview: unknown | null; response_preview: unknown | null; created_at: string };
type Stats = { requests: number; errors: number; avg_ms: number; bytes: string };
type Hour = { hour: string; requests: number; errors: number };
type Route = { path: string; requests: number; avg_ms: number };

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const slug = local
  ? /^\/logs\/([a-z0-9-]+)(?:\/|$)/.exec(location.pathname)?.[1]
  : location.hostname === 'workspace.endport.io' ? /^\/([a-z0-9-]+)(?:\/|$)/.exec(location.pathname)?.[1] : undefined;
if (!slug) throw new Error('App name missing from logs URL');
const API = `/api/logs/${slug}`;
let current: Endpoint | null = null;
let requests: RequestLog[] = [];
let nextBefore: string | null = null;
let olderLoaded = false;
let filterTimer: number | undefined;
let selectedId: string | null = null;
let activeView = 'traffic';
let paused = false;
let loading = false;
let refreshTimer: number | undefined;
let publicUrl = '';

function show(id: string, visible: boolean): void { el(id).hidden = !visible; }
function message(id: string, value: string): void { el(id).textContent = value; }
function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
function statusClass(status: number): string {
  return status >= 500 ? 'server-error' : status >= 400 ? 'client-error' : status >= 300 ? 'redirect' : '';
}
function announce(value: string): void { message('announcement', value); }

async function api<T>(action: string, method = 'GET', data?: object): Promise<T> {
  const response = await fetch(`${API}/${action}`, {
    method, credentials: 'same-origin',
    headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) {
    const error = new Error(result.error ?? `HTTP ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return result;
}
function lock(error?: string): void {
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = undefined;
  paused = false;
  el('pause-live').classList.remove('paused');
  el('pause-live').setAttribute('aria-pressed', 'false');
  el('pause-live').querySelector('span:last-child')!.textContent = 'Live';
  show('dashboard-view', false); show('auth-view', true);
  show('logout', false); show('topbar-status', false);
  if (error) message('auth-error', error);
}
function setConnection(online: boolean): void {
  const status = el('app-status');
  status.classList.toggle('online', online);
  status.querySelector('span')!.textContent = online ? 'Connected' : 'Offline';
  const top = el('topbar-status');
  top.classList.toggle('online', online);
  top.querySelector('span')!.textContent = online ? 'Connected' : 'Offline';
  show('offline-banner', !online);
}
function renderEndpoint(endpoint: Endpoint): void {
  current = endpoint;
  message('topbar-app', endpoint.slug);
  message('sidebar-app', endpoint.slug);
  message('breadcrumb-app', endpoint.slug.toUpperCase());
  message('app-name', endpoint.slug);
  publicUrl = endpoint.customDomain && endpoint.domainVerified ? `https://${endpoint.customDomain}` : endpoint.publicUrl;
  const link = el<HTMLAnchorElement>('app-url');
  link.href = publicUrl; link.textContent = publicUrl;
  setConnection(endpoint.online);
  renderDomain(endpoint);
  const mode = document.querySelector<HTMLInputElement>(`input[name="access-mode"][value="${endpoint.accessMode}"]`);
  if (mode) mode.checked = true;
  el<HTMLInputElement>('capture-bodies').checked = endpoint.captureBodies;
}
function renderDomain(endpoint: Endpoint): void {
  const hasDomain = !!endpoint.customDomain;
  show('domain-instructions', hasDomain);
  show('domain-placeholder', !hasDomain);
  if (!hasDomain) { message('domain-state', 'No custom domain yet'); return; }
  message('domain-state', endpoint.domainVerified ? `${endpoint.customDomain} is verified` : `Waiting for ${endpoint.customDomain}`);
  message('dns-cname', `${endpoint.customDomain} → ingress.endport.io`);
  message('dns-txt', `_endport.${endpoint.customDomain} → ${endpoint.verificationToken ?? ''}`);
  show('verify-domain', !endpoint.domainVerified);
  const input = el<HTMLInputElement>('domain-input');
  if (document.activeElement !== input) input.value = endpoint.customDomain ?? '';
}
function renderStats(stats: Stats): void {
  message('stat-requests', stats.requests.toLocaleString());
  message('stat-errors', stats.errors.toLocaleString());
  message('stat-latency', `${stats.avg_ms}ms`);
  message('stat-bytes', formatBytes(Number(stats.bytes)));
}
function renderDetail(item: RequestLog | undefined): void {
  show('detail-placeholder', !item);
  show('detail-content', !!item);
  show('replay-request', !!item && ['GET', 'HEAD'].includes(item.method));
  show('body-preview', !!item && (item.request_preview !== null || item.response_preview !== null));
  if (!item) return;
  message('detail-method', item.method);
  message('detail-status', String(item.status));
  el('detail-status').classList.toggle('error', item.status >= 400);
  message('detail-path', item.path);
  message('detail-time', new Date(item.created_at).toLocaleString());
  message('detail-duration', `${item.duration_ms} ms`);
  message('detail-origin', item.origin_ms === null ? 'Unavailable' : `${item.origin_ms} ms`);
  message('request-preview', item.request_preview === null ? 'Not captured' : JSON.stringify(item.request_preview, null, 2));
  message('response-preview', item.response_preview === null ? 'Not captured' : JSON.stringify(item.response_preview, null, 2));
  message('replay-result', '');
  message('detail-in', formatBytes(item.bytes_in));
  message('detail-out', formatBytes(item.bytes_out));
}
function renderRequests(): void {
  const filtered = requests;
  message('request-count', `${filtered.length} shown`);
  show('load-older', !!nextBefore);
  const list = el('request-list');
  list.replaceChildren();
  show('request-empty', filtered.length === 0);
  message('request-empty-copy', el<HTMLInputElement>('request-search').value || el<HTMLSelectElement>('status-filter').value !== 'all' ? 'Clear the filter to see more traffic.' : 'Send a request to your public URL, then watch it appear here.');
  if (!filtered.length) { renderDetail(undefined); return; }
  if (!filtered.some((item) => item.id === selectedId)) selectedId = filtered[0].id;
  for (const item of filtered) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `request-row${item.id === selectedId ? ' selected' : ''}`;
    row.setAttribute('aria-label', `${item.method} ${item.path}, status ${item.status}, ${item.duration_ms} milliseconds`);
    const method = document.createElement('span'); method.className = `method-pill ${item.method.toLowerCase()}`; method.textContent = item.method;
    const path = document.createElement('span'); path.className = 'path'; path.textContent = item.path; path.title = item.path;
    const status = document.createElement('span'); status.className = `status-code ${statusClass(item.status)}`; status.textContent = String(item.status);
    const duration = document.createElement('span'); duration.className = 'duration'; duration.textContent = `${item.duration_ms}ms`;
    const time = document.createElement('time'); time.dateTime = item.created_at; time.textContent = new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    row.append(method, path, status, duration, time);
    row.addEventListener('click', () => { selectedId = item.id; renderRequests(); });
    list.append(row);
  }
  renderDetail(filtered.find((item) => item.id === selectedId));
}
function renderAnalytics(hourly: Hour[], routes: Route[]): void {
  const counts = new Map(hourly.map((item) => [new Date(item.hour).toISOString().slice(0, 13), item]));
  const max = Math.max(1, ...hourly.map((item) => item.requests));
  const chart = el('analytics-bars');
  chart.replaceChildren();
  let total = 0;
  for (let offset = 23; offset >= 0; offset--) {
    const hour = new Date();
    hour.setUTCMinutes(0, 0, 0);
    hour.setUTCHours(hour.getUTCHours() - offset);
    const item = counts.get(hour.toISOString().slice(0, 13));
    const count = item?.requests ?? 0;
    total += count;
    const bar = document.createElement('div');
    bar.className = `bar${item?.errors ? ' error' : ''}`;
    bar.style.height = `${Math.max(count ? 6 : 2, (count / max) * 100)}%`;
    const tooltip = document.createElement('span');
    tooltip.textContent = `${hour.toLocaleTimeString([], { hour: 'numeric' })}: ${count} requests`;
    bar.append(tooltip); chart.append(bar);
  }
  chart.setAttribute('aria-label', `${total} requests over the last 24 hours`);
  const routeList = el('top-routes');
  routeList.replaceChildren();
  if (!routes.length) {
    const empty = document.createElement('p'); empty.className = 'analytics-empty'; empty.textContent = 'Routes will appear after your first request.'; routeList.append(empty); return;
  }
  for (const route of routes) {
    const row = document.createElement('div'); row.className = 'route-row';
    const name = document.createElement('code'); name.textContent = route.path; name.title = route.path;
    const count = document.createElement('strong'); count.textContent = String(route.requests);
    const average = document.createElement('span'); average.textContent = `${route.avg_ms}ms`;
    row.append(name, count, average); routeList.append(row);
  }
}
function renderShares(shares: Share[]): void {
  const list = el('share-list'); list.replaceChildren();
  show('share-empty', shares.length === 0);
  for (const share of shares) {
    const item = document.createElement('div'); item.className = `share-item${share.revoked_at || new Date(share.expires_at).getTime() < Date.now() ? ' revoked' : ''}`;
    const identity = document.createElement('div');
    const label = document.createElement('strong'); label.textContent = share.label;
    const meta = document.createElement('small'); meta.textContent = share.revoked_at ? 'Revoked' : new Date(share.expires_at).getTime() < Date.now() ? 'Expired' : share.last_used_at ? 'Opened by a visitor' : 'Not opened yet';
    identity.append(label, meta);
    const expiry = document.createElement('time'); expiry.dateTime = share.expires_at; expiry.textContent = new Date(share.expires_at).toLocaleDateString();
    const revoke = document.createElement('button'); revoke.type = 'button'; revoke.textContent = 'Revoke';
    revoke.addEventListener('click', async () => {
      revoke.disabled = true;
      try { await api('revoke-share', 'POST', { id: share.id }); await refreshShares(); announce('Visitor link revoked'); }
      catch (error) { message('share-error', (error as Error).message); revoke.disabled = false; }
    });
    item.append(identity, expiry, revoke); list.append(item);
  }
}
async function refreshShares(): Promise<void> {
  const { shares } = await api<{ shares: Share[] }>('shares');
  renderShares(shares);
}
async function refreshAnalytics(): Promise<void> {
  const data = await api<{ hourly: Hour[]; routes: Route[] }>('analytics');
  renderAnalytics(data.hourly, data.routes);
}
function requestAction(before?: string): string {
  const params = new URLSearchParams();
  const search = el<HTMLInputElement>('request-search').value.trim();
  const status = el<HTMLSelectElement>('status-filter').value;
  if (search) params.set('q', search);
  if (status !== 'all') params.set('status', status);
  if (before) params.set('before', before);
  return `requests${params.size ? `?${params}` : ''}`;
}
async function refresh(force = false): Promise<void> {
  if (loading || (paused && !force)) return;
  loading = true;
  try {
    const action = requestAction();
    const [{ endpoint }, { stats }, page] = await Promise.all([
      api<{ endpoint: Endpoint }>('session'),
      api<{ stats: Stats }>('stats'),
      api<{ requests: RequestLog[]; nextBefore: string | null }>(action),
    ]);
    renderEndpoint(endpoint); renderStats(stats);
    if (action === requestAction()) {
      requests = olderLoaded ? [...new Map([...page.requests, ...requests].map((item) => [item.id, item])).values()].sort((a, b) => b.created_at.localeCompare(a.created_at)) : page.requests;
      if (!olderLoaded) nextBefore = page.nextBefore;
      renderRequests();
    }
    if (activeView === 'analytics') await refreshAnalytics();
    if (activeView === 'access') await refreshShares();
    message('last-updated', `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
  } catch (error) {
    if ((error as Error & { status?: number }).status === 401) lock('Your session expired. Run endport code in your app directory to unlock again.');
    else message('last-updated', 'Connection interrupted · retrying');
  } finally { loading = false; }
}
function unlock(): void {
  show('auth-view', false); show('dashboard-view', true); show('logout', true); show('topbar-status', true);
  message('auth-error', '');
  activateView(activeView);
  if (!refreshTimer) refreshTimer = window.setInterval(() => { void refresh(); }, 5000);
  void refresh();
}
function activateView(view: string): void {
  activeView = view;
  for (const name of ['traffic', 'analytics', 'access', 'domains', 'setup']) show(`${name}-view`, name === view);
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  message('breadcrumb-view', view.toUpperCase());
  if (view === 'analytics' && current) void refreshAnalytics().catch(() => { message('last-updated', 'Analytics unavailable'); });
  if (view === 'access' && current) void refreshShares().catch(() => { message('share-error', 'Unable to load visitor links'); });
}
message('code-app-name', slug);
message('preview-app', slug);
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => button.addEventListener('click', () => activateView(button.dataset.view ?? 'traffic')));
el<HTMLFormElement>('code-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  message('auth-error', '');
  const button = el<HTMLButtonElement>('code-form').querySelector('button')!;
  button.disabled = true;
  try {
    await api('login', 'POST', { code: el<HTMLInputElement>('code-input').value });
    el<HTMLInputElement>('code-input').value = '';
    unlock();
  } catch (error) { message('auth-error', (error as Error).message); }
  finally { button.disabled = false; }
});
el('logout').addEventListener('click', async () => {
  try { await api('logout', 'POST'); } catch { /* Expired sessions are already locked. */ }
  current = null; requests = []; selectedId = null; nextBefore = null; olderLoaded = false; lock();
});
function resetRequestFilters(): void {
  requests = []; nextBefore = null; olderLoaded = false; selectedId = null; renderRequests();
  if (filterTimer) window.clearTimeout(filterTimer);
  filterTimer = window.setTimeout(() => { void refresh(true); }, 250);
}
el<HTMLInputElement>('request-search').addEventListener('input', resetRequestFilters);
el<HTMLSelectElement>('status-filter').addEventListener('change', resetRequestFilters);
el('load-older').addEventListener('click', async () => {
  if (!nextBefore) return;
  const cursor = nextBefore;
  const button = el<HTMLButtonElement>('load-older'); button.disabled = true;
  try {
    const page = await api<{ requests: RequestLog[]; nextBefore: string | null }>(requestAction(cursor));
    if (cursor !== nextBefore) return;
    requests = [...new Map([...requests, ...page.requests].map((item) => [item.id, item])).values()];
    nextBefore = page.nextBefore; olderLoaded = true; renderRequests();
  } catch { announce('Unable to load older requests'); }
  finally { button.disabled = false; }
});
el('pause-live').addEventListener('click', () => {
  paused = !paused;
  el('pause-live').classList.toggle('paused', paused);
  el('pause-live').setAttribute('aria-pressed', String(paused));
  el('pause-live').querySelector('span:last-child')!.textContent = paused ? 'Paused' : 'Live';
  if (!paused) void refresh();
});
el('copy-public').addEventListener('click', async () => {
  if (!publicUrl) return;
  try { await navigator.clipboard.writeText(publicUrl); announce('Public URL copied'); }
  catch { announce('Unable to copy the public URL'); }
});
document.querySelectorAll<HTMLInputElement>('input[name="access-mode"]').forEach((radio) => radio.addEventListener('change', async () => {
  if (!radio.checked) return;
  message('access-error', '');
  try {
    const { endpoint } = await api<{ endpoint: Endpoint }>('access', 'POST', { mode: radio.value });
    renderEndpoint(endpoint);
    announce(endpoint.accessMode === 'restricted' ? 'Visitor access is restricted' : 'App is public');
  } catch (error) { message('access-error', (error as Error).message); if (current) renderEndpoint(current); }
}));
el<HTMLInputElement>('capture-bodies').addEventListener('change', async () => {
  const toggle = el<HTMLInputElement>('capture-bodies');
  message('capture-error', ''); toggle.disabled = true;
  try {
    const { endpoint } = await api<{ endpoint: Endpoint }>('capture', 'POST', { enabled: toggle.checked });
    renderEndpoint(endpoint);
    announce(endpoint.captureBodies ? 'JSON previews enabled' : 'JSON previews disabled');
  } catch (error) { message('capture-error', (error as Error).message); if (current) renderEndpoint(current); }
  finally { toggle.disabled = false; }
});
el('replay-request').addEventListener('click', async () => {
  if (!selectedId) return;
  const button = el<HTMLButtonElement>('replay-request'); button.disabled = true;
  message('replay-result', 'Replaying…');
  try {
    const { replay } = await api<{ replay: { status: number; durationMs: number } }>('replay', 'POST', { id: selectedId });
    await refresh(true);
    message('replay-result', `Replay returned ${replay.status} in ${replay.durationMs} ms`);
  } catch (error) { message('replay-result', (error as Error).message); }
  finally { button.disabled = false; }
});
el<HTMLFormElement>('share-form').addEventListener('submit', async (event) => {
  event.preventDefault(); message('share-error', '');
  const button = el<HTMLButtonElement>('share-form').querySelector('button')!; button.disabled = true;
  try {
    const result = await api<{ share: Share; link: string }>('shares', 'POST', {
      label: el<HTMLInputElement>('share-label').value,
      hours: Number(el<HTMLSelectElement>('share-hours').value),
    });
    message('new-share-url', result.link); show('new-share', true);
    el<HTMLFormElement>('share-form').reset();
    await refreshShares(); announce('Visitor link created');
  } catch (error) { message('share-error', (error as Error).message); }
  finally { button.disabled = false; }
});
el('copy-share').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(el('new-share-url').textContent ?? ''); announce('Visitor link copied'); }
  catch { announce('Unable to copy link'); }
});
el<HTMLFormElement>('domain-form').addEventListener('submit', async (event) => {
  event.preventDefault(); message('domain-error', '');
  const button = el<HTMLButtonElement>('domain-form').querySelector('button')!; button.disabled = true;
  try {
    await api('domain', 'POST', { domain: el<HTMLInputElement>('domain-input').value });
    await refresh(true); announce('DNS records are ready');
  } catch (error) { message('domain-error', (error as Error).message); }
  finally { button.disabled = false; }
});
el('verify-domain').addEventListener('click', async () => {
  message('domain-error', '');
  try { await api('verify', 'POST'); await refresh(true); announce('Domain verified'); }
  catch (error) { message('domain-error', (error as Error).message); }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== '/' || activeView !== 'traffic' || el('dashboard-view').hidden) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  event.preventDefault(); el<HTMLInputElement>('request-search').focus();
});
void api('session').then(() => unlock()).catch(() => lock());
