// Remembers the main window's size, position and maximized state between
// launches (issue #73). Pure helpers live here so they can be unit tested
// without Electron; src/main/index.ts wires them to BrowserWindow events.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export interface SavedWindowState {
  x?: number
  y?: number
  width: number
  height: number
  isMaximized: boolean
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface InitialBounds {
  x?: number
  y?: number
  width: number
  height: number
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * Turn a saved state into bounds that are safe to open a window with. The
 * size is clamped to the window minimum; the position is only kept when a
 * reasonable slice of the title bar still lands on one of the current
 * displays, so a window last closed on an unplugged monitor comes back
 * centred instead of off-screen.
 */
export function fitBoundsToDisplays(
  saved: Partial<SavedWindowState> | null | undefined,
  workAreas: Rect[],
  defaults: { width: number; height: number },
  minimum: { width: number; height: number }
): InitialBounds {
  const width = Math.max(
    minimum.width,
    isFiniteNumber(saved?.width) ? Math.round(saved.width) : defaults.width
  )
  const height = Math.max(
    minimum.height,
    isFiniteNumber(saved?.height) ? Math.round(saved.height) : defaults.height
  )
  const bounds: InitialBounds = { width, height }

  if (!isFiniteNumber(saved?.x) || !isFiniteNumber(saved?.y)) return bounds
  const x = Math.round(saved.x)
  const y = Math.round(saved.y)

  // Require at least 100x40 px of the top strip of the window to be visible.
  const visibleOnSomeDisplay = workAreas.some((area) => {
    const overlapWidth = Math.min(x + width, area.x + area.width) - Math.max(x, area.x)
    const overlapHeight = Math.min(y + 40, area.y + area.height) - Math.max(y, area.y)
    return overlapWidth >= 100 && overlapHeight >= 40
  })
  if (!visibleOnSomeDisplay) return bounds

  return { ...bounds, x, y }
}

export function loadWindowState(filePath: string): SavedWindowState | null {
  try {
    if (!existsSync(filePath)) return null
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<SavedWindowState>
    if (!isFiniteNumber(parsed.width) || !isFiniteNumber(parsed.height)) return null
    return {
      x: isFiniteNumber(parsed.x) ? parsed.x : undefined,
      y: isFiniteNumber(parsed.y) ? parsed.y : undefined,
      width: parsed.width,
      height: parsed.height,
      isMaximized: parsed.isMaximized === true
    }
  } catch (error) {
    console.warn('[WindowState] Failed to read saved window state:', error)
    return null
  }
}

export function saveWindowState(filePath: string, state: SavedWindowState): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(state), 'utf8')
  } catch (error) {
    console.warn('[WindowState] Failed to save window state:', error)
  }
}
