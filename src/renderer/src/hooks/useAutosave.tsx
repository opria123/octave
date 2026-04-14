// Autosave hook - automatically saves dirty songs
import { useEffect, useRef, useCallback } from 'react'
import { useSettingsStore, useProjectStore, getSongStore } from '../stores'
import { serializeMidiBase64, serializeChartFile } from '../utils/midiParser'

const DEFAULT_DEBOUNCE_MS = 2000

export function useAutosave(): void {
  const { autosaveEnabled, autosaveIntervalMs } = useSettingsStore()
  const { songIds } = useProjectStore()
  const timeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map())

  const saveSong = useCallback(async (songId: string) => {
    const store = getSongStore(songId)
    const state = store.getState()

    if (!state.isDirty) return

    try {
      // Save song.ini
      const metadata = state.song.metadata
      await window.api.writeSongIni(state.song.folderPath, metadata)

      // Save video.json (video sync + clip data) — always save regardless of notes
      const vs = state.song.videoSync
      if (vs.videoPath || vs.clips.length > 0) {
        await window.api.writeVideoJson(state.song.folderPath, {
          videoPath: vs.videoPath,
          clips: vs.clips,
          offsetMs: vs.offsetMs
        })
      }

      // Don't overwrite notes.mid if there are no notes at all - prevents
      // clobbering a valid file when parse failed or song hasn't loaded yet
      const hasNotes = state.song.notes.length > 0 || state.song.vocalNotes.length > 0
      if (!hasNotes) {
        console.warn(`Autosave skipped MIDI for "${state.song.metadata.name}" — no notes to save`)
        store.getState().markClean()
        return
      }

      // Save notes in the original format (notes.mid or notes.chart)
      if (state.song.sourceFormat === 'chart') {
        const chartText = serializeChartFile(
          state.song.notes,
          state.song.tempoEvents,
          state.song.timeSignatures,
          state.song.starPowerPhrases,
          state.song.vocalNotes,
          state.song.vocalPhrases,
          state.song.soloSections,
          state.song.metadata as Record<string, unknown>
        )
        await window.api.writeSongChart(state.song.folderPath, chartText)
      } else {
        const midiBase64 = serializeMidiBase64(
          state.song.notes,
          state.song.tempoEvents,
          state.song.timeSignatures,
          480,
          state.song.starPowerPhrases,
          state.song.vocalNotes,
          state.song.vocalPhrases,
          state.song.soloSections
        )
        await window.api.writeSongMidi(state.song.folderPath, midiBase64)
      }

      store.getState().markClean()

      console.log(`Autosaved: ${state.song.metadata.name}`)
    } catch (error) {
      console.error(`Failed to autosave ${songId}:`, error)
    }
  }, [])

  const scheduleSave = useCallback(
    (songId: string) => {
      // Clear existing timeout
      const existingTimeout = timeoutsRef.current.get(songId)
      if (existingTimeout) {
        clearTimeout(existingTimeout)
      }

      // Schedule new save
      const timeout = setTimeout(() => {
        saveSong(songId)
        timeoutsRef.current.delete(songId)
      }, autosaveIntervalMs || DEFAULT_DEBOUNCE_MS)

      timeoutsRef.current.set(songId, timeout)
    },
    [saveSong, autosaveIntervalMs]
  )

  // Subscribe to song store changes
  useEffect(() => {
    if (!autosaveEnabled) return

    const unsubscribers: (() => void)[] = []

    for (const songId of songIds) {
      const store = getSongStore(songId)

      const unsubscribe = store.subscribe((state, prevState) => {
        // Only trigger autosave if the song became dirty
        if (state.isDirty && !prevState.isDirty) {
          scheduleSave(songId)
        }
        // Also trigger if there are new changes while already dirty
        else if (state.isDirty && state.song !== prevState.song) {
          scheduleSave(songId)
        }
      })

      unsubscribers.push(unsubscribe)
    }

    return () => {
      unsubscribers.forEach((unsub) => unsub())

      // Clear all pending timeouts
      timeoutsRef.current.forEach((timeout) => clearTimeout(timeout))
      timeoutsRef.current.clear()
    }
  }, [autosaveEnabled, songIds, scheduleSave])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      timeoutsRef.current.forEach((timeout) => clearTimeout(timeout))
      timeoutsRef.current.clear()
    }
  }, [])
}

// Provider component to initialize autosave
export function AutosaveProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  useAutosave()
  return <>{children}</>
}
