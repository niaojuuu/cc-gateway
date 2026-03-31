import { loadConfig } from './config.js'
import { setLogLevel, log } from './logger.js'
import { startProxy } from './proxy.js'

const configPath = process.argv[2]

try {
  const config = loadConfig(configPath)
  setLogLevel(config.logging.level)

  log('info', 'CC Gateway starting...')
  startProxy(config)
} catch (err) {
  console.error(`Fatal: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
