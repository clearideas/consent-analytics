---
title: Quick start
description: 'Run a collector, add the browser library to a page, and see consent and events arrive.'
---

# Quick start

In ten minutes: a collector on your machine, a web page with the consent banner, and the
events and consent records it stores.

Requirements:

- Node.js 24.15 or newer, or 22.22 or newer
- a terminal and a browser

## 1. Start a collector

Create an empty project and install the browser library and standalone collector:

```sh
mkdir consent-analytics-demo && cd consent-analytics-demo
npm init -y
npm install @clearideas/consent-analytics @clearideas/consent-analytics-collector
```

Register your site. A site has a public **site key** and the exact **origins** (scheme,
host and port) of the pages allowed to use it. Save this as `sites.json`:

```json
[
  {
    "siteKey": "my-site",
    "allowedOrigins": ["http://localhost:8080"],
    "policyVersion": "1"
  }
]
```

Start the collector. `DEFAULT_COUNTRY=DE` pretends every visitor is in Germany, so you
see the consent banner; on a real deployment the country comes from your CDN or an IP
lookup (see [Sites, origins and location](./server/sites-and-geo.md)).

```sh
HOST=127.0.0.1 SITES_FILE=./sites.json DEFAULT_COUNTRY=DE npx consent-analytics-collector
```

It listens on `http://localhost:8787` and stores to SQLite in `./data/analytics.db`. In
another terminal, check it:

```sh
curl http://localhost:8787/v1/health
curl -H 'Origin: http://localhost:8080' \
  'http://localhost:8787/v1/context?siteKey=my-site'
```

The second answer says `"consentRequired":true` for `"country":"DE"`.

## 2. Add the library to a page

In a second terminal, open the `consent-analytics-demo` folder and copy the script and its
built-in plugin files into a folder for the demo site:

```sh
mkdir my-site
cp -R node_modules/@clearideas/consent-analytics/dist/. my-site/
```

and save this as `my-site/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>My site</title>
    <script
      async
      src="/analytics.js"
      data-api-base-url="http://localhost:8787/"
      data-site-key="my-site"
    ></script>
  </head>
  <body>
    <h1>Hello</h1>
    <button
      onclick="ClearIdeasAnalytics.get().trackEvent('sign_up', { plan: 'pro' })"
    >
      Sign up
    </button>
    <footer><a href="#ci-consent-settings">Cookie settings</a></footer>
  </body>
</html>
```

Serve the folder on port 8080, the origin you registered:

```sh
cd my-site && npx serve -l 8080 .
```

Open `http://localhost:8080`. You should see the consent banner.

On your own site, load the library from npm or a CDN instead: see
[Add it to your site](./browser/frameworks.md).

## 3. Watch what happens

Open your browser's developer tools, on the **Network** tab:

- `GET /v1/context?siteKey=my-site` answers `consentRequired: true`.
- A `POST /v1/events` carries `limited` events: the `page_view`, and soon after
  `auto_metrics` and `web_vital`. They are anonymous, with the URL reduced to origin and
  path.
- Click **Sign up**: nothing is sent. `sign_up` isn't one of the events allowed without
  consent, so it is discarded.
- Click **Accept all**: a `POST /v1/consent` sends a `granted` consent record.
- Click **Sign up** again: this time `sign_up` is a `full` event. Events like this are
  sent in batches: within a minute (the default `flushInterval`), when ten are queued, or
  at once when you switch tabs or leave the page.

Look at what the collector stored, with the `sqlite3` command-line tool or any SQLite
client:

```sh
sqlite3 data/analytics.db "select name,
  json_extract(doc, '$.trackingCategory'), json_extract(doc, '$.profile')
  from events"
sqlite3 data/analytics.db "select json_extract(doc, '$.decision'),
  json_extract(doc, '$.policyVersion') from consents"
```

The profile, `gdpr`, is the part of the data policy (`balanced` by default) that applied to
a visitor in Germany. It decides what the collector adds to each event:
`json_extract(doc, '$.server')` shows the country and the parsed user agent, and for `full`
events the IP address too.

To start over as a new visitor, clear the site's storage in the developer tools
(Application → Storage → Clear site data).

## 4. Try other visitors

Restart the collector without `DEFAULT_COUNTRY`: the region is now unknown, and the banner
still appears (unknown means consent required). With `DEFAULT_COUNTRY=US`, there is no
banner and events are `full` from the start. Clear the site's data before reloading: the
browser keeps the collector's answer for the session.

For a richer tour (regions, Global Privacy Control, third-party tags, scripted journeys and
charts), run the [playground](./playground.md).

## Next steps

- [Core concepts](./concepts.md): policy, decisions, records, full and limited events.
- [Add it to your site](./browser/frameworks.md): npm, React, Next.js, Vue, Nuxt and others.
- [Consent and the banner](./browser/consent.md): texts, categories, your own UI.
- Collector in your own API: [Express](./server/express.md), or
  [run it as a service](./server/collector.md).
- [Production guide](./server/production.md) before going live.
