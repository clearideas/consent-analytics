// The playground website's routes (DEV_MODE): pages, the demo site, assets, and what it
// refuses to serve.
import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config.ts'
import { createPlaygroundApp } from '../src/playground.ts'

const app = createPlaygroundApp(loadConfig({ PORT: '8787', PLAYGROUND_PORT: '5173' }))
const get = (path: string) => app.request(path)

describe('playground routes', () => {
  it('serves the pages', async () => {
    const pages: Array<[string, string]> = [
      ['/', 'Explore Consent Analytics'],
      ['/live', 'Live playground'],
      ['/scenarios', 'Scenarios'],
      ['/analytics', 'Analytics'],
    ]
    for (const [path, marker] of pages) {
      const response = await get(path)
      expect(response.status, path).toBe(200)
      expect(response.headers.get('Content-Type')).toContain('text/html')
      expect(await response.text()).toContain(marker)
    }
  })

  it('serves the demo website for every /site path (a single-page app)', async () => {
    for (const path of ['/site', '/site/', '/site/pricing', '/site/reset-password']) {
      const response = await get(path)
      expect(response.status, path).toBe(200)
      expect(await response.text()).toContain('/assets/wiretap.js')
    }
  })

  it('serves assets with their types, and the collector address', async () => {
    expect((await get('/assets/playground.css')).headers.get('Content-Type')).toContain('text/css')
    expect((await get('/assets/lib/ui.js')).headers.get('Content-Type')).toContain('javascript')
    expect((await get('/assets/clearideas-logo.svg')).headers.get('Content-Type')).toBe(
      'image/svg+xml',
    )
    expect((await get('/assets/fonts/inter-roman-latin.woff2')).headers.get('Content-Type')).toBe(
      'font/woff2',
    )
    const config = await (await get('/playground-config.js')).text()
    expect(config).toContain('"apiBaseUrl":"http://localhost:8787/"')
    expect(config).toContain('"siteKey":"demo-site"')
  })

  it('answers 404 for unknown paths and never leaves its directories', async () => {
    const missing = await get('/nope')
    expect(missing.status).toBe(404)
    expect(await missing.text()).toContain('Not found')
    for (const path of [
      '/assets/../src/app.ts',
      '/assets/%2e%2e/%2e%2e/package.json',
      '/lib/../../package.json',
    ]) {
      const response = await get(path)
      expect(response.status, path).toBe(404)
    }
  })
})
