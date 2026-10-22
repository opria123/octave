import type { SongData } from '../types'
import { serializeChartFile } from './midiParser'

/** Resolution Clone Hero tooling expects in a .chart written by OCTAVE. */
export const CHART_EXPORT_RESOLUTION = 192

/** Serializes the live editor state of a song into notes.chart text. */
export function serializeSongToChartText(song: SongData): string {
  return serializeChartFile(
    song.notes,
    song.tempoEvents,
    song.timeSignatures,
    song.starPowerPhrases,
    song.vocalNotes,
    song.vocalPhrases,
    song.soloSections,
    song.songSections,
    song.metadata as Record<string, unknown>,
    CHART_EXPORT_RESOLUTION,
    song.laneMarkers,
    song.venueTrack
  )
}
