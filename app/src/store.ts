import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type {
  Density,
  Dependency,
  DependencyType,
  Item,
  ItemId,
  Lane,
  LaneId,
  PersistedState,
  Snapshot,
  Status,
  ThemeMode,
} from './types'
import { clampPpd, dayToIso, isoToDay, todayDay } from './lib/time'
import { relax, wouldCycle } from './lib/deps'
import { seed } from './lib/seed'
import { writeBackup } from './lib/tauri'

const STORAGE_KEY = 'timeline.v1'
const LEGACY_KEY = 'linea.v1'
const VERSION = 1
const HISTORY_LIMIT = 100

export const ALL_COLUMNS = ['dates', 'status', 'span'] as const

export interface State extends Snapshot {
  ppd: number
  autoShift: boolean
  showMinimap: boolean
  /** Collapse state for the synthetic "No lane" group, which has no Lane record. */
  noLaneCollapsed: boolean
  sidebarWidth: number
  sidebarOpen: boolean
  density: Density
  visibleColumns: string[]
  themeMode: ThemeMode

  /** Visible day range, republished by Timeline on scroll. Not persisted. */
  viewFrom: number
  viewTo: number

  selection: ItemId[]
  editingId: ItemId | null
  editingLaneId: LaneId | null
  search: string
  detailOpen: boolean

  past: Snapshot[]
  future: Snapshot[]
}

export interface Actions {
  // history
  commit: () => void
  undo: () => void
  redo: () => void

  // items
  createItem: (partial: Partial<Item>) => ItemId
  updateItem: (id: ItemId, patch: Partial<Item>, live?: boolean) => void
  updateItems: (patches: { id: ItemId; patch: Partial<Item> }[], live?: boolean) => void
  deleteItems: (ids: ItemId[]) => void
  /** Copy an item, its whole subtree, and any dependencies internal to it. */
  duplicateItems: (ids: ItemId[]) => void
  indent: (id: ItemId) => void
  outdent: (id: ItemId) => void

  // dependencies
  addDep: (fromId: ItemId, toId: ItemId, type?: DependencyType) => string | null
  removeDep: (id: string) => void
  /** Push dependents forward until every gap is satisfied. Folds into the caller's undo entry. */
  cascade: () => void

  // ordering
  reorderItem: (
    id: ItemId,
    targetId: ItemId,
    position: 'before' | 'after' | 'child',
    live?: boolean,
  ) => void

  // lanes
  createLane: (name: string) => LaneId
  updateLane: (id: LaneId, patch: Partial<Lane>) => void
  deleteLane: (id: LaneId) => void

  // view
  setPpd: (ppd: number) => void
  setSidebarWidth: (w: number) => void
  toggleSidebar: () => void
  setDensity: (d: Density) => void
  toggleColumn: (c: string) => void
  setThemeMode: (m: ThemeMode) => void
  cycleTheme: () => void
  setSearch: (s: string) => void
  toggleAutoShift: () => void
  toggleMinimap: () => void

  // collapse
  toggleCollapse: (id: ItemId) => void
  toggleLaneCollapse: (id: LaneId) => void
  expandAll: () => void
  collapseAll: () => void

  // selection
  select: (ids: ItemId[]) => void
  toggleSelect: (id: ItemId) => void
  setEditing: (id: ItemId | null) => void
  setEditingLane: (id: LaneId | null) => void
  setViewRange: (from: number, to: number) => void
  setDetailOpen: (open: boolean) => void

  // data
  exportJSON: () => string
  importJSON: (raw: string) => void
  /** Replace everything without touching undo history (startup restore). */
  hydrate: (raw: string) => void
  resetToSeed: () => void
}

const snapshot = (s: State): Snapshot => ({ items: s.items, lanes: s.lanes, deps: s.deps })

/** An item plus everything under it. Local copy so store.ts stays free of tree.ts. */
function subtree(items: Record<ItemId, Item>, root: ItemId): Set<ItemId> {
  const out = new Set<ItemId>([root])
  let grew = true
  while (grew) {
    grew = false
    for (const it of Object.values(items)) {
      if (it.parentId && out.has(it.parentId) && !out.has(it.id)) {
        out.add(it.id)
        grew = true
      }
    }
  }
  return out
}

function load(): Partial<PersistedState> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed?.version !== VERSION) return null
    return parsed
  } catch {
    return null
  }
}

const persisted = load()
/** True when the browser store already held a plan at startup. */
export const hadStoredState = !!persisted?.items
const initial = persisted?.items
  ? { items: persisted.items, lanes: persisted.lanes ?? {}, deps: persisted.deps ?? {} }
  : seed()

export const useStore = create<State & Actions>((set, get) => ({
  items: initial.items,
  lanes: initial.lanes as Record<LaneId, Lane>,
  deps: initial.deps as Record<string, Dependency>,
  ppd: persisted?.ppd ?? 4.2,
  autoShift: persisted?.autoShift ?? true,
  noLaneCollapsed: persisted?.noLaneCollapsed ?? false,
  showMinimap: persisted?.showMinimap ?? true,
  sidebarWidth: persisted?.sidebarWidth ?? 360,
  sidebarOpen: persisted?.sidebarOpen ?? true,
  density: persisted?.density ?? 'normal',
  visibleColumns: persisted?.visibleColumns ?? ['dates', 'span'],
  themeMode: (localStorage.getItem('timeline.theme') as ThemeMode) ?? 'auto',

  viewFrom: todayDay() - 180,
  viewTo: todayDay() + 180,

  selection: [],
  editingId: null,
  editingLaneId: null,
  search: '',
  detailOpen: true,

  past: [],
  future: [],

  // -- history ---------------------------------------------------------------
  commit: () =>
    set((s) => ({
      past: [...s.past.slice(-(HISTORY_LIMIT - 1)), snapshot(s)],
      future: [],
    })),

  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1]
      if (!prev) return s
      return {
        ...prev,
        past: s.past.slice(0, -1),
        future: [snapshot(s), ...s.future].slice(0, HISTORY_LIMIT),
      }
    }),

  redo: () =>
    set((s) => {
      const next = s.future[0]
      if (!next) return s
      return {
        ...next,
        past: [...s.past, snapshot(s)],
        future: s.future.slice(1),
      }
    }),

  // -- items -----------------------------------------------------------------
  createItem: (partial) => {
    const id = nanoid(8)
    const now = new Date().toISOString()
    const t = todayDay()
    get().commit()
    set((s) => ({
      items: {
        ...s.items,
        [id]: {
          title: '',
          parentId: null,
          laneId: null,
          order: Object.keys(s.items).length,
          start: { date: dayToIso(t), precision: 'day' },
          end: { date: dayToIso(t + 6), precision: 'day' },
          status: 'planned',
          progress: null,
          colorId: null,
          notes: '',
          collapsed: false,
          createdAt: now,
          updatedAt: now,
          ...partial,
          id,
        },
      },
      selection: [id],
    }))
    return id
  },

  updateItem: (id, patch, live) => {
    if (!live) get().commit()
    set((s) => {
      const cur = s.items[id]
      if (!cur) return s
      return {
        items: { ...s.items, [id]: { ...cur, ...patch, updatedAt: new Date().toISOString() } },
      }
    })
  },

  updateItems: (patches, live) => {
    if (!live) get().commit()
    set((s) => {
      const items = { ...s.items }
      const now = new Date().toISOString()
      for (const { id, patch } of patches) {
        const cur = items[id]
        if (cur) items[id] = { ...cur, ...patch, updatedAt: now }
      }
      return { items }
    })
  },

  deleteItems: (ids) => {
    get().commit()
    set((s) => {
      const doomed = new Set<ItemId>()
      const walk = (id: ItemId) => {
        doomed.add(id)
        for (const c of Object.values(s.items)) if (c.parentId === id) walk(c.id)
      }
      ids.forEach(walk)
      const items: Record<ItemId, Item> = {}
      for (const [k, v] of Object.entries(s.items)) if (!doomed.has(k)) items[k] = v
      const deps: Record<string, Dependency> = {}
      for (const [k, d] of Object.entries(s.deps)) {
        if (!doomed.has(d.fromId) && !doomed.has(d.toId)) deps[k] = d
      }
      return { items, deps, selection: s.selection.filter((id) => !doomed.has(id)) }
    })
  },

  duplicateItems: (ids) => {
    get().commit()
    set((s) => {
      const items = { ...s.items }
      const deps = { ...s.deps }
      const now = new Date().toISOString()
      const selection: ItemId[] = []

      for (const rootId of ids) {
        const root = s.items[rootId]
        if (!root) continue
        const clan = subtree(s.items, rootId)
        const idMap = new Map<ItemId, ItemId>()
        for (const oldId of clan) idMap.set(oldId, nanoid(8))

        for (const oldId of clan) {
          const src = s.items[oldId]
          const nid = idMap.get(oldId)!
          items[nid] = {
            ...src,
            id: nid,
            parentId: src.parentId ? idMap.get(src.parentId) ?? src.parentId : null,
            // Fractional order drops the copy in right after the original
            // without having to renumber every sibling below it.
            order: oldId === rootId ? src.order + 0.5 : src.order,
            createdAt: now,
            updatedAt: now,
          }
        }

        // Links wholly inside the copied subtree come along; links crossing its
        // boundary do not, since duplicating shouldn't silently add constraints.
        for (const d of Object.values(s.deps)) {
          if (idMap.has(d.fromId) && idMap.has(d.toId)) {
            const did = nanoid(8)
            deps[did] = { ...d, id: did, fromId: idMap.get(d.fromId)!, toId: idMap.get(d.toId)! }
          }
        }
        selection.push(idMap.get(rootId)!)
      }
      return { items, deps, selection }
    })
  },

  /** Make an item a child of its previous sibling. */
  indent: (id) => {
    const s = get()
    const me = s.items[id]
    if (!me) return
    const siblings = Object.values(s.items)
      .filter((i) => i.parentId === me.parentId && i.laneId === me.laneId)
      .sort((a, b) => a.order - b.order)
    const idx = siblings.findIndex((i) => i.id === id)
    if (idx <= 0) return
    get().updateItem(id, { parentId: siblings[idx - 1].id })
  },

  outdent: (id) => {
    const s = get()
    const me = s.items[id]
    if (!me?.parentId) return
    const parent = s.items[me.parentId]
    get().updateItem(id, { parentId: parent?.parentId ?? null, laneId: parent?.laneId ?? me.laneId })
  },

  // -- dependencies ----------------------------------------------------------
  addDep: (fromId, toId, type = 'finish-to-start') => {
    const s = get()
    if (fromId === toId) return null
    if (wouldCycle(s.deps, fromId, toId)) return null
    const exists = Object.values(s.deps).some((d) => d.fromId === fromId && d.toId === toId)
    if (exists) return null
    const id = nanoid(8)
    get().commit()
    set((st) => ({ deps: { ...st.deps, [id]: { id, fromId, toId, type, lagDays: 0 } } }))
    get().cascade()
    return id
  },

  removeDep: (id) => {
    get().commit()
    set((s) => {
      const deps = { ...s.deps }
      delete deps[id]
      return { deps }
    })
  },

  cascade: () => {
    const s = get()
    if (!s.autoShift) return
    const delta = relax(s.items, s.deps)
    if (!delta.size) return
    set((st) => {
      const items = { ...st.items }
      const now = new Date().toISOString()
      for (const [id, by] of delta) {
        const it = items[id]
        if (!it) continue
        items[id] = {
          ...it,
          start: it.start ? { ...it.start, date: dayToIso(isoToDay(it.start.date) + by) } : null,
          end: it.end ? { ...it.end, date: dayToIso(isoToDay(it.end.date) + by) } : null,
          updatedAt: now,
        }
      }
      return { items }
    })
  },

  // -- ordering --------------------------------------------------------------
  reorderItem: (id, targetId, position, live) => {
    const s = get()
    const me = s.items[id]
    const target = s.items[targetId]
    if (!me || !target || id === targetId) return
    // Never drop a branch inside itself.
    if (subtree(s.items, id).has(targetId)) return

    const parentId = position === 'child' ? targetId : target.parentId
    const laneId = target.laneId

    if (!live) get().commit()
    set((st) => {
      const siblings = Object.values(st.items)
        .filter((i) => i.id !== id && i.parentId === parentId && i.laneId === laneId)
        .sort((a, b) => a.order - b.order)

      let index = siblings.length
      if (position !== 'child') {
        const at = siblings.findIndex((i) => i.id === targetId)
        if (at >= 0) index = position === 'before' ? at : at + 1
      }
      siblings.splice(index, 0, { ...me, parentId, laneId } as Item)

      const items = { ...st.items }
      const now = new Date().toISOString()
      siblings.forEach((sib, i) => {
        items[sib.id] = { ...items[sib.id], parentId, laneId, order: i, updatedAt: now }
      })
      return { items }
    })
  },

  // -- lanes -----------------------------------------------------------------
  createLane: (name) => {
    const id = nanoid(8)
    get().commit()
    set((s) => ({
      lanes: {
        ...s.lanes,
        [id]: { id, name, colorId: 'gray', order: Object.keys(s.lanes).length, collapsed: false },
      },
    }))
    return id
  },

  updateLane: (id, patch) => {
    get().commit()
    set((s) => ({ lanes: { ...s.lanes, [id]: { ...s.lanes[id], ...patch } } }))
  },

  deleteLane: (id) => {
    get().commit()
    set((s) => {
      const lanes = { ...s.lanes }
      delete lanes[id]
      const items = { ...s.items }
      for (const [k, v] of Object.entries(items)) {
        if (v.laneId === id) items[k] = { ...v, laneId: null }
      }
      return { lanes, items }
    })
  },

  // -- view ------------------------------------------------------------------
  setPpd: (ppd) => set({ ppd: clampPpd(ppd) }),
  setSidebarWidth: (w) => set({ sidebarWidth: Math.min(640, Math.max(180, w)) }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setDensity: (density) => set({ density }),
  toggleColumn: (c) =>
    set((s) => ({
      visibleColumns: s.visibleColumns.includes(c)
        ? s.visibleColumns.filter((x) => x !== c)
        : [...s.visibleColumns, c],
    })),
  setThemeMode: (themeMode) => {
    localStorage.setItem('timeline.theme', themeMode)
    set({ themeMode })
  },
  // For the native menu item, which is a single command rather than a picker.
  cycleTheme: () =>
    set((s) => {
      const next: ThemeMode = s.themeMode === 'auto' ? 'light' : s.themeMode === 'light' ? 'dark' : 'auto'
      localStorage.setItem('timeline.theme', next)
      return { themeMode: next }
    }),
  setSearch: (search) => set({ search }),
  toggleAutoShift: () => set((s) => ({ autoShift: !s.autoShift })),
  toggleMinimap: () => set((s) => ({ showMinimap: !s.showMinimap })),

  // -- collapse --------------------------------------------------------------
  toggleCollapse: (id) =>
    set((s) => ({ items: { ...s.items, [id]: { ...s.items[id], collapsed: !s.items[id].collapsed } } })),

  toggleLaneCollapse: (id) =>
    set((s) =>
      id === '__none'
        ? { noLaneCollapsed: !s.noLaneCollapsed }
        : { lanes: { ...s.lanes, [id]: { ...s.lanes[id], collapsed: !s.lanes[id].collapsed } } },
    ),

  expandAll: () =>
    set((s) => {
      const items = { ...s.items }
      for (const k of Object.keys(items)) items[k] = { ...items[k], collapsed: false }
      const lanes = { ...s.lanes }
      for (const k of Object.keys(lanes)) lanes[k] = { ...lanes[k], collapsed: false }
      return { items, lanes, noLaneCollapsed: false }
    }),

  collapseAll: () =>
    set((s) => {
      const items = { ...s.items }
      for (const k of Object.keys(items)) items[k] = { ...items[k], collapsed: true }
      const lanes = { ...s.lanes }
      for (const k of Object.keys(lanes)) lanes[k] = { ...lanes[k], collapsed: true }
      return { items, lanes, noLaneCollapsed: true }
    }),

  // -- selection -------------------------------------------------------------
  // Closing the panel dismisses it for the current selection only - picking
  // something else is a fresh request to see it, so the panel comes back.
  select: (ids) => set((s) => (s.detailOpen ? { selection: ids } : { selection: ids, detailOpen: true })),
  toggleSelect: (id) =>
    set((s) => ({
      selection: s.selection.includes(id)
        ? s.selection.filter((x) => x !== id)
        : [...s.selection, id],
      detailOpen: true,
    })),
  setEditing: (editingId) => set({ editingId }),
  setEditingLane: (editingLaneId) => set({ editingLaneId }),
  setViewRange: (viewFrom, viewTo) =>
    set((s) => (s.viewFrom === viewFrom && s.viewTo === viewTo ? s : { viewFrom, viewTo })),
  setDetailOpen: (detailOpen) => set({ detailOpen }),

  // -- data ------------------------------------------------------------------
  exportJSON: () => {
    const s = get()
    return JSON.stringify(
      { version: VERSION, items: s.items, lanes: s.lanes, deps: s.deps },
      null,
      2,
    )
  },

  importJSON: (raw) => {
    const parsed = JSON.parse(raw)
    if (!parsed?.items) throw new Error('No `items` in file')
    get().commit()
    set({ items: parsed.items, lanes: parsed.lanes ?? {}, deps: parsed.deps ?? {}, selection: [] })
  },

  hydrate: (raw) => {
    const parsed = JSON.parse(raw)
    if (!parsed?.items) return
    set({ items: parsed.items, lanes: parsed.lanes ?? {}, deps: parsed.deps ?? {}, past: [], future: [] })
  },

  resetToSeed: () => {
    get().commit()
    set({ ...seed(), selection: [] })
  },
}))

export const statusLabel: Record<Status, string> = {
  idea: 'Idea',
  planned: 'Planned',
  active: 'In progress',
  done: 'Done',
  dropped: 'Dropped',
}

// -- persistence -------------------------------------------------------------
let saveTimer: number | undefined
useStore.subscribe((s) => {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const payload: PersistedState = {
      version: VERSION,
      items: s.items,
      lanes: s.lanes,
      deps: s.deps,
      ppd: s.ppd,
      autoShift: s.autoShift,
      noLaneCollapsed: s.noLaneCollapsed,
      showMinimap: s.showMinimap,
      sidebarWidth: s.sidebarWidth,
      sidebarOpen: s.sidebarOpen,
      density: s.density,
      visibleColumns: s.visibleColumns,
    }
    const json = JSON.stringify(payload)
    try {
      localStorage.setItem(STORAGE_KEY, json)
    } catch {
      /* quota - ignore */
    }
    void writeBackup(json)
  }, 400) as unknown as number
})
