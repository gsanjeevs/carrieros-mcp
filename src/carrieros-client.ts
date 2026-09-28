// Thin client for CarrierOS's public developer API (/api/public/v1/*), the
// same OAuth 2.0 client-credentials surface a third-party integration would
// use — see carrieros/carrieros-web/app/api/public/v1/. Tokens expire in
// 3600s (server-side constant); cached in memory and refreshed a little
// early so a long-running MCP server session never hands a stale token to a
// tool call mid-request.

export interface CarrierOsConfig {
  baseUrl: string
  clientId: string
  clientSecret: string
}

interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
}

interface PublicApiError {
  error: string
  error_description: string
}

export class CarrierOsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'CarrierOsApiError'
  }
}

export class CarrierOsClient {
  private accessToken: string | null = null
  private tokenExpiresAt = 0

  constructor(private readonly config: CarrierOsConfig) {}

  private async getToken(): Promise<string> {
    // 60s safety margin before the real expiry, not the exact boundary.
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken
    }
    const res = await fetch(`${this.config.baseUrl}/api/public/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as PublicApiError | null
      throw new CarrierOsApiError(res.status, body?.error ?? 'token_error', body?.error_description ?? 'Could not obtain an access token')
    }
    const token = (await res.json()) as TokenResponse
    this.accessToken = token.access_token
    this.tokenExpiresAt = Date.now() + token.expires_in * 1000
    return this.accessToken
  }

  async get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const token = await this.getToken()
    const url = new URL(`${this.config.baseUrl}${path}`)
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as PublicApiError | null
      throw new CarrierOsApiError(res.status, body?.error ?? 'request_error', body?.error_description ?? `Request to ${path} failed (${res.status})`)
    }
    return (await res.json()) as T
  }
}

export function loadConfigFromEnv(): CarrierOsConfig {
  const baseUrl = process.env.CARRIEROS_BASE_URL
  const clientId = process.env.CARRIEROS_CLIENT_ID
  const clientSecret = process.env.CARRIEROS_CLIENT_SECRET
  if (!baseUrl || !clientId || !clientSecret) {
    throw new Error('CARRIEROS_BASE_URL, CARRIEROS_CLIENT_ID, and CARRIEROS_CLIENT_SECRET must all be set (see .env.example).')
  }
  return { baseUrl, clientId, clientSecret }
}
