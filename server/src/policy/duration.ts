// Retention durations in data policies: "30d", "12w", "25mo", "5y" (calendar months/years).

export interface Duration {
  amount: number
  unit: 'd' | 'w' | 'mo' | 'y'
}

const DURATION = /^(\d{1,4})(d|w|mo|y)$/

export function parseDuration(text: string): Duration {
  const match = DURATION.exec(text)
  if (!match) throw new Error(`"${text}" is not a duration like 30d, 12w, 25mo or 5y`)
  return { amount: Number(match[1]), unit: match[2] as Duration['unit'] }
}

/** `from` plus the duration, in UTC. Months and years are calendar units (clamped to month end). */
export function addDuration(from: Date, duration: Duration): Date {
  const date = new Date(from.getTime())
  switch (duration.unit) {
    case 'd':
      date.setUTCDate(date.getUTCDate() + duration.amount)
      return date
    case 'w':
      date.setUTCDate(date.getUTCDate() + 7 * duration.amount)
      return date
    case 'mo':
    case 'y': {
      const months = duration.unit === 'y' ? 12 * duration.amount : duration.amount
      const day = date.getUTCDate()
      date.setUTCDate(1)
      date.setUTCMonth(date.getUTCMonth() + months)
      const lastDay = new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
      ).getUTCDate()
      date.setUTCDate(Math.min(day, lastDay))
      return date
    }
  }
}
