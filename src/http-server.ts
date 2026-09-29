#!/usr/bin/env node
// Hosted multi-tenant MCP server: same tools as index.ts (stdio), served
// over Streamable HTTP so remote clients (a customer's Claude Desktop,
// ChatGPT connectors, etc.) can reach it without running any code locally.
//
// Stateless by design: header-authenticated requests carry tenant credentials
// directly, while OAuth credentials are encrypted into short-lived tokens.
// There is no persistent tenant-credential database. A fresh CarrierOsClient
// and MCP Server is built per MCP request, with the CarrierOS OAuth client as
// the tenant identity.
//
// MUST be deployed behind TLS (ALB/CloudFront in front of ECS, etc.) since
// credentials travel in headers on every request.
import express from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { CarrierOsClient, type CarrierOsConfig } from './carrieros-client.js'
import { createMcpServer } from './server-factory.js'
import { CarrierOsOAuthProvider } from './oauth-provider.js'

const PORT = Number(process.env.PORT ?? 8080)
const PUBLIC_URL = new URL(process.env.MCP_PUBLIC_URL ?? `http://localhost:${PORT}`)
const MCP_RESOURCE_URL = new URL('/mcp', PUBLIC_URL)
const oauthProvider = new CarrierOsOAuthProvider()
const oauthEnabled = Boolean(process.env.MCP_OAUTH_ENCRYPTION_KEY)

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

if (oauthEnabled) {
  app.use(mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: PUBLIC_URL,
    resourceServerUrl: MCP_RESOURCE_URL,
    resourceName: 'CarrierOS MCP',
    serviceDocumentationUrl: new URL('https://github.com/gsanjeevs/carrieros-mcp'),
    scopesSupported: ['mcp:tools'],
    clientRegistrationOptions: { clientIdGeneration: false },
  }))
}

app.post('/oauth/authorize/complete', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const formToken = typeof req.body?.form_token === 'string' ? req.body.form_token : ''
    const clientId = typeof req.body?.client_id === 'string' ? req.body.client_id.trim() : ''
    const clientSecret = typeof req.body?.client_secret === 'string' ? req.body.client_secret : ''
    if (!formToken || !clientId || !clientSecret) {
      res.status(400).send('CarrierOS client ID and client secret are required.')
      return
    }
    if (!oauthEnabled) throw new Error('OAuth is not configured on this server')
    const configuredBaseUrl = process.env.CARRIEROS_BASE_URL
    if (!configuredBaseUrl) throw new Error('OAuth is missing CARRIEROS_BASE_URL configuration')
    const result = await oauthProvider.completeAuthorization(formToken, { baseUrl: new URL(configuredBaseUrl).origin, clientId, clientSecret })
    const redirect = new URL(result.redirectUri)
    redirect.searchParams.set('code', result.code)
    if (result.state !== undefined) redirect.searchParams.set('state', result.state)
    res.redirect(303, redirect.toString())
  } catch (error) {
    res.status(400).set('cache-control', 'no-store').send(`CarrierOS authorization failed: ${error instanceof Error ? error.message : 'Invalid request'}`)
  }
})

app.post('/mcp', async (req, res) => {
  let config = readTenantConfig(req)
  if (!config) {
    const bearer = req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
    if (bearer) {
      try {
        const authInfo = await oauthProvider.verifyAccessToken(bearer)
        if ((authInfo.resource && authInfo.resource.href !== MCP_RESOURCE_URL.href) || !authInfo.scopes.includes('mcp:tools')) {
          throw new Error('OAuth token is not valid for this MCP resource or scope')
        }
        config = authInfo.extra?.carrierOsConfig as CarrierOsConfig
      } catch {
        // The protocol response below includes the resource metadata URL that
        // lets OAuth-capable clients discover this server's login flow.
      }
    }
  }
  if (!config) {
    if (oauthEnabled) {
      const metadataUrl = getOAuthProtectedResourceMetadataUrl(MCP_RESOURCE_URL)
      res.set('www-authenticate', `Bearer resource_metadata="${metadataUrl}", scope="mcp:tools"`)
    }
    res.status(401).json({ error: 'unauthorized', error_description: oauthEnabled ? 'Authenticate with OAuth or provide x-carrieros-* headers.' : 'x-carrieros-base-url, x-carrieros-client-id, and x-carrieros-client-secret headers are required.' })
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
