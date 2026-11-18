// @vitest-environment happy-dom
// The playground's in-place DOM updates (playground/assets/lib/morph.js): charts and feeds
// are patched, not re-created, so nothing flashes and what the visitor opened stays open.
import { describe, expect, it } from 'vitest'

// @ts-expect-error: a plain JavaScript module of the playground
import { morphChildren } from '../playground/assets/lib/morph.js'

const html = (markup: string) => {
  const template = document.createElement('template')
  template.innerHTML = markup.trim()
  return [...template.content.childNodes]
}

describe('morphChildren', () => {
  it('updates text and attributes in place, keeping the elements', () => {
    const root = document.createElement('div')
    root.append(...html('<p class="a" title="x">one</p><svg><rect height="10"></rect></svg>'))
    const [paragraph, chart] = [...root.children]
    const bar = chart!.firstElementChild

    morphChildren(root, html('<p class="b">two</p><svg><rect height="30"></rect></svg>'))

    expect(root.innerHTML).toBe('<p class="b">two</p><svg><rect height="30"></rect></svg>')
    expect(root.children[0]).toBe(paragraph) // same element: no re-render, no flash
    expect(root.children[1]!.firstElementChild).toBe(bar)
  })

  it('matches keyed items, so a list can grow at the top', () => {
    const root = document.createElement('ol')
    root.append(...html('<li data-key="b">B</li><li data-key="a">A</li>'))
    const [b, a] = [...root.children]

    morphChildren(
      root,
      html('<li data-key="c">C</li><li data-key="b">B2</li><li data-key="a">A</li>'),
    )

    expect([...root.children].map(li => li.textContent)).toEqual(['C', 'B2', 'A'])
    expect(root.children[1]).toBe(b)
    expect(root.children[2]).toBe(a)
  })

  it('keeps what the visitor opened', () => {
    const root = document.createElement('ol')
    root.append(...html('<li data-key="a"><details><summary>A</summary>body</details></li>'))
    root.querySelector('details')!.open = true

    morphChildren(
      root,
      html(
        '<li data-key="b"><details><summary>B</summary></details></li><li data-key="a"><details><summary>A!</summary>body</details></li>',
      ),
    )

    expect(root.children[1]!.querySelector('details')!.open).toBe(true)
    expect(root.children[1]!.querySelector('summary')!.textContent).toBe('A!')
  })

  it('replaces what changed kind, and removes what is gone', () => {
    const root = document.createElement('div')
    root.append(...html('<div class="chart-empty">No data</div><span>x</span><i>y</i>'))

    morphChildren(root, html('<svg class="chart"></svg>'))

    expect(root.innerHTML).toBe('<svg class="chart"></svg>')
  })
})
