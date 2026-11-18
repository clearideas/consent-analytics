// A visitor's browser: the demo website (/site/) in a frame with a small browser chrome.
// The frame is on the playground's own origin, so the page around it can drive the site
// (click, read storage) the way a visitor or a test would, and hears from the site's
// wiretap what it sent (postMessage).
import { h } from './ui.js'

/** Keys a visitor's browser keeps for the library and the playground's visitor settings. */
const VISITOR_FLAGS = ['playground_gpc', 'playground_categories']

export function createBrowserFrame(container, { compact = false, onMessage = () => {} } = {}) {
  const address = h('div.address', { title: 'Address bar' })
  const iframe = h('iframe', {
    title: 'Demo website',
    src: 'about:blank',
    dataset: { testid: 'site-frame' },
  })
  const back = h('button.icon-button', { type: 'button', title: 'Back', text: '←' })
  const reload = h('button.icon-button', { type: 'button', title: 'Reload', text: '↻' })
  const blank = h('div.browser-empty', { text: 'No page is open.' })
  const element = h(
    `div.browser${compact ? '.compact' : ''}`,
    {},
    h('div.browser-bar', {}, h('span.dots', {}, h('i'), h('i'), h('i')), back, reload, address),
    h('div.browser-view', {}, iframe, blank),
  )
  container.replaceChildren(element)

  const showAddress = href => {
    blank.hidden = !!href && href !== 'about:blank'
    if (!href || href === 'about:blank') {
      address.replaceChildren('about:blank')
      return
    }
    const url = new URL(href)
    address.replaceChildren(url.origin, h('b', { text: `${url.pathname}${url.search}${url.hash}` }))
  }
  showAddress('about:blank')

  let waitingForReady = []
  let waitingForUnload = []
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== iframe.contentWindow) return
    const message = event.data
    if (message?.source !== 'ca-site') return
    if (message.type === 'ready' || message.type === 'route') showAddress(message.href)
    if (message.type === 'ready') {
      const path = new URL(message.href).pathname
      waitingForReady = waitingForReady.filter(waiter => {
        if (waiter.path && waiter.path !== path) return true
        waiter.resolve(message)
        return false
      })
    }
    if (message.type === 'unload') {
      for (const resolve of waitingForUnload) resolve(message)
      waitingForUnload = []
    }
    onMessage(message)
  })

  // Resolves on the site's "ready" (the library knows the consent policy) for `path`: a
  // page that is being replaced can still report its own.
  const untilReady = (path, timeoutMs = 10_000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The demo website did not load')), timeoutMs)
      waitingForReady.push({
        path,
        resolve: message => {
          clearTimeout(timer)
          resolve(message)
        },
      })
    })

  const frame = {
    element,
    iframe,
    get window() {
      return iframe.contentWindow
    },
    get document() {
      return iframe.contentDocument
    },
    /** The library instance running in the site (undefined while loading). */
    get analytics() {
      return iframe.contentWindow?.playgroundAnalytics
    },
    get href() {
      return iframe.contentWindow?.location.href ?? 'about:blank'
    },
    /** Load a site URL and wait until the library knows the visitor's consent policy. */
    async load(path) {
      const url = new URL(path, location.origin)
      const ready = untilReady(url.pathname)
      blank.hidden = true
      iframe.src = url.href
      return ready
    },
    async reload() {
      const ready = untilReady(iframe.contentWindow.location.pathname)
      iframe.contentWindow.location.reload()
      return ready
    },
    /** Leave the site (its pagehide sends what is queued with sendBeacon). */
    async leave() {
      const wasSite = frame.href.includes('/site')
      const unloaded = new Promise(resolve => {
        waitingForUnload.push(resolve)
        setTimeout(resolve, 1500)
      })
      iframe.src = 'about:blank'
      if (wasSite) await unloaded
      showAddress('about:blank')
      blank.textContent = 'The visitor left the site.'
    },
    /** Forget the visitor: the library's storage, its cookies and the visitor settings. */
    clearVisitor({ keepFlags = false } = {}) {
      for (const storage of [localStorage, sessionStorage]) {
        for (const key of Object.keys(storage)) {
          if (key.startsWith('ci_') || (!keepFlags && VISITOR_FLAGS.includes(key))) {
            storage.removeItem(key)
          }
        }
      }
      for (const cookie of document.cookie.split(';')) {
        const name = cookie.split('=')[0].trim()
        if (name) document.cookie = `${name}=; Max-Age=0; Path=/`
      }
    },
    setFlag(name, on) {
      if (on) localStorage.setItem(`playground_${name}`, '1')
      else localStorage.removeItem(`playground_${name}`)
    },
    flag: name => localStorage.getItem(`playground_${name}`) === '1',
  }
  back.addEventListener('click', () => iframe.contentWindow?.history.back())
  reload.addEventListener('click', () => void frame.reload().catch(() => {}))
  return frame
}
