import type { Precision } from '../types'

/**
 * The whole app's time axis is one linear map: day number -> pixels.
 *
 * A "day number" is days since the Unix epoch, computed in UTC from an ISO
 * date-only string. All arithmetic is integer days in UTC, so DST and
 * timezones can never shift anything.
 */

const MS_PER_DAY = 86_400_000

export const WORLD_START_ISO = '1990-01-01'
export const WORLD_END_ISO = '2100-01-01'

const pad = (n: number) => (n < 10 ? '0' + n : String(n))

export function isoToDay(iso: string): number {
  const y = +iso.slice(0, 4)
  const m = +iso.slice(5, 7)
  const d = +iso.slice(8, 10)
  return Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY)
}

export function dayToIso(day: number): string {
  const dt = new Date(day * MS_PER_DAY)
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

/** A UTC Date positioned at midnight of the given day number. */
export function dayToDate(day: number): Date {
  return new Date(day * MS_PER_DAY)
}

export const WORLD_START_DAY = isoToDay(WORLD_START_ISO)
export const WORLD_END_DAY = isoToDay(WORLD_END_ISO)
export const WORLD_DAYS = WORLD_END_DAY - WORLD_START_DAY

export function todayDay(): number {
  const now = new Date()
  return Math.floor(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY,
  )
}

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

export const MIN_PPD = 0.05 // ~18px per year: a full 110-year life on one screen
export const MAX_PPD = 90 // ~90px per day

export const clampPpd = (ppd: number) => Math.min(MAX_PPD, Math.max(MIN_PPD, ppd))

export const dayToX = (day: number, ppd: number) => (day - WORLD_START_DAY) * ppd
export const xToDay = (x: number, ppd: number) => WORLD_START_DAY + x / ppd
/**
 * Where a milestone's marker belongs, horizontally.
 *
 * `dayToX` gives the *start* of a day, which is the correct left edge for a bar
 * but the wrong place for a point in time: it sits the diamond on the boundary
 * between that day and the one before, so it reads as belonging to neither.
 * A milestone on a day sits in the middle of that day.
 */
export const milestoneCentreX = (day: number, ppd: number) => dayToX(day, ppd) + ppd / 2
export const totalWidth = (ppd: number) => WORLD_DAYS * ppd

// ---------------------------------------------------------------------------
// Header tiers
// ---------------------------------------------------------------------------

export type Unit = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'decade'

export interface Tier {
  major: Unit
  minor: Unit
  /** Unit that drag/resize snaps to at this zoom. */
  snap: Unit
}

/**
 * Zoom is a continuous float; which header tiers to draw is derived from it.
 * The thresholds are chosen so the minor tier's cells stay roughly 30-200px.
 */
export function tierFor(ppd: number): Tier {
  if (ppd >= 22) return { major: 'month', minor: 'day', snap: 'day' }
  if (ppd >= 5) return { major: 'month', minor: 'week', snap: 'day' }
  if (ppd >= 1.1) return { major: 'year', minor: 'month', snap: 'week' }
  if (ppd >= 0.32) return { major: 'year', minor: 'quarter', snap: 'month' }
  if (ppd >= 0.075) return { major: 'decade', minor: 'year', snap: 'month' }
  return { major: 'decade', minor: 'year', snap: 'year' }
}

/** Named zoom presets, mirroring Notion's picker but on the same continuum. */
export const ZOOM_PRESETS: { label: string; ppd: number }[] = [
  { label: 'Day', ppd: 46 },
  { label: 'Week', ppd: 14 },
  { label: 'Month', ppd: 4.2 },
  { label: 'Quarter', ppd: 1.6 },
  { label: 'Year', ppd: 0.5 },
  { label: 'Decade', ppd: 0.11 },
]

// ---------------------------------------------------------------------------
// Unit arithmetic
// ---------------------------------------------------------------------------

export function floorToUnit(day: number, unit: Unit): number {
  const dt = dayToDate(day)
  const y = dt.getUTCFullYear()
  const m = dt.getUTCMonth()
  switch (unit) {
    case 'day':
      return day
    case 'week': {
      // ISO weeks start Monday. getUTCDay(): 0=Sun.
      const dow = (dt.getUTCDay() + 6) % 7
      return day - dow
    }
    case 'month':
      return Math.floor(Date.UTC(y, m, 1) / MS_PER_DAY)
    case 'quarter':
      return Math.floor(Date.UTC(y, Math.floor(m / 3) * 3, 1) / MS_PER_DAY)
    case 'year':
      return Math.floor(Date.UTC(y, 0, 1) / MS_PER_DAY)
    case 'decade':
      return Math.floor(Date.UTC(Math.floor(y / 10) * 10, 0, 1) / MS_PER_DAY)
  }
}

export function addUnits(day: number, unit: Unit, n: number): number {
  if (unit === 'day') return day + n
  if (unit === 'week') return day + n * 7
  const dt = dayToDate(day)
  const y = dt.getUTCFullYear()
  const m = dt.getUTCMonth()
  const d = dt.getUTCDate()
  switch (unit) {
    case 'month':
      return Math.floor(Date.UTC(y, m + n, d) / MS_PER_DAY)
    case 'quarter':
      return Math.floor(Date.UTC(y, m + n * 3, d) / MS_PER_DAY)
    case 'year':
      return Math.floor(Date.UTC(y + n, m, d) / MS_PER_DAY)
    case 'decade':
      return Math.floor(Date.UTC(y + n * 10, m, d) / MS_PER_DAY)
  }
}

export function snapDay(day: number, unit: Unit): number {
  const lo = floorToUnit(day, unit)
  const hi = addUnits(lo, unit, 1)
  return day - lo < hi - day ? lo : hi
}

export interface Tick {
  day: number
  end: number
  label: string
  /** Weekend or otherwise de-emphasised cell. */
  dim: boolean
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const DOW = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']

function labelFor(day: number, unit: Unit, ppd: number): string {
  const dt = dayToDate(day)
  const y = dt.getUTCFullYear()
  const m = dt.getUTCMonth()
  switch (unit) {
    case 'day':
      return ppd >= 46 ? `${DOW[(dt.getUTCDay() + 6) % 7]} ${dt.getUTCDate()}` : String(dt.getUTCDate())
    case 'week':
      return `${MONTHS[m]} ${dt.getUTCDate()}`
    case 'month':
      return ppd >= 2.6 ? MONTHS[m] : MONTHS[m][0]
    case 'quarter':
      return `Q${Math.floor(m / 3) + 1}`
    case 'year':
      return ppd >= 0.16 ? String(y) : `'${String(y).slice(2)}`
    case 'decade':
      return `${y}s`
  }
}

/** Generate header/grid cells covering [fromDay, toDay] for a unit. */
export function ticks(unit: Unit, fromDay: number, toDay: number, ppd: number): Tick[] {
  const out: Tick[] = []
  let cursor = floorToUnit(Math.max(fromDay, WORLD_START_DAY), unit)
  const limit = Math.min(toDay, WORLD_END_DAY)
  // Guard against pathological loops if a caller passes a huge range.
  let guard = 0
  while (cursor <= limit && guard++ < 4000) {
    const end = addUnits(cursor, unit, 1)
    const dow = (dayToDate(cursor).getUTCDay() + 6) % 7
    out.push({
      day: cursor,
      end,
      label: labelFor(cursor, unit, ppd),
      dim: unit === 'day' && dow >= 5,
    })
    cursor = end
  }
  return out
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const FULL_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

export function formatDate(iso: string, precision: Precision = 'day'): string {
  const dt = dayToDate(isoToDay(iso))
  const y = dt.getUTCFullYear()
  const m = dt.getUTCMonth()
  switch (precision) {
    case 'year': return String(y)
    case 'quarter': return `Q${Math.floor(m / 3) + 1} ${y}`
    case 'month': return `${MONTHS[m]} ${y}`
    default: return `${MONTHS[m]} ${dt.getUTCDate()}, ${y}`
  }
}

export function formatLongDate(iso: string): string {
  const dt = dayToDate(isoToDay(iso))
  return `${FULL_MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`
}

/** Human duration for a day-count, e.g. "3 wks", "2 yrs". */
export function formatSpan(days: number): string {
  if (days < 14) return `${days} ${days === 1 ? 'day' : 'days'}`
  if (days < 70) return `${Math.round(days / 7)} wks`
  if (days < 730) return `${Math.round(days / 30.44)} mo`
  return `${(days / 365.25).toFixed(1)} yrs`
}
