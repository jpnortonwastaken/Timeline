import { nanoid } from 'nanoid'
import type { Dependency, Item, Lane, Snapshot, Status } from '../types'
import { dayToIso, todayDay } from './time'

/** A plausible life-and-projects plan, so the canvas is never empty. */
export function seed(): Snapshot {
  const t = todayDay()
  const items: Record<string, Item> = {}
  const lanes: Record<string, Lane> = {}
  const deps: Record<string, Dependency> = {}
  const now = new Date().toISOString()

  const lane = (name: string, colorId: string, order: number) => {
    const id = nanoid(8)
    lanes[id] = { id, name, colorId, order, collapsed: false }
    return id
  }

  const item = (
    title: string,
    laneId: string | null,
    parentId: string | null,
    startOffset: number | null,
    lengthDays: number | null,
    opts: Partial<Item> = {},
  ) => {
    const id = nanoid(8)
    const order = Object.keys(items).length
    items[id] = {
      id,
      title,
      parentId,
      laneId,
      order,
      start: startOffset === null ? null : { date: dayToIso(t + startOffset), precision: 'day' },
      end:
        startOffset === null || lengthDays === null
          ? null
          : { date: dayToIso(t + startOffset + lengthDays), precision: 'day' },
      status: 'planned',
      progress: null,
      colorId: null,
      notes: '',
      collapsed: false,
      createdAt: now,
      updatedAt: now,
      ...opts,
    }
    return id
  }

  const career = lane('Career', 'blue', 0)
  const projects = lane('Side projects', 'purple', 1)
  const health = lane('Health', 'green', 2)
  const travel = lane('Travel', 'orange', 3)
  const learning = lane('Learning', 'brown', 4)
  const money = lane('Money', 'yellow', 5)

  // Career
  const role = item('Current role', career, null, -420, 900, { status: 'active', progress: 0.55 })
  item('Push for senior', career, role, -40, 180, { status: 'active' })
  item('Performance review', career, role, 120, null, { status: 'planned' })
  item('Start looking around', career, null, 430, 200, {
    status: 'idea',
    start: { date: dayToIso(t + 430), precision: 'quarter' },
    end: { date: dayToIso(t + 630), precision: 'quarter' },
  })

  // Side projects
  const app = item('Build Timeline', projects, null, -14, 120, { status: 'active', progress: 0.15 })
  const canvas = item('Timeline canvas', projects, app, -14, 24, { status: 'active', progress: 0.6 })
  const editing = item('Editing + drag', projects, app, 11, 21, { status: 'planned' })
  const wrapper = item('Mac app wrapper', projects, app, 45, 14, { status: 'planned' })
  const ship = item('Ship v1', projects, app, 118, null, { status: 'planned' })
  item('Rewrite portfolio site', projects, null, 150, 45, { status: 'idea' })

  // Health
  const marathon = item('Marathon training', health, null, 20, 140, { status: 'planned' })
  const base = item('Base building', health, marathon, 20, 56, { status: 'planned' })
  const peak = item('Peak weeks', health, marathon, 90, 50, { status: 'planned' })
  const race = item('Race day', health, marathon, 160, null, { status: 'planned' })
  item('Dentist', health, null, 34, null, { status: 'planned' })

  // Travel
  item('Japan trip', travel, null, 75, 16, { status: 'planned' })
  item('Family holidays', travel, null, 210, 10, { status: 'planned' })
  item('Sabbatical?', travel, null, 1500, 200, {
    status: 'idea',
    start: { date: dayToIso(t + 1500), precision: 'year' },
    end: { date: dayToIso(t + 1700), precision: 'year' },
  })

  // Learning
  item('Learn Rust properly', learning, null, 60, 180, { status: 'idea' })
  item('Read 24 books', learning, null, -230, 365, { status: 'active', progress: 0.42 })

  // Money
  item('Emergency fund topped up', money, null, -90, 270, { status: 'active', progress: 0.7 })
  item('House deposit', money, null, 300, 900, {
    status: 'idea',
    start: { date: dayToIso(t + 300), precision: 'quarter' },
    end: { date: dayToIso(t + 1200), precision: 'year' },
  })

  const link = (fromId: string, toId: string) => {
    const id = nanoid(8)
    deps[id] = { id, fromId, toId, type: 'finish-to-start', lagDays: 0 }
  }
  link(canvas, editing)
  link(editing, wrapper)
  link(wrapper, ship)
  link(base, peak)
  link(peak, race)

  return { items, lanes, deps }
}

export const SEED_STATUSES: Status[] = ['idea', 'planned', 'active', 'done', 'dropped']
