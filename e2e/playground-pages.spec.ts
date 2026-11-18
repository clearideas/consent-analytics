// The playground pages around the demo website: the overview, the live playground (the site
// in a frame, driven from controls), the scenarios (scripted visitors with checks, which
// must all pass), and the analytics built from what the collector stored.
import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

const API = 'http://localhost:18787'

const events = async (request: APIRequestContext): Promise<any[]> =>
  (await request.get(`${API}/_dev/events?limit=5000`)).json()
const consents = async (request: APIRequestContext): Promise<any[]> =>
  (await request.get(`${API}/_dev/consents`)).json()

// The live playground's browser frame and its controls fit on one screen.
test.use({ viewport: { width: 1440, height: 1000 } })

const pageErrors: string[] = []
// The collector-contract scenario sends requests the collector refuses on purpose; the
// browser logs those answers (404, 413, 415) as failed resources.
const EXPECTED = /Failed to load resource: the server responded with a status of (404|413|415)/

test.beforeEach(async ({ request, page }) => {
  await request.post(`${API}/_dev/reset`)
  pageErrors.length = 0
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' && !EXPECTED.test(message.text()))
      pageErrors.push(message.text())
  })
})

test.afterEach(() => {
  expect(pageErrors, 'no errors in the page').toEqual([])
})

const site = (page: Page) => page.frameLocator('[data-testid="site-frame"]')

test('overview: the collector is described and every page is linked', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#collector-chip')).toHaveText('Collector online')
  await expect(page.locator('#environment')).toContainText('balanced')
  await expect(page.locator('#environment')).toContainText('consent-analytics')
  for (const id of ['live', 'scenarios', 'analytics', 'plain', 'tools']) {
    await expect(page.getByTestId(`card-${id}`)).toBeVisible()
  }
  await page.getByTestId('card-scenarios').click()
  await expect(page).toHaveURL(/\/scenarios$/)
})

test('live: the region decides the banner; decisions and requests are shown as they happen', async ({
  page,
  request,
}) => {
  await page.goto('/live')
  await page.click('[data-region="DE"]')
  await expect(page.locator('[data-region="DE"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(site(page).locator('#ci-consent-banner')).toBeVisible()
  await expect(page.locator('#status')).toContainText('Consent required: yes')

  await site(page).locator('#ci-consent-accept').click()
  await expect.poll(() => consents(request)).toHaveLength(1)
  await expect(page.locator('#status')).toContainText('Decision: accepted')
  await expect(page.locator('#feed-network')).toContainText('/v1/consent')
  await page.click('[data-tab="consents"]')
  await expect(page.getByTestId('consents').getByTestId('consent')).toHaveCount(1)
  await expect(page.locator('#count-consents')).toHaveText('1')

  // Actions on the site reach the collector; "Flush queue" sends the batch now.
  await site(page).locator('#ev-signup').click()
  await page.click('#flush')
  await expect.poll(async () => (await events(request)).map(e => e.name)).toContain('sign_up')
  await page.click('[data-tab="events"]')
  await expect(page.getByTestId('events')).toContainText('sign_up')
  // The flow counts what passed each stage.
  await expect(page.locator('#flow')).toContainText('1 consent')
})

test('live: resetting consent, the visitor, and everything', async ({ page, request }) => {
  await page.goto('/live')
  await page.click('[data-region="DE"]')
  await site(page).locator('#ci-consent-accept').click()
  await expect.poll(() => consents(request)).toHaveLength(1)

  await page.click('#reset-consent')
  await expect(page.locator('#reset-note')).toContainText('Consent reset')
  await expect(site(page).locator('#ci-consent-banner')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('ci_consent_status'))).toBeNull()

  await page.click('#reset-all')
  await expect(page.locator('#reset-note')).toContainText('Everything reset')
  await expect.poll(() => consents(request)).toEqual([])
  // The region override is gone: unknown region, so consent is required again.
  await expect(page.locator('#status')).toContainText('Region: unknown')
  await expect(site(page).locator('#ci-consent-banner')).toBeVisible()
})

test('live: arriving from an ad, as a US visitor with Global Privacy Control', async ({
  page,
  request,
}) => {
  await page.goto('/live')
  await page.click('[data-region="US"]')
  await page.locator('label:has(#gpc)').click()
  await expect(page.locator('#status')).toContainText('GPC: on')
  await page.click('#from-ads')
  await expect
    .poll(async () => (await events(request)).find(e => e.props.path === '/site/pricing'))
    .toMatchObject({ trackingCategory: 'full' })
  await expect(page.locator('#status')).toContainText('Marketing tags: off')
  await expect(page.locator('.browser .address')).toHaveText('http://localhost:15173/site/pricing')
})

test('scenarios: every scripted journey passes every check', async ({ page }) => {
  test.setTimeout(240_000)
  await page.goto('/scenarios?run=all&speed=fast')
  await expect(page.locator('body')).toHaveAttribute('data-run-complete', /passed|failed/, {
    timeout: 220_000,
  })
  const results = await page.evaluate(() =>
    [...(window as any).playgroundScenarios.results.values()].map((result: any) => ({
      id: result.id,
      failed: result.checks
        .filter((check: any) => check.state === 'failed')
        .map((check: any) => `${check.label}: ${check.detail}`),
    })),
  )
  expect(results.filter(result => result.failed.length)).toEqual([])
  expect(results.length).toBeGreaterThanOrEqual(15)
  await expect(page.locator('#summary')).toContainText('Failed checks0')
  // The last scenario's checks are on screen.
  expect(await page.getByTestId('check').count()).toBeGreaterThan(3)
})

test('analytics: simulated visitors become charts that match the stored data', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  await page.goto('/analytics?seed=7')
  await expect(page.locator('body')).toHaveAttribute('data-loaded', 'true')
  await expect(page.getByTestId('chart-timeline')).toContainText('No events yet.')

  // Charts are updated in place as data streams in: no panel or bar is ever re-created
  // (that would replay its animation, i.e. flash).
  await page.evaluate(() => {
    const counts = { panels: 0, bars: 0 }
    ;(window as any).replaced = counts
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (!(node instanceof Element)) continue
          if (node.matches('section.card')) counts.panels++
          counts.bars += node.matches('rect.bar, rect.hbar')
            ? 1
            : node.querySelectorAll('rect.bar, rect.hbar').length
        }
      }
    }).observe(document.querySelector('#dashboard')!, { childList: true, subtree: true })
  })

  await page.locator('label:has(input[name="visitors"][value="8"])').click()
  await page.click('#simulate')
  await expect(page.locator('body')).toHaveAttribute('data-simulated', 'true', { timeout: 100_000 })
  await expect(page.locator('#simulation-title')).toHaveText('8 visitors simulated')

  // The key figures are computed from what the collector stored.
  const stored = await events(request)
  const pageViews = stored.filter(e => e.name === 'page_view').length
  const sessions = new Set(stored.map(e => e.sessionId)).size
  expect(sessions).toBeGreaterThanOrEqual(8)
  await expect(page.locator('#kpis')).toContainText(`Page views${pageViews}`)
  await expect(page.locator('#kpis')).toContainText(`Sessions${sessions}`)
  await expect(
    page.getByTestId('chart-timeline').locator('rect.bar:not([height="0"])').first(),
  ).toBeVisible()
  await expect(page.getByTestId('chart-pages')).toContainText('/site/')
  await expect(page.getByTestId('chart-enrichment')).toContainText('gdpr')

  expect(await page.evaluate(() => (window as any).replaced)).toEqual({ panels: 0, bars: 0 })

  // The explorer shows what the browser sent next to what the collector added.
  await page.getByTestId('explorer-row').first().click()
  await expect(page.getByTestId('explorer')).toContainText('Added by the collector')
  await expect(page.getByTestId('explorer')).toContainText('"profile"')
})
