# Endport behind an existing Nginx server

Use this deployment when Nginx already owns ports 80 and 443 on the VPS. It keeps Endport's Node gateway on `127.0.0.1:8090`, leaves PostgreSQL private, and does not start the repository's Caddy container. The included Nginx configuration handles `api.endport.io` and first-level `*.endport.io` app URLs. The public website and workspace remain on Vercel.

## 1. Check the local port

On the VPS, run `sudo ss -ltnp '( sport = :8090 )'`. It should print no listener. If it is occupied, choose a free port and change **both** `compose.nginx.yaml` and `deploy/nginx/endport.conf` before starting Endport.

## 2. Start the private gateway

From the repository directory, with `.env` already configured:

```sh
sudo docker compose stop caddy
sudo docker compose -f compose.yaml -f compose.nginx.yaml up -d --build db app
sudo docker compose -f compose.yaml -f compose.nginx.yaml ps
curl -fsS http://127.0.0.1:8090/api/health
```

The health check should return `{"ok":true}`. Port 8090 binds to loopback only; do not expose it in the VPS firewall.

## 3. Obtain a renewable wildcard certificate

The Nginx configuration needs a certificate covering `*.endport.io`. Porkbun hosts this domain's DNS, and [acme.sh supports Porkbun DNS validation](https://github.com/acmesh-official/acme.sh/blob/master/dnsapi/dns_porkbun.sh). In Porkbun, create an API key and secret and enable API access for `endport.io`. Keep both keys private.

Install acme.sh as root so its scheduled renewal can write Nginx's certificate files. Its [installation guide](https://github.com/acmesh-official/acme.sh#install-online) describes the renewal job. In the root shell, enter the two keys without placing them in shell history:

```sh
sudo -i
git clone https://github.com/acmesh-official/acme.sh.git /root/acme-src
cd /root/acme-src
./acme.sh --install -m admin@endport.io
read -rsp 'Porkbun API key: ' PORKBUN_API_KEY; echo
read -rsp 'Porkbun secret API key: ' PORKBUN_SECRET_API_KEY; echo
export PORKBUN_API_KEY PORKBUN_SECRET_API_KEY
/root/.acme.sh/acme.sh --issue --dns dns_porkbun --server letsencrypt -d '*.endport.io'
mkdir -p /etc/nginx/ssl/endport
/root/.acme.sh/acme.sh --install-cert -d '*.endport.io' \
  --key-file /etc/nginx/ssl/endport/key.pem \
  --fullchain-file /etc/nginx/ssl/endport/fullchain.pem \
  --reloadcmd 'systemctl reload nginx'
exit
```

acme.sh saves the DNS credentials in root's account configuration for its renewal job. Restrict Porkbun API access to only the domains it needs. Use the `--install-cert` command above; do not point Nginx at acme.sh's internal certificate files.

## 4. Add the Nginx site

```sh
sudo cp deploy/nginx/endport.conf /etc/nginx/conf.d/endport.conf
sudo nginx -t
sudo systemctl reload nginx
curl -fsS https://api.endport.io/api/health
```

Only reload if `nginx -t` succeeds. The public health check should return `{"ok":true}`. The configuration forwards HTTP, WebSockets and server-sent events, and retains the incoming hostname so Endport can route each app. Check any error with `sudo journalctl -u nginx -n 100 --no-pager` and `sudo docker compose -f compose.yaml -f compose.nginx.yaml logs --tail=100 app`.

For updates, run `git pull --ff-only` followed by `sudo docker compose -f compose.yaml -f compose.nginx.yaml up -d --build db app`. Do not start the `caddy` service on this shared VPS.

This wildcard certificate covers Endport's first-level app names and `api.endport.io`. A visitor-supplied custom domain, such as `api.example.com`, needs an additional Nginx hostname and its own valid certificate. The current shared-Nginx configuration does not automate that step; use the standalone Caddy deployment if automatic custom-domain TLS is required.
