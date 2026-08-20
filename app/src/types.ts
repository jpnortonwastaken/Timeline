export type ItemId = string
export type LaneId = string

/** Date precision. `day` renders a crisp bar; anything coarser renders as a soft,
 *  hatched band — "sometime in 2031" shouldn't look as certain as "Nov 3-7". */
export type Precision = 'day' | 'week' | 'month' | 'quarter' | 'year'

export type Status = 'idea' | 'planned' | 'active' | 'done' | 'dropped'

export interface DateSpec {
  /** ISO date-only, e.g. "2026-08-20". No time, no timezone. */
  date: string
  precision: Precision
}

export interface Item {
  id: ItemId
  title: string
  parentId: ItemId | null
  laneId: LaneId | null
  order: number

  start: DateSpec | null
  /** null with a start set = milestone (diamond). */
  end: DateSpec | null

  status: Status
  progress: number | null
  colorId: string | null
  notes: string

  collapsed: boolean
  createdAt: string
  updatedAt: string
}

export interface Lane {
  id: LaneId
  name: string
  colorId: string
  order: number
  collapsed: boolean
}

export type Density = 'compact' | 'normal' | 'roomy'
export type ThemeMode = 'light' | 'dark' | 'auto'

export type DependencyType = 'finish-to-start' | 'start-to-start'

export interface Dependency {
  id: string
  fromId: ItemId
  toId: ItemId
  type: DependencyType
  lagDays: number
}

export interface Snapshot {
  items: Record<ItemId, Item>
  lanes: Record<LaneId, Lane>
  deps: Record<string, Dependency>
}

export interface PersistedState extends Snapshot {
  version: number
  ppd: number
  sidebarWidth: number
  density: Density
  visibleColumns: string[]
  autoShift: boolean
  showMinimap: boolean
  noLaneCollapsed: boolean
  sidebarOpen: boolean
}
