import type { SongData, Note, Instrument, Difficulty } from '../types'

export interface ValidationIssue {
  severity: 'error' | 'warning'
  message: string
  tick?: number
  instrument?: Instrument
  difficulty?: Difficulty
}

// Major sustain threshold in ticks (480 PPQ = 1 beat at 120BPM)
const MIN_SUSTAIN_TICKS = 48 // ~1/10 beat — shorter is probably a data glitch

export function validateChart(song: SongData): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const { notes, starPowerPhrases, vocalNotes, tempoEvents } = song

  if (notes.length === 0 && vocalNotes.length === 0) {
    issues.push({ severity: 'warning', message: 'Chart has no notes on any instrument.' })
    return issues
  }

  // --- 1. Overlapping notes (same instrument + difficulty + lane at same tick) ---
  const noteMap = new Map<string, Note>()
  for (const note of notes) {
    const key = `${note.instrument}|${note.difficulty}|${note.lane}|${note.tick}`
    if (noteMap.has(key)) {
      issues.push({
        severity: 'error',
        message: `Overlapping note at tick ${note.tick} (${note.instrument} ${note.difficulty} lane ${note.lane})`,
        tick: note.tick,
        instrument: note.instrument,
        difficulty: note.difficulty
      })
    } else {
      noteMap.set(key, note)
    }
  }

  // --- 2. Very short sustains (likely authoring mistake) ---
  for (const note of notes) {
    if (note.duration > 0 && note.duration < MIN_SUSTAIN_TICKS) {
      issues.push({
        severity: 'warning',
        message: `Very short sustain (${note.duration} ticks) at tick ${note.tick} on ${note.instrument} ${note.difficulty}`,
        tick: note.tick,
        instrument: note.instrument,
        difficulty: note.difficulty
      })
    }
  }

  // --- 3. Instruments with notes but no star power ---
  const instrumentsWithNotes = new Set<string>()
  for (const note of notes) {
    instrumentsWithNotes.add(`${note.instrument}|${note.difficulty}`)
  }
  const instrumentsWithSP = new Set<string>()
  for (const sp of starPowerPhrases) {
    // SP applies across difficulties for the instrument
    for (const diff of ['expert', 'hard', 'medium', 'easy'] as Difficulty[]) {
      instrumentsWithSP.add(`${sp.instrument}|${diff}`)
    }
  }
  for (const key of instrumentsWithNotes) {
    if (!instrumentsWithSP.has(key)) {
      const [inst, diff] = key.split('|')
      issues.push({
        severity: 'warning',
        message: `No star power phrases for ${inst} (${diff})`,
        instrument: inst as Instrument,
        difficulty: diff as Difficulty
      })
    }
  }

  // --- 4. Notes beyond end of tempo map last event (possible missing tempo) ---
  const lastTempoTick = tempoEvents.length > 0 ? tempoEvents[tempoEvents.length - 1].tick : 0
  if (notes.length > 0) {
    const lastNoteTick = notes[notes.length - 1].tick
    if (lastTempoTick > 0 && lastNoteTick > lastTempoTick * 4) {
      issues.push({
        severity: 'warning',
        message: `Notes extend far beyond last tempo event (last note: tick ${lastNoteTick}, last tempo: tick ${lastTempoTick}). Check tempo map.`
      })
    }
  }

  // --- 5. Notes during the same tick on the same instrument/difficulty (chord check for single-note instruments) ---
  // Guitar/bass should generally only have one note per lane per tick — but chords are valid, so skip.

  // --- 6. Vocal notes with no lyrics (except percussion) ---
  const vocalNotesWithoutLyric = vocalNotes.filter(n => !n.isPercussion && !n.lyric)
  if (vocalNotesWithoutLyric.length > 5) {
    issues.push({
      severity: 'warning',
      message: `${vocalNotesWithoutLyric.length} vocal notes have no lyric text.`,
      instrument: 'vocals'
    })
  }

  return issues
}
