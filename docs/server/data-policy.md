---
title: Data policies
description: 'Decide per region whether consent is required, what the collector adds to events, and how long data is kept. Reference of the policy document and the built-in presets.'
---

# Data policies

A **data policy** maps the visitor's region to a **profile**. The profile decides:

- whether consent is required (which drives `GET /v1/context` and the banner);
- whether anything may be sent without consent;
- what the collector adds to **full** events and to **limited** events, besides what the
  browser sends (IP address, location, network, user agent, language, ...);
- how long events, IP addresses, raw user agents and consent records are kept.

```ts
import {
  balancedDataPolicy,
  strictDataPolicy,
} from '@clearideas/consent-analytics-server'

// the default
createCollector({ ..., dataPolicy: balancedDataPolicy() })
// stricter
createCollector({ ..., dataPolicy: strictDataPolicy() })
// your own document
const dataPolicy = JSON.parse(readFileSync('policy.json', 'utf8'))
createCollector({ ..., dataPolicy })
```

Each event and consent record is stored with the name of the profile applied (`profile`).

::: warning Review it for your deployment
The presets are starting points built from common readings of GDPR, ePrivacy and US state
laws. They are not legal advice, and the laws change. Review the policy you use.
:::

## The presets

### `balancedDataPolicy()` (default)

Everything useful with consent (or where none is required); the minimum without it.

| Profile | Regions | Consent | Full events | Limited events | Retention |
| --- | --- | --- | --- | --- | --- |
| `gdpr` | EEA, UK, Switzerland, and **unknown regions** | required | IP address, location to coordinates, network owner, raw and parsed user agent, language, GPC, privacy flags, identity | country, device type, language, GPC | events 25 months; IP and raw user agent 30 days; consent records 5 years |
| `us-privacy` | US states with privacy laws (`US-CA`, `US-CO`, `US-CT`, `US-DE`, `US-IA`, `US-IN`, `US-KY`, `US-MD`, `US-MN`, `US-MT`, `US-NE`, `US-NH`, `US-NJ`, `US-OR`, `US-RI`, `US-TN`, `US-TX`, `US-UT`, `US-VA`) | not required | everything; with a Global Privacy Control signal, no IP address and only the network's ASN | region, ASN, parsed user agent, language, GPC | events 36 months; IP and raw user agent 180 days; consent records 5 years |
| `open` | everywhere else | not required | everything | as `us-privacy` | as `us-privacy` |

US states are matched by their region code (`US-CA`), which needs a geo resolver that
provides it (such as [IPinfo](./sites-and-geo.md#ipinfo)); with only a country header, US
visitors get the `open` profile.

Options:

```ts
balancedDataPolicy({
  // default; countries, subdivisions or sets
  consentCountries: ['@EEA', 'GB', 'CH'],
  // within consentCountries: nothing without consent
  noTrackingWithoutConsentCountries: ['DE', 'AT'],
  // default: the list above
  usPrivacyStates: ['US-CA', 'US-CO'],
})
```

With `noTrackingWithoutConsentCountries`, those countries get a `gdpr-no-tracking` profile:
like `gdpr`, but browsers send nothing until the visitor allows statistics.

### `strictDataPolicy()`

Consent where required by region; nothing stored beyond what the browser sends; no expiry.
Profiles `consent` (the consent countries and unknown regions) and `no-consent`
(elsewhere). It takes `consentCountries` and `noTrackingWithoutConsentCountries` too.

### Editing a preset

Presets return plain policy documents; change them before passing them on:

```ts
const policy = balancedDataPolicy()
policy.profiles.gdpr.retention!.events = '13mo'
policy.profiles.open.collect!.full!.ip = 'truncated'
createCollector({ ..., dataPolicy: policy })
```

Or write the document yourself, as below.

## The policy document

```json
{
  "$schema": "./node_modules/@clearideas/consent-analytics-server/schemas/data-policy.schema.json",
  "version": 1,
  "description": "Example Inc. analytics policy",
  "regionSets": {
    "gdpr": ["@EEA", "GB", "CH"],
    "strict": ["DE", "AT"]
  },
  "profiles": {
    "gdpr": {
      "description": "Consent required",
      "consent": { "required": true },
      "collect": {
        "full": { "ip": "truncated", "geo": "city", "userAgent": "parsed", "language": true, "identity": true },
        "limited": { "geo": "country", "userAgent": "device-type" }
      },
      "retention": { "events": "25mo", "ip": "30d", "consents": "5y" }
    },
    "gdpr-strict": {
      "consent": { "required": true, "withoutConsent": "none" },
      "collect": { "full": { "ip": "truncated", "geo": "country", "userAgent": "parsed" } },
      "retention": { "events": "13mo", "consents": "5y" }
    },
    "rest": {
      "consent": { "required": false },
      "collect": {
        "full": { "ip": "full", "geo": "coords", "network": "org", "userAgent": "raw", "identity": true },
        "limited": { "geo": "region", "userAgent": "parsed" },
        "onGlobalPrivacyControl": { "ip": "none", "network": "asn" }
      },
      "retention": { "events": "36mo", "ip": "180d", "rawUserAgent": "180d", "consents": "5y" }
    }
  },
  "rules": [
    { "match": "unknown", "profile": "gdpr" },
    { "match": "@strict", "profile": "gdpr-strict" },
    { "match": "@gdpr", "profile": "gdpr" },
    { "match": "*", "profile": "rest" }
  ]
}
```

The schema ships in the package (`schemas/data-policy.schema.json`): with `$schema`, editors
complete and check the document. The collector validates it again at startup.

### `rules`

Checked in order; the first match selects the profile.

| `match` | Matches |
| --- | --- |
| `"DE"` | A country (ISO 3166-1 alpha-2) |
| `"US-CA"` | A subdivision (ISO 3166-2), when the geo resolver provides `regionCode` |
| `"@EU"`, `"@EEA"`, `"@name"` | A region set: built in (`@EU`: the 27 member states; `@EEA`: the EU plus Iceland, Liechtenstein and Norway), or from `regionSets` |
| `"unknown"` | Visitors whose region couldn't be determined |
| `"*"` | Everyone (a catch-all is required) |
| `["DE", "AT", "unknown"]` | Any of these |

### `regionSets`

Named lists of countries, subdivisions or other sets, used as `@name` in rules. Names start
with a letter: `A-Z a-z 0-9 _ -`, up to 64 characters.

### `profiles`

| Field | |
| --- | --- |
| `description` | For your reference |
| `consent.required` | Whether visitors must opt in before full tracking |
| `consent.withoutConsent` | Where consent is required: `limited` (default, anonymous essential events) or `none` (nothing) |
| `collect.full` | What is added to full events (below) |
| `collect.limited` | What is added to limited events (below; fewer options) |
| `collect.onGlobalPrivacyControl` | Overrides for full events when the browser sends `Sec-GPC: 1` |
| `retention.events` | How long events are kept |
| `retention.ip` | How long the IP address is kept on an event |
| `retention.rawUserAgent` | How long the raw user agent is kept on an event |
| `retention.consents` | How long consent records are kept |

Settings that are absent mean **not stored**; retention that is absent means **no expiry**.

### Collection levels

| Setting | Full events | Limited events |
| --- | --- | --- |
| `ip` | `none`, `truncated` (IPv4 /24, IPv6 /48), `hashed` (HMAC with `hashSecret`, with a key that changes daily), `full` | not allowed |
| `geo` | `none`, `country`, `region`, `city`, `coords` (city plus latitude and longitude) | `none`, `country`, `region` |
| `network` | `none`, `asn`, `org` (ASN and owner) | `none`, `asn` |
| `userAgent` | `none`, `device-type`, `parsed` (browser, OS, device, bot flag), `raw` (plus the header) | `none`, `device-type`, `parsed` |
| `language` | `true`: the primary language from `Accept-Language`, e.g. `de-DE` | same |
| `gpc` | `true`: whether the browser sent `Sec-GPC: 1` | same |
| `privacyFlags` | `true`: VPN, proxy, Tor, relay, hosting, when the geo resolver knows them | not allowed |
| `identity` | `true`: the signed-in visitor's identity keys | not allowed |
| `clientProps.deny` | Browser props to drop before storing, e.g. `["userAgent"]` | not available |

Location, network and privacy flags come from the geo resolver: a level can't add what the
resolver doesn't know (a country header gives only the country).

### Durations

A number and a unit: `d` (days), `w` (weeks), `mo` (months), `y` (years), e.g. `30d`,
`12w`, `25mo`, `5y`. Retention counts from when the collector received the record.

## Rules a policy can't break

The collector refuses a policy at startup (`DataPolicyError`, listing each problem) when:

- the profile for `unknown` regions doesn't require consent (the contract's fail-closed
  rule);
- there is no catch-all rule (`"*"`);
- a rule names a profile, or a region set, that doesn't exist, or region sets refer to each
  other in a circle;
- a region set is named like a built-in one (`EU`, `EEA`);
- a profile says `withoutConsent: "none"` without requiring consent;
- the document doesn't match the schema (unknown fields, invalid levels or durations).

`createCollector` also refuses a policy that uses `ip: "hashed"` without a `hashSecret`.

Limited events never get an IP address (in any form), an identity or privacy flags: the
schema has no such settings for them, and enrichment refuses them anyway.

## Changing a policy

- **New events** follow the new policy at once.
- **Stored records** keep what they have, and their own expiry dates. To apply shorter
  retention to records already stored, pass the policy to the
  [retention job](./retention-and-privacy.md): records of each profile received before the
  new cutoff are removed too.
- Changing whether consent is required doesn't change the browser's stored decisions. If your
  banner or purposes change, also change the sites' `policyVersion`.
