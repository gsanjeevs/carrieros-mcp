# carrieros-mcp

MCP (Model Context Protocol) server exposing CarrierOS's public developer
API (`/api/public/v1/*`) as read-only LLM tools: `list_loads`, `get_load`,
`list_invoices`, `get_invoice`, `list_vehicles`, `list_exceptions`,
`list_financial_events`.

Two ways to run it:
- **stdio** (`src/index.ts`) — a local subprocess of a desktop MCP client
  (Claude Desktop, OpenClaw). One set of credentials per process, from `.env`
  or the client's own config.
- **HTTP** (`src/http-server.ts`) — a hosted, multi-tenant deployment.
  Stateless and credential-free: every request carries its own tenant's
  CarrierOS OAuth credentials via headers, so this process never stores
  customer secrets. This is what lets you offer it to customers without each
  of them running any code locally.

Authenticates via OAuth 2.0 client-credentials, the same flow any external
CarrierOS integration uses (Settings → Developer API in the CarrierOS app
issues the client id/secret).

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in your CarrierOS instance's URL
   and OAuth client credentials (create one at Settings → Developer API,
   requires Growth tier or above).
3. `npm run build`

## Using it from an MCP client

Point your client (Claude Desktop, OpenClaw, etc.) at the built server. For
Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "carrieros": {
      "command": "node",
      "args": ["/absolute/path/to/carrieros-mcp/dist/index.js"],
      "env": {
        "CARRIEROS_BASE_URL": "http://localhost:3100",
        "CARRIEROS_CLIENT_ID": "pub_client_...",
        "CARRIEROS_CLIENT_SECRET": "pub_secret_..."
      }
    }
  }
}
```

If `env` is omitted, the server falls back to reading `.env` in this
directory (via `dotenv`) — convenient for local dev, but an explicit `env`
block in the client config is the more portable option since it doesn't
depend on the process's working directory.

## Local dev

`npm run dev` runs the stdio server directly against `.env` via `tsx`, no
build step needed. `npm run dev:http` does the same for the HTTP server.

For the companion app's complete local machine setup (Node, Docker/Supabase,
web/mobile co-development, simulator setup, and the local port gotchas), see
the [CarrierOS local development guide](https://github.com/gsanjeevs/carrieros/blob/main/architecture/local-development.md).

## Hosted deployment (HTTP, multi-tenant)

**Live on staging (2026-09-29):** `https://ca-7dc84edc0bd24885b2af9d2ed91ecda4.ecs.us-east-1.on.aws`
— ECS Express service `carrieros-mcp-staging` in the `default` cluster, image in ECR repo
`carrieros-mcp`. Verified end-to-end against real staging CarrierOS data (`GET /health` → `200`,
a real `tools/call` for `list_vehicles` with real staging OAuth client credentials → real vehicle
records). See `architecture/how-it-was-built.md` for the full build breakdown,
`architecture/deployment.md` for the reusable hosted-MCP deployment pattern and staging runbook, and
`carrieros/architecture/deployment.md` for the CarrierOS-side staging environment this depends on.

The service currently runs manually deployed images (this repo does not yet have its own
CodeBuild auto-deploy project). The OAuth-enabled staging revision uses `MCP_PUBLIC_URL` for
the public MCP origin, `CARRIEROS_BASE_URL` for the fixed CarrierOS staging app, and the
Secrets Manager secret `carrieros-staging/MCP_OAUTH_ENCRYPTION_KEY` injected as
`MCP_OAUTH_ENCRYPTION_KEY`. The ECS execution role's `ReadCarrierOsMcpOauthKey` inline policy
grants access only to that secret. There is no production MCP deployment.

Build and run the container locally:

```bash
docker build -t carrieros-mcp .
docker run -p 3000:3000 carrieros-mcp
```

**Two real gotchas hit deploying this to ECS Express Mode, worth knowing if redeploying:**
- **`minTaskCount: 0` never scales back up.** ECS Express Gateway's autoscaling here is CPU-based
  (`AVERAGE_CPU`), which can't measure CPU on zero running tasks — there's no request-triggered
  cold-start the way some serverless platforms offer. A service created with `minTaskCount: 0` and no
  traffic just stays at zero forever, returning `503` from the gateway indefinitely. Set
  `minTaskCount: 1` for anything that needs to actually answer requests (fine for this service — it's
  a lightweight Node process, cheap to keep warm).
- **DNS for a freshly created `*.ecs.*.on.aws` endpoint can lag the AWS API's own success response**
  by a few minutes. `nslookup` may resolve before the system resolver (and therefore `curl`/browsers)
  catches up — don't treat a `curl: (6) Could not resolve host` right after creation as a real failure;
  wait a few minutes, or verify with `curl --resolve <host>:443:<ip>` using an IP `nslookup` already
  found, to confirm the service itself (not DNS) is the thing being tested.

Deploy that image the same way `carrieros-web` deploys (AWS ECS Express
Mode). Header-authenticated callers send tenant credentials per-request; the
OAuth flow additionally needs `MCP_PUBLIC_URL`, `CARRIEROS_BASE_URL`, and a
private random `MCP_OAUTH_ENCRYPTION_KEY`. Put it behind TLS since credentials
travel in OAuth forms or request headers. `GET /health` is the container health
check; `POST /mcp` is the only MCP endpoint (the deployment is stateless, so
`GET`/`DELETE /mcp` — used for server push and session teardown in stateful
mode — aren't supported and return 405).

Header-authenticated MCP clients may pass their CarrierOS OAuth client
credentials (from Settings → Developer API) as headers:

```
x-carrieros-base-url: https://<their-instance>.carrieros.com
x-carrieros-client-id: pub_client_...
x-carrieros-client-secret: pub_secret_...
```

### ChatGPT remote connector (OAuth)

The hosted endpoint supports MCP OAuth 2.1 with PKCE and dynamic client
registration. On an eligible ChatGPT Business, Enterprise, or Edu workspace,
enable **Settings → Apps → Advanced settings → Developer mode**, choose
**Apps → Create**, enter the hosted MCP URL above, select OAuth, scan the
tools, and create the app. On first
authorization, the browser asks for that organization's CarrierOS Developer
API client ID and secret, and shows an explicit read-only consent page.

The MCP server encrypts those credentials into expiring OAuth tokens; it does
not persist credentials in a database. `CARRIEROS_BASE_URL` fixes the upstream
host accepted by this OAuth flow (staging for this deployment). Access tokens
last one hour and refresh tokens last 30 days. Revoke access immediately by
revoking the Developer API client in CarrierOS Settings → Developer API.
`MCP_OAUTH_ENCRYPTION_KEY` must be a private, random 32-byte key encoded as
Base64, and `MCP_PUBLIC_URL` must be the public HTTPS service origin.
Changing the encryption key invalidates existing OAuth client registrations
and access/refresh tokens; users must reconnect.

ChatGPT full MCP support is still a plan/workspace feature rollout. If
Developer mode or app creation is unavailable, the workspace administrator
must enable it or the account must use an eligible plan.

### Connecting Claude Desktop to the hosted server

Claude Desktop's remote/custom connector support (Settings → Connectors →
Add Custom Connector) takes a URL, not a header map — if it doesn't offer a
way to attach these three headers directly, the simplest fix is a per-customer
proxy config entry using `mcp-remote` (or similar) to inject them:

```json
{
  "mcpServers": {
    "carrieros": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "https://ca-7dc84edc0bd24885b2af9d2ed91ecda4.ecs.us-east-1.on.aws/mcp",
        "--header", "x-carrieros-base-url:${CARRIEROS_BASE_URL}",
        "--header", "x-carrieros-client-id:${CARRIEROS_CLIENT_ID}",
        "--header", "x-carrieros-client-secret:${CARRIEROS_CLIENT_SECRET}"
      ],
      "env": {
        "CARRIEROS_BASE_URL": "https://ca-aa167deb702e4a338c4370ff70576195.ecs.us-east-1.on.aws",
        "CARRIEROS_CLIENT_ID": "pub_client_...",
        "CARRIEROS_CLIENT_SECRET": "pub_secret_..."
      }
    }
  }
}
```

This still runs one small local process (`npx mcp-remote`), but
it's a generic pass-through with no CarrierOS-specific code to install or
update — all the actual logic and any future tool additions live on the
hosted server. Claude Desktop versions that support OAuth remote MCP can add
the hosted URL directly and complete the consent flow above. The
`mcp-remote` setup remains a compatible header-auth fallback; local stdio
configuration above remains the simplest option when running the process on
the desktop.

## Scope, deliberately

Every tool here is a GET request — nothing mutates data. If you want a tool
that creates or updates something (marking an invoice paid, editing a load),
add it as a new, clearly-named tool rather than overloading an existing one,
and think about what confirmation step makes sense before an LLM can trigger
a real write against your business data.

## What's not exposed yet

**Drivers.** A drivers route exists in CarrierOS's public API, but the public
API's deliberately least-privileged `finance` actor does not have the
`drivers` role capability. It returns 403 and this MCP server does not expose
`list_drivers`; do not work around that boundary by changing the actor's role.
Adding driver data requires a deliberate CarrierOS authorization decision.

**Dispatch, customers, and anything else** not yet under
`carrieros-web/app/api/public/v1/` isn't reachable this way at all.
Expanding this server further means either the CarrierOS public API grows
first, or this project starts calling the internal `/api/v1/*` surface
directly with a real user session instead of an org-level OAuth client (a
bigger, different kind of auth to get right — worth a separate conversation
before doing it).
