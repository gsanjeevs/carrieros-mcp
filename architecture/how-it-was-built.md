# How carrieros-mcp was built

This is a walkthrough doc, meant to be read with the referenced files open
side by side — every code excerpt below is copied exactly from the real
file, with an exact `file_path:line_number` citation. It covers the whole
project (it's small — 454 lines of TypeScript across 5 files as of this
writing), how the two transports (stdio and hosted HTTP) share one core, and
how it fits into the wider CarrierOS system.

If you haven't read the CarrierOS monorepo's own walkthrough docs yet,
`../carrieros/architecture/walkthrough/03-api-and-public-api.md` covers the
API this project is a client of, including this exact project as its "real
external consumer" example.

## 1. Purpose

CarrierOS exposes a read-only public developer API
(`carrieros-web/app/api/public/v1/*`), authenticated via OAuth 2.0
client-credentials — the intended surface for third-party integrations.
`carrieros-mcp` wraps that API as an [MCP](https://modelcontextprotocol.io)
(Model Context Protocol) server, so an LLM client — Claude Desktop, an
OpenAI Agents SDK script, eventually a customer's own AI assistant — can
call `list_loads`, `get_load`, `list_invoices`, `get_invoice`,
`list_vehicles`, `list_exceptions`, and `list_financial_events` as ordinary
tool calls instead of the client needing to know anything about CarrierOS's
REST shape or OAuth flow.

It's deliberately **read-only**: every tool maps to a GET route. No tool
creates or mutates data (marking an invoice paid, editing a load) — that's a
conscious scope boundary, not an oversight, because a chat interface that
can write to real billing/dispatch data carries risk an "ask questions"
tool doesn't.

Two ways to run the same tool set:

- **stdio** (`src/index.ts`) — a local subprocess of a desktop MCP client.
  One CarrierOS OAuth credential per process (from `.env` or the client's
  own launch config). This is what a single developer or a technically
  comfortable customer runs locally.
- **HTTP** (`src/http-server.ts`) — a hosted, multi-tenant deployment
  (Docker/AWS ECS). Stateless and credential-free: every request carries
  its own tenant's CarrierOS OAuth credentials via headers, so the hosted
  process never stores a customer secret. This is what makes it possible to
  offer the server to customers without each of them installing anything.

## 2. File structure

```
carrieros-mcp/
├── src/
│   ├── carrieros-client.ts    Thin OAuth2 client-credentials HTTP client for
│   │                          CarrierOS's public API. In-memory token cache.
│   ├── types.ts               Response shapes for /api/public/v1/*, hand-mirrored
│   │                          from carrieros-web/server/contract/schemas.ts.
│   ├── server-factory.ts      createMcpServer(client) — the MCP tool definitions
│   │                          and handlers. Shared by both entrypoints below.
│   ├── index.ts                stdio entrypoint: one client, one server, one process.
│   └── http-server.ts          HTTP entrypoint: stateless, per-request tenant auth.
├── Dockerfile                  Multi-stage build for the HTTP entrypoint (ECS Express
│                                Mode convention, matching carrieros-web's Dockerfile).
├── .dockerignore
├── package.json                Two build outputs: dist/index.js (stdio), dist/http-server.js (HTTP).
├── .env.example / .env         Local-dev-only credentials (gitignored; never committed).
└── README.md                   User-facing setup/deploy instructions (this doc is the
                                 "how it's built" companion, not a replacement).
```

Note what's *not* here: no test suite, no CI workflow, no multi-tenant
credential store. This is a young, single-purpose project — worth being
explicit about that rather than implying more maturity than exists.

## 3. Key files

### `src/carrieros-client.ts` — the CarrierOS API client

The only place that knows how to talk to CarrierOS. It handles the OAuth2
client-credentials dance and caches the resulting token in memory, refreshed
a little early so a long tool-call sequence never hits a mid-request expiry:

```ts
// carrieros-mcp/src/carrieros-client.ts:36-46
export class CarrierOsClient {
  private accessToken: string | null = null
  private tokenExpiresAt = 0

  constructor(private readonly config: CarrierOsConfig) {}

  private async getToken(): Promise<string> {
    // 60s safety margin before the real expiry, not the exact boundary.
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken
    }
```

Note the constructor takes `config` as a plain argument — no module-scope
singleton, no implicit global state. That's what makes the HTTP entrypoint's
"one client per request, built from that request's headers" pattern (§3,
`http-server.ts` below) possible without any refactoring.

Errors from CarrierOS come back as a typed `CarrierOsApiError`
(`carrieros-mcp/src/carrieros-client.ts:25-34`) carrying the real HTTP
status and CarrierOS's own error code — `server-factory.ts` catches this
specifically so a tool call failure reads as "CarrierOS API error (404
not_found): load not found" rather than a raw stack trace.

### `src/types.ts` — response shapes

Plain TypeScript interfaces mirroring `carrieros-web/server/contract/schemas.ts`'s
public-facing shapes, hand-copied rather than shared via a package
(`carrieros-mcp/src/types.ts:1-4` — this project doesn't share a build with
the CarrierOS monorepo, so there's no automatic drift protection here; if
CarrierOS's public API contract changes, these need a manual update). Worth
flagging to the team: this is the one place in the project without a
verification mechanism, unlike CarrierOS's own `npm run check:api`.

### `src/server-factory.ts` — the actual MCP tools

This is where the 7 tools are defined and where each one maps to a
`CarrierOsClient` call. It exports one function, `createMcpServer`, that
both entrypoints call:

```ts
// carrieros-mcp/src/server-factory.ts:32-36
export function createMcpServer(client: CarrierOsClient): Server {
  const server = new Server(
    { name: 'carrieros', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )
```

Taking `client` as a parameter (rather than importing a shared instance) is
the same "no ambient state" pattern as `CarrierOsClient`'s constructor —
it's what lets `index.ts` build one client from `.env` and `http-server.ts`
build a fresh one per request, with zero duplicated tool-definition code.

Each tool call is wrapped in a `try`/`catch` that turns a `CarrierOsApiError`
into a readable message rather than letting it surface as an opaque
failure:

```ts
// carrieros-mcp/src/server-factory.ts:105-109 (representative — see list_loads)
case 'list_loads': {
  const limit = typeof args?.limit === 'number' ? args.limit : undefined
  const result = await client.get<ListLoadsResponse>('/api/public/v1/loads', { limit })
  return textResult(result)
}
```

### `src/index.ts` — stdio entrypoint

Deliberately thin — 26 lines. All it does is load `.env`, build one
`CarrierOsClient` from environment variables, hand it to `createMcpServer`,
and connect over stdio:

```ts
// carrieros-mcp/src/index.ts:15-21
async function main() {
  const config = loadConfigFromEnv()
  const client = new CarrierOsClient(config)
  const server = createMcpServer(client)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
```

This is what a desktop MCP client (Claude Desktop) launches as a
subprocess — see the `mcpServers` config block in `README.md`.

### `src/http-server.ts` — hosted, multi-tenant HTTP entrypoint

The one genuinely different piece: instead of one client built once at
startup, every incoming request builds its own client from headers, and the
process itself never sees or stores a customer's CarrierOS credentials:

```ts
// carrieros-mcp/src/http-server.ts:22-28
function readTenantConfig(req: express.Request): CarrierOsConfig | null {
  const baseUrl = req.header('x-carrieros-base-url')
  const clientId = req.header('x-carrieros-client-id')
  const clientSecret = req.header('x-carrieros-client-secret')
  if (!baseUrl || !clientId || !clientSecret) return null
  return { baseUrl, clientId, clientSecret }
}
```

```ts
// carrieros-mcp/src/http-server.ts:39-51
app.post('/mcp', async (req, res) => {
  const config = readTenantConfig(req)
  if (!config) {
    res.status(401).json({ ... })
    return
  }

  const client = new CarrierOsClient(config)
  const server = createMcpServer(client)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
```

`sessionIdGenerator: undefined` puts the MCP SDK's `StreamableHTTPServerTransport`
into **stateless mode** — each POST is handled as one self-contained
request/response, with no session kept between calls. That's a deliberate
match for the "fresh client + fresh server per request" model above: there's
nothing to keep in memory between requests, so there's no session to
manage. The tradeoff, documented in the route handlers for `GET`/`DELETE
/mcp` (`carrieros-mcp/src/http-server.ts:64-71`), is that server-initiated
push and explicit session teardown — both stateful-mode features — aren't
available; every deployment of this server only supports request/response.

## 4. How to trace a request end-to-end

**stdio path** (e.g. Claude Desktop asking "what loads are active"):

1. Claude Desktop reads `claude_desktop_config.json`, sees the `carrieros`
   entry, and spawns `node carrieros-mcp/dist/index.js` as a subprocess with
   the configured `env` block (or falls back to `.env` if `env` is omitted).
2. `index.ts`'s `main()` builds one `CarrierOsClient` and hands it to
   `createMcpServer`.
3. Claude sends an MCP `tools/call` message for `list_loads` over stdin.
4. `server-factory.ts`'s handler (§3 above) calls
   `client.get<ListLoadsResponse>('/api/public/v1/loads', ...)`.
5. `carrieros-client.ts`'s `getToken()` either reuses a cached token or
   does the OAuth2 client-credentials exchange against
   `POST {baseUrl}/api/public/v1/oauth/token`.
6. The GET request goes out with `Authorization: Bearer <token>`; the JSON
   response is wrapped as `{ content: [{ type: 'text', text: JSON.stringify(...) }] }`
   and written back to stdout for Claude to read.

**HTTP path** (a hosted customer deployment): same steps 4-6, except step 1
is a `POST /mcp` HTTP request carrying `x-carrieros-*` headers instead of a
subprocess launch, and steps 2-3 happen fresh inside that single request
(`http-server.ts:44-51`) rather than once at process startup. This was
verified for real during development — a one-shot MCP client script
connected over stdio to a locally built server, listed all 7 tools, and
called `list_loads` against a live local CarrierOS instance, returning real
load data (Acme Distribution, Dallas/Houston lanes). The HTTP path was
verified the same way: `curl` against `dist/http-server.js` directly, then
again inside the built Docker container — full `initialize` → `tools/call`
handshake returning real vehicle data (T-10, T-11, T-2).

## 5. Conventions and gotchas

- **Read-only is a scope decision, not a limitation to quietly work around.**
  `README.md`'s own "Scope, deliberately" section says: if you want a tool
  that creates or updates something, add it as a new, clearly-named tool
  rather than overloading an existing one, and think about what confirmation
  step makes sense before an LLM can trigger a real write.
- **No shared build with the CarrierOS monorepo.** `types.ts` is
  hand-mirrored from `carrieros-web/server/contract/schemas.ts` — there is
  no `check:api`-style CI gate here (unlike CarrierOS itself, which
  regenerates and verifies its typed client on every contract change). If
  the public API's response shape changes, this project's types silently
  go stale until someone notices a runtime mismatch.
- **The `.env` file is gitignored and never committed** — verified via
  `git ls-files` before the first push to `github.com/gsanjeevs/carrieros-mcp`.
  Only `.env.example` (placeholder values) is tracked.
- **The public API's OAuth client authenticates as a synthetic `finance`-role
  actor** (deliberately least-privileged), which is why there's no
  `list_drivers` tool — `GET /api/public/v1/drivers` currently 403s for
  every caller under that role. See `README.md`'s "What's not exposed yet"
  section, and `../carrieros/architecture/walkthrough/04-auth-and-authorization.md`
  for the full role/capability model this inherits.
- **TLS is mandatory for the HTTP deployment**, not optional — tenant
  credentials travel in request headers on every call, so an unencrypted
  deployment would leak them in transit. `README.md`'s hosted-deployment
  section calls this out explicitly.
- **Stateless HTTP mode has real limits**, not just a config toggle — see
  §3 above. If a future requirement needs server-push notifications or
  multi-turn session state, that's a deliberate mode change
  (`sessionIdGenerator` set to a real generator), not a bug fix.

## See also

- `README.md` — user-facing setup and hosted-deployment instructions
  (config examples, Docker commands, Claude Desktop connector setup).
- `../carrieros/architecture/walkthrough/03-api-and-public-api.md` — the
  CarrierOS-side doc covering the exact API this project consumes, written
  from the CarrierOS codebase's perspective.
- `../carrieros/architecture/walkthrough/04-auth-and-authorization.md` —
  the full role/capability model behind the public API's OAuth client.
