#!/usr/bin/env node
// consent-analytics-collector: start from environment variables (see README.md).
//   consent-analytics-collector               start
//   consent-analytics-collector --check       validate the configuration and exit
import { ConfigError, loadConfig, startCollector } from './main.ts'

let config
try {
  config = loadConfig()
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error)
  process.exit(1)
}
if (process.argv.includes('--check')) {
  console.log(
    `Configuration is valid: MODE=${config.mode} STORE=${config.store} QUEUE=${config.queue}`,
  )
  process.exit(0)
}

try {
  const running = await startCollector(config)
  let signals = 0
  const stop = () => {
    if (++signals > 1) process.exit(1) // a second signal: stop now
    running.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
} catch (error) {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'collector failed to start',
      err: { message: (error as Error).message },
    }),
  )
  process.exit(1)
}
