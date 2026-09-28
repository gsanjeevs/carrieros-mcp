// Builds an MCP Server instance wired to a given CarrierOsClient. Shared by
// both entrypoints (stdio for local/desktop clients, HTTP for the hosted
// multi-tenant deployment) so the tool definitions and handlers only exist
// in one place.
//
// Deliberately read-only for now: every tool here maps to a GET route on
// /api/public/v1/*. No write tools (create/update loads or invoices) exist
// yet — add them only once there's a real need, since a chat interface
// mutating billing/dispatch data carries real risk an "ask questions" tool
// doesn't.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { CarrierOsApiError, CarrierOsClient } from './carrieros-client.js'
import type {
  GetLoadResponse,
  ListExceptionsResponse,
  ListFinancialEventsResponse,
  ListInvoicesResponse,
  ListLoadsResponse,
  ListVehiclesResponse,
  PublicInvoiceDetail,
} from './types.js'

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true as const }
}

export function createMcpServer(client: CarrierOsClient): Server {
  const server = new Server(
    { name: 'carrieros', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_loads',
        description: 'List the carrier\'s loads (shipments) — id, status, route, customer, driver, rate. Use this for questions like "what loads are active" or "show me recent loads".',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max loads to return (1-100, default server-side).', minimum: 1, maximum: 100 },
          },
        },
      },
      {
        name: 'get_load',
        description: 'Get full detail for one load by its numeric id (from list_loads) — pickup/delivery address, weight, mileage, driver/vehicle assignment, and its event history.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The load\'s numeric id.' },
          },
          required: ['id'],
        },
      },
      {
        name: 'list_invoices',
        description: 'List the carrier\'s invoices — number, amount, status (draft/sent/paid/overdue), due date. Use this for questions like "what\'s overdue" or "show unpaid invoices".',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_invoice',
        description: 'Get full detail for one invoice by its numeric id (from list_invoices) — notes, sent/paid timestamps, and the load it belongs to.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The invoice\'s numeric id.' },
          },
          required: ['id'],
        },
      },
      {
        name: 'list_vehicles',
        description: 'List the carrier\'s active vehicles/trucks — number, nickname, status. Use this for questions like "how many trucks do we have" or "what\'s our fleet".',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_exceptions',
        description: 'List active operational exceptions (compliance issues, overdue invoices, missing proof-of-delivery, expiring credentials, etc.) that need attention. Use this for "what needs my attention right now" style questions.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_financial_events',
        description: 'List a cursor-paginated ledger of invoice/settlement/expense events, oldest-relevant-window first — useful for "what changed recently" or building an activity summary. Pass the previous response\'s next_cursor to page forward.',
        inputSchema: {
          type: 'object',
          properties: {
            cursor: { type: 'string', description: 'Pagination cursor from a previous response\'s next_cursor.' },
            limit: { type: 'number', description: 'Max events to return.' },
          },
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    try {
      switch (name) {
        case 'list_loads': {
          const limit = typeof args?.limit === 'number' ? args.limit : undefined
          const result = await client.get<ListLoadsResponse>('/api/public/v1/loads', { limit })
          return textResult(result)
        }
        case 'get_load': {
          const id = args?.id
          if (typeof id !== 'number') return errorResult('id is required and must be a number')
          const result = await client.get<GetLoadResponse>(`/api/public/v1/loads/${id}`)
          return textResult(result)
        }
        case 'list_invoices': {
          const result = await client.get<ListInvoicesResponse>('/api/public/v1/invoices')
          return textResult(result)
        }
        case 'get_invoice': {
          const id = args?.id
          if (typeof id !== 'number') return errorResult('id is required and must be a number')
          const result = await client.get<PublicInvoiceDetail>(`/api/public/v1/invoices/${id}`)
          return textResult(result)
        }
        case 'list_vehicles': {
          const result = await client.get<ListVehiclesResponse>('/api/public/v1/vehicles')
          return textResult(result)
        }
        case 'list_exceptions': {
          const result = await client.get<ListExceptionsResponse>('/api/public/v1/exceptions')
          return textResult(result)
        }
        case 'list_financial_events': {
          const cursor = typeof args?.cursor === 'string' ? args.cursor : undefined
          const limit = typeof args?.limit === 'number' ? args.limit : undefined
          const result = await client.get<ListFinancialEventsResponse>('/api/public/v1/financial-events', { cursor, limit })
          return textResult(result)
        }
        default:
          return errorResult(`Unknown tool: ${name}`)
      }
    } catch (err) {
      if (err instanceof CarrierOsApiError) {
        return errorResult(`CarrierOS API error (${err.status} ${err.code}): ${err.message}`)
      }
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  return server
}
