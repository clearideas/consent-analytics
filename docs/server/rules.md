---
title: Event rules
description: 'How the collector checks each event against the visitor''s consent, repairs or rejects it, and annotates consent records.'
---

# Event rules

Browsers can be old, buggy or tampered with. Before an event is stored, the collector checks
it against what it knows about the visitor, and against the contract's rules for limited
events.

```ts
createCollector({ ..., rules: { preset: 'standard' } }) // the default
```

## Presets

| Preset | Behavior |
| --- | --- |
| `standard` | **Repairs** inconsistent events toward the more private reading, and records each repair in the event's `sanitized` list. Events that can't be allowed are rejected. |
| `strict` | **Rejects** inconsistent events instead of repairing them. |
| `off` | No consent checks. Only clock-skew correction and your custom rules run. |

## What is checked

In order, for each valid event:

| Check | `standard` | `strict` |
| --- | --- | --- |
| The site's `eventNames.allow` / `deny` lists | rejected | rejected |
| A `limited` event claims consent was granted | claim removed: `consent-granted-cleared` | rejected |
| A `full` event without consent, where consent is required (by the event's claim or the visitor's region) | stored as limited: `downgraded-to-limited` | rejected |
| A limited event where the region allows nothing without consent | rejected | rejected |
| A limited event of a name that isn't collected without consent (only `page_view`, `page_exit`, `web_vital`, `auto_metrics`, `error` are) | rejected | rejected |
| A limited event with props outside the allowlist (`x-limited-tracking`) | props removed: `limited-props-removed` | rejected |
| A limited event's `url` or `outboundUrl` with a query or fragment | reduced to origin and path: `limited-url-reduced` (or removed if not a URL: `limited-url-removed`) | same |
| A limited event's error `message` over 500 characters | shortened: `limited-message-shortened` | same |
| The event time, corrected for clock skew (receive time minus `sentAt`), more than 7 days in the past or 10 minutes in the future | replaced by the receive time: `occurred-at-replaced` | same |

Rejected events are reported in the answer's `rejected[]`, with the field and the reason,
and aren't stored. The rest of the batch is.

Other repairs the collector records in `sanitized`:

| Code | |
| --- | --- |
| `nul-characters-removed` | NUL characters were removed from props (MongoDB and Postgres can't store them) |
| `client-props-denied` | Props listed in the data policy's `clientProps.deny` were removed |

Every stored event has `occurredAtCorrected`: the browser's time, corrected for the
difference between the browser's and the server's clocks, or the receive time when that
was implausible.

## Options

```ts
rules: {
  preset: 'standard',
  // corrected times further in the past are replaced
  maxPastDays: 7,
  // corrected times further in the future are replaced
  maxFutureMinutes: 10,
  custom: [dropInternalTraffic],
}
```

## Custom rules

A custom rule runs after the built-in ones, for each event that is still kept. Return
nothing to keep the event as it is, `{ event }` to replace it (with an optional `sanitized`
code), or `{ drop }` to reject it:

```ts
import type { CustomRule } from '@clearideas/consent-analytics-server'

const dropInternalTraffic: CustomRule = (event, context) => {
  if (event.props.path?.toString().startsWith('/admin')) {
    return {
      drop: { path: '/props/path', message: 'admin pages are not tracked' },
    }
  }
  if (event.name === 'purchase' && typeof event.props.value === 'string') {
    return {
      event: {
        ...event,
        props: { ...event.props, value: Number(event.props.value) },
      },
      sanitized: 'purchase-value-converted',
    }
  }
}
```

`context` has the `site`, whether `consentRequired` for the visitor, whether the region
allows nothing without consent (`nothingWithoutConsent`), `receivedAt` and the batch's
`sentAt`. Don't loosen the consent rules in a custom rule: a limited event must stay
anonymous.

## Consent records

Consent records are evidence, so they are **never modified**. The collector adds
`annotations` instead:

| Annotation | |
| --- | --- |
| `decision-categories-mismatch` | The decision doesn't match the categories (e.g. `granted` with a category refused) |
| `partial-without-categories` | A `partial` decision without the choice per category |
| `policy-version-not-current` | The record is for another `policyVersion` than the site's current one |

Records that don't match the contract (an unknown decision, a malformed `consentId`, ...)
are refused with `400`, as is a `policyVersion` containing NUL characters.
