// Small SVG charts for the analytics page: stacked columns, horizontal bars, donuts and
// legends. Colours come from CSS variables, so every chart speaks the same language
// (full = green, limited = amber, granted/partial/denied, ...).
import { h, svg } from './ui.js'

export const COLORS = {
  full: 'var(--full)',
  limited: 'var(--limited)',
  granted: 'var(--granted)',
  partial: 'var(--partial)',
  denied: 'var(--denied)',
  consent: 'var(--consent)',
  blue: 'var(--blue)',
  cyan: 'var(--cyan)',
  violet: 'var(--violet)',
  pink: 'var(--pink)',
  dim: 'var(--dim)',
}
const PALETTE = [
  'var(--blue)',
  'var(--cyan)',
  'var(--violet)',
  'var(--green)',
  'var(--amber)',
  'var(--pink)',
  'var(--red)',
]
export const paletteColor = index => PALETTE[index % PALETTE.length]

export const empty = (text = 'No data yet.') => h('div.chart-empty', { text })

export const legend = items =>
  h(
    'div.legend',
    {},
    ...items.map(item => h('span.key', { style: { '--swatch': item.color }, text: item.label })),
  )

/** A round axis maximum with four whole-number steps (4, 8, 20, 40, 100, ...). */
const niceMax = value => {
  for (let power = 1; ; power *= 10) {
    for (const step of [1, 2, 2.5, 5]) {
      const size = step * power
      if (Number.isInteger(size) && size * 4 >= value) return size * 4
    }
  }
}

/*
 * Charts are redrawn as data arrives and patched into the page in place (morph.js). To let
 * the patch reuse elements, every element has a stable place: rows, columns and segments
 * carry data-key attributes, and empty segments are drawn with zero size instead of being
 * left out. Changes then glide (CSS transitions) instead of rebuilding the chart.
 */

/**
 * Stacked columns. columns: [{ label, segments: [{ key, value, color, title }] }].
 */
export function columns(data, { height = 220, labelEvery = 1, title } = {}) {
  const total = column => column.segments.reduce((sum, segment) => sum + segment.value, 0)
  const max = niceMax(Math.max(1, ...data.map(total)))
  const width = 640
  const left = 34
  const bottom = 24
  const top = 10
  const plotHeight = height - bottom - top
  const plotWidth = width - left - 6
  const slot = plotWidth / Math.max(1, data.length)
  const barWidth = Math.max(3, Math.min(34, slot * 0.7))
  const chart = svg('svg', {
    class: 'chart',
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': title ?? 'Chart',
  })
  const axis = svg('g', { 'data-key': 'axis' })
  for (let i = 0; i <= 4; i++) {
    const y = top + plotHeight - (plotHeight * i) / 4
    axis.append(
      svg('line', { class: 'grid', x1: left, x2: width, y1: y, y2: y }),
      svg('text', {
        class: 'axis',
        x: left - 6,
        y: y + 4,
        'text-anchor': 'end',
        text: String(Math.round((max * i) / 4)),
      }),
    )
  }
  chart.append(axis)
  data.forEach((column, index) => {
    const x = left + slot * index + (slot - barWidth) / 2
    let y = top + plotHeight
    const group = svg('g', { 'data-key': `column-${index}` })
    for (const segment of column.segments) {
      const barHeight = (plotHeight * segment.value) / max
      y -= barHeight
      group.append(
        svg(
          'rect',
          {
            'data-key': `segment-${segment.key}`,
            class: 'bar',
            x,
            y,
            width: barWidth,
            height: barHeight,
            rx: segment.value ? 2 : 0,
            fill: segment.color,
          },
          svg('title', {
            text: `${column.label}: ${segment.title ?? segment.key} ${segment.value}`,
          }),
        ),
      )
    }
    group.append(
      svg('text', {
        'data-key': 'label',
        class: 'axis',
        x: x + barWidth / 2,
        y: height - 6,
        'text-anchor': 'middle',
        text: index % labelEvery === 0 ? column.label : '',
      }),
    )
    chart.append(group)
  })
  return chart
}

/**
 * Horizontal bars with labels and values. rows: [{ label, value, color, segments?, note }].
 * With segments, each bar is stacked and `value` is their total.
 */
export function bars(rows, { format = value => String(value), max, emptyText } = {}) {
  if (!rows.length) return empty(emptyText)
  const top = max ?? Math.max(1, ...rows.map(row => row.value))
  const labelWidth = 150
  const width = 640
  const rowHeight = 28
  const valueWidth = 70
  const plot = width - labelWidth - valueWidth
  const chart = svg('svg', {
    class: 'chart',
    viewBox: `0 0 ${width} ${rows.length * rowHeight}`,
    role: 'img',
    'aria-label': rows.map(row => `${row.label} ${format(row.value)}`).join(', '),
    // Rows are placed by their transform: reordering them needs no DOM moves.
    'data-unordered': '',
  })
  rows.forEach((row, index) => {
    const label = row.label.length > 24 ? `${row.label.slice(0, 23)}…` : row.label
    // A row moves (when the order changes) by its transform, so it glides to its new place.
    const group = svg('g', {
      'data-key': `row-${row.label}`,
      class: 'row',
      style: { transform: `translateY(${index * rowHeight}px)` },
    })
    group.append(
      svg('text', { class: 'label', x: 0, y: 18, text: label }, svg('title', { text: row.label })),
      svg('rect', { class: 'track', x: labelWidth, y: 7, width: plot, height: 14, rx: 4 }),
    )
    let x = labelWidth
    const segments = row.segments ?? [
      { value: row.value, color: row.color ?? COLORS.blue, key: 'value' },
    ]
    for (const segment of segments) {
      const segmentWidth = (plot * segment.value) / top
      group.append(
        svg(
          'rect',
          {
            'data-key': `segment-${segment.key}`,
            class: 'hbar',
            x,
            y: 7,
            width: segmentWidth,
            height: 14,
            rx: segment.value ? 3 : 0,
            fill: segment.color,
          },
          svg('title', {
            text: `${row.label}: ${segment.title ?? segment.key} ${format(segment.value)}`,
          }),
        ),
      )
      x += segmentWidth
    }
    group.append(
      svg('text', {
        class: 'value',
        x: width,
        y: 18,
        'text-anchor': 'end',
        text: row.note ?? format(row.value),
      }),
    )
    chart.append(group)
  })
  return chart
}

/** A donut with a figure in the middle. slices: [{ label, value, color }]. */
export function donut(slices, { center, caption, size = 180 } = {}) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  if (!total) return empty()
  const radius = 70
  const stroke = 22
  const circumference = 2 * Math.PI * radius
  const chart = svg('svg', {
    class: 'chart',
    viewBox: '0 0 200 200',
    width: size,
    height: size,
    role: 'img',
    'aria-label': slices.map(slice => `${slice.label} ${slice.value}`).join(', '),
  })
  chart.append(
    svg('circle', {
      cx: 100,
      cy: 100,
      r: radius,
      fill: 'none',
      stroke: 'rgba(148,163,184,0.1)',
      'stroke-width': stroke,
    }),
  )
  let offset = 0
  for (const slice of slices) {
    const length = (circumference * slice.value) / total
    chart.append(
      svg(
        'circle',
        {
          'data-key': `slice-${slice.label}`,
          class: 'arc',
          cx: 100,
          cy: 100,
          r: radius,
          fill: 'none',
          stroke: slice.color,
          'stroke-width': stroke,
          'stroke-dasharray': `${Math.max(0, length - 1.5)} ${circumference}`,
          'stroke-dashoffset': -offset,
          transform: 'rotate(-90 100 100)',
        },
        svg('title', { text: `${slice.label}: ${slice.value}` }),
      ),
    )
    offset += length
  }
  if (center !== undefined) {
    chart.append(
      svg('text', { class: 'center-value', x: 100, y: 104, 'text-anchor': 'middle', text: center }),
    )
  }
  if (caption)
    chart.append(
      svg('text', {
        class: 'center-label',
        x: 100,
        y: 126,
        'text-anchor': 'middle',
        text: caption,
      }),
    )
  return chart
}

/** A chart card: title, optional note, the chart, and an optional legend. */
export function panel({ title, note, span = 6, body, legendItems, testid }) {
  return h(
    `section.card.span-${span}`,
    { dataset: testid ? { testid, key: testid } : {} },
    h('header', {}, h('h3', { text: title }), note ? h('small', { text: note }) : null),
    h(
      'div.card-body',
      {},
      ...(Array.isArray(body) ? body : [body]),
      legendItems ? legend(legendItems) : null,
    ),
  )
}
