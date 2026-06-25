// Centralized playback controller - single source of truth for play/pause/stop.
// Eliminates duplicate RAF loops that caused desync between components.

import * as audioService from './audioService'
import { getSongStore, useSettingsStore, useUIStore } from '../stores'
import type { TempoEvent } from '../types'

let visualRafId: number | null = null

// Track the tick position where each song last started playback, so Stop can return there
const playbackStartTicks = new Map<string, number>()

function cancelVisualRaf(): void {
  if (visualRafId !== null) {
    cancelAnimationFrame(visualRafId)
    visualRafId = null
  }
}

// ── Tempo-aware tick↔seconds for visual-only fallback ────────────────
const TICKS_PER_BEAT = 480

function tickToSeconds(tick: number, tempoEvents: TempoEvent[]): number {
  let seconds = 0
  let prevTick = 0
  let bpm = tempoEvents[0]?.bpm ?? 120

  for (let i = 0; i < tempoEvents.length; i++) {
    const event = tempoEvents[i]
    if (event.tick >= tick) break
    const segmentTicks = event.tick - prevTick
    seconds += segmentTicks / ((TICKS_PER_BEAT * bpm) / 60)
    prevTick = event.tick
    bpm = event.bpm
  }

  const remainingTicks = tick - prevTick
  seconds += remainingTicks / ((TICKS_PER_BEAT * bpm) / 60)
  return seconds
}

function secondsToTick(seconds: number, tempoEvents: TempoEvent[]): number {
  let accSeconds = 0
  let prevTick = 0
  let bpm = tempoEvents[0]?.bpm ?? 120

  for (let i = 0; i < tempoEvents.length; i++) {
    const event = tempoEvents[i]
    const segmentTicks = event.tick - prevTick
    const segmentSeconds = segmentTicks / ((TICKS_PER_BEAT * bpm) / 60)
    if (accSeconds + segmentSeconds >= seconds) break
    accSeconds += segmentSeconds
    prevTick = event.tick
    bpm = event.bpm
  }

  const remainingSeconds = seconds - accSeconds
  const remainingTicks = remainingSeconds * ((TICKS_PER_BEAT * bpm) / 60)
  return Math.round(prevTick + remainingTicks)
}

// ── Vocal pitch playback (issue #10) ─────────────────────────────────
// When the UI toggle is on, sound a sine tone for each vocal note of the
// active harmony part as the playhead crosses its start tick, so charters can
// compare charted pitches against the real vocal while the song plays.

function triggerVocalPitchTones(
  songId: string,
  fromTick: number,
  toTick: number,
  tempoEvents: TempoEvent[],
  speed: number
): void {
  if (!useUIStore.getState().vocalPitchPlayback) return
  // Ignore backwards jumps and big forward jumps (seeks) — only sound notes
  // crossed by normal playback progression.
  if (toTick <= fromTick || toTick - fromTick > TICKS_PER_BEAT * 2) return

  const state = getSongStore(songId).getState()
  const part = state.activeHarmonyPart
  for (const note of state.song.vocalNotes) {
    if (note.harmonyPart !== part || note.isPercussion || note.isPitchless) continue
    if (typeof note.lane !== 'number') continue
    if (note.tick >= fromTick && note.tick < toTick) {
      const durationSec =
        (tickToSeconds(note.tick + note.duration, tempoEvents) -
          tickToSeconds(note.tick, tempoEvents)) /
        Math.max(0.1, speed)
      audioService.playVocalTone(note.lane, durationSec)
    }
  }
}

function startVisualRaf(
  songId: string,
  startTick: number,
  tempoEvents: TempoEvent[],
  speed: number = 1.0
): void {
  cancelVisualRaf()
  const startSeconds = tickToSeconds(startTick, tempoEvents)
  const startTime = performance.now()
  const store = getSongStore(songId)
  let lastUpdateTime = 0

  const tick = (): void => {
    if (!store.getState().isPlaying) {
      visualRafId = null
      return
    }
    const now = performance.now()
    // Throttle to ~30fps to reduce downstream re-renders
    if (now - lastUpdateTime >= 33) {
      lastUpdateTime = now
      const elapsed = ((now - startTime) / 1000) * speed
      const currentSeconds = startSeconds + elapsed
      const newTick = secondsToTick(currentSeconds, tempoEvents)
      const prevTick = store.getState().currentTick
      store.getState().setCurrentTick(newTick)
      triggerVocalPitchTones(songId, prevTick, newTick, tempoEvents, speed)
    }
    visualRafId = requestAnimationFrame(tick)
  }

  visualRafId = requestAnimationFrame(tick)
}

/** Stop all playback: audio RAF, visual RAF, and store state. */
export function stopPlayback(songId: string): void {
  audioService.stop(songId)
  audioService.stopAllVocalTones()
  cancelVisualRaf()
  getSongStore(songId).getState().setIsPlaying(false)
}

/** Start playback for a song. Handles audio + visual fallback. */
export async function startPlayback(songId: string): Promise<void> {
  // Ensure AudioContext is resumed
  await audioService.init()

  const store = getSongStore(songId)
  const state = store.getState()
  const tempoEvents = state.song.tempoEvents
  const startTick = state.currentTick

  // Remember where this playback run started so Stop can return here
  playbackStartTicks.set(songId, startTick)
  const speed = useSettingsStore.getState().highwaySpeed
  const audioSync = state.song.audioSync

  // Mark as playing
  store.getState().setIsPlaying(true)

  const audioLoaded = audioService.isAudioLoaded(songId)
  if (audioLoaded) {
    const started = await audioService.play(
      songId,
      startTick,
      tempoEvents,
      (tick) => {
        // Only update if still playing (prevent stale updates after stop)
        if (getSongStore(songId).getState().isPlaying) {
          const prevTick = getSongStore(songId).getState().currentTick
          getSongStore(songId).getState().setCurrentTick(tick)
          triggerVocalPitchTones(songId, prevTick, tick, tempoEvents, speed)
        }
      },
      () => {
        // Audio ended naturally
        cancelVisualRaf()
        getSongStore(songId).getState().setIsPlaying(false)
      },
      speed,
      audioSync
    )
    if (!started) {
      // Audio failed — fall back to visual-only
      startVisualRaf(songId, startTick, tempoEvents, speed)
    }
  } else {
    // No audio loaded — visual-only playback
    startVisualRaf(songId, startTick, tempoEvents, speed)
  }
}

/** Toggle play/pause. Returns a promise that resolves when the toggle is complete. */
export async function togglePlayback(songId: string): Promise<void> {
  const store = getSongStore(songId)
  if (store.getState().isPlaying) {
    stopPlayback(songId)
  } else {
    await startPlayback(songId)
  }
}

/** Stop playback for a specific song and return to where playback began. */
export function stopAndReset(songId: string): void {
  stopPlayback(songId)
  const startTick = playbackStartTicks.get(songId) ?? 0
  playbackStartTicks.delete(songId)
  getSongStore(songId).getState().setCurrentTick(startTick)
}

/** Stop everything — used on song switch. */
export function stopAll(): void {
  audioService.stopAll()
  audioService.stopAllVocalTones()
  cancelVisualRaf()
}
