// Scenarios: run scripted visitor journeys one by one, or all, and show their steps, the
// data flow and every check.
import { subscribe } from './lib/collector.js'
import { createFlow } from './lib/flow.js'
import { createBrowserFrame } from './lib/frame.js'
import { createRunner } from './lib/runner.js'
import { SCENARIOS } from './lib/scenarios.js'
import { setupShell } from './lib/shell.js'
import { $, h } from './lib/ui.js'

setupShell()

const params = new URLSearchParams(location.search)
if (params.get('speed') === 'fast')
  document.querySelector('input[name="speed"][value="fast"]').checked = true
const speed = () => document.querySelector('input[name="speed"]:checked')?.value ?? 'normal'

const flow = createFlow($('#run-flow'))
let runner
const frame = createBrowserFrame($('#browser'), {
  compact: true,
  onMessage(message) {
    runner?.onSiteMessage(message)
    if (message.type === 'request') flow.sent(message.request)
    if (message.type === 'request-update') flow.answered(message.request)
  },
})
runner = createRunner({
  frame,
  speed,
  onDirect(message) {
    if (message.type === 'request') flow.sent(message.request)
    if (message.type === 'request-update') flow.answered(message.request)
  },
})

let collecting = false
subscribe(({ type, data }) => {
  if (!collecting) return
  if (type === 'event') flow.stored('event', data)
  if (type === 'consent') flow.stored('consent', data)
})

// --- Scenario list -----------------------------------------------------------------------
const results = new Map()
const items = new Map()
let selected = SCENARIOS[0].id
let running = false

function renderList() {
  $('#scenario-list').replaceChildren(
    ...SCENARIOS.map(scenario => {
      const result = results.get(scenario.id)
      const passed = result?.checks.filter(check => check.state === 'passed').length ?? 0
      const item = h(
        'button.scenario-item',
        {
          type: 'button',
          dataset: {
            state: result?.state ?? 'idle',
            testid: `scenario-${scenario.id}`,
          },
          'aria-current': String(scenario.id === selected),
          onclick: () => {
            if (running) return
            selected = scenario.id
            renderList()
            showSource(scenario)
            showResult(results.get(scenario.id))
          },
        },
        h('span.state-dot'),
        h(
          'span',
          {},
          h('strong', { text: scenario.title }),
          h('small', { text: scenario.summary }),
        ),
        h('span.tally', { text: result?.checks ? `${passed}/${result.checks.length}` : '' }),
      )
      items.set(scenario.id, item)
      return h('li', {}, item)
    }),
  )
}

function renderSummary() {
  const finished = [...results.values()].filter(
    result => result.state === 'passed' || result.state === 'failed',
  )
  const checks = finished.flatMap(result => result.checks)
  const failed = checks.filter(check => check.state === 'failed').length
  const stat = (label, value, tone) =>
    h(
      'div.stat',
      tone ? { dataset: { tone } } : {},
      h('dt', { text: label }),
      h('dd', { text: value }),
    )
  $('#summary').replaceChildren(
    stat('Scenarios', `${finished.length}/${SCENARIOS.length}`),
    stat(
      'Passed',
      String(finished.filter(result => result.state === 'passed').length),
      finished.length ? 'good' : undefined,
    ),
    stat('Checks', String(checks.length)),
    stat('Failed checks', String(failed), failed ? 'bad' : checks.length ? 'good' : undefined),
  )
}

function showSource(scenario) {
  $('#source').textContent =
    `{\n  id: '${scenario.id}',\n  title: ${JSON.stringify(scenario.title)},\n  ${scenario.run.toString()}\n}`
}

// --- One run -----------------------------------------------------------------------------
const stepsList = $('#steps')
const checksBody = $('#checks')
const stepElements = new Map()

function renderStep(step) {
  let element = stepElements.get(step.index)
  if (!element) {
    element = h('li.step-card')
    stepElements.set(step.index, element)
    stepsList.append(element)
  }
  element.dataset.state = step.state
  element.replaceChildren(
    h('span.num', { text: step.index }),
    h(
      'div',
      {},
      h('strong', { text: step.title }),
      step.detail ? h('small.mono', { text: step.detail }) : null,
    ),
  )
}

function renderCheck(check) {
  $('#checks-empty').hidden = true
  checksBody.append(
    h(
      'tr',
      { dataset: { state: check.state, testid: 'check' } },
      h('td', {}, check.label, check.detail ? h('span.detail', { text: check.detail }) : null),
      h(
        'td.layer',
        {},
        h('span.layer-tag', { dataset: { layer: check.layer }, text: check.layer }),
      ),
      h('td.result', { text: check.state === 'passed' ? '✓ Passed' : '✗ Failed' }),
    ),
  )
}

function clearRun(title) {
  stepsList.replaceChildren()
  checksBody.replaceChildren()
  stepElements.clear()
  $('#checks-empty').hidden = false
  $('#run-title').textContent = title
}

function showResult(result) {
  const scenario = SCENARIOS.find(entry => entry.id === selected)
  clearRun(scenario.title)
  $('#run-signal').dataset.state = result?.state ?? 'idle'
  $('#run-elapsed').textContent = result?.durationMs
    ? `${(result.durationMs / 1000).toFixed(1)}s`
    : '0.0s'
  if (!result) return
  for (const step of result.steps) renderStep(step)
  for (const check of result.checks) renderCheck(check)
}

let timer
async function runOne(scenario) {
  selected = scenario.id
  results.set(scenario.id, { state: 'running', checks: [] })
  renderList()
  showSource(scenario)
  clearRun(scenario.title)
  flow.reset()
  $('#run-signal').dataset.state = 'running'
  const started = performance.now()
  clearInterval(timer)
  timer = setInterval(() => {
    $('#run-elapsed').textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`
  }, 100)
  collecting = true
  const result = await runner.run(scenario, {
    onStep: renderStep,
    onCheck(check) {
      results.get(scenario.id).checks.push(check)
      renderCheck(check)
      renderList()
    },
  })
  collecting = false
  clearInterval(timer)
  $('#run-elapsed').textContent = `${(result.durationMs / 1000).toFixed(1)}s`
  const state = result.passed ? 'passed' : 'failed'
  results.set(scenario.id, { ...result, state })
  $('#run-signal').dataset.state = state
  renderList()
  renderSummary()
  return result
}

const runButton = $('#run-all')
const setRunning = on => {
  running = on
  runButton.dataset.state = on ? 'running' : 'idle'
  $('#run-all-label').textContent = on ? 'Running…' : 'Run all'
  runButton.disabled = on
  $('#run-one').disabled = on
}

async function runAll() {
  if (running) return
  setRunning(true)
  results.clear()
  renderList()
  renderSummary()
  const all = []
  for (const scenario of SCENARIOS) all.push(await runOne(scenario))
  setRunning(false)
  document.body.dataset.runComplete = all.every(result => result.passed) ? 'passed' : 'failed'
  return all
}

runButton.addEventListener('click', () => void runAll())

$('#run-one').addEventListener('click', () => {
  if (running) return
  setRunning(true)
  void runOne(SCENARIOS.find(entry => entry.id === selected)).finally(() => setRunning(false))
})

renderList()
renderSummary()
showSource(SCENARIOS[0])
showResult(undefined)

// For tests and links: /scenarios?run=all&speed=fast, or ?run=<scenario id>.
window.playgroundScenarios = {
  runAll,
  runOne: id => runOne(SCENARIOS.find(entry => entry.id === id)),
  results,
}
const auto = params.get('run')
if (auto === 'all') void runAll()
else if (auto) {
  const scenario = SCENARIOS.find(entry => entry.id === auto)
  if (scenario) {
    setRunning(true)
    void runOne(scenario)
      .then(result => (document.body.dataset.runComplete = result.passed ? 'passed' : 'failed'))
      .finally(() => setRunning(false))
  }
}
