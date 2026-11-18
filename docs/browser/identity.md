---
title: Signed-in visitors
description: 'Link events and consent records to your signed-in users from your own authentication cookie, with a collector on your site.'
---

# Signed-in visitors

If the collector runs on your own API, on the same site as your website (for example
`api.example.com` for `www.example.com`), it can tell who a signed-in visitor is from your
existing authentication cookie, `HttpOnly` cookies included. The identity comes from your
server's own session check, never from the browser, so a visitor can't claim to be someone
else.

## Setup

Three settings go together:

1. **The site** on the collector allows credentialed requests:
   ```json
   { "siteKey": "my-site", "allowedOrigins": ["https://www.example.com"], "credentials": true }
   ```
2. **The collector** reads the visitor from your session, with `identify`. In Express:
   ```ts
   app.use('/analytics', collectorMiddleware(collector, {
     identify: req => (req.user ? { userId: req.user.id, accountId: req.user.accountId } : null),
   }))
   ```
   See [Signed-in visitors on the collector](../server/identity.md).
3. **The browser** sends cookies to the collector:

   | Integration | Setting |
   | --- | --- |
   | Options object | `credentials: 'include'` |
   | Script tag | `data-credentials="include"` |
   | Nuxt | `analyticsCredentials: 'include'` |
   | Vite | `VITE_ANALYTICS_CREDENTIALS=include` |

   Use `'same-origin'` if the collector is on the website's own origin (for example
   `https://www.example.com/analytics`).

Enable the browser and site settings together. `sendBeacon` always sends cookies, but
`fetch` (used for the context, consent records and retries) sends them only with this
option: with only one side enabled, some requests would be identified and others not.

## What is stored

- **Full events** carry the identity keys (e.g. `userId`, `accountId`) when the visitor
  allowed statistics, or where consent isn't required, and the collector's data policy
  allows identities for the region (the `balanced` policy does; `strict` doesn't).
- **Consent records** are linked to the identity, as proof of which account decided.
- **Limited events** never carry an identity.
- Extra attributes (for example `plan`) can be kept once per identity, not on every event.

## Limits

- The collector must share your website's **registrable domain** (site): browsers block
  cookies to other sites. `collector.example.com` works for `www.example.com`;
  `example-analytics.net` doesn't.
- Your session cookie must be sent to the collector's host: a cookie set for
  `www.example.com` only isn't sent to `api.example.com`. Set it for `example.com`, or mount
  the collector in the API that already receives it.
