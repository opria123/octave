import { describe, it, expect } from 'vitest'
import { generateFromExpert, DERIVED_DIFFICULTIES } from './difficultyReduction'
import type { Note, TempoEvent, DrumLane, GuitarLane, ProGuitarString } from '../types'

// 120 BPM: 1 beat = 500ms, 480 ticks per beat, so 1 tick ≈ 1.0417ms.
const TEMPO: TempoEvent[] = [{ tick: 0, bpm: 120 }]

let seq = 0
const mkNote = (over: Partial<Note>): Note => ({
  id: `n${seq++}`,
  tick: 0,
  duration: 0,
  instrument: 'drums',
  difficulty: 'expert',
  lane: 'snare',
  velocity: 100,
  ...over
})

/** A run of notes spaced `step` ticks apart. */
const run = (count: number, step: number, over: Partial<Note> = {}): Note[] =>
  Array.from({ length: count }, (_, i) => mkNote({ ...over, tick: i * step }))

const at = (notes: Note[], instrument: string, difficulty: string): Note[] =>
  notes.filter((n) => n.instrument === instrument && n.difficulty === difficulty)

describe('generateFromExpert', () => {
  describe('general behaviour', () => {
    it('leaves the expert chart untouched', () => {
      const expert = run(16, 120, { instrument: 'guitar', lane: 'green', duration: 60 })
      const { notes } = generateFromExpert(expert, TEMPO)

      const expertOut = at(notes, 'guitar', 'expert')
      expect(expertOut).toHaveLength(16)
      expect(expertOut.map((n) => n.tick)).toEqual(expert.map((n) => n.tick))
    })

    it('produces monotonically sparser charts down the difficulties', () => {
      const expert = run(64, 120, { instrument: 'guitar', lane: 'green', duration: 60 })
      const { notes } = generateFromExpert(expert, TEMPO)

      const hard = at(notes, 'guitar', 'hard').length
      const medium = at(notes, 'guitar', 'medium').length
      const easy = at(notes, 'guitar', 'easy').length

      expect(hard).toBeLessThan(64)
      expect(medium).toBeLessThanOrEqual(hard)
      expect(easy).toBeLessThanOrEqual(medium)
      expect(easy).toBeGreaterThan(0)
    })

    it('is deterministic — re-running yields the same ticks and lanes', () => {
      const expert = run(40, 90, { instrument: 'guitar', lane: 'red', duration: 45 })
      const first = generateFromExpert(expert, TEMPO).notes
      const second = generateFromExpert(expert, TEMPO).notes

      const shape = (ns: Note[]): string =>
        ns
          .filter((n) => n.difficulty !== 'expert')
          .map((n) => `${n.difficulty}:${n.tick}:${n.lane}:${n.duration}`)
          .sort()
          .join('|')

      expect(shape(first)).toBe(shape(second))
    })

    it('replaces existing lower difficulties rather than stacking onto them', () => {
      const expert = run(16, 120, { instrument: 'guitar', lane: 'green' })
      const staleHard = run(3, 480, { instrument: 'guitar', lane: 'orange', difficulty: 'hard' })
      const { notes } = generateFromExpert([...expert, ...staleHard], TEMPO)

      const hard = at(notes, 'guitar', 'hard')
      expect(hard.some((n) => n.lane === 'orange')).toBe(false)
    })

    it('assigns fresh ids so generated notes are independent of their source', () => {
      const expert = run(8, 240, { instrument: 'guitar', lane: 'green' })
      const { notes } = generateFromExpert(expert, TEMPO)

      const ids = notes.map((n) => n.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('skips an instrument with no expert notes and leaves its other difficulties alone', () => {
      const orphanHard = run(4, 240, { instrument: 'bass', lane: 'green', difficulty: 'hard' })
      const { notes, skipped } = generateFromExpert(orphanHard, TEMPO)

      expect(skipped).toContain('bass')
      expect(at(notes, 'bass', 'hard')).toHaveLength(4)
    })

    it('only touches the instruments and targets it was asked for', () => {
      const guitar = run(16, 120, { instrument: 'guitar', lane: 'green' })
      const drums = run(16, 120, { instrument: 'drums', lane: 'snare' })
      const { notes } = generateFromExpert([...guitar, ...drums], TEMPO, {
        instruments: ['guitar'],
        targets: ['hard']
      })

      expect(at(notes, 'guitar', 'hard').length).toBeGreaterThan(0)
      expect(at(notes, 'guitar', 'medium')).toHaveLength(0)
      expect(at(notes, 'drums', 'hard')).toHaveLength(0)
    })

    it('reports what it generated per instrument and difficulty', () => {
      const drums = run(24, 240, { instrument: 'drums', lane: 'snare' })
      const { generated } = generateFromExpert(drums, TEMPO, { instruments: ['drums'] })

      expect(Object.keys(generated)).toEqual(['drums'])
      for (const d of DERIVED_DIFFICULTIES) {
        expect(generated.drums[d]).toBeGreaterThan(0)
      }
    })
  })

  describe('drums', () => {
    it('drops ghost notes on hard', () => {
      // Well-spaced so only the ghost rule can remove anything.
      const expert = [
        mkNote({ tick: 0, lane: 'snare' }),
        mkNote({ tick: 480, lane: 'snare', flags: { isGhost: true } }),
        mkNote({ tick: 960, lane: 'snare', velocity: 40 }),
        mkNote({ tick: 1440, lane: 'snare' })
      ]
      const { notes } = generateFromExpert(expert, TEMPO, { targets: ['hard'] })

      expect(at(notes, 'drums', 'hard').map((n) => n.tick)).toEqual([0, 1440])
    })

    it('removes double kick by medium', () => {
      const expert = [
        mkNote({ tick: 0, lane: 'kick' }),
        mkNote({ tick: 480, lane: 'kick', flags: { isDoubleKick: true } }),
        mkNote({ tick: 960, lane: 'kick' })
      ]
      const { notes } = generateFromExpert(expert, TEMPO, { targets: ['medium'] })

      const medium = at(notes, 'drums', 'medium')
      expect(medium.every((n) => !n.flags?.isDoubleKick)).toBe(true)
      expect(medium.map((n) => n.tick)).not.toContain(480)
    })

    it('leaves easy with kick and snare only, folding cymbals away', () => {
      const lanes: DrumLane[] = [
        'kick',
        'snare',
        'yellowCymbal',
        'blueTom',
        'greenCymbal',
        'kick',
        'snare'
      ]
      const expert = lanes.map((lane, i) => mkNote({ tick: i * 480, lane, velocity: 110 }))
      const { notes } = generateFromExpert(expert, TEMPO, { targets: ['easy'] })

      const easy = at(notes, 'drums', 'easy')
      expect(easy.length).toBeGreaterThan(0)
      expect(easy.every((n) => n.lane === 'kick' || n.lane === 'snare')).toBe(true)
      expect(easy.every((n) => !n.flags?.isCymbal)).toBe(true)
    })

    it('thins a fast hi-hat pattern on hard', () => {
      // 16ths at 120 BPM = 125ms apart, inside the 150ms "fast pattern" window.
      const expert = run(12, 120, { lane: 'yellowCymbal', velocity: 100 })
      const { notes } = generateFromExpert(expert, TEMPO, { targets: ['hard'] })

      expect(at(notes, 'drums', 'hard').length).toBeLessThan(12)
    })
  })

  describe('guitar and bass', () => {
    it('caps frets at blue on hard and yellow on easy', () => {
      const lanes: GuitarLane[] = ['green', 'red', 'yellow', 'blue', 'orange']
      // Spaced a beat apart so nothing is thinned away before the cap is checked.
      const expert = lanes.map((lane, i) =>
        mkNote({ tick: i * 480, lane, instrument: 'guitar', duration: 0 })
      )
      const { notes } = generateFromExpert(expert, TEMPO)

      const laneOf = (d: string): string[] => at(notes, 'guitar', d).map((n) => String(n.lane))
      expect(laneOf('hard')).not.toContain('orange')
      expect(laneOf('easy')).not.toContain('orange')
      expect(laneOf('easy')).not.toContain('blue')
    })

    it('reduces chords to single notes on easy', () => {
      const chord = [
        mkNote({ tick: 0, lane: 'green', instrument: 'guitar' }),
        mkNote({ tick: 0, lane: 'red', instrument: 'guitar' }),
        mkNote({ tick: 0, lane: 'yellow', instrument: 'guitar' })
      ]
      const { notes } = generateFromExpert(chord, TEMPO, { targets: ['easy'] })

      expect(at(notes, 'guitar', 'easy')).toHaveLength(1)
    })

    it('never emits a forbidden green+orange two-note chord on hard', () => {
      const chord = [
        mkNote({ tick: 0, lane: 'green', instrument: 'guitar' }),
        mkNote({ tick: 0, lane: 'orange', instrument: 'guitar' })
      ]
      const { notes } = generateFromExpert(chord, TEMPO, { targets: ['hard'] })

      const lanes = at(notes, 'guitar', 'hard').map((n) => n.lane)
      expect(lanes.includes('green') && lanes.includes('orange')).toBe(false)
    })

    it('preserves open notes instead of remapping them to a fret', () => {
      const expert = [
        mkNote({ tick: 0, lane: 'open', instrument: 'bass' }),
        mkNote({ tick: 960, lane: 'open', instrument: 'bass' }),
        mkNote({ tick: 1920, lane: 'open', instrument: 'bass' })
      ]
      const { notes } = generateFromExpert(expert, TEMPO, { targets: ['hard'] })

      const hard = at(notes, 'bass', 'hard')
      expect(hard.length).toBeGreaterThan(0)
      expect(hard.every((n) => n.lane === 'open')).toBe(true)
    })

    it('thins bass more gently than guitar', () => {
      const guitar = run(48, 120, { instrument: 'guitar', lane: 'green' })
      const bass = run(48, 120, { instrument: 'bass', lane: 'green' })
      const { notes } = generateFromExpert([...guitar, ...bass], TEMPO, { targets: ['hard'] })

      expect(at(notes, 'bass', 'hard').length).toBeGreaterThan(at(notes, 'guitar', 'hard').length)
    })

    it('strips taps everywhere and hopos below hard', () => {
      const expert = run(12, 480, {
        instrument: 'guitar',
        lane: 'green',
        flags: { isHOPO: true, isTap: true }
      })
      const { notes } = generateFromExpert(expert, TEMPO)

      expect(at(notes, 'guitar', 'hard').every((n) => !n.flags?.isTap)).toBe(true)
      expect(at(notes, 'guitar', 'medium').every((n) => !n.flags?.isHOPO)).toBe(true)
      expect(at(notes, 'guitar', 'easy').every((n) => !n.flags?.isHOPO)).toBe(true)
    })

    it('never lets a sustain run into the next note', () => {
      // Overlapping sustains: each note is 2 beats long but only 1 beat apart.
      const expert = run(8, 480, { instrument: 'guitar', lane: 'green', duration: 960 })
      const { notes } = generateFromExpert(expert, TEMPO, { targets: ['hard'] })

      const hard = at(notes, 'guitar', 'hard').sort((a, b) => a.tick - b.tick)
      for (let i = 0; i < hard.length - 1; i++) {
        expect(hard[i].tick + hard[i].duration).toBeLessThan(hard[i + 1].tick)
      }
    })
  })

  describe('keys and pro keys', () => {
    it('thins keys and shrinks chord voicings on the way down', () => {
      const chords = Array.from({ length: 12 }, (_, i) => [
        mkNote({ tick: i * 480, lane: 'green', instrument: 'keys' }),
        mkNote({ tick: i * 480, lane: 'red', instrument: 'keys' }),
        mkNote({ tick: i * 480, lane: 'yellow', instrument: 'keys' })
      ]).flat()
      const { notes } = generateFromExpert(chords, TEMPO, { instruments: ['keys'] })

      const perTick = (d: string): number[] => {
        const counts = new Map<number, number>()
        for (const n of at(notes, 'keys', d)) counts.set(n.tick, (counts.get(n.tick) ?? 0) + 1)
        return [...counts.values()]
      }

      expect(perTick('medium').every((c) => c <= 2)).toBe(true)
      expect(perTick('easy').every((c) => c === 1)).toBe(true)
    })

    it('keeps pro keys pitches intact rather than remapping them', () => {
      const expert = run(24, 240, { instrument: 'proKeys', lane: 60 })
      const { notes } = generateFromExpert(expert, TEMPO, { instruments: ['proKeys'] })

      const derived = notes.filter((n) => n.instrument === 'proKeys' && n.difficulty !== 'expert')
      expect(derived.length).toBeGreaterThan(0)
      expect(derived.every((n) => n.lane === 60)).toBe(true)
    })

    it('leaves pro keys easy as a single voice per onset', () => {
      const voicings = Array.from({ length: 9 }, (_, i) => [
        mkNote({ tick: i * 480, lane: 48, instrument: 'proKeys' }),
        mkNote({ tick: i * 480, lane: 55, instrument: 'proKeys' }),
        mkNote({ tick: i * 480, lane: 64, instrument: 'proKeys' })
      ]).flat()
      const { notes } = generateFromExpert(voicings, TEMPO, {
        instruments: ['proKeys'],
        targets: ['easy']
      })

      const counts = new Map<number, number>()
      for (const n of at(notes, 'proKeys', 'easy')) counts.set(n.tick, (counts.get(n.tick) ?? 0) + 1)
      expect([...counts.values()].every((c) => c === 1)).toBe(true)
    })
  })

  describe('pro guitar and pro bass', () => {
    it('never transposes a fret', () => {
      const expert = run(16, 240, { instrument: 'proGuitar', lane: 0, string: 5, fret: 12 })
      const { notes } = generateFromExpert(expert, TEMPO, { instruments: ['proGuitar'] })

      const derived = notes.filter((n) => n.instrument === 'proGuitar' && n.difficulty !== 'expert')
      expect(derived.length).toBeGreaterThan(0)
      expect(derived.every((n) => n.fret === 12 && n.string === 5)).toBe(true)
    })

    it('shrinks voicings to a single low string on easy', () => {
      const voicings = Array.from({ length: 9 }, (_, i) =>
        ([6, 5, 4, 3] as ProGuitarString[]).map((string) =>
          mkNote({ tick: i * 480, lane: 0, instrument: 'proGuitar', string, fret: 3 })
        )
      ).flat()
      const { notes } = generateFromExpert(voicings, TEMPO, {
        instruments: ['proGuitar'],
        targets: ['easy']
      })

      const easy = at(notes, 'proGuitar', 'easy')
      const counts = new Map<number, number>()
      for (const n of easy) counts.set(n.tick, (counts.get(n.tick) ?? 0) + 1)
      expect([...counts.values()].every((c) => c === 1)).toBe(true)
      expect(easy.every((n) => n.string === 6)).toBe(true)
    })

    it('caps hard voicings at four strings', () => {
      const voicings = Array.from({ length: 6 }, (_, i) =>
        ([6, 5, 4, 3, 2, 1] as ProGuitarString[]).map((string) =>
          mkNote({ tick: i * 960, lane: 0, instrument: 'proBass', string, fret: 5 })
        )
      ).flat()
      const { notes } = generateFromExpert(voicings, TEMPO, {
        instruments: ['proBass'],
        targets: ['hard']
      })

      const counts = new Map<number, number>()
      for (const n of at(notes, 'proBass', 'hard')) counts.set(n.tick, (counts.get(n.tick) ?? 0) + 1)
      expect([...counts.values()].every((c) => c <= 4)).toBe(true)
    })
  })

  describe('tempo handling', () => {
    it('applies ms-based rules against the tempo map, not a fixed bpm', () => {
      // Identical tick spacing, different tempo: 240 ticks is 150ms at 200 BPM
      // (a fast passage, thinned hardest) but 500ms at 60 BPM (a moderate one).
      const fast = generateFromExpert(run(32, 240, { instrument: 'guitar', lane: 'green' }), [
        { tick: 0, bpm: 200 }
      ])
      const slow = generateFromExpert(run(32, 240, { instrument: 'guitar', lane: 'green' }), [
        { tick: 0, bpm: 60 }
      ])

      const fastEasy = fast.notes.filter(
        (n) => n.instrument === 'guitar' && n.difficulty === 'easy'
      ).length
      const slowEasy = slow.notes.filter(
        (n) => n.instrument === 'guitar' && n.difficulty === 'easy'
      ).length

      // Slower tempo = wider real-world gaps = less thinning.
      expect(slowEasy).toBeGreaterThan(fastEasy)
    })
  })
})
