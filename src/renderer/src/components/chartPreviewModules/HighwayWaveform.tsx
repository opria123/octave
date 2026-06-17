// Highway Waveform overlay (issue #7) — renders the song's audio waveform
// down the 3D note highway so charters can see where notes land against the
// actual audio. The whole song is pre-rendered once into a texture whose rows
// are linear in *ticks* (matching the highway's tick→Z mapping, including
// tempo changes), then scrolled per frame via texture offset — no per-frame
// geometry or canvas work.
import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import { TRACK_WIDTH, STRIKE_LINE_POS, HIGHWAY_LENGTH } from './constants'
import { onAudioLoaded } from '../../services/audioService'
import { buildTickAlignedWaveformPeaks } from '../../services/waveformService'
import type { TempoEvent } from '../../types'

// Texture resolution: rows along the song (time axis), columns across the track.
const WAVEFORM_ROWS = 4096
const WAVEFORM_TEX_WIDTH = 64
// Cap per-row sample scans so texture build stays fast on long songs.
const MAX_SAMPLES_PER_ROW = 256

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
  enabled: boolean,
  sourcePath?: string
): HighwayWaveformData | null {
  const [audioVersion, setAudioVersion] = useState(0)
  useEffect(() => onAudioLoaded(songId, () => setAudioVersion((v) => v + 1)), [songId])

  const data = useMemo<HighwayWaveformData | null>(() => {
    void audioVersion
    if (!enabled) return null
    const waveform = buildTickAlignedWaveformPeaks({
      songId,
      tempoEvents,
      rows: WAVEFORM_ROWS,
      sourcePath,
      maxSamplesPerRow: MAX_SAMPLES_PER_ROW
    })
    if (!waveform) return null
    const { peaks, totalTicks } = waveform

    const canvas = document.createElement('canvas')
    canvas.width = WAVEFORM_TEX_WIDTH
    canvas.height = WAVEFORM_ROWS
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.clearRect(0, 0, WAVEFORM_TEX_WIDTH, WAVEFORM_ROWS)
    ctx.fillStyle = '#FFFFFF'
    for (let row = 0; row < WAVEFORM_ROWS; row++) {
      // Mild power curve lifts quiet passages so they stay visible.
      const norm = Math.pow(peaks[row], 0.7)
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
  }, [songId, tempoEvents, enabled, audioVersion, sourcePath])

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
