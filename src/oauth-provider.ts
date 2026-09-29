import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Response } from 'express'
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { InvalidClientError, InvalidGrantError, InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { CarrierOsConfig } from './carrieros-client.js'

const ACCESS_TTL = 60 * 60
const REFRESH_TTL = 30 * 24 * 60 * 60
const AUTH_CODE_TTL = 5 * 60
const CLIENT_TTL = 365 * 24 * 60 * 60
const SCOPE = 'mcp:tools'

interface CredentialPayload {
  purpose: 'access' | 'refresh' | 'auth-code' | 'form' | 'client'
  exp: number
  iat: number
  [key: string]: unknown
}

function nowSeconds(): number { return Math.floor(Date.now() / 1000) }

function oauthKey(): Buffer {
  const value = process.env.MCP_OAUTH_ENCRYPTION_KEY
  if (!value) throw new Error('MCP_OAUTH_ENCRYPTION_KEY is required for hosted OAuth')
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32) throw new Error('MCP_OAUTH_ENCRYPTION_KEY must be a base64-encoded 32-byte key')
  return key
}

function seal(payload: CredentialPayload): string {
  const key = oauthKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()])
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.')
}

function open(token: string, purpose: CredentialPayload['purpose']): CredentialPayload {
  try {
    const [ivPart, tagPart, dataPart] = token.split('.')
    if (!ivPart || !tagPart || !dataPart) throw new Error('invalid token')
    const decipher = createDecipheriv('aes-256-gcm', oauthKey(), Buffer.from(ivPart, 'base64url'))
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString()
    const payload = JSON.parse(plaintext) as CredentialPayload
    if (payload.purpose !== purpose || !Number.isInteger(payload.exp) || payload.exp <= nowSeconds()) throw new Error('expired token')
    return payload
  } catch {
    throw new InvalidGrantError('Invalid or expired OAuth token')
  }
}

function sign(data: string): string {
  return createHmac('sha256', oauthKey()).update(data).digest('base64url')
}

function encodeClient(info: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(info)).toString('base64url')
  return `crs_${payload}.${sign(payload)}`
}

function decodeClient(clientId: string): OAuthClientInformationFull | undefined {
  if (!clientId.startsWith('crs_')) return undefined
  const [payload, signature] = clientId.slice(4).split('.')
  if (!payload || !signature) return undefined
  const expected = Buffer.from(sign(payload))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined
  try {
    const info = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Omit<OAuthClientInformationFull, 'client_id'>
    if (!Array.isArray(info.redirect_uris) || typeof info.client_id_issued_at !== 'number' || info.client_id_issued_at + CLIENT_TTL < nowSeconds()) return undefined
    return { ...info, client_id: clientId } as OAuthClientInformationFull
  } catch { return undefined }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

function carrierOsBaseUrl(): string {
  const raw = process.env.CARRIEROS_BASE_URL
  if (!raw) throw new Error('CARRIEROS_BASE_URL is required for OAuth authorization')
  const url = new URL(raw)
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('CARRIEROS_BASE_URL must use HTTPS')
  }
  return url.origin
}

async function validateCarrierOsCredentials(config: CarrierOsConfig): Promise<void> {
  const response = await fetch(`${config.baseUrl}/api/public/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new InvalidRequestError('CarrierOS credentials were rejected or the Public API is not enabled for this organization.')
  const body = await response.json().catch(() => null) as { access_token?: unknown } | null
  if (typeof body?.access_token !== 'string' || !body.access_token) throw new InvalidRequestError('CarrierOS did not return a valid access token.')
}

export class CarrierOsOAuthProvider implements OAuthServerProvider {
  private readonly consumedCodes = new Map<string, number>()

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: async (clientId) => decodeClient(clientId),
    registerClient: async (metadata) => {
      if (metadata.token_endpoint_auth_method !== 'none') throw new InvalidClientError('Only public OAuth clients are supported')
      const info = {
        ...metadata,
        client_id_issued_at: nowSeconds(),
        client_secret: undefined,
        client_secret_expires_at: undefined,
      } as Omit<OAuthClientInformationFull, 'client_id'>
      const clientId = encodeClient(info as Record<string, unknown>)
      return { ...info, client_id: clientId } as OAuthClientInformationFull
    },
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.scopes?.some((scope) => scope !== SCOPE)) throw new InvalidRequestError('Unsupported OAuth scope')
    const baseUrl = carrierOsBaseUrl()
    const state = seal({
      purpose: 'form', exp: nowSeconds() + 10 * 60, iat: nowSeconds(),
      clientId: client.client_id, redirectUri: params.redirectUri, oauthState: params.state,
      codeChallenge: params.codeChallenge, scopes: params.scopes ?? [SCOPE], resource: params.resource?.href,
      baseUrl,
    })
    const name = escapeHtml(client.client_name ?? 'LLM client')
    res.status(200).set({ 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", 'x-frame-options': 'DENY' }).send(`<!doctype html><html><head><meta charset="utf-8"><title>Connect CarrierOS</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#172033}label{display:block;margin:1rem 0 .35rem}input{box-sizing:border-box;width:100%;padding:.7rem}button{margin-top:1.2rem;padding:.7rem 1rem}small{color:#556}</style></head><body><h1>Connect CarrierOS staging</h1><p><strong>${name}</strong> is requesting read-only access to this CarrierOS organization through the Developer API.</p><p>Credentials are exchanged with CarrierOS and carried only in encrypted, expiring tokens. They are not saved in an MCP database.</p><form method="post" action="/oauth/authorize/complete"><input type="hidden" name="form_token" value="${escapeHtml(state)}"><label for="id">Developer API client ID</label><input id="id" name="client_id" autocomplete="username" required><label for="secret">Developer API client secret</label><input id="secret" name="client_secret" type="password" autocomplete="current-password" required><small>Create credentials in CarrierOS Settings → Developer API. You can revoke them there at any time.</small><br><button type="submit">Authorize read-only access</button></form></body></html>`)
  }

  async completeAuthorization(formToken: string, config: CarrierOsConfig): Promise<{ code: string; redirectUri: string; state?: string }> {
    const request = open(formToken, 'form')
    if (request.baseUrl !== config.baseUrl) throw new InvalidRequestError('CarrierOS staging configuration changed during authorization; restart the connection flow.')
    await validateCarrierOsCredentials(config)
    const code = seal({
      purpose: 'auth-code', exp: nowSeconds() + AUTH_CODE_TTL, iat: nowSeconds(),
      jti: randomUUID(), clientId: request.clientId, redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge, oauthState: request.oauthState, scopes: request.scopes,
      resource: request.resource, baseUrl: config.baseUrl, carrierOsClientId: config.clientId,
      carrierOsClientSecret: config.clientSecret,
    })
    return { code, redirectUri: String(request.redirectUri), state: typeof request.oauthState === 'string' ? request.oauthState : undefined }
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const payload = open(authorizationCode, 'auth-code')
    if (payload.clientId !== client.client_id || typeof payload.codeChallenge !== 'string') throw new InvalidGrantError('Authorization code was not issued to this client')
    return payload.codeChallenge
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const payload = open(authorizationCode, 'auth-code')
    if (payload.clientId !== client.client_id || payload.redirectUri !== redirectUri) throw new InvalidGrantError('Authorization code does not match this client or redirect URI')
    if (payload.resource && resource?.href !== payload.resource) throw new InvalidGrantError('Authorization code was issued for a different resource')
    const jti = String(payload.jti)
    const now = nowSeconds()
    for (const [id, expiry] of this.consumedCodes) if (expiry <= now) this.consumedCodes.delete(id)
    if (this.consumedCodes.has(jti)) throw new InvalidGrantError('Authorization code was already used')
    this.consumedCodes.set(jti, Number(payload.exp))
    const credentials = { baseUrl: String(payload.baseUrl), clientId: String(payload.carrierOsClientId), clientSecret: String(payload.carrierOsClientSecret) }
    const access = seal({ purpose: 'access', iat: now, exp: now + ACCESS_TTL, clientId: client.client_id, scopes: payload.scopes, resource: payload.resource, credentials })
    const refresh = seal({ purpose: 'refresh', iat: Number(payload.iat), exp: Number(payload.iat) + REFRESH_TTL, clientId: client.client_id, scopes: payload.scopes, resource: payload.resource, credentials })
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: (payload.scopes as string[]).join(' ') }
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const payload = open(refreshToken, 'refresh')
    if (payload.clientId !== client.client_id) throw new InvalidGrantError('Refresh token was issued to another client')
    if (scopes?.some((scope) => !(payload.scopes as string[]).includes(scope))) throw new InvalidGrantError('Requested scope exceeds the original grant')
    if (payload.resource && resource?.href !== payload.resource) throw new InvalidGrantError('Refresh token was issued for a different resource')
    const now = nowSeconds()
    const access = seal({ purpose: 'access', iat: now, exp: now + ACCESS_TTL, clientId: client.client_id, scopes: payload.scopes, resource: payload.resource, credentials: payload.credentials })
    const refresh = seal({ ...payload, purpose: 'refresh' })
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: (payload.scopes as string[]).join(' ') }
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const payload = open(token, 'access')
    const credentials = payload.credentials as CarrierOsConfig
    if (!credentials || typeof credentials.clientId !== 'string' || typeof credentials.clientSecret !== 'string' || typeof credentials.baseUrl !== 'string') throw new InvalidGrantError('Malformed access token')
    return {
      token, clientId: String(payload.clientId), scopes: payload.scopes as string[], expiresAt: Number(payload.exp),
      resource: typeof payload.resource === 'string' ? new URL(payload.resource) : undefined,
      extra: { carrierOsConfig: credentials },
    }
  }

}
