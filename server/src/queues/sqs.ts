// Amazon SQS as an IngestQueue, with your own AWS SDK v3 client:
//
//   import * as sqs from '@aws-sdk/client-sqs'
//   const queue = sqsQueue({ client: new sqs.SQSClient({}), commands: sqs, queueUrl, deadLetterQueueUrl })
//
// Nothing is imported from the SDK: pass the module (its command classes are used).
// - send: SendMessageBatch, split by 10 messages and by 256 KiB per batch.
// - receive: long polling (WaitTimeSeconds up to 20); attempts = ApproximateReceiveCount.
// - retry: ChangeMessageVisibility (the delay, in whole seconds, up to 12 hours).
// - deadLetter: to `deadLetterQueueUrl` (with the reason as a message attribute), then deleted.
//   Without one, the message becomes visible again and your queue's redrive policy moves it
//   after maxReceiveCount: set that at or above the worker's maxAttempts.
// Standard queues deliver at least once; the stores de-duplicate, so that is safe.
import type { IngestQueue, ReceivedMessage } from '../delivery/queue.ts'

type Command = new (input: any) => unknown

export interface SqsCommands {
  SendMessageBatchCommand: Command
  ReceiveMessageCommand: Command
  DeleteMessageBatchCommand: Command
  ChangeMessageVisibilityCommand: Command
  SendMessageCommand: Command
}

export interface SqsClientLike {
  send(command: any, options?: { abortSignal?: AbortSignal }): Promise<any>
}

export interface SqsQueueOptions {
  client: SqsClientLike
  commands: SqsCommands
  queueUrl: string
  deadLetterQueueUrl?: string
}

const MAX_BATCH_BYTES = 256 * 1024
const MAX_VISIBILITY_SECONDS = 12 * 60 * 60

/** Split into batches of at most 10 entries and 256 KiB. */
function batches(bodies: readonly string[]): string[][] {
  const result: string[][] = []
  let current: string[] = []
  let size = 0
  for (const body of bodies) {
    const bytes = Buffer.byteLength(body)
    if (current.length && (current.length === 10 || size + bytes > MAX_BATCH_BYTES)) {
      result.push(current)
      current = []
      size = 0
    }
    current.push(body)
    size += bytes
  }
  if (current.length) result.push(current)
  return result
}

const failures = (response: {
  Failed?: Array<{ Id?: string; Code?: string; Message?: string }>
}) =>
  response?.Failed?.length
    ? new Error(
        `SQS: ${response.Failed.length} failed (${response.Failed[0]!.Code}: ${response.Failed[0]!.Message})`,
      )
    : undefined

export function sqsQueue(options: SqsQueueOptions): IngestQueue {
  const { client, commands, queueUrl } = options
  for (const name of [
    'SendMessageBatchCommand',
    'ReceiveMessageCommand',
    'DeleteMessageBatchCommand',
    'ChangeMessageVisibilityCommand',
    'SendMessageCommand',
  ] as const) {
    if (typeof commands?.[name] !== 'function')
      throw new Error(`sqsQueue: commands.${name} is missing (pass the @aws-sdk/client-sqs module)`)
  }

  const remove = async (handles: string[]) => {
    for (let i = 0; i < handles.length; i += 10) {
      const chunk = handles.slice(i, i + 10)
      const response = await client.send(
        new commands.DeleteMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: chunk.map((ReceiptHandle, index) => ({ Id: String(index), ReceiptHandle })),
        }),
      )
      const error = failures(response)
      if (error) throw error
    }
  }

  return {
    async send(bodies) {
      for (const batch of batches(bodies)) {
        const response = await client.send(
          new commands.SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: batch.map((MessageBody, index) => ({ Id: String(index), MessageBody })),
          }),
        )
        const error = failures(response)
        if (error) throw error
      }
    },

    async receive({ max, waitMs, signal }) {
      if (signal?.aborted) return []
      let response
      try {
        response = await client.send(
          new commands.ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: Math.max(1, Math.min(max, 10)),
            WaitTimeSeconds: Math.max(0, Math.min(Math.floor(waitMs / 1000), 20)),
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
            AttributeNames: ['ApproximateReceiveCount'],
          }),
          signal ? { abortSignal: signal } : undefined,
        )
      } catch (error) {
        if (signal?.aborted) return []
        throw error
      }
      return (
        (response?.Messages ?? []) as Array<{
          Body?: string
          ReceiptHandle: string
          Attributes?: Record<string, string>
        }>
      ).map(message => ({
        body: message.Body ?? '',
        attempts: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
        handle: message.ReceiptHandle,
      }))
    },

    async ack(messages) {
      await remove(messages.map(message => message.handle as string))
    },

    async retry(message, delayMs) {
      await client.send(
        new commands.ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.handle as string,
          VisibilityTimeout: Math.min(
            Math.max(Math.ceil(delayMs / 1000), 0),
            MAX_VISIBILITY_SECONDS,
          ),
        }),
      )
    },

    async deadLetter(message: ReceivedMessage, reason: string) {
      if (!options.deadLetterQueueUrl) {
        // Leave it to the queue's redrive policy.
        await client.send(
          new commands.ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.handle as string,
            VisibilityTimeout: 0,
          }),
        )
        return
      }
      await client.send(
        new commands.SendMessageCommand({
          QueueUrl: options.deadLetterQueueUrl,
          MessageBody: message.body,
          MessageAttributes: {
            reason: { DataType: 'String', StringValue: reason.slice(0, 1000) },
            attempts: { DataType: 'Number', StringValue: String(message.attempts) },
          },
        }),
      )
      await remove([message.handle as string])
    },
  }
}
