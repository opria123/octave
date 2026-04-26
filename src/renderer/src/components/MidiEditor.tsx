// MIDI Editor - Piano roll style note editor
import { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import { useProjectStore, getSongStore, useSettingsStore, useUIStore } from '../stores'
import type { Note, NoteFlags, NoteModifiers, Instrument, DrumLane, GuitarLane, Difficulty, EditingTool, StarPowerPhrase, SoloSection, VocalNote, VocalPhrase, HarmonyPart, TempoEvent } from '../types'
import { PRO_KEYS_MIN, PRO_KEYS_MAX, SUSTAIN_THRESHOLD_MID, SUSTAIN_THRESHOLD_CHART } from '../types'
import { playPitchPreview, stopPitchPreview } from '../services/audioService'
import './MidiEditor.css'

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

const STRUM_GEM_WIDTH = 16 // Fixed pixel width for strum (non-sustained) notes
const SUSTAIN_HANDLE_WIDTH = 6 // Pixel width of the right-edge resize handle

// Configuration
const MIDI_EDITOR_CONFIG = {
  rowHeight: 20,
  spRowHeight: 24,
  headerWidth: 140,
  instrumentHeaderHeight: 28,
  pixelsPerTick: 0.1,
  snapDivisions: [1, 2, 4, 8, 12, 16, 24, 32],
  drumLanes: ['kick', 'snare', 'yellowTom', 'yellowCymbal', 'blueTom', 'blueCymbal', 'greenTom', 'greenCymbal'] as DrumLane[],
  guitarLanes: ['open', 'green', 'red', 'yellow', 'blue', 'orange'] as GuitarLane[],
  proGuitarLanes: ['1', '2', '3', '4', '5', '6'] as string[], // Strings high E to low E
  instruments: ['drums', 'guitar', 'bass', 'keys', 'proKeys', 'proGuitar', 'proBass', 'vocals'] as Instrument[],
  vocalPitchMin: 36,
  vocalPitchMax: 84,
  vocalRowHeight: 8, // Smaller rows for pitch display (49 pitch rows)
  proKeysPitchMin: PRO_KEYS_MIN,
  proKeysPitchMax: PRO_KEYS_MAX,
  proKeysRowHeight: 10, // Slightly larger than vocal rows for playability
  instrumentColors: {
    drums: '#FF6B6B',
    guitar: '#4ECDC4',
    bass: '#45B7D1',
    keys: '#96CEB4',
    proKeys: '#A78BFA',
    proGuitar: '#F97316',
    proBass: '#EF4444',
    vocals: '#E879F9'
  } as Record<string, string>,
  laneColors: {
    kick: '#FF4444',
    snare: '#FFAA44',
    yellowTom: '#FFFF44',
    yellowCymbal: '#FFFF88',
    blueTom: '#4488FF',
    blueCymbal: '#88BBFF',
    greenTom: '#44FF44',
    greenCymbal: '#88FF88',
    green: '#44FF44',
    red: '#FF4444',
    yellow: '#FFFF44',
    blue: '#4488FF',
    orange: '#FF8844',
    open: '#CC44FF',
    // Pro Guitar/Bass string colors (1=high E ... 6=low E)
    '1': '#FF4444',
    '2': '#FFAA44',
    '3': '#FFFF44',
    '4': '#4488FF',
    '5': '#44FF44',
    '6': '#FF8844'
  } as Record<string, string>
}

// MIDI note names for vocal pitch display
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
function midiNoteName(midi: number): string {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`
}

// Generate vocal pitch lane labels (high to low for piano roll layout)
const VOCAL_PITCH_LANES: string[] = []
for (let p = MIDI_EDITOR_CONFIG.vocalPitchMax; p >= MIDI_EDITOR_CONFIG.vocalPitchMin; p--) {
  VOCAL_PITCH_LANES.push(midiNoteName(p))
}

// Generate Pro Keys pitch lane labels (high to low, C3-C5 = MIDI 48-72)
const PRO_KEYS_PITCH_LANES: string[] = []
for (let p = MIDI_EDITOR_CONFIG.proKeysPitchMax; p >= MIDI_EDITOR_CONFIG.proKeysPitchMin; p--) {
  PRO_KEYS_PITCH_LANES.push(midiNoteName(p))
}

// Snap quantize function
function snapToGrid(tick: number, snapDivision: number, ticksPerBeat: number): number {
  const snapTicks = ticksPerBeat / snapDivision
  return Math.round(tick / snapTicks) * snapTicks
}

// Grid component
function Grid({
  width,
  height,
  lanes,
  rowHeight,
  scrollX,
  zoomLevel,
  ticksPerBeat,
  snapDivision,
  currentTick,
  tempoEvents
}: {
  width: number
  height: number
  lanes: string[]
  rowHeight: number
  scrollX: number
  zoomLevel: number
  ticksPerBeat: number
  snapDivision: number
  currentTick: number
  tempoEvents?: { tick: number; bpm: number }[]
}): React.JSX.Element {
  const gridCanvasRef = useRef<HTMLCanvasElement>(null)
  const playheadCanvasRef = useRef<HTMLCanvasElement>(null)

  // Draw static grid (only when scroll/zoom/snap/lanes change)
  useEffect(() => {
    const canvas = gridCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w === 0 || h === 0) return // not laid out yet — ResizeObserver will trigger redraw
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    else ctx.clearRect(0, 0, w, h)

    ctx.fillStyle = '#1a1a2e'
    ctx.fillRect(0, 0, w, h)

    const pixelsPerTick = MIDI_EDITOR_CONFIG.pixelsPerTick * zoomLevel
    const startTick = Math.floor(scrollX / pixelsPerTick)
    const endTick = Math.ceil((scrollX + w) / pixelsPerTick)

    // Draw horizontal lane lines
    ctx.strokeStyle = '#333355'
    ctx.lineWidth = 1
    for (let i = 0; i <= lanes.length; i++) {
      const y = i * rowHeight
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }

    // Draw vertical grid lines (beats and subdivisions)
    const snapTicks = ticksPerBeat / snapDivision
    const firstSnapLine = Math.floor(startTick / snapTicks) * snapTicks

    for (let tick = firstSnapLine; tick <= endTick; tick += snapTicks) {
      const x = (tick * pixelsPerTick) - scrollX
      if (x < 0 || x > w) continue

      const isBeat = tick % ticksPerBeat === 0
      const isMeasure = tick % (ticksPerBeat * 4) === 0

      ctx.strokeStyle = isMeasure ? '#555577' : isBeat ? '#444466' : '#2a2a4e'
      ctx.lineWidth = isMeasure ? 2 : 1
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
    }

    // Draw tempo change markers
    if (tempoEvents && tempoEvents.length > 1) {
      for (let i = 1; i < tempoEvents.length; i++) {
        const te = tempoEvents[i]
        const x = (te.tick * pixelsPerTick) - scrollX
        if (x < 0 || x > w) continue
        // Dashed orange line
        ctx.strokeStyle = '#FF8C00'
        ctx.lineWidth = 2
        ctx.setLineDash([5, 3])
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
        ctx.stroke()
        ctx.setLineDash([])
        // BPM label
        ctx.fillStyle = '#FF8C00'
        ctx.font = 'bold 10px monospace'
        ctx.textBaseline = 'top'
        ctx.fillText(`♩${Math.round(te.bpm * 10) / 10}`, x + 3, 2)
      }
    }
  }, [width, height, lanes, rowHeight, scrollX, zoomLevel, ticksPerBeat, snapDivision, tempoEvents])

  // Draw playhead only (lightweight, updates every tick)
  useEffect(() => {
    const canvas = playheadCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w === 0 || h === 0) return
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    else ctx.clearRect(0, 0, w, h)

    const pixelsPerTick = MIDI_EDITOR_CONFIG.pixelsPerTick * zoomLevel
    const playheadX = (currentTick * pixelsPerTick) - scrollX
    if (playheadX >= 0 && playheadX <= w) {
      ctx.strokeStyle = '#FFFFFF'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(playheadX, 0)
      ctx.lineTo(playheadX, h)
      ctx.stroke()
    }
  }, [width, height, currentTick, scrollX, zoomLevel])

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}>
      <canvas ref={gridCanvasRef} className="midi-grid-canvas" />
      <canvas ref={playheadCanvasRef} className="midi-grid-canvas" style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }} />
    </div>
  )
}

// Star Power lane - interactive SP phrase bars above note lanes
const SP_COLOR = '#00CCFF'
const SP_COLOR_SELECTED = '#33EEFF'
const SP_HANDLE_WIDTH = 6

function StarPowerLane({
  phrases,
  instrument,
  scrollX,
  zoomLevel,
  width: _width,
  selectedSpId,
  songStore,
  editTool,
  snapDivision
}: {
  phrases: StarPowerPhrase[]
  instrument: Instrument
  scrollX: number
  zoomLevel: number
  width: number
  selectedSpId: string | null
  songStore: ReturnType<typeof getSongStore> | null
  editTool: EditingTool
  snapDivision: number
}): React.JSX.Element {
  const height = MIDI_EDITOR_CONFIG.spRowHeight
  const pixelsPerTick = MIDI_EDITOR_CONFIG.pixelsPerTick * zoomLevel
  const dragRef = useRef<{
    mode: 'move' | 'resize-start' | 'resize-end' | 'draw'
    phraseId: string
    startMouseX: number
    originalTick: number
    originalDuration: number
  } | null>(null)

  const instrumentPhrases = useMemo(
    () => phrases.filter((sp) => sp.instrument === instrument),
    [phrases, instrument]
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!songStore) return
      const rect = e.currentTarget.getBoundingClientRect()
      const mx = e.clientX - rect.left + scrollX
      const clickTick = mx / pixelsPerTick

      // Check if clicking on an existing phrase
      for (const sp of instrumentPhrases) {
        const spX = sp.tick * pixelsPerTick - scrollX
        const spW = sp.duration * pixelsPerTick
        const localMx = e.clientX - rect.left

        if (localMx >= spX && localMx <= spX + spW) {
          if (editTool === 'erase') {
            songStore.getState().deleteStarPowerPhrase(sp.id)
            return
          }
          songStore.getState().selectStarPowerPhrase(sp.id)

          // Determine drag mode: resize handles at edges, move in middle
          if (localMx <= spX + SP_HANDLE_WIDTH) {
            dragRef.current = {
              mode: 'resize-start',
              phraseId: sp.id,
              startMouseX: e.clientX,
              originalTick: sp.tick,
              originalDuration: sp.duration
            }
          } else if (localMx >= spX + spW - SP_HANDLE_WIDTH) {
            dragRef.current = {
              mode: 'resize-end',
              phraseId: sp.id,
              startMouseX: e.clientX,
              originalTick: sp.tick,
              originalDuration: sp.duration
            }
          } else {
            dragRef.current = {
              mode: 'move',
              phraseId: sp.id,
              startMouseX: e.clientX,
              originalTick: sp.tick,
              originalDuration: sp.duration
            }
          }
          e.stopPropagation()
          return
        }
      }

      // Clicked on empty space - create new phrase (place tool) or draw
      if (editTool === 'place') {
        const tick = snapToGrid(clickTick, snapDivision, 480)
        songStore.getState().addStarPowerPhrase({
          tick,
          duration: 480, // Default 1 beat
          instrument
        })
        // Select the newly created phrase
        const latest = songStore.getState().song.starPowerPhrases
        const created = latest[latest.length - 1]
        if (created) {
          songStore.getState().selectStarPowerPhrase(created.id)
          dragRef.current = {
            mode: 'resize-end',
            phraseId: created.id,
            startMouseX: e.clientX,
            originalTick: created.tick,
            originalDuration: created.duration
          }
        }
        e.stopPropagation()
      } else if (editTool === 'select') {
        songStore.getState().selectStarPowerPhrase(null)
      }
    },
    [songStore, scrollX, pixelsPerTick, instrumentPhrases, editTool, instrument, snapDivision]
  )

  // Global mousemove/mouseup for drag operations
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent): void => {
      if (!dragRef.current || !songStore) return
      const drag = dragRef.current
      const dx = e.clientX - drag.startMouseX
      const dtick = dx / pixelsPerTick
      const snapTicks = 480 / snapDivision

      if (drag.mode === 'move') {
        const newTick = Math.max(0, Math.round((drag.originalTick + dtick) / snapTicks) * snapTicks)
        songStore.getState().updateStarPowerPhrase(drag.phraseId, { tick: newTick })
      } else if (drag.mode === 'resize-start') {
        const newStart = Math.max(0, Math.round((drag.originalTick + dtick) / snapTicks) * snapTicks)
        const endTick = drag.originalTick + drag.originalDuration
        const newDuration = Math.max(snapTicks, endTick - newStart)
        songStore.getState().updateStarPowerPhrase(drag.phraseId, { tick: newStart, duration: newDuration })
      } else if (drag.mode === 'resize-end') {
        const newDuration = Math.max(snapTicks, Math.round((drag.originalDuration + dtick) / snapTicks) * snapTicks)
        songStore.getState().updateStarPowerPhrase(drag.phraseId, { duration: newDuration })
      }
    }

    const handleMouseUp = (): void => {
      dragRef.current = null
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [songStore, pixelsPerTick, snapDivision])

  // Determine cursor
  const getCursor = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const localMx = e.clientX - rect.left
      for (const sp of instrumentPhrases) {
        const spX = sp.tick * pixelsPerTick - scrollX
        const spW = sp.duration * pixelsPerTick
        if (localMx >= spX && localMx <= spX + spW) {
          if (localMx <= spX + SP_HANDLE_WIDTH || localMx >= spX + spW - SP_HANDLE_WIDTH) {
            return 'ew-resize'
          }
          return editTool === 'erase' ? 'pointer' : 'grab'
        }
      }
      return editTool === 'place' ? 'crosshair' : 'default'
    },
    [instrumentPhrases, pixelsPerTick, scrollX, editTool]
  )

  const [cursor, setCursor] = useState('default')
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!dragRef.current) setCursor(getCursor(e))
    },
    [getCursor]
  )

  return (
    <div
      className="midi-sp-lane"
      style={{ height, cursor, position: 'relative', overflow: 'hidden' }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
    >
      {instrumentPhrases.map((sp) => {
        const x = sp.tick * pixelsPerTick - scrollX
        const w = sp.duration * pixelsPerTick
        const isSelected = sp.id === selectedSpId
        return (
          <div
            key={sp.id}
            className={`midi-sp-phrase${isSelected ? ' selected' : ''}`}
            style={{
              position: 'absolute',
              left: x,
              top: 2,
              width: Math.max(w, 4),
              height: height - 4,
              backgroundColor: isSelected ? SP_COLOR_SELECTED : SP_COLOR,
              opacity: isSelected ? 0.9 : 0.6,
              borderRadius: 3,
              border: isSelected ? '1px solid #fff' : '1px solid rgba(0,204,255,0.8)',
              pointerEvents: 'none'
            }}
          >
            {/* Resize handles - visual indicators */}
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: SP_HANDLE_WIDTH, cursor: 'ew-resize' }} />
            <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: SP_HANDLE_WIDTH, cursor: 'ew-resize' }} />
            {w > 40 && (
              <span style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
                fontSize: 9,
                fontWeight: 600,
                color: '#fff',
                textShadow: '0 0 4px rgba(0,0,0,0.5)',
                whiteSpace: 'nowrap',
                pointerEvents: 'none'
              }}>
                Star Power
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// Solo section lane - interactive solo bars (same pattern as StarPowerLane)
const SOLO_COLOR = '#FFD700'
const SOLO_COLOR_SELECTED = '#FFEA00'

function SoloLane({
  sections,
  instrument,
  scrollX,
  zoomLevel,
  width: _width,
  selectedSoloId,
  songStore,
  editTool,
  snapDivision
}: {
  sections: SoloSection[]
  instrument: Instrument
  scrollX: number
  zoomLevel: number
  width: number
  selectedSoloId: string | null
  songStore: ReturnType<typeof getSongStore> | null
  editTool: EditingTool
  snapDivision: number
}): React.JSX.Element {
  const height = MIDI_EDITOR_CONFIG.spRowHeight
  const pixelsPerTick = MIDI_EDITOR_CONFIG.pixelsPerTick * zoomLevel
  const dragRef = useRef<{
    mode: 'move' | 'resize-start' | 'resize-end'
    sectionId: string
    startMouseX: number
    originalTick: number
    originalDuration: number
  } | null>(null)

  const instrumentSections = useMemo(
    () => sections.filter((s) => s.instrument === instrument),
    [sections, instrument]
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!songStore) return
      const rect = e.currentTarget.getBoundingClientRect()
      const mx = e.clientX - rect.left + scrollX
      const clickTick = mx / pixelsPerTick

      for (const sec of instrumentSections) {
        const secX = sec.tick * pixelsPerTick - scrollX
        const secW = sec.duration * pixelsPerTick
        const localMx = e.clientX - rect.left

        if (localMx >= secX && localMx <= secX + secW) {
          if (editTool === 'erase') {
            songStore.getState().deleteSoloSection(sec.id)
            return
          }
          songStore.getState().selectSoloSection(sec.id)

          if (localMx <= secX + SP_HANDLE_WIDTH) {
            dragRef.current = { mode: 'resize-start', sectionId: sec.id, startMouseX: e.clientX, originalTick: sec.tick, originalDuration: sec.duration }
          } else if (localMx >= secX + secW - SP_HANDLE_WIDTH) {
            dragRef.current = { mode: 'resize-end', sectionId: sec.id, startMouseX: e.clientX, originalTick: sec.tick, originalDuration: sec.duration }
          } else {
            dragRef.current = { mode: 'move', sectionId: sec.id, startMouseX: e.clientX, originalTick: sec.tick, originalDuration: sec.duration }
          }
          e.stopPropagation()
          return
        }
      }

      if (editTool === 'place') {
        const tick = snapToGrid(clickTick, snapDivision, 480)
        songStore.getState().addSoloSection({ tick, duration: 480, instrument })
        const latest = songStore.getState().song.soloSections
        const created = latest[latest.length - 1]
        if (created) {
          songStore.getState().selectSoloSection(created.id)
          dragRef.current = { mode: 'resize-end', sectionId: created.id, startMouseX: e.clientX, originalTick: created.tick, originalDuration: created.duration }
        }
        e.stopPropagation()
      } else if (editTool === 'select') {
        songStore.getState().selectSoloSection(null)
      }
    },
    [songStore, scrollX, pixelsPerTick, instrumentSections, editTool, instrument, snapDivision]
  )

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent): void => {
      if (!dragRef.current || !songStore) return
      const drag = dragRef.current
      const dx = e.clientX - drag.startMouseX
      const dtick = dx / pixelsPerTick
      const snapTicks = 480 / snapDivision

      if (drag.mode === 'move') {
        const newTick = Math.max(0, Math.round((drag.originalTick + dtick) / snapTicks) * snapTicks)
        songStore.getState().updateSoloSection(drag.sectionId, { tick: newTick })
      } else if (drag.mode === 'resize-start') {
        const newStart = Math.max(0, Math.round((drag.originalTick + dtick) / snapTicks) * snapTicks)
        const endTick = drag.originalTick + drag.originalDuration
        const newDuration = Math.max(snapTicks, endTick - newStart)
        songStore.getState().updateSoloSection(drag.sectionId, { tick: newStart, duration: newDuration })
      } else if (drag.mode === 'resize-end') {
        const newDuration = Math.max(snapTicks, Math.round((drag.originalDuration + dtick) / snapTicks) * snapTicks)
        songStore.getState().updateSoloSection(drag.sectionId, { duration: newDuration })
      }
    }

    const handleMouseUp = (): void => { dragRef.current = null }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [songStore, pixelsPerTick, snapDivision])

  const getCursor = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const localMx = e.clientX - rect.left
      for (const sec of instrumentSections) {
        const secX = sec.tick * pixelsPerTick - scrollX
        const secW = sec.duration * pixelsPerTick
        if (localMx >= secX && localMx <= secX + secW) {
          if (localMx <= secX + SP_HANDLE_WIDTH || localMx >= secX + secW - SP_HANDLE_WIDTH) return 'ew-resize'
          return editTool === 'erase' ? 'pointer' : 'grab'
        }
      }
      return editTool === 'place' ? 'crosshair' : 'default'
    },
    [instrumentSections, pixelsPerTick, scrollX, editTool]
  )

  const [cursor, setCursor] = useState('default')
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => { if (!dragRef.current) setCursor(getCursor(e)) },
    [getCursor]
  )

  return (
    <div
      className="midi-sp-lane"
      style={{ height, cursor, position: 'relative', overflow: 'hidden', borderBottomColor: 'rgba(255,215,0,0.3)' }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
    >
      {instrumentSections.map((sec) => {
        const x = sec.tick * pixelsPerTick - scrollX
        const w = sec.duration * pixelsPerTick
        const isSelected = sec.id === selectedSoloId
        return (
          <div
            key={sec.id}
            style={{
              position: 'absolute',
              left: x,
              top: 2,
              width: Math.max(w, 4),
              height: height - 4,
              backgroundColor: isSelected ? SOLO_COLOR_SELECTED : SOLO_COLOR,
              opacity: isSelected ? 0.9 : 0.6,
              borderRadius: 3,
              border: isSelected ? '1px solid #fff' : '1px solid rgba(255,215,0,0.8)',
              pointerEvents: 'none'
            }}
          >
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: SP_HANDLE_WIDTH, cursor: 'ew-resize' }} />
            <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: SP_HANDLE_WIDTH, cursor: 'ew-resize' }} />
            {w > 40 && (
              <span style={{
                position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
                fontSize: 9, fontWeight: 600, color: '#000', textShadow: '0 0 4px rgba(255,255,255,0.3)',
                whiteSpace: 'nowrap', pointerEvents: 'none'
              }}>
                Solo
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// Notes component - renders notes on a Canvas overlay (not DOM divs)
function Notes({
  notes,
  lanes,
  rowHeight,
  scrollX,
  zoomLevel,
  width,
  height,
  selectedNoteIds,
  onNoteClick,
  onNoteMove: _onNoteMove,
  starPowerPhrases,
  instrument,
  onFretChange,
  onSustainResize,
  sustainThreshold
}: {
  notes: Note[]
  lanes: string[]
  rowHeight: number
  scrollX: number
  zoomLevel: number
  width: number
  height: number
  selectedNoteIds: string[]
  onNoteClick: (noteId: string, modifiers: { ctrl: boolean; shift: boolean; alt: boolean }) => void
  onNoteMove: (noteId: string, newTick: number, newLane: string) => void
  starPowerPhrases: StarPowerPhrase[]
  instrument: string
  onFretChange?: (noteId: string, fret: number) => void
  onSustainResize?: (noteId: string, e: React.MouseEvent) => void
  sustainThreshold: number
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pixelsPerTick = MIDI_EDITOR_CONFIG.pixelsPerTick * zoomLevel
  const isProGuitarInst = instrument === 'proGuitar' || instrument === 'proBass'

  // Inline fret editing state (like vocal lyric editing)
  const [editingFret, setEditingFret] = useState<{
    noteId: string; x: number; y: number; fret: string
  } | null>(null)

  const commitFret = useCallback(() => {
    if (editingFret && onFretChange) {
      const parsed = parseInt(editingFret.fret, 10)
      if (!isNaN(parsed)) {
        onFretChange(editingFret.noteId, Math.min(22, Math.max(0, parsed)))
      }
      setEditingFret(null)
    }
  }, [editingFret, onFretChange])

  // Track actual canvas width for accurate note culling
  const [canvasWidth, setCanvasWidth] = useState(width)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(([entry]) => {
      setCanvasWidth(entry.contentRect.width || width)
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [width])

  // Build a lookup of visible notes with their screen rects for hit-testing
  const visibleNotes = useMemo(() => {
    const cullWidth = Math.max(canvasWidth, width)
    const isDrums = instrument === 'drums'
    const result: { note: Note; x: number; y: number; w: number; h: number; isSustain: boolean }[] = []
    for (const note of notes) {
      const laneIndex = lanes.indexOf(String(note.lane))
      if (laneIndex === -1) continue
      const x = note.tick * pixelsPerTick - scrollX
      const isSustain = !isDrums && note.duration >= sustainThreshold
      const w = isSustain ? Math.max(note.duration * pixelsPerTick, STRUM_GEM_WIDTH) : STRUM_GEM_WIDTH
      if (x + w < 0 || x > cullWidth) continue
      const y = laneIndex * rowHeight + 2
      const h = rowHeight - 4
      result.push({ note, x, y, w, h, isSustain })
    }
    return result
  }, [notes, lanes, pixelsPerTick, scrollX, width, canvasWidth, rowHeight, instrument, sustainThreshold])

  // Draw notes on canvas
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w === 0 || h === 0) return // not laid out yet — ResizeObserver will trigger redraw
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    else ctx.clearRect(0, 0, w, h)

    // Draw star power phrase backgrounds
    const totalLaneHeight = lanes.length * rowHeight
    for (const sp of starPowerPhrases) {
      if (sp.instrument !== instrument) continue
      const spX = sp.tick * pixelsPerTick - scrollX
      const spW = sp.duration * pixelsPerTick
      if (spX + spW < 0 || spX > w) continue
      ctx.fillStyle = 'rgba(0, 200, 255, 0.1)'
      ctx.fillRect(spX, 0, spW, totalLaneHeight)
      // Edge lines
      ctx.strokeStyle = 'rgba(0, 200, 255, 0.5)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(spX, 0)
      ctx.lineTo(spX, totalLaneHeight)
      ctx.moveTo(spX + spW, 0)
      ctx.lineTo(spX + spW, totalLaneHeight)
      ctx.stroke()
    }

    const selectedSet = new Set(selectedNoteIds)
    const isProGuitarInst = instrument === 'proGuitar' || instrument === 'proBass'

    for (const { note, x, y, w, h, isSustain } of visibleNotes) {
      const isSelected = selectedSet.has(note.id)
      const color = MIDI_EDITOR_CONFIG.laneColors[String(note.lane)] || '#888888'

      if (isSustain) {
        // Sustain: gem head + thinner tail
        const tailH = Math.max(h * 0.4, 4)
        const tailY = y + (h - tailH) / 2

        // Draw sustain tail
        ctx.fillStyle = color
        ctx.globalAlpha = isSelected ? 0.7 : 0.5
        ctx.beginPath()
        ctx.roundRect(x + STRUM_GEM_WIDTH / 2, tailY, w - STRUM_GEM_WIDTH / 2, tailH, 2)
        ctx.fill()

        // Draw gem head (full height)
        ctx.globalAlpha = isSelected ? 1.0 : 0.85
        ctx.beginPath()
        ctx.roundRect(x, y, STRUM_GEM_WIDTH, h, 3)
        ctx.fill()

        // Sustain end handle (subtle line)
        ctx.fillStyle = isSelected ? '#FFFFFF' : color
        ctx.globalAlpha = isSelected ? 0.9 : 0.6
        ctx.fillRect(x + w - 2, tailY, 2, tailH)
      } else {
        // Strum: short gem
        ctx.fillStyle = color
        ctx.globalAlpha = isSelected ? 1.0 : 0.85
        ctx.beginPath()
        ctx.roundRect(x, y, w, h, 3)
        ctx.fill()
      }

      // Selection outline
      if (isSelected) {
        ctx.strokeStyle = '#FFFFFF'
        ctx.lineWidth = 2
        ctx.beginPath()
        if (isSustain) {
          // Outline the full sustain area
          ctx.roundRect(x, y, w, h, 3)
        } else {
          ctx.roundRect(x, y, w, h, 3)
        }
        ctx.stroke()
      }

      // Draw fret number for pro guitar/bass
      if (isProGuitarInst && note.fret !== undefined) {
        ctx.globalAlpha = 1.0
        ctx.fillStyle = '#000'
        ctx.font = 'bold 10px monospace'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(note.fret), x + Math.min(w, STRUM_GEM_WIDTH) / 2, y + h / 2)
      }

      ctx.globalAlpha = 1.0
    }
  }, [visibleNotes, selectedNoteIds, width, height, starPowerPhrases, instrument, pixelsPerTick, scrollX, lanes, rowHeight])

  // Handle mousedown: intercept sustain right-edge drags before click propagates
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!onSustainResize) return
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top

      for (let i = visibleNotes.length - 1; i >= 0; i--) {
        const { note, x, y, w, h, isSustain } = visibleNotes[i]
        if (!isSustain) continue
        if (my >= y && my <= y + h && mx >= x + w - SUSTAIN_HANDLE_WIDTH && mx <= x + w + 2) {
          e.stopPropagation()
          e.preventDefault()
          onSustainResize(note.id, e)
          return
        }
      }
    },
    [visibleNotes, onSustainResize]
  )

  // Handle click events via hit-testing against canvas coordinates
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top

      // Hit test in reverse order (top-most note wins)
      for (let i = visibleNotes.length - 1; i >= 0; i--) {
        const { note, x, y, w, h } = visibleNotes[i]
        if (mx >= x && mx <= x + w && my >= y && my <= y + h) {
          e.stopPropagation()
          onNoteClick(note.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey })
          return
        }
      }
    },
    [visibleNotes, onNoteClick]
  )

  // Double-click to edit fret number inline (pro guitar/bass only)
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isProGuitarInst || !onFretChange) return
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top

      for (let i = visibleNotes.length - 1; i >= 0; i--) {
        const { note, x, y, w, h } = visibleNotes[i]
        if (mx >= x && mx <= x + w && my >= y && my <= y + h) {
          e.stopPropagation()
          setEditingFret({
            noteId: note.id,
            x: Math.max(0, x),
            y: y,
            fret: String(note.fret ?? 0)
          })
          return
        }
      }
    },
    [visibleNotes, isProGuitarInst, onFretChange]
  )

  // Cursor: show ew-resize on sustain right edge, grab on selected notes
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top

      // Check sustain right-edge hover (for any note, not just selected)
      for (let i = visibleNotes.length - 1; i >= 0; i--) {
        const { x, y, w, h, isSustain } = visibleNotes[i]
        if (!isSustain) continue
        if (my >= y && my <= y + h && mx >= x + w - SUSTAIN_HANDLE_WIDTH && mx <= x + w + 2) {
          canvas.style.cursor = 'ew-resize'
          return
        }
      }

      const selectedSet = new Set(selectedNoteIds)
      if (selectedSet.size === 0) { canvas.style.cursor = ''; return }
      for (let i = visibleNotes.length - 1; i >= 0; i--) {
        const { note, x, y, w, h } = visibleNotes[i]
        if (selectedSet.has(note.id) && mx >= x - 4 && mx <= x + w + 4 && my >= y - 2 && my <= y + h + 2) {
          canvas.style.cursor = 'grab'
          return
        }
      }
      canvas.style.cursor = ''
    },
    [visibleNotes, selectedNoteIds]
  )

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        className="midi-notes-canvas"
        onMouseDown={handleMouseDown}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onMouseMove={handleMouseMove}
        style={{ pointerEvents: 'auto' }}
      />
      {editingFret && (
        <input
          autoFocus
          type="number"
          min={0}
          max={22}
          value={editingFret.fret}
          onChange={(e) => setEditingFret({ ...editingFret, fret: e.target.value })}
          onBlur={commitFret}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitFret()
            if (e.key === 'Escape') setEditingFret(null)
            e.stopPropagation()
          }}
          style={{
            position: 'absolute',
            left: editingFret.x,
            top: Math.max(0, editingFret.y),
            width: 42,
            height: rowHeight,
            fontSize: 12,
            fontWeight: 700,
            color: '#fff',
            background: 'rgba(30, 30, 50, 0.95)',
            border: '1px solid #F97316',
            borderRadius: 3,
            padding: '0 4px',
            outline: 'none',
            zIndex: 20,
            pointerEvents: 'auto',
            textAlign: 'center'
          }}
        />
      )}
    </div>
  )
}

// Vocal Notes renderer - pitch-based horizontal bars with lyrics and phrase overlays
function VocalNotes({
  vocalNotes,
  vocalPhrases,
  harmonyPart,
  scrollX,
  zoomLevel,
  width,
  height,
  selectedNoteIds,
  onNoteClick,
  onLyricChange,
  onGridMouseDown,
  starPowerPhrases
}: {
  vocalNotes: VocalNote[]
  vocalPhrases: VocalPhrase[]
  harmonyPart: HarmonyPart
  scrollX: number
  zoomLevel: number
  width: number
  height: number
  selectedNoteIds: string[]
  onNoteClick: (noteId: string, modifiers: { ctrl: boolean; shift: boolean; alt: boolean }) => void
  onLyricChange: (noteId: string, lyric: string) => void
  onGridMouseDown: (e: React.MouseEvent<HTMLElement>) => void
  starPowerPhrases: StarPowerPhrase[]
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [editingLyric, setEditingLyric] = useState<{
    noteId: string; x: number; y: number; lyric: string
  } | null>(null)
  const pixelsPerTick = MIDI_EDITOR_CONFIG.pixelsPerTick * zoomLevel
  const rowHeight = MIDI_EDITOR_CONFIG.vocalRowHeight
  const pitchMin = MIDI_EDITOR_CONFIG.vocalPitchMin
  const pitchMax = MIDI_EDITOR_CONFIG.vocalPitchMax
  const pitchRange = pitchMax - pitchMin + 1

  const [canvasWidth, setCanvasWidth] = useState(width)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(([entry]) => {
      setCanvasWidth(entry.contentRect.width || width)
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [width])

  // Filter notes for current harmony part
  const partNotes = useMemo(() => {
    return vocalNotes.filter((n) => n.harmonyPart === harmonyPart)
  }, [vocalNotes, harmonyPart])

  const partPhrases = useMemo(() => {
    return vocalPhrases.filter((p) => p.harmonyPart === harmonyPart)
  }, [vocalPhrases, harmonyPart])

  // Build visible note rects
  const visibleNotes = useMemo(() => {
    const cullWidth = Math.max(canvasWidth, width)
    const result: { note: VocalNote; x: number; y: number; w: number; h: number }[] = []
    for (const note of partNotes) {
      const x = note.tick * pixelsPerTick - scrollX
      const w = Math.max(note.duration * pixelsPerTick, 12)
      if (x + w < 0 || x > cullWidth) continue
      const pitch = typeof note.lane === 'number' ? note.lane : 60
      const pitchIdx = pitchMax - Math.min(Math.max(pitch, pitchMin), pitchMax) // High pitches at top
      const y = pitchIdx * rowHeight + 1
      const h = rowHeight - 2
      result.push({ note, x, y, w, h })
    }
    return result
  }, [partNotes, pixelsPerTick, scrollX, width, canvasWidth, pitchMax, pitchMin, rowHeight])

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w === 0 || h === 0) return
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    else ctx.clearRect(0, 0, w, h)

    const totalHeight = pitchRange * rowHeight

    // Draw vocal phrase backgrounds
    for (const phrase of partPhrases) {
      const px = phrase.tick * pixelsPerTick - scrollX
      const pw = phrase.duration * pixelsPerTick
      if (px + pw < 0 || px > w) continue
      ctx.fillStyle = 'rgba(232, 121, 249, 0.08)'
      ctx.fillRect(px, 0, pw, totalHeight)
      ctx.strokeStyle = 'rgba(232, 121, 249, 0.4)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(px, 0)
      ctx.lineTo(px, totalHeight)
      ctx.moveTo(px + pw, 0)
      ctx.lineTo(px + pw, totalHeight)
      ctx.stroke()
    }

    // Draw star power backgrounds
    for (const sp of starPowerPhrases) {
      if (sp.instrument !== 'vocals') continue
      const spX = sp.tick * pixelsPerTick - scrollX
      const spW = sp.duration * pixelsPerTick
      if (spX + spW < 0 || spX > w) continue
      ctx.fillStyle = 'rgba(0, 200, 255, 0.1)'
      ctx.fillRect(spX, 0, spW, totalHeight)
    }

    // Draw octave reference lines (C notes)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
    ctx.lineWidth = 1
    for (let pitch = pitchMin; pitch <= pitchMax; pitch++) {
      if (pitch % 12 === 0) { // C notes
        const y = (pitchMax - pitch) * rowHeight
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
      }
    }

    const selectedSet = new Set(selectedNoteIds)

    // Sort notes by tick for transition drawing
    const sortedNotes = [...visibleNotes].sort((a, b) => a.note.tick - b.note.tick)

    // Draw pitch-shift transition lines between consecutive notes (YARG-style portamento)
    for (let i = 1; i < sortedNotes.length; i++) {
      const prev = sortedNotes[i - 1]
      const curr = sortedNotes[i]
      if (curr.note.isPercussion || prev.note.isPercussion) continue
      // Only draw transition if notes are close enough (within a beat gap)
      const gap = curr.note.tick - (prev.note.tick + prev.note.duration)
      if (gap < 0 || gap > 240) continue // skip if overlapping or too far apart
      const prevPitch = typeof prev.note.lane === 'number' ? prev.note.lane : 60
      const currPitch = typeof curr.note.lane === 'number' ? curr.note.lane : 60
      if (prevPitch === currPitch) continue // same pitch, no transition needed

      const x1 = prev.x + prev.w
      const y1 = prev.y + prev.h / 2
      const x2 = curr.x
      const y2 = curr.y + curr.h / 2

      const partColors = ['#E879F9', '#60A5FA', '#34D399', '#FBBF24']
      ctx.strokeStyle = partColors[harmonyPart] || '#E879F9'
      ctx.globalAlpha = 0.5
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      // Bezier curve for smooth transition
      const midX = (x1 + x2) / 2
      ctx.bezierCurveTo(midX, y1, midX, y2, x2, y2)
      ctx.stroke()
      ctx.globalAlpha = 1.0
    }

    // Draw notes
    for (const { note, x, y, w: nw, h: nh } of visibleNotes) {
      const isSelected = selectedSet.has(note.id)
      const isPercussion = note.isPercussion

      // Color by harmony part
      const partColors = ['#E879F9', '#60A5FA', '#34D399', '#FBBF24']
      const color = isPercussion ? '#888888' : (partColors[harmonyPart] || '#E879F9')

      // Note body
      ctx.fillStyle = color
      ctx.globalAlpha = isSelected ? 1.0 : 0.8
      ctx.beginPath()
      if (isPercussion) {
        // Percussion: diamond shape
        const cx = x + nw / 2
        const cy = y + nh / 2
        const r = Math.min(nw, nh) / 2
        ctx.moveTo(cx, cy - r)
        ctx.lineTo(cx + r, cy)
        ctx.lineTo(cx, cy + r)
        ctx.lineTo(cx - r, cy)
        ctx.closePath()
      } else {
        ctx.roundRect(x, y, nw, nh, 2)
      }
      ctx.fill()

      // Slide indicator
      if (note.isSlide) {
        ctx.strokeStyle = '#FFFFFF'
        ctx.lineWidth = 1
        ctx.setLineDash([3, 2])
        ctx.stroke()
        ctx.setLineDash([])
      }

      // Selection outline
      if (isSelected) {
        ctx.strokeStyle = '#FFFFFF'
        ctx.lineWidth = 2
        ctx.setLineDash([])
        ctx.stroke()
      }

      ctx.globalAlpha = 1.0

      // Lyric text — drawn above the note bar for visibility
      if (note.lyric) {
        ctx.fillStyle = '#FFFFFF'
        ctx.font = 'bold 11px sans-serif'
        ctx.textBaseline = 'bottom'
        ctx.fillText(note.lyric, x + 2, y - 2, Math.max(nw, 60))
      }
    }
  }, [visibleNotes, selectedNoteIds, width, height, partPhrases, starPowerPhrases, pixelsPerTick, scrollX, pitchRange, pitchMax, pitchMin, rowHeight, harmonyPart])

  // Hit testing
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top

      for (let i = visibleNotes.length - 1; i >= 0; i--) {
        const { note, x, y, w, h } = visibleNotes[i]
        if (mx >= x && mx <= x + w && my >= y && my <= y + h) {
          e.stopPropagation()
          onNoteClick(note.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey })
          return
        }
      }
    },
    [visibleNotes, onNoteClick]
  )

  // Double-click to edit lyric inline
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top

      for (let i = visibleNotes.length - 1; i >= 0; i--) {
        const { note, x, y, w, h } = visibleNotes[i]
        if (mx >= x && mx <= x + w && my >= y && my <= y + h) {
          e.stopPropagation()
          setEditingLyric({
            noteId: note.id,
            x: Math.max(0, x),
            y: y - 20,
            lyric: note.lyric || ''
          })
          return
        }
      }
    },
    [visibleNotes]
  )

  const commitLyric = useCallback(() => {
    if (editingLyric) {
      onLyricChange(editingLyric.noteId, editingLyric.lyric)
      setEditingLyric(null)
    }
  }, [editingLyric, onLyricChange])

  // Cursor: show grab when hovering over a selected vocal note
  const handleCursorMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const selectedSet = new Set(selectedNoteIds)
      if (selectedSet.size === 0) { canvas.style.cursor = ''; return }
      for (let i = visibleNotes.length - 1; i >= 0; i--) {
        const { note, x, y, w, h } = visibleNotes[i]
        if (selectedSet.has(note.id) && mx >= x - 4 && mx <= x + w + 4 && my >= y - 2 && my <= y + h + 2) {
          canvas.style.cursor = 'grab'
          return
        }
      }
      canvas.style.cursor = ''
    },
    [visibleNotes, selectedNoteIds]
  )

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
      <canvas
        ref={canvasRef}
        className="midi-notes-canvas"
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onMouseDown={onGridMouseDown}
        onMouseMove={handleCursorMove}
        style={{ pointerEvents: 'auto' }}
      />
      {editingLyric && (
        <input
          autoFocus
          type="text"
          value={editingLyric.lyric}
          onChange={(e) => setEditingLyric({ ...editingLyric, lyric: e.target.value })}
          onBlur={commitLyric}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitLyric()
            if (e.key === 'Escape') setEditingLyric(null)
            e.stopPropagation()
          }}
          style={{
            position: 'absolute',
            left: editingLyric.x,
            top: Math.max(0, editingLyric.y),
            width: 120,
            height: 20,
            fontSize: 11,
            fontWeight: 600,
            color: '#fff',
            background: 'rgba(30, 30, 50, 0.95)',
            border: '1px solid #E879F9',
            borderRadius: 3,
            padding: '0 4px',
            outline: 'none',
            zIndex: 20,
            pointerEvents: 'auto'
          }}
        />
      )}
    </div>
  )
}

// Pro Keys Notes renderer - pitch-based horizontal bars (like vocals but no lyrics/phrases)
function ProKeysNotes({
  notes,
  scrollX,
  zoomLevel,
  width,
  height,
  selectedNoteIds,
  onNoteClick,
  starPowerPhrases,
  onGridMouseDown,
  sustainThreshold
}: {
  notes: Note[]
  scrollX: number
  zoomLevel: number
  width: number
  height: number
  selectedNoteIds: string[]
  onNoteClick: (noteId: string, modifiers: { ctrl: boolean; shift: boolean; alt: boolean }) => void
  starPowerPhrases: StarPowerPhrase[]
  onGridMouseDown: (e: React.MouseEvent<HTMLElement>) => void
  sustainThreshold: number
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pixelsPerTick = MIDI_EDITOR_CONFIG.pixelsPerTick * zoomLevel
  const rowHeight = MIDI_EDITOR_CONFIG.proKeysRowHeight
  const pitchMin = MIDI_EDITOR_CONFIG.proKeysPitchMin
  const pitchMax = MIDI_EDITOR_CONFIG.proKeysPitchMax
  const pitchRange = pitchMax - pitchMin + 1

  const [canvasWidth, setCanvasWidth] = useState(width)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(([entry]) => {
      setCanvasWidth(entry.contentRect.width || width)
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [width])

  const visibleNotes = useMemo(() => {
    const cullWidth = Math.max(canvasWidth, width)
    const result: { note: Note; x: number; y: number; w: number; h: number; isSustain: boolean }[] = []
    for (const note of notes) {
      const isSustain = note.duration >= sustainThreshold
      const x = note.tick * pixelsPerTick - scrollX
      const w = isSustain ? Math.max(note.duration * pixelsPerTick, 12) : 12
      if (x + w < 0 || x > cullWidth) continue
      const pitch = typeof note.lane === 'number' ? note.lane : 60
      const pitchIdx = pitchMax - Math.min(Math.max(pitch, pitchMin), pitchMax)
      const y = pitchIdx * rowHeight + 1
      const h = rowHeight - 2
      result.push({ note, x, y, w, h, isSustain })
    }
    return result
  }, [notes, pixelsPerTick, scrollX, width, canvasWidth, pitchMax, pitchMin, rowHeight, sustainThreshold])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w === 0 || h === 0) return
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    else ctx.clearRect(0, 0, w, h)

    const totalHeight = pitchRange * rowHeight

    // Draw SP phrase backgrounds
    for (const sp of starPowerPhrases) {
      if (sp.instrument !== 'proKeys') continue
      const spX = sp.tick * pixelsPerTick - scrollX
      const spW = sp.duration * pixelsPerTick
      if (spX + spW < 0 || spX > w) continue
      ctx.fillStyle = 'rgba(0, 200, 255, 0.1)'
      ctx.fillRect(spX, 0, spW, totalHeight)
    }

    // Draw black key row shading
    for (let p = pitchMax; p >= pitchMin; p--) {
      const name = NOTE_NAMES[p % 12]
      if (!name.includes('#')) continue
      const pitchIdx = pitchMax - p
      const y = pitchIdx * rowHeight
      ctx.fillStyle = 'rgba(0, 0, 0, 0.15)'
      ctx.fillRect(0, y, w, rowHeight)
    }

    const selectedSet = new Set(selectedNoteIds)
    const proKeysColor = MIDI_EDITOR_CONFIG.instrumentColors.proKeys

    for (const { note, x, y, w: nw, h: nh } of visibleNotes) {
      const isSelected = selectedSet.has(note.id)
      const pitch = typeof note.lane === 'number' ? note.lane : 60
      const isBlackKey = NOTE_NAMES[pitch % 12].includes('#')

      ctx.fillStyle = isBlackKey ? '#7C3AED' : proKeysColor
      ctx.globalAlpha = isSelected ? 1.0 : 0.85
      ctx.beginPath()
      ctx.roundRect(x, y, nw, nh, 2)
      ctx.fill()

      if (isSelected) {
        ctx.strokeStyle = '#FFFFFF'
        ctx.lineWidth = 2
        ctx.stroke()
      }
      ctx.globalAlpha = 1.0
    }
  }, [visibleNotes, selectedNoteIds, width, height, starPowerPhrases, pixelsPerTick, scrollX, pitchRange, pitchMax, pitchMin, rowHeight])

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top

      for (let i = visibleNotes.length - 1; i >= 0; i--) {
        const { note, x, y, w, h } = visibleNotes[i]
        if (mx >= x && mx <= x + w && my >= y && my <= y + h) {
          e.stopPropagation()
          onNoteClick(note.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey })
          return
        }
      }
    },
    [visibleNotes, onNoteClick]
  )

  // Cursor: show grab when hovering over a selected proKeys note
  const handleCursorMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const selectedSet = new Set(selectedNoteIds)
      if (selectedSet.size === 0) { canvas.style.cursor = ''; return }
      for (let i = visibleNotes.length - 1; i >= 0; i--) {
        const { note, x, y, w, h } = visibleNotes[i]
        if (selectedSet.has(note.id) && mx >= x - 4 && mx <= x + w + 4 && my >= y - 2 && my <= y + h + 2) {
          canvas.style.cursor = 'grab'
          return
        }
      }
      canvas.style.cursor = ''
    },
    [visibleNotes, selectedNoteIds]
  )

  return (
    <canvas
      ref={canvasRef}
      className="midi-notes-canvas"
      onClick={handleClick}
      onMouseDown={onGridMouseDown}
      onMouseMove={handleCursorMove}
      style={{ pointerEvents: 'auto' }}
    />
  )
}

// Edit tool selector for MidiEditor toolbar
function MidiEditToolSelector(): React.JSX.Element {
  const editTool = useUIStore((s) => s.editTool)
  const setEditTool = useUIStore((s) => s.setEditTool)
  const tools: { id: EditingTool; label: string; icon: string; shortcut: string }[] = [
    { id: 'select', label: 'Select', icon: '🖱️', shortcut: '1' },
    { id: 'place', label: 'Place', icon: '✏️', shortcut: '2' },
    { id: 'erase', label: 'Erase', icon: '🗑️', shortcut: '3' }
  ]

  return (
    <div className="edit-tool-selector">
      {tools.map((tool) => (
        <button
          key={tool.id}
          className={`edit-tool-button ${editTool === tool.id ? 'active' : ''}`}
          onClick={() => setEditTool(tool.id)}
          title={`${tool.label} (${tool.shortcut})`}
        >
          <span>{tool.icon}</span>
          <span>{tool.label}</span>
        </button>
      ))}
    </div>
  )
}

// Note modifier toggle buttons
function NoteModifierToggles(): React.JSX.Element {
  const mods = useUIStore((s) => s.noteModifiers)
  const toggle = useUIStore((s) => s.toggleModifier)

  const buttons: { key: keyof typeof mods; label: string; shortcut: string; activeColor: string }[] = [
    { key: 'cymbalOrTap', label: 'Cymbal/Tap', shortcut: 'S', activeColor: '#FFD700' },
    { key: 'ghostOrHopo', label: 'Ghost/HOPO', shortcut: 'G', activeColor: '#88BBFF' },
    { key: 'accent', label: 'Accent', shortcut: 'F', activeColor: '#FF6666' },
    { key: 'openOrKick', label: 'Open/Kick', shortcut: 'O', activeColor: '#CC44FF' },
    { key: 'starPower', label: 'Star Power', shortcut: 'P', activeColor: '#00CED1' },
    { key: 'solo', label: 'Solo', shortcut: 'L', activeColor: '#FFD700' }
  ]

  return (
    <div className="note-modifier-toggles">
      {buttons.map((btn) => (
        <button
          key={btn.key}
          className={`modifier-toggle-button ${mods[btn.key] ? 'active' : ''}`}
          style={mods[btn.key] ? { backgroundColor: btn.activeColor, color: '#000' } : undefined}
          onClick={() => toggle(btn.key)}
          title={`${btn.label} (${btn.shortcut})`}
        >
          <span>{btn.label}</span>
          <kbd>{btn.shortcut}</kbd>
        </button>
      ))}
    </div>
  )
}

// Shortcut help button (same as the one in ChartPreview, rendered locally)
function MidiShortcutHelpButton(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="shortcut-help-wrapper">
      <button
        className={`shortcut-help-toggle ${open ? 'active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Keyboard Shortcuts"
      >
        ?
      </button>
      {open && (
        <div className="shortcut-help-panel">
          <div className="shortcut-help-title">Keyboard Shortcuts</div>
          <div className="shortcut-help-section">
            <div className="shortcut-help-section-title">Tools</div>
            <div className="shortcut-row"><div className="shortcut-keys"><kbd>1</kbd></div><span className="shortcut-desc">Select tool</span></div>
            <div className="shortcut-row"><div className="shortcut-keys"><kbd>2</kbd></div><span className="shortcut-desc">Place tool</span></div>
            <div className="shortcut-row"><div className="shortcut-keys"><kbd>3</kbd></div><span className="shortcut-desc">Erase tool</span></div>
          </div>
          <div className="shortcut-help-section">
            <div className="shortcut-help-section-title">Note Modifiers (toggle)</div>
            <div className="shortcut-row"><div className="shortcut-keys"><kbd>S</kbd></div><span className="shortcut-desc">Cymbal / Tap</span></div>
            <div className="shortcut-row"><div className="shortcut-keys"><kbd>G</kbd></div><span className="shortcut-desc">Ghost / HOPO</span></div>
            <div className="shortcut-row"><div className="shortcut-keys"><kbd>F</kbd></div><span className="shortcut-desc">Accent</span></div>
            <div className="shortcut-row"><div className="shortcut-keys"><kbd>O</kbd></div><span className="shortcut-desc">Open / Kick</span></div>
            <div className="shortcut-row"><div className="shortcut-keys"><kbd>P</kbd></div><span className="shortcut-desc">Star Power mode</span></div>
          </div>
          <div className="shortcut-help-section">
            <div className="shortcut-help-section-title">Editing</div>
            <div className="shortcut-row"><div className="shortcut-keys"><kbd>Ctrl</kbd><span className="shortcut-plus">+</span><kbd>C</kbd></div><span className="shortcut-desc">Copy</span></div>
            <div className="shortcut-row"><div className="shortcut-keys"><kbd>Ctrl</kbd><span className="shortcut-plus">+</span><kbd>V</kbd></div><span className="shortcut-desc">Paste at playhead</span></div>
            <div className="shortcut-row"><div className="shortcut-keys"><kbd>Ctrl</kbd><span className="shortcut-plus">+</span><kbd>Z</kbd></div><span className="shortcut-desc">Undo</span></div>
            <div className="shortcut-row"><div className="shortcut-keys"><kbd>Del</kbd></div><span className="shortcut-desc">Delete selected</span></div>
            <div className="shortcut-row"><div className="shortcut-keys"><kbd>Ctrl</kbd><span className="shortcut-plus">+</span><kbd>P</kbd></div><span className="shortcut-desc">Star Power from selection</span></div>
            <div className="shortcut-row"><div className="shortcut-keys"><kbd>Esc</kbd></div><span className="shortcut-desc">Clear selection</span></div>
          </div>
          <div className="shortcut-help-section">
            <div className="shortcut-help-section-title">Click Modifiers</div>
            <div className="shortcut-row"><div className="shortcut-keys"><kbd>Ctrl</kbd><span className="shortcut-plus">+</span><kbd>Click</kbd></div><span className="shortcut-desc">Multi-select</span></div>
            <div className="shortcut-row"><div className="shortcut-keys"><kbd>Click</kbd><span className="shortcut-plus">+</span><kbd>Drag</kbd></div><span className="shortcut-desc">Box select / Sustain</span></div>
          </div>
          <div className="shortcut-help-section">
            <div className="shortcut-help-section-title">Pro Guitar/Bass</div>
            <div className="shortcut-row"><div className="shortcut-keys"><kbd>Dbl-click</kbd></div><span className="shortcut-desc">Edit fret number inline</span></div>
            <div className="shortcut-row"><div className="shortcut-keys"><kbd>↑</kbd> / <kbd>↓</kbd></div><span className="shortcut-desc">Fret +1 / −1</span></div>
          </div>
        </div>
      )}
    </div>
  )
}

// Playhead ruler - click/drag to position the playhead
// Split into two canvases: static ruler (redraws on scroll/zoom) + lightweight playhead overlay
function PlayheadRuler({
  scrollX,
  zoomLevel,
  currentTick,
  snapDivision,
  songStore,
  headerWidth
}: {
  scrollX: number
  zoomLevel: number
  currentTick: number
  snapDivision: number
  songStore: ReturnType<typeof getSongStore>
  headerWidth: number
}): React.JSX.Element {
  const rulerCanvasRef = useRef<HTMLCanvasElement>(null)
  const playheadCanvasRef = useRef<HTMLCanvasElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const pixelsPerTick = MIDI_EDITOR_CONFIG.pixelsPerTick * zoomLevel

  const tickFromX = useCallback((clientX: number): number => {
    const canvas = rulerCanvasRef.current
    if (!canvas) return 0
    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left + scrollX
    const rawTick = x / pixelsPerTick
    const snapTicks = 480 / snapDivision
    return Math.max(0, Math.round(rawTick / snapTicks) * snapTicks)
  }, [scrollX, pixelsPerTick, snapDivision])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setIsDragging(true)
    const tick = tickFromX(e.clientX)
    songStore.getState().setCurrentTick(tick)
  }, [tickFromX, songStore])

  useEffect(() => {
    if (!isDragging) return
    const onMove = (e: MouseEvent): void => {
      const tick = tickFromX(e.clientX)
      songStore.getState().setCurrentTick(tick)
    }
    const onUp = (): void => setIsDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [isDragging, tickFromX, songStore])

  // Draw static ruler (measure/beat markers only) - redraws on scroll/zoom
  useEffect(() => {
    const canvas = rulerCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.clientWidth || 100
    const h = 20
    canvas.width = w
    canvas.height = h

    ctx.fillStyle = '#12122a'
    ctx.fillRect(0, 0, w, h)

    const startTick = Math.floor(scrollX / pixelsPerTick)
    const endTick = Math.ceil((scrollX + w) / pixelsPerTick)

    for (let tick = Math.floor(startTick / 480) * 480; tick <= endTick; tick += 480) {
      const x = tick * pixelsPerTick - scrollX
      if (x < 0 || x > w) continue
      const isMeasure = tick % 1920 === 0
      ctx.strokeStyle = isMeasure ? '#666688' : '#444466'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x, isMeasure ? 0 : 10)
      ctx.lineTo(x, h)
      ctx.stroke()
      if (isMeasure) {
        ctx.fillStyle = '#888899'
        ctx.font = '9px sans-serif'
        ctx.fillText(`${Math.floor(tick / 1920) + 1}`, x + 2, 9)
      }
    }
  }, [scrollX, pixelsPerTick, snapDivision])

  // Draw playhead only - lightweight, redraws on tick change
  useEffect(() => {
    const canvas = playheadCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.clientWidth || 100
    const h = 20
    canvas.width = w
    canvas.height = h

    ctx.clearRect(0, 0, w, h)

    const playheadX = currentTick * pixelsPerTick - scrollX
    if (playheadX >= 0 && playheadX <= w) {
      ctx.fillStyle = '#FFFFFF'
      ctx.beginPath()
      ctx.moveTo(playheadX, 0)
      ctx.lineTo(playheadX - 4, 0)
      ctx.lineTo(playheadX, 8)
      ctx.lineTo(playheadX + 4, 0)
      ctx.closePath()
      ctx.fill()
      ctx.strokeStyle = '#FFFFFF'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(playheadX, 0)
      ctx.lineTo(playheadX, h)
      ctx.stroke()
    }
  }, [currentTick, scrollX, pixelsPerTick])

  return (
    <div className="midi-ruler" style={{ marginLeft: headerWidth, position: 'relative' }}>
      <canvas
        ref={rulerCanvasRef}
        className="midi-ruler-canvas"
        style={{ cursor: 'col-resize' }}
      />
      <canvas
        ref={playheadCanvasRef}
        className="midi-ruler-canvas"
        onMouseDown={handleMouseDown}
        style={{ cursor: 'col-resize', position: 'absolute', top: 0, left: 0, pointerEvents: 'auto' }}
      />
    </div>
  )
}

// Snap selector
function SnapSelector({
  value,
  onChange
}: {
  value: number
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <div className="midi-snap-selector">
      <label>Snap:</label>
      <select value={value} onChange={(e) => onChange(parseInt(e.target.value))}>
        {MIDI_EDITOR_CONFIG.snapDivisions.map((div) => (
          <option key={div} value={div}>
            1/{div}
          </option>
        ))}
      </select>
    </div>
  )
}

// Main MIDI Editor component
export function MidiEditor(): React.JSX.Element {
  const { activeSongId } = useProjectStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 300 })
  const [scrollX, setScrollX] = useState(0)
  const [scrollY, setScrollY] = useState(0)
  const { pianoRollZoom: zoomLevel, updateSettings } = useSettingsStore()
  const setZoomLevel = useCallback((updater: number | ((prev: number) => number)) => {
    const newZoom = typeof updater === 'function' ? updater(useSettingsStore.getState().pianoRollZoom ?? 2.0) : updater
    updateSettings({ pianoRollZoom: Math.max(0.1, Math.min(5, newZoom)) })
  }, [updateSettings])
  const [visibleInstruments, setVisibleInstruments] = useState<Set<Instrument>>(new Set(MIDI_EDITOR_CONFIG.instruments))
  const [collapsedInstruments, setCollapsedInstruments] = useState<Set<Instrument>>(new Set())
  const isUserScrolling = useRef(false)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Get song store — use reactive selectors for data that changes during playback
  const songStore = activeSongId ? getSongStore(activeSongId) : null
  const editTool = useUIStore((s) => s.editTool)
  const [notes, setNotes] = useState<Note[]>([])
  const eraserCursor = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M7 21h10'/%3E%3Cpath d='M5.5 11.5 17 23'/%3E%3Cpath d='m2 17 4.5-4.5 6 6L8 23z'/%3E%3Cpath d='m6.5 12.5 6-6 5 5-6 6'/%3E%3Cpath d='m12.5 6.5 4-4 5 5-4 4'/%3E%3C/svg%3E") 4 20, auto`
  const gridCursor = editTool === 'place' ? 'crosshair' : editTool === 'erase' ? eraserCursor : 'default'
  const [starPowerPhrases, setStarPowerPhrases] = useState<StarPowerPhrase[]>([])
  const [soloSections, setSoloSections] = useState<SoloSection[]>([])
  const [vocalNotes, setVocalNotes] = useState<VocalNote[]>([])
  const [vocalPhrases, setVocalPhrases] = useState<VocalPhrase[]>([])
  const [activeHarmonyPart, setActiveHarmonyPart] = useState<HarmonyPart>(0)
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([])
  const [selectedVocalNoteIds, setSelectedVocalNoteIds] = useState<string[]>([])
  const [selectedSpId, setSelectedSpId] = useState<string | null>(null)
  const [selectedSoloId, setSelectedSoloId] = useState<string | null>(null)
  const [snapDivision, setSnapDivisionState] = useState(4)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTick, setCurrentTick] = useState(0)
  const [activeDifficulty, setActiveDifficulty] = useState<Difficulty>('expert')
  const [tempoEvents, setTempoEvents] = useState<TempoEvent[]>([{ tick: 0, bpm: 120 }])

  // Compute sustain threshold based on source format (doesn't change per song)
  const sustainThreshold = useMemo(() => {
    if (!songStore) return SUSTAIN_THRESHOLD_MID
    const fmt = songStore.getState().song.sourceFormat
    return fmt === 'chart' ? SUSTAIN_THRESHOLD_CHART : SUSTAIN_THRESHOLD_MID
  }, [songStore])

  // Subscribe to all needed store fields reactively
  useEffect(() => {
    if (!songStore) {
      setNotes([])
      setStarPowerPhrases([])
      setVocalNotes([])
      setVocalPhrases([])
      setSelectedNoteIds([])
      setSelectedVocalNoteIds([])
      setSelectedSpId(null)
      setSelectedSoloId(null)
      setSnapDivisionState(4)
      setIsPlaying(false)
      setTempoEvents([{ tick: 0, bpm: 120 }])
      setCurrentTick(0)
      return
    }

    const init = songStore.getState()
    const persistedSnap = useSettingsStore.getState().snapDivision
    if (persistedSnap && persistedSnap !== init.snapDivision) {
      songStore.getState().setSnapDivision(persistedSnap)
    }
    setNotes(init.song.notes)
    setStarPowerPhrases(init.song.starPowerPhrases || [])
    setSoloSections(init.song.soloSections || [])
    setVocalNotes(init.song.vocalNotes || [])
    setVocalPhrases(init.song.vocalPhrases || [])
    setActiveHarmonyPart(init.activeHarmonyPart)
    setSelectedNoteIds(init.selectedNoteIds)
    setSelectedVocalNoteIds(init.selectedVocalNoteIds || [])
    setSelectedSpId(init.selectedSpId)
    setSelectedSoloId(init.selectedSoloId)
    setSnapDivisionState(persistedSnap ?? init.snapDivision)
    setIsPlaying(init.isPlaying)
    setCurrentTick(init.currentTick)
    setTempoEvents(init.song.tempoEvents || [{ tick: 0, bpm: 120 }])

    return songStore.subscribe((state, prev) => {
      if (state.song.notes !== prev.song.notes) {
        setNotes(state.song.notes)
      }
      if (state.song.starPowerPhrases !== prev.song.starPowerPhrases) setStarPowerPhrases(state.song.starPowerPhrases || [])
      if (state.song.soloSections !== prev.song.soloSections) setSoloSections(state.song.soloSections || [])
      if (state.song.vocalNotes !== prev.song.vocalNotes) setVocalNotes(state.song.vocalNotes || [])
      if (state.song.vocalPhrases !== prev.song.vocalPhrases) setVocalPhrases(state.song.vocalPhrases || [])
      if (state.activeHarmonyPart !== prev.activeHarmonyPart) setActiveHarmonyPart(state.activeHarmonyPart)
      if (state.selectedNoteIds !== prev.selectedNoteIds) setSelectedNoteIds(state.selectedNoteIds)
      if (state.selectedVocalNoteIds !== prev.selectedVocalNoteIds) setSelectedVocalNoteIds(state.selectedVocalNoteIds || [])
      if (state.selectedSpId !== prev.selectedSpId) setSelectedSpId(state.selectedSpId)
      if (state.selectedSoloId !== prev.selectedSoloId) setSelectedSoloId(state.selectedSoloId)
      if (state.snapDivision !== prev.snapDivision) setSnapDivisionState(state.snapDivision)
      if (state.isPlaying !== prev.isPlaying) setIsPlaying(state.isPlaying)
      if (state.song.tempoEvents !== prev.song.tempoEvents) setTempoEvents(state.song.tempoEvents || [{ tick: 0, bpm: 120 }])
      // Throttle currentTick updates during playback to reduce re-renders
      if (state.currentTick !== prev.currentTick) {
        if (!state.isPlaying) {
          setCurrentTick(state.currentTick)
        } else {
          // During playback, only update when tick changes by enough to matter visually
          const delta = Math.abs(state.currentTick - prev.currentTick)
          if (delta >= 10) setCurrentTick(state.currentTick)
        }
      }
    })
  }, [songStore])

  // Subscribe to visible instruments changes from store
  useEffect(() => {
    if (!songStore) return

    setVisibleInstruments(new Set(songStore.getState().visibleInstruments))

    return songStore.subscribe((state, prev) => {
      if (state.visibleInstruments !== prev.visibleInstruments) {
        setVisibleInstruments(new Set(state.visibleInstruments))
      }
    })
  }, [songStore])

  // Subscribe to active difficulty changes from store
  useEffect(() => {
    if (!songStore) return

    setActiveDifficulty(songStore.getState().activeDifficulty)

    return songStore.subscribe((state, prev) => {
      if (state.activeDifficulty !== prev.activeDifficulty) {
        setActiveDifficulty(state.activeDifficulty)
      }
    })
  }, [songStore])

  // Auto-scroll to first note when notes load for a new song
  const hasAutoScrolledRef = useRef<string | null>(null)
  useEffect(() => {
    if (!activeSongId || notes.length === 0 || isPlaying) return
    if (hasAutoScrolledRef.current === activeSongId) return
    const pixelsPerTick = MIDI_EDITOR_CONFIG.pixelsPerTick * zoomLevel
    let minTick = Infinity
    for (const note of notes) {
      if (note.difficulty === activeDifficulty && note.tick < minTick) {
        minTick = note.tick
      }
    }
    if (minTick === Infinity) return
    const firstNoteX = minTick * pixelsPerTick
    // Only auto-scroll if first note is off-screen
    if (firstNoteX > dimensions.width) {
      setScrollX(Math.max(0, firstNoteX - dimensions.width / 6))
    }
    hasAutoScrolledRef.current = activeSongId
  }, [activeSongId, notes, activeDifficulty, zoomLevel, dimensions.width, isPlaying])

  // Derive effective scrollX: during playback, compute directly from currentTick
  // to avoid double re-render (tick change → effect → setScrollX → second render)
  const effectiveScrollX = useMemo(() => {
    if (isPlaying && !isUserScrolling.current) {
      // During playback: keep playhead at ~1/3 from left
      const pixelsPerTick = MIDI_EDITOR_CONFIG.pixelsPerTick * zoomLevel
      const playheadX = currentTick * pixelsPerTick
      return Math.max(0, playheadX - dimensions.width / 3)
    }
    return scrollX
  }, [isPlaying, currentTick, scrollX, zoomLevel, dimensions.width])

  // When pausing, persist the current auto-scroll position so the view does not snap back.
  const prevIsPlayingRef = useRef(isPlaying)
  useEffect(() => {
    if (prevIsPlayingRef.current && !isPlaying && !isUserScrolling.current) {
      const pixelsPerTick = MIDI_EDITOR_CONFIG.pixelsPerTick * zoomLevel
      const playheadX = currentTick * pixelsPerTick
      setScrollX(Math.max(0, playheadX - dimensions.width / 3))
    }
    prevIsPlayingRef.current = isPlaying
  }, [currentTick, isPlaying, zoomLevel, dimensions.width])

  // Get lanes for each instrument
  const getLanesForInstrument = useCallback((instrument: Instrument) => {
    if (instrument === 'drums') return MIDI_EDITOR_CONFIG.drumLanes
    if (instrument === 'vocals') return VOCAL_PITCH_LANES
    if (instrument === 'proKeys') return PRO_KEYS_PITCH_LANES
    if (instrument === 'proGuitar' || instrument === 'proBass') return MIDI_EDITOR_CONFIG.proGuitarLanes
    return MIDI_EDITOR_CONFIG.guitarLanes
  }, [])

  // Filter instruments to only visible ones
  const displayedInstruments = useMemo(() => {
    return MIDI_EDITOR_CONFIG.instruments.filter(inst => visibleInstruments.has(inst))
  }, [visibleInstruments])

  // Calculate total height for visible instruments
  const getRowHeight = useCallback((inst: Instrument) => {
    if (inst === 'vocals') return MIDI_EDITOR_CONFIG.vocalRowHeight
    if (inst === 'proKeys') return MIDI_EDITOR_CONFIG.proKeysRowHeight
    return MIDI_EDITOR_CONFIG.rowHeight
  }, [])

  const totalHeight = useMemo(() => {
    return displayedInstruments.reduce((total, inst) => {
      const lanes = getLanesForInstrument(inst)
      const rh = getRowHeight(inst)
      return total + MIDI_EDITOR_CONFIG.instrumentHeaderHeight + MIDI_EDITOR_CONFIG.spRowHeight * 2 + lanes.length * rh
    }, 0)
  }, [displayedInstruments, getLanesForInstrument, getRowHeight])

  // Filter notes for current difficulty
  const filteredNotes = useMemo(() => {
    const result = notes.filter(
      (note) => note.difficulty === activeDifficulty
    )
    if (notes.length > 0 && result.length === 0) {
      const diffs = new Set(notes.map(n => n.difficulty))
      console.warn(`[MidiEditor] 0/${notes.length} notes match difficulty '${activeDifficulty}'. Available: ${[...diffs].join(',')}`)
    }
    return result
  }, [notes, activeDifficulty])

  // Pre-group notes by instrument so each piano roll gets a stable array reference
  const notesByInstrument = useMemo(() => {
    const map = new Map<Instrument, Note[]>()
    for (const note of filteredNotes) {
      let arr = map.get(note.instrument)
      if (!arr) { arr = []; map.set(note.instrument, arr) }
      arr.push(note)
    }
    return map
  }, [filteredNotes])

  // Handle resize
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        // Use full width minus header, ensure minimum width
        const gridWidth = Math.max(100, width - MIDI_EDITOR_CONFIG.headerWidth)
        setDimensions({ width: gridWidth, height })
      }
    })

    resizeObserver.observe(container)
    return () => resizeObserver.disconnect()
  }, [])

  // Handle scroll on notes area - vertical scroll + horizontal scroll
  const handleNotesScroll = useCallback((e: React.WheelEvent) => {
    e.stopPropagation()
    e.preventDefault()
    
    if (e.ctrlKey || e.metaKey) {
      // Zoom
      const delta = e.deltaY > 0 ? 0.9 : 1.1
      setZoomLevel((prev) => Math.max(0.1, Math.min(5, prev * delta)))
    } else if (e.shiftKey) {
      // Shift+scroll = horizontal scroll (timeline)
      isUserScrolling.current = true
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current)
      const hDelta = e.deltaX + e.deltaY
      setScrollX((prev) => {
        const newScrollX = Math.max(0, prev + hDelta)
        if (songStore && !songStore.getState().isPlaying) {
          const pixelsPerTick = MIDI_EDITOR_CONFIG.pixelsPerTick * zoomLevel
          const newTick = Math.round(newScrollX / pixelsPerTick)
          songStore.getState().setCurrentTick(newTick)
        }
        return newScrollX
      })
      
      scrollTimeoutRef.current = setTimeout(() => {
        isUserScrolling.current = false
      }, 200)
    } else {
      // Default: deltaY = vertical, deltaX = horizontal
      const maxScrollY = Math.max(0, totalHeight - dimensions.height + 50)
      setScrollY((prev) => Math.max(0, Math.min(maxScrollY, prev + e.deltaY)))
      
      if (Math.abs(e.deltaX) > 0) {
        isUserScrolling.current = true
        if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current)
        const hDelta = e.deltaX
        setScrollX((prev) => {
          const newScrollX = Math.max(0, prev + hDelta)
          if (songStore && !songStore.getState().isPlaying) {
            const pixelsPerTick = MIDI_EDITOR_CONFIG.pixelsPerTick * zoomLevel
            const newTick = Math.round(newScrollX / pixelsPerTick)
            songStore.getState().setCurrentTick(newTick)
          }
          return newScrollX
        })
        
        scrollTimeoutRef.current = setTimeout(() => {
          isUserScrolling.current = false
        }, 200)
      }
    }
  }, [songStore, zoomLevel, totalHeight, dimensions.height])

  // Handle scroll on lane headers - vertical scroll
  const handleHeaderScroll = useCallback((e: React.WheelEvent) => {
    e.stopPropagation()
    e.preventDefault()
    
    // Vertical scroll - ensure max is at least 0
    const maxScroll = Math.max(0, totalHeight - dimensions.height + 50)
    setScrollY((prev) => Math.max(0, Math.min(maxScroll, prev + e.deltaY)))
  }, [totalHeight, dimensions.height])

  // Handle scroll on editor area (fallback)
  const handleScroll = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // Zoom
      const delta = e.deltaY > 0 ? 0.9 : 1.1
      setZoomLevel((prev) => prev * delta)
    } else if (e.shiftKey) {
      // Shift+scroll = horizontal scroll (timeline)
      isUserScrolling.current = true
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current)
      const hDelta = e.deltaX + e.deltaY
      setScrollX((prev) => {
        const newScrollX = Math.max(0, prev + hDelta)
        if (songStore && !songStore.getState().isPlaying) {
          const pixelsPerTick = MIDI_EDITOR_CONFIG.pixelsPerTick * zoomLevel
          const newTick = Math.round(newScrollX / pixelsPerTick)
          songStore.getState().setCurrentTick(newTick)
        }
        return newScrollX
      })
      
      scrollTimeoutRef.current = setTimeout(() => {
        isUserScrolling.current = false
      }, 200)
    } else {
      // Default: deltaY = vertical, deltaX = horizontal
      const maxScroll = Math.max(0, totalHeight - dimensions.height + 50)
      setScrollY((prev) => Math.max(0, Math.min(maxScroll, prev + e.deltaY)))
      
      if (Math.abs(e.deltaX) > 0) {
        isUserScrolling.current = true
        if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current)
        const hDelta = e.deltaX
        setScrollX((prev) => {
          const newScrollX = Math.max(0, prev + hDelta)
          if (songStore && !songStore.getState().isPlaying) {
            const pixelsPerTick = MIDI_EDITOR_CONFIG.pixelsPerTick * zoomLevel
            const newTick = Math.round(newScrollX / pixelsPerTick)
            songStore.getState().setCurrentTick(newTick)
          }
          return newScrollX
        })
        
        scrollTimeoutRef.current = setTimeout(() => {
          isUserScrolling.current = false
        }, 200)
      }
    }
  }, [songStore, zoomLevel, totalHeight, dimensions.height])

  // Handle note click - tool-aware, supports flag toggling with modifier toggles
  const handleNoteClick = useCallback(
    (noteId: string, modifiers: { ctrl: boolean; shift: boolean; alt: boolean }) => {
      if (!songStore) return
      const tool = useUIStore.getState().editTool

      // Check if this is a vocal note
      const isVocalNote = (songStore.getState().song.vocalNotes || []).some((n) => n.id === noteId)

      if (tool === 'erase') {
        if (isVocalNote) {
          songStore.getState().deleteVocalNote(noteId)
        } else {
          songStore.getState().deleteNote(noteId)
        }
        return
      }

      if (isVocalNote) {
        // Vocal note click: select/multi-select
        songStore.getState().selectVocalNote(noteId, modifiers.ctrl)
        return
      }

      // Read sticky toggles from UIStore
      const mods = useUIStore.getState().noteModifiers
      if (mods.cymbalOrTap || mods.ghostOrHopo || mods.accent) {
        const note = songStore.getState().song.notes.find((n) => n.id === noteId)
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
          songStore.getState().updateNote(noteId, { flags: newFlags })
          return
        }
      }
      // Normal click: select (ctrl for multi-select)
      songStore.getState().selectNote(noteId, modifiers.ctrl)
    },
    [songStore]
  )

  // Handle note move
  const handleNoteMove = useCallback(
    (noteId: string, newTick: number, newLane: string) => {
      if (songStore) {
        songStore.getState().updateNote(noteId, {
          tick: newTick,
          lane: newLane as DrumLane | GuitarLane
        })
      }
    },
    [songStore]
  )

  // Drag state for sustain drawing, box-select, and erase sweeping
  const gridDragRef = useRef<{
    mode: 'sustain' | 'select' | 'sp-extend' | 'solo-extend' | 'erase' | 'move' | 'resize-sustain'
    startTick: number
    startX: number
    startY?: number
    noteId?: string
    instrument: Instrument
    rect: DOMRect
    lanes: string[]
    erasedIds?: Set<string>
    lastEraseTick?: number
    moveOriginals?: { id: string; tick: number; lane: string | number }[]
    preMoveSnapshot?: unknown
    resizeOriginalDuration?: number
  } | null>(null)

  // Selection box visual state (tracks which instrument the drag is on)
  const [selectionBox, setSelectionBox] = useState<{ x: number; y: number; w: number; h: number; instrument: Instrument } | null>(null)

  // Handle mousedown on grid - tool-aware, starts drag
  const handleGridMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, instrument: Instrument, lanes: string[]) => {
      if (!songStore) return
      const tool = useUIStore.getState().editTool

      const rect = e.currentTarget.getBoundingClientRect()
      const x = e.clientX - rect.left + effectiveScrollX
      const y = e.clientY - rect.top

      const pixelsPerTick = MIDI_EDITOR_CONFIG.pixelsPerTick * zoomLevel
      const clickTick = x / pixelsPerTick
      const tick = snapToGrid(clickTick, snapDivision, 480)
      const laneIndex = Math.floor(y / MIDI_EDITOR_CONFIG.rowHeight)
      const lane = lanes[laneIndex]

      if (tool === 'select') {
        // Check if clicking on an already-selected note — start move instead of box-select
        const selectedIds = new Set(songStore.getState().selectedNoteIds)
        if (selectedIds.size > 0 && lane) {
          // Use generous hit padding so short notes are easy to grab
          const hitPadTicks = Math.max(240, 480 / snapDivision)
          const hitNote = songStore.getState().song.notes.find(
            (n) =>
              selectedIds.has(n.id) &&
              n.instrument === instrument &&
              n.difficulty === activeDifficulty &&
              String(n.lane) === lane &&
              clickTick >= n.tick - hitPadTicks && clickTick <= n.tick + n.duration + hitPadTicks
          )
          if (hitNote) {
            const originals = songStore.getState().song.notes
              .filter((n) => selectedIds.has(n.id))
              .map((n) => ({ id: n.id, tick: n.tick, lane: n.lane as string | number }))
            const snapshot = songStore.getState().song
            songStore.temporal.getState().pause()
            gridDragRef.current = {
              mode: 'move',
              startTick: clickTick,
              startX: e.clientX - rect.left,
              startY: y,
              instrument,
              rect,
              lanes,
              moveOriginals: originals,
              preMoveSnapshot: snapshot
            }
            return
          }
        }
        // Start box-select drag
        songStore.getState().clearSelection()
        gridDragRef.current = {
          mode: 'select',
          startTick: clickTick,
          startX: e.clientX - rect.left,
          instrument,
          rect,
          lanes
        }
        setSelectionBox(null)
        return
      }

      if (tool === 'erase') {
        const erasedIds = new Set<string>()
        if (lane) {
          const snapTicks = 480 / snapDivision
          const target = songStore.getState().song.notes.find(
            (n) =>
              n.instrument === instrument &&
              n.difficulty === activeDifficulty &&
              String(n.lane) === lane &&
              Math.abs(n.tick - clickTick) <= snapTicks / 2
          )
          if (target) {
            songStore.getState().deleteNote(target.id)
            erasedIds.add(target.id)
          }
        }
        // Start erase drag
        gridDragRef.current = {
          mode: 'erase',
          startTick: clickTick,
          startX: e.clientX - rect.left,
          instrument,
          rect,
          lanes,
          erasedIds
        }
        return
      }

      // Place tool: add a note, start sustain drag for non-drums
      if (lane && tick >= 0 && laneIndex >= 0 && laneIndex < lanes.length) {
        const mods = useUIStore.getState().noteModifiers

        // Star Power placement mode
        if (mods.starPower) {
          songStore.getState().addStarPowerPhrase({
            tick,
            duration: 480,
            instrument
          })
          const latest = songStore.getState().song.starPowerPhrases
          const created = latest[latest.length - 1]
          if (created) {
            songStore.getState().selectStarPowerPhrase(created.id)
            gridDragRef.current = {
              mode: 'sp-extend',
              startTick: tick,
              startX: e.clientX - rect.left,
              noteId: created.id,
              instrument,
              rect,
              lanes
            }
          }
          return
        }

        // Solo section placement mode
        if (mods.solo) {
          songStore.getState().addSoloSection({
            tick,
            duration: 480,
            instrument
          })
          const latest = songStore.getState().song.soloSections
          const created = latest[latest.length - 1]
          if (created) {
            songStore.getState().selectSoloSection(created.id)
            gridDragRef.current = {
              mode: 'solo-extend',
              startTick: tick,
              startX: e.clientX - rect.left,
              noteId: created.id,
              instrument,
              rect,
              lanes
            }
          }
          return
        }

        const flags = buildNoteFlags(instrument, mods)
        // Open/kick toggle overrides the lane
        let finalLane: string = lane
        if (mods.openOrKick) {
          if (instrument === 'drums') finalLane = 'kick'
          else finalLane = 'open'
        }
        const isProGtr = instrument === 'proGuitar' || instrument === 'proBass'
        songStore.getState().addNote({
          tick,
          duration: instrument === 'drums' ? 0 : 0, // Start at 0, drag extends
          instrument,
          difficulty: activeDifficulty,
          lane: finalLane as DrumLane | GuitarLane,
          velocity: 100,
          ...(flags ? { flags } : {}),
          ...(isProGtr ? { string: parseInt(finalLane, 10) as 1|2|3|4|5|6, fret: 0 } : {})
        })
        // Start sustain drag for non-drum instruments
        if (instrument !== 'drums') {
          const newNotes = songStore.getState().song.notes
          const placed = newNotes[newNotes.length - 1]
          if (placed) {
            gridDragRef.current = {
              mode: 'sustain',
              startTick: tick,
              startX: e.clientX - rect.left,
              noteId: placed.id,
              instrument,
              rect,
              lanes
            }
          }
        }
      }
    },
    [songStore, snapDivision, activeDifficulty, effectiveScrollX, zoomLevel]
  )

  // Handle sustain right-edge resize drag (initiated from Notes canvas)
  const handleSustainResize = useCallback(
    (noteId: string, e: React.MouseEvent, instrument: Instrument, lanes: string[]) => {
      if (!songStore) return
      const note = songStore.getState().song.notes.find((n) => n.id === noteId)
      if (!note) return
      const rect = (e.target as HTMLElement).closest('.midi-grid-area')?.getBoundingClientRect()
      if (!rect) return
      gridDragRef.current = {
        mode: 'resize-sustain',
        startTick: note.tick,
        startX: e.clientX - rect.left,
        noteId,
        instrument,
        rect,
        lanes,
        resizeOriginalDuration: note.duration
      }
    },
    [songStore]
  )

  // Handle mousedown on vocal grid - pitch-based note placement
  const handleVocalGridMouseDown = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (!songStore) return
      const tool = useUIStore.getState().editTool

      const rect = e.currentTarget.getBoundingClientRect()
      const x = e.clientX - rect.left + effectiveScrollX
      const y = e.clientY - rect.top

      const pixelsPerTick = MIDI_EDITOR_CONFIG.pixelsPerTick * zoomLevel
      const clickTick = x / pixelsPerTick
      const tick = snapToGrid(clickTick, snapDivision, 480)
      const vocalRowH = MIDI_EDITOR_CONFIG.vocalRowHeight
      const pitchIdx = Math.floor(y / vocalRowH)
      const pitch = MIDI_EDITOR_CONFIG.vocalPitchMax - pitchIdx

      if (pitch < MIDI_EDITOR_CONFIG.vocalPitchMin || pitch > MIDI_EDITOR_CONFIG.vocalPitchMax) return

      if (tool === 'select') {
        // Check if clicking on an already-selected vocal note — start move
        const selectedIds = new Set(songStore.getState().selectedVocalNoteIds || [])
        if (selectedIds.size > 0) {
          const hp = songStore.getState().activeHarmonyPart
          // Use generous hit padding so short notes are easy to grab
          const hitPadTicks = Math.max(240, 480 / snapDivision)
          const hitNote = (songStore.getState().song.vocalNotes || []).find(
            (n) =>
              selectedIds.has(n.id) &&
              n.harmonyPart === hp &&
              typeof n.lane === 'number' && Math.abs(n.lane - pitch) <= 1 &&
              clickTick >= n.tick - hitPadTicks && clickTick <= n.tick + n.duration + hitPadTicks
          )
          if (hitNote) {
            const originals = (songStore.getState().song.vocalNotes || [])
              .filter((n) => selectedIds.has(n.id))
              .map((n) => ({ id: n.id, tick: n.tick, lane: n.lane as string | number }))
            const snapshot = songStore.getState().song
            songStore.temporal.getState().pause()
            gridDragRef.current = {
              mode: 'move',
              startTick: clickTick,
              startX: e.clientX - rect.left,
              startY: y,
              instrument: 'vocals',
              rect,
              lanes: [],
              moveOriginals: originals,
              preMoveSnapshot: snapshot
            }
            return
          }
        }
        // Start box-select drag for vocal notes
        songStore.getState().clearVocalSelection()
        gridDragRef.current = {
          mode: 'select',
          startTick: clickTick,
          startX: e.clientX - rect.left,
          instrument: 'vocals',
          rect,
          lanes: []
        }
        setSelectionBox(null)
        return
      }

      if (tool === 'erase') {
        const erasedIds = new Set<string>()
        const snapTicks = 480 / snapDivision
        const target = (songStore.getState().song.vocalNotes || []).find(
          (n) =>
            n.harmonyPart === songStore.getState().activeHarmonyPart &&
            typeof n.lane === 'number' && n.lane === pitch &&
            Math.abs(n.tick - clickTick) <= snapTicks / 2
        )
        if (target) {
          songStore.getState().deleteVocalNote(target.id)
          erasedIds.add(target.id)
        }
        // Start erase drag
        gridDragRef.current = {
          mode: 'erase',
          startTick: clickTick,
          startX: e.clientX - rect.left,
          instrument: 'vocals',
          rect,
          lanes: [],
          erasedIds
        }
        return
      }

      // Place tool: add vocal note at pitch
      if (tick >= 0) {
        const harmonyPart = songStore.getState().activeHarmonyPart
        // Track existing IDs before adding (addVocalNote sorts, so last element won't be the new one)
        const prevIds = new Set((songStore.getState().song.vocalNotes || []).map((n) => n.id))
        songStore.getState().addVocalNote({
          tick,
          duration: 480 / snapDivision,
          instrument: 'vocals',
          difficulty: 'expert',
          lane: pitch,
          velocity: 100,
          harmonyPart,
          lyric: '',
          isSlide: false,
          isPercussion: false,
          isPitchless: false
        })

        // Play pitch preview so charter can hear the note
        playPitchPreview(pitch)

        // Start sustain drag - find the newly added note by ID diff (array is sorted)
        const newNotes = songStore.getState().song.vocalNotes
        const placed = newNotes.find((n) => !prevIds.has(n.id))
        if (placed) {
          gridDragRef.current = {
            mode: 'sustain',
            startTick: tick,
            startX: e.clientX - rect.left,
            noteId: placed.id,
            instrument: 'vocals',
            rect,
            lanes: []
          }
        }
      }
    },
    [songStore, snapDivision, effectiveScrollX, zoomLevel]
  )

  // Handle mousedown on Pro Keys grid - pitch-based note placement (like vocals but regular notes)
  const handleProKeysGridMouseDown = useCallback(
    (e: React.MouseEvent<HTMLElement>, instrument: Instrument) => {
      if (!songStore) return
      const tool = useUIStore.getState().editTool

      const rect = e.currentTarget.getBoundingClientRect()
      const x = e.clientX - rect.left + effectiveScrollX
      const y = e.clientY - rect.top

      const pixelsPerTick = MIDI_EDITOR_CONFIG.pixelsPerTick * zoomLevel
      const clickTick = x / pixelsPerTick
      const tick = snapToGrid(clickTick, snapDivision, 480)
      const proKeysRowH = MIDI_EDITOR_CONFIG.proKeysRowHeight
      const pitchIdx = Math.floor(y / proKeysRowH)
      const pitch = MIDI_EDITOR_CONFIG.proKeysPitchMax - pitchIdx

      if (pitch < MIDI_EDITOR_CONFIG.proKeysPitchMin || pitch > MIDI_EDITOR_CONFIG.proKeysPitchMax) return

      if (tool === 'select') {
        // Check if clicking on an already-selected proKeys note — start move
        const selectedIds = new Set(songStore.getState().selectedNoteIds)
        if (selectedIds.size > 0) {
          // Use generous hit padding so short notes are easy to grab
          const hitPadTicks = Math.max(240, 480 / snapDivision)
          const hitNote = songStore.getState().song.notes.find(
            (n) =>
              selectedIds.has(n.id) &&
              n.instrument === instrument &&
              n.difficulty === activeDifficulty &&
              typeof n.lane === 'number' && Math.abs(n.lane - pitch) <= 1 &&
              clickTick >= n.tick - hitPadTicks && clickTick <= n.tick + n.duration + hitPadTicks
          )
          if (hitNote) {
            const originals = songStore.getState().song.notes
              .filter((n) => selectedIds.has(n.id))
              .map((n) => ({ id: n.id, tick: n.tick, lane: n.lane as string | number }))
            const snapshot = songStore.getState().song
            songStore.temporal.getState().pause()
            gridDragRef.current = {
              mode: 'move',
              startTick: clickTick,
              startX: e.clientX - rect.left,
              startY: y,
              instrument,
              rect,
              lanes: [],
              moveOriginals: originals,
              preMoveSnapshot: snapshot
            }
            return
          }
        }
        songStore.getState().clearSelection()
        gridDragRef.current = {
          mode: 'select',
          startTick: clickTick,
          startX: e.clientX - rect.left,
          instrument,
          rect,
          lanes: []
        }
        setSelectionBox(null)
        return
      }

      if (tool === 'erase') {
        const erasedIds = new Set<string>()
        const snapTicks = 480 / snapDivision
        const target = songStore.getState().song.notes.find(
          (n) =>
            n.instrument === instrument &&
            n.difficulty === activeDifficulty &&
            typeof n.lane === 'number' && n.lane === pitch &&
            Math.abs(n.tick - clickTick) <= snapTicks / 2
        )
        if (target) {
          songStore.getState().deleteNote(target.id)
          erasedIds.add(target.id)
        }
        gridDragRef.current = {
          mode: 'erase',
          startTick: clickTick,
          startX: e.clientX - rect.left,
          instrument,
          rect,
          lanes: [],
          erasedIds
        }
        return
      }

      // Place tool: add pro keys note at pitch
      if (tick >= 0) {
        const mods = useUIStore.getState().noteModifiers

        // Star Power placement mode
        if (mods.starPower) {
          songStore.getState().addStarPowerPhrase({ tick, duration: 480, instrument })
          const latest = songStore.getState().song.starPowerPhrases
          const created = latest[latest.length - 1]
          if (created) {
            songStore.getState().selectStarPowerPhrase(created.id)
            gridDragRef.current = {
              mode: 'sp-extend', startTick: tick, startX: e.clientX - rect.left,
              noteId: created.id, instrument, rect, lanes: []
            }
          }
          return
        }

        // Solo section placement mode
        if (mods.solo) {
          songStore.getState().addSoloSection({ tick, duration: 480, instrument })
          const latest = songStore.getState().song.soloSections
          const created = latest[latest.length - 1]
          if (created) {
            songStore.getState().selectSoloSection(created.id)
            gridDragRef.current = {
              mode: 'solo-extend', startTick: tick, startX: e.clientX - rect.left,
              noteId: created.id, instrument, rect, lanes: []
            }
          }
          return
        }

        const prevIds = new Set(songStore.getState().song.notes.map((n) => n.id))
        songStore.getState().addNote({
          tick,
          duration: 480 / snapDivision,
          instrument,
          difficulty: activeDifficulty,
          lane: pitch,
          velocity: 100
        })

        // Play pitch preview so charter can hear the note
        playPitchPreview(pitch)

        // Start sustain drag
        const newNotes = songStore.getState().song.notes
        const placed = newNotes.find((n) => !prevIds.has(n.id))
        if (placed) {
          gridDragRef.current = {
            mode: 'sustain',
            startTick: tick,
            startX: e.clientX - rect.left,
            noteId: placed.id,
            instrument,
            rect,
            lanes: []
          }
        }
      }
    },
    [songStore, snapDivision, activeDifficulty, effectiveScrollX, zoomLevel]
  )

  // Global mousemove/mouseup for grid drag operations
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent): void => {
      if (!gridDragRef.current || !songStore) return
      const drag = gridDragRef.current
      const pixelsPerTick = MIDI_EDITOR_CONFIG.pixelsPerTick * zoomLevel
      const currentX = e.clientX - drag.rect.left + effectiveScrollX
      const currentTick = currentX / pixelsPerTick

      if (drag.mode === 'sustain' && drag.noteId) {
        const snappedTick = snapToGrid(currentTick, snapDivision, 480)
        const duration = Math.max(0, snappedTick - drag.startTick)
        if (drag.instrument === 'vocals') {
          songStore.getState().updateVocalNote(drag.noteId, { duration })
        } else {
          songStore.getState().updateNote(drag.noteId, { duration })
        }
      } else if (drag.mode === 'resize-sustain' && drag.noteId) {
        const snappedTick = snapToGrid(currentTick, snapDivision, 480)
        const duration = Math.max(0, snappedTick - drag.startTick)
        songStore.getState().updateNote(drag.noteId, { duration })
      } else if (drag.mode === 'select') {
        const startTick = Math.min(drag.startTick, currentTick)
        const endTick = Math.max(drag.startTick, currentTick)
        if (drag.instrument === 'vocals') {
          songStore.getState().selectAllVocalInRange(startTick, endTick)
        } else {
          songStore.getState().selectAllInRange(startTick, endTick, drag.instrument)
        }

        // Update visual selection box
        const x1 = Math.min(drag.startX, e.clientX - drag.rect.left)
        const x2 = Math.max(drag.startX, e.clientX - drag.rect.left)
        const totalH = drag.instrument === 'vocals'
          ? (MIDI_EDITOR_CONFIG.vocalPitchMax - MIDI_EDITOR_CONFIG.vocalPitchMin + 1) * MIDI_EDITOR_CONFIG.vocalRowHeight
          : drag.instrument === 'proKeys'
          ? (MIDI_EDITOR_CONFIG.proKeysPitchMax - MIDI_EDITOR_CONFIG.proKeysPitchMin + 1) * MIDI_EDITOR_CONFIG.proKeysRowHeight
          : drag.lanes.length * MIDI_EDITOR_CONFIG.rowHeight
        setSelectionBox({ x: x1, y: 0, w: x2 - x1, h: totalH, instrument: drag.instrument })
      } else if (drag.mode === 'erase') {
        const erased = drag.erasedIds || new Set<string>()
        const prevTick = drag.lastEraseTick ?? drag.startTick
        const sweepMin = Math.min(prevTick, currentTick)
        const sweepMax = Math.max(prevTick, currentTick)
        drag.lastEraseTick = currentTick

        if (drag.instrument === 'vocals') {
          const state = songStore.getState()
          // Delete any vocal note whose range overlaps the sweep and whose pitch lane overlaps the cursor
          const y = e.clientY - drag.rect.top
          const vocalRowH = MIDI_EDITOR_CONFIG.vocalRowHeight
          const pitchIdx = Math.floor(y / vocalRowH)
          const pitch = MIDI_EDITOR_CONFIG.vocalPitchMax - pitchIdx
          const toDelete = (state.song.vocalNotes || []).filter(
            (n) =>
              !erased.has(n.id) &&
              n.harmonyPart === state.activeHarmonyPart &&
              typeof n.lane === 'number' && n.lane === pitch &&
              n.tick + n.duration >= sweepMin &&
              n.tick <= sweepMax
          )
          for (const n of toDelete) {
            state.deleteVocalNote(n.id)
            erased.add(n.id)
          }
        } else {
          const y = e.clientY - drag.rect.top
          const isProKeysInst = drag.instrument === 'proKeys'
          if (isProKeysInst) {
            // Pro keys: pitch-based erase (like vocals but regular notes)
            const proKeysRowH = MIDI_EDITOR_CONFIG.proKeysRowHeight
            const pitchIdx = Math.floor(y / proKeysRowH)
            const pitch = MIDI_EDITOR_CONFIG.proKeysPitchMax - pitchIdx
            const state = songStore.getState()
            const toDelete = state.song.notes.filter(
              (n) =>
                !erased.has(n.id) &&
                n.instrument === drag.instrument &&
                n.difficulty === state.activeDifficulty &&
                typeof n.lane === 'number' && n.lane === pitch &&
                n.tick + n.duration >= sweepMin &&
                n.tick <= sweepMax
            )
            for (const n of toDelete) {
              state.deleteNote(n.id)
              erased.add(n.id)
            }
          } else {
            const laneIndex = Math.floor(y / MIDI_EDITOR_CONFIG.rowHeight)
            const lane = drag.lanes[laneIndex]
            if (lane) {
              const state = songStore.getState()
              const toDelete = state.song.notes.filter(
                (n) =>
                  !erased.has(n.id) &&
                  n.instrument === drag.instrument &&
                  n.difficulty === state.activeDifficulty &&
                  String(n.lane) === lane &&
                  n.tick + n.duration >= sweepMin &&
                  n.tick <= sweepMax
              )
              for (const n of toDelete) {
                state.deleteNote(n.id)
                erased.add(n.id)
              }
            }
          }
        }
      } else if (drag.mode === 'sp-extend' && drag.noteId) {
        const snappedTick = snapToGrid(currentTick, snapDivision, 480)
        const duration = Math.max(480, snappedTick - drag.startTick)
        songStore.getState().updateStarPowerPhrase(drag.noteId, { duration })
      } else if (drag.mode === 'solo-extend' && drag.noteId) {
        const snappedTick = snapToGrid(currentTick, snapDivision, 480)
        const duration = Math.max(480, snappedTick - drag.startTick)
        songStore.getState().updateSoloSection(drag.noteId, { duration })
      } else if (drag.mode === 'move' && drag.moveOriginals) {
        const tickDelta = snapToGrid(currentTick - drag.startTick, snapDivision, 480)
        const y = e.clientY - drag.rect.top
        const startY = drag.startY ?? 0

        if (drag.instrument === 'vocals') {
          // Vocal: Move by tick and pitch
          const vocalRowH = MIDI_EDITOR_CONFIG.vocalRowHeight
          const pitchDelta = -Math.round((y - startY) / vocalRowH)
          const state = songStore.getState()
          for (const orig of drag.moveOriginals) {
            const newTick = Math.max(0, orig.tick + tickDelta)
            const origPitch = typeof orig.lane === 'number' ? orig.lane : 60
            const newPitch = Math.max(MIDI_EDITOR_CONFIG.vocalPitchMin,
              Math.min(MIDI_EDITOR_CONFIG.vocalPitchMax, origPitch + pitchDelta))
            state.updateVocalNote(orig.id, { tick: newTick, lane: newPitch as unknown as VocalNote['lane'] })
          }
          // Preview the pitch of the first moved note
          if (drag.moveOriginals.length > 0) {
            const origPitch = typeof drag.moveOriginals[0].lane === 'number' ? drag.moveOriginals[0].lane : 60
            const newPitch = Math.max(MIDI_EDITOR_CONFIG.vocalPitchMin,
              Math.min(MIDI_EDITOR_CONFIG.vocalPitchMax, origPitch + pitchDelta))
            playPitchPreview(newPitch)
          }
        } else if (drag.instrument === 'proKeys') {
          // Pro Keys: Move by tick and pitch
          const proKeysRowH = MIDI_EDITOR_CONFIG.proKeysRowHeight
          const pitchDelta = -Math.round((y - startY) / proKeysRowH)
          const state = songStore.getState()
          for (const orig of drag.moveOriginals) {
            const newTick = Math.max(0, orig.tick + tickDelta)
            const origPitch = typeof orig.lane === 'number' ? orig.lane : 48
            const newPitch = Math.max(MIDI_EDITOR_CONFIG.proKeysPitchMin,
              Math.min(MIDI_EDITOR_CONFIG.proKeysPitchMax, origPitch + pitchDelta))
            state.updateNote(orig.id, { tick: newTick, lane: newPitch as unknown as Note['lane'] })
          }
          // Preview the pitch of the first moved note
          if (drag.moveOriginals.length > 0) {
            const origPitch = typeof drag.moveOriginals[0].lane === 'number' ? drag.moveOriginals[0].lane : 48
            const newPitch = Math.max(MIDI_EDITOR_CONFIG.proKeysPitchMin,
              Math.min(MIDI_EDITOR_CONFIG.proKeysPitchMax, origPitch + pitchDelta))
            playPitchPreview(newPitch)
          }
        } else {
          // Lane-based instruments: Move by tick and lane
          const rowH = MIDI_EDITOR_CONFIG.rowHeight
          const laneDelta = Math.round((y - startY) / rowH)
          const state = songStore.getState()
          for (const orig of drag.moveOriginals) {
            const newTick = Math.max(0, orig.tick + tickDelta)
            const origLaneIdx = drag.lanes.indexOf(String(orig.lane))
            if (origLaneIdx >= 0) {
              const newLaneIdx = Math.max(0, Math.min(drag.lanes.length - 1, origLaneIdx + laneDelta))
              state.updateNote(orig.id, { tick: newTick, lane: drag.lanes[newLaneIdx] as Note['lane'] })
            }
          }
        }
      }
    }

    const handleMouseUp = (): void => {
      if (gridDragRef.current) {
        // Stop any pitch preview tone
        stopPitchPreview()

        // If sustain drag gave 0 duration, keep as strum for lane-based instruments; default for vocals
        if (gridDragRef.current.mode === 'sustain' && gridDragRef.current.noteId && songStore) {
          if (gridDragRef.current.instrument === 'vocals') {
            const note = (songStore.getState().song.vocalNotes || []).find((n) => n.id === gridDragRef.current!.noteId)
            if (note && note.duration === 0) {
              songStore.getState().updateVocalNote(note.id, { duration: 480 / snapDivision })
            }
          }
          // For guitar/bass/keys: duration 0 = strum, which is the correct default
        }
        // Commit move as a single undo entry
        if (gridDragRef.current.mode === 'move' && gridDragRef.current.preMoveSnapshot && songStore) {
          const finalSong = songStore.getState().song
          // Restore pre-move state (still paused, not tracked)
          songStore.setState({ song: gridDragRef.current.preMoveSnapshot as typeof finalSong })
          // Resume temporal tracking
          songStore.temporal.getState().resume()
          // Apply final state as a single tracked entry
          songStore.setState({ song: finalSong, isDirty: true })
        }
        gridDragRef.current = null
        setSelectionBox(null)
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [songStore, zoomLevel, effectiveScrollX, snapDivision])

  if (!activeSongId || !songStore) {
    return (
      <div className="midi-editor">
        <div className="empty-state">
          <div className="empty-state-icon">🎹</div>
          <div className="empty-state-title">No Song Selected</div>
          <div className="empty-state-description">
            Select a song to edit its notes in the piano roll
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="midi-editor" ref={containerRef}>
      {/* Toolbar */}
      <div className="midi-toolbar">
        <MidiEditToolSelector />
        <NoteModifierToggles />
        <SnapSelector
          value={snapDivision}
          onChange={(v) => {
            songStore?.getState().setSnapDivision(v)
            useSettingsStore.getState().updateSettings({ snapDivision: v })
          }}
        />
        <div className="midi-zoom-controls">
          <label>Zoom:</label>
          <button onClick={() => setZoomLevel((z) => z * 0.8)}>-</button>
          <span>{Math.round(zoomLevel * 100)}%</span>
          <button onClick={() => setZoomLevel((z) => z * 1.25)}>+</button>
        </div>
        {/* Pro Guitar/Bass fret property editor — shown when pro notes are selected */}
        {(() => {
          if (!songStore || selectedNoteIds.length === 0) return null
          const selNotes = notes.filter((n) => selectedNoteIds.includes(n.id))
          const proNotes = selNotes.filter((n) => n.instrument === 'proGuitar' || n.instrument === 'proBass')
          if (proNotes.length === 0) return null
          const frets = proNotes.map((n) => n.fret ?? 0)
          const allSame = frets.every((f) => f === frets[0])
          return (
            <div className="midi-fret-editor" style={{
              display: 'flex', alignItems: 'center', gap: 4,
              marginLeft: 8, padding: '0 6px',
              border: '1px solid rgba(249,115,22,0.4)', borderRadius: 4,
              background: 'rgba(249,115,22,0.08)', fontSize: 11, color: '#F97316'
            }}>
              <span style={{ fontWeight: 600 }}>Fret:</span>
              <input
                type="number"
                min={0}
                max={22}
                value={allSame ? frets[0] : ''}
                placeholder={allSame ? undefined : '—'}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10)
                  if (isNaN(val)) return
                  const fret = Math.min(22, Math.max(0, val))
                  for (const n of proNotes) {
                    songStore.getState().updateNote(n.id, { fret })
                  }
                }}
                onKeyDown={(e) => e.stopPropagation()}
                style={{
                  width: 38, height: 20, fontSize: 12, fontWeight: 700,
                  color: '#fff', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(249,115,22,0.5)',
                  borderRadius: 3, textAlign: 'center', outline: 'none'
                }}
              />
              <span style={{ fontSize: 9, opacity: 0.6 }}>({proNotes.length})</span>
            </div>
          )
        })()}
        <div className="midi-scroll-hint">Notes: H-scroll | Headers: V-scroll | Ctrl+Scroll: Zoom</div>
        <MidiShortcutHelpButton />
      </div>

      {/* Playhead ruler */}
      <PlayheadRuler
        scrollX={effectiveScrollX}
        zoomLevel={zoomLevel}
        currentTick={currentTick}
        snapDivision={snapDivision}
        songStore={songStore}
        headerWidth={MIDI_EDITOR_CONFIG.headerWidth}
      />

      {/* Editor area with stacked instruments */}
      <div className="midi-editor-area" onWheel={handleScroll}>
        <div className="midi-instruments-container" style={{ transform: `translateY(-${scrollY}px)` }}>
          {displayedInstruments.map((instrument) => {
            const lanes = getLanesForInstrument(instrument)
            const isCollapsed = collapsedInstruments.has(instrument)
            const isVocal = instrument === 'vocals'
            const isProKeys = instrument === 'proKeys'
            const isProGuitar = instrument === 'proGuitar' || instrument === 'proBass'
            const isPitchBased = isVocal || isProKeys
            const laneRowHeight = getRowHeight(instrument)
            const noteAreaHeight = lanes.length * laneRowHeight
            const sectionHeight = isCollapsed
              ? MIDI_EDITOR_CONFIG.instrumentHeaderHeight
              : MIDI_EDITOR_CONFIG.instrumentHeaderHeight + MIDI_EDITOR_CONFIG.spRowHeight * 2 + noteAreaHeight
            const instrumentNotes = notesByInstrument.get(instrument) || []

            const toggleCollapse = (): void => {
              setCollapsedInstruments((prev) => {
                const next = new Set(prev)
                if (next.has(instrument)) next.delete(instrument)
                else next.add(instrument)
                return next
              })
            }

            return (
              <div key={instrument} className="midi-instrument-section" style={{ height: sectionHeight, flexDirection: 'column' }}>
                {/* Instrument name header - full width */}
                <div
                  className="midi-instrument-label"
                  style={{
                    height: MIDI_EDITOR_CONFIG.instrumentHeaderHeight,
                    backgroundColor: MIDI_EDITOR_CONFIG.instrumentColors[instrument],
                    cursor: 'pointer',
                    userSelect: 'none'
                  }}
                  onClick={toggleCollapse}
                >
                  <span style={{ marginRight: 6, fontSize: 9 }}>{isCollapsed ? '▶' : '▼'}</span>
                  {({ proKeys: 'Pro Keys', proGuitar: 'Pro Guitar', proBass: 'Pro Bass' } as Record<string, string>)[instrument] || instrument.charAt(0).toUpperCase() + instrument.slice(1)}
                </div>

                {!isCollapsed && (
                <>
                  {/* Star Power row: label + lane */}
                  <div style={{ display: 'flex', flexDirection: 'row', height: MIDI_EDITOR_CONFIG.spRowHeight }}>
                    <div
                      className="midi-lane-label"
                      style={{
                        width: MIDI_EDITOR_CONFIG.headerWidth,
                        height: MIDI_EDITOR_CONFIG.spRowHeight,
                        backgroundColor: 'rgba(0, 204, 255, 0.1)',
                        borderRight: '1px solid var(--border-color)',
                        flexShrink: 0
                      }}
                    >
                      <span className="midi-lane-color" style={{ backgroundColor: SP_COLOR }} />
                      <span className="midi-lane-name">Star Power</span>
                    </div>
                    <StarPowerLane
                      phrases={starPowerPhrases}
                      instrument={instrument}
                      scrollX={effectiveScrollX}
                      zoomLevel={zoomLevel}
                      width={Math.max(dimensions.width, 100)}
                      selectedSpId={selectedSpId}
                      songStore={songStore}
                      editTool={editTool}
                      snapDivision={snapDivision}
                    />
                  </div>

                  {/* Solo section row: label + lane */}
                  <div style={{ display: 'flex', flexDirection: 'row', height: MIDI_EDITOR_CONFIG.spRowHeight }}>
                    <div
                      className="midi-lane-label"
                      style={{
                        width: MIDI_EDITOR_CONFIG.headerWidth,
                        height: MIDI_EDITOR_CONFIG.spRowHeight,
                        backgroundColor: 'rgba(255, 215, 0, 0.1)',
                        borderRight: '1px solid var(--border-color)',
                        flexShrink: 0
                      }}
                    >
                      <span className="midi-lane-color" style={{ backgroundColor: SOLO_COLOR }} />
                      <span className="midi-lane-name">Solo</span>
                    </div>
                    <SoloLane
                      sections={soloSections}
                      instrument={instrument}
                      scrollX={effectiveScrollX}
                      zoomLevel={zoomLevel}
                      width={Math.max(dimensions.width, 100)}
                      selectedSoloId={selectedSoloId}
                      songStore={songStore}
                      editTool={editTool}
                      snapDivision={snapDivision}
                    />
                  </div>

                  {/* Note lanes row: lane headers + grid */}
                  <div style={{ display: 'flex', flexDirection: 'row', height: noteAreaHeight }}>
                    <div className="midi-lane-header" style={{ width: MIDI_EDITOR_CONFIG.headerWidth, flexShrink: 0 }} onWheel={handleHeaderScroll}>
                      {isVocal ? (
                        // Vocal pitch header - compact with octave labels
                        <div style={{ position: 'relative', height: noteAreaHeight }}>
                          {(lanes as string[]).map((lane) => {
                            const isOctave = lane.includes('C') && !lane.includes('#')
                            return (
                              <div
                                key={lane}
                                className="midi-lane-label"
                                style={{
                                  height: laneRowHeight,
                                  fontSize: 7,
                                  opacity: isOctave ? 1 : 0.4,
                                  backgroundColor: isOctave ? 'rgba(232, 121, 249, 0.1)' : undefined
                                }}
                              >
                                {isOctave && <span className="midi-lane-name" style={{ fontSize: 8 }}>{lane}</span>}
                              </div>
                            )
                          })}
                          {/* Harmony part selector */}
                          <div style={{
                            position: 'absolute', bottom: 4, left: 4, right: 4,
                            display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center',
                            padding: '3px 2px',
                            backgroundColor: 'rgba(0,0,0,0.5)',
                            borderRadius: 4
                          }}>
                            {([0, 1, 2, 3] as HarmonyPart[]).map((part) => {
                              const partLabels = ['Main', 'H1', 'H2', 'H3']
                              const partColors = ['#E879F9', '#60A5FA', '#34D399', '#FBBF24']
                              const hasNotes = vocalNotes.some((n) => n.harmonyPart === part)
                              if (!hasNotes && part !== 0 && part !== activeHarmonyPart) return null
                              return (
                                <button
                                  key={part}
                                  style={{
                                    fontSize: 10, padding: '2px 6px', border: 'none', borderRadius: 3, cursor: 'pointer',
                                    fontWeight: activeHarmonyPart === part ? 700 : 500,
                                    backgroundColor: activeHarmonyPart === part ? partColors[part] : 'rgba(255,255,255,0.15)',
                                    color: activeHarmonyPart === part ? '#000' : '#ccc',
                                    boxShadow: activeHarmonyPart === part ? `0 0 6px ${partColors[part]}80` : 'none'
                                  }}
                                  onClick={() => songStore?.getState().setActiveHarmonyPart(part)}
                                >
                                  {partLabels[part]}
                                </button>
                              )
                            })}
                            {/* Add harmony part button */}
                            {(() => {
                              const usedParts = new Set(vocalNotes.map((n) => n.harmonyPart))
                              const nextPart = ([1, 2, 3] as HarmonyPart[]).find((p) => !usedParts.has(p))
                              if (nextPart === undefined) return null
                              return (
                                <button
                                  title={`Add Harmony ${nextPart}`}
                                  style={{
                                    fontSize: 10, padding: '1px 5px', border: '1px dashed rgba(255,255,255,0.3)',
                                    borderRadius: 3, cursor: 'pointer', backgroundColor: 'transparent', color: '#aaa',
                                    lineHeight: 1
                                  }}
                                  onClick={() => songStore?.getState().setActiveHarmonyPart(nextPart)}
                                >
                                  +
                                </button>
                              )
                            })()}
                            {/* Remove current harmony part button (not Main) */}
                            {activeHarmonyPart !== 0 && (
                              <button
                                title={`Remove all notes from ${['Main', 'H1', 'H2', 'H3'][activeHarmonyPart]}`}
                                style={{
                                  fontSize: 10, padding: '1px 5px', border: '1px dashed rgba(255,100,100,0.4)',
                                  borderRadius: 3, cursor: 'pointer', backgroundColor: 'transparent', color: '#f88',
                                  lineHeight: 1, marginLeft: 'auto'
                                }}
                                onClick={() => {
                                  if (confirm(`Delete all notes and phrases for ${['Main', 'H1', 'H2', 'H3'][activeHarmonyPart]}?`)) {
                                    songStore?.getState().deleteHarmonyPartNotes(activeHarmonyPart)
                                  }
                                }}
                              >
                                🗑
                              </button>
                            )}
                          </div>
                        </div>
                      ) : isProKeys ? (
                        // Pro Keys pitch header - compact with octave labels (like vocals but purple)
                        <div style={{ height: noteAreaHeight }}>
                          {(lanes as string[]).map((lane) => {
                            const isOctave = lane.includes('C') && !lane.includes('#')
                            const isBlackKey = lane.includes('#')
                            return (
                              <div
                                key={lane}
                                className="midi-lane-label"
                                style={{
                                  height: laneRowHeight,
                                  fontSize: 8,
                                  opacity: isOctave ? 1 : isBlackKey ? 0.3 : 0.5,
                                  backgroundColor: isOctave ? 'rgba(167, 139, 250, 0.1)' : isBlackKey ? 'rgba(0,0,0,0.15)' : undefined
                                }}
                              >
                                {(isOctave || !isBlackKey) && <span className="midi-lane-name" style={{ fontSize: 8 }}>{lane}</span>}
                              </div>
                            )
                          })}
                        </div>
                      ) : isProGuitar ? (
                        // Pro Guitar/Bass string headers
                        (lanes as string[]).map((lane) => {
                          const stringNames = ['e', 'B', 'G', 'D', 'A', 'E']
                          const idx = parseInt(lane) - 1
                          return (
                            <div
                              key={lane}
                              className="midi-lane-label"
                              style={{ height: laneRowHeight }}
                            >
                              <span
                                className="midi-lane-color"
                                style={{ backgroundColor: MIDI_EDITOR_CONFIG.laneColors[lane] }}
                              />
                              <span className="midi-lane-name">{stringNames[idx] || lane}</span>
                            </div>
                          )
                        })
                      ) : (
                        // Standard lane headers
                        (lanes as string[]).map((lane) => (
                          <div
                            key={lane}
                            className="midi-lane-label"
                            style={{ height: laneRowHeight }}
                          >
                            <span
                              className="midi-lane-color"
                              style={{ backgroundColor: MIDI_EDITOR_CONFIG.laneColors[lane] }}
                            />
                            <span className="midi-lane-name">{lane}</span>
                          </div>
                        ))
                      )}
                    </div>
                    <div
                      className="midi-grid-area"
                      style={{ minWidth: dimensions.width, height: noteAreaHeight, cursor: gridCursor }}
                      onMouseDown={isPitchBased ? undefined : (e) => handleGridMouseDown(e, instrument, lanes as string[])}
                      onWheel={handleNotesScroll}
                    >
                      <Grid
                        width={Math.max(dimensions.width, 100)}
                        height={noteAreaHeight}
                        lanes={lanes as string[]}
                        rowHeight={laneRowHeight}
                        scrollX={effectiveScrollX}
                        zoomLevel={zoomLevel}
                        ticksPerBeat={480}
                        snapDivision={snapDivision}
                        currentTick={currentTick}
                        tempoEvents={tempoEvents}
                      />
                      {isVocal ? (
                        <VocalNotes
                          vocalNotes={vocalNotes}
                          vocalPhrases={vocalPhrases}
                          harmonyPart={activeHarmonyPart}
                          scrollX={effectiveScrollX}
                          zoomLevel={zoomLevel}
                          width={Math.max(dimensions.width, 100)}
                          height={noteAreaHeight}
                          selectedNoteIds={selectedVocalNoteIds}
                          onNoteClick={handleNoteClick}
                          onLyricChange={(noteId, lyric) => songStore?.getState().updateVocalNote(noteId, { lyric })}
                          onGridMouseDown={handleVocalGridMouseDown}
                          starPowerPhrases={starPowerPhrases}
                        />
                      ) : isProKeys ? (
                        <ProKeysNotes
                          notes={instrumentNotes}
                          scrollX={effectiveScrollX}
                          zoomLevel={zoomLevel}
                          width={Math.max(dimensions.width, 100)}
                          height={noteAreaHeight}
                          selectedNoteIds={selectedNoteIds}
                          onNoteClick={handleNoteClick}
                          starPowerPhrases={starPowerPhrases}
                          onGridMouseDown={(e) => handleProKeysGridMouseDown(e, instrument)}
                          sustainThreshold={sustainThreshold}
                        />
                      ) : (
                        <Notes
                          notes={instrumentNotes}
                          lanes={lanes as string[]}
                          rowHeight={laneRowHeight}
                          scrollX={effectiveScrollX}
                          zoomLevel={zoomLevel}
                          width={Math.max(dimensions.width, 100)}
                          height={noteAreaHeight}
                          selectedNoteIds={selectedNoteIds}
                          onNoteClick={handleNoteClick}
                          onNoteMove={handleNoteMove}
                          starPowerPhrases={starPowerPhrases}
                          instrument={instrument}
                          onFretChange={(noteId, fret) => songStore?.getState().updateNote(noteId, { fret })}
                          onSustainResize={(noteId, e) => handleSustainResize(noteId, e, instrument, lanes as string[])}
                          sustainThreshold={sustainThreshold}
                        />
                      )}
                      {selectionBox && selectionBox.instrument === instrument && (
                        <div
                          className="midi-selection-box"
                          style={{
                            left: selectionBox.x,
                            top: selectionBox.y,
                            width: selectionBox.w,
                            height: selectionBox.h
                          }}
                        />
                      )}
                    </div>
                  </div>
                </>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
