// Audio service using Web Audio API directly (replaces Tone.js for reliability in Electron)
// Audio files are streamed via song-file:// custom protocol instead of base64 IPC

import type { TempoEvent, AudioSync, AudioClip } from '../types'

interface DecodedAudioSource {
  filePath: string
  filename: string
  buffer: AudioBuffer
}

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
  sources: DecodedAudioSource[]
  buffers: AudioBuffer[]
  sourceNodes: AudioBufferSourceNode[]
  gainNode: GainNode | null
  // Per-stem gain nodes keyed by filePath. Each stem source routes through
  // its own GainNode → master gainNode → destination so we can mute/solo
  // individual stems without recreating audio sources.
  stemGains: Map<string, GainNode>
  stemVolumes: Map<string, number>
  mutedStems: Set<string>
  soloedStems: Set<string>
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
      sources: [],
      buffers: [],
      sourceNodes: [],
      gainNode: null,
      stemGains: new Map(),
      stemVolumes: new Map(),
      mutedStems: new Set(),
      soloedStems: new Set(),
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

// Audio load listeners
const audioLoadListeners: Map<string, Set<(duration: number) => void>> = new Map()

export function onAudioLoaded(songId: string, cb: (duration: number) => void): () => void {
  if (!audioLoadListeners.has(songId)) audioLoadListeners.set(songId, new Set())
  audioLoadListeners.get(songId)!.add(cb)
  return () => audioLoadListeners.get(songId)?.delete(cb)
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
      return {
        filePath: audioFile.filePath,
        filename: audioFile.filename,
        buffer
      }
    })

    const sources = await Promise.all(loadPromises)
    state.sources = sources
    state.buffers = sources.map((source) => source.buffer)
    // Allocate one gain node per loaded stem and wire it to the master gain.
    for (const source of sources) {
      if (!state.stemGains.has(source.filePath)) {
        const stemGain = ctx.createGain()
        stemGain.connect(state.gainNode!)
        state.stemGains.set(source.filePath, stemGain)
      }
    }
    applyStemGains(state)
    state.isLoaded = true
    state.duration = Math.max(...sources.map((source) => source.buffer.duration))

    console.log(`[Audio] Loaded ${songId}: ${sources.length} source(s), max duration ${state.duration.toFixed(2)}s`)
    audioLoadListeners.get(songId)?.forEach(cb => cb(state.duration))
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

function getDefaultAudioClips(state: AudioState): AudioClip[] {
  return state.sources.map((source, index) => ({
    id: `default-audio-${index}`,
    filePath: source.filePath,
    filename: source.filename,
    startMs: 0,
    sourceStartMs: 0,
    durationMs: Math.round(source.buffer.duration * 1000)
  }))
}

function getEffectiveAudioClips(state: AudioState, audioSync?: AudioSync): AudioClip[] {
  if (audioSync && audioSync.clips.length > 0) {
    return audioSync.clips
      .map((clip) => {
        if (clip.durationMs > 0) return clip
        const source = findSourceForClip(state, clip)
        if (!source) return clip
        return {
          ...clip,
          durationMs: Math.max(0, Math.round(source.buffer.duration * 1000) - clip.sourceStartMs)
        }
      })
      .filter((clip) => clip.durationMs > 0)
  }
  return getDefaultAudioClips(state)
}

function findSourceForClip(state: AudioState, clip: AudioClip): DecodedAudioSource | undefined {
  return state.sources.find((source) => source.filePath === clip.filePath)
    ?? state.sources.find((source) => source.filename === clip.filename)
}

function scheduleClipSources(
  ctx: AudioContext,
  state: AudioState,
  clips: AudioClip[],
  timelineStartSec: number,
  speed: number
): AudioBufferSourceNode[] {
  const sourceNodes: AudioBufferSourceNode[] = []

  for (const clip of clips) {
    const sourceData = findSourceForClip(state, clip)
    if (!sourceData) continue

    const clipStartSec = clip.startMs / 1000
    const clipSourceStartSec = clip.sourceStartMs / 1000
    const clipDurationSec = clip.durationMs / 1000
    const clipEndSec = clipStartSec + clipDurationSec

    if (timelineStartSec >= clipEndSec) continue

    const playbackStartInClipSec = Math.max(0, timelineStartSec - clipStartSec)
    const bufferOffsetSec = clipSourceStartSec + playbackStartInClipSec
    const remainingClipSec = clipDurationSec - playbackStartInClipSec
    const remainingBufferSec = sourceData.buffer.duration - bufferOffsetSec
    const playbackDurationSec = Math.min(remainingClipSec, remainingBufferSec)

    if (playbackDurationSec <= 0) continue

    const delaySec = Math.max(0, clipStartSec - timelineStartSec) / speed
    const source = ctx.createBufferSource()
    source.buffer = sourceData.buffer
    source.playbackRate.value = speed
    const stemGain = state.stemGains.get(sourceData.filePath)
    source.connect(stemGain ?? state.gainNode ?? ctx.destination)
    source.start(ctx.currentTime + delaySec, bufferOffsetSec, playbackDurationSec)
    sourceNodes.push(source)
  }

  return sourceNodes
}

// Play audio
export async function play(
  songId: string,
  currentTick: number,
  tempoEvents: TempoEvent[],
  onTimeUpdate: (tick: number) => void,
  onEnded?: () => void,
  speed: number = 1.0,
  audioSync?: AudioSync
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

  // Timeline time at which playback starts (chart time)
  const timelineStartSec = Math.max(0, tickToSeconds(currentTick, tempoEvents))
  const clips = getEffectiveAudioClips(state, audioSync)
  const sourceNodes = scheduleClipSources(ctx, state, clips, timelineStartSec, speed)

  if (sourceNodes.length === 0) {
    console.warn('[Audio] No audio clips scheduled at timeline', timelineStartSec)
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

  state.sourceNodes = sourceNodes
  state.isPlaying = true
  state.startOffset = timelineStartSec
  state.startTimestamp = ctx.currentTime
  state.speed = speed

  console.log(`[Audio] Playing ${songId} (${sourceNodes.length} scheduled clip(s)) at timeline ${timelineStartSec.toFixed(2)}s (tick ${currentTick})`)

  let pendingNodes = sourceNodes.length
  for (const source of sourceNodes) {
    source.onended = () => {
      pendingNodes -= 1
      if (pendingNodes === 0 && state.sourceNodes === sourceNodes) {
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
  }

  // RAF loop using AudioContext.currentTime for precise sync (~30fps tick updates)
  let lastUpdateTime = 0
  const updateLoop = (): void => {
    // Bail when playback stops. We deliberately do NOT compare against the
    // closure-captured `sourceNodes` here — `seek()` swaps `state.sourceNodes`
    // mid-flight to retarget audio, and an identity check would freeze the
    // RAF (and the highway scroll along with it) on every scrub.
    if (!state.isPlaying) {
      state.rafId = null
      return
    }
    const now = performance.now()
    // Throttle tick updates to ~30fps (every ~33ms) to reduce downstream re-renders
    if (now - lastUpdateTime >= 33) {
      lastUpdateTime = now
      const elapsed = ctx.currentTime - state.startTimestamp
      const currentTimelineTime = state.startOffset + elapsed * speed
      const tick = secondsToTick(currentTimelineTime, tempoEvents)
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
export function seek(songId: string, tick: number, tempoEvents: TempoEvent[], audioSync?: AudioSync): void {
  const state = audioRegistry.get(songId)
  if (!state || !state.isLoaded || state.buffers.length === 0) return

  const ctx = getContext()
  const timelineSeekSec = tickToSeconds(tick, tempoEvents)

  if (!state.isPlaying) return

  for (const source of state.sourceNodes) {
    try {
      source.stop()
      source.disconnect()
    } catch { /* already stopped */ }
  }

  const newSources = scheduleClipSources(ctx, state, getEffectiveAudioClips(state, audioSync), timelineSeekSec, state.speed)
  state.sourceNodes = newSources
  state.startOffset = timelineSeekSec
  state.startTimestamp = ctx.currentTime
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

// ── Per-stem mute / solo ─────────────────────────────────────────────
// If any stems are soloed, only those play; otherwise all play except muted.

const stemControlListeners = new Map<string, Set<() => void>>()

function notifyStemControlsChanged(songId: string): void {
  stemControlListeners.get(songId)?.forEach((cb) => cb())
}

function applyStemGains(state: AudioState): void {
  const hasSolo = state.soloedStems.size > 0
  for (const [filePath, gain] of state.stemGains) {
    const muted = state.mutedStems.has(filePath)
    const audible = hasSolo ? state.soloedStems.has(filePath) : !muted
    const volume = state.stemVolumes.get(filePath) ?? 1
    // Set value directly so the change applies immediately even if the
    // AudioContext clock is paused or the node was just created.
    gain.gain.value = audible ? volume : 0
  }
}

export function setStemVolume(songId: string, filePath: string, volume: number): void {
  const state = audioRegistry.get(songId)
  if (!state) return
  const clamped = Math.max(0, Math.min(1, volume))
  state.stemVolumes.set(filePath, clamped)
  applyStemGains(state)
  notifyStemControlsChanged(songId)
}

export function setStemMute(songId: string, filePath: string, muted: boolean): void {
  const state = audioRegistry.get(songId)
  if (!state) return
  if (muted) {
    state.mutedStems.add(filePath)
    // DAW convention: muting a track clears its solo state.
    state.soloedStems.delete(filePath)
  } else {
    state.mutedStems.delete(filePath)
  }
  applyStemGains(state)
  notifyStemControlsChanged(songId)
}

export function setStemSolo(songId: string, filePath: string, soloed: boolean): void {
  const state = audioRegistry.get(songId)
  if (!state) return
  if (soloed) {
    state.soloedStems.add(filePath)
    // DAW convention: soloing a track clears its mute state so it is audible.
    state.mutedStems.delete(filePath)
  } else {
    state.soloedStems.delete(filePath)
  }
  applyStemGains(state)
  notifyStemControlsChanged(songId)
}

export interface StemControl {
  filePath: string
  filename: string
  muted: boolean
  soloed: boolean
  volume: number
}

export function getStemControls(songId: string): StemControl[] {
  const state = audioRegistry.get(songId)
  if (!state) return []
  return state.sources.map((s) => ({
    filePath: s.filePath,
    filename: s.filename,
    muted: state.mutedStems.has(s.filePath),
    soloed: state.soloedStems.has(s.filePath),
    volume: state.stemVolumes.get(s.filePath) ?? 1
  }))
}

export function onStemControlsChange(songId: string, cb: () => void): () => void {
  if (!stemControlListeners.has(songId)) stemControlListeners.set(songId, new Set())
  stemControlListeners.get(songId)!.add(cb)
  return () => stemControlListeners.get(songId)?.delete(cb)
}

// Check if audio is loaded
export function isAudioLoaded(songId: string): boolean {
  return audioRegistry.get(songId)?.isLoaded ?? false
}

// Get audio duration
export function getAudioDuration(songId: string, audioSync?: AudioSync): number {
  const state = audioRegistry.get(songId)
  if (!state) return 0
  const clips = getEffectiveAudioClips(state, audioSync)
  if (clips.length === 0) return state.duration ?? 0
  return Math.max(...clips.map((clip) => (clip.startMs + clip.durationMs) / 1000), state.duration ?? 0)
}

// Get decoded audio buffers for waveform rendering
export function getAudioBuffers(songId: string): AudioBuffer[] {
  return audioRegistry.get(songId)?.buffers ?? []
}

export function getAudioSources(songId: string): Array<{ filePath: string; filename: string; duration: number }> {
  const state = audioRegistry.get(songId)
  if (!state) return []
  return state.sources.map((source) => ({
    filePath: source.filePath,
    filename: source.filename,
    duration: source.buffer.duration
  }))
}

// Cleanup audio for a song
export function unloadAudio(songId: string): void {
  const state = audioRegistry.get(songId)
  if (state) {
    stopInternal(state)
    for (const gain of state.stemGains.values()) {
      try { gain.disconnect() } catch { /* noop */ }
    }
    state.stemGains.clear()
    audioRegistry.delete(songId)
    stemControlListeners.delete(songId)
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
