---
title: Attribution and conversions
description: 'First-touch attribution from campaign parameters and ad click IDs, under the visitor''s consent, and conversions for Google Ads, Microsoft Ads and OpenAI Ads.'
---

# Attribution and conversions

The library remembers where a visitor first came from (campaign parameters and ad click
IDs), sends it with their `full` events, and uses it to decide which ad platform gets a
conversion.

## What is captured

From the landing page's URL, only these parameters:

| Source | Parameters |
| --- | --- |
| Google Ads | `gclid`, `gbraid`, `wbraid` (`gtm_debug` stands in for `gclid` when testing) |
| Microsoft Ads | `msclkid` (`bat_debug` stands in when testing) |
| Meta | `fbclid` |
| Campaigns | `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `utm_context` |
| Your own campaigns | `ci_source`, `ci_medium`, `ci_campaign`, `ci_term`, `ci_content` |

With them: the referrer (origin and path only), the landing path, and when the visitor
landed, was first seen and last seen. Values longer than 256 characters are dropped, and
data read back from storage or a cookie is validated again, so other keys are never sent.

## When it is captured

Attribution follows the visitor's statistics choice:

| Situation | What happens |
| --- | --- |
| Consent not required, visitor hasn't refused | Stored at once |
| Consent required, visitor undecided | Held in memory only; nothing stored, nothing sent |
| Visitor allows statistics | The landing attribution is stored, even if they have navigated since |
| Visitor refuses or withdraws statistics | Stored attribution and the attribution cookie are deleted |

It is **first-touch**: once stored, later campaign visits don't replace it (only its
`lastSeen` time is updated).

It is stored in `localStorage` (`ci_click`). With `cookieDomain` set (for example
`example.com`), it is also kept in a 90-day first-party cookie on that domain, so
`app.example.com` and `www.example.com` share it. The domain must be the current host or a
parent of it; it is never guessed.

Once captured, the parameters are removed from the address bar (`history.replaceState`),
so they aren't shared or bookmarked. `cleanAttributionUrl: false` keeps them.

## What is sent

- To your **collector**: in every `full` event, as `props.attribution`, with the campaign
  parameters and `gclid`/`msclkid` also at the top level of `props`. Never in `limited`
  events.
- To **third parties**: not forwarded as event parameters. Attribution is used only to
  decide conversions (below).

Page URLs in events keep the campaign parameters (`utm_*`, `ci_*`), and drop everything
else, including click IDs: see [What leaves the page](./privacy-security.md#what-leaves-the-page).

## Conversions

With the [Google Analytics](./third-party.md) and Microsoft UET integrations configured,
a tracked event can trigger an ad conversion:

```ts
integrations: {
  googleAnalytics: {
    measurementId: 'G-XXXXXXXXXX',
    adsConversions: {
      sign_up: 'AW-123456789/AbCdEf',
      purchase: 'AW-123456789/GhIjKl',
    },
  },
  microsoftUet: { tagId: '12345678', goals: { purchase: 'purchase-goal' } },
}
```

```ts
analytics.trackEvent('purchase', { value: 99, currency: 'USD' })
```

| Platform | A conversion is sent when |
| --- | --- |
| Google Ads | The event has a conversion in `adsConversions` (or `ads_send_to` in its props), **marketing** is allowed, and the visitor came from Google Ads (`gclid`, `gbraid`, `wbraid`, or `utm_source=google` with `utm_medium=cpc`). `force_ads_conversion: true` in the props skips the last check. |
| Microsoft Ads | The event has a goal in `goals` (or `goal_id` in its props), marketing is allowed, and the visitor came from Microsoft Ads (`msclkid`). `force_ms_conversion: true` skips the last check. |

The control props (`ads_send_to`, `force_ads_conversion`, `goal_id`,
`force_ms_conversion`, ...) are not forwarded to the vendors as event parameters.

## OpenAI Ads

The OpenAI Ads Measurement Pixel is a marketing integration:

```ts
integrations: { openAIAds: { pixelId: 'px_…' } }
```

When marketing is allowed, it maps your events to OpenAI's standard events:

| Your event | OpenAI event |
| --- | --- |
| `sign_up`, `sign_up_start`, `signup_start`, `submit_contact_form` | `lead_created` |
| `signup_complete`, `sign_up_complete` | `registration_completed` |
| `trial_started` | `trial_started` |
| `intent_pricing_view` | `page_viewed` |
| `newsletter_signup` | custom `newsletter_signup` |

Add or override mappings with `events`:

```ts
openAIAds: {
  pixelId: 'px_…',
  events: {
    quote_requested: {
      eventName: 'custom',
      customEventName: 'quote_requested',
      type: 'custom',
    },
    demo_booked: 'appointment_scheduled',
  },
}
```

## Reading attribution in your code

```ts
import { getAttributionContext } from '@clearideas/consent-analytics'

const attribution = getAttributionContext()
// { gclid, utm_source, landingPath, landedAt, ... } or null
```

For example, to pass it with a form to your own backend:

```html
<input type="hidden" name="gclid" :value="attribution?.gclid" />
<input type="hidden" name="utm_source" :value="attribution?.utm_source" />
```

It is `null` until statistics is allowed (or where consent isn't required). In the browser
console, with `exposeGlobals` or `debug` on: `ciAnalytics.getAttributionContext()`.

## Across domains

- **Subdomains** of one site: set `cookieDomain` to the parent domain.
- **Different domains** (e.g. `example.com` to `example-shop.com`): browsers don't share
  storage or first-party cookies between them. Keep the campaign parameters on the links
  between your domains, so the second site captures them too.
