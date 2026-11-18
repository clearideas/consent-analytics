// The demo website's wiretap: records every request the library makes to the collector
// (fetch and sendBeacon), with its body and answer, before the library loads. The
// playground pages around the site read it through postMessage; window.playgroundWire
// keeps the same list for tests and the console.
//
// This is a development tool for the playground only: a real website needs nothing like it.
;(() => {
  const collectorOrigin = new URL(window.PLAYGROUND.apiBaseUrl).origin
  const requests = []
  let sequence = 0
  const framed = window.parent !== window

  const post = message => {
    if (!framed) return
    try {
      window.parent.postMessage({ source: 'ca-site', ...message }, location.origin)
    } catch {
      // The parent is gone (the frame is being replaced).
    }
  }
  const parse = body => {
    if (typeof body !== 'string') return body ?? null
    try {
      return JSON.parse(body)
    } catch {
      return body
    }
  }
  const describe = url => {
    const parsed = new URL(url, location.href)
    return {
      url: parsed.href,
      path: `${parsed.pathname}${parsed.search}`,
      collector: parsed.origin === collectorOrigin,
    }
  }
  const record = entry => {
    requests.push(entry)
    post({ type: 'request', request: { ...entry } })
  }
  const update = entry => post({ type: 'request-update', request: { ...entry } })

  // Beacon bodies are Blobs, which can only be read asynchronously, and a beacon is often
  // the last thing a page does. Remember the text of Blobs made from strings instead.
  const blobText = new WeakMap()
  const NativeBlob = window.Blob
  window.Blob = class extends NativeBlob {
    constructor(parts = [], options) {
      super(parts, options)
      if (parts.every(part => typeof part === 'string')) blobText.set(this, parts.join(''))
    }
  }

  const nativeFetch = window.fetch.bind(window)
  window.fetch = async (input, init = {}) => {
    const target = describe(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (!target.collector) return nativeFetch(input, init)
    const entry = {
      id: ++sequence,
      transport: 'fetch',
      method: (init.method ?? 'GET').toUpperCase(),
      ...target,
      credentials: init.credentials ?? 'same-origin',
      at: Date.now(),
      body: parse(init.body),
      status: 'pending',
    }
    record(entry)
    try {
      const response = await nativeFetch(input, init)
      entry.status = response.status
      entry.durationMs = Date.now() - entry.at
      try {
        entry.response = await response.clone().json()
      } catch {
        entry.response = null
      }
      update(entry)
      return response
    } catch (error) {
      entry.status = 'failed'
      entry.error = String(error?.message ?? error)
      update(entry)
      throw error
    }
  }

  if (typeof navigator.sendBeacon === 'function') {
    const nativeBeacon = navigator.sendBeacon.bind(navigator)
    navigator.sendBeacon = (url, data) => {
      const target = describe(url)
      const queued = nativeBeacon(url, data)
      if (target.collector) {
        record({
          id: ++sequence,
          transport: 'beacon',
          method: 'POST',
          ...target,
          credentials: 'include',
          at: Date.now(),
          body: parse(typeof data === 'string' ? data : (blobText.get(data) ?? null)),
          // A beacon has no answer the page can read: the browser only says it queued it.
          status: queued ? 'queued' : 'refused',
        })
      }
      return queued
    }
  }

  window.playgroundWire = { requests, post }
})()
