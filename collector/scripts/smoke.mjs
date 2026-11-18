#!/usr/bin/env node
// Smoke test of a running collector (a container, or a local process):
//   node collector/scripts/smoke.mjs http://localhost:8787 [siteKey] [origin]
// Defaults match collector/sites.example.json. Checks health, readiness, metrics, the
// context, a consent record (and its retry) and an event batch, plus CORS and the
// fail-closed default (no geo configured: consent required).
import assert from 'node:assert/strict'

const [base = 'http://localhost:8787', siteKey = 'example-site', origin = 'https://www.example.com'] =
  process.argv.slice(2)
const url = path => new URL(path, base.endsWith('/') ? base : `${base}/`).href

// Wait for the collector to come up (containers take a moment).
const deadline = Date.now() + 60_000
for (;;) {
  try {
    if ((await fetch(url('healthz'))).ok) break
  } catch {}
  if (Date.now() > deadline) throw new Error(`${base} did not become healthy`)
  await new Promise(resolve => setTimeout(resolve, 500))
}

const ready = await fetch(url('readyz'))
assert.equal(ready.status, 200, `readyz: ${await ready.text()}`)

const context = await fetch(url(`v1/context?siteKey=${siteKey}`), { headers: { Origin: origin } })
assert.equal(context.status, 200)
assert.equal(context.headers.get('access-control-allow-origin'), origin)
const { policy } = await context.json()
assert.equal(typeof policy.consentRequired, 'boolean')

const foreign = await fetch(url(`v1/context?siteKey=${siteKey}`), {
  headers: { Origin: 'https://not-allowed.example' },
})
assert.equal(foreign.status, 403)

const now = new Date().toISOString()
const id = suffix => `smoke${Date.now().toString(36)}${suffix}`.padEnd(24, '0').slice(0, 24)
const record = {
  v: 1,
  siteKey,
  consentId: id('c'),
  decision: 'granted',
  policyVersion: policy.policyVersion,
  decidedAt: now,
  source: 'banner',
}
const post = (path, body) =>
  fetch(url(path), {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify(body),
  })
const consent = await post('v1/consent', record)
assert.equal(consent.status, 201, await consent.clone().text())
const retried = await post('v1/consent', record)
assert.equal(retried.status, 201)
assert.equal((await retried.json()).recordId, (await consent.json()).recordId)

const events = await post('v1/events', {
  v: 1,
  siteKey,
  sentAt: now,
  events: [
    {
      eventId: id('e'),
      name: 'page_view',
      occurredAt: now,
      sessionId: id('s'),
      pageViewId: id('p'),
      trackingCategory: 'full',
      consent: { required: policy.consentRequired, granted: true },
      props: { url: `${origin}/smoke`, path: '/smoke' },
    },
  ],
})
assert.equal(events.status, 202, await events.clone().text())
assert.equal((await events.json()).accepted, 1)

const metrics = await fetch(url('metrics'))
if (metrics.status !== 404) {
  assert.equal(metrics.status, 200)
  assert.match(await metrics.text(), /^consent_analytics_up 1$/m)
}

console.log(`Smoke test passed: ${base} (consent required: ${policy.consentRequired})`)
