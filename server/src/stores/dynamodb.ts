// Amazon DynamoDB store (one table), with your own AWS SDK v3 document client:
//
//   import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
//   import * as lib from '@aws-sdk/lib-dynamodb'
//   const store = dynamoStore({ client: lib.DynamoDBDocumentClient.from(new DynamoDBClient({})), commands: lib, table: 'analytics' })
//   await createDynamoTable({ client: new DynamoDBClient({}), commands: await import('@aws-sdk/client-dynamodb'), table: 'analytics' })
//
// - Items are keyed by `pk` ("E#site#event", "C#record", "I#<hash>") with a `kind`.
// - Inserts are conditional puts: idempotent per event and consent record.
// - Each record's document is stored as a JSON string (no DynamoDB type quirks); the fields
//   used to filter are attributes.
// - `expiresAt` (epoch seconds, from retainUntil) lets DynamoDB's TTL delete expired events
//   and consent records. purge() also removes expired fields.
// - purge, exportSubject, eraseSubject and the readers SCAN the table: schedule them off-peak;
//   for large tables, add indexes and your own tooling.
import { createHash } from 'node:crypto'

import type { Identity } from '../identity/index.ts'
import { due, identityMatches, profileCutoffs, siteMatches } from '../storage/subject.ts'
import type {
  CollectorReader,
  CollectorStore,
  ListOptions,
  PurgeOptions,
  StoredConsent,
  StoredEvent,
  StoredIdentity,
  SubjectSelector,
} from '../storage/types.ts'
import { assertSubjectSelector } from '../storage/types.ts'

type Command = new (input: any) => unknown

export interface DynamoDocumentCommands {
  PutCommand: Command
  GetCommand: Command
  DeleteCommand: Command
  UpdateCommand: Command
  ScanCommand: Command
}

export interface DynamoClientLike {
  send(command: any): Promise<any>
}

export interface DynamoStoreOptions {
  /** A DynamoDBDocumentClient (from @aws-sdk/lib-dynamodb). */
  client: DynamoClientLike
  /** The @aws-sdk/lib-dynamodb module (its command classes are used). */
  commands: DynamoDocumentCommands
  table: string
  /** Parallel writes per batch. Default 10. */
  concurrency?: number
}

const epoch = (iso: string | undefined) => (iso ? Math.floor(Date.parse(iso) / 1000) : undefined)
const identityKey = (siteKey: string, identity: Identity) =>
  createHash('sha256')
    .update(
      `${siteKey}:${JSON.stringify(Object.entries(identity).sort(([a], [b]) => (a < b ? -1 : 1)))}`,
    )
    .digest('hex')
const isConditionFailure = (error: unknown) =>
  (error as { name?: string })?.name === 'ConditionalCheckFailedException'

async function eachLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

export interface DynamoStore extends CollectorStore, CollectorReader {
  upsertIdentity(record: StoredIdentity): Promise<void>
  purge(options: PurgeOptions): ReturnType<NonNullable<CollectorStore['purge']>>
  exportSubject(selector: SubjectSelector): ReturnType<NonNullable<CollectorStore['exportSubject']>>
  eraseSubject(selector: SubjectSelector): ReturnType<NonNullable<CollectorStore['eraseSubject']>>
  listIdentities(options?: ListOptions): Promise<StoredIdentity[]>
}

export function dynamoStore(options: DynamoStoreOptions): DynamoStore {
  const { client, commands, table } = options
  for (const name of [
    'PutCommand',
    'GetCommand',
    'DeleteCommand',
    'UpdateCommand',
    'ScanCommand',
  ] as const) {
    if (typeof commands?.[name] !== 'function')
      throw new Error(
        `dynamoStore: commands.${name} is missing (pass the @aws-sdk/lib-dynamodb module)`,
      )
  }
  const concurrency = options.concurrency ?? 10
  let counter = 0
  const order = () => Date.now() * 1000 + (counter++ % 1000)

  const put = (item: Record<string, unknown>, condition = true) =>
    client.send(
      new commands.PutCommand({
        TableName: table,
        Item: item,
        ...(condition ? { ConditionExpression: 'attribute_not_exists(pk)' } : {}),
      }),
    )
  const remove = (pk: string) =>
    client.send(new commands.DeleteCommand({ TableName: table, Key: { pk } }))

  const scan = async (kind: 'event' | 'consent' | 'identity', siteKey?: string) => {
    const items: any[] = []
    let start: unknown
    do {
      const page = await client.send(
        new commands.ScanCommand({
          TableName: table,
          FilterExpression: siteKey ? '#kind = :kind AND siteKey = :site' : '#kind = :kind',
          ExpressionAttributeNames: { '#kind': 'kind' },
          ExpressionAttributeValues: { ':kind': kind, ...(siteKey ? { ':site': siteKey } : {}) },
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      )
      items.push(...(page.Items ?? []))
      start = page.LastEvaluatedKey
    } while (start)
    return items.sort((a, b) => a.seq - b.seq)
  }

  const eventItem = (event: StoredEvent, seq: number) => ({
    pk: `E#${event.siteKey}#${event.eventId}`,
    kind: 'event',
    siteKey: event.siteKey,
    seq,
    doc: JSON.stringify(event),
    ...(event.retainUntil ? { expiresAt: epoch(event.retainUntil) } : {}),
  })
  const consentItem = (record: StoredConsent, seq: number) => ({
    pk: `C#${record.recordId}`,
    kind: 'consent',
    siteKey: record.siteKey,
    seq,
    doc: JSON.stringify(record),
    ...(record.retainUntil ? { expiresAt: epoch(record.retainUntil) } : {}),
  })
  const identityRecord = (item: any): StoredIdentity & { firstSeenAt: string } => ({
    siteKey: item.siteKey,
    identity: item.identity,
    traits: Object.fromEntries(
      Object.entries(item)
        .filter(([key]) => key.startsWith('trait_'))
        .map(([key, value]) => [key.slice(6), value as string | number | boolean]),
    ),
    seenAt: item.seenAt,
    firstSeenAt: item.firstSeenAt,
  })

  const subjectEvents = async (selector: SubjectSelector) =>
    (await scan('event', selector.siteKey))
      .map(item => JSON.parse(item.doc) as StoredEvent)
      .filter(
        event =>
          siteMatches(event.siteKey, selector) &&
          (identityMatches(event.identity, selector.identity) ||
            (!!selector.sessionId && event.sessionId === selector.sessionId)),
      )
  const subjectConsents = async (selector: SubjectSelector) =>
    (await scan('consent', selector.siteKey))
      .map(item => ({ item, record: JSON.parse(item.doc) as StoredConsent }))
      .filter(
        ({ record }) =>
          siteMatches(record.siteKey, selector) &&
          (identityMatches(record.identity, selector.identity) ||
            (!!selector.consentId && record.consentId === selector.consentId)),
      )
  const subjectIdentities = async (selector: SubjectSelector) =>
    selector.identity && Object.keys(selector.identity).length
      ? (await scan('identity', selector.siteKey)).filter(item =>
          identityMatches(item.identity, selector.identity),
        )
      : []

  return {
    async insertEvents(events) {
      const outcomes = await eachLimited(events, concurrency, async event => {
        try {
          await put(eventItem(event, order()))
          return true
        } catch (error) {
          if (isConditionFailure(error)) return false
          throw error
        }
      })
      const inserted = outcomes.filter(Boolean).length
      return { inserted, duplicates: events.length - inserted }
    },

    async insertConsent(record) {
      try {
        await put(consentItem(record, order()))
        return { duplicate: false, recordedAt: record.recordedAt }
      } catch (error) {
        if (!isConditionFailure(error)) throw error
        const { Item } = await client.send(
          new commands.GetCommand({ TableName: table, Key: { pk: `C#${record.recordId}` } }),
        )
        return {
          duplicate: true,
          recordedAt: Item ? (JSON.parse(Item.doc) as StoredConsent).recordedAt : record.recordedAt,
        }
      }
    },

    async upsertIdentity(record) {
      const names: Record<string, string> = { '#kind': 'kind', '#identity': 'identity' }
      const values: Record<string, unknown> = {
        ':kind': 'identity',
        ':site': record.siteKey,
        ':identity': record.identity,
        ':seen': record.seenAt,
        ':seq': order(),
      }
      const sets = [
        '#kind = :kind',
        'siteKey = :site',
        '#identity = :identity',
        'seenAt = :seen',
        'firstSeenAt = if_not_exists(firstSeenAt, :seen)',
        'seq = if_not_exists(seq, :seq)',
      ]
      Object.entries(record.traits).forEach(([name, value], index) => {
        names[`#t${index}`] = `trait_${name}`
        values[`:t${index}`] = value
        sets.push(`#t${index} = :t${index}`)
      })
      await client.send(
        new commands.UpdateCommand({
          TableName: table,
          Key: { pk: `I#${identityKey(record.siteKey, record.identity)}` },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      )
    },

    async purge(options) {
      const cutoffs = profileCutoffs(options)
      const result = {
        eventsDeleted: 0,
        ipsRemoved: 0,
        rawUserAgentsRemoved: 0,
        consentsDeleted: 0,
      }
      for (const item of await scan('event')) {
        const event = JSON.parse(item.doc) as StoredEvent
        const cutoff = cutoffs.get(event.profile)
        if (
          due(event.retainUntil, options.now) ||
          due(event.receivedAt, cutoff?.eventsBefore, false)
        ) {
          await remove(item.pk)
          result.eventsDeleted++
          continue
        }
        let changed = false
        if (
          event.server?.ip &&
          (due(event.ipRetainUntil, options.now) || due(event.receivedAt, cutoff?.ipBefore, false))
        ) {
          delete event.server.ip
          delete event.server.ipForm
          delete event.ipRetainUntil
          result.ipsRemoved++
          changed = true
        }
        if (
          event.server?.userAgent?.raw &&
          (due(event.rawUserAgentRetainUntil, options.now) ||
            due(event.receivedAt, cutoff?.rawUserAgentBefore, false))
        ) {
          delete event.server.userAgent.raw
          delete event.rawUserAgentRetainUntil
          result.rawUserAgentsRemoved++
          changed = true
        }
        if (changed) await put({ ...item, doc: JSON.stringify(event) }, false)
      }
      for (const item of await scan('consent')) {
        const record = JSON.parse(item.doc) as StoredConsent
        if (
          due(record.retainUntil, options.now) ||
          due(record.recordedAt, cutoffs.get(record.profile)?.consentsBefore, false)
        ) {
          await remove(item.pk)
          result.consentsDeleted++
        }
      }
      return result
    },

    async exportSubject(selector) {
      assertSubjectSelector(selector)
      return {
        events: await subjectEvents(selector),
        consents: (await subjectConsents(selector)).map(({ record }) => record),
        identities: (await subjectIdentities(selector)).map(identityRecord),
      }
    },

    async eraseSubject(selector) {
      assertSubjectSelector(selector)
      const events = await subjectEvents(selector)
      await eachLimited(events, concurrency, event => remove(`E#${event.siteKey}#${event.eventId}`))
      let consentsDeidentified = 0
      for (const { item, record } of await subjectConsents(selector)) {
        if (!record.identity) continue
        delete record.identity
        await put({ ...item, doc: JSON.stringify(record) }, false)
        consentsDeidentified++
      }
      const identities = await subjectIdentities(selector)
      await eachLimited(identities, concurrency, item => remove(item.pk))
      return {
        eventsDeleted: events.length,
        consentsDeidentified,
        identitiesDeleted: identities.length,
      }
    },

    async health() {
      await client.send(new commands.GetCommand({ TableName: table, Key: { pk: '__health__' } }))
    },

    async close() {},

    async listEvents({ siteKey, limit = 500 }: ListOptions = {}) {
      return (await scan('event', siteKey))
        .slice(0, limit)
        .map(item => JSON.parse(item.doc) as StoredEvent)
    },
    async listConsents({ siteKey, limit = 500 }: ListOptions = {}) {
      return (await scan('consent', siteKey))
        .slice(0, limit)
        .map(item => JSON.parse(item.doc) as StoredConsent)
    },
    async listIdentities({ siteKey, limit = 500 }: ListOptions = {}) {
      return (await scan('identity', siteKey)).slice(0, limit).map(identityRecord)
    },
  }
}

export interface CreateDynamoTableOptions {
  /** A DynamoDBClient (from @aws-sdk/client-dynamodb). */
  client: DynamoClientLike
  /** The @aws-sdk/client-dynamodb module. */
  commands: { CreateTableCommand: Command; UpdateTimeToLiveCommand: Command }
  table: string
}

/** Create the table (on-demand capacity) with TTL on `expiresAt`. Fails if it exists. */
export async function createDynamoTable({
  client,
  commands,
  table,
}: CreateDynamoTableOptions): Promise<void> {
  await client.send(
    new commands.CreateTableCommand({
      TableName: table,
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  )
  await client.send(
    new commands.UpdateTimeToLiveCommand({
      TableName: table,
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    }),
  )
}
