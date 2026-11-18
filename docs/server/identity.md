---
title: Signed-in visitors on the collector
description: 'Identify signed-in visitors from your own authentication, and control which identity keys and traits are stored.'
---

# Signed-in visitors

When the collector runs in your API, on the same site as your website, it can tell who a
signed-in visitor is from your own session check, and store their identity with their full
events and consent records.

Three settings go together:

1. **The site** allows credentialed requests (`credentials: true`). Responses then allow
   credentials, for that site's origins only. Sites without it ignore cookies, including those
   `sendBeacon` attaches.
2. **`identify`** returns the visitor from your session: the Express middleware option
   `identify(req)`, or the collector option `identify(request)` for other transports. Return
   `null` for anonymous visitors.
3. **The browser** sends cookies: `credentials: 'include'` (see
   [the browser side](../browser/identity.md)).

```ts
const collector = createCollector({
  sites: [
    {
      siteKey: 'app',
      allowedOrigins: ['https://app.example.com'],
      credentials: true,
    },
  ],
  identity: {
    // default: stored with events and consent records
    keys: ['userId', 'accountId'],
    // optional: kept once per identity, not on every event
    traits: ['plan', 'role'],
  },
  ...
})

// sets req.user if the session cookie is valid; never rejects
app.use(optionalAuth)
app.use(
  '/analytics',
  collectorMiddleware(collector, {
    identify: req =>
      req.user
        ? {
            userId: req.user.id,
            accountId: req.user.accountId,
            plan: req.user.plan,
          }
        : null,
  }),
)
```

For the `node:http` and Fetch transports, set `identify` on the collector; it receives the
neutral request, whose `raw` property is the framework's own request:

```ts
createCollector({
  ...,
  identify: async request => {
    const cookie = request.headers.get('cookie')
    const session = await sessions.fromCookieHeader(cookie)
    return session ? { userId: session.userId } : null
  },
})
```

## What `identify` may return

An object of **keys** and **traits**, as configured in `identity`:

- Values may be strings (up to 256 characters, `maxValueLength`), numbers or booleans.
  Other values are dropped.
- Names that are neither keys nor traits are dropped, with one warning per name. The value
  is never logged.
- Without at least one key, the visitor counts as anonymous.
- A failing `identify` is logged and counts as anonymous; the request still succeeds.
- Key and trait names: a letter or `_`, then letters, digits or `_`, up to 64 characters.

## What is stored

| Record | Identity |
| --- | --- |
| Full events | The identity keys, when the visitor allowed statistics or consent isn't required, **and** the region's [data policy](./data-policy.md) profile has `identity: true` (the `balanced` preset does; `strict` doesn't) |
| Limited events | Never (a rule of the contract) |
| Consent records | Always linked, as proof of which account decided. `identity: { consentRecords: false }` turns it off. |
| Identities | The traits, once per identity, with when they were last seen, through the store's optional `upsertIdentity` |

A `userId` the browser puts in event props stays an ordinary, untrusted prop: only
`identify` sets the identity.

## Finding a person's data

A person's records can be [exported or erased](./retention-and-privacy.md#data-subject-requests)
by their identity keys (indexed in MongoDB and Postgres):

```ts
await store.exportSubject({ siteKey: 'app', identity: { userId: 'u-123' } })
await store.eraseSubject({ siteKey: 'app', identity: { userId: 'u-123' } })
```
