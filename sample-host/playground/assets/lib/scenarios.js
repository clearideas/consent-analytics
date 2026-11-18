// Scripted visitor journeys. Each one drives the demo website like a visitor (region, clicks,
// navigation), then checks what the browser kept, what it sent, what the collector stored
// and what Google received. They run in the playground (/scenarios) and in CI (e2e).
//
// A check passes or fails on its own; a scenario passes when all of its checks pass.
const ORIGIN = location.origin

const byName = (events, name) => events.filter(event => event.name === name)
const names = events => events.map(event => event.name)
const show = value => JSON.stringify(value)

/** Stored events of a name, once there are at least `count`. */
const storedNamed = async (t, name, count = 1) => {
  const found = byName(await t.events(), name)
  return found.length >= count ? found : undefined
}

export const SCENARIOS = [
  {
    id: 'eu-undecided',
    title: 'EU visitor, before a decision',
    summary:
      'Banner shown; only limited, anonymous events; nothing non-essential leaves the browser.',
    tags: ['Germany', 'limited'],
    async run(t) {
      await t.step(
        'A visitor from Germany arrives from a newsletter link',
        '/site/pricing?utm_source=newsletter&gclid=CLICK-1',
      )
      await t.region('DE', 'EU')
      await t.visit('/site/pricing?utm_source=newsletter&gclid=CLICK-1')
      t.check('The consent banner is shown', t.bannerVisible())
      t.check('Consent is required for this visitor', t.consent()?.required === true, {
        detail: show(t.consent()),
      })
      await t.eventually('The page_view is stored as a limited event', async () => {
        const [view] = byName(await t.events(), 'page_view')
        return { pass: view?.trackingCategory === 'limited', detail: show(view?.trackingCategory) }
      })
      await t.eventually(
        'The stored page URL has no query string (no campaign, no click ID)',
        async () => {
          const [view] = byName(await t.events(), 'page_view')
          return { pass: view?.props.url === `${ORIGIN}/site/pricing`, detail: view?.props.url }
        },
      )

      await t.step(
        'The visitor clicks "Start free trial" (sign_up)',
        'non-essential: needs consent',
      )
      await t.click('#ev-signup')
      t.flush()
      await t.stays(
        'sign_up is not sent without consent',
        () => !t.sentEventNames().includes('sign_up'),
        {
          layer: 'network',
        },
      )
      await t.stays(
        'sign_up is not stored',
        async () => !names(await t.events()).includes('sign_up'),
        { wait: 100 },
      )
      t.check('No attribution is kept in the browser (ci_click)', t.local('ci_click') === null)
      t.check('Nothing is sent to Google', t.gtagEvents().length === 0, {
        layer: 'google',
        detail: show(t.gtagEvents()),
      })
      const stored = await t.events()
      t.check(
        'Every stored event is limited',
        stored.every(event => event.trackingCategory === 'limited'),
        {
          layer: 'collector',
          detail: show(names(stored)),
        },
      )
      t.check('The click ID was never stored', !show(stored).includes('CLICK-1'), {
        layer: 'collector',
      })
    },
  },
  {
    id: 'eu-accepts',
    title: 'EU visitor from an ad accepts',
    summary: 'Consent record, attribution, full events, and the Google Ads conversion.',
    tags: ['Germany', 'full', 'Google'],
    async run(t) {
      await t.step(
        'A visitor from Germany clicks a Google ad',
        '/site/pricing?gclid=…&utm_source=google&utm_medium=cpc',
      )
      await t.region('DE', 'EU')
      await t.visit('/site/pricing?gclid=PLAYGROUND-GCLID-123&utm_source=google&utm_medium=cpc')
      t.check('The consent banner is shown', t.bannerVisible())

      await t.step('The visitor clicks "Accept all"')
      await t.clickBanner('Accept all')
      t.check('The banner closes', !t.bannerVisible())
      await t.eventually(
        'A "granted" consent record is stored, for the current policy, from the banner',
        async () => {
          const [record] = await t.consents()
          return {
            pass:
              record?.decision === 'granted' &&
              record.policyVersion === '1' &&
              record.source === 'banner',
            detail: show(
              record && {
                decision: record.decision,
                policyVersion: record.policyVersion,
                source: record.source,
              },
            ),
          }
        },
      )
      t.check(
        'The address bar no longer shows the campaign parameters',
        t.url() === `${ORIGIN}/site/pricing`,
        {
          detail: t.url(),
        },
      )
      const attribution = JSON.parse(t.local('ci_click') ?? 'null')
      t.check(
        'First-touch attribution is kept (gclid, utm_source, landing page)',
        attribution?.gclid === 'PLAYGROUND-GCLID-123' &&
          attribution.utm_source === 'google' &&
          attribution.landingPath === '/site/pricing',
        {
          detail: show(attribution),
        },
      )

      await t.step('The visitor starts a free trial (sign_up)')
      await t.click('#ev-signup')
      t.flush()
      await t.eventually(
        'sign_up is stored as a full event with consent and attribution',
        async () => {
          const [signUp] = (await storedNamed(t, 'sign_up')) ?? []
          return {
            pass:
              signUp?.trackingCategory === 'full' &&
              signUp.consentGranted === true &&
              signUp.props.attribution?.gclid === 'PLAYGROUND-GCLID-123',
            detail: show(
              signUp && {
                trackingCategory: signUp.trackingCategory,
                attribution: signUp.props.attribution,
              },
            ),
          }
        },
      )
      t.check(
        'Google consent is updated to granted',
        t.gtag.some(
          call =>
            call[0] === 'consent' && call[1] === 'update' && call[2]?.ad_storage === 'granted',
        ),
        {
          layer: 'google',
        },
      )
      const gaSignUp = t.gtag.find(call => call[0] === 'event' && call[1] === 'sign_up')
      t.check(
        'Google Analytics gets sign_up without attribution or click IDs',
        !!gaSignUp && show(gaSignUp[2]) === show({ plan: 'pro', method: 'email' }),
        {
          layer: 'google',
          detail: show(gaSignUp),
        },
      )
      await t.eventually(
        'The Google Ads conversion is sent',
        () =>
          t.gtag.some(
            call => call[1] === 'conversion' && call[2]?.send_to === 'AW-PLAYGROUND/signup',
          ),
        {
          layer: 'google',
        },
      )
    },
  },
  {
    id: 'eu-rejects',
    title: 'EU visitor rejects',
    summary: 'A "denied" record; no attribution; trackers denied; limited events continue.',
    tags: ['France', 'limited'],
    async run(t) {
      await t.step(
        'A visitor from France arrives from a Google ad',
        '/site/?utm_source=google&gclid=X1',
      )
      await t.region('FR', 'EU')
      await t.visit('/site/?utm_source=google&gclid=X1')

      await t.step('The visitor clicks "Reject non-essential"')
      await t.clickBanner('Reject non-essential')
      await t.eventually('A "denied" consent record is stored', async () => {
        const records = await t.consents()
        return {
          pass: records.length === 1 && records[0].decision === 'denied',
          detail: show(records.map(r => r.decision)),
        }
      })
      t.check(
        'Google consent is updated to denied',
        t.gtag.some(
          call =>
            call[0] === 'consent' &&
            call[1] === 'update' &&
            call[2]?.ad_storage === 'denied' &&
            call[2]?.analytics_storage === 'denied',
        ),
        {
          layer: 'google',
        },
      )
      t.check('No attribution is kept in the browser', t.local('ci_click') === null)

      await t.step('The visitor starts a free trial and opens the docs')
      await t.click('#ev-signup')
      await t.navigate('/site/docs')
      t.flush()
      await t.eventually('Page views continue as limited events', async () => {
        const views = byName(await t.events(), 'page_view')
        return {
          pass: views.length >= 2 && views.every(view => view.trackingCategory === 'limited'),
          detail: show(views.map(v => v.trackingCategory)),
        }
      })
      await t.stays(
        'sign_up is neither sent nor stored',
        async () =>
          !t.sentEventNames().includes('sign_up') && !names(await t.events()).includes('sign_up'),
        {
          layer: 'network',
        },
      )
      t.check('Nothing is sent to Google', t.gtagEvents().length === 0, { layer: 'google' })
    },
  },
  {
    id: 'change-mind',
    title: 'Changing your mind',
    summary: 'Accept, then withdraw from "Cookie settings": two records with the same consent ID.',
    tags: ['Germany', 'withdrawal'],
    async run(t) {
      await t.step('A visitor from Germany accepts')
      await t.region('DE', 'EU')
      await t.visit('/site/')
      await t.clickBanner('Accept all')
      await t.eventually('A "granted" record is stored', async () =>
        (await t.consents()).some(record => record.decision === 'granted'),
      )

      await t.step('Later, "Cookie settings" → "Reject non-essential"')
      await t.click('#manage-cookies')
      t.check('"Cookie settings" reopens the banner', t.bannerVisible())
      await t.clickBanner('Reject non-essential')
      await t.eventually('A "denied" record follows the "granted" one', async () => {
        const decisions = (await t.consents()).map(record => record.decision)
        return { pass: show(decisions) === show(['granted', 'denied']), detail: show(decisions) }
      })
      const [granted, denied] = await t.consents()
      t.check(
        'Both records carry the same consent ID (one visitor, two decisions)',
        !!granted && granted.consentId === denied?.consentId,
        {
          layer: 'collector',
          detail: granted?.consentId,
        },
      )
      t.check('Records are append-only: the first is unchanged', granted?.decision === 'granted', {
        layer: 'collector',
      })
      t.check(
        'Google consent is withdrawn',
        t.gtag.filter(call => call[1] === 'update').at(-1)?.[2]?.ad_storage === 'denied',
        {
          layer: 'google',
        },
      )

      await t.step('The visitor keeps browsing')
      await t.navigate('/site/pricing')
      await t.eventually('New page views are limited again', async () => {
        const views = byName(await t.events(), 'page_view')
        const last = views.at(-1)
        return {
          pass:
            views.length >= 2 &&
            last?.props.path === '/site/pricing' &&
            last.trackingCategory === 'limited',
          detail: show(last && [last.props.path, last.trackingCategory]),
        }
      })
    },
  },
  {
    id: 'us-visitor',
    title: 'US visitor',
    summary: 'No banner where consent is not required: full tracking, attribution, clean URL.',
    tags: ['United States', 'full'],
    async run(t) {
      await t.step(
        'A visitor from the United States clicks an ad',
        '/site/pricing?utm_source=google&utm_medium=cpc&gclid=US-1',
      )
      await t.region('US', 'NA')
      await t.visit('/site/pricing?utm_source=google&utm_medium=cpc&gclid=US-1')
      t.check('No consent banner', !t.bannerVisible())
      t.check('Consent is not required', t.consent()?.required === false, {
        detail: show(t.consent()),
      })
      await t.eventually('The page_view is full, with consentRequired: false', async () => {
        const [view] = byName(await t.events(), 'page_view')
        return {
          pass: view?.trackingCategory === 'full' && view.consentRequired === false,
          detail: show(view && [view.trackingCategory, view.consentRequired]),
        }
      })
      const [view] = byName(await t.events(), 'page_view')
      t.check(
        'Attribution is captured (gclid, utm_source)',
        view?.props.attribution?.gclid === 'US-1' && view.props.attribution.utm_source === 'google',
        {
          layer: 'collector',
          detail: show(view?.props.attribution),
        },
      )
      t.check('The address bar is cleaned', t.url() === `${ORIGIN}/site/pricing`, {
        detail: t.url(),
      })
    },
  },
  {
    id: 'gpc',
    title: 'Global Privacy Control',
    summary:
      'A US browser sends GPC: first-party analytics on, marketing off until explicitly allowed.',
    tags: ['United States', 'GPC', 'Google'],
    async run(t) {
      await t.step(
        'A US visitor whose browser sends Global Privacy Control',
        'navigator.globalPrivacyControl = true',
      )
      await t.region('US', 'NA')
      t.flag('gpc', true)
      await t.visit('/site/?gclid=G-ADS&utm_source=google')
      t.check('No consent banner', !t.bannerVisible())
      t.check('The library sees the GPC signal', t.consent()?.gpc === true, {
        detail: show(t.consent()),
      })

      await t.step('The visitor starts a free trial')
      await t.click('#ev-signup')
      t.flush()
      await t.eventually('sign_up is stored as a full first-party event', async () => {
        const [signUp] = (await storedNamed(t, 'sign_up')) ?? []
        return { pass: signUp?.trackingCategory === 'full', detail: show(signUp?.trackingCategory) }
      })
      t.check(
        'Google: analytics granted, advertising denied',
        t.gtag.some(
          call =>
            call[1] === 'update' &&
            call[2]?.analytics_storage === 'granted' &&
            call[2]?.ad_storage === 'denied',
        ),
        {
          layer: 'google',
        },
      )
      t.check('No Google Ads conversion', !t.gtag.some(call => call[1] === 'conversion'), {
        layer: 'google',
      })

      await t.step('"Cookie settings" → "Accept all" (an explicit choice overrides GPC)')
      await t.click('#manage-cookies')
      await t.clickBanner('Accept all')
      await t.click('#ev-signup')
      await t.eventually(
        'Now the Ads conversion is sent',
        () => t.gtag.some(call => call[1] === 'conversion'),
        { layer: 'google' },
      )
      t.flag('gpc', false)
    },
  },
  {
    id: 'unknown-region',
    title: 'Unknown region',
    summary:
      'When the collector cannot tell where a visitor is, consent is required (fail closed).',
    tags: ['unknown', 'limited'],
    async run(t) {
      await t.step('A visitor whose region nobody knows')
      await t.region(null)
      await t.visit('/site/')
      const context = t.requestsTo('context').at(-1)
      t.check(
        'The collector answers consentRequired: true, reason "unknown-region"',
        context?.response?.policy?.consentRequired === true &&
          context.response.policy.reason === 'unknown-region',
        {
          layer: 'network',
          detail: show(context?.response?.policy),
        },
      )
      t.check('The consent banner is shown', t.bannerVisible())
      await t.eventually('The page_view is limited', async () => {
        const [view] = byName(await t.events(), 'page_view')
        return { pass: view?.trackingCategory === 'limited', detail: show(view?.trackingCategory) }
      })
    },
  },
  {
    id: 'secrets',
    title: 'Secrets in the landing URL',
    summary: 'A password-reset link: the token, email and fragment never leave the browser.',
    tags: ['United States', 'privacy'],
    async run(t) {
      await t.step(
        'A visitor opens a password-reset link',
        '/site/reset-password?token=…&email=…#access_token=…',
      )
      await t.region('US', 'NA')
      await t.visit(
        '/site/reset-password?token=SECRET-RESET-TOKEN&email=jane%40example.com#access_token=SECRET-FRAGMENT',
      )
      await t.eventually('The page_view URL is the bare page', async () => {
        const [view] = byName(await t.events(), 'page_view')
        return {
          pass: view?.props.url === `${ORIGIN}/site/reset-password`,
          detail: view?.props.url,
        }
      })

      await t.step('The visitor moves on to the docs')
      await t.navigate('/site/docs')
      await t.eventually(
        'The page_exit describes the reset page, without the secrets',
        async () => {
          const [exit] = byName(await t.events(), 'page_exit')
          return {
            pass: exit?.props.path === '/site/reset-password',
            detail: show(exit?.props.path),
          }
        },
      )
      const everything = show({
        sent: t.sent.map(request => request.body),
        stored: await t.events(),
        google: t.gtag,
      })
      for (const secret of ['SECRET-RESET-TOKEN', 'jane', 'SECRET-FRAGMENT']) {
        t.check(
          `"${secret}" appears in no request, stored event or Google call`,
          !everything.includes(secret),
          { layer: 'network' },
        )
      }
    },
  },
  {
    id: 'navigation',
    title: 'Single-page navigation',
    summary: 'One page_view per route; each page_exit describes the page that was left.',
    tags: ['United States', 'SPA'],
    async run(t) {
      await t.step('A US visitor lands on the home page')
      await t.region('US', 'NA')
      await t.visit('/site/')
      await t.step('…then opens Pricing and Docs without reloading')
      await t.navigate('/site/pricing')
      await t.navigate('/site/docs')
      await t.eventually('Three page_views: home, pricing, docs', async () => {
        const paths = byName(await t.events(), 'page_view').map(view => view.props.path)
        return {
          pass: show(paths) === show(['/site/', '/site/pricing', '/site/docs']),
          detail: show(paths),
        }
      })
      await t.eventually('Two page_exits: home, pricing', async () => {
        const paths = byName(await t.events(), 'page_exit').map(exit => exit.props.path)
        return { pass: show(paths) === show(['/site/', '/site/pricing']), detail: show(paths) }
      })
    },
  },
  {
    id: 'leave',
    title: 'Leaving the page',
    summary: 'Closing the tab sends what is queued with sendBeacon, with the Origin header.',
    tags: ['United States', 'beacon'],
    async run(t) {
      await t.step('A US visitor reads the pricing page')
      await t.region('US', 'NA')
      await t.visit('/site/pricing')
      await t.eventually('The page_view is stored', () => storedNamed(t, 'page_view'))
      await t.step('The visitor leaves (the page is unloaded)')
      await t.leave()
      t.check(
        'The browser queued a beacon to /v1/events',
        t.requestsTo('events').some(request => request.transport === 'beacon'),
        {
          layer: 'network',
          detail: show(t.requestsTo('events').map(request => request.transport)),
        },
      )
      await t.eventually('A page_exit for /site/pricing is stored', async () => {
        const [exit] = byName(await t.events(), 'page_exit')
        return { pass: exit?.props.path === '/site/pricing', detail: show(exit?.props.path) }
      })
      const [exit] = byName(await t.events(), 'page_exit')
      t.check(
        "The beacon carried the site's Origin (the collector checked it)",
        exit?.origin === ORIGIN,
        {
          layer: 'collector',
          detail: exit?.origin,
        },
      )
    },
  },
  {
    id: 'new-policy',
    title: 'A new policy version',
    summary: 'Publishing a new policyVersion asks visitors who already decided again.',
    tags: ['Germany', 'policy'],
    async run(t) {
      await t.step('A visitor from Germany accepts')
      await t.region('DE', 'EU')
      await t.visit('/site/')
      await t.clickBanner('Accept all')
      await t.reload()
      t.check('On the next visit, no banner: the decision is remembered', !t.bannerVisible())

      await t.step('The site publishes a new consent policy (policyVersion 2)')
      await t.policy({ policyVersion: '2' })
      sessionStorage.removeItem('ci_geo_context') // the cached context would otherwise be reused this session
      await t.reload()
      t.check('The banner asks again', t.bannerVisible())
      t.check('The visitor counts as undecided for version 2', t.consent()?.granted === null, {
        detail: show(t.consent()),
      })

      await t.step('The visitor accepts again')
      await t.clickBanner('Accept all')
      await t.eventually('The new record is for policyVersion 2', async () => {
        const versions = (await t.consents()).map(record => record.policyVersion)
        return { pass: show(versions) === show(['1', '2']), detail: show(versions) }
      })
    },
  },
  {
    id: 'categories',
    title: 'Choices per category',
    summary: 'Customize → statistics only: a partial record; analytics on, advertising off.',
    tags: ['Germany', 'categories', 'Google'],
    async run(t) {
      await t.step(
        'The site offers choices per category; a visitor from Germany arrives from an ad',
      )
      await t.region('DE', 'EU')
      t.flag('categories', true)
      await t.visit('/site/pricing?gclid=ADS-1&utm_source=google')

      await t.step('"Customize" → tick Statistics → "Save choices"')
      await t.clickBanner('Customize')
      const boxes = [...t.banner().querySelectorAll('input[type="checkbox"]')]
      t.check(
        'No category is pre-ticked',
        boxes.filter(box => !box.disabled).every(box => !box.checked),
        {
          detail: show(boxes.map(box => box.checked)),
        },
      )
      await t.tick('Statistics')
      await t.clickBanner('Save choices')
      await t.eventually('A "partial" record with statistics only', async () => {
        const [record] = await t.consents()
        return {
          pass:
            record?.decision === 'partial' &&
            show(record.categories) ===
              show({ preferences: false, statistics: true, marketing: false }),
          detail: show(record && { decision: record.decision, categories: record.categories }),
        }
      })

      await t.step('The visitor starts a free trial')
      await t.click('#ev-signup')
      t.flush()
      await t.eventually('sign_up is a full event (statistics allowed)', async () => {
        const [signUp] = (await storedNamed(t, 'sign_up')) ?? []
        return { pass: signUp?.trackingCategory === 'full', detail: show(signUp?.trackingCategory) }
      })
      t.check(
        'Google: analytics granted, every advertising signal denied',
        t.gtag.some(
          call =>
            call[1] === 'update' &&
            show(call[2]) ===
              show({
                analytics_storage: 'granted',
                ad_storage: 'denied',
                ad_user_data: 'denied',
                ad_personalization: 'denied',
              }),
        ),
        {
          layer: 'google',
        },
      )
      t.check(
        'No Google Ads conversion (it needs marketing)',
        !t.gtag.some(call => call[1] === 'conversion'),
        { layer: 'google' },
      )
      t.flag('categories', false)
    },
  },
  {
    id: 'nothing-without-consent',
    title: 'Nothing without consent',
    summary:
      "The collector's policy for the region allows no tracking at all until the visitor accepts.",
    tags: ['Germany', 'policy'],
    async run(t) {
      await t.step(
        'The collector allows no tracking without consent',
        'trackingWithoutConsent: "none"',
      )
      await t.policy({ trackingWithoutConsent: 'none' })
      await t.region('DE', 'EU')
      await t.visit('/site/')
      t.check('The banner is shown', t.bannerVisible())

      await t.step('The visitor reports a problem (an essential event) before deciding')
      await t.click('#ev-error')
      t.flush()
      await t.stays(
        'No event request leaves the browser',
        () => t.requestsTo('events').length === 0,
        {
          layer: 'network',
          detail: show(t.sentEventNames()),
        },
      )
      await t.stays('Nothing is stored', async () => (await t.events()).length === 0, { wait: 100 })

      await t.step('The visitor accepts and starts a free trial')
      await t.clickBanner('Accept all')
      await t.click('#ev-signup')
      t.flush()
      await t.eventually('sign_up is stored', () => storedNamed(t, 'sign_up'))
    },
  },
  {
    id: 'event-names',
    title: 'Custom event names',
    summary: '"Newsletter Signup" becomes newsletter_signup, as the contract requires.',
    tags: ['United States'],
    async run(t) {
      await t.step('A US visitor subscribes to the newsletter', 'trackEvent("Newsletter Signup")')
      await t.region('US', 'NA')
      await t.visit('/site/')
      await t.click('#ev-custom')
      t.flush()
      await t.eventually('Stored as newsletter_signup', () => storedNamed(t, 'newsletter_signup'))
      t.check(
        'The name sent was already normalized',
        t.sentEventNames().includes('newsletter_signup'),
        {
          layer: 'network',
          detail: show(t.sentEventNames()),
        },
      )
    },
  },
  {
    id: 'collector-contract',
    title: 'Collector contract',
    summary: 'Requests built by hand: idempotency, per-event validation, size and type limits.',
    tags: ['collector'],
    async run(t) {
      const now = new Date().toISOString()
      const event = (eventId, name = 'page_view') => ({
        eventId,
        name,
        occurredAt: now,
        sessionId: 'sess0000000000000000000001',
        pageViewId: 'pv000000000000000000000001',
        trackingCategory: 'full',
        consent: { required: false, granted: false },
        props: { url: `${ORIGIN}/site/`, path: '/site/' },
      })
      const batch = events => ({ v: 1, siteKey: t.siteKey, sentAt: now, events })
      const post = (path, body, type = 'text/plain;charset=UTF-8') =>
        t.fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': type },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        })
      await t.region('US', 'NA')

      await t.step('Send a batch, then send it again (a retry)')
      const first = await (
        await post('/v1/events', batch([event('contract000000000000000001')]))
      ).json()
      const again = await (
        await post('/v1/events', batch([event('contract000000000000000001')]))
      ).json()
      t.check('The first is accepted', first.accepted === 1, {
        layer: 'collector',
        detail: show(first),
      })
      t.check(
        'The retry is a duplicate, not a second event',
        again.accepted === 0 && again.duplicates === 1,
        {
          layer: 'collector',
          detail: show(again),
        },
      )

      await t.step('A batch with one invalid event')
      const mixed = await post(
        '/v1/events',
        batch([
          event('contract000000000000000002'),
          event('contract000000000000000003', 'Not Valid!'),
        ]),
      )
      const mixedBody = await mixed.json()
      t.check(
        '202: the valid event is stored, the invalid one reported',
        mixed.status === 202 && mixedBody.accepted === 1 && mixedBody.rejected?.[0]?.index === 1,
        {
          layer: 'collector',
          detail: show(mixedBody),
        },
      )
      t.check(
        'The report points at the field',
        mixedBody.rejected?.[0]?.errors?.[0]?.path === '/name',
        { layer: 'collector' },
      )

      await t.step('Requests the collector refuses')
      const unknown = await post('/v1/events', {
        ...batch([event('contract000000000000000004')]),
        siteKey: 'no-such-site',
      })
      t.check('Unknown site key → 404', unknown.status === 404, {
        layer: 'collector',
        detail: String(unknown.status),
      })
      const large = await post(
        '/v1/events',
        batch([{ ...event('contract000000000000000005'), props: { pad: 'x'.repeat(70_000) } }]),
      )
      t.check('A body over 64 KiB → 413', large.status === 413, {
        layer: 'collector',
        detail: String(large.status),
      })
      const form = await post('/v1/events', 'a=b', 'application/x-www-form-urlencoded')
      t.check('A form post → 415', form.status === 415, {
        layer: 'collector',
        detail: String(form.status),
      })

      await t.step('A consent record, sent twice')
      const record = {
        v: 1,
        siteKey: t.siteKey,
        consentId: 'contractconsent000000001',
        decision: 'granted',
        policyVersion: '1',
        decidedAt: now,
        source: 'banner',
      }
      const one = await (await post('/v1/consent', record)).json()
      const two = await (await post('/v1/consent', record)).json()
      t.check(
        'Both answers carry the same recordId',
        !!one.recordId && one.recordId === two.recordId,
        { layer: 'collector', detail: show([one.recordId, two.recordId]) },
      )
      await t.eventually('One record is stored', async () => (await t.consents()).length === 1)
    },
  },
]
