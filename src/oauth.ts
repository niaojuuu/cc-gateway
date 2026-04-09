import { request as httpsRequest } from 'https'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { createHash, randomBytes } from 'crypto'
import { log } from './logger.js'
import { getProxyAgent } from './proxy-agent.js'

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize'
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback'
let CONFIG_PATH = resolve(process.cwd(), 'config.yaml')

export function setConfigPath(p: string) {
  CONFIG_PATH = resolve(p)
}
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const DEFAULT_SCOPES = [
  'org:create_api_key',
  'user:inference',
  'user:profile',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
]

type OAuthTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

let cachedTokens: OAuthTokens | null = null

/**
 * Initialize OAuth.
 * If a valid access_token is provided, use it immediately — no network call.
 * Only refresh when the token is expired or about to expire.
 */
export async function initOAuth(oauth: {
  access_token?: string
  refresh_token: string
  expires_at?: number
}): Promise<void> {
  const now = Date.now()
  const expiresAt = oauth.expires_at ?? 0
  const fiveMinutes = 5 * 60 * 1000

  // Use existing access token if still valid (with 5-min buffer)
  if (oauth.access_token && expiresAt > now + fiveMinutes) {
    cachedTokens = {
      accessToken: oauth.access_token,
      refreshToken: oauth.refresh_token,
      expiresAt,
    }
    const remaining = Math.round((expiresAt - now) / 60_000)
    log('info', `Using existing access token (expires in ${remaining} min)`)
    scheduleRefresh(oauth.refresh_token)
    return
  }

  // Token missing or expired — must refresh
  if (oauth.access_token) {
    log('info', 'Access token expired, refreshing...')
  } else {
    log('info', 'No access token provided, refreshing...')
  }

  cachedTokens = await refreshOAuthToken(oauth.refresh_token)
  log('info', `OAuth token acquired, expires at ${new Date(cachedTokens.expiresAt).toISOString()}`)
  scheduleRefresh(oauth.refresh_token)
}

function scheduleRefresh(refreshToken: string) {
  if (!cachedTokens) return

  const msUntilExpiry = cachedTokens.expiresAt - Date.now()
  const refreshIn = Math.max(msUntilExpiry - 5 * 60 * 1000, 10_000)

  setTimeout(async () => {
    try {
      const oldAccessToken = cachedTokens?.accessToken || ''
      const oldRefreshToken = cachedTokens?.refreshToken || refreshToken

      log('info', 'Auto-refreshing OAuth token...')
      cachedTokens = await refreshOAuthToken(
        cachedTokens?.refreshToken || refreshToken,
      )

      log('info', `Token refreshed:`)
      log('info', `  access_token:  ${oldAccessToken.slice(0, 20)}... → ${cachedTokens.accessToken.slice(0, 20)}...`)
      log('info', `  refresh_token: ${oldRefreshToken.slice(0, 20)}... → ${cachedTokens.refreshToken.slice(0, 20)}...`)
      log('info', `  expires_at:    ${new Date(cachedTokens.expiresAt).toISOString()}`)

      persistTokens()
      scheduleRefresh(cachedTokens.refreshToken || refreshToken)
    } catch (err) {
      log('error', `OAuth refresh failed: ${err}. Retrying in 30s...`)
      setTimeout(() => scheduleRefresh(refreshToken), 30_000)
    }
  }, refreshIn)
}

function persistTokens() {
  if (!cachedTokens) return
  try {
    let content = readFileSync(CONFIG_PATH, 'utf-8')
    const orig = content
    content = content.replace(
      /access_token:\s*"[^"]*"/,
      `access_token: "${cachedTokens.accessToken}"`,
    )
    content = content.replace(
      /refresh_token:\s*"[^"]*"/,
      `refresh_token: "${cachedTokens.refreshToken}"`,
    )
    content = content.replace(
      /expires_at:\s*\d+/,
      `expires_at: ${cachedTokens.expiresAt}`,
    )
    if (content === orig) {
      log('warn', 'persistTokens: no changes to write (regex did not match?)')
      return
    }
    const newAccessMatch = content.match(/access_token:\s*"([^"]*)"/)
    log('info', `persistTokens: writing to ${CONFIG_PATH} (${Buffer.byteLength(content)} bytes)`)
    log('info', `persistTokens: new access_token prefix: ${newAccessMatch?.[1]?.slice(0, 20) || 'NOT FOUND'}...`)
    writeFileSync(CONFIG_PATH, content, 'utf-8')
    // Verify write
    const verify = readFileSync(CONFIG_PATH, 'utf-8')
    const verifyAccessMatch = verify.match(/access_token:\s*"([^"]*)"/)
    if (verify !== content) {
      log('error', `persistTokens: write verification FAILED (file unchanged after write)`)
      log('error', `persistTokens: expected access_token prefix: ${newAccessMatch?.[1]?.slice(0, 20) || '?'}`)
      log('error', `persistTokens: file access_token prefix: ${verifyAccessMatch?.[1]?.slice(0, 20) || '?'}`)
    } else {
      log('info', `persistTokens: verified OK, access_token updated to ${verifyAccessMatch?.[1]?.slice(0, 20) || '?'}...`)
    }
  } catch (err) {
    log('error', `Failed to persist tokens to config.yaml (${CONFIG_PATH}): ${err}`)
  }
}

export function getAccessToken(): string | null {
  if (!cachedTokens) return null
  if (Date.now() >= cachedTokens.expiresAt) {
    log('warn', 'OAuth token expired, waiting for refresh...')
    return null
  }
  return cachedTokens.accessToken
}

let refreshing = false
export async function forceRefreshToken(): Promise<boolean> {
  if (refreshing || !cachedTokens) return false
  refreshing = true
  try {
    const oldAccessToken = cachedTokens.accessToken
    const oldRefreshToken = cachedTokens.refreshToken
    log('warn', 'Forcing OAuth token refresh (received 401)...')
    cachedTokens = await refreshOAuthToken(cachedTokens.refreshToken)
    log('info', `Token refreshed (forced):`)
    log('info', `  access_token:  ${oldAccessToken.slice(0, 20)}... → ${cachedTokens.accessToken.slice(0, 20)}...`)
    log('info', `  refresh_token: ${oldRefreshToken.slice(0, 20)}... → ${cachedTokens.refreshToken.slice(0, 20)}...`)
    log('info', `  expires_at:    ${new Date(cachedTokens.expiresAt).toISOString()}`)
    persistTokens()
    scheduleRefresh(cachedTokens.refreshToken)
    return true
  } catch (err) {
    log('error', `Forced OAuth refresh failed: ${err}`)
    return false
  } finally {
    refreshing = false
  }
}

function refreshOAuthToken(refreshToken: string): Promise<OAuthTokens> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: DEFAULT_SCOPES.join(' '),
    })

    const url = new URL(TOKEN_URL)
    const agent = getProxyAgent()
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
        },
        ...(agent && { agent }),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
          if (res.statusCode !== 200) {
            reject(new Error(`OAuth refresh failed (${res.statusCode}): ${JSON.stringify(data)}`))
            return
          }
          resolve({
            accessToken: data.access_token,
            refreshToken: data.refresh_token || refreshToken,
            expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
          })
        })
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ── PKCE + OAuth Login Flow ──

export function generatePKCE(): { codeVerifier: string; codeChallenge: string; state: string } {
  const codeVerifier = randomBytes(64).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const state = randomBytes(16).toString('hex')
  return { codeVerifier, codeChallenge, state }
}

export function buildAuthUrl(codeChallenge: string, state: string): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', DEFAULT_SCOPES.join(' '))
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  return url.toString()
}

export async function loginWithCode(code: string, codeVerifier: string, state: string): Promise<void> {
  const body = JSON.stringify({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
    state,
  })

  const data = await new Promise<any>((resolve, reject) => {
    const url = new URL(TOKEN_URL)
    const agent = getProxyAgent()
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
        },
        ...(agent && { agent }),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
          if (res.statusCode !== 200) {
            reject(new Error(`OAuth login failed (${res.statusCode}): ${JSON.stringify(data)}`))
            return
          }
          resolve(data)
        })
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })

  cachedTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  }

  log('info', 'OAuth login successful!')
  log('info', `  access_token:  ${data.access_token.slice(0, 20)}...`)
  log('info', `  refresh_token: ${data.refresh_token.slice(0, 20)}...`)
  log('info', `  expires_at:    ${new Date(cachedTokens.expiresAt).toISOString()}`)

  persistTokens()
  scheduleRefresh(data.refresh_token)
}
