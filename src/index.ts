#!/usr/bin/env node
// Local MCP server exposing CarrierOS's public developer API (read-only) as
// tools an LLM can call. Runs over stdio, as a subprocess of an MCP client
// (Claude Desktop, OpenClaw, etc.) — see README.md for client config.
//
// For the hosted multi-tenant HTTP version, see http-server.ts.
//
// Loads .env for standalone/dev use (e.g. `npm run dev`). Never overrides a variable an MCP client
// already set via its own server-launch config, so a real client config always wins.
import 'dotenv/config'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CarrierOsClient, loadConfigFromEnv } from './carrieros-client.js'
import { createMcpServer } from './server-factory.js'

async function main() {
  const config = loadConfigFromEnv()
  const client = new CarrierOsClient(config)
  const server = createMcpServer(client)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('Fatal error starting carrieros-mcp:', err)
  process.exit(1)
})
