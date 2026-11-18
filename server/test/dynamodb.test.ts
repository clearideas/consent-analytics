// The DynamoDB store against a DynamoDB emulator (moto; see test/support/services.ts).
import { randomUUID } from 'node:crypto'

import * as ddb from '@aws-sdk/client-dynamodb'
import * as lib from '@aws-sdk/lib-dynamodb'
import { describe, expect, inject, it } from 'vitest'

import { createDynamoTable, dynamoStore } from '../src/stores/dynamodb.ts'
import { runStoreConformance, storedEvent } from './support/store-conformance.ts'

const endpoint = inject('awsEndpoint')

describe.skipIf(!endpoint)('DynamoDB', () => {
  const base = new ddb.DynamoDBClient({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  })
  const client = lib.DynamoDBDocumentClient.from(base)

  async function fresh() {
    const table = `ca-${randomUUID()}`
    await createDynamoTable({ client: base, commands: ddb, table })
    return { table, store: dynamoStore({ client, commands: lib, table }) }
  }

  runStoreConformance('dynamoStore', async () => {
    const { table, store } = await fresh()
    return {
      store,
      reader: store,
      cleanup: async () => void (await base.send(new ddb.DeleteTableCommand({ TableName: table }))),
    }
  })

  it('TTL is enabled on expiresAt, set from retainUntil', async () => {
    const { table, store } = await fresh()
    const ttl = await base.send(new ddb.DescribeTimeToLiveCommand({ TableName: table }))
    expect(ttl.TimeToLiveDescription).toMatchObject({
      AttributeName: 'expiresAt',
      TimeToLiveStatus: 'ENABLED',
    })
    await store.insertEvents([storedEvent({ retainUntil: '2030-01-01T00:00:00.000Z' })])
    const { Item } = await client.send(
      new lib.GetCommand({ TableName: table, Key: { pk: 'E#site-a#event-00000001' } }),
    )
    expect(Item!.expiresAt).toBe(Date.parse('2030-01-01T00:00:00.000Z') / 1000)
  })

  it('keeps awkward props intact (empty keys, big numbers, nested arrays)', async () => {
    const { store } = await fresh()
    const props = {
      '': 'empty key',
      big: 12345678901234567890,
      nested: [[1, { a: null }], true],
      'a.b': 'dot',
    }
    await store.insertEvents([storedEvent({ props })])
    expect((await store.listEvents())[0]!.props).toEqual(props)
  })

  it('requires the command classes', () => {
    expect(() => dynamoStore({ client, commands: {} as any, table: 't' })).toThrow(/PutCommand/)
  })
})
