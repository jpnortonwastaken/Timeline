/** Notion's colour palette, in Notion's own order. Actual values live in CSS
 *  (`.c-blue` etc.) so light/dark theming is handled by the stylesheet. */
export const COLORS = [
  { id: 'gray', label: 'Gray' },
  { id: 'brown', label: 'Brown' },
  { id: 'orange', label: 'Orange' },
  { id: 'yellow', label: 'Yellow' },
  { id: 'green', label: 'Green' },
  { id: 'blue', label: 'Blue' },
  { id: 'purple', label: 'Purple' },
  { id: 'pink', label: 'Pink' },
  { id: 'red', label: 'Red' },
] as const

export type ColorId = (typeof COLORS)[number]['id']
export const DEFAULT_COLOR: ColorId = 'blue'
