---
title: Playground
description: 'A demo website with the library, scripted visitor journeys that check every layer, and charts of what was collected.'
---

# Playground

The playground runs the real library on a demo website against a real collector, on your
machine. Nothing to configure.

```sh
git clone https://github.com/clearideas/consent-analytics.git
cd consent-analytics
npm ci && (cd sample-host && npm ci)
npm run playground
```

Open `http://localhost:5173`. The collector runs on `http://localhost:8787`; the two are
different origins, so the demo website is a cross-origin client like a real one.

## Pages

| Page | What it shows |
| --- | --- |
| **Overview** `/` | The collector you're talking to (library, server and spec versions, data policy, storage, region), and links to the other pages. |
| **Live** `/live` | A visitor's browser: the demo website in a frame. Choose the visitor's region, Global Privacy Control, choices per category, or the collector's "nothing without consent" policy; arrive from an ad or a password-reset link; flush, switch tabs or leave. Every request animates from the browser to the collector and into storage. |
| **Scenarios** `/scenarios` | Scripted visitors. Each journey acts on the demo website like a person, then checks four layers: the **browser** (banner, address bar, storage), the **network** (what left the browser), the **collector** (what it stored) and **Google** (what its tag received). |
| **Analytics** `/analytics` | Charts of everything stored: events over time, consent decisions, choices per category, tracking by country, consent by profile, pages, acquisition, web vitals, scroll depth, time on page, devices, what the collector added per profile, and an event explorer. |
| **Demo website** `/site/` | The site the library runs on: a few pages, visitor actions (`sign_up`, `purchase`, a newsletter signup, an error), an outbound link, and "Cookie settings". |

## Live

The inspector under the frame has five tabs:

- **Sent by the browser**: each request to the collector, `fetch` or `sendBeacon`, with its
  body and (for `fetch`) the collector's answer.
- **Stored events**: what the collector stored, with what the browser sent next to what the
  collector added (profile, server-side enrichment, corrected time, sanitizing).
- **Consent records**, **Google tag** calls, and **Browser storage** (`ci_*` keys and cookies).

Things to try:

| Try | What to look for |
| --- | --- |
| Region **Germany** | Banner. Events are `limited`: no query string, no attribution. *Start free trial* sends nothing. |
| **From a Google ad**, then *Accept all* | A `granted` record. The address bar loses `gclid` and `utm_*`; `ci_click` appears in storage. `sign_up` is `full` with attribution; Google gets the event without it, plus the Ads conversion. |
| *Cookie settings* → *Reject non-essential* | A `denied` record with the same consent ID. Attribution removed, Google consent `denied`. |
| Region **US** with **Global Privacy Control** | No banner, `full` first-party events, but marketing tags stay off until the visitor accepts in *Cookie settings*. |
| **Via a reset link** | The token, email and fragment are in the address bar, and in no request. |
| Region **Unknown** | Banner: unknown region means consent required. |
| **Choices per category**, then *Customize* | Unticked boxes; *Statistics* only gives a `partial` record, `full` events, and Google analytics without ad signals. |
| **Nothing without consent** with Germany | No events at all until the visitor accepts. |
| **Publish a new policy version** | Visitors who already decided are asked again. |

## Scenarios

*Run all* runs every journey; *Run this scenario* runs the selected one, at a watchable or
fast pace. Each check shows its evidence (for example the stored record), and *Under the
hood* shows the scenario's script.

The same scenarios run in CI, in Chromium (`e2e/playground-pages.spec.ts`): the build
fails if any check fails. To add one, append to `SCENARIOS` in
`sample-host/playground/assets/lib/scenarios.js`.

## Analytics

The charts update as data arrives. *Simulate visitors* runs 8 to 32 scripted browsers on the
demo website, from several regions and traffic sources, making different consent choices.
They go through the real library and the real collector, so the charts show what a real
site would collect. `?seed=42` on the page URL replays the same visitors.

## How it works

- The collector is the [collector library](./server/index.md) in a small
  [Hono](https://hono.dev) app (`sample-host/`), with the `balanced` data policy so the
  server-side enrichment is visible. Data is kept in memory.
- The demo website loads a small *wiretap* before the library that records each request to
  the collector and reports it to the page around it. Google's tag is a stub that records its
  calls. A real website needs neither.
- The playground pages use development endpoints (`/_dev/*`) that list stored data, stream
  changes, set the visitor's region and change the site's policy. They exist only with
  `DEV_MODE=1`; never enable it in production.
- The playground pages share the browser's storage with the demo website: use one playground
  tab at a time.

More demo sites on the same port: `/plain/first` (a plain site with only the script tag)
and `/tools/` (third-party tools under a strict Content Security Policy).
