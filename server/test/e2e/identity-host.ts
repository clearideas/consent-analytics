// End-to-end host for identity tests (e2e/identity.spec.ts), run with Node directly:
//   node server/test/e2e/identity-host.ts
//
// Two origins on the same site, like www.example.com and api.example.com:
//   API  http://localhost:IDENTITY_API_PORT   an Express 5 app: /login issues an HttpOnly
//        session cookie; an optional auth middleware sets req.user; the collector is mounted
//        at /analytics with `identify`; /_test/* exposes what was stored.
//   SITE http://localhost:IDENTITY_SITE_PORT  pages using the script-tag build.
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'

import express from 'express'

import { collectorMiddleware } from '../../src/http/express.ts'
import { createCollector, fixedGeo, memoryStore } from '../../src/index.ts'

const API_PORT = Number(process.env.IDENTITY_API_PORT ?? 18790)
const SITE_PORT = Number(process.env.IDENTITY_SITE_PORT ?? 15190)
const API = `http://localhost:${API_PORT}`
const SITE = `http://localhost:${SITE_PORT}`
const LIB_DIR = resolve(join(import.meta.dirname, '..', '..', '..', 'dist'))

const store = memoryStore()
const collector = createCollector({
  sites: [
    // Identifies signed-in visitors from the API's session cookie.
    { siteKey: 'app-site', allowedOrigins: [SITE], credentials: true },
    // Does not enable credentialed requests: cookies are ignored.
    { siteKey: 'public-site', allowedOrigins: [SITE] },
  ],
  store,
  geo: fixedGeo({ country: 'US' }), // no consent required: full tracking
  identity: { traits: ['plan'] },
  logger: false,
})

// --- API (same site as the website, another origin) ------------------------------------
const sessions = new Map<string, { id: string; account: string; plan: string }>()
type Req = express.Request & { user?: { id: string; account: string; plan: string } }

const api = express()
api.get('/login', (_req, res) => {
  const sid = `s-${Math.random().toString(36).slice(2)}`
  sessions.set(sid, { id: 'user-42', account: 'account-7', plan: 'pro' })
  res.cookie('sid', sid, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
  res.send('signed in')
})
// Optional authentication: never rejects anonymous visitors.
api.use((req: Req, _res, next) => {
  const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
  const user = sid ? sessions.get(sid) : undefined
  if (user) req.user = user
  next()
})
api.use(
  '/analytics',
  collectorMiddleware<Req>(collector, {
    identify: req =>
      req.user ? { userId: req.user.id, accountId: req.user.account, plan: req.user.plan } : null,
  }),
)
api.get('/_test/stored', async (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    events: await store.listEvents({ limit: 10_000 }),
    consents: await store.listConsents({ limit: 10_000 }),
    identities: await store.listIdentities(),
  })
})
api.post('/_test/reset', (_req, res) => {
  store.clear()
  sessions.clear()
  res.json({ ok: true })
})

// --- website ------------------------------------------------------------------------------
const page = (siteKey: string, credentials?: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${siteKey}</title>
  <script async src="/lib/analytics.js"
          data-api-base-url="${API}/analytics/"
          data-site-key="${siteKey}"${credentials ? ` data-credentials="${credentials}"` : ''}></script>
</head>
<body><h1>${siteKey}</h1><p id="cookies"></p></body>
</html>`

const site = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', SITE).pathname
  if (path.startsWith('/lib/')) {
    // Serve the library build, never anything outside dist/.
    const file = resolve(LIB_DIR, `.${sep}${path.slice('/lib/'.length)}`)
    try {
      if (!file.startsWith(LIB_DIR + sep)) throw new Error('outside dist/')
      const body = await readFile(file)
      res.writeHead(200, {
        'Content-Type':
          extname(file) === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream',
      })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('Library not built. Run `npm run build` in the repository root.')
    }
    return
  }
  const pages: Record<string, string> = {
    '/identified': page('app-site', 'include'),
    '/not-opted-in': page('app-site'),
    '/public': page('public-site', 'include'),
  }
  const html = pages[path]
  res.writeHead(html ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html ?? 'not found')
})

api.listen(API_PORT, () => console.log(`identity e2e API  ${API}`))
site.listen(SITE_PORT, () => console.log(`identity e2e site ${SITE}`))
