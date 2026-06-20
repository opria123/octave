import { describe, it, expect } from 'vitest'
import { validateChart, validateChartAsync } from './chartValidation'
import type { Note, SongData } from '../types'

describe('chartValidation', () => {
  const mkNote = (over: Partial<Note>): Note => ({
    id: `note-${Math.random().toString(36).substring(2, 9)}`,
    tick: 0,
    duration: 0,
    instrument: 'drums',
    difficulty: 'expert',
    lane: 'snare',
    velocity: 100,
    ...over
  })

  const mkGuitarNote = (over: Partial<Note>): Note => ({
    id: `note-${Math.random().toString(36).substring(2, 9)}`,
    tick: 0,
    duration: 120,
    instrument: 'guitar',
    difficulty: 'expert',
    lane: 'green',
    velocity: 100,
    ...over
  })

  const mockSong = (notes: Note[]): SongData =>
    ({
      notes,
      starPowerPhrases: [],
      vocalNotes: [],
      tempoEvents: [{ tick: 0, bpm: 120 }] // 120 BPM means 1 beat = 500ms, so 1 tick = 500/480 = 1.0416ms
    }) as unknown as SongData

  it('detects overlapping notes', () => {
    const song = mockSong([
      mkGuitarNote({ tick: 120, lane: 'green' }),
      mkGuitarNote({ tick: 120, lane: 'green' })
    ])
    const issues = validateChart(song, {
      validationEnableOverlapsCheck: true,
      validationEnableStarPowerCheck: false
    })
    expect(issues.some((i) => i.message.includes('Overlapping note'))).toBe(true)
  })

  it('detects short sustains on guitar', () => {
    const song = mockSong([
      mkGuitarNote({ tick: 120, duration: 10 }) // min threshold is 48
    ])
    const issues = validateChart(song, {
      validationMinSustainGuitar: 48,
      validationEnableStarPowerCheck: false
    })
    expect(issues.some((i) => i.message.includes('Very short sustain'))).toBe(true)
  })

  it('detects three or more simultaneous hand hits on drums', () => {
    const song = mockSong([
      mkNote({ tick: 120, lane: 'snare' }),
      mkNote({ tick: 120, lane: 'yellowTom' }),
      mkNote({ tick: 120, lane: 'blueTom' })
    ])
    const issues = validateChart(song, {
      validationEnableDrumImpossibilityCheck: true,
      validationEnableStarPowerCheck: false
    })
    expect(issues.some((i) => i.message.includes('Three or more simultaneous hand hits'))).toBe(
      true
    )
  })

  it('detects physically impossible transition on same hand', () => {
    // 120 BPM tempo: 1 tick = 1.0416ms
    // Snare (LH) and Yellow Tom (RH) at t=0
    // Snare (LH) and Blue Tom (LH) transition at t=20 (20 ticks = 20.8ms)
    // Snare to Blue Tom (distance 2, limit 40ms, cymbal = false)
    const song = mockSong([
      // Chord 1 at tick 120
      mkNote({ tick: 120, lane: 'snare' }), // LH
      mkNote({ tick: 120, lane: 'yellowTom' }), // RH
      // Chord 2 at tick 140 (20 ticks later = 20.8ms)
      mkNote({ tick: 140, lane: 'blueTom' }), // LH or RH transition
      mkNote({ tick: 140, lane: 'greenTom' })
    ])
    const issues = validateChart(song, {
      validationEnableDrumImpossibilityCheck: true,
      validationDrumTimeThresholdMs: 40,
      validationDrumCrossoverThresholdMs: 80,
      validationEnableStarPowerCheck: false
    })

    expect(
      issues.some((i) => i.message.includes('Physically impossible transition between pads'))
    ).toBe(true)
  })

  it('does NOT flag alternating fast rolls as violations', () => {
    // Alternating Snare -> Yellow -> Blue -> Green roll at 30 ticks intervals (31.25ms)
    // This alternating pattern is played as: LH -> RH -> LH -> RH
    // Consecutive hits on LH: Snare (120) to Blue (180), dt = 60 ticks = 62.5ms (limit 40ms) -> possible!
    // Consecutive hits on RH: Yellow (150) to Green (210), dt = 60 ticks = 62.5ms (limit 40ms) -> possible!
    const song = mockSong([
      mkNote({ tick: 120, lane: 'snare' }),
      mkNote({ tick: 150, lane: 'yellowTom' }),
      mkNote({ tick: 180, lane: 'blueTom' }),
      mkNote({ tick: 210, lane: 'greenTom' })
    ])
    const issues = validateChart(song, {
      validationEnableDrumImpossibilityCheck: true,
      validationDrumTimeThresholdMs: 40,
      validationDrumCrossoverThresholdMs: 80,
      validationEnableStarPowerCheck: false
    })
    expect(issues.filter((i) => i.severity === 'error' || i.severity === 'warning').length).toBe(0)
  })

  it('does NOT flag simultaneous cymbal hits as crossovers', () => {
    // Simultaneous Yellow Cymbal and Green Cymbal played repeatedly at 50ms intervals
    // LH stays on Yellow Cymbal, RH stays on Green Cymbal. No transitions.
    const song = mockSong([
      mkNote({ tick: 120, lane: 'yellowCymbal' }), // LH
      mkNote({ tick: 120, lane: 'greenCymbal' }), // RH

      mkNote({ tick: 170, lane: 'yellowCymbal' }), // LH
      mkNote({ tick: 170, lane: 'greenCymbal' }), // RH

      mkNote({ tick: 220, lane: 'yellowCymbal' }), // LH
      mkNote({ tick: 220, lane: 'greenCymbal' }) // RH
    ])
    const issues = validateChart(song, {
      validationEnableDrumImpossibilityCheck: true,
      validationDrumTimeThresholdMs: 40,
      validationDrumCrossoverThresholdMs: 80,
      validationEnableStarPowerCheck: false
    })
    expect(issues.filter((i) => i.severity === 'error' || i.severity === 'warning').length).toBe(0)
  })

  it('handles validation engine errors gracefully', () => {
    const issues = validateChart(null as unknown as SongData)
    expect(
      issues.some((i) => i.severity === 'error' && i.message.includes('No song data provided.'))
    ).toBe(true)
  })

  it('validateChartAsync falls back to sync or runs worker successfully', async () => {
    const song = mockSong([
      mkGuitarNote({ tick: 120, lane: 'green' }),
      mkGuitarNote({ tick: 120, lane: 'green' })
    ])
    const issues = await validateChartAsync(song, {
      validationEnableOverlapsCheck: true,
      validationEnableStarPowerCheck: false
    })
    expect(issues.some((i) => i.message.includes('Overlapping note'))).toBe(true)
  })
})
