// The SQS queue against an SQS emulator (moto; see test/support/services.ts).
import { randomUUID } from 'node:crypto'

import * as sqs from '@aws-sdk/client-sqs'
import { describe, expect, inject, it, vi } from 'vitest'

import { encodeMessage, memoryStore, runWorker } from '../src/index.ts'
import { sqsQueue } from '../src/queues/sqs.ts'
import { runQueueConformance } from './support/queue-conformance.ts'
import { storedEvent } from './support/store-conformance.ts'

const endpoint = inject('awsEndpoint')

describe.skipIf(!endpoint)('SQS', () => {
  const client = new sqs.SQSClient({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  })

  async function createQueues(visibilitySeconds: number) {
    const name = `ca-${randomUUID()}`
    const { QueueUrl: queueUrl } = await client.send(
      new sqs.CreateQueueCommand({
        QueueName: name,
        Attributes: { VisibilityTimeout: String(visibilitySeconds) },
      }),
    )
    const { QueueUrl: deadLetterQueueUrl } = await client.send(
      new sqs.CreateQueueCommand({ QueueName: `${name}-dlq` }),
    )
    return { queueUrl: queueUrl!, deadLetterQueueUrl: deadLetterQueueUrl! }
  }

  runQueueConformance('sqsQueue', async () => {
    const { queueUrl, deadLetterQueueUrl } = await createQueues(1)
    return {
      queue: sqsQueue({ client, commands: sqs, queueUrl, deadLetterQueueUrl }),
      visibilityTimeoutMs: 1_000,
      staleReceiptsIgnored: false,
      async deadLetters() {
        const { Messages = [] } = await client.send(
          new sqs.ReceiveMessageCommand({
            QueueUrl: deadLetterQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
          }),
        )
        return Messages.map(m => m.Body!)
      },
      cleanup: async () => {
        await client.send(new sqs.DeleteQueueCommand({ QueueUrl: queueUrl }))
        await client.send(new sqs.DeleteQueueCommand({ QueueUrl: deadLetterQueueUrl }))
      },
    }
  })

  it('splits sends into batches of at most 10 messages and 256 KiB', async () => {
    const { queueUrl } = await createQueues(30)
    const sent: number[] = []
    const counting = {
      send: (command: any, options?: any) => {
        if (command instanceof sqs.SendMessageBatchCommand)
          sent.push((command.input as any).Entries.length)
        return client.send(command, options)
      },
    }
    const queue = sqsQueue({ client: counting, commands: sqs, queueUrl })
    await queue.send([
      ...Array.from({ length: 12 }, (_, i) => `small-${i}`),
      ...Array.from({ length: 3 }, () => 'x'.repeat(100_000)),
    ])
    expect(sent).toEqual([10, 4, 1]) // 2 small + 2 large = 200 KB, then the third large one
  })

  it('a worker writes from SQS to the store; a poison message goes to the dead-letter queue', async () => {
    const { queueUrl, deadLetterQueueUrl } = await createQueues(30)
    const queue = sqsQueue({ client, commands: sqs, queueUrl, deadLetterQueueUrl })
    await queue.send([
      encodeMessage({
        kind: 'events',
        v: 1,
        requestId: 'r',
        siteKey: 'site-a',
        events: [storedEvent()],
      }),
      'not a message',
    ])
    const store = memoryStore()
    const dead = vi.fn()
    const worker = runWorker({
      queue,
      store,
      waitMs: 1_000,
      logger: false,
      hooks: { onDeadLetter: dead },
    })
    await vi.waitFor(async () => expect(await store.listEvents()).toHaveLength(1), {
      timeout: 15_000,
    })
    await vi.waitFor(() => expect(dead).toHaveBeenCalledOnce(), { timeout: 15_000 })
    await worker.stop()
    const { Messages = [] } = await client.send(
      new sqs.ReceiveMessageCommand({
        QueueUrl: deadLetterQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['All'],
      }),
    )
    expect(Messages.map(m => [m.Body, m.MessageAttributes?.reason?.StringValue])).toEqual([
      ['not a message', 'undeliverable: not JSON'],
    ])
  })

  it('without a dead-letter queue URL, a dead letter is left to the redrive policy', async () => {
    const { queueUrl } = await createQueues(30)
    const queue = sqsQueue({ client, commands: sqs, queueUrl })
    await queue.send(['poison'])
    const [message] = await queue.receive({ max: 1, waitMs: 2_000 })
    await queue.deadLetter(message!, 'bad')
    const [again] = await queue.receive({ max: 1, waitMs: 2_000 })
    expect(again).toMatchObject({ body: 'poison', attempts: 2 })
  })

  it('requires the command classes', () => {
    expect(() => sqsQueue({ client, commands: {} as any, queueUrl: 'q' })).toThrow(
      /SendMessageBatchCommand/,
    )
  })
})
