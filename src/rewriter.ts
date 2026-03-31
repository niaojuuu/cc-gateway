import type { Config } from './config.js'
import { log } from './logger.js'

/**
 * Rewrite identity fields in the API request body.
 *
 * Handles two request types:
 * 1. /v1/messages - rewrite metadata.user_id JSON blob
 * 2. /api/event_logging/batch - rewrite event_data identity/env/process fields
 */
export function rewriteBody(body: Buffer, path: string, config: Config): Buffer {
  const text = body.toString('utf-8')

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Not JSON - pass through unchanged
    return body
  }

  if (path.startsWith('/v1/messages')) {
    rewriteMessagesBody(parsed, config)
  } else if (path.includes('/event_logging/batch')) {
    rewriteEventBatch(parsed, config)
  } else if (path.includes('/policy_limits') || path.includes('/settings')) {
    // These are GET-like requests, usually no body to rewrite
    // But if they do have a body, rewrite identity fields
    rewriteGenericIdentity(parsed, config)
  }

  return Buffer.from(JSON.stringify(parsed), 'utf-8')
}

/**
 * Rewrite /v1/messages request body.
 * Key field: metadata.user_id (JSON-stringified object with device_id, account_uuid, session_id)
 */
function rewriteMessagesBody(body: any, config: Config) {
  if (!body?.metadata?.user_id) return

  try {
    const userId = JSON.parse(body.metadata.user_id)
    userId.device_id = config.identity.device_id
    // Keep session_id and account_uuid as-is (session_id is per-window, account_uuid is same for all)
    body.metadata.user_id = JSON.stringify(userId)
    log('debug', `Rewrote metadata.user_id device_id`)
  } catch {
    log('warn', `Failed to parse metadata.user_id`)
  }

  // Rewrite system prompt billing header if present
  if (Array.isArray(body.system)) {
    rewriteSystemPromptBilling(body.system, config)
  } else if (typeof body.system === 'string') {
    body.system = rewriteBillingInText(body.system, config)
  }
}

/**
 * Rewrite billing header embedded in system prompt array.
 * The billing header is in the format:
 *   x-anthropic-billing-header: cc_version=X.Y.Z.FP; cc_entrypoint=cli;
 */
function rewriteSystemPromptBilling(systemArray: any[], config: Config) {
  for (let i = 0; i < systemArray.length; i++) {
    const item = systemArray[i]
    if (typeof item === 'string') {
      systemArray[i] = rewriteBillingInText(item, config)
    } else if (item?.text) {
      item.text = rewriteBillingInText(item.text, config)
    }
  }
}

function rewriteBillingInText(text: string, config: Config): string {
  // Normalize the cc_version to use canonical version
  // Pattern: cc_version=X.Y.Z.FP where FP is 3 hex chars
  return text.replace(
    /cc_version=[\d.]+\.[a-f0-9]{3}/g,
    `cc_version=${config.env.version}.000`
  )
}

/**
 * Rewrite /api/event_logging/batch payload.
 * Each event has event_data with identity, env, and process fields.
 */
function rewriteEventBatch(body: any, config: Config) {
  if (!Array.isArray(body?.events)) return

  for (const event of body.events) {
    if (!event?.event_data) continue
    const data = event.event_data

    // Identity fields
    if (data.device_id) data.device_id = config.identity.device_id
    if (data.email) data.email = config.identity.email

    // Environment fingerprint - replace entirely with canonical
    if (data.env) {
      data.env = buildCanonicalEnv(config)
    }

    // Process metrics - generate realistic values
    if (data.process) {
      data.process = buildCanonicalProcess(data.process, config)
    }

    // Additional metadata - rewrite base64-encoded blob if present
    if (data.additional_metadata) {
      data.additional_metadata = rewriteAdditionalMetadata(data.additional_metadata, config)
    }

    log('debug', `Rewrote event: ${data.event_name || 'unknown'}`)
  }
}

function rewriteGenericIdentity(body: any, config: Config) {
  if (typeof body !== 'object' || body === null) return
  if (body.device_id) body.device_id = config.identity.device_id
  if (body.email) body.email = config.identity.email
}

/**
 * Build canonical env object from config.
 * Merges config env values into the expected structure.
 */
function buildCanonicalEnv(config: Config): Record<string, unknown> {
  return {
    platform: config.env.platform,
    platform_raw: config.env.platform_raw || config.env.platform,
    arch: config.env.arch,
    node_version: config.env.node_version,
    terminal: config.env.terminal,
    package_managers: config.env.package_managers,
    runtimes: config.env.runtimes,
    is_running_with_bun: config.env.is_running_with_bun ?? false,
    is_ci: false,
    is_claubbit: false,
    is_claude_code_remote: false,
    is_local_agent_mode: false,
    is_conductor: false,
    is_github_action: false,
    is_claude_code_action: false,
    is_claude_ai_auth: config.env.is_claude_ai_auth ?? true,
    version: config.env.version,
    version_base: config.env.version_base || config.env.version,
    build_time: config.env.build_time,
    deployment_environment: config.env.deployment_environment,
    vcs: config.env.vcs,
  }
}

/**
 * Generate realistic process metrics.
 * Keeps uptime from the real event but normalizes hardware-identifying fields.
 */
function buildCanonicalProcess(original: any, config: Config): any {
  // If it's a base64 string, decode → rewrite → re-encode
  if (typeof original === 'string') {
    try {
      const decoded = JSON.parse(Buffer.from(original, 'base64').toString('utf-8'))
      const rewritten = rewriteProcessFields(decoded, config)
      return Buffer.from(JSON.stringify(rewritten)).toString('base64')
    } catch {
      return original
    }
  }

  // If it's already an object
  if (typeof original === 'object') {
    return rewriteProcessFields(original, config)
  }

  return original
}

function rewriteProcessFields(proc: any, config: Config): any {
  const { constrained_memory, rss_range, heap_total_range, heap_used_range } = config.process
  return {
    ...proc,
    constrainedMemory: constrained_memory,
    rss: randomInRange(rss_range[0], rss_range[1]),
    heapTotal: randomInRange(heap_total_range[0], heap_total_range[1]),
    heapUsed: randomInRange(heap_used_range[0], heap_used_range[1]),
    // Keep uptime and cpuUsage as-is (these vary naturally)
  }
}

function rewriteAdditionalMetadata(original: string, config: Config): string {
  try {
    const decoded = JSON.parse(Buffer.from(original, 'base64').toString('utf-8'))
    // rh (repo hash) is fine to keep - users work on different repos naturally
    // Strip any fields that might leak real machine identity
    return Buffer.from(JSON.stringify(decoded)).toString('base64')
  } catch {
    return original
  }
}

function randomInRange(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min))
}

/**
 * Rewrite HTTP headers to canonical identity.
 */
export function rewriteHeaders(
  headers: Record<string, string | string[] | undefined>,
  config: Config,
): Record<string, string> {
  const out: Record<string, string> = {}

  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue
    const v = Array.isArray(value) ? value.join(', ') : value
    const lower = key.toLowerCase()

    // Skip hop-by-hop headers
    if (['host', 'connection', 'proxy-authorization', 'proxy-connection', 'transfer-encoding'].includes(lower)) {
      continue
    }

    if (lower === 'user-agent') {
      // Normalize to canonical version
      out[key] = `claude-code/${config.env.version} (external, cli)`
    } else if (lower === 'x-anthropic-billing-header') {
      // Rewrite billing header
      out[key] = v.replace(/cc_version=[\d.]+\.[a-f0-9]{3}/g, `cc_version=${config.env.version}.000`)
    } else {
      out[key] = v
    }
  }

  return out
}
