# Endport CLI

Expose your local HTTP app through a stable public HTTPS URL, inspect requests, and connect several services from one project. No email login is required.

## Install

Requires Node.js 20.19 or newer (Node.js 22 or newer recommended).

```sh
npm install -g @endport/cli
endport --version
```

## Connect an app

Start your local server, then run this from its project directory:

```sh
endport 3000
# Or choose the preferred app name:
endport 3000 --name myapp
```

The CLI prints the public URL, workspace URL, and a code valid for 10 minutes. Enter that code at https://workspace.endport.io to inspect requests. Leave your local server and CLI running. Press Ctrl+C to disconnect. The project retains its assigned URL; name collisions receive a readable suffix from the gateway.

```sh
endport code                 # Get another workspace code
endport 3000 --domain api.example.com
```

Custom domains must already be registered and verified with the gateway. The CLI does not configure your DNS.

## Multiple services

Create `endport.config.json` in the project:

```json
{
  "name": "myapp",
  "services": {
    "web": { "port": 3000 },
    "api": { "port": 4000 },
    "hooks": { "port": 4001 }
  }
}
```

```sh
endport start
endport code api
```

Configure between one and five services. Each receives a separate endpoint. All service processes stop together when you interrupt the CLI or one fails.

## Ownership and security

`.endport.json` stores non-secret endpoint identifiers and can be committed to your project. Owner credentials stay on your computer in `~/.config/endport/identities/`, with restrictive filesystem permissions. Back up this private directory securely; losing it means losing access to that endpoint. Another developer cloning the project does not receive ownership automatically.

A public endpoint exposes the local app to the internet. Use your application's authentication or Endport's visitor controls for private previews. Never share owner credentials. Workspace codes are separate from public app access.

## Options and environment

- `--name NAME`: preferred app name on first connection.
- `--domain HOST`: use a verified custom hostname.
- `--server URL`: override the gateway; defaults to `https://api.endport.io`.
- `--help`, `--version`: usage and installed version.
- `ENDPORT_SERVER`: gateway override. Remote gateways require HTTPS; loopback HTTP supports local development.
- `ENDPORT_NO_BROWSER=1`: print the workspace URL without opening a browser.
- `ENDPORT_CONFIG_FILE`: alternate client config location; identities are stored beside it.
- `ENDPORT_CREDENTIAL`: owner credential override for managed environments. Treat it as a secret.

HTTP responses are streamed; non-SSE responses are limited to 10 MiB. WebSockets and SSE are supported. The CLI reconnects with bounded exponential backoff and jitter after network interruptions. A revoked credential or replacement connection stops the old tunnel. The gateway sets its own traffic and request limits.

## Troubleshooting

- **Endpoint offline:** keep the local server and CLI running; wait for `Tunnel connected`.
- **Local origin unavailable:** check the port and confirm the app listens on `127.0.0.1`.
- **Code expired:** run `endport code` in the original project directory.
- **Missing owner credential:** restore your private identity backup on this machine.
- **Tunnel replaced:** another CLI is serving the same endpoint; stop it before reconnecting.

## Developing and publishing

See [PUBLISHING.md](https://github.com/TinkerPal/endport/blob/main/packages/cli/PUBLISHING.md) in the repository. The package ships compiled JavaScript from TypeScript source and requires no install scripts or compiler on the user's machine.
