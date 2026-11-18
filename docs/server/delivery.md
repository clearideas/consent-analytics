---
title: Delivery and queues
description: 'Write events and consent records directly, through an in-process buffer, or through a queue and a worker; Redis Streams, SQS and your own queue.'
---

# Delivery and queues

Each endpoint chooses how its records reach the store:

| Mode | The browser gets its answer | If the process crashes | Needs |
| --- | --- | --- | --- |
| `direct` (default) | after the write, with real `duplicates` counts | nothing is lost (the browser retries a `503`) | a store |
| `buffered` | at once; written shortly after, in batches | what is in the buffer is lost | a store |
| `queued`, `ack: 'durable'` | once the queue has the message | nothing is lost | a queue and a worker |
| `queued`, `ack: 'fast'` | at once; sent to the queue shortly after | what isn't sent yet is lost | a queue and a worker |

```ts
createCollector({
  store,
  delivery: {
    // fastest intake
    events: { mode: 'queued', queue, ack: 'fast' },
    // evidence: written before answering
    consent: { mode: 'direct' },
  },
  ...
})
```

The API does all the work (validation, rules, policy, enrichment, identity) before
delivery: messages carry finished records, so the worker needs nothing but the queue and the
store. The `store` option may be left out when both endpoints are queued.

In the asynchronous modes, `202` means *accepted for storage*, and `duplicates` is `0`, as the
contract allows. Repeats are still stored only once.

## Choosing a mode

- **Small and medium sites:** `direct`. Simplest; a store outage gives `503`s, which browsers
  retry for `fetch` requests (beacons aren't retried; see
  [Events and delivery](../browser/events.md#delivery)).
- **Spiky traffic, a slow or remote database:** `queued` for events, with a worker writing in
  bulk. Use `ack: 'durable'` unless losing a few seconds of events in a crash is acceptable.
- **Consent records:** `direct` or `queued` with `ack: 'durable'`. They are evidence; don't
  buffer them in memory.
- `buffered` suits a single process that wants fast answers and bulk writes, and can accept
  losing the buffer in a crash.

## Buffers

`buffered`, and `queued` with `ack: 'fast'`, hold records in memory:

| Option | Default | |
| --- | --- | --- |
| `maxBatch` | 100 (buffered), 10 (queued) | Records per write, or messages per send |
| `flushIntervalMs` | 250 | Write at least this often while records wait |
| `maxBufferedMessages` | 10 000 | Capacity |
| `whenFull` | write directly (`'direct'`, or `'durable'` when queued) | When full, handle this request as if unbuffered, so a busy server slows down instead of losing data; `'reject'` answers `503` instead |

Failed writes are retried with backoff, in order. `collector.close()` writes what is left
(up to `flushTimeoutMs`, 10 s by default); `collector.stats()` reports what is buffered,
written, retried and lost.

## The worker

```ts
import { runWorker } from '@clearideas/consent-analytics-server'

const worker = runWorker({ queue, store, logger })
process.on('SIGTERM', async () => {
  await worker.stop() // finishes the messages in hand
  process.exit(0)
})
```

- **Bulk writes:** the events of all messages received together go in one insert.
- **A failed message** is retried after a growing delay. After `maxAttempts` deliveries, or
  at once if it can't be decoded, it is **dead-lettered** (`hooks.onDeadLetter`).
- **One bad message doesn't block the others:** a failed bulk write is retried message by
  message.
- **When the store is down,** every write fails; the worker then pauses before receiving more.
- **Redelivery is safe:** events are unique by `(siteKey, eventId)`, consent records by
  `recordId`.

| Option | Default | |
| --- | --- | --- |
| `batchSize` | 10 | Messages per receive (and per bulk write) |
| `waitMs` | 20 000 | Long-poll wait per receive |
| `concurrency` | 1 | Parallel receive loops |
| `maxAttempts` | 10 | Deliveries before a failing message is dead-lettered |
| `retryBaseMs`, `retryMaxMs` | 1 s, 5 min | Delay before a retry, doubling per attempt |
| `outageBaseMs`, `outageMaxMs` | 1 s, 1 min | Pause when all writes of a batch fail |
| `logger` | warnings and errors on stderr | |
| `hooks.onError`, `hooks.onDeadLetter` | | Report failures and dead letters |

`worker.stats()` reports messages received, written, retried and dead-lettered. Run workers
in their own processes to scale them independently of the API, or in the API process for
simplicity.

To consume messages with your own framework instead (a Lambda function triggered by SQS, for
example), use `createIngestProcessor({ store, logger }).process(bodies)`: it decodes and
writes a list of message bodies, and returns one outcome per message, so you can report the
failed ones back to the queue.

## Queues

### In memory

`memoryQueue()`: for tests, or a single process that wants the API and the worker decoupled.
Messages are lost on restart.

### Redis Streams

```ts
import {
  fromNodeRedis,
  redisStreamQueue,
} from '@clearideas/consent-analytics-server/redis'

const queue = redisStreamQueue(fromNodeRedis(redisClient), {
  // default
  stream: '{consent-analytics}:ingest',
  // default: unacknowledged messages are delivered again
  visibilityTimeoutMs: 60_000,
})
```

A stream with a consumer group: at-least-once delivery; messages of a crashed worker are
reclaimed after `visibilityTimeoutMs`; delayed retries wait in a sorted set; dead letters go
to `<stream>:dead`. Acknowledged entries are deleted, so the stream holds only what's waiting.
It needs node-redis or ioredis (blocking reads), and uses a duplicate connection per receive
loop, so blocking never delays your other Redis commands. See [Redis](./redis.md).

### Amazon SQS

```ts
import * as sqs from '@aws-sdk/client-sqs'
import { sqsQueue } from '@clearideas/consent-analytics-server/sqs'

const queue = sqsQueue({
  client: new sqs.SQSClient({}),
  // the SDK module: its command classes are used
  commands: sqs,
  queueUrl: process.env.ANALYTICS_QUEUE_URL!,
  deadLetterQueueUrl: process.env.ANALYTICS_DLQ_URL, // optional
})
```

- Messages are sent in batches of up to 10 entries and 256 KiB; attempts come from
  `ApproximateReceiveCount`; a retry changes the message's visibility.
- Set the queue's visibility timeout above your slowest write (60 seconds is a good start).
- Without `deadLetterQueueUrl`, dead letters are left to the queue's redrive policy
  (`maxReceiveCount`): configure one.
- SQS may still delete a message acknowledged with an outdated receipt; idempotent writes make
  that harmless.
- Tested against an SQS emulator with the AWS SDK v3.

### Your own queue

Any queue works through a small interface (see [Custom adapters](./custom-adapters.md#queues)):

```ts
interface IngestQueue {
  send(bodies: string[]): Promise<void>
  receive(options: {
    max: number
    waitMs: number
    signal?: AbortSignal
  }): Promise<ReceivedMessage[]>
  ack(messages: ReceivedMessage[]): Promise<void>
  retry(message: ReceivedMessage, delayMs: number): Promise<void>
  deadLetter(message: ReceivedMessage, reason: string): Promise<void>
}
```

## Messages

A message body is a JSON document with a version (`v`), a `kind` (`events` or `consent`) and
finished records. `encodeMessage()` and `decodeMessage()` are exported; a message the worker
can't decode (an unknown version, for example) is dead-lettered at once.
