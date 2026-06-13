// Highway Waveform overlay (issue #7) — renders the song's audio waveform
// down the 3D note highway so charters can see where notes land against the
// actual audio. The whole song is pre-rendered once into a texture whose rows
// are linear in *ticks* (matching the highway's tick→Z mapping, including
// tempo changes), then scrolled per frame via texture offset — no per-frame
// geometry or canvas work.
import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import { TRACK_WIDTH, STRIKE_LINE_POS, HIGHWAY_LENGTH } from './constants'
import { getAudioBuffers, onAudioLoaded } from '../../services/audioService'
import type { TempoEvent } from '../../types'

const TICKS_PER_BEAT = 480
// Texture resolution: rows along the song (time axis), columns across the track.
const WAVEFORM_ROWS = 4096
const WAVEFORM_TEX_WIDTH = 64
// Cap per-row sample scans so texture build stays fast on long songs.
const MAX_SAMPLES_PER_ROW = 256

function tickToSeconds(tick: number, tempoEvents: TempoEvent[]): number {
  let seconds = 0
  let prevTick = 0
  let bpm = tempoEvents[0]?.bpm ?? 120
  for (const event of tempoEvents) {
    if (event.tick >= tick) break
    seconds += (event.tick - prevTick) / ((TICKS_PER_BEAT * bpm) / 60)
    prevTick = event.tick
    bpm = event.bpm
  }
  return seconds + (tick - prevTick) / ((TICKS_PER_BEAT * bpm) / 60)
}

function secondsToTick(seconds: number, tempoEvents: TempoEvent[]): number {
  let accSeconds = 0
  let prevTick = 0
  let bpm = tempoEvents[0]?.bpm ?? 120
  for (const event of tempoEvents) {
    const segmentSeconds = (event.tick - prevTick) / ((TICKS_PER_BEAT * bpm) / 60)
    if (accSeconds + segmentSeconds >= seconds) break
    accSeconds += segmentSeconds
    prevTick = event.tick
    bpm = event.bpm
  }
  return Math.round(prevTick + (seconds - accSeconds) * ((TICKS_PER_BEAT * bpm) / 60))
}

export interface HighwayWaveformData {
  texture: THREE.CanvasTexture
  totalTicks: number
}

/**
 * Builds (and rebuilds on audio load) the waveform texture for a song.
 * Returns null when disabled or no audio is loaded.
 */
export function useHighwayWaveform(
  songId: string,
  tempoEvents: TempoEvent[],
  enabled: boolean
): HighwayWaveformData | null {
  const [audioVersion, setAudioVersion] = useState(0)
  useEffect(() => onAudioLoaded(songId, () => setAudioVersion((v) => v + 1)), [songId])

  const data = useMemo<HighwayWaveformData | null>(() => {
    void audioVersion
    if (!enabled) return null
    const buffers = getAudioBuffers(songId)
    if (buffers.length === 0) return null
    const duration = Math.max(...buffers.map((b) => b.duration))
    if (!(duration > 0)) return null
    const totalTicks = Math.max(1, secondsToTick(duration, tempoEvents))

    // Peak amplitude per row. Rows are linear in ticks: each row covers the
    // audio between its row-start and row-end ticks (tempo-map aware).
    const channels = buffers.map((b) => ({
      data: b.getChannelData(0),
      rate: b.sampleRate
    }))
    const peaks = new Float32Array(WAVEFORM_ROWS)
    let globalPeak = 0
    let tPrev = 0
    for (let row = 0; row < WAVEFORM_ROWS; row++) {
      const tNext = tickToSeconds(((row + 1) / WAVEFORM_ROWS) * totalTicks, tempoEvents)
      let peak = 0
      for (const chan of channels) {
        const s0 = Math.floor(tPrev * chan.rate)
        const s1 = Math.min(chan.data.length, Math.ceil(tNext * chan.rate))
        if (s1 <= s0) continue
        const step = Math.max(1, Math.floor((s1 - s0) / MAX_SAMPLES_PER_ROW))
        for (let s = s0; s < s1; s += step) {
          const v = Math.abs(chan.data[s])
          if (v > peak) peak = v
        }
      }
      peaks[row] = peak
      if (peak > globalPeak) globalPeak = peak
      tPrev = tNext
    }
    if (globalPeak <= 0) return null

    const canvas = document.createElement('canvas')
    canvas.width = WAVEFORM_TEX_WIDTH
    canvas.height = WAVEFORM_ROWS
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.clearRect(0, 0, WAVEFORM_TEX_WIDTH, WAVEFORM_ROWS)
    ctx.fillStyle = '#FFFFFF'
    for (let row = 0; row < WAVEFORM_ROWS; row++) {
      // Mild power curve lifts quiet passages so they stay visible.
      const norm = Math.pow(peaks[row] / globalPeak, 0.7)
      const w = Math.max(norm > 0 ? 1 : 0, Math.round(norm * WAVEFORM_TEX_WIDTH))
      if (w === 0) continue
      // Tick 0 at the canvas bottom (v=0 with default flipY).
      ctx.fillRect((WAVEFORM_TEX_WIDTH - w) / 2, WAVEFORM_ROWS - 1 - row, w, 1)
    }

    const texture = new THREE.CanvasTexture(canvas)
    texture.wrapS = THREE.ClampToEdgeWrapping
    texture.wrapT = THREE.ClampToEdgeWrapping
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    return { texture, totalTicks }
  }, [songId, tempoEvents, enabled, audioVersion])

  // Free GPU memory when the texture is replaced or unmounted.
  useEffect(() => {
    return () => {
      data?.texture.dispose()
    }
  }, [data])

  return data
}

/** Translucent waveform strip lying on a single highway. */
export function HighwayWaveform({
  waveform,
  currentTick,
  pixelsPerTick,
  offsetX = 0
}: {
  waveform: HighwayWaveformData
  currentTick: number
  pixelsPerTick: number
  offsetX?: number
}): React.JSX.Element {
  const { texture, totalTicks } = waveform
  // Scroll by mapping the visible tick window onto the song-long texture.
  const visibleTicks = HIGHWAY_LENGTH / pixelsPerTick
  texture.repeat.set(1, visibleTicks / totalTicks)
  texture.offset.set(0, currentTick / totalTicks)
  return (
    <mesh
      position={[offsetX, 0.0005, STRIKE_LINE_POS - HIGHWAY_LENGTH / 2]}
      rotation={[-Math.PI / 2, 0, 0]}
    >
      <planeGeometry args={[TRACK_WIDTH, HIGHWAY_LENGTH]} />
      <meshBasicMaterial map={texture} transparent opacity={0.4} color="#4DD0E1" depthWrite={false} />
    </mesh>
  )
}
