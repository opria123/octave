import { describe, it, expect } from 'vitest'
import { parseMidiBase64, serializeMidiBase64, parseChartFile, serializeChartFile } from './midiParser'
import type { LaneMarker, Note } from '../types'

// Issue #12: open frets and tap notes reverted to green/strums after a
// save → reopen round-trip because serializeMidiBase64 dropped them.
describe('open fret / tap note MIDI round-trip', () => {
  const mkNote = (over: Partial<Note>): Note => ({
    id: 'x',
    tick: 0,
    duration: 120,
    instrument: 'guitar',
    difficulty: 'expert',
    lane: 'green',
    velocity: 100,
    ...over
  })

  it('preserves open frets and taps across serialize → parse', () => {
    const notes: Note[] = [
      mkNote({ tick: 0, lane: 'open' }),
      mkNote({ tick: 480, lane: 'red', flags: { isTap: true } }),
      mkNote({ tick: 960, lane: 'orange' }),
      mkNote({ tick: 1440, lane: 'open', flags: { isTap: true } }),
      mkNote({ tick: 1920, lane: 'open', difficulty: 'hard', instrument: 'bass' }),
      mkNote({ tick: 1920, lane: 'green', difficulty: 'expert', instrument: 'bass' })
    ]
    const b64 = serializeMidiBase64(notes, [{ tick: 0, bpm: 120 }], [{ tick: 0, numerator: 4, denominator: 4 }])
    const parsed = parseMidiBase64(b64)

    const find = (tick: number, instrument: string, difficulty: string): Note | undefined =>
      parsed.notes.find((n) => n.tick === tick && n.instrument === instrument && n.difficulty === difficulty)

    expect(find(0, 'guitar', 'expert')?.lane).toBe('open')
    expect(find(0, 'guitar', 'expert')?.flags?.isTap).toBeFalsy()
    expect(find(480, 'guitar', 'expert')?.lane).toBe('red')
    expect(find(480, 'guitar', 'expert')?.flags?.isTap).toBe(true)
    expect(find(960, 'guitar', 'expert')?.lane).toBe('orange')
    expect(find(960, 'guitar', 'expert')?.flags?.isTap).toBeFalsy()
    expect(find(1440, 'guitar', 'expert')?.lane).toBe('open')
    expect(find(1440, 'guitar', 'expert')?.flags?.isTap).toBe(true)
    // PS phrases are per-difficulty: hard bass open must not affect the
    // expert bass green note at the same tick.
    expect(find(1920, 'bass', 'hard')?.lane).toBe('open')
    expect(find(1920, 'bass', 'expert')?.lane).toBe('green')
  })

  it('survives a double round-trip', () => {
    const notes: Note[] = [
      mkNote({ tick: 0, lane: 'open' }),
      mkNote({ tick: 480, lane: 'yellow', flags: { isTap: true } })
    ]
    const once = parseMidiBase64(
      serializeMidiBase64(notes, [{ tick: 0, bpm: 120 }], [{ tick: 0, numerator: 4, denominator: 4 }])
    )
    const twice = parseMidiBase64(
      serializeMidiBase64(once.notes, once.tempoEvents, once.timeSignatures)
    )
    expect(twice.notes.find((n) => n.tick === 0)?.lane).toBe('open')
    expect(twice.notes.find((n) => n.tick === 480)?.flags?.isTap).toBe(true)
  })
})

// Issue #37: BRE sections and drum rolls disappeared after a save → reopen
// round-trip because both serializers dropped lane markers entirely.
describe('lane marker round-trip', () => {
  const tempo = [{ tick: 0, bpm: 120 }]
  const timeSig = [{ tick: 0, numerator: 4, denominator: 4 }]
  const mkNote = (over: Partial<Note>): Note => ({
    id: 'x',
    tick: 0,
    duration: 120,
    instrument: 'guitar',
    difficulty: 'expert',
    lane: 'green',
    velocity: 100,
    ...over
  })
  const mkMarker = (over: Partial<LaneMarker>): LaneMarker => ({
    id: 'm',
    tick: 960,
    duration: 480,
    instrument: 'drums',
    type: 'drumRoll',
    ...over
  })
  // The serializers only emit tracks that contain notes, so seed one per instrument.
  const notes: Note[] = [
    mkNote({ instrument: 'drums', lane: 'kick' }),
    mkNote({ instrument: 'guitar', lane: 'green' })
  ]

  const findMarker = (
    markers: LaneMarker[],
    instrument: string,
    type: string
  ): LaneMarker | undefined =>
    markers.find((m) => m.instrument === instrument && m.type === type)

  it('preserves BRE and drum roll markers across MIDI serialize → parse', () => {
    const markers: LaneMarker[] = [
      mkMarker({ tick: 960, type: 'drumRoll' }),
      mkMarker({ tick: 1920, type: 'bre' }),
      mkMarker({ tick: 960, instrument: 'guitar', type: 'tremolo' }),
      mkMarker({ tick: 1920, instrument: 'guitar', type: 'trill' }),
      mkMarker({ tick: 2880, instrument: 'guitar', type: 'bre' })
    ]
    const parsed = parseMidiBase64(
      serializeMidiBase64(notes, tempo, timeSig, 480, [], [], [], [], [], markers)
    )

    expect(findMarker(parsed.laneMarkers, 'drums', 'drumRoll')).toMatchObject({ tick: 960, duration: 480 })
    expect(findMarker(parsed.laneMarkers, 'drums', 'bre')).toMatchObject({ tick: 1920, duration: 480 })
    expect(findMarker(parsed.laneMarkers, 'guitar', 'tremolo')).toMatchObject({ tick: 960 })
    expect(findMarker(parsed.laneMarkers, 'guitar', 'trill')).toMatchObject({ tick: 1920 })
    expect(findMarker(parsed.laneMarkers, 'guitar', 'bre')).toMatchObject({ tick: 2880 })
    // The BRE companion notes (121-124) must not leak into playable notes.
    expect(parsed.notes).toHaveLength(notes.length)
  })

  it('preserves drum fill/roll markers across .chart serialize → parse', () => {
    const markers: LaneMarker[] = [
      mkMarker({ tick: 960, type: 'drumRoll' }),
      mkMarker({ tick: 1920, type: 'bre' })
    ]
    const parsed = parseChartFile(
      serializeChartFile(notes, tempo, timeSig, [], [], [], [], [], {}, 192, markers)
    )

    expect(findMarker(parsed.laneMarkers, 'drums', 'drumRoll')).toMatchObject({ tick: 960, duration: 480 })
    expect(findMarker(parsed.laneMarkers, 'drums', 'bre')).toMatchObject({ tick: 1920, duration: 480 })
  })
})
