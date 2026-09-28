#!/usr/bin/env node
// Hosted multi-tenant MCP server: same tools as index.ts (stdio), served
// over Streamable HTTP so remote clients (a customer's Claude Desktop,
// ChatGPT connectors, etc.) can reach it without running any code locally.
//
// Stateless and credential-free by design: this process never stores a
// customer's CarrierOS OAuth client id/secret. Each request carries its own
// tenant's credentials via headers, a fresh CarrierOsClient + MCP Server is
// built for that single request, and nothing is kept afterward. This avoids
// needing a customer/tenant database on this server just to route requests
// — the CarrierOS OAuth client itself is the tenant identity.
//
// MUST be deployed behind TLS (ALB/CloudFront in front of ECS, etc.) since
// credentials travel in headers on every request.
import express from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CarrierOsClient, type CarrierOsConfig } from './carrieros-client.js'
import { createMcpServer } from './server-factory.js'

const PORT = Number(process.env.PORT ?? 8080)

function readTenantConfig(req: express.Request): CarrierOsConfig | null {
  const baseUrl = req.header('x-carrieros-base-url')
  const clientId = req.header('x-carrieros-client-id')
  const clientSecret = req.header('x-carrieros-client-secret')
  if (!baseUrl || !clientId || !clientSecret) return null
  return { baseUrl, clientId, clientSecret }
}

const app = express()
app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.post('/mcp', async (req, res) => {
  const config = readTenantConfig(req)
  if (!config) {
    res.status(401).json({
      error: 'missing_tenant_credentials',
      error_description: 'x-carrieros-base-url, x-carrieros-client-id, and x-carrieros-client-secret headers are all required.',
    })
    return
  }

  const client = new CarrierOsClient(config)
  const server = createMcpServer(client)
  // Stateless mode: no sessionIdGenerator, so a fresh transport handles
  // exactly one request/response cycle and is discarded — matches the
  // fresh-server-per-request model above.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

  res.on('close', () => {
    transport.close()
    server.close()
  })

  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
})

// Stateless mode doesn't support the GET (server->client stream) or DELETE
// (session teardown) verbs — only POST request/response.
app.get('/mcp', (_req, res) => {
  res.status(405).json({ error: 'method_not_allowed', error_description: 'This deployment is stateless; use POST /mcp.' })
})
app.delete('/mcp', (_req, res) => {
  res.status(405).json({ error: 'method_not_allowed', error_description: 'This deployment is stateless; use POST /mcp.' })
})

app.listen(PORT, () => {
  console.log(`carrieros-mcp HTTP server listening on :${PORT}`)
})
