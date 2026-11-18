---
title: Consent and the banner
description: 'How consent works in the browser library, the built-in banner, choices per category, your own consent UI, Global Privacy Control and policy versions.'
---

# Consent and the banner

## How consent works

1. On page load, the library asks the collector for the visitor's policy
   (`GET /v1/context`): is consent required, which `policyVersion`, and what may be sent
   before a decision. The answer is kept for the browser session. If the request fails,
   consent is required.
2. Where consent is required and the visitor hasn't decided, the **banner** appears.
   Meanwhile only anonymous `limited` events are sent, or nothing where the policy says
   `trackingWithoutConsent: "none"`. Third-party tools stay off.
3. The visitor's **decision** is stored in the browser (`localStorage`, key
   `ci_consent_status`) and applies at once: full events, stored attribution and allowed
   tools start; refused tools are removed.
4. A **consent record** is sent to the collector (`POST /v1/consent`). Records that can't be
   delivered are kept and retried on the next visit.
5. When you publish a new `policyVersion` on the collector, decisions made under the old
   version no longer count, and the banner appears again.

Where consent isn't required (by region, or the site's `consentMode: "never"`), there is
no banner: events are `full` unless the visitor refuses through *Cookie settings*.

## The banner

The built-in banner is framework-neutral and accessible:

- It's a labelled region with native buttons, operable with the keyboard.
- *Accept all* and *Reject non-essential* are equally prominent.
- It doesn't take focus when the page loads, but does when the visitor opens it.
- The privacy link accepts only `http(s)` URLs.
- Configured texts are rendered as text, never as HTML.

Change its texts and behavior with the `banner` option (see the
[configuration reference](./configuration.md#consent) for every default):

```ts
banner: {
  title: 'Cookies on example.com',
  message: 'We use cookies to …',
  acceptLabel: 'Accept all',
  rejectLabel: 'Reject non-essential',
  privacyPolicyUrl: 'https://www.example.com/privacy',
  position: 'bottom', // or 'top'
  // false: only when you call analytics.consent.showBanner()
  autoShow: true,
}
```

### Styling

Theme it with CSS custom properties on `:root` (or any ancestor):

```css
:root {
  --ci-consent-background: #ffffff;
  --ci-consent-color: #111827;
  --ci-consent-border: #e5e7eb;
  --ci-consent-link: #4f46e5;
  --ci-consent-button-background: #4f46e5;
  --ci-consent-button-color: #ffffff;
  --ci-consent-button-border: #4f46e5;
  --ci-consent-radius: 10px;
  --ci-consent-font: inherit;
  --ci-consent-focus: #ffbf47;
  --ci-consent-max-width: 1100px;
  --ci-consent-z-index: 2147483000;
}
```

The banner injects its stylesheet by default. Under a strict Content Security Policy
(no inline styles), set `banner: { injectStyles: false }` and include the stylesheet
yourself: `import '@clearideas/consent-analytics/consent.css'`, or copy
`dist/consent.css`. For your own markup entirely, use [your own consent UI](#your-own-consent-ui).

## Letting visitors change their decision

Once a visitor has decided, the banner is gone. Give them a way back, usually in the
footer:

```html
<a href="#ci-consent-settings">Cookie settings</a>
```

- `data-ci-consent-settings` or the class `ci-consent-settings` work too, on any link or
  button.
- Clicking it opens the banner with focus on the choices. It works with client-side
  routers, and also when clicked before the script has loaded: the banner opens on arrival at
  `#ci-consent-settings` (also from other pages, e.g. `/about#ci-consent-settings`).
- It works in every region, so visitors where consent isn't required can still opt out.
- Without such a link, a small floating *Cookie settings* button appears once a visitor
  has decided, where consent is required (`banner.manageButton: 'auto'`). With the link on
  the page, the button isn't added; `manageButton: true` shows both.
- From code: `analytics.consent.showBanner()`.

## Choices per category

By default visitors make one choice (**simple** mode), recorded as the same choice for every
category. To let them choose per category:

```ts
// all three categories
consent: { choices: 'categories' }
// or only some of them
consent: { choices: 'categories', categories: ['statistics', 'marketing'] }
```

The banner gets a *Customize* button that opens the categories, with descriptions. None is
pre-ticked, and *Necessary* is always on. A choice that allows some categories is recorded
as `partial`, with the choice per category.

| Category | Covers |
| --- | --- |
| necessary | The consent mechanism; functional integrations. Always allowed. |
| preferences | Remembered settings; Intercom by default |
| statistics | Full first-party analytics (`full` events), stored attribution, Google Analytics, Microsoft Clarity, Hotjar |
| marketing | Google Ads conversions and ad signals, Microsoft UET, OpenAI Ads, Meta Pixel, LinkedIn Insight, HubSpot by default, and custom plugins unless they say otherwise |

Labels and descriptions are configurable: `banner.categoryText`, `customizeLabel`,
`saveLabel`, `categoriesLegend`.

## Your own consent UI

With `banner: false`, the library shows nothing, and you build the UI on the consent API:

```ts
const state = analytics.consent.get()
// { required, granted, categories, gpc, policyVersion }

// everything
await analytics.consent.accept()
// only necessary
await analytics.consent.reject()
// per category
await analytics.consent.set({ statistics: true, marketing: false })

// called when the policy is known, and after each decision
const stop = analytics.consent.onChange(state => render(state))
```

- `granted` is `true` when everything was accepted, `false` for any other decision
  (rejected or partial), and `null` while undecided. `categories` holds the choice per
  category (`null` while undecided).
- Decisions made through the API are recorded with `source: "api"`; through the banner,
  `source: "banner"`.
- `onChange` is called once the policy is known (after `GET /v1/context`) and after each
  decision. Wait for `await analytics.ready()` before reading `consent.get()` if you need the
  policy.
- In React, `useConsent()` gives the same state and re-renders on changes.

You can also keep the built-in banner but decide when it appears:

```ts
// banner: { autoShow: false }
router.afterEach(to => {
  const { required, granted } = analytics.consent.get()
  if (publicRoutes.includes(to.path) && required && granted === null) {
    analytics.consent.showBanner()
  }
})
```

## Global Privacy Control

Browsers with Global Privacy Control (`navigator.globalPrivacyControl`) ask sites not to
sell or share the visitor's data. Where consent isn't required, the library then withholds
the **marketing** category (advertising tags, conversions) unless the visitor explicitly
accepts through the banner. Statistics is unaffected. Set
`respectGlobalPrivacyControl: false` to turn this off.

The collector sees the signal too (`Sec-GPC: 1`); its data policy can store less for those
visitors (the `balanced` policy drops the IP address and network owner in US privacy states).

## Policy versions

Each decision is for one `policyVersion`, set on the collector per site. Change it when your
consent policy, banner or tools change materially: visitors who decided under the old
version count as undecided again and see the banner. Their earlier records stay on the
collector.

## Nothing without consent

Some regulators expect nothing at all to be measured before consent, not even anonymous
page views. Where the collector's policy says `trackingWithoutConsent: "none"` for the
visitor's region (or your site sets `consent: { trackingWithoutConsent: 'none' }`), the
library sends no events until statistics is allowed. Only the consent mechanism itself
runs. The collector's per-region answer wins over the site setting.

## Withdrawal and refusal

Refusing (or withdrawing) a category:

- stops full events and third-party tools in that category, and deletes the cookies and
  storage keys declared for them;
- deletes stored attribution (`ci_click`) when statistics is refused;
- reloads the page once, after the decision is saved, if a running tool can't be stopped in
  place (turn this off with `consent: { reloadOnWithdrawal: false }`).

Details per tool: [Third-party tools](./third-party.md#what-refusal-and-withdrawal-do).

## Why it works this way

Several parts of the design come from GDPR and the EU ePrivacy Directive. They are listed
here so they aren't removed as unnecessary complexity. This describes the design; it is not
legal advice.

| Behavior | Reason |
| --- | --- |
| Consent before non-essential storage or access on the device, with the consent decision itself treated as necessary | ePrivacy Directive Art. 5(3) requires consent for storage that isn't strictly necessary. GDPR defines valid consent (Art. 4(11), Art. 7). |
| Unknown region or a failed context request means consent is required | A safe default: if the region is unknown, the library can't assume consent is unnecessary. |
| Reject is as prominent as accept; the banner can be reopened at any time | Consent must be freely given, and withdrawing it as easy as giving it (GDPR Art. 4(11), Art. 7(3); EDPB Guidelines 05/2020). |
| Category boxes are never pre-ticked | Silence or pre-ticked boxes are not consent (GDPR Recital 32; CJEU *Planet49*, C-673/17). |
| Separate statistics and marketing categories | Consent must be specific to each purpose (GDPR Art. 4(11), Art. 6(1)(a)). |
| Append-only consent records with `consentId`, `policyVersion`, `decidedAt` and `source` | The site must be able to show that consent was given (GDPR Art. 7(1)). Withdrawals are new records, so history is never overwritten. |
| Asking again when `policyVersion` changes | Consent is valid only for the purposes the visitor was told about. |
| Attribution and vendor cookies deleted on withdrawal; tools that can't be stopped are removed by a reload | Data kept only because of consent should stop being processed once it is withdrawn (GDPR Art. 7(3), Art. 17(1)(b)). |
| Third-party code loaded only after consent | Storage and access on the device by those tools needs consent first (ePrivacy Art. 5(3)); a tool that has already run can't be un-run. |
| URL sanitization, no fingerprinting fields, no IP addresses or cookies with consent records | Data minimization and data protection by default (GDPR Art. 5(1)(c), Art. 25). |
| `trackingWithoutConsent: "none"` per region | EU regulators differ on whether anonymous audience measurement without consent is acceptable (France's CNIL allows a narrow exemption; others are stricter), so it's set per region. |

Global Privacy Control comes from US state privacy laws (such as California's opt-out of
sale and sharing), not GDPR, which is why it withholds only marketing.
