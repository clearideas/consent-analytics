// @clearideas/consent-analytics-server
// Collector for the @clearideas/consent-analytics browser library (spec/openapi.yaml v1).
// Zero runtime dependencies: adapters work with the clients you already use.
//
// Transports are separate entry points: `/node` (node:http, Connect-style middleware),
// `/fetch` (Fetch API platforms).
export type { Cache } from './cache/index.ts'
export { memoryCache } from './cache/index.ts'
export type { Collector, CollectorHooks, CollectorOptions } from './core/collector.ts'
export { createCollector } from './core/collector.ts'
export type { CollectorRequest, CollectorResponse, HeaderReader } from './core/http.ts'
export { BodyTooLargeError, collectBody, headerReader } from './core/http.ts'
export type { Logger } from './core/logger.ts'
export { consoleLogger, silentLogger } from './core/logger.ts'
export { consentRecordId } from './core/record-id.ts'
export type { BackgroundWriter, BackgroundWriterOptions, BufferStats } from './delivery/buffer.ts'
export { backgroundWriter } from './delivery/buffer.ts'
export type { IngestMessage } from './delivery/messages.ts'
export {
  decodeMessage,
  encodeMessage,
  MESSAGE_VERSION,
  MessageFormatError,
} from './delivery/messages.ts'
export type { IngestProcessor, IngestProcessorOptions, WriteOutcome } from './delivery/processor.ts'
export { createIngestProcessor } from './delivery/processor.ts'
export type {
  IngestQueue,
  MemoryQueue,
  MemoryQueueOptions,
  QueueProducer,
  ReceivedMessage,
  ReceiveOptions,
} from './delivery/queue.ts'
export { memoryQueue } from './delivery/queue.ts'
export type {
  BufferOptions,
  DeliveryOptions,
  DeliveryResult,
  DeliveryStats,
} from './delivery/sinks.ts'
export { DeliveryRejectedError } from './delivery/sinks.ts'
export type { Worker, WorkerOptions, WorkerStats } from './delivery/worker.ts'
export { runWorker } from './delivery/worker.ts'
export type {
  ClientHints,
  DeviceType,
  ParsedUserAgent,
  RequestFacts,
  ServerInfo,
} from './enrich/index.ts'
export {
  collectServerInfo,
  ipHasher,
  parseUserAgent,
  primaryLanguage,
  requestFacts,
  truncateIp,
} from './enrich/index.ts'
export type { Geo, GeoRequest, GeoResolver } from './geo/index.ts'
export { chainGeo, fixedGeo, normalizeGeo, trustedHeaderGeo } from './geo/index.ts'
export type {
  Identity,
  IdentityOptions,
  IdentityValue,
  ResolvedIdentity,
} from './identity/index.ts'
export { identityConfig, sanitizeIdentity } from './identity/index.ts'
export type { EventProjection } from './normalize/index.ts'
export { normalizeEvent } from './normalize/index.ts'
export type {
  DataPolicy,
  DataPolicyDocument,
  Duration,
  FullCollection,
  GeoLevel,
  IpLevel,
  LimitedCollection,
  NetworkLevel,
  Policy,
  PresetOptions,
  Profile,
  UserAgentLevel,
} from './policy/index.ts'
export {
  addDuration,
  balancedDataPolicy,
  compileDataPolicy,
  contextPolicy,
  DataPolicyError,
  EEA_COUNTRIES,
  EU_COUNTRIES,
  parseDuration,
  strictDataPolicy,
  US_PRIVACY_STATES,
} from './policy/index.ts'
export * from './protocol/index.ts'
export type {
  MemoryRateLimiterOptions,
  RateLimiter,
  RateLimitResult,
  RateLimitRule,
} from './ratelimit/index.ts'
export { memoryRateLimiter } from './ratelimit/index.ts'
export type { Lock, PurgeExpiredOptions, Retention, RetentionOptions } from './retention/index.ts'
export { purgeExpired, retentionCutoffs, startRetention } from './retention/index.ts'
export type {
  CustomRule,
  RuleContext,
  RuleOutcome,
  RuleResult,
  RulesOptions,
  RulesPreset,
} from './rules/index.ts'
export { annotateConsent, createRules, originAndPath } from './rules/index.ts'
export type {
  CachedSites,
  CachedSitesOptions,
  ConsentMode,
  Site,
  SiteInput,
  SiteSource,
  TrackingWithoutConsent,
} from './sites/index.ts'
export { cachedSites, chainSites, defineSite, SiteConfigError, staticSites } from './sites/index.ts'
export type { MemoryStore } from './storage/memory.ts'
export { memoryStore } from './storage/memory.ts'
export { due, identityMatches, profileCutoffs, siteMatches } from './storage/subject.ts'
export type {
  CollectorReader,
  CollectorStore,
  EraseResult,
  InsertConsentResult,
  InsertEventsResult,
  ListOptions,
  PurgeOptions,
  PurgeResult,
  StoredConsent,
  StoredEvent,
  StoredIdentity,
  SubjectData,
  SubjectSelector,
} from './storage/types.ts'
export { assertSubjectSelector } from './storage/types.ts'
