// Audio service using Web Audio API directly (replaces Tone.js for reliability in Electron)
// Audio files are streamed via song-file:// custom protocol instead of base64 IPC

import type { TempoEvent } from '../types'

// ── Tempo-aware tick↔seconds conversion ──────────────────────────────
// Handles songs with tempo changes by walking the tempo map.
const TICKS_PER_BEAT = 480

export function tickToSeconds(tick: number, tempoEvents: TempoEvent[]): number {
  let seconds = 0
  let prevTick = 0
  let bpm = tempoEvents[0]?.bpm ?? 120

  for (let i = 0; i < tempoEvents.length; i++) {
    const event = tempoEvents[i]
    if (event.tick >= tick) break
    // Accumulate time for the segment before this tempo change
    const segmentTicks = event.tick - prevTick
    seconds += segmentTicks / ((TICKS_PER_BEAT * bpm) / 60)
    prevTick = event.tick
    bpm = event.bpm
  }

  // Add remaining ticks at current BPM
  const remainingTicks = tick - prevTick
  seconds += remainingTicks / ((TICKS_PER_BEAT * bpm) / 60)
  return seconds
}

export function secondsToTick(seconds: number, tempoEvents: TempoEvent[]): number {
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

  // Convert remaining seconds to ticks at current BPM
  const remainingSeconds = seconds - accSeconds
  const remainingTicks = remainingSeconds * ((TICKS_PER_BEAT * bpm) / 60)
  return Math.round(prevTick + remainingTicks)
}

interface AudioState {
  buffers: AudioBuffer[]
  sourceNodes: AudioBufferSourceNode[]
  gainNode: GainNode | null
  isLoaded: boolean
  duration: number
  isPlaying: boolean
  startOffset: number
  startTimestamp: number
  rafId: number | null
  speed: number
}

const audioRegistry = new Map<string, AudioState>()
let activeSongId: string | null = null
let currentVolume = 0.8

// Shared AudioContext - created once and reused
let sharedContext: AudioContext | null = null

function getContext(): AudioContext {
  if (!sharedContext || sharedContext.state === 'closed') {
    sharedContext = new AudioContext()
    console.log('[Audio] Created new AudioContext, state:', sharedContext.state)
  }
  return sharedContext
}

// Initialize AudioContext - call this from a user gesture (click handler) to ensure it can resume
export async function init(): Promise<void> {
  const ctx = getContext()
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume()
      console.log('[Audio] AudioContext resumed via init(), state:', ctx.state)
    } catch (err) {
      console.error('[Audio] Failed to resume AudioContext:', err)
    }
  }
}

function getAudioState(songId: string): AudioState {
  let state = audioRegistry.get(songId)
  if (!state) {
    state = {
      buffers: [],
      sourceNodes: [],
      gainNode: null,
      isLoaded: false,
      duration: 0,
      isPlaying: false,
      startOffset: 0,
      startTimestamp: 0,
      rafId: null,
      speed: 1.0
    }
    audioRegistry.set(songId, state)
  }
  return state
}

// Load audio for a song via song-file:// custom protocol (no base64 encoding)
// Supports multiple stems - all audio files in the folder are loaded and mixed
export async function loadAudio(songId: string, songPath: string): Promise<boolean> {
  try {
    console.log('[Audio] loadAudio called for', songId, 'path:', songPath)
    const audioFiles = await window.api.readAudio(songPath)
    if (!audioFiles || audioFiles.length === 0) {
      console.log('[Audio] No audio files found for song:', songId)
      return false
    }

    const ctx = getContext()

    // Ensure AudioContext is running before creating audio nodes
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume()
        console.log('[Audio] Resumed AudioContext during loadAudio, state:', ctx.state)
      } catch (err) {
        console.warn('[Audio] Could not resume AudioContext during load:', err)
      }
    }

    const state = getAudioState(songId)

    // Create gain node for volume control
    if (!state.gainNode) {
      state.gainNode = ctx.createGain()
      state.gainNode.connect(ctx.destination)
    }

    console.log(`[Audio] Loading ${audioFiles.length} audio stem(s) for ${songId}:`, audioFiles.map(f => f.filename))

    // Load all stems in parallel
    const loadPromises = audioFiles.map(async (audioFile) => {
      const protocolUrl = `song-file://${encodeURIComponent(audioFile.filePath)}`
      const response = await fetch(protocolUrl)
      if (!response.ok) {
        throw new Error(`Protocol fetch failed for ${audioFile.filename}: ${response.status} ${response.statusText}`)
      }
      const arrayBuffer = await response.arrayBuffer()
      console.log(`[Audio] Fetched ${audioFile.filename}: ${arrayBuffer.byteLength} bytes`)
      const buffer = await ctx.decodeAudioData(arrayBuffer)
      console.log(`[Audio] Decoded ${audioFile.filename}: ${buffer.duration.toFixed(2)}s, ${buffer.numberOfChannels}ch, ${buffer.sampleRate}Hz`)
      return buffer
    })

    const buffers = await Promise.all(loadPromises)
    state.buffers = buffers
    state.isLoaded = true
    state.duration = Math.max(...buffers.map(b => b.duration))

    console.log(`[Audio] Loaded ${songId}: ${buffers.length} stem(s), max duration ${state.duration.toFixed(2)}s`)
    return true
  } catch (error) {
    console.error('[Audio] Error loading audio:', error)
    return false
  }
}

// Set active song
export function setActiveSong(songId: string | null): void {
  if (activeSongId && activeSongId !== songId) {
    stop(activeSongId)
  }
  activeSongId = songId
}

// Play audio
export async function play(
  songId: string,
  currentTick: number,
  tempoEvents: TempoEvent[],
  onTimeUpdate: (tick: number) => void,
  onEnded?: () => void,
  speed: number = 1.0
): Promise<boolean> {
  const state = getAudioState(songId)

  if (state.buffers.length === 0 || !state.isLoaded) {
    console.warn('[Audio] Not loaded for song:', songId)
    return false
  }

  const ctx = getContext()

  // Resume suspended context
  if (ctx.state === 'suspended') {
    console.log('[Audio] Resuming suspended AudioContext...')
    try {
      await ctx.resume()
    } catch (err) {
      console.error('[Audio] Failed to resume:', err)
      return false
    }
    console.log('[Audio] AudioContext state after resume:', ctx.state)
  }

  if (ctx.state !== 'running') {
    console.error('[Audio] AudioContext not running after resume attempt:', ctx.state)
    return false
  }

  // Stop any existing playback
  stopInternal(state)

  // Calculate start offset in seconds using tempo map
  const startOffset = Math.max(0, tickToSeconds(currentTick, tempoEvents))

  if (startOffset >= state.duration) {
    console.warn('[Audio] Start offset beyond audio duration:', startOffset, '>=', state.duration)
    return false
  }

  // Ensure gain node is connected
  if (!state.gainNode) {
    state.gainNode = ctx.createGain()
    state.gainNode.connect(ctx.destination)
  }

  // Apply current volume — use setValueAtTime for reliability on freshly-resumed context
  const now = ctx.currentTime
  state.gainNode.gain.cancelScheduledValues(now)
  state.gainNode.gain.setValueAtTime(currentVolume, now)

  // Create source nodes for all stems and start simultaneously
  const sourceNodes: AudioBufferSourceNode[] = []
  for (const buffer of state.buffers) {
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = speed
    source.connect(state.gainNode)
    try {
      source.start(0, Math.min(startOffset, buffer.duration))
    } catch (err) {
      console.error('[Audio] Failed to start source:', err)
      return false
    }
    sourceNodes.push(source)
  }

  state.sourceNodes = sourceNodes
  state.isPlaying = true
  state.startOffset = startOffset
  state.startTimestamp = ctx.currentTime
  state.speed = speed

  console.log(`[Audio] Playing ${songId} (${sourceNodes.length} stems) from ${startOffset.toFixed(2)}s (tick ${currentTick})`)

  // Handle natural end on the longest stem
  const longestIdx = state.buffers.indexOf(
    state.buffers.reduce((a, b) => (a.duration > b.duration ? a : b))
  )
  sourceNodes[longestIdx].onended = () => {
    if (state.sourceNodes.includes(sourceNodes[longestIdx])) {
      console.log('[Audio] Playback ended naturally')
      state.isPlaying = false
      if (state.rafId) {
        cancelAnimationFrame(state.rafId)
        state.rafId = null
      }
      state.sourceNodes = []
      if (onEnded) onEnded()
    }
  }

  // RAF loop using AudioContext.currentTime for precise sync (~30fps tick updates)
  let lastUpdateTime = 0
  const updateLoop = (): void => {
    if (!state.isPlaying || state.sourceNodes !== sourceNodes) {
      state.rafId = null
      return
    }
    const now = performance.now()
    // Throttle tick updates to ~30fps (every ~33ms) to reduce downstream re-renders
    if (now - lastUpdateTime >= 33) {
      lastUpdateTime = now
      const elapsed = ctx.currentTime - state.startTimestamp
      const currentAudioTime = state.startOffset + elapsed * speed
      const tick = secondsToTick(currentAudioTime, tempoEvents)
      onTimeUpdate(tick)
    }
    state.rafId = requestAnimationFrame(updateLoop)
  }

  state.rafId = requestAnimationFrame(updateLoop)
  return true
}

// Check if audio is actively playing (internal state)
export function isCurrentlyPlaying(songId: string): boolean {
  return audioRegistry.get(songId)?.isPlaying ?? false
}

function stopInternal(state: AudioState): void {
  for (const source of state.sourceNodes) {
    try {
      source.onended = null
      source.stop()
      source.disconnect()
    } catch {
      // Already stopped
    }
  }
  state.sourceNodes = []
  state.isPlaying = false
  if (state.rafId) {
    cancelAnimationFrame(state.rafId)
    state.rafId = null
  }
}

// Stop audio playback
export function stop(songId: string): void {
  const state = audioRegistry.get(songId)
  if (state) {
    stopInternal(state)
  }
}

// Stop all audio playback across all songs
export function stopAll(): void {
  for (const [, state] of audioRegistry) {
    stopInternal(state)
  }
}

// Pause audio playback
export function pause(songId: string): void {
  stop(songId)
}

// Seek to a position
export function seek(songId: string, tick: number, tempoEvents: TempoEvent[]): void {
  const state = audioRegistry.get(songId)
  if (!state || !state.isLoaded || state.buffers.length === 0) return

  const ctx = getContext()
  const seekTime = tickToSeconds(tick, tempoEvents)

  if (state.isPlaying) {
    // Stop all current sources
    for (const source of state.sourceNodes) {
      try {
        source.stop()
        source.disconnect()
      } catch { /* already stopped */ }
    }

    // Create new sources for all stems
    const newSources: AudioBufferSourceNode[] = []
    for (const buffer of state.buffers) {
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.playbackRate.value = state.speed
      source.connect(state.gainNode || ctx.destination)
      source.start(0, Math.min(seekTime, buffer.duration))
      newSources.push(source)
    }

    state.sourceNodes = newSources
    state.startOffset = seekTime
    state.startTimestamp = ctx.currentTime
  }
}

// Set volume (0-1 linear)
export function setVolume(volume: number): void {
  const clampedVol = Math.max(0, Math.min(1, volume))
  currentVolume = clampedVol
  const ctx = sharedContext
  const now = ctx?.currentTime ?? 0
  for (const state of audioRegistry.values()) {
    if (state.gainNode) {
      state.gainNode.gain.cancelScheduledValues(now)
      state.gainNode.gain.setValueAtTime(clampedVol, now)
    }
  }
}

// Check if audio is loaded
export function isAudioLoaded(songId: string): boolean {
  return audioRegistry.get(songId)?.isLoaded ?? false
}

// Get audio duration
export function getAudioDuration(songId: string): number {
  return audioRegistry.get(songId)?.duration ?? 0
}

// Get decoded audio buffers for waveform rendering
export function getAudioBuffers(songId: string): AudioBuffer[] {
  return audioRegistry.get(songId)?.buffers ?? []
}

// Cleanup audio for a song
export function unloadAudio(songId: string): void {
  const state = audioRegistry.get(songId)
  if (state) {
    stopInternal(state)
    audioRegistry.delete(songId)
  }
}

// Cleanup all audio
export function cleanup(): void {
  for (const songId of audioRegistry.keys()) {
    unloadAudio(songId)
  }
  stopPitchPreview()
  if (sharedContext) {
    sharedContext.close()
    sharedContext = null
  }
}

// ── Pitch preview synthesizer ────────────────────────────────────────
// Plays a short sine-wave tone at a given MIDI pitch so charters can
// hear what note they're placing / dragging to.

let previewOsc: OscillatorNode | null = null
let previewGain: GainNode | null = null
let previewPitch = -1

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

/**
 * Start or update the pitch preview tone.
 * If already playing at a different pitch, smoothly glide to the new one.
 * If already at this pitch, do nothing.
 */
export function playPitchPreview(midiNote: number): void {
  if (midiNote === previewPitch && previewOsc) return

  const ctx = getContext()
  if (ctx.state === 'suspended') ctx.resume()

  const now = ctx.currentTime

  if (previewOsc) {
    // Glide to new pitch
    previewOsc.frequency.setTargetAtTime(midiToHz(midiNote), now, 0.03)
    previewPitch = midiNote
    return
  }

  // Create new oscillator + gain envelope
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = midiToHz(midiNote)
  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(0.18, now + 0.02) // quick attack

  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(now)

  previewOsc = osc
  previewGain = gain
  previewPitch = midiNote
}

/** Stop the pitch preview tone with a short fade-out. */
export function stopPitchPreview(): void {
  if (!previewOsc || !previewGain) {
    previewOsc = null
    previewGain = null
    previewPitch = -1
    return
  }

  try {
    const ctx = getContext()
    const now = ctx.currentTime
    previewGain.gain.cancelScheduledValues(now)
    previewGain.gain.setValueAtTime(previewGain.gain.value, now)
    previewGain.gain.linearRampToValueAtTime(0, now + 0.06) // quick release
    const osc = previewOsc
    const gain = previewGain
    setTimeout(() => {
      try { osc.stop(); osc.disconnect(); gain.disconnect() } catch { /* already stopped */ }
    }, 100)
  } catch { /* context closed */ }

  previewOsc = null
  previewGain = null
  previewPitch = -1
}
