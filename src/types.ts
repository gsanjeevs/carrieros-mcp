// Response shapes for /api/public/v1/*, confirmed against a live CarrierOS
// dev instance (2026-09-28). These mirror carrieros-web/server/contract/
// schemas.ts's public-facing record shapes — kept as plain types here since
// this project doesn't share a build with the CarrierOS monorepo.

export interface PublicLoadSummary {
  id: number
  load_number: string
  status: string
  customer_name_raw: string | null
  pickup_city: string | null
  pickup_state: string | null
  delivery_city: string | null
  delivery_state: string | null
  pickup_date: string | null
  delivery_date: string | null
  commodity: string | null
  driver_id: number | null
  rate: number | null
}

export interface ListLoadsResponse {
  loads: PublicLoadSummary[]
  can_see_rate: boolean
}

export interface PublicLoadDetail {
  id: number
  load_number: string
  status: string
  customer_name_raw: string | null
  pickup_address: string | null
  pickup_city: string | null
  pickup_state: string | null
  pickup_date: string | null
  pickup_time: string | null
  delivery_address: string | null
  delivery_city: string | null
  delivery_state: string | null
  delivery_date: string | null
  delivery_time: string | null
  commodity: string | null
  weight_lbs: number | null
  total_miles: number | null
  driver_id: number | null
  vehicle_id: number | null
  rate: number | null
}

export interface GetLoadResponse {
  load: PublicLoadDetail
  // Shape not fully confirmed live (the test load had none) — treated as opaque records rather than
  // guessing exact fields.
  events: unknown[]
}

export interface PublicInvoiceSummary {
  id: number
  invoice_number: string
  amount: number
  status: string
  due_date: string | null
  opened_at: string | null
}

export interface ListInvoicesResponse {
  invoices: PublicInvoiceSummary[]
}

export interface PublicInvoiceDetail extends PublicInvoiceSummary {
  notes: string | null
  sent_at: string | null
  paid_at: string | null
  load_id: number | null
}

export interface PublicVehicle {
  id: number
  vehicle_number: string | null
  nickname: string | null
  status: string
  photo_url: string | null
}

export interface ListVehiclesResponse {
  vehicles: PublicVehicle[]
}

export interface PublicException {
  entity_type: string
  entity_id: number
  exception_type: string
  tier: string
  title: string
  detail: string
  due_at: string | null
}

export interface ListExceptionsResponse {
  exceptions: PublicException[]
}

export interface FinancialEvent {
  id: number
  event_type: string
  occurred_at: string
  [key: string]: unknown
}

export interface ListFinancialEventsResponse {
  events: FinancialEvent[]
  next_cursor: string | null
}
