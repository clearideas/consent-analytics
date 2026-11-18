// Retention: remove data whose time is up. Records carry their own expiry dates (from the
// data policy profile at the time they were stored). With the current data policy, shortened
// limits are applied to records already stored as well.
//
//   const retention = startRetention({ store, dataPolicy, lock })   // in a worker process
//   process.on('SIGTERM', () => retention.stop())
//
// With several workers, pass a `lock` (e.g. Redis) so one purge runs at a time.
import type { Logger } from '../core/logger.ts'
import { consoleLogger, errorFields } from '../core/logger.ts'
import type { Duration } from '../policy/duration.ts'
import type { DataPolicy, DataPolicyDocument } from '../policy/index.ts'
import { addDuration, compileDataPolicy } from '../policy/index.ts'
import type { CollectorStore, PurgeOptions, PurgeResult } from '../storage/types.ts'

/** A distributed lock: resolve with a release function, or null if someone else holds it. */
export interface Lock {
  acquire(name: string, ttlMs: number): Promise<(() => Promise<void>) | null>
}

const before = (now: Date, duration: Duration | undefined) =>
  duration ? addDuration(now, { amount: -duration.amount, unit: duration.unit }) : undefined

/** Per-profile cutoffs from a data policy's retention settings. */
type ProfileCutoff = NonNullable<PurgeOptions['profiles']>[number]

export function retentionCutoffs(policy: DataPolicy, now: Date): ProfileCutoff[] {
  const cutoffs: ProfileCutoff[] = []
  for (const profile of policy.profiles.values()) {
    const { events, ip, rawUserAgent, consents } = profile.retention
    if (!events && !ip && !rawUserAgent && !consents) continue
    cutoffs.push({
      profile: profile.name,
      ...(events ? { eventsBefore: before(now, events) } : {}),
      ...(ip ? { ipBefore: before(now, ip) } : {}),
      ...(rawUserAgent ? { rawUserAgentBefore: before(now, rawUserAgent) } : {}),
      ...(consents ? { consentsBefore: before(now, consents) } : {}),
    })
  }
  return cutoffs
}

export interface PurgeExpiredOptions {
  store: CollectorStore
  /** Apply the current policy's limits to stored records too. Default: only records' own dates. */
  dataPolicy?: DataPolicy | DataPolicyDocument
  now?: Date
}

const compiled = (policy: DataPolicy | DataPolicyDocument | undefined) =>
  policy === undefined ? undefined : 'select' in policy ? policy : compileDataPolicy(policy)

/** Run one purge. */
export async function purgeExpired(options: PurgeExpiredOptions): Promise<PurgeResult> {
  const { store } = options
  if (!store.purge) throw new Error('This store does not support purging (store.purge)')
  const now = options.now ?? new Date()
  const policy = compiled(options.dataPolicy)
  return store.purge({ now, ...(policy ? { profiles: retentionCutoffs(policy, now) } : {}) })
}

export interface RetentionOptions extends Omit<PurgeExpiredOptions, 'now'> {
  /** How often to purge. Default 1 hour. */
  everyMs?: number
  /** Purge once right away. Default true. */
  runAtStart?: boolean
  lock?: Lock
  logger?: Logger | false
  onResult?(result: PurgeResult): void
  clock?: () => Date
}

export interface Retention {
  /** Purge now (if the lock is free); null if another process holds the lock. */
  runNow(): Promise<PurgeResult | null>
  stop(): Promise<void>
}

export function startRetention(options: RetentionOptions): Retention {
  if (!options.store.purge) throw new Error('This store does not support purging (store.purge)')
  const everyMs = options.everyMs ?? 3_600_000
  const logger = options.logger === false ? undefined : (options.logger ?? consoleLogger())
  const clock = options.clock ?? (() => new Date())
  const policy = compiled(options.dataPolicy) // validate once, at start
  let running: Promise<PurgeResult | null> | undefined
  let stopped = false

  const runNow = (): Promise<PurgeResult | null> => {
    running ??= (async () => {
      const release = options.lock
        ? await options.lock.acquire('consent-analytics:retention', everyMs)
        : undefined
      if (release === null) return null
      try {
        const result = await purgeExpired({
          store: options.store,
          ...(policy ? { dataPolicy: policy } : {}),
          now: clock(),
        })
        logger?.info({ ...result }, 'retention purge done')
        options.onResult?.(result)
        return result
      } catch (error) {
        logger?.error({ ...errorFields(error) }, 'retention purge failed')
        return null
      } finally {
        await release?.()
      }
    })().finally(() => {
      running = undefined
    })
    return running
  }

  const timer = setInterval(() => {
    if (!stopped) void runNow()
  }, everyMs)
  timer.unref?.()
  if (options.runAtStart !== false) void runNow()

  return {
    runNow,
    async stop() {
      stopped = true
      clearInterval(timer)
      await running
    },
  }
}
