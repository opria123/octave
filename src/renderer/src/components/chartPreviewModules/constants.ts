// YARG Constants and Color Profiles
// Replicated from YARG source (TrackPlayer.cs, FretArray.cs, GenericTrackPlayer.cs)

export const TRACK_WIDTH = 2.8
export const STRIKE_LINE_POS = -2.0
export const HIGHWAY_LENGTH = 28
export const BASE_PIXELS_PER_TICK = 0.01
export const UNITY_IMPORT_SCALE = 0.01 // Unity FBX import: cm → meters

// YARG camera — distance reduced to bring strike line lower in viewport
export const CAMERA_HEIGHT = 2.66
export const CAMERA_DISTANCE = 3.0
export const CAMERA_ANGLE = 24.12
export const CAMERA_FOV = 55

// Guitar: 5 lanes (green, red, yellow, blue, orange)
export const GUITAR_COLORS = ['#79D304', '#FF1D23', '#FFE900', '#00BFFF', '#FF8400']
export const GUITAR_INNER = ['#3E6A02', '#801012', '#807500', '#00608C', '#804200']
// Drums: 4 lanes (red, yellow, blue, green) — kick is separate full-width bar
export const DRUM_COLORS = ['#FF1D23', '#FFE900', '#00BFFF', '#79D304']
export const DRUM_INNER = ['#801012', '#807500', '#00608C', '#3E6A02']
export const DRUM_KICK_COLOR = '#C800FF'
// Pro Guitar/Bass: 6 strings (high E → low E) — RB3 string colors
export const PRO_GUITAR_COLORS = ['#FF1D23', '#FFE900', '#00BFFF', '#FF8400', '#79D304', '#C800FF']
export const PRO_GUITAR_INNER = ['#801012', '#807500', '#00608C', '#804200', '#3E6A02', '#640080']
// Pro Keys: uses piano-style coloring — white/black keys mapped to YARG purple
export const PRO_KEYS_COLOR = '#A78BFA'
export const PRO_KEYS_LANE_COUNT = 25 // C3 to C5 (MIDI 48-72)
export const PRO_KEYS_MIN = 48
export const PRO_KEYS_MAX = 72
// YARG shows ~10 white keys at a time; that's about 17 total keys (white+black)
// We show a sliding window of VISIBLE_KEYS keys on the highway
export const PRO_KEYS_VISIBLE = 17

// Vocals: pitch-based rendering
export const VOCAL_COLOR = '#E879F9'
export const VOCAL_LANE_COUNT = 12 // one octave of visual lanes

export const GUITAR_LANE_COUNT = 5
export const DRUM_LANE_COUNT = 4
export const PRO_GUITAR_LANE_COUNT = 6

// YARG fret scale: FretArray.cs — (trackWidth/2)/(FretCount/(2/5))
export const GUITAR_FRET_SCALE_X = 1.0
export const DRUM_FRET_SCALE_X = 1.25

// YARG fret inactive color (FretArray.cs)
export const FRET_INACTIVE_COLOR = '#525252'

export const COLORS = {
  guitar: { notes: GUITAR_COLORS, fretInner: GUITAR_INNER },
  drums: { notes: DRUM_COLORS, fretInner: DRUM_INNER },
  proGuitar: { notes: PRO_GUITAR_COLORS, fretInner: PRO_GUITAR_INNER },
  strikeline: '#FFFFFF',
  trackBase: '#0F0F0F',
  trackLine: '#4B4B4B',
  trackEdge: '#575757',
  railColor: '#1144AA',
  railGlow: '#2266DD',
  beatlineMeasure: '#FFFFFF',
  beatlineStrong: '#FFFFFF',
  beatlineWeak: '#FFFFFF'
}

// Animation timing (tick-based)
export const HIT_EFFECT_TICKS = 200
export const FRET_PRESS_TICKS = 80

export type InstrumentRenderType = 'drums' | 'guitar' | 'proGuitar' | 'proKeys' | 'vocals'

// Helper functions
export function getLaneConfig(instrumentType: InstrumentRenderType): { laneCount: number; laneWidth: number } {
  const laneCount = instrumentType === 'drums' ? DRUM_LANE_COUNT
    : instrumentType === 'proGuitar' ? PRO_GUITAR_LANE_COUNT
    : instrumentType === 'proKeys' ? PRO_KEYS_VISIBLE
    : instrumentType === 'vocals' ? VOCAL_LANE_COUNT
    : GUITAR_LANE_COUNT
  return { laneCount, laneWidth: TRACK_WIDTH / laneCount }
}

// YARG fret position formula (FretArray.cs):
// x = trackWidth/FretCount * i - trackWidth/2 + trackWidth/(2*FretCount)
export function getFretX(lane: number, laneCount: number): number {
  return (TRACK_WIDTH / laneCount) * lane - TRACK_WIDTH / 2 + TRACK_WIDTH / (2 * laneCount)
}

// Piano key helpers for pro keys
const BLACK_KEY_OFFSETS = new Set([1, 3, 6, 8, 10]) // C# D# F# G# A#
export function isBlackKey(midiPitch: number): boolean {
  return BLACK_KEY_OFFSETS.has(midiPitch % 12)
}

// Map MIDI pitch (48-72) to lane index (0-24) for pro keys
export function pitchToProKeysLane(pitch: number): number {
  return Math.max(0, Math.min(PRO_KEYS_LANE_COUNT - 1, pitch - PRO_KEYS_MIN))
}

// Compute the lowest visible key for the pro keys sliding viewport
// Centers the view on the notes near the current playhead, clamped to valid range
export function computeProKeysViewStart(
  notes: { tick: number; lane: number | string }[],
  currentTick: number,
  lookAheadTicks: number = 2400
): number {
  // Gather pitches from notes near playhead
  const nearby = notes.filter(
    (n) => n.tick >= currentTick - 480 && n.tick <= currentTick + lookAheadTicks
  )
  if (nearby.length === 0) return PRO_KEYS_MIN // default: start at C3

  let minPitch = PRO_KEYS_MAX
  let maxPitch = PRO_KEYS_MIN
  for (const n of nearby) {
    const p = typeof n.lane === 'number' ? n.lane : parseInt(String(n.lane))
    if (p >= PRO_KEYS_MIN && p <= PRO_KEYS_MAX) {
      if (p < minPitch) minPitch = p
      if (p > maxPitch) maxPitch = p
    }
  }

  // Center the visible window on the note range
  const center = Math.round((minPitch + maxPitch) / 2)
  const halfVisible = Math.floor(PRO_KEYS_VISIBLE / 2)
  const viewStart = Math.max(PRO_KEYS_MIN, Math.min(PRO_KEYS_MAX - PRO_KEYS_VISIBLE + 1, center - halfVisible))
  return viewStart
}

// Map vocal pitch to normalized position (0-1 across track width)
export function vocalPitchToX(pitch: number, pitchMin: number, pitchMax: number): number {
  const norm = (pitch - pitchMin) / Math.max(1, pitchMax - pitchMin)
  return norm * TRACK_WIDTH - TRACK_WIDTH / 2
}
