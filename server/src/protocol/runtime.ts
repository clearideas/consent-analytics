// Runtime helpers for the validators generated from the spec (src/protocol/generated).
// Ajv's standalone output needs a few helpers at runtime. They are copied here, adapted to
// TypeScript, so that the published package has no dependencies.
//
// ucs2length: from ajv (lib/runtime/ucs2length.ts), MIT, Copyright (c) 2015-2021 Evgeny Poberezkin.
// date-time format: from ajv-formats (src/formats.ts), MIT, Copyright (c) 2020
// Evgeny Poberezkin. Full license texts: THIRD_PARTY_NOTICES.md.
// Equivalence with the originals is tested (test/generated.test.ts).

/** String length in Unicode code points (JSON Schema maxLength/minLength semantics). */
export function ucs2length(str: string): number {
  const len = str.length
  let length = 0
  let pos = 0
  let value: number
  while (pos < len) {
    length++
    value = str.charCodeAt(pos++)
    if (value >= 0xd800 && value <= 0xdbff && pos < len) {
      // high surrogate, and there is a next character
      value = str.charCodeAt(pos)
      if ((value & 0xfc00) === 0xdc00) pos++ // low surrogate
    }
  }
  return length
}

function isLeapYear(year: number): boolean {
  // https://tools.ietf.org/html/rfc3339#appendix-C
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

const DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/
const DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function date(str: string): boolean {
  // full-date from http://tools.ietf.org/html/rfc3339#section-5.6
  const matches = DATE.exec(str)
  if (!matches) return false
  const year = +matches[1]!
  const month = +matches[2]!
  const day = +matches[3]!
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (month === 2 && isLeapYear(year) ? 29 : DAYS[month]!)
  )
}

const TIME = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i

function time(str: string): boolean {
  const matches = TIME.exec(str)
  if (!matches) return false
  const hr = +matches[1]!
  const min = +matches[2]!
  const sec = +matches[3]!
  const tz = matches[4]
  const tzSign = matches[5] === '-' ? -1 : 1
  const tzH = +(matches[6] || 0)
  const tzM = +(matches[7] || 0)
  // date-time requires a time zone (strictTimeZone)
  if (tzH > 23 || tzM > 59 || !tz) return false
  if (hr <= 23 && min <= 59 && sec < 60) return true
  // leap second
  const utcMin = min - tzM * tzSign
  const utcHr = hr - tzH * tzSign - (utcMin < 0 ? 1 : 0)
  return (utcHr === 23 || utcHr === -1) && (utcMin === 59 || utcMin === -1) && sec < 61
}

const DATE_TIME_SEPARATOR = /t|\s/i

function dateTime(str: string): boolean {
  // http://tools.ietf.org/html/rfc3339#section-5.6
  const parts = str.split(DATE_TIME_SEPARATOR)
  return parts.length === 2 && date(parts[0]!) && time(parts[1]!)
}

function compareDateTime(dt1: string, dt2: string): number | undefined {
  if (!(dt1 && dt2)) return undefined
  const d1 = new Date(dt1).valueOf()
  const d2 = new Date(dt2).valueOf()
  if (!(d1 && d2)) return undefined
  return d1 - d2
}

/** Formats used by the spec, in the shape Ajv's generated code expects. */
export const formats: Record<string, unknown> = {
  'date-time': { validate: dateTime, compare: compareDateTime },
}
