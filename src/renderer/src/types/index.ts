// Chart Editor Type Definitions

// Note types for different instruments
export type Instrument = 'drums' | 'guitar' | 'bass' | 'vocals' | 'keys' | 'proKeys' | 'proGuitar' | 'proBass'
export type Difficulty = 'expert' | 'hard' | 'medium' | 'easy'

// Drum pad lanes (Pro Drums)
export type DrumLane = 'kick' | 'snare' | 'yellowTom' | 'yellowCymbal' | 'blueTom' | 'blueCymbal' | 'greenTom' | 'greenCymbal'

// Guitar/Bass fret lanes (5-fret)
export type GuitarLane = 'open' | 'green' | 'red' | 'yellow' | 'blue' | 'orange'

// Pro Guitar/Bass: 6 strings (or 4 for bass), fret 0-22
export type ProGuitarString = 1 | 2 | 3 | 4 | 5 | 6
export type ProGuitarFret = number // 0-22

// Pro Keys: MIDI note range 48-72 (C3-C5, 25 keys)
export const PRO_KEYS_MIN = 48
export const PRO_KEYS_MAX = 72

// Base note interface
export interface Note {
  id: string
  tick: number // Position in ticks (480 per beat for MIDI)
  duration: number // Duration in ticks (0 for non-sustained notes like drums)
  instrument: Instrument
  difficulty: Difficulty
  lane: DrumLane | GuitarLane | number // number for vocals pitch
  velocity: number // 0-127
  flags?: NoteFlags  // Pro Guitar/Bass specific
  string?: ProGuitarString // Which string (1=high E, 6=low E)
  fret?: ProGuitarFret // Which fret (0=open, 1-22)
}

export interface NoteFlags {
  isHOPO?: boolean // Hammer-on/Pull-off for guitar
  isTap?: boolean // Tap note for guitar
  isAccent?: boolean // Accented hit for drums
  isGhost?: boolean // Ghost note for drums
  isCymbal?: boolean // Cymbal vs tom for drums
  isDoubleKick?: boolean // Double-bass callout for kick notes
}

// Harmony parts for vocals
export type HarmonyPart = 0 | 1 | 2 | 3 // 0 = main (PART VOCALS), 1-3 = HARM1-3

// Vocal-specific note with lyrics and pitch
export interface VocalNote extends Note {
  instrument: 'vocals'
  lyric?: string               // Lyric syllable text
  harmonyPart: HarmonyPart     // Which vocal track (main or harmony 1-3)
  isSlide?: boolean            // Pitch slide from previous note ('+' prefix in MIDI)
  isPercussion?: boolean       // Non-pitched percussion hit (MIDI note 96-97)
  isPitchless?: boolean        // Talky/unpitched section (note 2 or range indicator)
}

// Vocal phrase - groups vocal notes into singable phrases
export interface VocalPhrase {
  id: string
  tick: number                 // Start tick of phrase
  duration: number             // Duration in ticks
  harmonyPart: HarmonyPart     // Which vocal track
}

// Time signature event
export interface TimeSignature {
  tick: number
  numerator: number
  denominator: number
}

// Tempo/BPM event
export interface TempoEvent {
  tick: number
  bpm: number
}

// Song metadata (song.ini format)
export interface SongMetadata {
  name: string
  artist: string
  album?: string
  genre?: string
  year?: string
  charter?: string
  song_length?: number // milliseconds
  preview_start_time?: number // milliseconds
  diff_drums?: number // -1 to 6
  diff_guitar?: number
  diff_bass?: number
  diff_vocals?: number
  diff_keys?: number
  diff_prokeys?: number
  diff_proguitar?: number
  diff_probass?: number
  loading_phrase?: string
  icon?: string
  [key: string]: string | number | undefined
}

// Video sync settings
export interface VideoClip {
  id: string
  startMs: number  // Position on the timeline (in ms from song start)
  sourceStartMs: number // Where in the source video this clip starts
  durationMs: number // Duration of this clip
}

export interface VideoSync {
  videoPath?: string
  clips: VideoClip[] // Individual clips on the timeline
  offsetMs: number // Legacy: global offset (kept for migration)
  trimStartMs: number // Legacy: kept for migration
  trimEndMs: number // Legacy: kept for migration
}

// Star Power phrase
export interface StarPowerPhrase {
  id: string
  tick: number
  duration: number // in ticks
  instrument: Instrument
}

// Solo section
export interface SoloSection {
  id: string
  tick: number
  duration: number // in ticks
  instrument: Instrument
}

// Complete song data
export interface SongData {
  id: string
  folderPath: string
  metadata: SongMetadata
  notes: Note[]
  vocalNotes: VocalNote[]
  vocalPhrases: VocalPhrase[]
  starPowerPhrases: StarPowerPhrase[]
  soloSections: SoloSection[]
  tempoEvents: TempoEvent[]
  timeSignatures: TimeSignature[]
  videoSync: VideoSync
  audioPath?: string
  albumArtPath?: string
  sourceFormat: 'midi' | 'chart'
}

// Editor state for a song
export interface SongEditorState {
  song: SongData
  selectedNoteIds: string[]
  selectedSpId: string | null
  selectedSoloId: string | null
  selectedVocalNoteIds: string[]
  selectedVocalPhraseId: string | null
  activeHarmonyPart: HarmonyPart
  currentTick: number
  zoomLevel: number
  isPlaying: boolean
  isDirty: boolean
  visibleInstruments: Set<Instrument>
  activeDifficulty: Difficulty
  snapDivision: number // 1 = whole, 4 = quarter, 8 = eighth, etc.
}

// Project state
export interface ProjectState {
  loadedFolderPath: string | null
  songIds: string[]
  activeSongId: string | null
}

// Application settings
export interface AppSettings {
  autosaveEnabled: boolean
  autosaveIntervalMs: number
  theme: 'dark' | 'light'
  highwaySpeed: number // 1.0 = normal
  audioLatencyMs: number
  volume: number // 0.0 - 1.0
  pianoRollZoom: number // 0.1 - 5.0
  snapDivision: number // 1-32
  lastOpenedFolder?: string
}

// UI state
export type EditingTool = 'select' | 'place' | 'erase'

// Toggle modifiers for note placement (sticky toggles, not held keys)
export interface NoteModifiers {
  cymbalOrTap: boolean   // Shift-equivalent: cymbal (drums) / tap (guitar)
  ghostOrHopo: boolean   // Alt-equivalent: ghost (drums) / HOPO (guitar)
  accent: boolean        // Accent for all instruments
  openOrKick: boolean    // Open strum (guitar/bass) / kick (drums)
  starPower: boolean     // Star Power phrase placement mode
  solo: boolean           // Solo section placement mode
}

export interface UIState {
  leftPanelWidth: number
  rightPanelWidth: number
  bottomPanelHeight: number
  bottomPanelTab: 'midi' | 'video'
  focusedPanel: 'explorer' | 'preview' | 'properties' | 'midi' | 'video' | null
  editTool: EditingTool
  noteModifiers: NoteModifiers
  isPreviewFullscreen: boolean
}

// Clone Hero/YARG MIDI note mappings
export const MIDI_DRUM_NOTES = {
  expert: { kick: 96, snare: 97, yellow: 98, blue: 99, green: 100 },
  hard: { kick: 84, snare: 85, yellow: 86, blue: 87, green: 88 },
  medium: { kick: 72, snare: 73, yellow: 74, blue: 75, green: 76 },
  easy: { kick: 60, snare: 61, yellow: 62, blue: 63, green: 64 }
} as const

export const MIDI_DRUM_CYMBAL_MARKERS = {
  yellow: 110,
  blue: 111,
  green: 112
} as const

export const MIDI_GUITAR_NOTES = {
  expert: { green: 96, red: 97, yellow: 98, blue: 99, orange: 100 },
  hard: { green: 84, red: 85, yellow: 86, blue: 87, orange: 88 },
  medium: { green: 72, red: 73, yellow: 74, blue: 75, orange: 76 },
  easy: { green: 60, red: 61, yellow: 62, blue: 63, orange: 64 }
} as const

// Ticks per beat (standard MIDI resolution)
export const TICKS_PER_BEAT = 480

// Sustain threshold: notes with duration >= this (in ticks) render as sustains.
// Notes below this threshold render as short "strum" gems.
// For .mid files: 1/12th note = resolution/3 = 160 ticks at 480 PPQ (per YARG/CH spec).
// For .chart files: no cutoff — any note with duration > 0 is a sustain.
export const SUSTAIN_THRESHOLD_MID = Math.round(TICKS_PER_BEAT / 3) // 160 ticks
export const SUSTAIN_THRESHOLD_CHART = 1 // duration > 0 means sustain

// Default snap divisions
export const SNAP_DIVISIONS = [1, 2, 4, 8, 12, 16, 24, 32, 48, 64] as const
