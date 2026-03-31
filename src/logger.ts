type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

let currentLevel: LogLevel = 'info'

export function setLogLevel(level: LogLevel) {
  currentLevel = level
}

export function log(level: LogLevel, message: string, extra?: Record<string, unknown>) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return

  const ts = new Date().toISOString()
  const prefix = `[${ts}] [${level.toUpperCase().padEnd(5)}]`

  if (extra) {
    console.log(`${prefix} ${message}`, JSON.stringify(extra))
  } else {
    console.log(`${prefix} ${message}`)
  }
}

export function audit(clientName: string, method: string, path: string, status: number) {
  const ts = new Date().toISOString()
  console.log(`[${ts}] [AUDIT] client=${clientName} ${method} ${path} → ${status}`)
}
