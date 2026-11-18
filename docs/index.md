---
title: Clear Ideas Consent Analytics
description: 'Privacy-first analytics with a consent banner for any website, and the collector that stores what it sends, standalone or inside your own API.'
layout: doc
aside: false
---

<div class="ca-hero">

# Analytics that asks first

Measure your website with a consent banner built in. The browser library decides what
may be sent for each visitor; the collector checks it again, adds what your data policy
allows, and stores it in your own database.

</div>

```sh
npm install @clearideas/consent-analytics
```

Consent Analytics is open source (MIT). It has three parts, which you can use together
or on their own:

| Part | Package | What it does |
| --- | --- | --- |
| Browser library | `@clearideas/consent-analytics` | Consent banner, page and event tracking, attribution and third-party tools, in any website or framework |
| Collector library | `@clearideas/consent-analytics-server` | Receives, checks and stores what the browser sends. Mount it in Express, `node:http` or a Fetch API server. No dependencies |
| Standalone collector | `@clearideas/consent-analytics-collector` | The collector library as a service: environment variables, CLI and Docker image |

They talk through a documented HTTP contract, [`spec/openapi.yaml`](https://github.com/clearideas/consent-analytics/blob/main/spec/openapi.yaml),
so you can also write your own collector.

<div class="ca-grid">
  <a class="ca-card" href="./getting-started">
    <strong>Quick start</strong>
    <span>Run a collector and add the library to a page in ten minutes.</span>
  </a>
  <a class="ca-card" href="./concepts">
    <strong>Core concepts</strong>
    <span>Consent policy, decisions and records, full and limited events.</span>
  </a>
  <a class="ca-card" href="./browser/frameworks">
    <strong>Add it to your site</strong>
    <span>Script tag, React, Next.js, Vue, Nuxt, SvelteKit, Angular, Astro.</span>
  </a>
  <a class="ca-card" href="./server/express">
    <strong>Collector in Express</strong>
    <span>One middleware in the API you already run, with your database and queue.</span>
  </a>
</div>

## How it fits together

<div class="ca-flow">
  <div><strong>Browser library</strong><br/><small>banner, events, consent records</small></div>
  <span>→</span>
  <div><strong>Collector API</strong><br/><small>/v1/context, /v1/events, /v1/consent</small></div>
  <span>→</span>
  <div><strong>Collector</strong><br/><small>origins, validation, rules, data policy</small></div>
  <span>→</span>
  <div><strong>Your storage</strong><br/><small>MongoDB, Postgres, MySQL, DynamoDB, SQLite</small></div>
</div>

1. When a page loads, the browser library asks the collector for this visitor's
   **consent policy** (`GET /v1/context`). The collector answers from the visitor's region:
   is consent required, and which version of your policy applies. If it can't tell, consent
   is required.
2. Until the visitor accepts, the library sends only anonymous **limited** events, or
   nothing where your policy says so. After acceptance, **full** events carry the page,
   attribution and context.
3. Every decision becomes an append-only **consent record** (`POST /v1/consent`), your proof
   of what the visitor agreed to.
4. The collector checks every event against the visitor's consent again, adds what your
   **data policy** allows for the region (location, device, and so on), and writes it to
   your store, directly or through a queue.

## Choose a path

| Goal | Start here |
| --- | --- |
| See it working, without setting anything up | [Playground](./playground.md) |
| Add analytics and a banner to a website | [Quick start](./getting-started.md), then [Add it to your site](./browser/frameworks.md) |
| Add the collector to an existing Node.js API | [Express](./server/express.md) or [node:http and Fetch platforms](./server/node-and-fetch.md) |
| Run the collector as its own service | [Standalone collector](./server/collector.md) |
| Decide what is stored, per region | [Data policies](./server/data-policy.md) |
| Load Google Analytics, Meta Pixel and others only with consent | [Third-party tools](./browser/third-party.md) |
| Identify signed-in visitors | [Signed-in visitors](./browser/identity.md) |
| Go to production | [Production guide](./server/production.md) |
| Write your own collector | [Collector API (v1)](./api-contract.md) |

## Design principles

- **Unknown means consent required.** If the collector can't determine the visitor's
  region, or the browser can't reach the collector, the library treats consent as required.
- **Limited means anonymous.** Before consent, events carry an allowlisted set of fields:
  no attribution, no query strings, no identifiers. The collector enforces the same
  allowlist.
- **Records are evidence.** Consent records are append-only and carry the policy version.
  A withdrawal is a new record, never an edit.
- **Third parties wait.** Vendor tags load, and receive events, only once the visitor
  allows their category. Withdrawal stops them and removes their cookies.
- **Your data, your database.** The collector writes to storage you run. Nothing goes to
  Clear Ideas.

::: info Not legal advice
These pages describe what the software does. Whether your configuration meets the laws
that apply to you (GDPR, ePrivacy, US state laws, ...) is for you and your advisers to
decide.
:::
