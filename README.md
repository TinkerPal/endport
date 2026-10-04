# Endport

Endport gives a local HTTP server a stable public HTTPS URL and a private logs dashboard. The first version uses a CLI identity stored on the developer's machine. **No email account or password is required.**

## Developer flow

```sh
npm install -g https://endport.io/downloads/endport-cli-0.1.0.tgz
endport 3000 --name packly
```

The CLI prints:

```text
Public  https://packly.endport.io
Logs    https://workspace.endport.io/
Code    ABCDE-23456
```

Run Endport from the application's directory. The first run creates that app and writes a non-secret `.endport.json` marker there. By default, Endport uses a clean version of the directory name; `--name packly` chooses a preferred name. If it is taken, Endport assigns a readable suffix such as `packly-7c2a` and prints the actual URL. Later runs from that directory reconnect the same app.

Open the logs URL and enter the 10-character code. Endport identifies the app from that code and opens its workspace. The code expires after 10 minutes and works once. The dashboard keeps a secure, host-only cookie for 24 hours. To get another code without restarting the tunnel, run `endport code` from the same project directory.

Each project has a separate owner credential stored with owner-only file permissions in `~/.config/endport/identities/`. The `.endport.json` marker contains no secret and can be kept with project files. **Back up the private identities directory:** without email or another recovery method, losing it means losing control of the app name. Treat the credentials like API keys. The CLI opens the logs URL automatically on a desktop; the URL and code are also printed for remote terminals.

The dashboard shows searchable, paginated request methods, paths, statuses, total and local handling times, and 24-hour stats. Headers are never stored, and query strings are dropped from request history. JSON body previews are off by default. The owner can enable them in **Access**: only JSON bodies up to 8 KB are considered, common secret fields and token-like values are masked before storage, and previews expire with request metadata after seven days. Redaction is best effort; do not enable previews for sensitive personal or payment data. The inspector can replay stored GET and HEAD paths without original headers, query strings, or bodies. Those replayed requests reach the local app and can have side effects if the app treats GET/HEAD as mutating operations.

### Share a running app

In the app workspace, open **Access**, choose **Restricted**, then create a visitor link with a 1-hour, 24-hour, or 7-day expiry. A visitor can use that link to open the public app without receiving access to its logs workspace. Endport shows the secret link only once. Revoking it blocks new requests, including from visitors who already redeemed it; an already open WebSocket remains connected until it closes. The public URL still shows an offline response when the CLI or local app stops.

### Connect several local services

Create `endport.config.json` in the project directory:

```json
{
  "name": "packly",
  "services": {
    "web": { "port": 3000 },
    "api": { "port": 4000 }
  }
}
```

Then run `endport start`. Each service gets its own stable Endport URL and private logs workspace under the same CLI owner identity. The first service uses the project’s original URL; other service URLs use readable suffixes such as `packly-api`. Use `endport code api` to print a new code for one service. Up to five services can be configured. A service may include a `domain` after verifying it in that service's workspace.

The public setup guide is at `https://endport.io/get-started`. The **Open Workspace** action opens `https://workspace.endport.io/`. Developers enter only their terminal code; Endport routes them to `https://workspace.endport.io/<app>` after login. For local Docker testing, the corresponding entry page is `http://localhost:8080/logs`.

## Production deployment

The website and workspace UI deploy together as one static Vercel project using the root `vercel.json`. Add **both** `endport.io` and `workspace.endport.io` to that project. The hostname-aware routes serve the landing page at the apex and the code-entry/workspace pages on the subdomain. The Vercel build outputs `landing.html` instead of a root `index.html` so its hostname rewrite can select the workspace page at `/`. Workspace API requests at `/api/logs/*` are proxied by Vercel to `https://api.endport.io`; the browser stays on `workspace.endport.io` so its host-only session cookie works. Build settings are in `vercel.json`, so import this repository with its root directory unchanged.

The tunnel gateway cannot run as a static Vercel site. Deploy the included Docker Compose stack on a Linux VPS with public ports 80 and 443, and keep PostgreSQL and Caddy's certificate storage persistent. The CLI connects to `api.endport.io`. App URLs (`<app>.endport.io`) and custom-domain traffic also reach that gateway. Deploy and verify the gateway **before** pointing the Vercel workspace live, or login and logs requests will fail.

Add the two domains in Vercel first and use the exact A/CNAME targets shown by its domain inspector. Configure DNS at your current DNS provider:

| Name | Type | Target |
| --- | --- | --- |
| `endport.io` | A | Vercel-provided apex address |
| `workspace.endport.io` | CNAME | Vercel-provided subdomain target |
| `api.endport.io` | A | Gateway VPS IPv4 address |
| `*.endport.io` | A | Gateway VPS IPv4 address |
| `ingress.endport.io` | A | Gateway VPS IPv4 address |

Explicit `workspace` and `api` records take priority over the wildcard at your DNS provider. Remove the current Porkbun parking records for the apex and workspace when replacing them. Do not add `*.endport.io` as a Vercel project domain: the wildcard belongs to the gateway. Use DNS-only records for the gateway if your provider offers proxying. `endport.dev` is unused by this deployment; it can later redirect to the `.io` site from a separate domain configuration.

On an Ubuntu VPS, install Docker Engine and its Compose plugin using [Docker's Ubuntu installation guide](https://docs.docker.com/engine/install/ubuntu/). Point the `api` and wildcard DNS records to the VPS, and allow inbound TCP ports 80 and 443 at the VPS provider firewall. Keep SSH (usually TCP 22) available. Ports 5432 and 8080 stay internal to Docker and should not be opened publicly. Ensure no other server already occupies 80 or 443.

Clone the repository on the VPS and create `.env` from `.env.example`. Set a URL-safe PostgreSQL password, an ACME email address, and a separate `INTERNAL_SHARED_SECRET` of at least 32 characters. `openssl rand -hex 32` generates a suitable value for each secret. Do not commit `.env` or `.env.test`.

```sh
git clone https://github.com/TinkerPal/endport.git
cd endport
cp .env.example .env
chmod 600 .env
nano .env
sudo docker compose up -d --build
sudo docker compose ps
curl https://api.endport.io/api/health
```

The health check should return `{"ok":true}` over HTTPS. Check startup or certificate problems with `sudo docker compose logs --tail=100 app caddy db`. Caddy obtains and renews TLS for `api.endport.io` and approved app hostnames; its data volume must persist. For later updates, run `git pull --ff-only` and `sudo docker compose up -d --build` from the same directory.

Push the repository from TinkerPal, import it into one Vercel project, and attach the apex and workspace domains to the production deployment. Vercel builds the static `dist/` output. Then install the CLI and run `endport 3000 --name packly` from a machine with a local server on port 3000. The CLI package is included in the site build at `/downloads/endport-cli-0.1.0.tgz`.

For a custom public hostname, add a subdomain in the logs dashboard. Add the CNAME and TXT records shown, then select **Verify DNS**. Once verified, use `endport 3000 --domain api.example.com`. The logs URL remains `workspace.endport.io/packly`.

The unscoped npm package `endport` belongs to an unrelated project. This deployment serves a versioned `@endport/cli` tarball directly. Publish that package to npm only if you control the `@endport` scope, then update the website's install command.

## Local verification

Node.js 20.19+ and Docker Compose are required. The development override publishes the app on `127.0.0.1:8080` without Caddy. Local logs pages use `http://localhost:8080/logs/<app>`.

```sh
npm ci
npm run build
cp .env.example .env.test
# Replace the sample database password and internal shared secret in .env.test.
docker compose --profile cluster_test --env-file .env.test -f compose.yaml -f compose.dev.yaml up -d --build db app app2
node tests/e2e.mjs
```

## Operating limits

- Active tunnel leases are stored in PostgreSQL; gateway nodes can forward requests and WebSockets to the node holding a CLI connection. Every node needs a unique, privately reachable `INSTANCE_URL` and the same `INTERNAL_SHARED_SECRET`. The Compose deployment runs one gateway node; add an external load balancer and multiple gateway instances for a cluster. Cluster failover and load testing still need to be completed before an availability guarantee.
- Five app names per CLI identity, 100 concurrent HTTP requests per app, 120 HTTP requests per minute per visitor, and 50 public WebSockets per app.
- Request bodies are limited to 2 MB and ordinary responses to 10 MB. Server sent events need data or heartbeat comments within the 60-second idle timeout.
- Request metadata is retained for seven days. Back up the `postgres_data` and `caddy_data` volumes. A logical database backup can be made with `docker compose exec -T db pg_dump -U endport endport > endport-backup.sql`.
- A fresh Caddy on-demand certificate can delay the first connection to a new app hostname and is subject to certificate authority rate limits. At larger scale, use a wildcard certificate for `*.endport.io` through a DNS challenge. Vercel manages TLS for `endport.io` and `workspace.endport.io`; Caddy manages it for `api.endport.io` and gateway-routed app hostnames.
- This release does not provide account recovery, teams, full-fidelity request replay, or a high-availability guarantee. JSON previews are intentionally redacted and cannot be used to replay POST or PUT bodies.
