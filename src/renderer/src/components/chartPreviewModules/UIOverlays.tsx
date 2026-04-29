// UI Overlays - Instrument toggles, difficulty selector, timeline scrubber, vocal overlay
import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useProjectStore, getSongStore, useUIStore, useSettingsStore } from '../../stores'
import type { Instrument, Difficulty, NoteModifiers, VocalNote, VocalPhrase, HarmonyPart } from '../../types'
import type { EditingTool } from './types'
import { playPitchPreview, stopPitchPreview } from '../../services/audioService'

export function InstrumentToggles(): React.JSX.Element {
  const { activeSongId } = useProjectStore()
  const [visibleInstruments, setVisibleInstruments] = useState<Set<Instrument>>(
    new Set(['drums', 'guitar', 'bass', 'vocals', 'keys', 'proKeys', 'proGuitar', 'proBass'])
  )

  useEffect(() => {
    if (!activeSongId) return
    const store = getSongStore(activeSongId)
    setVisibleInstruments(new Set(store.getState().visibleInstruments))
    return store.subscribe((state, prev) => {
      if (state.visibleInstruments !== prev.visibleInstruments)
        setVisibleInstruments(new Set(state.visibleInstruments))
    })
  }, [activeSongId])

  if (!activeSongId) return <></>

  const instruments: { id: Instrument; label: string }[] = [
    { id: 'drums', label: 'Drums' },
    { id: 'guitar', label: 'Guitar' },
    { id: 'bass', label: 'Bass' },
    { id: 'vocals', label: 'Vocals' },
    { id: 'keys', label: 'Keys' },
    { id: 'proKeys', label: 'Pro Keys' },
    { id: 'proGuitar', label: 'Pro Guitar' },
    { id: 'proBass', label: 'Pro Bass' }
  ]

  return (
    <div className="instrument-toggles">
      {instruments.map((inst) => (
        <button
          key={inst.id}
          className={`instrument-toggle ${visibleInstruments.has(inst.id) ? 'active' : ''}`}
          onClick={() => getSongStore(activeSongId).getState().toggleInstrumentVisibility(inst.id)}
        >
          {inst.label}
        </button>
      ))}
    </div>
  )
}

export function DifficultySelector(): React.JSX.Element {
  const { activeSongId } = useProjectStore()
  const [activeDifficulty, setActiveDifficulty] = useState<Difficulty>('expert')

  useEffect(() => {
    if (!activeSongId) return
    const store = getSongStore(activeSongId)
    setActiveDifficulty(store.getState().activeDifficulty)
    return store.subscribe((state, prev) => {
      if (state.activeDifficulty !== prev.activeDifficulty) setActiveDifficulty(state.activeDifficulty)
    })
  }, [activeSongId])

  if (!activeSongId) return <></>

  const difficulties: Difficulty[] = ['expert', 'hard', 'medium', 'easy']

  return (
    <div className="difficulty-selector">
      {difficulties.map((diff) => (
        <button
          key={diff}
          className={`difficulty-button ${activeDifficulty === diff ? 'active' : ''}`}
          onClick={() => getSongStore(activeSongId).getState().setActiveDifficulty(diff)}
        >
          {diff.charAt(0).toUpperCase() + diff.slice(1)}
        </button>
      ))}
    </div>
  )
}

const SNAP_DIVISIONS = [1, 2, 4, 8, 12, 16, 24, 32]

export function SnapSelector(): React.JSX.Element {
  const { activeSongId } = useProjectStore()
  const [snapDivision, setSnapDivision] = useState(4)

  useEffect(() => {
    if (!activeSongId) return
    const store = getSongStore(activeSongId)
    const persistedSnap = useSettingsStore.getState().snapDivision
    if (persistedSnap && persistedSnap !== store.getState().snapDivision) {
      store.getState().setSnapDivision(persistedSnap)
    }
    setSnapDivision(persistedSnap ?? store.getState().snapDivision)
    return store.subscribe((state, prev) => {
      if (state.snapDivision !== prev.snapDivision) setSnapDivision(state.snapDivision)
    })
  }, [activeSongId])

  if (!activeSongId) return <></>

  return (
    <div className="preview-snap-selector">
      <label>Snap:</label>
      <select
        value={snapDivision}
        onChange={(e) => {
          const v = parseInt(e.target.value)
          getSongStore(activeSongId).getState().setSnapDivision(v)
          useSettingsStore.getState().updateSettings({ snapDivision: v })
        }}
      >
        {SNAP_DIVISIONS.map((div) => (
          <option key={div} value={div}>
            1/{div}
          </option>
        ))}
      </select>
    </div>
  )
}

export function TimelineScrubber(): React.JSX.Element {
  const { activeSongId } = useProjectStore()
  const scrubberRef = useRef<HTMLDivElement>(null)
  const [currentTick, setCurrentTick] = useState(0)
  const [maxTick, setMaxTick] = useState(19200)
  const [isDragging, setIsDragging] = useState(false)

  useEffect(() => {
    if (!activeSongId) return
    const store = getSongStore(activeSongId)
    const initial = store.getState()
    setCurrentTick(initial.currentTick)
    const noteMaxTick = initial.song.notes.reduce((max, n) => Math.max(max, n.tick + n.duration), 0)
    setMaxTick(Math.max(19200, noteMaxTick + 4800))
    return store.subscribe((state, prev) => {
      if (state.currentTick !== prev.currentTick) setCurrentTick(state.currentTick)
      if (state.song.notes !== prev.song.notes) {
        const noteMax = state.song.notes.reduce((max, n) => Math.max(max, n.tick + n.duration), 0)
        setMaxTick(Math.max(19200, noteMax + 4800))
      }
    })
  }, [activeSongId])

  const handleScrub = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      if (!activeSongId || !scrubberRef.current) return
      const rect = scrubberRef.current.getBoundingClientRect()
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
      getSongStore(activeSongId).getState().setCurrentTick(Math.round((x / rect.width) * maxTick))
    },
    [activeSongId, maxTick]
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      setIsDragging(true)
      handleScrub(e)
    },
    [handleScrub]
  )

  useEffect(() => {
    if (!isDragging) return
    const onMove = (e: MouseEvent): void => handleScrub(e)
    const onUp = (): void => setIsDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [isDragging, handleScrub])

  if (!activeSongId) return <></>

  const pct = (currentTick / maxTick) * 100
  const measure = Math.floor(currentTick / 1920) + 1
  const beat = Math.floor((currentTick % 1920) / 480) + 1

  return (
    <div className="timeline-scrubber">
      <div className="timeline-time">
        {measure}:{beat}
      </div>
      <div ref={scrubberRef} className="timeline-track" onMouseDown={handleMouseDown}>
        <div className="timeline-progress" style={{ width: `${pct}%` }} />
        <div className="timeline-handle" style={{ left: `${pct}%` }} />
      </div>
      <div className="timeline-tick">{currentTick}</div>
    </div>
  )
}

export function VocalTrackOverlay({ songId }: { songId: string }): React.JSX.Element {
  const [vocalNotes, setVocalNotes] = useState<VocalNote[]>([])
  const [vocalPhrases, setVocalPhrases] = useState<VocalPhrase[]>([])
  const [currentTick, setCurrentTick] = useState(0)
  const [activeHarmonyPart, setActiveHarmonyPart] = useState<HarmonyPart>(0)
  const [visibleInstruments, setVisibleInstruments] = useState<Set<Instrument>>(new Set())
  const [selectedVocalNoteIds, setSelectedVocalNoteIds] = useState<string[]>([])
  const [snapDivision, setSnapDivision] = useState(4)
  const editTool = useUIStore((s) => s.editTool)
  const contentRef = useRef<HTMLDivElement>(null)
  const [editingLyric, setEditingLyric] = useState<{ noteId: string; value: string } | null>(null)
  const [hoveredNoteId, setHoveredNoteId] = useState<string | null>(null)
  const [selectionBox, setSelectionBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const dragRef = useRef<{
    mode: 'select' | 'move'
    startX: number
    startY: number
    startClientX: number
    startClientY: number
    noteIds?: string[]
    origPositions?: { id: string; tick: number; pitch: number }[]
    preMoveSnapshot?: unknown
  } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const noteRectsRef = useRef<Array<{ id: string; x: number; y: number; w: number; h: number }>>([])

  useEffect(() => {
    const store = getSongStore(songId)
    const init = store.getState()
    setVocalNotes(init.song.vocalNotes || [])
    setVocalPhrases(init.song.vocalPhrases || [])
    setCurrentTick(init.currentTick)
    setActiveHarmonyPart(init.activeHarmonyPart)
    setVisibleInstruments(new Set(init.visibleInstruments))
    setSelectedVocalNoteIds(init.selectedVocalNoteIds || [])
    setSnapDivision(init.snapDivision)
    return store.subscribe((state, prev) => {
      if (state.currentTick !== prev.currentTick) setCurrentTick(state.currentTick)
      if (state.song.vocalNotes !== prev.song.vocalNotes) setVocalNotes(state.song.vocalNotes || [])
      if (state.song.vocalPhrases !== prev.song.vocalPhrases) setVocalPhrases(state.song.vocalPhrases || [])
      if (state.activeHarmonyPart !== prev.activeHarmonyPart) setActiveHarmonyPart(state.activeHarmonyPart)
      if (state.visibleInstruments !== prev.visibleInstruments)
        setVisibleInstruments(new Set(state.visibleInstruments))
      if (state.selectedVocalNoteIds !== prev.selectedVocalNoteIds)
        setSelectedVocalNoteIds(state.selectedVocalNoteIds || [])
      if (state.snapDivision !== prev.snapDivision) setSnapDivision(state.snapDivision)
    })
  }, [songId])

  const tickWindow = 9600
  const pitchMin = 36
  const pitchMax = 84
  const pitchRange = pitchMax - pitchMin

  // Filter notes for visible window (show ALL harmony parts simultaneously with different colors)
  const filteredNotes = useMemo(() => vocalNotes.filter(
    (n) =>
      n.tick + n.duration >= currentTick - 480 &&
      n.tick <= currentTick + tickWindow
  ), [vocalNotes, currentTick, tickWindow])

  // Filter phrases for active harmony part
  const filteredPhrases = useMemo(() => vocalPhrases.filter(
    (p) =>
      p.harmonyPart === activeHarmonyPart &&
      p.tick + p.duration >= currentTick - 480 &&
      p.tick <= currentTick + tickWindow
  ), [vocalPhrases, activeHarmonyPart, currentTick, tickWindow])

  // Check which harmony parts have notes
  const availableParts = useMemo(() => [0, 1, 2, 3].filter(
    (p) => vocalNotes.some((n) => n.harmonyPart === p)
  ) as HarmonyPart[], [vocalNotes])

  const partColors = ['#E879F9', '#60A5FA', '#34D399', '#FBBF24']
  const partLabels = ['Main', 'H1', 'H2', 'H3']

  const ticksPerSnap = Math.round(1920 / snapDivision)
  const snapTick = (raw: number): number => Math.round(raw / ticksPerSnap) * ticksPerSnap
  const strikelinePos = 10

  // Convert mouse position to tick + pitch
  const posToTickPitch = useCallback(
    (e: React.MouseEvent): { tick: number; pitch: number } | null => {
      const el = contentRef.current
      if (!el) return null
      const rect = el.getBoundingClientRect()
      const x = (e.clientX - rect.left) / rect.width
      const y = (e.clientY - rect.top) / rect.height
      const tickFrac = (x - strikelinePos / 100) / ((100 - strikelinePos) / 100)
      const rawTick = currentTick + tickFrac * tickWindow
      const tick = snapTick(Math.max(0, rawTick))
      // Vertical: top=pitchMax, bottom=pitchMin
      const pitch = Math.round(pitchMax - y * pitchRange)
      return { tick, pitch: Math.max(pitchMin, Math.min(pitchMax, pitch)) }
    },
    [currentTick, tickWindow, pitchRange, pitchMax, pitchMin, ticksPerSnap]
  )

  const handleContentMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      const store = getSongStore(songId)
      const pos = posToTickPitch(e)
      if (!pos) return

      if (editTool === 'place') {
        // Check for duplicate
        const existing = vocalNotes.find(
          (n) => n.harmonyPart === activeHarmonyPart && Math.abs(n.tick - pos.tick) < ticksPerSnap / 2
        )
        if (existing) return
        store.getState().addVocalNote({
          tick: pos.tick,
          duration: ticksPerSnap,
          instrument: 'vocals',
          difficulty: 'expert',
          lane: pos.pitch,
          velocity: 100,
          harmonyPart: activeHarmonyPart,
          lyric: '+'
        })
        // Play pitch preview so charter can hear the note
        playPitchPreview(pos.pitch)
      } else if (editTool === 'select') {
        store.getState().clearVocalSelection?.()
        // Start box-select drag
        const el = contentRef.current
        if (el) {
          const rect = el.getBoundingClientRect()
          dragRef.current = {
            mode: 'select',
            startX: e.clientX - rect.left,
            startY: e.clientY - rect.top,
            startClientX: e.clientX,
            startClientY: e.clientY
          }
          setSelectionBox(null)
        }
      }
    },
    [songId, editTool, posToTickPitch, vocalNotes, activeHarmonyPart, ticksPerSnap]
  )

  const handleNoteMouseDown = useCallback(
    (noteId: string, e: React.MouseEvent) => {
      e.stopPropagation()
      const store = getSongStore(songId)
      if (editTool === 'erase') {
        store.getState().deleteVocalNote(noteId)
      } else if (editTool === 'select' || editTool === 'place') {
        // Select the note (toggle with ctrl)
        if (!selectedVocalNoteIds.includes(noteId)) {
          store.getState().selectVocalNote(noteId, e.ctrlKey || e.metaKey)
        }
        // Start drag-move
        const el = contentRef.current
        if (el) {
          const rect = el.getBoundingClientRect()
          const ids = selectedVocalNoteIds.includes(noteId)
            ? selectedVocalNoteIds : [noteId]
          const allNotes = store.getState().song.vocalNotes || []
          const origPositions = ids.map((id) => {
            const n = allNotes.find((v) => v.id === id)
            return { id, tick: n?.tick ?? 0, pitch: typeof n?.lane === 'number' ? n.lane : 60 }
          })
          const snapshot = store.getState().song
          store.temporal.getState().pause()
          dragRef.current = {
            mode: 'move',
            startX: e.clientX - rect.left,
            startY: e.clientY - rect.top,
            startClientX: e.clientX,
            startClientY: e.clientY,
            noteIds: ids,
            origPositions,
            preMoveSnapshot: snapshot
          }
        }
      }
    },
    [songId, editTool, selectedVocalNoteIds]
  )

  const handleNoteDoubleClick = useCallback(
    (noteId: string, currentLyric: string, e: React.MouseEvent) => {
      e.stopPropagation()
      setEditingLyric({ noteId, value: currentLyric || '' })
    },
    []
  )

  const commitLyric = useCallback(() => {
    if (!editingLyric) return
    const store = getSongStore(songId)
    store.getState().updateVocalNote(editingLyric.noteId, { lyric: editingLyric.value || '+' })
    setEditingLyric(null)
  }, [songId, editingLyric])

  // Hit-test: find note under cursor on canvas
  const findNoteAt = useCallback((mx: number, my: number) => {
    for (let i = noteRectsRef.current.length - 1; i >= 0; i--) {
      const r = noteRectsRef.current[i]
      if (mx >= r.x - 2 && mx <= r.x + r.w + 2 && my >= r.y - 4 && my <= r.y + r.h + 4) {
        return r
      }
    }
    return null
  }, [])

  // Unified canvas mouse down: hit-test notes first, then fall through to content handler
  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      const rect = e.currentTarget.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const hit = findNoteAt(mx, my)
      if (hit) {
        handleNoteMouseDown(hit.id, e)
      } else {
        handleContentMouseDown(e)
      }
    },
    [findNoteAt, handleNoteMouseDown, handleContentMouseDown]
  )

  // Canvas mouse move: track hover for erase tool cursor
  const handleCanvasMouseMove = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (dragRef.current) return
      const rect = e.currentTarget.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const hit = findNoteAt(mx, my)
      if (hit) {
        if (editTool === 'erase') {
          setHoveredNoteId(hit.id)
          e.currentTarget.style.cursor = 'pointer'
        } else if (editTool === 'select') {
          e.currentTarget.style.cursor = 'grab'
          if (hoveredNoteId) setHoveredNoteId(null)
        } else {
          e.currentTarget.style.cursor = 'default'
          if (hoveredNoteId) setHoveredNoteId(null)
        }
      } else {
        e.currentTarget.style.cursor = editTool === 'place' ? 'crosshair' : editTool === 'erase' ? 'pointer' : 'default'
        if (hoveredNoteId) setHoveredNoteId(null)
      }
    },
    [findNoteAt, editTool, hoveredNoteId]
  )

  // Canvas double-click: open lyric editor on note
  const handleCanvasDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const hit = findNoteAt(mx, my)
      if (hit) {
        const note = vocalNotes.find((n) => n.id === hit.id)
        if (note) handleNoteDoubleClick(note.id, note.lyric || '', e)
      }
    },
    [findNoteAt, vocalNotes, handleNoteDoubleClick]
  )

  // Drag handler: box-select or move selected notes
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent): void => {
      const drag = dragRef.current
      const el = contentRef.current
      if (!drag || !el) return
      const rect = el.getBoundingClientRect()

      if (drag.mode === 'select') {
        const curX = e.clientX - rect.left
        const curY = e.clientY - rect.top
        const x = Math.min(drag.startX, curX)
        const y = Math.min(drag.startY, curY)
        const w = Math.abs(curX - drag.startX)
        const h = Math.abs(curY - drag.startY)
        setSelectionBox({ x, y, w, h })

        // Convert box to tick + pitch range and select notes
        const leftPct = x / rect.width
        const rightPct = (x + w) / rect.width
        const topPct = y / rect.height
        const bottomPct = (y + h) / rect.height
        const tickFracL = (leftPct - strikelinePos / 100) / ((100 - strikelinePos) / 100)
        const tickFracR = (rightPct - strikelinePos / 100) / ((100 - strikelinePos) / 100)
        const startTick = currentTick + tickFracL * tickWindow
        const endTick = currentTick + tickFracR * tickWindow
        const topPitch = Math.round(pitchMax - topPct * pitchRange)
        const bottomPitch = Math.round(pitchMax - bottomPct * pitchRange)
        const highPitch = Math.max(topPitch, bottomPitch)
        const lowPitch = Math.min(topPitch, bottomPitch)

        const store = getSongStore(songId)
        const notes = store.getState().song.vocalNotes || []
        const hp = store.getState().activeHarmonyPart
        const ids = notes
          .filter((n) => {
            if (n.harmonyPart !== hp) return false
            const p = typeof n.lane === 'number' ? n.lane : 60
            return n.tick + n.duration >= startTick && n.tick <= endTick &&
              p >= lowPitch && p <= highPitch
          })
          .map((n) => n.id)
        store.getState().selectVocalNotes(ids)
      } else if (drag.mode === 'move' && drag.origPositions) {
        const dx = e.clientX - drag.startClientX
        const dy = e.clientY - drag.startClientY
        // Convert pixel deltas to tick/pitch deltas
        const tickDelta = (dx / rect.width) * tickWindow / ((100 - strikelinePos) / 100)
        const pitchDelta = -Math.round((dy / rect.height) * pitchRange)
        const snappedTickDelta = Math.round(tickDelta / ticksPerSnap) * ticksPerSnap

        const store = getSongStore(songId)
        for (const orig of drag.origPositions) {
          const newTick = Math.max(0, orig.tick + snappedTickDelta)
          const newPitch = Math.max(pitchMin, Math.min(pitchMax, orig.pitch + pitchDelta))
          store.getState().updateVocalNote(orig.id, { tick: newTick, lane: newPitch as unknown as VocalNote['lane'] })
        }
        // Preview pitch of first moved note
        if (drag.origPositions.length > 0) {
          const newPitch = Math.max(pitchMin, Math.min(pitchMax, drag.origPositions[0].pitch + pitchDelta))
          playPitchPreview(newPitch)
        }
      }
    }

    const handleMouseUp = (): void => {
      stopPitchPreview()
      const drag = dragRef.current
      if (drag?.mode === 'move' && drag.preMoveSnapshot) {
        const store = getSongStore(songId)
        const finalSong = store.getState().song
        // Restore pre-move state (still paused, not tracked)
        store.setState({ song: drag.preMoveSnapshot as typeof finalSong })
        // Resume temporal tracking
        store.temporal.getState().resume()
        // Apply final state as a single tracked entry
        store.setState({ song: finalSong, isDirty: true })
      }
      dragRef.current = null
      setSelectionBox(null)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [songId, currentTick, tickWindow, pitchRange, pitchMax, pitchMin, ticksPerSnap, strikelinePos])

  // Canvas drawing effect — renders all visuals to a single canvas instead of 100s of DOM elements
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const draw = (): void => {
      const dpr = window.devicePixelRatio || 1
      const cw = canvas.clientWidth
      const ch = canvas.clientHeight
      if (cw === 0 || ch === 0) return
      canvas.width = cw * dpr
      canvas.height = ch * dpr
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, cw, ch)

      const strikeX = cw * strikelinePos / 100
      const rects: Array<{ id: string; x: number; y: number; w: number; h: number }> = []

      // 1. Phrase backgrounds (clipped to strikeline)
      for (const phrase of filteredPhrases) {
        const tickOff = phrase.tick - currentTick
        const rawPct = strikelinePos + (tickOff / tickWindow) * (100 - strikelinePos)
        const clampPct = Math.max(strikelinePos, rawPct)
        const endPct = rawPct + Math.max(1, (phrase.duration / tickWindow) * 85)
        const wPct = endPct - clampPct
        if (wPct <= 0) continue
        const px = cw * clampPct / 100
        const pw = cw * wPct / 100
        ctx.fillStyle = 'rgba(232, 121, 249, 0.06)'
        ctx.fillRect(px, 0, pw, ch)
        ctx.strokeStyle = 'rgba(232, 121, 249, 0.3)'
        ctx.lineWidth = 1
        if (rawPct >= strikelinePos) {
          ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, ch); ctx.stroke()
        }
        ctx.beginPath(); ctx.moveTo(px + pw, 0); ctx.lineTo(px + pw, ch); ctx.stroke()
      }

      // 2. Pitch grid lines
      for (let p = pitchMin; p <= pitchMax; p++) {
        const pct = ((pitchMax - p) / pitchRange) * 75 + 8
        const y = ch * pct / 100
        const isC = p % 12 === 0
        ctx.strokeStyle = isC ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.04)'
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(strikeX, y); ctx.lineTo(cw, y); ctx.stroke()
        if (isC) {
          ctx.fillStyle = 'rgba(255,255,255,0.3)'
          ctx.font = '9px sans-serif'
          ctx.textAlign = 'right'
          ctx.fillText(`C${Math.floor(p / 12) - 1}`, strikeX - 3, y + 3)
        }
      }

      // 3. Beat grid lines
      const beatStart = currentTick - 480
      const beatEnd = currentTick + tickWindow
      const firstBeat = Math.ceil(beatStart / 480) * 480
      for (let t = firstBeat; t <= beatEnd; t += 480) {
        const tickOff = t - currentTick
        const pct = strikelinePos + (tickOff / tickWindow) * (100 - strikelinePos)
        if (pct < 0 || pct > 100) continue
        const x = cw * pct / 100
        const isMeasure = t % 1920 === 0
        ctx.strokeStyle = isMeasure ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.06)'
        ctx.lineWidth = isMeasure ? 2 : 1
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ch); ctx.stroke()
      }

      // 4. Strikeline with gradient + glow
      const grad = ctx.createLinearGradient(strikeX, 6, strikeX, ch - 6)
      grad.addColorStop(0, '#14b8a6')
      grad.addColorStop(0.5, '#0ea5e9')
      grad.addColorStop(1, '#14b8a6')
      ctx.save()
      ctx.shadowColor = '#0ea5e9'
      ctx.shadowBlur = 15
      ctx.fillStyle = grad
      ctx.fillRect(strikeX - 2, 6, 4, ch - 12)
      ctx.restore()

      // 5. Notes (transitions, bars, lyrics)
      const notesByPart = new Map<number, VocalNote[]>()
      for (const note of filteredNotes) {
        const arr = notesByPart.get(note.harmonyPart) || []
        arr.push(note)
        notesByPart.set(note.harmonyPart, arr)
      }

      for (const note of filteredNotes) {
        const tickOff = note.tick - currentTick
        const offsetPct = strikelinePos + (tickOff / tickWindow) * (100 - strikelinePos)
        const widthPct = Math.max(1.5, (note.duration / tickWindow) * 85)
        const isPast = note.tick + note.duration < currentTick
        const isCurrent = note.tick <= currentTick && note.tick + note.duration >= currentTick
        const isActivePart = note.harmonyPart === activeHarmonyPart
        const isSelected = selectedVocalNoteIds.includes(note.id)
        const noteColor = partColors[note.harmonyPart] || partColors[0]

        const pitch = typeof note.lane === 'number' ? note.lane : 60
        const clampedPitch = Math.min(Math.max(pitch, pitchMin), pitchMax)
        const pitchPct = note.isPercussion ? 88 : ((pitchMax - clampedPitch) / pitchRange) * 75 + 8

        const nx = cw * Math.max(0, offsetPct) / 100
        const nw = cw * widthPct / 100
        const ny = ch * pitchPct / 100
        const nh = note.isPercussion ? 6 : 10
        const nr = note.isPercussion ? 3 : 4

        // Transition curve between consecutive notes
        if (!note.isPercussion && isActivePart) {
          const samePartNotes = notesByPart.get(note.harmonyPart) || []
          let prev: VocalNote | undefined
          for (const n of samePartNotes) {
            if (!n.isPercussion && n.tick < note.tick) prev = n
          }
          if (prev) {
            const gap = note.tick - (prev.tick + prev.duration)
            if (gap >= 0 && gap <= 240) {
              const prevPitch = typeof prev.lane === 'number' ? prev.lane : 60
              if (prevPitch !== pitch) {
                const prevClamped = Math.min(Math.max(prevPitch, pitchMin), pitchMax)
                const prevPitchPct = ((pitchMax - prevClamped) / pitchRange) * 75 + 8
                const prevEndPct = strikelinePos + ((prev.tick + prev.duration - currentTick) / tickWindow) * (100 - strikelinePos)
                if (offsetPct - prevEndPct > 0) {
                  const tx1 = cw * prevEndPct / 100
                  const ty1 = ch * prevPitchPct / 100
                  const tx2 = cw * offsetPct / 100
                  ctx.save()
                  ctx.strokeStyle = noteColor
                  ctx.lineWidth = 3
                  ctx.globalAlpha = isPast ? 0.2 : 0.6
                  ctx.beginPath()
                  ctx.moveTo(tx1, ty1)
                  const midX = (tx1 + tx2) / 2
                  ctx.bezierCurveTo(midX, ty1, midX, ny, tx2, ny)
                  ctx.stroke()
                  ctx.restore()
                }
              }
            }
          }
        }

        // Note bar
        let fillColor: string
        if (editTool === 'erase' && hoveredNoteId === note.id) fillColor = '#FF4444'
        else if (isCurrent) fillColor = '#14b8a6'
        else if (isPast) fillColor = '#555'
        else fillColor = noteColor

        ctx.save()
        ctx.globalAlpha = isPast ? 0.3 : isActivePart ? 1 : 0.35
        ctx.fillStyle = fillColor
        ctx.beginPath()
        ctx.roundRect(nx, ny - nh / 2, nw, nh, nr)
        ctx.fill()
        if (isCurrent) {
          ctx.shadowColor = 'rgba(14, 184, 166, 0.7)'
          ctx.shadowBlur = 10
          ctx.beginPath()
          ctx.roundRect(nx, ny - nh / 2, nw, nh, nr)
          ctx.fill()
        }
        ctx.restore()

        // Selection outline
        if (isSelected) {
          ctx.save()
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 2
          ctx.shadowColor = 'rgba(255,255,255,0.5)'
          ctx.shadowBlur = 8
          ctx.beginPath()
          ctx.roundRect(nx - 1, ny - nh / 2 - 1, nw + 2, nh + 2, nr + 1)
          ctx.stroke()
          ctx.restore()
        }

        // Erase hover outline
        if (editTool === 'erase' && hoveredNoteId === note.id) {
          ctx.save()
          ctx.strokeStyle = '#FF4444'
          ctx.lineWidth = 2
          ctx.shadowColor = 'rgba(255,68,68,0.6)'
          ctx.shadowBlur = 8
          ctx.beginPath()
          ctx.roundRect(nx - 1, ny - nh / 2 - 1, nw + 2, nh + 2, nr + 1)
          ctx.stroke()
          ctx.restore()
        }

        // Lyrics
        if (note.lyric && isActivePart && editingLyric?.noteId !== note.id) {
          ctx.save()
          ctx.font = '600 13px sans-serif'
          ctx.fillStyle = isCurrent ? '#14b8a6' : isPast ? '#666' : '#fff'
          ctx.shadowColor = 'rgba(0,0,0,0.9)'
          ctx.shadowBlur = 3
          ctx.textAlign = 'left'
          ctx.globalAlpha = isPast ? 0.3 : 1
          ctx.fillText(note.lyric, nx, ny - nh / 2 - 4)
          ctx.restore()
        }

        // Store rect for hit-testing (active part only)
        if (isActivePart) {
          rects.push({ id: note.id, x: nx, y: ny - nh / 2, w: nw, h: nh })
        }
      }

      // 6. Selection box
      if (selectionBox) {
        ctx.save()
        ctx.fillStyle = 'rgba(100,150,255,0.15)'
        ctx.fillRect(selectionBox.x, selectionBox.y, selectionBox.w, selectionBox.h)
        ctx.strokeStyle = 'rgba(255,255,255,0.6)'
        ctx.lineWidth = 1
        ctx.strokeRect(selectionBox.x, selectionBox.y, selectionBox.w, selectionBox.h)
        ctx.restore()
      }

      noteRectsRef.current = rects
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [filteredNotes, filteredPhrases, currentTick, activeHarmonyPart, selectedVocalNoteIds, editTool, hoveredNoteId, selectionBox, editingLyric])

  if (!visibleInstruments.has('vocals')) return <></>

  return (
    <div className="vocal-track-overlay" style={{ height: 160, userSelect: 'none' }}>
      <div className="vocal-track-label" style={{ flexDirection: 'column', gap: 6 }}>
        <span>🎤 VOCALS</span>
        {availableParts.length > 1 && (
          <span style={{ display: 'flex', gap: 3, flexWrap: 'wrap', justifyContent: 'center' }}>
            {availableParts.map((part) => (
              <button
                key={part}
                style={{
                  fontSize: 10, padding: '2px 6px', border: 'none', borderRadius: 3, cursor: 'pointer',
                  fontWeight: activeHarmonyPart === part ? 700 : 500,
                  backgroundColor: activeHarmonyPart === part ? partColors[part] : 'rgba(255,255,255,0.15)',
                  color: activeHarmonyPart === part ? '#000' : '#ccc',
                  boxShadow: activeHarmonyPart === part ? `0 0 6px ${partColors[part]}80` : 'none',
                  lineHeight: '16px'
                }}
                onClick={() => getSongStore(songId).getState().setActiveHarmonyPart(part)}
              >
                {partLabels[part]}
              </button>
            ))}
          </span>
        )}
      </div>
      <div
        ref={contentRef}
        className="vocal-track-content"
        style={{ position: 'relative', height: '100%', overflow: 'hidden' }}
      >
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }}
        />
        <div
          style={{
            position: 'absolute', inset: 0,
            cursor: editTool === 'place' ? 'crosshair' : editTool === 'erase' ? 'pointer' : 'default'
          }}
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onDoubleClick={handleCanvasDoubleClick}
        />
        {editingLyric && (() => {
          const nr = noteRectsRef.current.find((r) => r.id === editingLyric.noteId)
          if (!nr) return null
          return (
            <input
              autoFocus
              value={editingLyric.value}
              onChange={(ev) => setEditingLyric({ ...editingLyric, value: ev.target.value })}
              onBlur={commitLyric}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') commitLyric()
                if (ev.key === 'Escape') setEditingLyric(null)
                ev.stopPropagation()
              }}
              style={{
                position: 'absolute',
                left: nr.x,
                top: nr.y - 22,
                width: 60, fontSize: 12, fontWeight: 700, padding: '1px 4px',
                background: 'rgba(0,0,0,0.85)', color: '#fff',
                border: '1px solid #E879F9', borderRadius: 3, outline: 'none',
                zIndex: 20
              }}
              onClick={(ev) => ev.stopPropagation()}
            />
          )
        })()}
      </div>
    </div>
  )
}

export function EditToolSelector({
  editTool,
  setEditTool
}: {
  editTool: EditingTool
  setEditTool: (tool: EditingTool) => void
}): React.JSX.Element {
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

// Note modifier toggle buttons (shared between 3D preview and piano roll)
export function NoteModifierToggles(): React.JSX.Element {
  const mods = useUIStore((s) => s.noteModifiers)
  const toggle = useUIStore((s) => s.toggleModifier)

  const buttons: { key: keyof NoteModifiers; label: string; shortcut: string; activeColor: string }[] = [
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

// Shortcut help panel with a toggle button
export function ShortcutHelpButton(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [panelStyle, setPanelStyle] = useState<{ top: number; left: number; maxHeight: number } | null>(null)

  useEffect(() => {
    if (!open) return

    const updatePanelPosition = (): void => {
      const button = buttonRef.current
      if (!button) return
      const rect = button.getBoundingClientRect()
      const panelWidth = 320
      const viewportPadding = 12
      const gap = 8
      const preferredMaxHeight = 460

      const left = Math.min(
        window.innerWidth - panelWidth - viewportPadding,
        Math.max(viewportPadding, rect.right - panelWidth)
      )

      let top = rect.bottom + gap
      let maxHeight = Math.min(preferredMaxHeight, window.innerHeight - top - viewportPadding)

      if (maxHeight < 180) {
        top = Math.max(viewportPadding, rect.top - gap - preferredMaxHeight)
        maxHeight = Math.min(preferredMaxHeight, rect.top - gap - viewportPadding)
      }

      setPanelStyle({ top, left, maxHeight: Math.max(140, maxHeight) })
    }

    const handleClickOutside = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (wrapperRef.current && target && !wrapperRef.current.contains(target)) {
        setOpen(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }

    updatePanelPosition()
    window.addEventListener('resize', updatePanelPosition)
    window.addEventListener('scroll', updatePanelPosition, true)
    window.addEventListener('mousedown', handleClickOutside)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('resize', updatePanelPosition)
      window.removeEventListener('scroll', updatePanelPosition, true)
      window.removeEventListener('mousedown', handleClickOutside)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div className="shortcut-help-wrapper" ref={wrapperRef}>
      <button
        ref={buttonRef}
        className={`shortcut-help-toggle ${open ? 'active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Keyboard Shortcuts"
      >
        ?
      </button>
      {open && panelStyle && (
        <div
          className="shortcut-help-panel"
          style={{
            position: 'fixed',
            top: panelStyle.top,
            left: panelStyle.left,
            width: 320,
            maxHeight: panelStyle.maxHeight,
            zIndex: 4000
          }}
        >
          <div className="shortcut-help-title">Keyboard Shortcuts</div>
          <div className="shortcut-help-section">
            <div className="shortcut-help-section-title">Tools</div>
            <ShortcutRow keys="1" desc="Select tool" />
            <ShortcutRow keys="2" desc="Place tool" />
            <ShortcutRow keys="3" desc="Erase tool" />
          </div>
          <div className="shortcut-help-section">
            <div className="shortcut-help-section-title">Note Modifiers (toggle)</div>
            <ShortcutRow keys="S" desc="Cymbal (drums) / Tap (guitar)" />
            <ShortcutRow keys="G" desc="Ghost (drums) / HOPO (guitar)" />
            <ShortcutRow keys="F" desc="Accent" />
            <ShortcutRow keys="O" desc="Open strum (guitar) / Kick (drums)" />
            <ShortcutRow keys="P" desc="Star Power mode" />
            <ShortcutRow keys="L" desc="Solo section mode" />
          </div>
          <div className="shortcut-help-section">
            <div className="shortcut-help-section-title">Editing</div>
            <ShortcutRow keys="Ctrl+C" desc="Copy selected notes" />
            <ShortcutRow keys="Ctrl+V" desc="Paste at playhead" />
            <ShortcutRow keys="Ctrl+Z" desc="Undo" />
            <ShortcutRow keys="Ctrl+Shift+Z" desc="Redo" />
            <ShortcutRow keys="Ctrl+A" desc="Select all" />
            <ShortcutRow keys="Del" desc="Delete selected" />
            <ShortcutRow keys="Ctrl+P" desc="Star Power from selection" />
            <ShortcutRow keys="Ctrl+L" desc="Solo from selection" />
            <ShortcutRow keys="Esc" desc="Clear selection" />
          </div>
          <div className="shortcut-help-section">
            <div className="shortcut-help-section-title">Playback & View</div>
            <ShortcutRow keys="Space" desc="Play / Pause" />
            <ShortcutRow keys="Ctrl+=" desc="Zoom in" />
            <ShortcutRow keys="Ctrl+-" desc="Zoom out" />
            <ShortcutRow keys="Ctrl+0" desc="Reset zoom" />
            <ShortcutRow keys="Ctrl+S" desc="Save" />
          </div>
          <div className="shortcut-help-section">
            <div className="shortcut-help-section-title">Click Modifiers</div>
            <ShortcutRow keys="Ctrl+Click" desc="Multi-select / add to selection" />
            <ShortcutRow keys="Click+Drag" desc="Box select (select) / Sustain (place)" />
          </div>
          <div className="shortcut-help-section">
            <div className="shortcut-help-section-title">Pro Guitar/Bass</div>
            <ShortcutRow keys="Dbl-click" desc="Edit fret number inline" />
            <ShortcutRow keys="↑ / ↓" desc="Fret +1 / −1 (selected)" />
          </div>
        </div>
      )}
    </div>
  )
}

function ShortcutRow({ keys, desc }: { keys: string; desc: string }): React.JSX.Element {
  return (
    <div className="shortcut-row">
      <div className="shortcut-keys">
        {keys.split('+').map((k, i) => (
          <span key={i}>
            {i > 0 && <span className="shortcut-plus">+</span>}
            <kbd>{k}</kbd>
          </span>
        ))}
      </div>
      <span className="shortcut-desc">{desc}</span>
    </div>
  )
}
