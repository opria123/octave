// Beat Grid - YARG TrackPlayer.cs beat line rendering
import { useMemo } from 'react'
import { TRACK_WIDTH, STRIKE_LINE_POS, HIGHWAY_LENGTH, COLORS } from './constants'

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
        const alpha = line.type === 'measure' ? 0.6 : line.type === 'strong' ? 0.4 : 0.3
        const color = line.type === 'measure' ? COLORS.beatlineMeasure
          : line.type === 'strong' ? COLORS.beatlineStrong : COLORS.beatlineWeak
        return (
          <mesh key={i} position={[0, 0.001, line.z]}>
            <boxGeometry args={[TRACK_WIDTH, 0.003, thickness]} />
            <meshBasicMaterial color={color} transparent opacity={alpha} />
          </mesh>
        )
      })}
      {tempoMarkers.map((marker, i) => (
        <group key={`tempo-${i}`}>
          {/* Orange line across the highway */}
          <mesh position={[0, 0.002, marker.z]}>
            <boxGeometry args={[TRACK_WIDTH, 0.004, 0.06]} />
            <meshBasicMaterial color="#FF8C00" transparent opacity={0.8} />
          </mesh>
          {/* Small BPM label tab on the left edge */}
          <mesh position={[-TRACK_WIDTH / 2 - 0.25, 0.01, marker.z]}>
            <boxGeometry args={[0.5, 0.01, 0.2]} />
            <meshBasicMaterial color="#FF8C00" transparent opacity={0.7} />
          </mesh>
        </group>
      ))}
    </group>
  )
}
