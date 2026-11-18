// Update a part of the page in place: patch the existing elements to match freshly built
// ones, instead of replacing them. Charts then change smoothly as data arrives (nothing is
// re-created, so entrance animations don't replay), and what the visitor opened or
// selected (a <details>, a scroll position) stays as it is.
//
// Children with a data-key are matched by key (lists that grow at the top); others by
// position. In a container marked data-unordered (e.g. an SVG chart whose rows are placed
// by their transform), matched children are never moved: moving an element restarts its
// CSS animations and skips its transitions. Event handlers are not copied: reused elements keep their own, so pages
// attach handlers to stable containers (event delegation) rather than to items.

/** Attributes that hold the visitor's state rather than the data. */
const USER_STATE = new Set(['open'])

function patchAttributes(from, to) {
  for (const { name } of [...from.attributes]) {
    if (!to.hasAttribute(name) && !USER_STATE.has(name)) from.removeAttribute(name)
  }
  for (const { name, value } of [...to.attributes]) {
    if (USER_STATE.has(name)) continue
    if (from.getAttribute(name) !== value) from.setAttribute(name, value)
  }
}

const keyOf = node => (node.nodeType === Node.ELEMENT_NODE ? node.getAttribute('data-key') : null)

const sameKind = (a, b) =>
  a.nodeType === b.nodeType && a.nodeName === b.nodeName && keyOf(a) === keyOf(b)

/** Make `from` look like `to`; returns the node that is now in the document. */
export function morph(from, to) {
  if (!sameKind(from, to)) {
    from.replaceWith(to)
    return to
  }
  if (from.nodeType === Node.TEXT_NODE) {
    if (from.data !== to.data) from.data = to.data
    return from
  }
  if (from.nodeType === Node.ELEMENT_NODE) {
    patchAttributes(from, to)
    morphChildren(from, [...to.childNodes])
  }
  return from
}

/** Make `parent`'s children look like `next` (an array of nodes, not yet in the document). */
export function morphChildren(parent, next) {
  const unordered = parent.nodeType === Node.ELEMENT_NODE && parent.hasAttribute('data-unordered')
  const old = [...parent.childNodes]
  const keyed = new Map()
  const unkeyed = []
  for (const node of old) {
    const key = keyOf(node)
    if (key !== null) keyed.set(key, node)
    else unkeyed.push(node)
  }
  const used = new Set()
  let cursor = 0
  next.forEach((node, index) => {
    const key = keyOf(node)
    let candidate = key !== null ? keyed.get(key) : unkeyed[cursor]
    if (key === null && candidate) cursor += 1
    let result
    if (candidate && sameKind(candidate, node)) {
      used.add(candidate)
      result = morph(candidate, node)
    } else result = node
    if (unordered) {
      if (result.parentNode !== parent) parent.append(result)
      return
    }
    const at = parent.childNodes[index]
    if (at !== result) parent.insertBefore(result, at ?? null)
  })
  for (const node of old) {
    if (!used.has(node) && node.parentNode === parent && !next.includes(node)) node.remove()
  }
  // Anything left beyond the new children (e.g. replaced candidates) goes too.
  while (parent.childNodes.length > next.length) parent.lastChild.remove()
}
