// The frame shared by every playground page: the current page in the navigation, and a
// chip that says whether the collector answers.
import { collector } from './collector.js'
import { $, h } from './ui.js'

export function setupShell() {
  const here = location.pathname.replace(/\/$/u, '') || '/'
  for (const link of document.querySelectorAll('.site-nav a')) {
    const target = link.getAttribute('href').replace(/\/$/u, '') || '/'
    if (target === here) link.setAttribute('aria-current', 'page')
  }
  const chip = $('#collector-chip')
  if (!chip) return
  const check = async () => {
    const ok = await collector.health()
    chip.className = `chip ${ok ? 'ok' : 'danger'}`
    chip.replaceChildren(h('i'), ok ? 'Collector online' : 'Collector offline')
    chip.title = ok ? window.PLAYGROUND.apiBaseUrl : 'Start it with: npm run playground'
  }
  void check()
  setInterval(check, 10_000)
}
