/**
 * Small stroked glyphs for menu rows. One shared 16px box and stroke weight so
 * they sit on a common baseline down the left edge of a menu.
 */
import type { ReactNode } from 'react'

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      className="menu-icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

export const IconRename = () => (
  <Glyph>
    <path d="M11.3 2.7a1.7 1.7 0 0 1 2.4 2.4L6 12.8l-3 .6.6-3z" />
  </Glyph>
)

export const IconDuplicate = () => (
  <Glyph>
    <rect x="5.6" y="5.6" width="8" height="8" rx="1.8" />
    <path d="M10.4 3.4a1.8 1.8 0 0 0-1.8-1.8H4.2a2.6 2.6 0 0 0-2.6 2.6v4.4c0 1 .8 1.8 1.8 1.8" />
  </Glyph>
)

export const IconSubItem = () => (
  <Glyph>
    <path d="M4 3v4.2a2 2 0 0 0 2 2h6" />
    <path d="M9.6 6.8 12.4 9.2 9.6 11.6" />
  </Glyph>
)

export const IconDone = () => (
  <Glyph>
    <circle cx="8" cy="8" r="6" />
    <path d="M5.4 8.2 7.2 10l3.4-3.6" />
  </Glyph>
)

export const IconInProgress = () => (
  <Glyph>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.6V8l2.2 1.4" />
  </Glyph>
)

export const IconMilestone = () => (
  <Glyph>
    <rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1.6" transform="rotate(45 8 8)" />
  </Glyph>
)

export const IconSpan = () => (
  <Glyph>
    <rect x="1.8" y="5.4" width="12.4" height="5.2" rx="1.8" />
  </Glyph>
)

export const IconDelete = () => (
  <Glyph>
    <path d="M2.8 4.4h10.4" />
    <path d="M6.4 4.4V3.2a1 1 0 0 1 1-1h1.2a1 1 0 0 1 1 1v1.2" />
    <path d="M4 4.4l.6 8a1.2 1.2 0 0 0 1.2 1.1h4.4a1.2 1.2 0 0 0 1.2-1.1l.6-8" />
  </Glyph>
)

export const IconPlus = () => (
  <Glyph>
    <path d="M8 3.2v9.6M3.2 8h9.6" />
  </Glyph>
)

export const IconLane = () => (
  <Glyph>
    <rect x="1.8" y="3" width="8" height="3.4" rx="1.4" />
    <rect x="5" y="9.6" width="9.2" height="3.4" rx="1.4" />
  </Glyph>
)

export const IconCollapseLane = () => (
  <Glyph>
    <path d="M4.6 6.4 8 9.8l3.4-3.4" />
  </Glyph>
)

export const IconExpandAll = () => (
  <Glyph>
    <path d="M5 6.4 8 3.4l3 3M5 9.6 8 12.6l3-3" />
  </Glyph>
)

export const IconCollapseAll = () => (
  <Glyph>
    <path d="M5 3.8 8 6.8l3-3M5 12.2l3-3 3 3" />
  </Glyph>
)

export const IconExport = () => (
  <Glyph>
    <path d="M8 10.2V2.6M5.2 5.4 8 2.6l2.8 2.8" />
    <path d="M2.8 10.6v1.6a1.6 1.6 0 0 0 1.6 1.6h7.2a1.6 1.6 0 0 0 1.6-1.6v-1.6" />
  </Glyph>
)

export const IconImport = () => (
  <Glyph>
    <path d="M8 2.6v7.6M5.2 7.4 8 10.2l2.8-2.8" />
    <path d="M2.8 10.6v1.6a1.6 1.6 0 0 0 1.6 1.6h7.2a1.6 1.6 0 0 0 1.6-1.6v-1.6" />
  </Glyph>
)

export const IconPalette = () => (
  <Glyph>
    <circle cx="8" cy="8" r="6" />
    <circle cx="8" cy="5.2" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="5.3" cy="8.4" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="10.7" cy="8.4" r="0.9" fill="currentColor" stroke="none" />
  </Glyph>
)
