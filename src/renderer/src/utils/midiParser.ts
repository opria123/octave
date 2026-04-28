// MIDI Parser - Converts MIDI files to chart notes
import { Midi } from '@tonejs/midi'
import { parseMidi, writeMidi } from 'midi-file'
import type { MidiEvent as RawMidiEvent } from 'midi-file'
import { v4 as uuidv4 } from 'uuid'
import type { Note, Instrument, Difficulty, DrumLane, GuitarLane, ProGuitarString, TempoEvent, TimeSignature, StarPowerPhrase, SoloSection, VocalNote, VocalPhrase, HarmonyPart } from '../types'

// Clone Hero/YARG MIDI track names
const TRACK_NAMES: Record<string, { instrument: Instrument; type: 'guitar' | 'drums' }> = {
  'PART DRUMS': { instrument: 'drums', type: 'drums' },
  'PART GUITAR': { instrument: 'guitar', type: 'guitar' },
  'PART BASS': { instrument: 'bass', type: 'guitar' },
  'PART KEYS': { instrument: 'keys', type: 'guitar' },
  'PART RHYTHM': { instrument: 'guitar', type: 'guitar' }
}

// Pro Keys track names — each difficulty is a separate MIDI track
const PRO_KEYS_TRACKS: Record<string, Difficulty> = {
  'PART REAL_KEYS_X': 'expert',
  'PART REAL_KEYS_H': 'hard',
  'PART REAL_KEYS_M': 'medium',
  'PART REAL_KEYS_E': 'easy'
}

// Pro Guitar/Bass track names
const PRO_GUITAR_TRACKS: Record<string, Instrument> = {
  'PART REAL_GUITAR': 'proGuitar',
  'PART REAL_GUITAR_22': 'proGuitar',
  'PART REAL_BASS': 'proBass',
  'PART REAL_BASS_22': 'proBass'
}

// Pro Keys MIDI note range
const PRO_KEYS_NOTE_MIN = 48  // C3
const PRO_KEYS_NOTE_MAX = 72  // C5

// Pro Guitar/Bass: note offsets per difficulty (6 notes per difficulty = 6 strings)
const PRO_GUITAR_OFFSETS: Record<Difficulty, number> = {
  expert: 96,
  hard: 72,
  medium: 48,
  easy: 24
}

// Vocal track names → harmony part
const VOCAL_TRACK_NAMES: Record<string, HarmonyPart> = {
  'PART VOCALS': 0,
  'HARM1': 1,
  'HARM2': 2,
  'HARM3': 3
}

// Vocal MIDI constants
const VOCAL_PHRASE_NOTE = 105        // Phrase marker (on/off)
const VOCAL_PERCUSSION_NOTE = 96     // Non-pitched percussion
const VOCAL_PERCUSSION_NOTE_2 = 97   // Non-pitched percussion variant
const VOCAL_PITCH_MIN = 36           // Lowest pitched vocal note
const VOCAL_PITCH_MAX = 84           // Highest pitched vocal note

// MIDI note to lane mapping for guitar (5-fret)
const GUITAR_NOTE_OFFSETS: Record<Difficulty, number> = {
  expert: 96,
  hard: 84,
  medium: 72,
  easy: 60
}

const GUITAR_LANES: GuitarLane[] = ['green', 'red', 'yellow', 'blue', 'orange']

// MIDI note to lane mapping for drums
const DRUM_NOTE_OFFSETS: Record<Difficulty, number> = {
  expert: 96,
  hard: 84,
  medium: 72,
  easy: 60
}

// Expert+ / double-bass kicks are encoded as the kick lane note minus 1.
// The game-critical expert note is 95, but we also round-trip the same pattern
// for the lower difficulties to stay compatible with common chart editors.

const DRUM_LANES: DrumLane[] = ['kick', 'snare', 'yellowCymbal', 'blueCymbal', 'greenCymbal']

// Tom marker notes (110/111/112 convert default cymbals → toms)
const TOM_MARKERS = {
  110: 'yellowTom',
  111: 'blueTom',
  112: 'greenTom'
} as const

// Star Power note (same across all instruments)
const STAR_POWER_NOTE = 116

// Solo marker note (same across all instruments)
const SOLO_NOTE = 103

interface ParsedMidiData {
  notes: Note[]
  vocalNotes: VocalNote[]
  vocalPhrases: VocalPhrase[]
  starPowerPhrases: StarPowerPhrase[]
  soloSections: SoloSection[]
  tempoEvents: TempoEvent[]
  timeSignatures: TimeSignature[]
}

// Process a single pro guitar/bass note from raw MIDI data
// RB3 pro guitar encoding: note numbers 24-29 (easy) / 48-53 (medium) / 72-77 (hard) / 96-101 (expert)
// represent strings 6-1 (low E to high E). Velocity encodes fret: velocity = 100 + fret (0-22)
function processProGuitarNote(
  noteNumber: number,
  tick: number,
  duration: number,
  velocity: number,
  instrument: Instrument,
  notes: Note[],
  starPowerPhrases: StarPowerPhrase[],
  soloSections: SoloSection[]
): void {
  // Star Power / Solo
  if (noteNumber === STAR_POWER_NOTE) {
    starPowerPhrases.push({ id: uuidv4(), tick, duration, instrument })
    return
  }
  if (noteNumber === SOLO_NOTE) {
    soloSections.push({ id: uuidv4(), tick, duration, instrument })
    return
  }

  // Determine difficulty and string from note number
  for (const diff of ['expert', 'hard', 'medium', 'easy'] as Difficulty[]) {
    const offset = PRO_GUITAR_OFFSETS[diff]
    const stringIndex = noteNumber - offset // 0=string6(lowE), 1=string5(A), ..., 5=string1(highE)
    if (stringIndex >= 0 && stringIndex <= 5) {
      const guitarString = (6 - stringIndex) as ProGuitarString // Convert to 1-6 (high to low)
      const fret = Math.max(0, velocity - 100) // Velocity encodes fret as 100+fret

      notes.push({
        id: uuidv4(),
        tick,
        duration,
        instrument,
        difficulty: diff,
        lane: guitarString, // Use string number as lane
        velocity: 100,
        string: guitarString,
        fret
      })
      return
    }
  }
}

export function parseMidiBase64(midiBase64: string): ParsedMidiData {
  // Decode base64 to ArrayBuffer
  const binaryString = atob(midiBase64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }

  const midi = new Midi(bytes.buffer)
  const rawMidi = parseMidi(bytes)
  const notes: Note[] = []
  const vocalNotes: VocalNote[] = []
  const vocalPhrases: VocalPhrase[] = []
  const starPowerPhrases: StarPowerPhrase[] = []
  const soloSections: SoloSection[] = []
  const tempoEvents: TempoEvent[] = []
  const timeSignatures: TimeSignature[] = []

  // Normalize all ticks to 480 PPQ (our internal standard)
  const sourcePPQ = midi.header.ppq || 480
  const tickScale = 480 / sourcePPQ

  console.log(`[MIDI Parse] PPQ: ${sourcePPQ}, tickScale: ${tickScale}, tracks: ${midi.tracks.length}`)
  for (const track of midi.tracks) {
    console.log(`[MIDI Parse]   Track "${track.name}" — ${track.notes.length} notes`)
  }
  // Also log raw track names for pro guitar/bass detection
  for (const rawTrack of rawMidi.tracks) {
    for (const ev of rawTrack) {
      if (ev.type === 'trackName' && 'text' in ev) {
        console.log(`[MIDI Parse]   Raw track: "${(ev as RawMidiEvent & { text: string }).text}"`)
        break
      }
    }
  }

  // Extract tempo events
  if (midi.header.tempos && midi.header.tempos.length > 0) {
    for (const tempo of midi.header.tempos) {
      tempoEvents.push({
        tick: Math.round(tempo.ticks * tickScale),
        bpm: Math.round(tempo.bpm * 100) / 100
      })
    }
  } else {
    tempoEvents.push({ tick: 0, bpm: 120 })
  }

  // Extract time signatures
  if (midi.header.timeSignatures && midi.header.timeSignatures.length > 0) {
    for (const ts of midi.header.timeSignatures) {
      timeSignatures.push({
        tick: Math.round(ts.ticks * tickScale),
        numerator: ts.timeSignature[0],
        denominator: ts.timeSignature[1]
      })
    }
  } else {
    timeSignatures.push({ tick: 0, numerator: 4, denominator: 4 })
  }

  // Track tom markers by tick to modify drum notes (default is cymbal)
  const tomTicks = new Map<number, Set<string>>()

  // First pass: collect tom markers
  for (const track of midi.tracks) {
    const trackName = track.name?.toUpperCase() || ''
    if (trackName === 'PART DRUMS') {
      for (const note of track.notes) {
        const midiNote = note.midi
        if (midiNote in TOM_MARKERS) {
          const tick = Math.round(note.ticks * tickScale)
          if (!tomTicks.has(tick)) {
            tomTicks.set(tick, new Set())
          }
          tomTicks.get(tick)!.add(TOM_MARKERS[midiNote as keyof typeof TOM_MARKERS])
        }
      }
    }
  }

  // Second pass: process all tracks
  for (const track of midi.tracks) {
    const trackName = track.name?.toUpperCase() || ''
    const trackInfo = TRACK_NAMES[trackName]

    if (!trackInfo) continue

    const { instrument, type } = trackInfo

    for (const midiNote of track.notes) {
      const noteNumber = midiNote.midi
      const tick = Math.round(midiNote.ticks * tickScale)
      const duration = Math.round(midiNote.durationTicks * tickScale)
      const velocity = Math.round(midiNote.velocity * 127)

      // Skip tom markers themselves
      if (noteNumber in TOM_MARKERS) continue

      // Star Power phrase (MIDI note 116)
      if (noteNumber === STAR_POWER_NOTE) {
        starPowerPhrases.push({ id: uuidv4(), tick, duration, instrument })
        continue
      }

      // Solo section (MIDI note 103)
      if (noteNumber === SOLO_NOTE) {
        soloSections.push({ id: uuidv4(), tick, duration, instrument })
        continue
      }

      // Determine difficulty and lane
      let difficulty: Difficulty | null = null
      let lane: DrumLane | GuitarLane | null = null

      if (type === 'guitar') {
        // Guitar/Bass/Keys
        for (const diff of ['expert', 'hard', 'medium', 'easy'] as Difficulty[]) {
          const offset = GUITAR_NOTE_OFFSETS[diff]
          const laneIndex = noteNumber - offset
          if (laneIndex >= 0 && laneIndex < GUITAR_LANES.length) {
            difficulty = diff
            lane = GUITAR_LANES[laneIndex]
            break
          }
        }
      } else {
        // Drums
        for (const diff of ['expert', 'hard', 'medium', 'easy'] as Difficulty[]) {
          const offset = DRUM_NOTE_OFFSETS[diff]
          if (noteNumber === offset - 1) {
            difficulty = diff
            lane = 'kick'
            break
          }
        }

        if (difficulty && lane) {
          notes.push({
            id: uuidv4(),
            tick,
            duration: 0,
            instrument,
            difficulty,
            lane,
            velocity,
            flags: { isDoubleKick: true }
          })
          continue
        }

        for (const diff of ['expert', 'hard', 'medium', 'easy'] as Difficulty[]) {
          const offset = DRUM_NOTE_OFFSETS[diff]
          const laneIndex = noteNumber - offset
          if (laneIndex >= 0 && laneIndex < DRUM_LANES.length) {
            difficulty = diff
            const baseLane = DRUM_LANES[laneIndex]

            // Check if this tick has a tom marker (converts cymbal → tom)
            const toms = tomTicks.get(tick)
            if (toms) {
              if (baseLane === 'yellowCymbal' && toms.has('yellowTom')) {
                lane = 'yellowTom'
              } else if (baseLane === 'blueCymbal' && toms.has('blueTom')) {
                lane = 'blueTom'
              } else if (baseLane === 'greenCymbal' && toms.has('greenTom')) {
                lane = 'greenTom'
              } else {
                lane = baseLane
              }
            } else {
              lane = baseLane
            }
            break
          }
        }
      }

      if (difficulty && lane) {
        notes.push({
          id: uuidv4(),
          tick,
          duration: type === 'drums' ? 0 : duration,
          instrument,
          difficulty,
          lane,
          velocity
        })
      }
    }
  }

  // ── Parse Pro Keys Tracks ───────────────────────────────────────────
  for (const track of midi.tracks) {
    const trackName = track.name?.toUpperCase() || ''
    const proKeysDifficulty = PRO_KEYS_TRACKS[trackName]
    if (proKeysDifficulty === undefined) continue

    for (const midiNote of track.notes) {
      const noteNumber = midiNote.midi
      const tick = Math.round(midiNote.ticks * tickScale)
      const duration = Math.round(midiNote.durationTicks * tickScale)
      const velocity = Math.round(midiNote.velocity * 127)

      // Star Power / Solo on pro keys tracks
      if (noteNumber === STAR_POWER_NOTE) {
        starPowerPhrases.push({ id: uuidv4(), tick, duration, instrument: 'proKeys' })
        continue
      }
      if (noteNumber === SOLO_NOTE) {
        soloSections.push({ id: uuidv4(), tick, duration, instrument: 'proKeys' })
        continue
      }

      // Pro Keys notes are in range 48-72 (C3-C5)
      if (noteNumber >= PRO_KEYS_NOTE_MIN && noteNumber <= PRO_KEYS_NOTE_MAX) {
        notes.push({
          id: uuidv4(),
          tick,
          duration,
          instrument: 'proKeys',
          difficulty: proKeysDifficulty,
          lane: noteNumber, // MIDI pitch as lane
          velocity
        })
      }
    }
  }

  // ── Parse Pro Guitar/Bass Tracks ────────────────────────────────────
  // Pro guitar uses raw MIDI because @tonejs/midi may not preserve channel info
  for (let trackIdx = 0; trackIdx < rawMidi.tracks.length; trackIdx++) {
    const rawTrack = rawMidi.tracks[trackIdx]
    let rawTrackName = ''
    for (const ev of rawTrack) {
      if (ev.type === 'trackName' && 'text' in ev) {
        rawTrackName = (ev as RawMidiEvent & { text: string }).text.toUpperCase()
        break
      }
    }

    const proInstrument = PRO_GUITAR_TRACKS[rawTrackName]
    if (!proInstrument) continue

    // Collect note on/off pairs
    const noteOns = new Map<string, { tick: number; velocity: number; channel: number }>()
    let absTick = 0

    for (const ev of rawTrack) {
      absTick += ev.deltaTime
      const scaledTick = Math.round(absTick * tickScale)

      if (ev.type === 'noteOn' && 'noteNumber' in ev) {
        const noteEv = ev as RawMidiEvent & { noteNumber: number; velocity: number; channel: number }
        if (noteEv.velocity > 0) {
          const key = `${noteEv.noteNumber}-${noteEv.channel}`
          noteOns.set(key, { tick: scaledTick, velocity: noteEv.velocity, channel: noteEv.channel })
        } else {
          // velocity 0 = note off
          const key = `${noteEv.noteNumber}-${noteEv.channel}`
          const on = noteOns.get(key)
          if (on) {
            processProGuitarNote(noteEv.noteNumber, on.tick, scaledTick - on.tick, on.velocity, proInstrument, notes, starPowerPhrases, soloSections)
            noteOns.delete(key)
          }
        }
      } else if (ev.type === 'noteOff' && 'noteNumber' in ev) {
        const noteEv = ev as RawMidiEvent & { noteNumber: number; channel: number }
        const key = `${noteEv.noteNumber}-${noteEv.channel}`
        const on = noteOns.get(key)
        if (on) {
          processProGuitarNote(noteEv.noteNumber, on.tick, scaledTick - on.tick, on.velocity, proInstrument, notes, starPowerPhrases, soloSections)
          noteOns.delete(key)
        }
      }
    }
  }

  // Log pro instrument parse results
  const proKeysCount = notes.filter(n => n.instrument === 'proKeys').length
  const proGuitarCount = notes.filter(n => n.instrument === 'proGuitar').length
  const proBassCount = notes.filter(n => n.instrument === 'proBass').length
  if (proKeysCount || proGuitarCount || proBassCount) {
    console.log(`[MIDI Parse] Pro instruments: proKeys=${proKeysCount}, proGuitar=${proGuitarCount}, proBass=${proBassCount}`)
  } else {
    console.log(`[MIDI Parse] No pro instrument tracks found`)
  }

  // ── Parse Vocal Tracks ──────────────────────────────────────────────
  // Use raw midi-file parser for lyrics since @tonejs/midi doesn't expose them
  for (let trackIdx = 0; trackIdx < rawMidi.tracks.length; trackIdx++) {
    const rawTrack = rawMidi.tracks[trackIdx]
    // Find track name from raw events
    let rawTrackName = ''
    for (const ev of rawTrack) {
      if (ev.type === 'trackName' && 'text' in ev) {
        rawTrackName = (ev as RawMidiEvent & { text: string }).text.toUpperCase()
        break
      }
    }

    const harmonyPart = VOCAL_TRACK_NAMES[rawTrackName]
    if (harmonyPart === undefined) continue

    // Collect lyrics, note on/off, and phrase markers from raw events
    // We need to accumulate absolute ticks from delta times
    const lyrics: { tick: number; text: string }[] = []
    const noteOns: Map<number, { tick: number; velocity: number }> = new Map()
    const parsedNotes: { tick: number; duration: number; midi: number; velocity: number }[] = []
    const phraseStarts: Map<number, number> = new Map() // note -> startTick

    let rawAbsTick = 0
    for (const ev of rawTrack) {
      rawAbsTick += ev.deltaTime
      const absTick = Math.round(rawAbsTick * tickScale)

      if (ev.type === 'lyrics' && 'text' in ev) {
        lyrics.push({ tick: absTick, text: (ev as RawMidiEvent & { text: string }).text })
      } else if (ev.type === 'text' && 'text' in ev) {
        // Some charts use text events for lyrics
        const text = (ev as RawMidiEvent & { text: string }).text
        if (!text.startsWith('[')) { // Skip section markers like [verse]
          lyrics.push({ tick: absTick, text })
        }
      } else if (ev.type === 'noteOn' && 'noteNumber' in ev) {
        const noteEv = ev as RawMidiEvent & { noteNumber: number; velocity: number }
        if (noteEv.velocity > 0) {
          if (noteEv.noteNumber === VOCAL_PHRASE_NOTE) {
            phraseStarts.set(noteEv.noteNumber, absTick)
          } else {
            noteOns.set(noteEv.noteNumber, { tick: absTick, velocity: noteEv.velocity })
          }
        } else {
          // velocity 0 = note off
          if (noteEv.noteNumber === VOCAL_PHRASE_NOTE) {
            const startTick = phraseStarts.get(noteEv.noteNumber)
            if (startTick !== undefined) {
              vocalPhrases.push({
                id: uuidv4(),
                tick: startTick,
                duration: absTick - startTick,
                harmonyPart
              })
              phraseStarts.delete(noteEv.noteNumber)
            }
          } else {
            const on = noteOns.get(noteEv.noteNumber)
            if (on) {
              parsedNotes.push({ tick: on.tick, duration: absTick - on.tick, midi: noteEv.noteNumber, velocity: on.velocity })
              noteOns.delete(noteEv.noteNumber)
            }
          }
        }
      } else if (ev.type === 'noteOff' && 'noteNumber' in ev) {
        const noteEv = ev as RawMidiEvent & { noteNumber: number }
        if (noteEv.noteNumber === VOCAL_PHRASE_NOTE) {
          const startTick = phraseStarts.get(noteEv.noteNumber)
          if (startTick !== undefined) {
            vocalPhrases.push({
              id: uuidv4(),
              tick: startTick,
              duration: absTick - startTick,
              harmonyPart
            })
            phraseStarts.delete(noteEv.noteNumber)
          }
        } else {
          const on = noteOns.get(noteEv.noteNumber)
          if (on) {
            parsedNotes.push({ tick: on.tick, duration: absTick - on.tick, midi: noteEv.noteNumber, velocity: on.velocity })
            noteOns.delete(noteEv.noteNumber)
          }
        }
      }
    }

    // Sort lyrics by tick for matching
    lyrics.sort((a, b) => a.tick - b.tick)

    // Match lyrics to notes by closest tick (lyrics typically appear at note start)
    let lyricIdx = 0
    for (const pn of parsedNotes.sort((a, b) => a.tick - b.tick)) {
      const isPercussion = pn.midi === VOCAL_PERCUSSION_NOTE || pn.midi === VOCAL_PERCUSSION_NOTE_2
      const isPitched = pn.midi >= VOCAL_PITCH_MIN && pn.midi <= VOCAL_PITCH_MAX

      if (!isPercussion && !isPitched) continue

      // Find the closest lyric event at or near this note's tick
      let lyric: string | undefined
      let isSlide = false
      while (lyricIdx < lyrics.length && lyrics[lyricIdx].tick <= pn.tick + 5) {
        if (Math.abs(lyrics[lyricIdx].tick - pn.tick) <= 5) {
          lyric = lyrics[lyricIdx].text
          lyricIdx++
          break
        }
        lyricIdx++
      }

      // Check for pitch slide prefix
      if (lyric && lyric.startsWith('+')) {
        isSlide = true
        lyric = lyric.slice(1) || undefined
      }

      // Clean up lyric special chars
      if (lyric) {
        lyric = lyric.replace(/[=$#^]/g, '').trim() || undefined
      }

      vocalNotes.push({
        id: uuidv4(),
        tick: pn.tick,
        duration: pn.duration,
        instrument: 'vocals',
        difficulty: 'expert', // Vocals don't have difficulty in CH/RB
        lane: isPercussion ? 0 : pn.midi,
        velocity: pn.velocity,
        harmonyPart,
        lyric,
        isSlide: isSlide || undefined,
        isPercussion: isPercussion || undefined,
        isPitchless: undefined
      })
    }
  }

  // Sort notes by tick
  notes.sort((a, b) => a.tick - b.tick)
  vocalNotes.sort((a, b) => a.tick - b.tick)
  vocalPhrases.sort((a, b) => a.tick - b.tick)
  starPowerPhrases.sort((a, b) => a.tick - b.tick)
  soloSections.sort((a, b) => a.tick - b.tick)

  const lastNote = notes.length > 0 ? notes[notes.length - 1] : null
  const lastVocal = vocalNotes.length > 0 ? vocalNotes[vocalNotes.length - 1] : null
  console.log(`[MIDI Parse] Result: ${notes.length} notes, ${vocalNotes.length} vocals, ${starPowerPhrases.length} SP, ${soloSections.length} solos`)
  if (lastNote) console.log(`[MIDI Parse] Last instrument note at tick ${lastNote.tick} (${lastNote.instrument}/${lastNote.lane})`)
  if (lastVocal) console.log(`[MIDI Parse] Last vocal note at tick ${lastVocal.tick}`)
  console.log(`[MIDI Parse] Tempo events: ${tempoEvents.length}, first BPM: ${tempoEvents[0]?.bpm}`)

  return { notes, vocalNotes, vocalPhrases, starPowerPhrases, soloSections, tempoEvents, timeSignatures }
}

// ── .chart File Parser ───────────────────────────────────────────────
// Parses Clone Hero .chart text format into the same ParsedMidiData structure

// .chart section name → instrument + difficulty + type
const CHART_SECTIONS: Record<string, { instrument: Instrument; difficulty: Difficulty; type: 'guitar' | 'drums' }> = {
  'ExpertSingle': { instrument: 'guitar', difficulty: 'expert', type: 'guitar' },
  'HardSingle': { instrument: 'guitar', difficulty: 'hard', type: 'guitar' },
  'MediumSingle': { instrument: 'guitar', difficulty: 'medium', type: 'guitar' },
  'EasySingle': { instrument: 'guitar', difficulty: 'easy', type: 'guitar' },
  'ExpertDoubleBass': { instrument: 'bass', difficulty: 'expert', type: 'guitar' },
  'HardDoubleBass': { instrument: 'bass', difficulty: 'hard', type: 'guitar' },
  'MediumDoubleBass': { instrument: 'bass', difficulty: 'medium', type: 'guitar' },
  'EasyDoubleBass': { instrument: 'bass', difficulty: 'easy', type: 'guitar' },
  'ExpertDoubleGuitar': { instrument: 'bass', difficulty: 'expert', type: 'guitar' },
  'HardDoubleGuitar': { instrument: 'bass', difficulty: 'hard', type: 'guitar' },
  'MediumDoubleGuitar': { instrument: 'bass', difficulty: 'medium', type: 'guitar' },
  'EasyDoubleGuitar': { instrument: 'bass', difficulty: 'easy', type: 'guitar' },
  'ExpertDrums': { instrument: 'drums', difficulty: 'expert', type: 'drums' },
  'HardDrums': { instrument: 'drums', difficulty: 'hard', type: 'drums' },
  'MediumDrums': { instrument: 'drums', difficulty: 'medium', type: 'drums' },
  'EasyDrums': { instrument: 'drums', difficulty: 'easy', type: 'drums' },
  'ExpertKeyboard': { instrument: 'keys', difficulty: 'expert', type: 'guitar' },
  'HardKeyboard': { instrument: 'keys', difficulty: 'hard', type: 'guitar' },
  'MediumKeyboard': { instrument: 'keys', difficulty: 'medium', type: 'guitar' },
  'EasyKeyboard': { instrument: 'keys', difficulty: 'easy', type: 'guitar' },
}

// .chart guitar lanes: 0=green, 1=red, 2=yellow, 3=blue, 4=orange, 7=open
const CHART_GUITAR_LANES: Record<number, GuitarLane> = {
  0: 'green', 1: 'red', 2: 'yellow', 3: 'blue', 4: 'orange', 7: 'open'
}

// .chart drum lanes: 0=kick, 1=snare, 2=yellow(cymbal/tom), 3=blue(cymbal/tom), 4=green(cymbal/tom), 5=kick(2x)
// Note 66 = cymbal modifier flag (present = cymbal, absent = tom for lanes 2-4)
// In .chart drums, lanes 2/3/4 default to tom unless flagged with 66
const CHART_DRUM_LANES: Record<number, DrumLane> = {
  0: 'kick', 1: 'snare', 2: 'yellowTom', 3: 'blueTom', 4: 'greenTom', 5: 'kick'
}

// Cymbal versions of lanes 2/3/4 (activated by note 66)
const CHART_DRUM_CYMBAL_LANES: Record<number, DrumLane> = {
  2: 'yellowCymbal', 3: 'blueCymbal', 4: 'greenCymbal'
}

interface ChartSection {
  name: string
  lines: string[]
}

function parseChartSections(text: string): ChartSection[] {
  const sections: ChartSection[] = []
  const lines = text.split(/\r?\n/)
  let currentSection: ChartSection | null = null
  let braceDepth = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const sectionMatch = trimmed.match(/^\[(.+)]$/)
    if (sectionMatch && braceDepth === 0) {
      currentSection = { name: sectionMatch[1], lines: [] }
      sections.push(currentSection)
      continue
    }

    if (trimmed === '{') {
      braceDepth++
      continue
    }
    if (trimmed === '}') {
      braceDepth--
      continue
    }

    if (currentSection && braceDepth > 0) {
      currentSection.lines.push(trimmed)
    }
  }

  return sections
}

export function parseChartFile(chartText: string): ParsedMidiData {
  const sections = parseChartSections(chartText)
  const notes: Note[] = []
  const vocalNotes: VocalNote[] = []
  const vocalPhrases: VocalPhrase[] = []
  const starPowerPhrases: StarPowerPhrase[] = []
  const soloSections: SoloSection[] = []
  const tempoEvents: TempoEvent[] = []
  const timeSignatures: TimeSignature[] = []

  // Get resolution from [Song] section
  let resolution = 192
  const songSection = sections.find(s => s.name === 'Song')
  if (songSection) {
    for (const line of songSection.lines) {
      const m = line.match(/^\s*Resolution\s*=\s*(\d+)/)
      if (m) {
        resolution = parseInt(m[1], 10)
        break
      }
    }
  }

  // Scale factor to normalize to 480 PPQ
  const tickScale = 480 / resolution

  console.log(`[Chart Parse] Resolution: ${resolution}, tickScale: ${tickScale}, sections: ${sections.map(s => s.name).join(', ')}`)

  // Parse [SyncTrack]
  const syncSection = sections.find(s => s.name === 'SyncTrack')
  if (syncSection) {
    for (const line of syncSection.lines) {
      // Tempo: tick = B milliBPM
      const tempoMatch = line.match(/^\s*(\d+)\s*=\s*B\s+(\d+)/)
      if (tempoMatch) {
        const tick = Math.round(parseInt(tempoMatch[1], 10) * tickScale)
        const bpm = parseInt(tempoMatch[2], 10) / 1000
        tempoEvents.push({ tick, bpm: Math.round(bpm * 100) / 100 })
        continue
      }
      // Time signature: tick = TS numerator [denomPower]
      const tsMatch = line.match(/^\s*(\d+)\s*=\s*TS\s+(\d+)(?:\s+(\d+))?/)
      if (tsMatch) {
        const tick = Math.round(parseInt(tsMatch[1], 10) * tickScale)
        const numerator = parseInt(tsMatch[2], 10)
        const denomPower = tsMatch[3] ? parseInt(tsMatch[3], 10) : 2
        const denominator = Math.pow(2, denomPower)
        timeSignatures.push({ tick, numerator, denominator })
      }
    }
  }

  if (tempoEvents.length === 0) {
    tempoEvents.push({ tick: 0, bpm: 120 })
  }
  if (timeSignatures.length === 0) {
    timeSignatures.push({ tick: 0, numerator: 4, denominator: 4 })
  }

  // Parse [Events] for vocals (lyrics + phrase markers)
  const eventsSection = sections.find(s => s.name === 'Events')
  if (eventsSection) {
    let phraseStartTick: number | null = null
    const pendingLyrics: { tick: number; text: string }[] = []

    for (const line of eventsSection.lines) {
      const m = line.match(/^\s*(\d+)\s*=\s*E\s+"(.+)"/)
      if (!m) continue
      const tick = Math.round(parseInt(m[1], 10) * tickScale)
      const eventText = m[2]

      if (eventText === 'phrase_start') {
        phraseStartTick = tick
      } else if (eventText === 'phrase_end') {
        if (phraseStartTick !== null) {
          vocalPhrases.push({
            id: uuidv4(),
            tick: phraseStartTick,
            duration: tick - phraseStartTick,
            harmonyPart: 0
          })
          phraseStartTick = null
        }
      } else if (eventText.startsWith('lyric ')) {
        pendingLyrics.push({ tick, text: eventText.substring(6) })
      }
    }

    // Lyrics in .chart don't have pitch info — create unpitched vocal notes
    for (const lyric of pendingLyrics) {
      vocalNotes.push({
        id: uuidv4(),
        tick: lyric.tick,
        duration: Math.round(96 * tickScale), // Default duration ~half beat
        instrument: 'vocals',
        difficulty: 'expert',
        lane: 60, // Default middle C since .chart lyrics have no pitch
        velocity: 100,
        lyric: lyric.text,
        harmonyPart: 0,
        isPercussion: false
      })
    }
  }

  // Parse instrument sections
  for (const section of sections) {
    const sectionInfo = CHART_SECTIONS[section.name]
    if (!sectionInfo) continue

    const { instrument, difficulty, type } = sectionInfo

    // Collect all note events and cymbal flags at each tick for drums
    const tickNotes = new Map<number, { lane: number; duration: number }[]>()
    const cymbalTicks = new Set<number>()

    for (const line of section.lines) {
      // Note: tick = N lane duration
      const noteMatch = line.match(/^\s*(\d+)\s*=\s*N\s+(\d+)\s+(\d+)/)
      if (noteMatch) {
        const tick = Math.round(parseInt(noteMatch[1], 10) * tickScale)
        const lane = parseInt(noteMatch[2], 10)
        const duration = Math.round(parseInt(noteMatch[3], 10) * tickScale)

        if (type === 'drums' && lane === 66) {
          cymbalTicks.add(tick)
          continue
        }

        if (!tickNotes.has(tick)) tickNotes.set(tick, [])
        tickNotes.get(tick)!.push({ lane, duration })
        continue
      }

      // Star Power: tick = S 2 duration
      const spMatch = line.match(/^\s*(\d+)\s*=\s*S\s+2\s+(\d+)/)
      if (spMatch) {
        const tick = Math.round(parseInt(spMatch[1], 10) * tickScale)
        const duration = Math.round(parseInt(spMatch[2], 10) * tickScale)
        starPowerPhrases.push({ id: uuidv4(), tick, duration, instrument })
        continue
      }

      // Solo: tick = E solo / tick = E soloend (some charts)
      // Also check for solo markers via S type (less common)
    }

    // Process notes
    for (const [tick, noteEvents] of tickNotes) {
      const hasCymbal = cymbalTicks.has(tick)

      for (const { lane: laneNum, duration } of noteEvents) {
        let lane: DrumLane | GuitarLane | undefined

        if (type === 'guitar') {
          lane = CHART_GUITAR_LANES[laneNum]
        } else {
          // Drums: check if cymbal modifier is present for lanes 2/3/4
          if (hasCymbal && laneNum in CHART_DRUM_CYMBAL_LANES) {
            lane = CHART_DRUM_CYMBAL_LANES[laneNum]
          } else {
            lane = CHART_DRUM_LANES[laneNum]
          }
        }

        if (lane === undefined) continue

        notes.push({
          id: uuidv4(),
          tick,
          duration: type === 'drums' ? 0 : duration,
          instrument,
          difficulty,
          lane,
          velocity: 100,
          ...(type === 'drums' && laneNum === 5 ? { flags: { isDoubleKick: true } } : {})
        })
      }
    }
  }

  // Sort
  notes.sort((a, b) => a.tick - b.tick)
  vocalNotes.sort((a, b) => a.tick - b.tick)
  vocalPhrases.sort((a, b) => a.tick - b.tick)
  starPowerPhrases.sort((a, b) => a.tick - b.tick)
  soloSections.sort((a, b) => a.tick - b.tick)

  const lastNote = notes.length > 0 ? notes[notes.length - 1] : null
  const lastVocal = vocalNotes.length > 0 ? vocalNotes[vocalNotes.length - 1] : null
  console.log(`[Chart Parse] Result: ${notes.length} notes, ${vocalNotes.length} vocals, ${starPowerPhrases.length} SP, ${soloSections.length} solos`)
  if (lastNote) console.log(`[Chart Parse] Last instrument note at tick ${lastNote.tick} (${lastNote.instrument}/${lastNote.lane})`)
  if (lastVocal) console.log(`[Chart Parse] Last vocal note at tick ${lastVocal.tick}`)
  console.log(`[Chart Parse] Tempo events: ${tempoEvents.length}, first BPM: ${tempoEvents[0]?.bpm}`)

  return { notes, vocalNotes, vocalPhrases, starPowerPhrases, soloSections, tempoEvents, timeSignatures }
}

// ── .chart Serialization ─────────────────────────────────────────────
// Converts internal notes back to a .chart text file

// Reverse mapping: instrument + difficulty → .chart section name
const CHART_SECTION_NAMES: Record<string, Record<string, string>> = {
  guitar: { expert: 'ExpertSingle', hard: 'HardSingle', medium: 'MediumSingle', easy: 'EasySingle' },
  bass: { expert: 'ExpertDoubleBass', hard: 'HardDoubleBass', medium: 'MediumDoubleBass', easy: 'EasyDoubleBass' },
  drums: { expert: 'ExpertDrums', hard: 'HardDrums', medium: 'MediumDrums', easy: 'EasyDrums' },
  keys: { expert: 'ExpertKeyboard', hard: 'HardKeyboard', medium: 'MediumKeyboard', easy: 'EasyKeyboard' },
}

// Reverse guitar lane → .chart lane number
const CHART_GUITAR_LANE_NUM: Record<string, number> = {
  green: 0, red: 1, yellow: 2, blue: 3, orange: 4, open: 7
}

// Reverse drum lane → .chart lane number + cymbal flag
const CHART_DRUM_LANE_NUM: Record<string, { lane: number; cymbal: boolean }> = {
  kick: { lane: 0, cymbal: false },
  snare: { lane: 1, cymbal: false },
  yellowTom: { lane: 2, cymbal: false },
  yellowCymbal: { lane: 2, cymbal: true },
  blueTom: { lane: 3, cymbal: false },
  blueCymbal: { lane: 3, cymbal: true },
  greenTom: { lane: 4, cymbal: false },
  greenCymbal: { lane: 4, cymbal: true },
}

export function serializeChartFile(
  notes: Note[],
  tempoEvents: TempoEvent[],
  timeSignatures: TimeSignature[],
  starPowerPhrases: StarPowerPhrase[] = [],
  vocalNotes: VocalNote[] = [],
  vocalPhrases: VocalPhrase[] = [],
  _soloSections: SoloSection[] = [],
  metadata: Record<string, unknown> = {},
  resolution = 192
): string {
  const tickScale = resolution / 480 // Convert from internal 480 PPQ to chart resolution
  const scaleTick = (t: number): number => Math.round(t * tickScale)

  const lines: string[] = []

  // [Song] section
  lines.push('[Song]')
  lines.push('{')
  if (metadata.name) lines.push(`  Name = "${metadata.name}"`)
  if (metadata.artist) lines.push(`  Artist = "${metadata.artist}"`)
  if (metadata.charter) lines.push(`  Charter = "${metadata.charter}"`)
  if (metadata.album) lines.push(`  Album = "${metadata.album}"`)
  lines.push(`  Offset = 0`)
  lines.push(`  Resolution = ${resolution}`)
  lines.push(`  Player2 = bass`)
  lines.push(`  Difficulty = 0`)
  lines.push(`  PreviewStart = 0`)
  lines.push(`  PreviewEnd = 0`)
  if (metadata.genre) lines.push(`  Genre = "${metadata.genre}"`)
  lines.push(`  MediaType = "cd"`)
  lines.push('}')

  // [SyncTrack] section
  lines.push('[SyncTrack]')
  lines.push('{')
  for (const ts of timeSignatures) {
    const tick = scaleTick(ts.tick)
    // denominator = 2^power, so power = log2(denom)
    const denomPower = Math.round(Math.log2(ts.denominator))
    lines.push(`  ${tick} = TS ${ts.numerator} ${denomPower}`)
  }
  for (const te of tempoEvents) {
    const tick = scaleTick(te.tick)
    const milliBpm = Math.round(te.bpm * 1000)
    lines.push(`  ${tick} = B ${milliBpm}`)
  }
  lines.push('}')

  // [Events] section — vocal phrases and lyrics
  lines.push('[Events]')
  lines.push('{')
  // Vocal phrases
  for (const phrase of vocalPhrases) {
    const startTick = scaleTick(phrase.tick)
    const endTick = scaleTick(phrase.tick + phrase.duration)
    lines.push(`  ${startTick} = E "phrase_start"`)
    lines.push(`  ${endTick} = E "phrase_end"`)
  }
  // Vocal lyrics
  for (const vn of vocalNotes) {
    if (vn.lyric) {
      const tick = scaleTick(vn.tick)
      lines.push(`  ${tick} = E "lyric ${vn.lyric}"`)
    }
  }
  lines.push('}')

  // Group notes by instrument + difficulty
  const notesBySection = new Map<string, Note[]>()
  for (const note of notes) {
    const sectionMap = CHART_SECTION_NAMES[note.instrument]
    if (!sectionMap) continue
    const sectionName = sectionMap[note.difficulty]
    if (!sectionName) continue
    if (!notesBySection.has(sectionName)) notesBySection.set(sectionName, [])
    notesBySection.get(sectionName)!.push(note)
  }

  // Group star power by instrument
  const spByInstrument = new Map<string, StarPowerPhrase[]>()
  for (const sp of starPowerPhrases) {
    if (!spByInstrument.has(sp.instrument)) spByInstrument.set(sp.instrument, [])
    spByInstrument.get(sp.instrument)!.push(sp)
  }

  // Write instrument sections
  // Order sections consistently
  const sectionOrder = [
    'ExpertSingle', 'HardSingle', 'MediumSingle', 'EasySingle',
    'ExpertDoubleBass', 'HardDoubleBass', 'MediumDoubleBass', 'EasyDoubleBass',
    'ExpertDrums', 'HardDrums', 'MediumDrums', 'EasyDrums',
    'ExpertKeyboard', 'HardKeyboard', 'MediumKeyboard', 'EasyKeyboard',
  ]

  for (const sectionName of sectionOrder) {
    const sectionNotes = notesBySection.get(sectionName)
    if (!sectionNotes || sectionNotes.length === 0) continue

    const sectionInfo = CHART_SECTIONS[sectionName]
    if (!sectionInfo) continue

    // Get star power for this instrument + difficulty (SP is per-instrument, written once per section)
    const instrument = sectionInfo.instrument
    const isDrums = sectionInfo.type === 'drums'

    // Collect all entries: notes + star power, sorted by tick
    const entries: { tick: number; text: string }[] = []

    for (const note of sectionNotes) {
      const tick = scaleTick(note.tick)
      const duration = scaleTick(note.duration)

      if (isDrums) {
        const isDoubleKick = String(note.lane) === 'kick' && !!note.flags?.isDoubleKick
        const drumInfo = isDoubleKick
          ? { lane: 5, cymbal: false }
          : CHART_DRUM_LANE_NUM[note.lane as string]
        if (!drumInfo) continue
        entries.push({ tick, text: `${tick} = N ${drumInfo.lane} ${duration}` })
        if (drumInfo.cymbal) {
          entries.push({ tick, text: `${tick} = N 66 0` })
        }
      } else {
        const laneNum = CHART_GUITAR_LANE_NUM[note.lane as string]
        if (laneNum === undefined) continue
        entries.push({ tick, text: `${tick} = N ${laneNum} ${duration}` })
      }
    }

    // Add star power for this section (only on expert to avoid duplicates)
    if (sectionInfo.difficulty === 'expert') {
      const spList = spByInstrument.get(instrument) || []
      for (const sp of spList) {
        const tick = scaleTick(sp.tick)
        const duration = scaleTick(sp.duration)
        entries.push({ tick, text: `${tick} = S 2 ${duration}` })
      }
    }

    // Sort by tick
    entries.sort((a, b) => a.tick - b.tick)

    lines.push(`[${sectionName}]`)
    lines.push('{')
    for (const entry of entries) {
      lines.push(`  ${entry.text}`)
    }
    lines.push('}')
  }

  return lines.join('\n')
}

// ── MIDI Serialization ───────────────────────────────────────────────
// Converts internal notes back to a .mid file (base64 encoded)

// Reverse mapping: instrument → track name
const INSTRUMENT_TRACKS: Record<string, string> = {
  drums: 'PART DRUMS',
  guitar: 'PART GUITAR',
  bass: 'PART BASS',
  keys: 'PART KEYS'
}

// Reverse lane → MIDI note offset within a difficulty
const GUITAR_LANE_INDEX: Record<string, number> = {
  green: 0, red: 1, yellow: 2, blue: 3, orange: 4
}

const DRUM_LANE_TO_BASE: Record<string, number> = {
  kick: 0, snare: 1,
  yellowTom: 2, yellowCymbal: 2,
  blueTom: 3, blueCymbal: 3,
  greenTom: 4, greenCymbal: 4
}

// Tom lanes that need a marker note (110/111/112 mark toms)
const TOM_MARKER_NOTES: Record<string, number> = {
  yellowTom: 110,
  blueTom: 111,
  greenTom: 112
}

// Reverse mapping: harmony part → track name
const HARMONY_PART_TRACKS: Record<number, string> = {
  0: 'PART VOCALS',
  1: 'HARM1',
  2: 'HARM2',
  3: 'HARM3'
}

export function serializeMidiBase64(
  notes: Note[],
  tempoEvents: TempoEvent[],
  timeSignatures: TimeSignature[],
  ticksPerBeat = 480,
  starPowerPhrases: StarPowerPhrase[] = [],
  vocalNotes: VocalNote[] = [],
  vocalPhrases: VocalPhrase[] = [],
  soloSections: SoloSection[] = []
): string {
  const midi = new Midi()
  midi.header.fromJSON({
    name: '',
    ppq: ticksPerBeat,
    meta: [],
    tempos: tempoEvents.map((t) => ({ ticks: t.tick, bpm: t.bpm })),
    timeSignatures: timeSignatures.map((ts) => ({
      ticks: ts.tick,
      timeSignature: [ts.numerator, ts.denominator] as [number, number],
      measures: 0
    })),
    keySignatures: []
  })

  // Group notes by track name
  const trackNotes = new Map<string, Note[]>()
  for (const note of notes) {
    const trackName = INSTRUMENT_TRACKS[note.instrument]
    if (!trackName) continue
    if (!trackNotes.has(trackName)) trackNotes.set(trackName, [])
    trackNotes.get(trackName)!.push(note)
  }

  // Track for emitting tom markers (one per drum track)
  const emittedTomMarkers = new Set<string>()

  for (const [trackName, trackNoteList] of trackNotes) {
    const track = midi.addTrack()
    track.name = trackName
    const isDrums = trackName === 'PART DRUMS'

    for (const note of trackNoteList) {
      const diffOffset = isDrums
        ? DRUM_NOTE_OFFSETS[note.difficulty]
        : GUITAR_NOTE_OFFSETS[note.difficulty]

      let laneIndex: number
      if (isDrums) {
        const lane = note.lane as DrumLane
        laneIndex = DRUM_LANE_TO_BASE[lane] ?? 0

        // Emit tom marker if needed (once per tick+marker combo)
        const markerNote = TOM_MARKER_NOTES[lane]
        if (markerNote !== undefined) {
          const key = `${note.tick}-${markerNote}`
          if (!emittedTomMarkers.has(key)) {
            emittedTomMarkers.add(key)
            track.addNote({
              midi: markerNote,
              ticks: note.tick,
              durationTicks: 1,
              velocity: 1.0
            })
          }
        }
      } else {
        const lane = note.lane as GuitarLane
        laneIndex = GUITAR_LANE_INDEX[lane] ?? 0
      }

      const isDoubleKick = isDrums && (note.lane as DrumLane) === 'kick' && !!note.flags?.isDoubleKick
      const midiNoteNumber = diffOffset + laneIndex - (isDoubleKick ? 1 : 0)
      track.addNote({
        midi: midiNoteNumber,
        ticks: note.tick,
        durationTicks: Math.max(note.duration, 1),
        velocity: (note.velocity || 100) / 127
      })
    }

    // Add star power phrases for this instrument
    const instrumentName = trackName === 'PART DRUMS' ? 'drums'
      : trackName === 'PART GUITAR' ? 'guitar'
      : trackName === 'PART BASS' ? 'bass'
      : trackName === 'PART KEYS' ? 'keys' : null
    if (instrumentName) {
      for (const sp of starPowerPhrases) {
        if (sp.instrument === instrumentName) {
          track.addNote({
            midi: STAR_POWER_NOTE,
            ticks: sp.tick,
            durationTicks: Math.max(sp.duration, 1),
            velocity: 1.0
          })
        }
      }
      for (const solo of soloSections) {
        if (solo.instrument === instrumentName) {
          track.addNote({
            midi: SOLO_NOTE,
            ticks: solo.tick,
            durationTicks: Math.max(solo.duration, 1),
            velocity: 1.0
          })
        }
      }
    }
  }

  // ── Serialize Pro Keys Tracks ───────────────────────────────────────
  const PRO_KEYS_DIFFICULTY_TRACKS: Record<Difficulty, string> = {
    expert: 'PART REAL_KEYS_X',
    hard: 'PART REAL_KEYS_H',
    medium: 'PART REAL_KEYS_M',
    easy: 'PART REAL_KEYS_E'
  }

  // Group pro keys notes by difficulty
  const proKeysByDiff = new Map<Difficulty, Note[]>()
  for (const note of notes) {
    if (note.instrument !== 'proKeys') continue
    if (!proKeysByDiff.has(note.difficulty)) proKeysByDiff.set(note.difficulty, [])
    proKeysByDiff.get(note.difficulty)!.push(note)
  }

  for (const [diff, diffNotes] of proKeysByDiff) {
    const trackName = PRO_KEYS_DIFFICULTY_TRACKS[diff]
    const track = midi.addTrack()
    track.name = trackName

    for (const note of diffNotes) {
      const midiPitch = typeof note.lane === 'number' ? note.lane : 60
      if (midiPitch >= PRO_KEYS_NOTE_MIN && midiPitch <= PRO_KEYS_NOTE_MAX) {
        track.addNote({
          midi: midiPitch,
          ticks: note.tick,
          durationTicks: Math.max(note.duration, 1),
          velocity: (note.velocity || 100) / 127
        })
      }
    }

    // SP and solo for proKeys (only emit once, on expert track)
    if (diff === 'expert') {
      for (const sp of starPowerPhrases) {
        if (sp.instrument === 'proKeys') {
          track.addNote({ midi: STAR_POWER_NOTE, ticks: sp.tick, durationTicks: Math.max(sp.duration, 1), velocity: 1.0 })
        }
      }
      for (const solo of soloSections) {
        if (solo.instrument === 'proKeys') {
          track.addNote({ midi: SOLO_NOTE, ticks: solo.tick, durationTicks: Math.max(solo.duration, 1), velocity: 1.0 })
        }
      }
    }
  }

  // ── Serialize Pro Guitar/Bass Tracks ────────────────────────────────
  const PRO_GUITAR_INSTRUMENT_TRACKS: Record<string, string> = {
    proGuitar: 'PART REAL_GUITAR',
    proBass: 'PART REAL_BASS'
  }

  for (const [inst, trackName] of Object.entries(PRO_GUITAR_INSTRUMENT_TRACKS)) {
    const instNotes = notes.filter((n) => n.instrument === inst)
    if (instNotes.length === 0) {
      // Still check if there are SP/solo for this instrument
      const hasSpOrSolo = starPowerPhrases.some((s) => s.instrument === inst) || soloSections.some((s) => s.instrument === inst)
      if (!hasSpOrSolo) continue
    }

    const track = midi.addTrack()
    track.name = trackName

    for (const note of instNotes) {
      if (note.string === undefined || note.fret === undefined) continue
      const diffOffset = PRO_GUITAR_OFFSETS[note.difficulty]
      const stringOffset = 6 - note.string // string 1(highE)=5, string 6(lowE)=0
      const midiNote = diffOffset + stringOffset
      const fretVelocity = (100 + note.fret) / 127 // Encode fret as velocity 100+fret

      track.addNote({
        midi: midiNote,
        ticks: note.tick,
        durationTicks: Math.max(note.duration, 1),
        velocity: Math.min(1.0, fretVelocity)
      })
    }

    // SP and solo
    for (const sp of starPowerPhrases) {
      if (sp.instrument === inst) {
        track.addNote({ midi: STAR_POWER_NOTE, ticks: sp.tick, durationTicks: Math.max(sp.duration, 1), velocity: 1.0 })
      }
    }
    for (const solo of soloSections) {
      if (solo.instrument === inst) {
        track.addNote({ midi: SOLO_NOTE, ticks: solo.tick, durationTicks: Math.max(solo.duration, 1), velocity: 1.0 })
      }
    }
  }

  // ── Serialize Vocal Tracks ──────────────────────────────────────────
  // We need raw midi-file format for lyrics meta events
  // First convert existing @tonejs/midi data to raw format, then append vocal tracks
  const rawOut = parseMidi(midi.toArray())

  // Group vocal notes and phrases by harmony part
  const vocalsByPart = new Map<HarmonyPart, VocalNote[]>()
  const phrasesByPart = new Map<HarmonyPart, VocalPhrase[]>()
  for (const vn of vocalNotes) {
    if (!vocalsByPart.has(vn.harmonyPart)) vocalsByPart.set(vn.harmonyPart, [])
    vocalsByPart.get(vn.harmonyPart)!.push(vn)
  }
  for (const vp of vocalPhrases) {
    if (!phrasesByPart.has(vp.harmonyPart)) phrasesByPart.set(vp.harmonyPart, [])
    phrasesByPart.get(vp.harmonyPart)!.push(vp)
  }

  for (const [part, partNotes] of vocalsByPart) {
    const trackName = HARMONY_PART_TRACKS[part]
    if (!trackName) continue

    // Build raw MIDI events for this vocal track
    type RawEvent = RawMidiEvent & { absTick: number }
    const events: RawEvent[] = []

    // Track name event
    events.push({ type: 'trackName', text: trackName, deltaTime: 0, absTick: 0 } as RawEvent)

    // Sort notes by tick
    const sortedNotes = [...partNotes].sort((a, b) => a.tick - b.tick)

    // Add note events and lyrics
    for (const vn of sortedNotes) {
      // Lyric event (before note on)
      if (vn.lyric) {
        let lyricText = vn.isSlide ? `+${vn.lyric}` : vn.lyric
        events.push({ type: 'lyrics', text: lyricText, deltaTime: 0, absTick: vn.tick } as RawEvent)
      }

      const midiNote = vn.isPercussion ? VOCAL_PERCUSSION_NOTE : (typeof vn.lane === 'number' ? vn.lane : VOCAL_PITCH_MIN)

      // Note on
      events.push({
        type: 'noteOn', noteNumber: midiNote, velocity: vn.velocity || 100,
        channel: 0, deltaTime: 0, absTick: vn.tick
      } as RawEvent)

      // Note off
      events.push({
        type: 'noteOff', noteNumber: midiNote, velocity: 0,
        channel: 0, deltaTime: 0, absTick: vn.tick + Math.max(vn.duration, 1)
      } as RawEvent)
    }

    // Add phrase markers
    const partPhrases = phrasesByPart.get(part) || []
    for (const phrase of partPhrases) {
      events.push({
        type: 'noteOn', noteNumber: VOCAL_PHRASE_NOTE, velocity: 100,
        channel: 0, deltaTime: 0, absTick: phrase.tick
      } as RawEvent)
      events.push({
        type: 'noteOff', noteNumber: VOCAL_PHRASE_NOTE, velocity: 0,
        channel: 0, deltaTime: 0, absTick: phrase.tick + Math.max(phrase.duration, 1)
      } as RawEvent)
    }

    // Add vocal star power
    for (const sp of starPowerPhrases) {
      if (sp.instrument === 'vocals') {
        events.push({
          type: 'noteOn', noteNumber: STAR_POWER_NOTE, velocity: 100,
          channel: 0, deltaTime: 0, absTick: sp.tick
        } as RawEvent)
        events.push({
          type: 'noteOff', noteNumber: STAR_POWER_NOTE, velocity: 0,
          channel: 0, deltaTime: 0, absTick: sp.tick + Math.max(sp.duration, 1)
        } as RawEvent)
      }
    }

    // Add vocal solo sections
    for (const solo of soloSections) {
      if (solo.instrument === 'vocals') {
        events.push({
          type: 'noteOn', noteNumber: SOLO_NOTE, velocity: 100,
          channel: 0, deltaTime: 0, absTick: solo.tick
        } as RawEvent)
        events.push({
          type: 'noteOff', noteNumber: SOLO_NOTE, velocity: 0,
          channel: 0, deltaTime: 0, absTick: solo.tick + Math.max(solo.duration, 1)
        } as RawEvent)
      }
    }

    // Sort by absolute tick, then convert to delta times
    events.sort((a, b) => a.absTick - b.absTick)
    let prevTick = 0
    const rawEvents: RawMidiEvent[] = []
    for (const ev of events) {
      const delta = ev.absTick - prevTick
      prevTick = ev.absTick
      const { absTick: _, ...rest } = ev
      rawEvents.push({ ...rest, deltaTime: delta } as RawMidiEvent)
    }
    rawEvents.push({ type: 'endOfTrack', deltaTime: 0 } as RawMidiEvent)

    rawOut.tracks.push(rawEvents)
  }

  // Convert to base64 using midi-file's writeMidi
  const midiBytes = writeMidi(rawOut)
  const arrayBuffer = new Uint8Array(midiBytes)
  let binary = ''
  for (let i = 0; i < arrayBuffer.length; i++) {
    binary += String.fromCharCode(arrayBuffer[i])
  }
  return btoa(binary)
}
