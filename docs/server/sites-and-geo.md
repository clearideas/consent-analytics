---
title: Sites, origins and location
description: 'Register sites and their allowed origins, load sites from your database, and determine visitors'' location from CDN headers, IPinfo or your own service.'
---

# Sites, origins and location

## Sites

```ts
createCollector({
  sites: [
    {
      siteKey: 'my-site',
      name: 'Example',
      allowedOrigins: ['https://www.example.com', 'https://example.com'],
      policyVersion: '2026-11-01',
      consentMode: 'geo',
      trackingWithoutConsent: 'limited',
      eventNames: { deny: ['debug_event'] },
      credentials: false,
    },
  ],
  ...
})
```

| Field | Required | |
| --- | --- | --- |
| `siteKey` | yes | The public key the browser sends: 3 to 64 of `A-Z a-z 0-9 . _ -`. |
| `allowedOrigins` | yes | Exact origins (scheme, host, port; no path) allowed to use the key. |
| `name` | | For your own reference. |
| `policyVersion` | | Default `"1"`. Change it when your consent policy or banner changes materially: visitors are asked again. |
| `consentMode` | | `geo` (default): by the visitor's region, through the data policy. `always` / `never`: regardless of region. |
| `trackingWithoutConsent` | | Where consent is required and not given: `limited` (default) or `none` (nothing). The data policy can set `none` per region; the stricter wins. |
| `eventNames` | | `{ allow: [...] }` accepts only these event names; `{ deny: [...] }` never these. Others are rejected (`rejected[]`). |
| `credentials` | | `true`: cookies are accepted from this site's origins, and signed-in visitors can be [identified](./identity.md). Default `false`. |

Definitions are validated when the collector is created: an invalid one throws
`SiteConfigError` with the field and the reason.

### Origins and CORS

- A request's `Origin` must be in a site's `allowedOrigins`: otherwise `403 Origin not allowed`,
  without CORS headers. `POST` requests require an `Origin` (browsers always send one,
  including with `sendBeacon`).
- For allowed origins, every response, errors included, carries
  `Access-Control-Allow-Origin: <origin>` and `Vary: Origin`. Preflights (`OPTIONS`) are
  answered with `204`.
- `Access-Control-Allow-Credentials: true` is sent only to origins of sites with
  `credentials: true`. For other sites, cookies (such as those `sendBeacon` attaches) are
  ignored.
- `GET /v1/context` without an `Origin` (same-origin requests) is allowed; the site key must
  still exist.
- Write origins exactly as browsers send them: `https://www.example.com` and
  `https://example.com` are different; `http://localhost:3000` includes the port.

### Site sources

Instead of a list, `sites` takes any **site source**:

```ts
interface SiteSource {
  getSite(siteKey: string): Site | null | Promise<Site | null>
  isOriginAllowed(origin: string): boolean | Promise<boolean>
  isCredentialedOrigin?(origin: string): boolean | Promise<boolean>
}
```

Building blocks:

| Function | |
| --- | --- |
| `staticSites(list)` | Sites from configuration (what a plain list becomes). |
| `mongoSites({ db, collection? })` | Sites from a MongoDB collection you manage (default `analytics_sites`), documents with the fields above. Invalid documents are logged and treated as unknown. From `/mongodb`. |
| `cachedSites(source, { ttlMs, negativeTtlMs, shared })` | Caches answers: 60 s (`ttlMs`), unknown sites and origins 10 s (`negativeTtlMs`). `shared` adds a cache shared by instances (e.g. `redisCache(redis)`). `invalidate(siteKey?)` forgets answers at once. |
| `chainSites(a, b, ...)` | Asks sources in order; the first that knows the site answers. |
| `defineSite(input)` | Validates one definition and fills defaults. |

```ts
import {
  cachedSites,
  chainSites,
  staticSites,
} from '@clearideas/consent-analytics-server'
import { mongoSites } from '@clearideas/consent-analytics-server/mongodb'

sites: cachedSites(
  chainSites(
    staticSites(configSites),
    mongoSites({ db: () => mongoose.connection.db }),
  ),
  { shared: redisCache(redis) },
)
```

Always cache a database-backed source: the collector asks for the site on every request.
With `cachedSites`, a change (such as a new `policyVersion`) takes effect within `ttlMs`, or
at once after `invalidate()`.

A failing source makes the collector answer `503` (and call `hooks.onError`), so browsers
retry.

## Location

The collector needs the visitor's region to choose the data policy profile: most
importantly, whether consent is required. A **geo resolver** provides it:

```ts
type GeoResolver = (request: { headers: HeaderReader; clientIp?: string }) =>
  Geo | null | undefined | Promise<Geo | null | undefined>
```

Without a resolver, every region is unknown, so **consent is required everywhere**.

| Resolver | |
| --- | --- |
| `trustedHeaderGeo(headers, { continentHeaders? })` | Reads the country from headers your CDN or proxy sets. |
| `ipinfoGeo({ token, ... })` | Looks the client IP up with IPinfo. From `/ipinfo`. |
| `fixedGeo({ country })` | Always the same country (development, or single-country sites). |
| `chainGeo(a, b, ...)` | Tries resolvers in order; the first that knows the country wins. |

```ts
geo: chainGeo(
  // free and instant, when the CDN sets the header
  trustedHeaderGeo(['cf-ipcountry'], {
    continentHeaders: ['cf-ipcontinent'],
  }),
  // otherwise, a lookup
  ipinfoGeo({ token: process.env.IPINFO_TOKEN!, cache: redisCache(redis) }),
)
```

### Trusted headers

Common headers: `cf-ipcountry` (Cloudflare), `cloudfront-viewer-country` (Amazon
CloudFront), `x-vercel-ip-country` (Vercel), `x-appengine-country` (Google App Engine).

::: warning Only headers your proxy sets
If visitors can reach the collector directly, they can send these headers themselves and
choose their own consent policy. Trust a header only if your CDN or proxy overwrites it on
every request, and the collector isn't reachable around it.
:::

- A value that isn't a real country is ignored: `XX` (unknown), `T1` (Tor), continent codes
  such as `EU`, and other placeholders. The next resolver is then asked.
- A continent header is read only as the continent, never as a country (`NA` would be
  Namibia).

### IPinfo

```ts
import { ipinfoGeo } from '@clearideas/consent-analytics-server/ipinfo'

ipinfoGeo({
  token: process.env.IPINFO_TOKEN!,
  // optional, shared by instances
  cache: redisCache(redis),
  // the same on every instance, to share the cache
  cacheKeySecret: process.env.HASH_SECRET,
  timeoutMs: 150,
})
```

- Answers the country, region and (for the US and Canada) region codes such as `US-CA`, so
  data policy rules can match states; city, postal code, coordinates, time zone, ASN and
  organization; and privacy flags (VPN, proxy, Tor, relay, hosting) when your plan includes
  them. What is **stored** is decided by the data policy.
- The classic API (`ipinfo.io/{ip}/json`) and the newer one are both understood; `url`
  chooses the endpoint, e.g. `ip => \`https://api.ipinfo.io/lookup/${ip}\``. The token goes
  in the `Authorization` header.
- **Bounded:** a 150 ms timeout, an in-memory cache plus the optional shared one (answers
  24 hours, unknown answers 10 minutes; `ttlMs`). Private, loopback and other non-public
  addresses are never looked up.
- **Failures** (timeouts, errors, quota) give an unknown location, so consent is required,
  and a warning is logged at most once a minute.
- Cache keys are an HMAC of the IP address, never the address.

### Your own resolver

```ts
const myGeo: GeoResolver = async ({ clientIp, headers }) => {
  if (!clientIp) return null
  const answer = await myGeoService.lookup(clientIp)
  return answer
    ? { country: answer.countryCode, regionCode: answer.subdivision }
    : null
}
```

A resolver may return `country` (ISO 3166-1 alpha-2; required for the answer to count),
`continent`, `region`, `regionCode` (ISO 3166-2, e.g. `US-CA`), `city`, `postalCode`,
`latitude`/`longitude`, `timezone`, `asn`, `org` and `privacy` flags. Everything is
validated; invalid fields are dropped. A resolver that throws counts as unknown.

`GET /v1/context` returns only the country and continent to the browser. The client IP
(`clientIp`) depends on [`trustProxy`](./node-and-fetch.md#client-ip).
