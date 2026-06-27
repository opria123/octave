import { describe, it, expect } from 'vitest'
import {
  snapTickToGrid,
  gridTicksForDivision,
  snapEntriesToGrid,
  SNAP_TO_GRID_TOLERANCE_FRACTION
} from './snapToGrid'

interface TestNote {
  id: string
  tick: number
  duration: number
  lane: string
}

let idCounter = 0
const mkNote = (over: Partial<TestNote>): TestNote => ({
  id: `n${idCounter++}`,
  tick: 0,
  duration: 0,
  lane: 'snare',
  ...over
})

const snapAll = <T extends { tick: number; duration: number }>(
  entries: T[],
  gridTicks: number,
  keyOf: (e: T) => string,
  toleranceTicks = Infinity
): { entries: T[]; changed: boolean } =>
  snapEntriesToGrid(entries, { gridTicks, toleranceTicks, isEligible: () => true, keyOf })

describe('snapTickToGrid', () => {
  it('rounds to the nearest grid line', () => {
    expect(snapTickToGrid(482, 120)).toBe(480)
    expect(snapTickToGrid(540, 120)).toBe(600) // midpoint rounds up
    expect(snapTickToGrid(7, 15)).toBe(0)
    expect(snapTickToGrid(8, 15)).toBe(15)
  })

  it('returns the tick unchanged for a non-positive grid', () => {
    expect(snapTickToGrid(123, 0)).toBe(123)
  })
})

describe('gridTicksForDivision', () => {
  it('computes grid spacing at 480 PPQ', () => {
    expect(gridTicksForDivision(4)).toBe(120)
    expect(gridTicksForDivision(32)).toBe(15)
    expect(gridTicksForDivision(1)).toBe(480)
  })
})

describe('snapEntriesToGrid', () => {
  it('nudges a slightly-off note onto the nearest grid line', () => {
    const notes = [mkNote({ tick: 482, lane: 'snare' })]
    const { entries, changed } = snapAll(notes, 120, (n) => `${n.lane}|${n.tick}`)
    expect(changed).toBe(true)
    expect(entries[0].tick).toBe(480)
  })

  it('leaves genuinely off-grid notes untouched when within tolerance limits', () => {
    // gridTicks 120, tolerance 25% = 30 ticks. A note at 540 is 60 ticks from
    // either line (a real 1/8-label offbeat) and must NOT be dragged.
    const gridTicks = gridTicksForDivision(4)
    const tolerance = gridTicks * SNAP_TO_GRID_TOLERANCE_FRACTION
    const notes = [mkNote({ tick: 540, lane: 'snare' })]
    const { entries, changed } = snapAll(notes, gridTicks, (n) => `${n.lane}|${n.tick}`, tolerance)
    expect(changed).toBe(false)
    expect(entries[0].tick).toBe(540)
  })

  it('snaps a near-grid note but leaves a far one within the same pass', () => {
    const gridTicks = gridTicksForDivision(4)
    const tolerance = gridTicks * SNAP_TO_GRID_TOLERANCE_FRACTION
    const notes = [
      mkNote({ tick: 485, lane: 'snare' }), // 5 off -> snaps to 480
      mkNote({ tick: 540, lane: 'yellowTom' }) // 60 off -> stays
    ]
    const { entries } = snapAll(notes, gridTicks, (n) => `${n.lane}|${n.tick}`, tolerance)
    const snare = entries.find((n) => n.lane === 'snare')!
    const tom = entries.find((n) => n.lane === 'yellowTom')!
    expect(snare.tick).toBe(480)
    expect(tom.tick).toBe(540)
  })

  it('de-duplicates notes that collapse onto the same position (issue #22)', () => {
    // Two snare notes near tick 480 collapse onto 480 and must merge into one.
    const notes = [
      mkNote({ tick: 478, lane: 'snare', duration: 0 }),
      mkNote({ tick: 482, lane: 'snare', duration: 0 })
    ]
    const { entries, changed } = snapAll(notes, 120, (n) => `${n.lane}|${n.tick}`)
    expect(changed).toBe(true)
    expect(entries).toHaveLength(1)
    expect(entries[0].tick).toBe(480)
  })

  it('keeps the longest sustain when collapsing duplicates', () => {
    const notes = [
      mkNote({ tick: 478, lane: 'snare', duration: 30 }),
      mkNote({ tick: 482, lane: 'snare', duration: 200 })
    ]
    const { entries } = snapAll(notes, 120, (n) => `${n.lane}|${n.tick}`)
    expect(entries).toHaveLength(1)
    expect(entries[0].duration).toBeGreaterThanOrEqual(200)
  })

  it('does not merge notes on different lanes at the same tick (chords survive)', () => {
    const notes = [
      mkNote({ tick: 482, lane: 'snare' }),
      mkNote({ tick: 482, lane: 'yellowTom' })
    ]
    const { entries } = snapAll(notes, 120, (n) => `${n.lane}|${n.tick}`)
    expect(entries).toHaveLength(2)
    expect(entries.every((n) => n.tick === 480)).toBe(true)
  })

  it('re-aligns sustain ends so durations stay clean', () => {
    const notes = [mkNote({ tick: 482, lane: 'green', duration: 236 })] // ends at 718
    const { entries } = snapAll(notes, 120, (n) => `${n.lane}|${n.tick}`)
    expect(entries[0].tick).toBe(480)
    // 718 -> nearest 120 grid line is 720, so duration becomes 240.
    expect(entries[0].duration).toBe(240)
  })

  it('only snaps eligible (selected) entries', () => {
    const notes = [
      mkNote({ tick: 482, lane: 'snare', id: 'sel' }),
      mkNote({ tick: 482, lane: 'snare', id: 'other' })
    ]
    const selected = new Set(['sel'])
    const { entries } = snapEntriesToGrid(notes, {
      gridTicks: 120,
      toleranceTicks: Infinity,
      isEligible: (n) => selected.has(n.id),
      keyOf: (n) => `${n.lane}|${n.tick}`
    })
    const sel = entries.find((n) => n.id === 'sel')!
    const other = entries.find((n) => n.id === 'other')!
    expect(sel.tick).toBe(480)
    expect(other.tick).toBe(482)
  })

  it('reports no change when nothing needs snapping', () => {
    const notes = [mkNote({ tick: 480, lane: 'snare' })]
    const { entries, changed } = snapAll(notes, 120, (n) => `${n.lane}|${n.tick}`)
    expect(changed).toBe(false)
    expect(entries).toBe(notes)
  })
})
