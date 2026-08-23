/**
 * A tiny command bus so the toolbar and global keyboard shortcuts can drive the
 * scroller without prop-drilling through the tree. Timeline registers the real
 * implementations on mount.
 */
export const cmd = {
  /** Zoom to a new pixels-per-day, anchored at a client X (defaults to viewport center). */
  zoom: (_ppd: number, _anchorClientX?: number) => {},
  /** Scroll so a day number sits at the given fraction across the visible canvas. */
  goToDay: (_day: number, _align?: number, _smooth?: boolean) => {},
  /** Scroll a row index into view vertically. */
  revealRow: (_index: number) => {},
  /** Put a (fractional) row index at the top of the canvas, without easing. */
  scrollToRow: (_row: number) => {},
  /** Current visible day range, for the minimap window. */
  visibleDays: () => ({ from: 0, to: 0 }),
}

/** Row heights. `normal` matches Notion's table row. */
export const DENSITY_HEIGHT: Record<string, number> = {
  compact: 28,
  normal: 33,
  roomy: 44,
}

/** Fixed widths of the optional table columns, and the room a name needs. */
export const COLUMN_WIDTH: Record<string, number> = { status: 88, dates: 88, span: 52 }
export const NAME_MIN_WIDTH = 132

/**
 * Drop the columns that don't fit the current table width. Their widths are
 * fixed so the header and cells line up, which means without this they simply
 * overflow the sticky column and spill onto the canvas.
 */
export function fitColumns(columns: string[], sidebarWidth: number): string[] {
  let room = sidebarWidth - NAME_MIN_WIDTH
  return columns.filter((c) => {
    const w = COLUMN_WIDTH[c] ?? 0
    if (room < w) return false
    room -= w
    return true
  })
}

export const HEADER_HEIGHT = 56
export const TIER_HEIGHT = 28
