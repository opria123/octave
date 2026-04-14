// Highway Edit Layer - Click-to-place/erase editing via raycasting
import { useMemo, useState, useCallback, useRef } from 'react'
import * as THREE from 'three'
import {
  TRACK_WIDTH, STRIKE_LINE_POS, HIGHWAY_LENGTH, COLORS, DRUM_KICK_COLOR,
  PRO_GUITAR_COLORS, PRO_KEYS_COLOR, VOCAL_COLOR, getLaneConfig, getFretX,
  PRO_KEYS_MIN
} from './constants'
import type { InstrumentRenderType } from './constants'
import { getSongStore, useUIStore } from '../../stores'
import type { Note, NoteFlags, NoteModifiers, Instrument, Difficulty, ProGuitarString } from '../../types'
import type { HighwayAssets, EditingTool } from './types'

// Build note flags from UI toggle modifiers
function buildNoteFlags(instrument: Instrument, mods: NoteModifiers): NoteFlags | undefined {
  const flags: NoteFlags = {}
  const isDrum = instrument === 'drums'

  if (mods.cymbalOrTap) {
    if (isDrum) flags.isCymbal = true
    else flags.isTap = true
  }
  if (mods.ghostOrHopo) {
    if (isDrum) flags.isGhost = true
    else flags.isHOPO = true
  }
  if (mods.accent) {
    flags.isAccent = true
  }

  return Object.keys(flags).length > 0 ? flags : undefined
}

function GhostNote({
  position,
  color,
  assets,
  isDrum,
  isKick,
  noteModifiers
}: {
  position: [number, number, number]
  color: string
  assets: HighwayAssets | null
  isDrum: boolean
  isKick: boolean
  noteModifiers: NoteModifiers
}): React.JSX.Element {
  // Open/kick override
  const showKick = isKick || noteModifiers.openOrKick

  if (isDrum && showKick) {
    return (
      <group position={position} scale={[TRACK_WIDTH / 3.27, 1, 1]}>
        <mesh geometry={assets?.kickGeo ?? undefined}>
          {!assets?.kickGeo && <boxGeometry args={[3.27, 0.06, 0.15]} />}
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.5}
            transparent
            opacity={0.4}
            toneMapped={false}
          />
        </mesh>
      </group>
    )
  }

  // Pick geometry based on active modifiers
  let geometry: THREE.BufferGeometry | undefined
  if (assets) {
    if (isDrum && noteModifiers.cymbalOrTap) geometry = assets.cymbalGeo
    else if (!isDrum && noteModifiers.cymbalOrTap) geometry = assets.tapGeo
    else if (!isDrum && noteModifiers.ghostOrHopo) geometry = assets.hopoGeo
    else if (isDrum && noteModifiers.ghostOrHopo) geometry = assets.ghostGeo
    else if (noteModifiers.accent) geometry = assets.accentGeo
    else geometry = assets.noteGeo
  }

  const scale = noteModifiers.ghostOrHopo && isDrum ? 0.8 : noteModifiers.accent ? 1.2 : 1.0

  return (
    <group position={position} scale={[1, scale, 1]}>
      <mesh geometry={geometry ?? undefined}>
        {!geometry && <boxGeometry args={[0.34, 0.06, 0.2]} />}
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.5}
          transparent
          opacity={0.4}
          toneMapped={false}
        />
      </mesh>
    </group>
  )
}

export function HighwayEditLayer({
  offsetX,
  instrument,
  difficulty,
  currentTick,
  pixelsPerTick,
  songId,
  editTool,
  snapDivision,
  assets,
  proKeysViewStart
}: {
  offsetX: number
  instrument: Instrument
  difficulty: Difficulty
  currentTick: number
  pixelsPerTick: number
  songId: string
  editTool: EditingTool
  snapDivision: number
  assets: HighwayAssets | null
  proKeysViewStart?: number
}): React.JSX.Element {
  const instrumentType: InstrumentRenderType = instrument === 'drums' ? 'drums'
    : instrument === 'proKeys' ? 'proKeys'
    : instrument === 'vocals' ? 'vocals'
    : (instrument === 'proGuitar' || instrument === 'proBass') ? 'proGuitar'
    : 'guitar'
  const { laneCount } = getLaneConfig(instrumentType)
  const colors = instrumentType === 'proGuitar' ? PRO_GUITAR_COLORS
    : instrumentType === 'proKeys' ? [PRO_KEYS_COLOR]
    : instrumentType === 'vocals' ? [VOCAL_COLOR]
    : COLORS[instrumentType === 'drums' ? 'drums' : 'guitar'].notes
  const noteModifiers = useUIStore((s) => s.noteModifiers)
  const planeRef = useRef<THREE.Mesh>(null)
  const [ghost, setGhost] = useState<{
    position: [number, number, number]
    lane: number
    tick: number
    visible: boolean
    color: string
    isKick: boolean
  }>({ position: [0, 0, 0], lane: 0, tick: 0, visible: false, color: '#FFFFFF', isKick: false })

  const ticksPerSnap = useMemo(() => {
    return Math.round(1920 / snapDivision)
  }, [snapDivision])

  const snapTick = useCallback(
    (rawTick: number): number => {
      return Math.round(rawTick / ticksPerSnap) * ticksPerSnap
    },
    [ticksPerSnap]
  )

  const worldToTickAndLane = useCallback(
    (worldPoint: THREE.Vector3): { tick: number; lane: number; isKick: boolean } => {
      // Z axis is unaffected by parent group X-scale, use world Z directly
      const rawTick = currentTick + (STRIKE_LINE_POS - worldPoint.z) / pixelsPerTick
      const tick = snapTick(Math.max(0, rawTick))

      // Use mesh worldToLocal to correctly handle parent group X-scale
      let localX: number
      if (planeRef.current) {
        const localPt = planeRef.current.worldToLocal(worldPoint.clone())
        localX = localPt.x
      } else {
        localX = worldPoint.x - offsetX
      }

      let bestLane = 0
      let bestDist = Infinity
      for (let i = 0; i < laneCount; i++) {
        const laneX = getFretX(i, laneCount)
        const dist = Math.abs(localX - laneX)
        if (dist < bestDist) {
          bestDist = dist
          bestLane = i
        }
      }

      const isKick = instrumentType === 'drums' && bestDist > TRACK_WIDTH / (laneCount * 1.5)

      return { tick, lane: bestLane, isKick }
    },
    [currentTick, pixelsPerTick, offsetX, laneCount, instrumentType, snapTick]
  )

  const getLaneString = useCallback(
    (laneIndex: number, isKick: boolean): string | number => {
      if (isKick) return 'kick'
      if (instrument === 'drums') {
        const drumLanes = ['snare', 'yellowTom', 'blueTom', 'greenTom']
        return drumLanes[laneIndex] || 'snare'
      }
      // Pro Guitar/Bass: lane is string number 1-6
      if (instrument === 'proGuitar' || instrument === 'proBass') {
        return laneIndex + 1 // 0→1, 1→2, ..., 5→6
      }
      // Pro Keys: lane index maps to MIDI pitch relative to viewport
      if (instrument === 'proKeys') {
        return (proKeysViewStart ?? PRO_KEYS_MIN) + laneIndex
      }
      // Vocals: lane index maps to approximate pitch
      if (instrument === 'vocals') {
        return 36 + Math.round((laneIndex / 11) * 48) // pitch 36-84
      }
      const guitarLanes = ['green', 'red', 'yellow', 'blue', 'orange']
      return guitarLanes[laneIndex] || 'green'
    },
    [instrument, proKeysViewStart]
  )

  // Drag state for sustain drawing and box-select
  const dragRef = useRef<{
    mode: 'sustain' | 'select' | 'sp-extend' | 'solo-extend'
    startTick: number
    noteId?: string
    instrument: Instrument
  } | null>(null)
  const isDragging = useRef(false)

  const highwayCenterZ = STRIKE_LINE_POS - HIGHWAY_LENGTH / 2

  const handlePointerMove = useCallback(
    (e: { point: THREE.Vector3; stopPropagation?: () => void }) => {
      // Handle drag-to-sustain during place tool
      if (isDragging.current && dragRef.current) {
        e.stopPropagation?.()
        const { tick } = worldToTickAndLane(e.point)
        if (dragRef.current.mode === 'sustain' && dragRef.current.noteId) {
          const duration = Math.max(0, tick - dragRef.current.startTick)
          const store = getSongStore(songId)
          store.getState().updateNote(dragRef.current.noteId, { duration })
        } else if (dragRef.current.mode === 'select') {
          // Live box-select: select all notes between startTick and current tick
          const store = getSongStore(songId)
          const startTick = Math.min(dragRef.current.startTick, tick)
          const endTick = Math.max(dragRef.current.startTick, tick)
          store.getState().selectAllInRange(startTick, endTick, instrument)
        } else if (dragRef.current.mode === 'sp-extend' && dragRef.current.noteId) {
          const duration = Math.max(480, tick - dragRef.current.startTick)
          const store = getSongStore(songId)
          store.getState().updateStarPowerPhrase(dragRef.current.noteId, { duration })
        } else if (dragRef.current.mode === 'solo-extend' && dragRef.current.noteId) {
          const duration = Math.max(480, tick - dragRef.current.startTick)
          const store = getSongStore(songId)
          store.getState().updateSoloSection(dragRef.current.noteId, { duration })
        }
        return
      }

      if (editTool === 'select') {
        if (ghost.visible) setGhost((g) => ({ ...g, visible: false }))
        return
      }
      e.stopPropagation?.()
      const { tick, lane, isKick } = worldToTickAndLane(e.point)
      const mods = useUIStore.getState().noteModifiers
      let effectiveKick = isKick || (mods.openOrKick && instrumentType === 'drums')

      // For erase tool, detect kick note at this tick so ghost snaps to it
      if (editTool === 'erase' && instrumentType === 'drums' && !effectiveKick) {
        const store = getSongStore(songId)
        const ghostLane = getLaneString(lane, false)
        const notes = store.getState().song.notes
        const hasLaneNote = notes.some(
          (n) =>
            n.instrument === instrument &&
            n.difficulty === difficulty &&
            Math.abs(n.tick - tick) <= ticksPerSnap / 2 &&
            String(n.lane) === String(ghostLane)
        )
        if (!hasLaneNote) {
          const hasKick = notes.some(
            (n) =>
              n.instrument === instrument &&
              n.difficulty === difficulty &&
              Math.abs(n.tick - tick) <= ticksPerSnap / 2 &&
              String(n.lane) === 'kick'
          )
          if (hasKick) effectiveKick = true
        }
      }

      const z = STRIKE_LINE_POS - (tick - currentTick) * pixelsPerTick
      const isSpMode = mods.starPower && editTool === 'place'
      const isSoloMode = mods.solo && editTool === 'place'
      const isFullWidth = isSpMode || isSoloMode
      const x = isFullWidth ? offsetX : effectiveKick ? offsetX : offsetX + getFretX(lane, laneCount)
      const color = isSpMode ? '#00CCFF'
        : isSoloMode ? '#FFD700'
        : effectiveKick ? DRUM_KICK_COLOR
        : (mods.openOrKick && instrumentType !== 'drums') ? '#CC44FF'
        : (colors[lane % colors.length] || '#FFFFFF')
      setGhost({
        position: [x, 0.02, z],
        lane,
        tick,
        visible: true,
        color,
        isKick: isFullWidth || effectiveKick
      })
    },
    [editTool, worldToTickAndLane, currentTick, pixelsPerTick, offsetX, laneCount, colors, ghost.visible, instrumentType, songId, instrument, difficulty, getLaneString, ticksPerSnap]
  )

  const handlePointerLeave = useCallback(() => {
    setGhost((g) => ({ ...g, visible: false }))
  }, [])

  const handlePointerDown = useCallback(
    (e: { point: THREE.Vector3; stopPropagation?: () => void; nativeEvent?: MouseEvent }) => {
      e.stopPropagation?.()
      const store = getSongStore(songId)
      const { tick, lane, isKick } = worldToTickAndLane(e.point)
      const native = e.nativeEvent

      if (editTool === 'select') {
        // Check if clicking near existing note first
        const selectLane = getLaneString(lane, isKick)
        const existingNotes = store.getState().song.notes
        const target = existingNotes.find(
          (n) =>
            n.instrument === instrument &&
            n.difficulty === difficulty &&
            Math.abs(n.tick - tick) <= ticksPerSnap / 2 &&
            String(n.lane) === String(selectLane)
        )
        if (target) {
          store.getState().selectNote(target.id, native?.ctrlKey || native?.metaKey)
        } else {
          store.getState().clearSelection()
          // Start box-select drag
          isDragging.current = true
          dragRef.current = { mode: 'select', startTick: tick, instrument }
        }
      } else if (editTool === 'place') {
        const mods = useUIStore.getState().noteModifiers

        // Star Power placement mode
        if (mods.starPower) {
          store.getState().addStarPowerPhrase({
            tick,
            duration: 480, // Default 1 beat, drag to extend
            instrument
          })
          // Start drag to extend duration
          const latest = store.getState().song.starPowerPhrases
          const created = latest[latest.length - 1]
          if (created) {
            store.getState().selectStarPowerPhrase(created.id)
            isDragging.current = true
            dragRef.current = { mode: 'sp-extend', startTick: tick, noteId: created.id, instrument }
          }
          return
        }

        // Solo section placement mode
        if (mods.solo) {
          store.getState().addSoloSection({
            tick,
            duration: 480,
            instrument
          })
          const latest = store.getState().song.soloSections
          const created = latest[latest.length - 1]
          if (created) {
            store.getState().selectSoloSection(created.id)
            isDragging.current = true
            dragRef.current = { mode: 'solo-extend', startTick: tick, noteId: created.id, instrument }
          }
          return
        }

        // Open/kick toggle overrides the lane
        let noteLane: string | number
        if (mods.openOrKick) {
          noteLane = instrument === 'drums' ? 'kick' : 'open'
        } else {
          noteLane = getLaneString(lane, isKick)
        }
        const existingNotes = store.getState().song.notes
        const duplicate = existingNotes.find(
          (n) =>
            n.instrument === instrument &&
            n.difficulty === difficulty &&
            n.tick === tick &&
            String(n.lane) === String(noteLane)
        )
        if (duplicate) {
          store.getState().selectNote(duplicate.id)
          return
        }
        const flags = buildNoteFlags(instrument, mods)
        // Pro guitar/bass: add string and fret info
        const isProGtr = instrument === 'proGuitar' || instrument === 'proBass'
        store.getState().addNote({
          tick,
          duration: 0,
          instrument,
          difficulty,
          lane: noteLane as Note['lane'],
          velocity: 100,
          ...(flags ? { flags } : {}),
          ...(isProGtr ? { string: noteLane as ProGuitarString, fret: 0 } : {})
        })
        // For non-drum instruments, start sustain drag
        if (instrument !== 'drums') {
          const newNotes = store.getState().song.notes
          const placed = newNotes[newNotes.length - 1]
          if (placed) {
            isDragging.current = true
            dragRef.current = { mode: 'sustain', startTick: tick, noteId: placed.id, instrument }
          }
        }
      } else if (editTool === 'erase') {
        const eraseLane = getLaneString(lane, isKick)
        const existingNotes = store.getState().song.notes
        const matchesTick = existingNotes.filter(
          (n) =>
            n.instrument === instrument &&
            n.difficulty === difficulty &&
            Math.abs(n.tick - tick) <= ticksPerSnap / 2
        )
        const target = matchesTick.find((n) => String(n.lane) === String(eraseLane))
          || (instrumentType === 'drums' && !isKick
            ? matchesTick.find((n) => String(n.lane) === 'kick')
            : undefined)
        if (target) {
          store.getState().deleteNote(target.id)
        }
      }
    },
    [songId, editTool, worldToTickAndLane, instrument, difficulty, getLaneString, ticksPerSnap]
  )

  const handlePointerUp = useCallback(() => {
    isDragging.current = false
    dragRef.current = null
  }, [])

  return (
    <group>
      <mesh
        ref={planeRef}
        position={[offsetX, 0, highwayCenterZ]}
        rotation={[-Math.PI / 2, 0, 0]}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
      >
        <planeGeometry args={[TRACK_WIDTH + 0.3, HIGHWAY_LENGTH]} />
        <meshBasicMaterial visible={false} />
      </mesh>
      {ghost.visible && editTool === 'place' && (
        <GhostNote
          position={ghost.position}
          color={ghost.color}
          assets={assets}
          isDrum={instrumentType === 'drums'}
          isKick={ghost.isKick}
          noteModifiers={noteModifiers}
        />
      )}
      {ghost.visible && editTool === 'erase' && (
        <mesh position={ghost.position}>
          <ringGeometry args={[0.08, 0.12, 16]} />
          <meshBasicMaterial color="#FF3333" transparent opacity={0.6} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      )}
    </group>
  )
}
