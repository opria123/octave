// Animated Highway Scene - Main 3D scene orchestrator
import { useCallback, useRef, useContext, useMemo } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useStore } from 'zustand'
import { getSongStore, useSettingsStore, useUIStore } from '../../stores'
import { BASE_PIXELS_PER_TICK, TRACK_WIDTH, STRIKE_LINE_POS, HIGHWAY_LENGTH, HIT_EFFECT_TICKS, FRET_PRESS_TICKS, computeProKeysViewStart } from './constants'
import { HighwayAssetsContext } from './AssetProvider'
import { Highway } from './Highway'
import { Strikeline } from './Strikeline'
import { BeatGrid } from './BeatGrid'
import { NotesRenderer } from './NotesRenderer'
import { HighwayEditLayer } from './HighwayEditLayer'
import type { Instrument, Difficulty } from '../../types'
import type { HitEffect, EditingTool } from './types'

// Display names and accent colors for each instrument
const INSTRUMENT_LABELS: Record<string, { name: string; color: string }> = {
  drums: { name: 'DRUMS', color: '#FF4466' },
  guitar: { name: 'GUITAR', color: '#79D304' },
  bass: { name: 'BASS', color: '#FF8400' },
  keys: { name: 'KEYS', color: '#00BFFF' },
  proKeys: { name: 'PRO KEYS', color: '#A78BFA' },
  proGuitar: { name: 'PRO GUITAR', color: '#F97316' },
  proBass: { name: 'PRO BASS', color: '#FFB347' }
}

// Canvas-texture label cache
const labelTextureCache = new Map<string, THREE.CanvasTexture>()
function getLabelTexture(instrument: string): THREE.CanvasTexture {
  let tex = labelTextureCache.get(instrument)
  if (tex) return tex
  const info = INSTRUMENT_LABELS[instrument] || { name: instrument.toUpperCase(), color: '#FFFFFF' }
  const w = 256
  const h = 48
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, w, h)
  // Background pill
  ctx.fillStyle = '#000000'
  ctx.globalAlpha = 0.55
  const r = 10
  ctx.beginPath()
  ctx.moveTo(r, 0)
  ctx.lineTo(w - r, 0)
  ctx.quadraticCurveTo(w, 0, w, r)
  ctx.lineTo(w, h - r)
  ctx.quadraticCurveTo(w, h, w - r, h)
  ctx.lineTo(r, h)
  ctx.quadraticCurveTo(0, h, 0, h - r)
  ctx.lineTo(0, r)
  ctx.quadraticCurveTo(0, 0, r, 0)
  ctx.fill()
  ctx.globalAlpha = 1
  // Accent bar on left
  ctx.fillStyle = info.color
  ctx.fillRect(0, 4, 5, h - 8)
  // Text
  ctx.fillStyle = '#FFFFFF'
  ctx.font = 'bold 26px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(info.name, w / 2, h / 2 + 1)
  tex = new THREE.CanvasTexture(canvas)
  labelTextureCache.set(instrument, tex)
  return tex
}

// Track label sprite rendered above the strikeline
function TrackLabel({ instrument, offsetX }: { instrument: string; offsetX: number }): React.JSX.Element {
  const tex = useMemo(() => getLabelTexture(instrument), [instrument])
  return (
    <sprite
      position={[offsetX, 0.08, STRIKE_LINE_POS + 0.55]}
      scale={[1.6, 0.3, 1]}
    >
      <spriteMaterial map={tex} transparent depthWrite={false} sizeAttenuation />
    </sprite>
  )
}

export function AnimatedHighwayScene({
  songId,
  visibleInstruments,
  activeDifficulty,
  editTool
}: {
  songId: string
  visibleInstruments: Set<Instrument>
  activeDifficulty: Difficulty
  editTool: EditingTool
}): React.JSX.Element {
  const store = getSongStore(songId)
  const currentTick = useStore(store, (s) => s.currentTick)
  const notes = useStore(store, (s) => s.song.notes)
  const starPowerPhrases = useStore(store, (s) => s.song.starPowerPhrases)
  const soloSections = useStore(store, (s) => s.song.soloSections)
  const selectedNoteIds = useStore(store, (s) => s.selectedNoteIds)
  const selectedSpId = useStore(store, (s) => s.selectedSpId)
  const selectedSoloId = useStore(store, (s) => s.selectedSoloId)
  const tempoEvents = useStore(store, (s) => s.song.tempoEvents)
  const sourceFormat = useStore(store, (s) => s.song.sourceFormat)
  const snapDivision = useStore(store, (s) => s.snapDivision)
  const isPlaying = useStore(store, (s) => s.isPlaying)
  const assets = useContext(HighwayAssetsContext)
  const { highwaySpeed: _highwaySpeed } = useSettingsStore()

  const pixelsPerTick = BASE_PIXELS_PER_TICK

  // ALL animation state in refs — never triggers React re-renders
  const hitEffectsRef = useRef<HitEffect[]>([])
  const pressedLanesRef = useRef<Map<string, { index: number; startTick: number; endTick: number }[]>>(new Map())
  const hitNotesRef = useRef<Set<string>>(new Set())
  const wasPlayingRef = useRef<boolean>(false)

  // Reset hit tracking when playback starts or when scrubbing while stopped
  if (isPlaying && !wasPlayingRef.current) {
    hitNotesRef.current.clear()
    hitEffectsRef.current = []
    pressedLanesRef.current.clear()
  }
  if (!isPlaying) {
    // Clear flash effects when not playing (prevents stale flashes from scroll)
    if (hitEffectsRef.current.length > 0) {
      hitEffectsRef.current = []
      pressedLanesRef.current.clear()
    }
  }
  wasPlayingRef.current = isPlaying

  // Expire old hit effects
  const activeEffects = hitEffectsRef.current.filter(
    (e) => currentTick - e.startTick < HIT_EFFECT_TICKS
  )
  hitEffectsRef.current = activeEffects

  const handleNoteClick = useCallback(
    (noteId: string, event?: MouseEvent): void => {
      const store = getSongStore(songId)
      const ctrl = event?.ctrlKey || event?.metaKey || false

      // Use sticky toggle modifiers from UIStore
      const mods = useUIStore.getState().noteModifiers
      if (mods.cymbalOrTap || mods.ghostOrHopo || mods.accent) {
        const note = store.getState().song.notes.find((n) => n.id === noteId)
        if (note) {
          const isDrum = note.instrument === 'drums'
          const oldFlags = note.flags || {}
          const newFlags = { ...oldFlags }
          if (mods.cymbalOrTap) {
            if (isDrum) newFlags.isCymbal = !oldFlags.isCymbal
            else newFlags.isTap = !oldFlags.isTap
          }
          if (mods.ghostOrHopo) {
            if (isDrum) newFlags.isGhost = !oldFlags.isGhost
            else newFlags.isHOPO = !oldFlags.isHOPO
          }
          if (mods.accent) {
            newFlags.isAccent = !oldFlags.isAccent
          }
          store.getState().updateNote(noteId, { flags: newFlags })
          return
        }
      }
      store.getState().selectNote(noteId, ctrl)
    },
    [songId]
  )

  // Keep currentTick in a ref so handleNoteHit doesn't recreate closures every tick
  const currentTickRef = useRef(currentTick)
  currentTickRef.current = currentTick

  const handleNoteHit = useCallback(
    (instrumentKey: string) =>
      (_noteId: string, laneIndex: number, color: string, x: number, endTick: number): void => {
        const tick = currentTickRef.current
        hitEffectsRef.current = [
          ...hitEffectsRef.current.slice(-20),
          { id: `${_noteId}-${tick}`, instrumentKey, laneIndex, color, startTick: tick, endTick, x }
        ]
        const map = pressedLanesRef.current
        const lanes = map.get(instrumentKey) || []
        const existing = lanes.findIndex((l) => l.index === laneIndex)
        if (existing >= 0) {
          // Extend the press if new note has a later endTick
          lanes[existing] = {
            index: laneIndex,
            startTick: tick,
            endTick: Math.max(lanes[existing].endTick, endTick)
          }
        } else {
          lanes.push({ index: laneIndex, startTick: tick, endTick })
        }
        map.set(instrumentKey, [...lanes])
      },
    []
  )

  // Layout — scale tracks to fit when many are visible
  const highwayGap = 0.6
  const instrumentArray = useMemo(
    () => Array.from(visibleInstruments).filter((i) => i !== 'vocals'),
    [visibleInstruments]
  )

  // Pre-filter pro keys notes once instead of every render inside the map
  const proKeysNotes = useMemo(
    () => notes.filter((n) => n.instrument === 'proKeys'),
    [notes]
  )
  // Fit all tracks within a max width budget based on camera FOV
  const maxTotalWidth = 8.5 // fits comfortably in FOV 55 at camera distance 3
  const naturalWidth = instrumentArray.length * TRACK_WIDTH + (instrumentArray.length - 1) * highwayGap
  const layoutScale = naturalWidth > maxTotalWidth ? maxTotalWidth / naturalWidth : 1
  // Use unscaled positions inside a scaled group
  const startX = -naturalWidth / 2 + TRACK_WIDTH / 2

  return (
    <group scale={[layoutScale, 1, 1]}>
      {instrumentArray.map((instrument, index) => {
        const offsetX = startX + index * (TRACK_WIDTH + highwayGap)
        const instrumentType = instrument === 'drums' ? 'drums'
          : instrument === 'proKeys' ? 'proKeys'
          : (instrument === 'proGuitar' || instrument === 'proBass') ? 'proGuitar'
          : 'guitar'
        // Pro keys sliding viewport: compute which keys are currently visible
        const proKeysViewStart = instrument === 'proKeys'
          ? computeProKeysViewStart(proKeysNotes, currentTick)
          : undefined
        const instrumentKey = `${instrument}-${index}`

        // Compute fret presses from ref — sustain notes keep frets active until endTick
        const rawPresses = pressedLanesRef.current.get(instrumentKey) || []
        const lanePresses = rawPresses
          .filter((l) => {
            // Active if sustain hasn't ended, OR within the short press fade after endTick
            if (currentTick < l.endTick) return true
            return currentTick - l.endTick < FRET_PRESS_TICKS
          })
          .map((l) => {
            // Full brightness while sustain is active, fade out after endTick
            if (currentTick < l.endTick) {
              return { index: l.index, brightness: 1.0 }
            }
            const fadeProgress = (currentTick - l.endTick) / FRET_PRESS_TICKS
            return {
              index: l.index,
              brightness: Math.max(0, 1 - fadeProgress)
            }
          })

        if (rawPresses.length !== lanePresses.length) {
          pressedLanesRef.current.set(
            instrumentKey,
            rawPresses.filter((l) => currentTick - l.endTick < FRET_PRESS_TICKS)
          )
        }

        return (
          <group key={instrument}>
            <TrackLabel instrument={instrument} offsetX={offsetX} />
            <Highway instrumentType={instrumentType} offsetX={offsetX} currentTick={currentTick} pixelsPerTick={pixelsPerTick} proKeysViewStart={proKeysViewStart} />
            <Strikeline instrumentType={instrumentType} offsetX={offsetX} pressedLanes={lanePresses} />
            <BeatGrid currentTick={currentTick} ticksPerBeat={480} pixelsPerTick={pixelsPerTick} offsetX={offsetX} tempoEvents={tempoEvents} />
            <StarPowerOverlay
              phrases={starPowerPhrases}
              instrument={instrument}
              currentTick={currentTick}
              pixelsPerTick={pixelsPerTick}
              offsetX={offsetX}
              songId={songId}
              editTool={editTool}
              selectedSpId={selectedSpId}
            />
            <SoloOverlay
              sections={soloSections}
              instrument={instrument}
              currentTick={currentTick}
              pixelsPerTick={pixelsPerTick}
              offsetX={offsetX}
              songId={songId}
              editTool={editTool}
              selectedSoloId={selectedSoloId}
            />
            <NotesRenderer
              notes={notes}
              currentTick={currentTick}
              selectedNoteIds={selectedNoteIds}
              instrument={instrument}
              difficulty={activeDifficulty}
              pixelsPerTick={pixelsPerTick}
              offsetX={offsetX}
              onNoteClick={handleNoteClick}
              hitNotesRef={hitNotesRef}
              onNoteHit={handleNoteHit(instrumentKey)}
              assets={assets}
              isPlaying={isPlaying}
              proKeysViewStart={proKeysViewStart}
              sourceFormat={sourceFormat}
            />
            <HighwayEditLayer
              offsetX={offsetX}
              instrument={instrument}
              difficulty={activeDifficulty}
              currentTick={currentTick}
              pixelsPerTick={pixelsPerTick}
              songId={songId}
              editTool={editTool}
              snapDivision={snapDivision}
              assets={assets}
              proKeysViewStart={proKeysViewStart}
            />
            <HitEffectsGroup
              effects={activeEffects.filter((e) => e.instrumentKey === instrumentKey)}
              currentTick={currentTick}
              offsetX={offsetX}
            />
          </group>
        )
      })}
    </group>
  )
}

// Star Power overlay on highway
function StarPowerOverlay({
  phrases,
  instrument,
  currentTick,
  pixelsPerTick,
  offsetX,
  songId,
  editTool,
  selectedSpId
}: {
  phrases: { id: string; tick: number; duration: number; instrument: string }[]
  instrument: string
  currentTick: number
  pixelsPerTick: number
  offsetX: number
  songId: string
  editTool: string
  selectedSpId: string | null
}): React.JSX.Element {
  const visibleTicks = HIGHWAY_LENGTH / pixelsPerTick + 500
  const visible = phrases.filter(
    (sp) =>
      sp.instrument === instrument &&
      sp.tick + sp.duration >= currentTick - 200 &&
      sp.tick <= currentTick + visibleTicks
  )

  const handleSpClick = useCallback(
    (spId: string, e: { stopPropagation: () => void }) => {
      e.stopPropagation()
      const store = getSongStore(songId)
      if (editTool === 'erase') {
        store.getState().deleteStarPowerPhrase(spId)
      } else {
        store.getState().selectStarPowerPhrase(spId)
      }
    },
    [songId, editTool]
  )

  return (
    <>
      {visible.map((sp) => {
        const startZ = STRIKE_LINE_POS - (sp.tick - currentTick) * pixelsPerTick
        const endZ = STRIKE_LINE_POS - (sp.tick + sp.duration - currentTick) * pixelsPerTick
        const length = startZ - endZ
        const centerZ = endZ + length / 2
        const isSelected = sp.id === selectedSpId
        return (
          <mesh
            key={`sp-${sp.id}`}
            position={[offsetX, 0.003, centerZ]}
            onClick={(e) => handleSpClick(sp.id, e)}
          >
            <boxGeometry args={[TRACK_WIDTH * 0.98, 0.002, Math.abs(length)]} />
            <meshBasicMaterial
              color={isSelected ? '#33EEFF' : '#00CCFF'}
              transparent
              opacity={isSelected ? 0.25 : 0.12}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        )
      })}
      {/* Star power edge lines */}
      {visible.map((sp) => {
        const startZ = STRIKE_LINE_POS - (sp.tick - currentTick) * pixelsPerTick
        const endZ = STRIKE_LINE_POS - (sp.tick + sp.duration - currentTick) * pixelsPerTick
        const isSelected = sp.id === selectedSpId
        return (
          <group key={`sp-edges-${sp.id}`}>
            <mesh position={[offsetX, 0.004, startZ]}>
              <boxGeometry args={[TRACK_WIDTH * 0.98, 0.003, 0.03]} />
              <meshBasicMaterial color={isSelected ? '#33EEFF' : '#00CCFF'} transparent opacity={isSelected ? 0.9 : 0.6} depthWrite={false} toneMapped={false} />
            </mesh>
            <mesh position={[offsetX, 0.004, endZ]}>
              <boxGeometry args={[TRACK_WIDTH * 0.98, 0.003, 0.03]} />
              <meshBasicMaterial color={isSelected ? '#33EEFF' : '#00CCFF'} transparent opacity={isSelected ? 0.9 : 0.6} depthWrite={false} toneMapped={false} />
            </mesh>
          </group>
        )
      })}
    </>
  )
}

// Solo section overlay on highway (gold/amber theme)
function SoloOverlay({
  sections,
  instrument,
  currentTick,
  pixelsPerTick,
  offsetX,
  songId,
  editTool,
  selectedSoloId
}: {
  sections: { id: string; tick: number; duration: number; instrument: string }[]
  instrument: string
  currentTick: number
  pixelsPerTick: number
  offsetX: number
  songId: string
  editTool: string
  selectedSoloId: string | null
}): React.JSX.Element {
  const visibleTicks = HIGHWAY_LENGTH / pixelsPerTick + 500
  const visible = sections.filter(
    (s) =>
      s.instrument === instrument &&
      s.tick + s.duration >= currentTick - 200 &&
      s.tick <= currentTick + visibleTicks
  )

  const handleClick = useCallback(
    (soloId: string, e: { stopPropagation: () => void }) => {
      e.stopPropagation()
      const store = getSongStore(songId)
      if (editTool === 'erase') {
        store.getState().deleteSoloSection(soloId)
      } else {
        store.getState().selectSoloSection(soloId)
      }
    },
    [songId, editTool]
  )

  return (
    <>
      {visible.map((s) => {
        const startZ = STRIKE_LINE_POS - (s.tick - currentTick) * pixelsPerTick
        const endZ = STRIKE_LINE_POS - (s.tick + s.duration - currentTick) * pixelsPerTick
        const length = startZ - endZ
        const centerZ = endZ + length / 2
        const isSelected = s.id === selectedSoloId
        return (
          <mesh
            key={`solo-${s.id}`}
            position={[offsetX, 0.002, centerZ]}
            onClick={(e) => handleClick(s.id, e)}
          >
            <boxGeometry args={[TRACK_WIDTH * 0.98, 0.002, Math.abs(length)]} />
            <meshBasicMaterial
              color={isSelected ? '#FFEA00' : '#FFD700'}
              transparent
              opacity={isSelected ? 0.25 : 0.12}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        )
      })}
      {visible.map((s) => {
        const startZ = STRIKE_LINE_POS - (s.tick - currentTick) * pixelsPerTick
        const endZ = STRIKE_LINE_POS - (s.tick + s.duration - currentTick) * pixelsPerTick
        const isSelected = s.id === selectedSoloId
        return (
          <group key={`solo-edges-${s.id}`}>
            <mesh position={[offsetX, 0.003, startZ]}>
              <boxGeometry args={[TRACK_WIDTH * 0.98, 0.003, 0.03]} />
              <meshBasicMaterial color={isSelected ? '#FFEA00' : '#FFD700'} transparent opacity={isSelected ? 0.9 : 0.6} depthWrite={false} toneMapped={false} />
            </mesh>
            <mesh position={[offsetX, 0.003, endZ]}>
              <boxGeometry args={[TRACK_WIDTH * 0.98, 0.003, 0.03]} />
              <meshBasicMaterial color={isSelected ? '#FFEA00' : '#FFD700'} transparent opacity={isSelected ? 0.9 : 0.6} depthWrite={false} toneMapped={false} />
            </mesh>
          </group>
        )
      })}
    </>
  )
}

// Imperative hit flash — no React reconciliation, no stale meshes
const _sphereGeo = new THREE.SphereGeometry(0.06, 8, 8)
const _boxGeo = new THREE.BoxGeometry(0.02, 0.02, 0.02)

function HitEffectsGroup({
  effects,
  currentTick,
  offsetX
}: {
  effects: HitEffect[]
  currentTick: number
  offsetX: number
}): React.JSX.Element {
  const groupRef = useRef<THREE.Group>(null)

  // Pool of materials we reuse (avoid GC thrashing)
  const poolRef = useRef<{
    mats: THREE.MeshBasicMaterial[]
  }>({ mats: [] })

  useFrame(() => {
    const group = groupRef.current
    if (!group) return

    // Remove all children every frame (imperative — no React)
    while (group.children.length > 0) {
      group.remove(group.children[0])
    }

    // Dispose old pooled materials
    for (const m of poolRef.current.mats) m.dispose()
    poolRef.current.mats = []

    for (const effect of effects) {
      const progress = (currentTick - effect.startTick) / HIT_EFFECT_TICKS
      if (progress < 0 || progress >= 1) continue

      const flashOpacity = (1 - progress) * 0.8
      const flashScale = 0.3 + progress * 1.2

      // Flash sphere
      const flashMat = new THREE.MeshBasicMaterial({
        color: effect.color,
        transparent: true,
        opacity: flashOpacity,
        depthWrite: false,
        toneMapped: false
      })
      poolRef.current.mats.push(flashMat)
      const flashMesh = new THREE.Mesh(_sphereGeo, flashMat)
      flashMesh.position.set(offsetX + effect.x, 0.06, STRIKE_LINE_POS)
      flashMesh.scale.setScalar(flashScale)
      group.add(flashMesh)

      // 4 small particles
      for (let i = 0; i < 4; i++) {
        const angle = (i / 4) * Math.PI * 2 + progress * 2
        const dist = progress * 0.25
        const particleY = progress * 0.5
        const pScale = 1 - progress

        const pMat = new THREE.MeshBasicMaterial({
          color: effect.color,
          transparent: true,
          opacity: flashOpacity * 0.6,
          depthWrite: false,
          toneMapped: false
        })
        poolRef.current.mats.push(pMat)
        const pMesh = new THREE.Mesh(_boxGeo, pMat)
        pMesh.position.set(
          offsetX + effect.x + Math.cos(angle) * dist,
          0.04 + particleY,
          STRIKE_LINE_POS + Math.sin(angle) * dist
        )
        pMesh.scale.setScalar(pScale)
        group.add(pMesh)
      }
    }
  })

  return <group ref={groupRef} />
}
