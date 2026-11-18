// Logging: pass your own logger (pino, winston, console, ...). Only these methods are used,
// pino-style: structured fields first, then the message.

export interface Logger {
  debug(fields: Record<string, unknown>, message: string): void
  info(fields: Record<string, unknown>, message: string): void
  warn(fields: Record<string, unknown>, message: string): void
  error(fields: Record<string, unknown>, message: string): void
}

const LEVELS = ['debug', 'info', 'warn', 'error'] as const
type Level = (typeof LEVELS)[number]

/**
 * One JSON line per entry on stderr, at `level` and above. The default logger uses `warn`,
 * so a library embedded in an application stays quiet unless something is wrong.
 */
export function consoleLogger(level: Level = 'warn'): Logger {
  const min = LEVELS.indexOf(level)
  const write = (at: Level) => (fields: Record<string, unknown>, message: string) => {
    if (LEVELS.indexOf(at) < min) return
    console.error(
      JSON.stringify({ level: at, time: new Date().toISOString(), msg: message, ...fields }),
    )
  }
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') }
}

/** Discards everything. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

/** Describe an error for a log entry without leaking request data. */
export function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { err: { name: error.name, message: error.message, stack: error.stack } }
  }
  return { err: { message: String(error) } }
}
