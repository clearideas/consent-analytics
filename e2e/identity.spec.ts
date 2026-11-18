// Identity from the website's own HttpOnly session cookie, in a real browser.
// The collector library runs inside an Express 5 "API" on another origin of the same site
// (like api.example.com for www.example.com). Host: server/test/e2e/identity-host.ts.
import type { APIRequestContext } from '@playwright/test'
import { expect, test } from '@playwright/test'

import { IDENTITY_API, IDENTITY_SITE } from '../playwright.config'

interface Stored {
  events: any[]
  consents: any[]
  identities: any[]
}

const stored = async (request: APIRequestContext): Promise<Stored> =>
  (await request.get(`${IDENTITY_API}/_test/stored`)).json()
const pageViews = async (request: APIRequestContext) =>
  (await stored(request)).events.filter(e => e.name === 'page_view')

const pageErrors: string[] = []
test.beforeEach(async ({ request, page }) => {
  await request.post(`${IDENTITY_API}/_test/reset`)
  pageErrors.length = 0
  page.on('pageerror', error => pageErrors.push(error.message))
})
test.afterEach(() => expect(pageErrors).toEqual([]))

test('a signed-in visitor: events and consent records carry the identity from the HttpOnly cookie', async ({
  page,
  request,
}) => {
  await page.goto(`${IDENTITY_API}/login`) // the API sets sid (HttpOnly, Secure, SameSite=Lax)
  await page.goto(`${IDENTITY_SITE}/identified`) // script tag with data-credentials="include"

  await expect.poll(async () => (await pageViews(request)).length).toBeGreaterThan(0)
  const [view] = await pageViews(request)
  expect(view.identity).toEqual({ userId: 'user-42', accountId: 'account-7' })
  expect(view.trackingCategory).toBe('full')

  // The page itself can't read the session cookie.
  expect(await page.evaluate(() => document.cookie)).not.toContain('sid=')

  await page.evaluate(() => (window as any).ClearIdeasAnalytics.get().consent.accept())
  await expect.poll(async () => (await stored(request)).consents.length).toBe(1)
  const { consents, identities } = await stored(request)
  expect(consents[0]).toMatchObject({
    decision: 'granted',
    identity: { userId: 'user-42', accountId: 'account-7' },
  })
  expect(identities).toEqual([expect.objectContaining({ traits: { plan: 'pro' } })])
})

test('an anonymous visitor on the same page: everything works, without identity', async ({
  page,
  request,
}) => {
  await page.goto(`${IDENTITY_SITE}/identified`)
  await expect.poll(async () => (await pageViews(request)).length).toBeGreaterThan(0)
  expect((await pageViews(request))[0]).not.toHaveProperty('identity')
})

test('without the credentials option, fetch requests carry no cookie: enable both together', async ({
  page,
  request,
}) => {
  // app-site enables credentialed requests, but this page does not set data-credentials.
  await page.goto(`${IDENTITY_API}/login`)
  await page.goto(`${IDENTITY_SITE}/not-opted-in`)
  await expect.poll(async () => (await pageViews(request)).length).toBeGreaterThan(0)
  await page.evaluate(() => (window as any).ClearIdeasAnalytics.get().consent.accept())
  await expect.poll(async () => (await stored(request)).consents.length).toBe(1)

  // Events go out with sendBeacon, which always attaches cookies: they are identified.
  expect((await pageViews(request))[0].identity).toEqual({
    userId: 'user-42',
    accountId: 'account-7',
  })
  // The consent record is sent with fetch, which omits cookies by default: not linked.
  expect((await stored(request)).consents[0]).not.toHaveProperty('identity')
})

test('a site without credentialed requests ignores the cookie, even when sendBeacon attaches it', async ({
  page,
  request,
}) => {
  await page.goto(`${IDENTITY_API}/login`)
  await page.goto(`${IDENTITY_SITE}/public`) // public-site, whose browser config asks for credentials
  await expect.poll(async () => (await stored(request)).events.length).toBeGreaterThan(0)

  // Leave the page: page_exit goes out with sendBeacon, which always attaches cookies.
  await page.goto('about:blank')
  await expect
    .poll(async () => (await stored(request)).events.map(e => e.name))
    .toContain('page_exit')
  const { events } = await stored(request)
  expect(events.every(e => e.identity === undefined)).toBe(true)
})
