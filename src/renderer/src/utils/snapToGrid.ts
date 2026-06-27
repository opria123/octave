import { TICKS_PER_BEAT } from '../types'

/**
 * Snapping fraction used by the manual "Snap to Grid" action: a note is only
 * pulled onto a grid line when it already lies within this fraction of the grid
 * spacing of that line. Notes nearer the middle of a cell (a genuine finer
 * subdivision — syncopation, fills, or an intentional off-beat hit) are left
 * exactly where they are. This mirrors the auto-chart drum-snap behaviour
 * ("nudge onset jitter onto the grid, leave genuinely off-grid hits untouched")
 * and fixes issue #22, where coarse snapping dragged correctly-placed notes off
 * their subdivision.
 */
export const SNAP_TO_GRID_TOLERANCE_FRACTION = 0.25

/** Snap a single tick value to the nearest grid line of the given spacing. */
export function snapTickToGrid(tick: number, gridTicks: number): number {
  if (gridTicks <= 0) return tick
  return Math.round(tick / gridTicks) * gridTicks
}

/** Grid-line spacing in ticks for a snap division (e.g. 4 → 120 ticks at 480 PPQ). */
export function gridTicksForDivision(division: number): number {
  return TICKS_PER_BEAT / division
}

export interface SnapEntriesOptions<T> {
  /** Spacing between grid lines, in ticks. */
  gridTicks: number
  /**
   * A note is only moved when its distance to the nearest grid line is `<=` this
   * many ticks. Pass `Infinity` to snap every eligible note to its nearest line.
   */
  toleranceTicks: number
  /** Whether an entry is eligible to be snapped (e.g. a selection filter). */
  isEligible: (entry: T) => boolean
  /**
   * De-duplication key for an entry at its (possibly snapped) position. When two
   * entries share a key, only the one with the longest sustain is kept, so
   * snapping never silently stacks notes on top of each other (issue #22).
   */
  keyOf: (entry: T) => string
}

export interface SnapEntriesResult<T> {
  entries: T[]
  changed: boolean
}

/**
 * Snap a list of tick-based entries onto the grid and collapse any entries that
 * land on the same logical position.
 *
 * Eligible entries within `toleranceTicks` of a grid line are nudged onto it
 * (their sustain end is re-aligned too, so durations stay clean); entries that
 * are further out, ineligible, or already on the grid keep their exact tick.
 * After snapping, entries that now share a `keyOf` value are de-duplicated,
 * keeping the longest sustain. The returned list preserves first-seen order.
 */
export function snapEntriesToGrid<T extends { tick: number; duration: number }>(
  entries: T[],
  options: SnapEntriesOptions<T>
): SnapEntriesResult<T> {
  const { gridTicks, toleranceTicks, isEligible, keyOf } = options
  if (gridTicks <= 0) return { entries, changed: false }

  let changed = false

  const snapped = entries.map((entry) => {
    if (!isEligible(entry)) return entry
    const newTick = snapTickToGrid(entry.tick, gridTicks)
    const delta = newTick - entry.tick
    if (delta === 0 || Math.abs(delta) > toleranceTicks) return entry

    let newDuration = entry.duration
    if (entry.duration > 0) {
      newDuration = Math.max(0, snapTickToGrid(entry.tick + entry.duration, gridTicks) - newTick)
    }
    if (newTick === entry.tick && newDuration === entry.duration) return entry

    changed = true
    return { ...entry, tick: newTick, duration: newDuration }
  })

  // Collapse entries that now share a position, keeping the longest sustain.
  const byKey = new Map<string, T>()
  const order: string[] = []
  for (const entry of snapped) {
    const key = keyOf(entry)
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, entry)
      order.push(key)
    } else {
      if (entry.duration > existing.duration) byKey.set(key, entry)
      changed = true
    }
  }

  if (!changed) return { entries, changed: false }
  return { entries: order.map((key) => byKey.get(key)!), changed: true }
}
