import { createServer as createHttpsServer, type ServerOptions } from 'https'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'http'
import { readFileSync } from 'fs'
import { gunzipSync } from 'zlib'
import { request as httpsRequest } from 'https'
import { URL } from 'url'
import type { Config } from './config.js'
import { authenticate, initAuth } from './auth.js'
import { getAccessToken, forceRefreshToken } from './oauth.js'
import { rewriteBody, rewriteHeaders } from './rewriter.js'
import { audit, log } from './logger.js'
import { getProxyAgent } from './proxy-agent.js'

// ── Global forwarding restriction state ──
let restricted = false
let restrictReason = ''

function setRestricted(reason: string) {
  restricted = true
  restrictReason = reason
  log('warn', `⚠ Gateway forwarding RESTRICTED: ${reason}`)
  log('warn', 'All subsequent requests will be rejected until server restart')
}

export function startProxy(config: Config) {
  initAuth(config)

  const upstream = new URL(config.upstream.url)
  const useTls = config.server.tls?.cert && config.server.tls?.key

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    handleRequest(req, res, config, upstream)
  }

  let server
  if (useTls) {
    const tlsOptions: ServerOptions = {
      cert: readFileSync(config.server.tls.cert),
      key: readFileSync(config.server.tls.key),
    }
    server = createHttpsServer(tlsOptions, handler)
  } else {
    server = createHttpServer(handler)
    log('warn', 'Running without TLS - only use for local development')
  }

  server.listen(config.server.port, () => {
    log('info', `CC Gateway listening on ${useTls ? 'https' : 'http'}://0.0.0.0:${config.server.port}`)
    log('info', `Upstream: ${config.upstream.url}`)
    log('info', `Canonical device_id: ${config.identity.device_id.slice(0, 8)}...`)
    log('info', `Authorized clients: ${config.auth.tokens.map(t => t.name).join(', ')}`)
  })

  return server
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  upstream: URL,
) {
  const method = req.method || 'GET'
  const path = req.url || '/'
  const clientIp = req.socket.remoteAddress || 'unknown'

  log('info', `← ${method} ${path} from ${clientIp}`)

  // Health check - no auth required
  if (path === '/_health') {
    const oauthOk = !!getAccessToken()
    const status = oauthOk ? 200 : 503
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: oauthOk ? 'ok' : 'degraded',
      oauth: oauthOk ? 'valid' : 'expired/refreshing',
      canonical_device: config.identity.device_id.slice(0, 8) + '...',
      canonical_platform: config.env.platform,
      upstream: config.upstream.url,
      clients: config.auth.tokens.map(t => t.name),
    }))
    return
  }

  // Dry-run verification - shows what would be rewritten (auth required)
  if (path === '/_verify') {
    const clientName = authenticate(req)
    if (!clientName) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    const sample = buildVerificationPayload(config)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(sample, null, 2))
    return
  }

  // Authenticate client (proxy-level auth)
  const clientName = authenticate(req)
  if (!clientName) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized - provide client token via x-api-key header' }))
    log('warn', `Unauthorized request: ${method} ${path}`)
    return
  }

  log('info', `Client "${clientName}" → ${method} ${path}`)

  // Check if gateway forwarding is restricted
  if (restricted) {
    res.writeHead(429, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: `Gateway forwarding restricted: ${restrictReason}`,
      },
      gateway_restricted: true,
    }))
    log('warn', `Rejected ${method} ${path} from "${clientName}" — forwarding restricted`)
    if (config.logging.audit) {
      audit(clientName, method, path, 429)
    }
    return
  }

  // Get the real OAuth token (managed by gateway)
  const oauthToken = getAccessToken()
  if (!oauthToken) {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'OAuth token not available - gateway is refreshing' }))
    log('error', 'No valid OAuth token available')
    return
  }

  // Collect request body
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  let body = Buffer.concat(chunks)

  // Rewrite identity fields in body
  if (body.length > 0) {
    try {
      body = rewriteBody(body, path, config) as Buffer<ArrayBuffer>
    } catch (err) {
      log('error', `Body rewrite failed for ${path}: ${err}`)
    }
  }

  // Rewrite headers (strips client auth, normalizes identity headers)
  const rewrittenHeaders = rewriteHeaders(
    req.headers as Record<string, string | string[] | undefined>,
    config,
  )

  // Inject the real OAuth token via x-api-key.
  // Anthropic accepts sk-ant-oat01- tokens in x-api-key header.
  rewrittenHeaders['x-api-key'] = oauthToken
  log('info', `Forwarding with x-api-key prefix: ${oauthToken.slice(0, 12)}...`)

  // Forward to upstream
  const upstreamUrl = new URL(path, upstream)

  const agent = getProxyAgent()
  const proxyReq = httpsRequest(
    upstreamUrl,
    {
      method,
      headers: {
        ...rewrittenHeaders,
        host: upstream.host,
        'content-length': String(body.length),
      },
      ...(agent && { agent }),
    },
    (proxyRes) => {
      const status = proxyRes.statusCode || 502

      const responseHeaders = { ...proxyRes.headers }
      // Remove hop-by-hop headers — Node.js http.Server auto-adds
      // transfer-encoding: chunked when no content-length is set
      delete responseHeaders['transfer-encoding']
      delete responseHeaders['connection']
      // Drop content-length to avoid chunked re-encoding conflict with
      // upstream's gzip stream — Node.js will use chunked transfer instead
      delete responseHeaders['content-length']

      // 401: don't forward upstream headers — we return our own clean JSON
      if (status === 401) {
        const chunks: Buffer[] = []
        proxyRes.on('data', (chunk) => chunks.push(chunk))
        proxyRes.on('end', async () => {
          const raw = Buffer.concat(chunks)
          const bodyText = decompressBody(raw, responseHeaders)
          log('error', `Upstream 401 response:\n${bodyText}`)

          const refreshed = await forceRefreshToken()
          if (refreshed) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              type: 'error',
              error: {
                type: 'authentication_error',
                message: 'Gateway token expired, refreshing. Please retry.',
              },
              gateway_retry_hint: true,
            }))
          } else {
            log('error', 'Token refresh failed — forwarding stopped')
            setRestricted('OAuth token refresh failed after 401')
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              type: 'error',
              error: {
                type: 'api_error',
                message: 'Gateway authentication failed, token refresh failed. Manual restart required.',
              },
              gateway_restricted: true,
            }))
          }
        })
        return
      }

      // Forward all responses with upstream headers (gzip etc.)
      res.writeHead(status, responseHeaders)

      // Error responses: collect body for restriction detection, then forward
      if (status === 429) {
        const chunks: Buffer[] = []
        proxyRes.on('data', (chunk) => {
          chunks.push(chunk)
          res.write(chunk)
        })
        proxyRes.on('end', () => {
          const raw = Buffer.concat(chunks)
          const bodyText = decompressBody(raw, responseHeaders)
          setRestricted(`Anthropic rate limited (HTTP 429): ${bodyText}`)
          log('error', `Upstream 429 response:\n${bodyText}`)
          res.end()
        })
        return
      }

      if (status >= 400) {
        const chunks: Buffer[] = []
        proxyRes.on('data', (chunk) => {
          chunks.push(chunk)
          res.write(chunk)
        })
        proxyRes.on('end', () => {
          res.end()
          if (status >= 500) {
            const raw = Buffer.concat(chunks)
            const bodyText = decompressBody(raw, responseHeaders)
            setRestricted(`Upstream error (HTTP ${status}): ${bodyText}`)
            log('error', `Upstream ${status} response:\n${bodyText}`)
          }
        })
        return
      }

      // Stream successful response (SSE for Claude responses)
      // Intercept data chunks to detect error events in the SSE stream
      const contentType = String(responseHeaders['content-type'] || '')
      const isSSE = contentType.includes('text/event-stream')

      if (isSSE) {
        let buffer = ''
        const originalWrite = res.write.bind(res)

        proxyRes.on('data', (chunk: Buffer) => {
          originalWrite(chunk)

          // Scan SSE chunks for error events
          buffer += chunk.toString('utf-8')
          // Keep buffer manageable — only need recent data
          if (buffer.length > 8192) {
            buffer = buffer.slice(-4096)
          }

          // Detect error patterns in SSE stream — pass full buffer for logging
          checkSSEForRestriction(buffer, clientName, method, path)
        })

        proxyRes.on('end', () => {
          res.end()
        })

        proxyRes.on('error', (err) => {
          log('error', `SSE stream error: ${err.message}`)
          setRestricted(`Upstream stream error: ${err.message}`)
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Upstream stream error' }))
          }
        })
      } else {
        proxyRes.pipe(res)
      }

      if (config.logging.audit) {
        audit(clientName, method, path, status)
      }
    },
  )

  proxyReq.on('error', (err) => {
    log('error', `Upstream error: ${err.message}`)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Bad gateway', detail: err.message }))
    }
    if (config.logging.audit) {
      audit(clientName, method, path, 502)
    }
  })

  proxyReq.write(body)
  proxyReq.end()
}

// ── Error detection helpers ──

/**
 * Check SSE stream data for error events that indicate rate limiting or throttling.
 * Anthropic sends SSE events like:
 *   event: error
 *   data: {"type":"error","error":{"type":"rate_limit_error",...}}
 */
function checkSSEForRestriction(buffer: string, clientName: string, method: string, path: string) {
  if (restricted) return

  // Look for error events in SSE
  const errorPatterns = [
    // Rate limit error
    { pattern: /"type"\s*:\s*"rate_limit_error"/, reason: 'Anthropic rate_limit_error in SSE stream' },
    // Overloaded / throttled
    { pattern: /"type"\s*:\s*"overloaded_error"/, reason: 'Anthropic overloaded_error in SSE stream' },
    // General error event line
    { pattern: /event:\s*error/, reason: 'Anthropic error event in SSE stream' },
  ]

  for (const { pattern, reason } of errorPatterns) {
    if (pattern.test(buffer)) {
      // Extract the full error event from buffer for diagnostics
      const errorEvent = extractErrorEvent(buffer)
      log('error', `SSE error detected from ${clientName} ${method} ${path}:`)
      log('error', `  Pattern matched: ${reason}`)
      log('error', `  Full SSE event:\n${errorEvent}`)
      setRestricted(reason)
      return
    }
  }
}

/**
 * Extract the most recent complete SSE event from buffer,
 * focusing on the error event and its data payload.
 */
function extractErrorEvent(buffer: string): string {
  // Find the last "event:" block — SSE events start with "event:" line
  const eventBlocks = buffer.split(/\n(?=event:)/)
  const lastBlock = eventBlocks[eventBlocks.length - 1]

  // Also try to extract and pretty-print the JSON data if present
  const dataMatch = lastBlock.match(/data:\s*(\{[\s\S]*?\})\s*\n/)
  if (dataMatch) {
    try {
      const parsed = JSON.parse(dataMatch[1])
      return lastBlock.trim() + '\n\nParsed data:\n' + JSON.stringify(parsed, null, 2)
    } catch {
      // JSON parse failed, return raw
    }
  }

  return lastBlock.trim()
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen) + '...'
}

/**
 * Build a sample payload showing what the rewriter produces.
 * Used by /_verify endpoint for admin validation.
 */
function buildVerificationPayload(config: Config) {
  // Simulate a /v1/messages request body
  const sampleInput = {
    metadata: {
      user_id: JSON.stringify({
        device_id: 'REAL_DEVICE_ID_FROM_CLIENT_abc123',
        account_uuid: 'shared-account-uuid',
        session_id: 'session-xxx',
      }),
    },
    system: [
      {
        type: 'text',
        text: `x-anthropic-billing-header: cc_version=2.1.81.a1b; cc_entrypoint=cli;`,
      },
      {
        type: 'text',
        text: `Here is useful information about the environment:\n<env>\nWorking directory: /home/bob/myproject\nPlatform: linux\nShell: bash\nOS Version: Linux 6.5.0-generic\n</env>`,
      },
    ],
    messages: [{ role: 'user', content: 'hello' }],
  }

  const rewritten = JSON.parse(
    rewriteBody(Buffer.from(JSON.stringify(sampleInput)), '/v1/messages', config).toString('utf-8'),
  )

  return {
    _info: 'This shows how the gateway rewrites a sample request',
    before: {
      'metadata.user_id': JSON.parse(sampleInput.metadata.user_id),
      billing_header: sampleInput.system[0].text,
      system_prompt_env: sampleInput.system[1].text,
      system_block_count: sampleInput.system.length,
    },
    after: {
      'metadata.user_id': JSON.parse(rewritten.metadata.user_id),
      billing_header: '(stripped)',
      system_prompt_env: rewritten.system[0]?.text ?? '(empty)',
      system_block_count: rewritten.system.length,
    },
  }
}

function decompressBody(raw: Buffer, headers: Record<string, unknown>): string {
  const encoding = String(headers['content-encoding'] || '').toLowerCase()
  if (encoding.includes('gzip')) {
    try {
      return gunzipSync(raw).toString('utf-8')
    } catch {
      return `[gzip decompression failed, ${raw.length} bytes]`
    }
  }
  return raw.toString('utf-8')
}
