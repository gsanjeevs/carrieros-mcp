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

## Hosted deployment (HTTP, multi-tenant)

Build and run the container:

```bash
docker build -t carrieros-mcp .
docker run -p 3000:3000 carrieros-mcp
```

Deploy that image the same way `carrieros-web` deploys (AWS ECS Express
Mode) — it needs no app-specific env vars at all, since tenant credentials
arrive per-request. Put it behind TLS (ALB/CloudFront) since credentials
travel in headers on every call. `GET /health` is the container health
check; `POST /mcp` is the only MCP endpoint (the deployment is stateless, so
`GET`/`DELETE /mcp` — used for server push and session teardown in stateful
mode — aren't supported and return 405).

Each customer calls it with their own CarrierOS OAuth client credentials
(from their Settings → Developer API) as headers:

```
x-carrieros-base-url: https://<their-instance>.carrieros.com
x-carrieros-client-id: pub_client_...
x-carrieros-client-secret: pub_secret_...
```

### Connecting a customer's Claude Desktop to the hosted server

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
        "-y", "mcp-remote", "https://mcp.carrieros.com/mcp",
        "--header", "x-carrieros-base-url:${CARRIEROS_BASE_URL}",
        "--header", "x-carrieros-client-id:${CARRIEROS_CLIENT_ID}",
        "--header", "x-carrieros-client-secret:${CARRIEROS_CLIENT_SECRET}"
      ],
      "env": {
        "CARRIEROS_BASE_URL": "https://their-instance.carrieros.com",
        "CARRIEROS_CLIENT_ID": "pub_client_...",
        "CARRIEROS_CLIENT_SECRET": "pub_secret_..."
      }
    }
  }
}
```

This still runs one small local process per customer (`npx mcp-remote`), but
it's a generic pass-through with no CarrierOS-specific code to install or
update — all the actual logic and any future tool additions live on the
hosted server. Verify the exact custom-connector header syntax against
whatever Claude Desktop version the customer is on before shipping this
broadly; connector configuration has changed across releases.

## Scope, deliberately

Every tool here is a GET request — nothing mutates data. If you want a tool
that creates or updates something (marking an invoice paid, editing a load),
add it as a new, clearly-named tool rather than overloading an existing one,
and think about what confirmation step makes sense before an LLM can trigger
a real write against your business data.

## What's not exposed yet

**Drivers.** The public API has a `GET /api/public/v1/drivers` route, but it
currently returns a 403 for every caller: the org-level OAuth client
authenticates as a synthetic `finance`-role actor (deliberately
least-privileged — see CarrierOS's `lib/public-api-auth.ts`), and listing
drivers requires the `drivers` role capability, which `finance` doesn't hold.
This is left as an open product/security decision on the CarrierOS side
(should the public API get a dedicated capability set, or should this stay
blocked) — not something to work around from this project. No `list_drivers`
tool exists here until that's resolved.

**Dispatch, customers, and anything else** not yet under
`carrieros-web/app/api/public/v1/` isn't reachable this way at all.
Expanding this server further means either the CarrierOS public API grows
first, or this project starts calling the internal `/api/v1/*` surface
directly with a real user session instead of an org-level OAuth client (a
bigger, different kind of auth to get right — worth a separate conversation
before doing it).
