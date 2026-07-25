// Beat Grid - YARG TrackPlayer.cs beat line rendering
import { useMemo } from 'react'
import * as THREE from 'three'
import { TRACK_WIDTH, STRIKE_LINE_POS, HIGHWAY_LENGTH, COLORS } from './constants'

// Reusable static geometries at module level to prevent dynamic allocations
const beatLineUnitGeo = new THREE.BoxGeometry(TRACK_WIDTH, 0.003, 1) // Depth (Z) is 1, scale dynamically
const tempoLineGeo = new THREE.BoxGeometry(TRACK_WIDTH, 0.004, 0.06)
const tempoTabGeo = new THREE.BoxGeometry(0.5, 0.01, 0.2)

// Reusable static basic materials at module level
const measureMaterial = new THREE.MeshBasicMaterial({
  color: COLORS.beatlineMeasure,
  transparent: true,
  opacity: 0.6
})
const strongMaterial = new THREE.MeshBasicMaterial({
  color: COLORS.beatlineStrong,
  transparent: true,
  opacity: 0.4
})
const weakMaterial = new THREE.MeshBasicMaterial({
  color: COLORS.beatlineWeak,
  transparent: true,
  opacity: 0.3
})
const tempoLineMaterial = new THREE.MeshBasicMaterial({
  color: '#FF8C00',
  transparent: true,
  opacity: 0.8
})
const tempoTabMaterial = new THREE.MeshBasicMaterial({
  color: '#FF8C00',
  transparent: true,
  opacity: 0.7
})

export function BeatGrid({
  currentTick,
  ticksPerBeat,
  pixelsPerTick,
  offsetX = 0,
  tempoEvents
}: {
  currentTick: number
  ticksPerBeat: number
  pixelsPerTick: number
  offsetX?: number
  tempoEvents?: { tick: number; bpm: number }[]
}): React.JSX.Element {
  const beatLines = useMemo(() => {
    const lines: { z: number; type: 'measure' | 'strong' | 'weak' }[] = []
    const visibleTicks = HIGHWAY_LENGTH / pixelsPerTick
    const firstBeat = Math.floor(currentTick / ticksPerBeat)
    const lastBeat = Math.ceil((currentTick + visibleTicks) / ticksPerBeat)
    for (let beat = firstBeat; beat <= lastBeat; beat++) {
      const tick = beat * ticksPerBeat
      const z = STRIKE_LINE_POS - (tick - currentTick) * pixelsPerTick
      if (z >= -HIGHWAY_LENGTH && z <= STRIKE_LINE_POS + 0.5) {
        const type = beat % 4 === 0 ? 'measure' : beat % 2 === 0 ? 'strong' : 'weak'
        lines.push({ z, type })
      }
    }
    return lines
  }, [currentTick, ticksPerBeat, pixelsPerTick])

  // Tempo change markers (skip the first since it's just the default tempo)
  const tempoMarkers = useMemo(() => {
    if (!tempoEvents || tempoEvents.length <= 1) return []
    const visibleTicks = HIGHWAY_LENGTH / pixelsPerTick
    const markers: { z: number; bpm: number }[] = []
    for (let i = 1; i < tempoEvents.length; i++) {
      const te = tempoEvents[i]
      if (te.tick < currentTick - ticksPerBeat || te.tick > currentTick + visibleTicks) continue
      const z = STRIKE_LINE_POS - (te.tick - currentTick) * pixelsPerTick
      if (z >= -HIGHWAY_LENGTH && z <= STRIKE_LINE_POS + 0.5) {
        markers.push({ z, bpm: te.bpm })
      }
    }
    return markers
  }, [currentTick, tempoEvents, pixelsPerTick, ticksPerBeat])

  return (
    <group position={[offsetX, 0, 0]}>
      {beatLines.map((line, i) => {
        const thickness = line.type === 'measure' ? 0.07 : line.type === 'strong' ? 0.05 : 0.03
        const material = line.type === 'measure' ? measureMaterial
          : line.type === 'strong' ? strongMaterial : weakMaterial
        return (
          <mesh
            key={i}
            geometry={beatLineUnitGeo}
            position={[0, 0.001, line.z]}
            scale={[1, 1, thickness]}
            material={material}
          />
        )
      })}
      {tempoMarkers.map((marker, i) => (
        <group key={`tempo-${i}`}>
          {/* Orange line across the highway */}
          <mesh
            geometry={tempoLineGeo}
            position={[0, 0.002, marker.z]}
            material={tempoLineMaterial}
          />
          {/* Small BPM label tab on the left edge */}
          <mesh
            geometry={tempoTabGeo}
            position={[-TRACK_WIDTH / 2 - 0.25, 0.01, marker.z]}
            material={tempoTabMaterial}
          />
        </group>
      ))}
    </group>
  )
}
