/**
 * A tiny command bus so the toolbar and global keyboard shortcuts can drive the
 * scroller without prop-drilling through the tree. Timeline registers the real
 * implementations on mount.
 */
export const cmd = {
  /** Zoom to a new pixels-per-day, anchored at a client X (defaults to viewport centre). */
  zoom: (_ppd: number, _anchorClientX?: number) => {},
  /** Scroll so a day number sits at the given fraction across the visible canvas. */
  goToDay: (_day: number, _align?: number, _smooth?: boolean) => {},
  /** Scroll a row index into view vertically. */
  revealRow: (_index: number) => {},
  /** Current visible day range, for the minimap window. */
  visibleDays: () => ({ from: 0, to: 0 }),
}

/** Row heights. `normal` matches Notion's table row. */
export const DENSITY_HEIGHT: Record<string, number> = {
  compact: 28,
  normal: 33,
  roomy: 44,
}

export const HEADER_HEIGHT = 56
export const TIER_HEIGHT = 28
