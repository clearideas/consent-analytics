// Small DOM helpers shared by the playground pages. No framework, no build step.
// Everything from the collector or the browser is rendered as text, never as HTML.

const setStyle = (element, style) => {
  for (const [property, value] of Object.entries(style)) {
    if (property.startsWith('--')) element.style.setProperty(property, value)
    else element.style[property] = value
  }
}

/** Create an element: h('div.card#id', { dataset, onclick, text, ... }, ...children). */
export const h = (selector, properties = {}, ...children) => {
  const [, tag = 'div', rest = ''] = /^([a-z0-9-]+)?(.*)$/iu.exec(selector)
  const element = document.createElement(tag || 'div')
  for (const token of rest.match(/[.#][^.#]+/gu) ?? []) {
    if (token[0] === '.') element.classList.add(token.slice(1))
    else element.id = token.slice(1)
  }
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (value == null || value === false) continue
    if (key === 'dataset') Object.assign(element.dataset, value)
    else if (key === 'style') setStyle(element, value)
    else if (key.startsWith('on')) element.addEventListener(key.slice(2), value)
    else if (key === 'text') element.textContent = value
    else if (key in element && key !== 'list') element[key] = value
    else element.setAttribute(key, value === true ? '' : value)
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue
    element.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return element
}

export const $ = (selector, root = document) => root.querySelector(selector)
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

/** An SVG element with attributes. */
export const svg = (tag, attributes = {}, ...children) => {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(attributes)) {
    if (value == null || value === false) continue
    if (key === 'text') element.textContent = value
    else if (key === 'style') setStyle(element, value)
    else element.setAttribute(key, String(value))
  }
  for (const child of children.flat()) if (child) element.append(child)
  return element
}

export const formatTime = value =>
  new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export const formatNumber = value =>
  value >= 10_000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value))

export const formatPercent = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '–')

export const formatMs = value =>
  value == null ? '–' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`

export const formatBytes = bytes =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`

/** Pretty-printed JSON with light syntax colouring (text nodes only). */
export const jsonView = value => {
  const pre = h('pre.json')
  const text = JSON.stringify(value, null, 2) ?? 'undefined'
  const token =
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/giu
  let last = 0
  for (const match of text.matchAll(token)) {
    if (match.index > last) pre.append(text.slice(last, match.index))
    const [whole, string, colon, keyword, number] = match
    if (string) {
      pre.append(h(`span.${colon ? 'k' : 's'}`, { text: string }))
      if (colon) pre.append(colon)
    } else if (keyword) pre.append(h('span.b', { text: keyword }))
    else if (number) pre.append(h('span.n', { text: number }))
    else pre.append(whole)
    last = match.index + whole.length
  }
  pre.append(text.slice(last))
  return pre
}

export const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/** Position of an element's edge or center relative to a container. */
export const anchor = (element, container, side = 'center') => {
  const box = element.getBoundingClientRect()
  const frame = container.getBoundingClientRect()
  const x = side === 'left' ? box.left : side === 'right' ? box.right : box.left + box.width / 2
  const y = side === 'top' ? box.top : side === 'bottom' ? box.bottom : box.top + box.height / 2
  return { x: x - frame.left, y: y - frame.top }
}

/**
 * Send a glowing packet along a curve between two points (CSS offset-path). Resolves when
 * the animation ends.
 */
export const sendPacket = (
  layer,
  from,
  to,
  { tone = 'blue', label, duration = 700, bend = 0 } = {},
) => {
  if (reducedMotion() || !layer.isConnected) return Promise.resolve()
  const packet = h(`div.packet.tone-${tone}`, {}, label ? h('span', { text: label }) : null)
  const midX = (from.x + to.x) / 2
  packet.style.offsetPath = `path("M ${from.x} ${from.y} C ${midX} ${from.y + bend}, ${midX} ${to.y - bend}, ${to.x} ${to.y}")`
  layer.append(packet)
  const animation = packet.animate(
    [
      { offsetDistance: '0%', opacity: 0, transform: 'scale(0.6)' },
      { offsetDistance: '12%', opacity: 1, transform: 'scale(1)' },
      { offsetDistance: '88%', opacity: 1, transform: 'scale(1)' },
      { offsetDistance: '100%', opacity: 0, transform: 'scale(0.7)' },
    ],
    { duration, easing: 'cubic-bezier(.45,.05,.35,1)', fill: 'forwards' },
  )
  return animation.finished.then(
    () => packet.remove(),
    () => packet.remove(),
  )
}

/** Briefly add a class to replay a CSS animation. */
export const flash = (element, className = 'pulse', duration = 800) => {
  if (!element) return
  element.classList.remove(className)
  void element.offsetWidth
  element.classList.add(className)
  setTimeout(() => element.classList.remove(className), duration)
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Tabs: buttons with data-tab="name" show the panel with data-panel="name". */
export const setupTabs = (root, onChange = () => {}) => {
  const buttons = $$('[data-tab]', root)
  const show = name => {
    for (const button of buttons)
      button.setAttribute('aria-selected', String(button.dataset.tab === name))
    for (const panel of $$('[data-panel]', root)) panel.hidden = panel.dataset.panel !== name
    onChange(name)
  }
  for (const button of buttons) button.addEventListener('click', () => show(button.dataset.tab))
  return { show }
}
