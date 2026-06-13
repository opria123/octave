import { describe, it, expect } from 'vitest'
import { parseMidiBase64, serializeMidiBase64 } from './midiParser'
import type { Note } from '../types'

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
