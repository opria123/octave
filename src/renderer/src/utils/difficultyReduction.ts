// Difficulty reduction — derive Hard / Medium / Easy from an Expert chart.
//
// These rules are a TypeScript port of the reducers STRUM already runs during
// Auto-Chart (strum: src/export/midi.py `_reduce_to_hard/_medium/_easy`,
// src/inference/guitar_bass.py `reduce_to_difficulty`, src/inference/c3_rules.py,
// and the keys / pro-keys stride reduction in scripts/batch_pipeline.py). They
// live here rather than behind an IPC call into the Python worker so that
// reduction works on hand-authored and imported charts without bootstrapping
// the Auto-Chart runtime, runs instantly, and folds into a single undo entry.
//
// Everything in this file is pure: same input notes + tempo map → same output,
// no randomness, no clock. That keeps generated difficulties reproducible, so
// re-running on an unchanged Expert chart is a no-op rather than a reshuffle.
import { v4 as uuidv4 } from 'uuid'
import { tickToMs } from './chartValidation'
import type {
  Note,
  Difficulty,
  DrumLane,
  GuitarLane,
  Instrument,
  TempoEvent,
  ProGuitarString
} from '../types'

/** Difficulties this module can derive. Expert is the source, never a target. */
export type DerivedDifficulty = Exclude<Difficulty, 'expert'>

export const DERIVED_DIFFICULTIES: DerivedDifficulty[] = ['hard', 'medium', 'easy']

/**
 * Instruments reduction understands. Vocals are absent on purpose: CH/RB have
 * no per-difficulty vocal charts, and OCTAVE stores vocals in a separate
 * `vocalNotes` array anyway.
 */
export const REDUCIBLE_INSTRUMENTS: Instrument[] = [
  'drums',
  'guitar',
  'bass',
  'keys',
  'proKeys',
  'proGuitar',
  'proBass'
]

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** A note paired with its wall-clock position, so ms-based rules can be applied. */
interface TimedNote {
  note: Note
  ms: number
  endMs: number
}

function withTimes(notes: Note[], tempoEvents: TempoEvent[]): TimedNote[] {
  return notes
    .map((note) => ({
      note,
      ms: tickToMs(note.tick, tempoEvents),
      endMs: tickToMs(note.tick + note.duration, tempoEvents)
    }))
    .sort((a, b) => a.ms - b.ms || String(a.note.lane).localeCompare(String(b.note.lane)))
}

/**
 * Local tempo at a tick, used by the C3 sustain/gap rules. STRUM works from a
 * single global BPM; charts in the editor can have a full tempo map, so we take
 * the tempo in force at each note instead of assuming one.
 */
function bpmAt(tick: number, tempoEvents: TempoEvent[]): number {
  if (tempoEvents.length === 0) return 120
  let bpm = tempoEvents[0].bpm
  for (const ev of tempoEvents) {
    if (ev.tick > tick) break
    bpm = ev.bpm
  }
  return bpm > 0 ? bpm : 120
}

/** Rebuild a note at a target difficulty. New id — difficulties are independent rows. */
function derive(note: Note, difficulty: DerivedDifficulty, overrides: Partial<Note> = {}): Note {
  return {
    ...note,
    ...overrides,
    id: uuidv4(),
    difficulty
  }
}

/** Group notes that share an onset tick — a chord in the editor's model. */
function groupByTick(timed: TimedNote[]): TimedNote[][] {
  const groups: TimedNote[][] = []
  for (const item of timed) {
    const last = groups[groups.length - 1]
    if (last && last[0].note.tick === item.note.tick) last.push(item)
    else groups.push([item])
  }
  return groups
}

// ─── Drums ───────────────────────────────────────────────────────────────────

// STRUM reduces on lane indices 0-4 (kick / snare / hi-hat / blue / green).
// OCTAVE names its lanes and splits tom vs cymbal, so map into STRUM's space to
// keep the thresholds meaning the same thing.
const DRUM_LANE_INDEX: Record<DrumLane, number> = {
  kick: 0,
  snare: 1,
  yellowTom: 2,
  yellowCymbal: 2,
  blueTom: 3,
  blueCymbal: 3,
  greenTom: 4,
  greenCymbal: 4
}

/** Cymbal lanes collapse to their tom counterpart when Easy drops cymbals. */
const CYMBAL_TO_TOM: Partial<Record<DrumLane, DrumLane>> = {
  yellowCymbal: 'yellowTom',
  blueCymbal: 'blueTom',
  greenCymbal: 'greenTom'
}

function laneIndexOf(note: Note): number {
  return DRUM_LANE_INDEX[note.lane as DrumLane] ?? 1
}

/**
 * Hard (~75% of Expert): drop ghost notes, drop very fast repeats on a lane,
 * thin dense hi-hat. Mirrors strum `_reduce_to_hard`.
 */
function reduceDrumsToHard(timed: TimedNote[]): TimedNote[] {
  const out: TimedNote[] = []
  const lastHit: Record<number, number> = { 0: -1000, 1: -1000, 2: -1000, 3: -1000, 4: -1000 }
  let hihatCount = 0
  let prevHihat = -1000

  for (const item of timed) {
    const lane = laneIndexOf(item.note)

    // Ghost notes: STRUM only has velocity to go on; the editor also has an
    // explicit flag, so honour either signal.
    if (item.note.flags?.isGhost || item.note.velocity < 60) continue

    const minGap = lane === 2 ? 100 : 80
    if (item.ms - lastHit[lane] < minGap) continue

    if (lane === 2) {
      if (item.ms - prevHihat < 150) {
        hihatCount += 1
        if (hihatCount % 3 === 0) continue
      } else {
        hihatCount = 0
      }
      prevHihat = item.ms
    }

    out.push(item)
    lastHit[lane] = item.ms
  }
  return out
}

/**
 * Medium (~50%): kick to a basic pulse (no double kick), hi-hat halved, toms
 * only on loud accents. Mirrors strum `_reduce_to_medium`.
 */
function reduceDrumsToMedium(timed: TimedNote[]): TimedNote[] {
  const out: TimedNote[] = []
  let prevKick = -1000
  let prevSnare = -1000
  let prevHihat = -1000
  let hihatCount = 0

  for (const item of timed) {
    const lane = laneIndexOf(item.note)

    if (lane === 0) {
      // Double-kick is an Expert-only device; it must not survive to Medium.
      if (item.note.flags?.isDoubleKick) continue
      if (item.ms - prevKick < 200) continue
      prevKick = item.ms
    } else if (lane === 1) {
      if (item.ms - prevSnare < 150) continue
      prevSnare = item.ms
    } else if (lane === 2) {
      hihatCount += 1
      if (hihatCount % 2 === 0) continue
      if (item.ms - prevHihat < 180) continue
      prevHihat = item.ms
    } else if (item.note.velocity < 80) {
      continue
    }

    out.push(item)
  }
  return out
}

/**
 * Easy (~25-30%): kick and snare only, very sparse, no cymbals.
 * Mirrors strum `_reduce_to_easy`.
 */
function reduceDrumsToEasy(timed: TimedNote[]): TimedNote[] {
  const out: TimedNote[] = []
  const lastLane: Record<number, number> = { 0: -1000, 1: -1000 }
  let lastAny = -1000

  for (const item of timed) {
    const lane = laneIndexOf(item.note)
    if (lane > 1) continue
    if (item.ms - lastLane[lane] < 250) continue
    // No simultaneous kick+snare on Easy.
    if (item.ms - lastAny < 150) continue

    out.push(item)
    lastLane[lane] = item.ms
    lastAny = item.ms
  }
  return out
}

function reduceDrums(
  expert: Note[],
  tempoEvents: TempoEvent[],
  target: DerivedDifficulty
): Note[] {
  const timed = withTimes(expert, tempoEvents)
  const hard = reduceDrumsToHard(timed)
  const chain =
    target === 'hard' ? hard : target === 'medium' ? reduceDrumsToMedium(hard) : reduceDrumsToEasy(reduceDrumsToMedium(hard))

  return chain.map((item) => {
    const lane = item.note.lane as DrumLane
    if (target === 'easy') {
      // Easy has no cymbals and no double kick; fold anything that survived.
      const folded = CYMBAL_TO_TOM[lane] ?? lane
      return derive(item.note, target, {
        lane: folded,
        duration: 0,
        flags: { ...item.note.flags, isCymbal: false, isGhost: false, isDoubleKick: false }
      })
    }
    if (target === 'medium') {
      return derive(item.note, target, {
        duration: 0,
        flags: { ...item.note.flags, isGhost: false, isDoubleKick: false }
      })
    }
    return derive(item.note, target, { duration: 0, flags: { ...item.note.flags, isGhost: false } })
  })
}

// ─── Guitar / Bass (5-fret) ──────────────────────────────────────────────────

// C3 fret indices: 0=Green 1=Red 2=Yellow 3=Blue 4=Orange. 'open' has no index —
// it is a strum of the open string and is preserved rather than fret-capped.
const GUITAR_LANE_INDEX: Record<Exclude<GuitarLane, 'open'>, number> = {
  green: 0,
  red: 1,
  yellow: 2,
  blue: 3,
  orange: 4
}
const INDEX_TO_GUITAR_LANE: Exclude<GuitarLane, 'open'>[] = [
  'green',
  'red',
  'yellow',
  'blue',
  'orange'
]

/** Forbidden 2-note chord shapes per difficulty (c3_rules `_FORBIDDEN_2CHORD`). */
const FORBIDDEN_2CHORD: Record<Difficulty, Set<string>> = {
  expert: new Set(),
  hard: new Set(['0,4']),
  medium: new Set(['0,3', '0,4', '1,4']),
  easy: new Set([
    '0,1',
    '0,2',
    '0,3',
    '0,4',
    '1,2',
    '1,3',
    '1,4',
    '2,3',
    '2,4',
    '3,4'
  ])
}

/** c3_rules `_fix_chord_shape` — return a fret set legal for `difficulty`. */
function fixChordShape(fretsIn: number[], difficulty: Difficulty): number[] {
  let frets = Array.from(new Set(fretsIn)).sort((a, b) => a - b)
  if (frets.length === 0) return frets

  if (difficulty === 'easy') return [frets[0]]

  if (frets.length >= 3) {
    if (difficulty === 'expert') {
      if (frets.includes(0) && frets.includes(4)) {
        frets = frets.filter((f) => f !== 4)
        if (frets.length < 2) return frets.slice(0, 1)
      }
    } else {
      // Hard / Medium take no 3-note chords — reduce to the outer two.
      frets = [frets[0], frets[frets.length - 1]]
    }
  }

  if (frets.length === 2) {
    const key = `${frets[0]},${frets[1]}`
    if (FORBIDDEN_2CHORD[difficulty].has(key)) {
      // Hard prefers remapping GO → GB rather than dropping to a single note.
      if (difficulty === 'hard' && key === '0,4') return [0, 3]
      return [frets[0]]
    }
  }

  return frets
}

/** Notes shorter than this (3/16 of a beat, ≈ dotted 8th) lose their sustain tail. */
function minSustainMs(bpm: number): number {
  return 0.75 * (60000 / Math.max(bpm, 30))
}

/** Required silence between a sustain end and the next onset (1/32 note). */
function minGapMs(bpm: number): number {
  return 60000 / Math.max(bpm, 30) / 8
}

interface GuitarEvent {
  tick: number
  ms: number
  durationMs: number
  frets: number[]
  open: boolean
  source: Note
}

/**
 * Thinning stage — strum `_reduce_hard/_reduce_medium/_reduce_easy`. Operates on
 * chord groups (one entry per onset) so a chord counts once, matching STRUM's
 * de-duplication of chord notes sharing a time.
 */
function thinGuitarGroups(
  groups: TimedNote[][],
  target: DerivedDifficulty,
  isBass: boolean
): TimedNote[][] {
  const out: TimedNote[][] = []
  let skipCounter = 0

  for (let i = 0; i < groups.length; i++) {
    if (i > 0) {
      const gap = groups[i][0].ms - groups[i - 1][0].ms
      let skip = false

      if (target === 'hard') {
        const gapThreshold = isBass ? 500 : 350
        const skipMod = isBass ? 5 : 3
        if (gap < gapThreshold) {
          skipCounter += 1
          if (skipCounter % skipMod === 0) skip = true
        } else {
          skipCounter = 0
        }
      } else if (target === 'medium') {
        if (isBass) {
          if (gap < 500) {
            skipCounter += 1
            if (skipCounter % 3 === 0) skip = true
          } else {
            skipCounter = 0
          }
        } else if (gap < 200) {
          skipCounter += 1
          if (skipCounter % 2 === 0) skip = true
        } else if (gap < 500) {
          skipCounter += 1
          if (skipCounter % 3 === 0) skip = true
        } else {
          skipCounter = 0
        }
      } else {
        // Easy keeps only 1-in-N through fast passages.
        if (isBass) {
          if (gap < 400) {
            skipCounter += 1
            if (skipCounter % 3 !== 0) skip = true
          } else if (gap < 700) {
            skipCounter += 1
            if (skipCounter % 2 !== 0) skip = true
          } else {
            skipCounter = 0
          }
        } else if (gap < 400) {
          skipCounter += 1
          if (skipCounter % 4 !== 0) skip = true
        } else if (gap < 800) {
          skipCounter += 1
          if (skipCounter % 2 !== 0) skip = true
        } else {
          skipCounter = 0
        }
      }

      if (skip) continue
    }
    out.push(groups[i])
  }
  return out
}

function reduceGuitar(
  expert: Note[],
  tempoEvents: TempoEvent[],
  target: DerivedDifficulty,
  isBass: boolean
): Note[] {
  const groups = groupByTick(withTimes(expert, tempoEvents))
  const kept = thinGuitarGroups(groups, target, isBass)

  const fretCap = target === 'easy' ? 2 : 3

  // Build one event per onset, capping frets the way STRUM does before the C3 pass.
  const events: GuitarEvent[] = kept.map((group) => {
    const open = group.some((g) => g.note.lane === 'open')
    const frets = group
      .filter((g) => g.note.lane !== 'open')
      .map((g) => GUITAR_LANE_INDEX[g.note.lane as Exclude<GuitarLane, 'open'>] ?? 0)
      .map((f) => Math.min(f, fretCap))
    const longest = group.reduce((a, b) => (b.endMs - b.ms > a.endMs - a.ms ? b : a))
    return {
      tick: group[0].note.tick,
      ms: group[0].ms,
      durationMs: longest.endMs - longest.ms,
      frets,
      open,
      source: longest.note
    }
  })

  // C3 chord-shape rules. An open strum is a single event on its own — it can't
  // be combined with fretted notes, so when both land on one tick the open wins
  // and the fretted notes are dropped, which is what the games expect.
  const shaped = events
    .map((ev) => {
      if (ev.open) return { ...ev, frets: [] }
      return { ...ev, frets: fixChordShape(ev.frets, target) }
    })
    .filter((ev) => ev.open || ev.frets.length > 0)

  // Tempo-aware sustains + no-overlap enforcement (c3_rules steps 3 and 4).
  const SHORT_NOTE_MS = 80
  for (let i = 0; i < shaped.length; i++) {
    const bpm = bpmAt(shaped[i].tick, tempoEvents)
    if (shaped[i].durationMs < minSustainMs(bpm)) shaped[i].durationMs = SHORT_NOTE_MS
  }
  for (let i = 0; i < shaped.length - 1; i++) {
    const bpm = bpmAt(shaped[i].tick, tempoEvents)
    const gap = minGapMs(bpm)
    const maxEnd = shaped[i + 1].ms - gap
    const end = shaped[i].ms + shaped[i].durationMs
    if (end > maxEnd) {
      const fits = maxEnd - shaped[i].ms
      shaped[i].durationMs = fits < SHORT_NOTE_MS ? Math.max(20, fits) : Math.max(SHORT_NOTE_MS, fits)
    }
  }

  // Back to editor notes. Durations are converted from ms to ticks against the
  // local tempo so the sustain enforcement above survives tempo changes.
  const out: Note[] = []
  for (const ev of shaped) {
    const bpm = bpmAt(ev.tick, tempoEvents)
    const ticksPerMs = (480 * bpm) / 60 / 1000
    const durationTicks = Math.max(0, Math.round(ev.durationMs * ticksPerMs))
    // A tap/short note carries no tail in the editor's model.
    const duration = ev.durationMs <= SHORT_NOTE_MS ? 0 : durationTicks

    const lanes: GuitarLane[] = ev.open ? ['open'] : ev.frets.map((f) => INDEX_TO_GUITAR_LANE[f])
    for (const lane of lanes) {
      out.push(
        derive(ev.source, target, {
          tick: ev.tick,
          lane,
          duration,
          flags: {
            ...ev.source.flags,
            // Medium and Easy are strum-only; Hard keeps HOPOs but never taps.
            isHOPO: target === 'hard' ? ev.source.flags?.isHOPO : false,
            isTap: false
          }
        })
      )
    }
  }
  return out
}

// ─── Keys (5-lane) and Pro Keys ──────────────────────────────────────────────

/**
 * Deterministic stride reduction, matching the keys/pro-keys behaviour in
 * strum `batch_pipeline._create_keys_track` / `_create_prokeys_track`:
 * Hard drops every 4th note, Medium keeps every other, Easy keeps every 3rd.
 */
function strideKeep<T>(items: T[], target: DerivedDifficulty): T[] {
  if (target === 'hard') return items.filter((_, i) => i % 4 !== 0)
  if (target === 'medium') return items.filter((_, i) => i % 2 === 0)
  return items.filter((_, i) => i % 3 === 0)
}

function reduceKeys(
  expert: Note[],
  tempoEvents: TempoEvent[],
  target: DerivedDifficulty
): Note[] {
  // Stride on chord groups, not raw notes, so a chord is kept or dropped whole
  // instead of being torn apart into an unplayable fragment.
  const groups = groupByTick(withTimes(expert, tempoEvents))
  const kept = strideKeep(groups, target)

  return kept.flatMap((group) => {
    // Keys chords thin with difficulty: Medium takes two lanes, Easy one.
    const limit = target === 'hard' ? group.length : target === 'medium' ? 2 : 1
    return group
      .slice(0, limit)
      .map((item) => derive(item.note, target, { flags: { ...item.note.flags, isTap: false } }))
  })
}

function reduceProKeys(
  expert: Note[],
  tempoEvents: TempoEvent[],
  target: DerivedDifficulty
): Note[] {
  const groups = groupByTick(withTimes(expert, tempoEvents))
  const kept = strideKeep(groups, target)

  return kept.flatMap((group) => {
    // Pro Keys keeps real pitches; reduce the size of simultaneous voicings
    // rather than remapping them. Easy is melody only (top voice).
    const sorted = [...group].sort((a, b) => Number(a.note.lane) - Number(b.note.lane))
    const limit = target === 'hard' ? sorted.length : target === 'medium' ? 2 : 1
    const chosen = target === 'easy' ? [sorted[sorted.length - 1]] : sorted.slice(0, limit)
    return chosen.map((item) => derive(item.note, target))
  })
}

// ─── Pro Guitar / Pro Bass ───────────────────────────────────────────────────

/**
 * STRUM has no Pro Guitar/Bass reducer, so these rules are OCTAVE's own. They
 * follow the same shape as the 5-fret ones — thin by onset gap, then shrink
 * chord voicings — but operate on strings rather than lanes and never transpose
 * a fret, because moving a fret changes the actual note being played.
 *
 * Hard   — thin dense passages, cap voicings at 4 strings, drop no frets.
 * Medium — cap voicings at 2 strings (keep the lowest two), thin harder.
 * Easy   — single notes only (lowest string of each voicing), sparsest.
 */
function reduceProGuitar(
  expert: Note[],
  tempoEvents: TempoEvent[],
  target: DerivedDifficulty,
  isBass: boolean
): Note[] {
  const groups = groupByTick(withTimes(expert, tempoEvents))
  const kept = thinGuitarGroups(groups, target, isBass)
  const stringLimit = target === 'hard' ? 4 : target === 'medium' ? 2 : 1

  return kept.flatMap((group) => {
    // `string` 1 = high E … 6 = low E, so descending order keeps the low
    // strings — the root of the voicing — which is what lower difficulties play.
    const sorted = [...group].sort(
      (a, b) => ((b.note.string ?? 6) as number) - ((a.note.string ?? 6) as number)
    )
    return sorted.slice(0, stringLimit).map((item) =>
      derive(item.note, target, {
        string: (item.note.string ?? 6) as ProGuitarString,
        fret: item.note.fret,
        flags: {
          ...item.note.flags,
          isHOPO: target === 'hard' ? item.note.flags?.isHOPO : false,
          isTap: false
        }
      })
    )
  })
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export interface GenerateFromExpertOptions {
  /** Instruments to reduce. Defaults to every reducible instrument with Expert notes. */
  instruments?: Instrument[]
  /** Difficulties to write. Defaults to Hard + Medium + Easy. */
  targets?: DerivedDifficulty[]
}

export interface GenerateFromExpertResult {
  /** The full replacement note list for the song. */
  notes: Note[]
  /** Per-instrument, per-difficulty counts of what was generated. */
  generated: Record<string, Partial<Record<DerivedDifficulty, number>>>
  /** Instruments that were asked for but had no Expert notes to reduce. */
  skipped: Instrument[]
}

function reduceForInstrument(
  instrument: Instrument,
  expert: Note[],
  tempoEvents: TempoEvent[],
  target: DerivedDifficulty
): Note[] {
  switch (instrument) {
    case 'drums':
      return reduceDrums(expert, tempoEvents, target)
    case 'guitar':
      return reduceGuitar(expert, tempoEvents, target, false)
    case 'bass':
      return reduceGuitar(expert, tempoEvents, target, true)
    case 'keys':
      return reduceKeys(expert, tempoEvents, target)
    case 'proKeys':
      return reduceProKeys(expert, tempoEvents, target)
    case 'proGuitar':
      return reduceProGuitar(expert, tempoEvents, target, false)
    case 'proBass':
      return reduceProGuitar(expert, tempoEvents, target, true)
    default:
      return []
  }
}

/**
 * Derive lower difficulties from the Expert chart.
 *
 * Returns a complete replacement note list: notes for the targeted
 * instrument/difficulty pairs are replaced wholesale, and everything else
 * (Expert, untargeted instruments, untargeted difficulties) is passed through
 * untouched. Callers are responsible for confirming the overwrite with the user
 * — any hand-authored work on a targeted difficulty is discarded.
 */
export function generateFromExpert(
  notes: Note[],
  tempoEvents: TempoEvent[],
  options: GenerateFromExpertOptions = {}
): GenerateFromExpertResult {
  const targets = options.targets?.length ? options.targets : DERIVED_DIFFICULTIES
  const requested = options.instruments?.length
    ? options.instruments.filter((i) => REDUCIBLE_INSTRUMENTS.includes(i))
    : REDUCIBLE_INSTRUMENTS

  const generated: GenerateFromExpertResult['generated'] = {}
  const skipped: Instrument[] = []
  const replacedPairs = new Set<string>()
  const additions: Note[] = []

  for (const instrument of requested) {
    const expert = notes.filter((n) => n.instrument === instrument && n.difficulty === 'expert')
    if (expert.length === 0) {
      // Nothing to reduce — leave any existing lower difficulties alone rather
      // than wiping them because Expert happens to be empty.
      skipped.push(instrument)
      continue
    }

    for (const target of targets) {
      const produced = reduceForInstrument(instrument, expert, tempoEvents, target)
      replacedPairs.add(`${instrument}|${target}`)
      additions.push(...produced)
      generated[instrument] = { ...generated[instrument], [target]: produced.length }
    }
  }

  const kept = notes.filter((n) => !replacedPairs.has(`${n.instrument}|${n.difficulty}`))
  return { notes: [...kept, ...additions], generated, skipped }
}
