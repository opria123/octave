// Timeline editor for background media and venue authoring
import { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import { useProjectStore, useUIStore, getSongStore } from '../stores'
import { tickToSeconds, secondsToTick, getAudioDuration, getAudioSources, onAudioLoaded } from '../services/audioService'
import * as audioService from '../services/audioService'
import type {
  VideoSync,
  VideoClip,
  AudioSync,
  AudioClip,
  TempoEvent,
  VenueTrackData,
  VenueLightingEvent,
  VenuePostProcessingEvent,
  VenueStageEvent,
  VenueCameraCutEvent,
  VenuePerformerEvent,
  SelectedVenueEventRef
} from '../types'
import './VideoEditor.css'

const VIDEO_EDITOR_CONFIG = {
  pixelsPerSecond: 50,
  waveformHeight: 64,
  rulerHeight: 24,
  venueTrackHeight: 42,
  playheadHeight: 390
}

const TIMELINE_LABEL_WIDTH = 120

// Exhaustive RB3/YARG lighting cue list
const LIGHTING_PRESETS = [
  // Keyframed cues
  'verse', 'chorus', 'dischord', 'manual_cool', 'manual_warm', 'stomp',
  // Automatic cues
  'blackout_fast', 'blackout_slow', 'blackout_spot', 'bre',
  'flare_fast', 'flare_slow', 'frenzy', 'harmony', 'intro',
  'loop_cool', 'loop_warm', 'searchlights',
  'silhouettes', 'silhouettes_spot',
  'strobe_fast', 'strobe_slow', 'sweep'
]

// Exhaustive RB3 post-processing effect list
const POST_PROCESSING_PRESETS = [
  'ProFilm_a.pp', 'ProFilm_b.pp', 'ProFilm_mirror_a.pp', 'ProFilm_psychedelic_blue_red.pp',
  'bloom.pp', 'bright.pp',
  'clean_trails.pp', 'video_trails.pp', 'flicker_trails.pp', 'desat_posterize_trails.pp', 'space_woosh.pp',
  'contrast_a.pp', 'desat_blue.pp',
  'film_16mm.pp', 'film_b+w.pp', 'film_blue_filter.pp',
  'film_contrast.pp', 'film_contrast_blue.pp', 'film_contrast_green.pp', 'film_contrast_red.pp',
  'film_sepia_ink.pp', 'film_silvertone.pp',
  'horror_movie_special.pp', 'photo_negative.pp', 'photocopy.pp', 'posterize.pp',
  'shitty_tv.pp',
  'video_a.pp', 'video_bw.pp', 'video_security.pp'
]

const STAGE_PRESETS = ['FogOn', 'FogOff', 'bonusfx', 'bonusfx_optional', 'first', 'next', 'prev']

// Exhaustive RB3 camera cut list (coop + directed)
const CAMERA_CUT_PRESETS = [
  // One-character coop cuts
  'coop_g_behind', 'coop_g_near', 'coop_g_closeup_hand', 'coop_g_closeup_head',
  'coop_b_behind', 'coop_b_near', 'coop_b_closeup_hand', 'coop_b_closeup_head',
  'coop_d_behind', 'coop_d_near', 'coop_d_closeup_hand', 'coop_d_closeup_head',
  'coop_v_behind', 'coop_v_near', 'coop_v_closeup',
  'coop_k_behind', 'coop_k_near', 'coop_k_closeup_hand', 'coop_k_closeup_head',
  // Two-character coop cuts
  'coop_gv_behind', 'coop_gv_near', 'coop_gk_behind', 'coop_gk_near',
  'coop_bg_behind', 'coop_bg_near', 'coop_bd_near',
  'coop_bv_behind', 'coop_bv_near', 'coop_bk_behind', 'coop_bk_near',
  'coop_dg_near', 'coop_dv_near',
  'coop_kv_behind', 'coop_kv_near',
  // Three-character coop cuts
  'coop_front_behind', 'coop_front_near',
  // Full-band coop cuts
  'coop_all_behind', 'coop_all_far', 'coop_all_near',
  // Directed cuts – full band
  'directed_all', 'directed_all_cam', 'directed_all_lt', 'directed_all_yeah',
  'directed_bre', 'directed_brej', 'directed_crowd',
  // Directed cuts – guitarist
  'directed_guitar', 'directed_guitar_np', 'directed_guitar_cls',
  'directed_guitar_cam_pr', 'directed_guitar_cam_pt', 'directed_crowd_g',
  // Directed cuts – bassist
  'directed_bass', 'directed_bass_np', 'directed_bass_cam', 'directed_bass_cls', 'directed_crowd_b',
  // Directed cuts – drummer
  'directed_drums', 'directed_drums_lt', 'directed_drums_np', 'directed_drums_pnt', 'directed_drums_kd',
  // Directed cuts – vocalist
  'directed_vocals', 'directed_vocals_np', 'directed_vocals_cls',
  'directed_vocals_cam_pr', 'directed_vocals_cam_pt',
  'directed_stagedive', 'directed_crowdsurf',
  // Directed cuts – keys
  'directed_keys', 'directed_keys_np', 'directed_keys_cam',
  // Directed cuts – two characters
  'directed_duo_guitar', 'directed_duo_bass', 'directed_duo_drums', 'directed_duo_kv',
  'directed_duo_gb', 'directed_duo_kg', 'directed_duo_kb'
]

const PERFORMER_TYPE_PRESETS = ['spotlight', 'singalong']
const PERFORMER_TARGET_PRESETS = ['guitar', 'bass', 'drums', 'vocals', 'keys']

type VenueLaneKey = keyof Pick<VenueTrackData, 'lighting' | 'postProcessing' | 'stage' | 'cameraCuts' | 'performer'>
type VenueEvent = VenueLightingEvent | VenuePostProcessingEvent | VenueStageEvent | VenueCameraCutEvent | VenuePerformerEvent

type VenueTrackProps = {
  laneKey: VenueLaneKey
  label: string
  icon: string
  tone: 'lighting' | 'post' | 'stage' | 'camera' | 'performer'
  events: VenueEvent[]
  tempoEvents: TempoEvent[]
  scrollX: number
  zoom: number
  width: number
  selectedEventId: string | null
  onSelectEvent: (id: string | null) => void
  onSelectRange?: (startTick: number, endTick: number) => void
  sharedSelectionBox: { startX: number; currentX: number } | null
  onSharedSelectionBoxChange: (box: { startX: number; currentX: number } | null) => void
  onMoveEvent: (id: string, newTick: number) => void
  onDeleteEvent: (id: string) => void
  onResizeEvent?: (id: string, newDuration: number) => void
  getEventLabel: (event: VenueEvent) => string
  getEventDuration?: (event: VenueEvent) => number
}

function sortByTick<T extends { tick: number }>(events: T[]): T[] {
  return [...events].sort((left, right) => left.tick - right.tick)
}

function uniqueOptions(options: string[], value?: string): string[] {
  return value && !options.includes(value) ? [...options, value] : options
}

function createVenueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function snapVenueTick(tick: number): number {
  const snap = 120
  return Math.max(0, Math.round(tick / snap) * snap)
}

function formatVenueLabel(value: string): string {
  return value
    .replace(/\[|\]/g, '')
    .replace(/\.pp$/i, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
}

function getVenueLaneLabel(lane: VenueLaneKey): string {
  switch (lane) {
    case 'lighting':
      return 'Lighting'
    case 'postProcessing':
      return 'Post FX'
    case 'stage':
      return 'Stage FX'
    case 'cameraCuts':
      return 'Camera Cut'
    case 'performer':
      return 'Performer'
    default:
      return lane
  }
}

function TimelineRuler({
  duration, scrollX, zoom, width
}: {
  duration: number; scrollX: number; zoom: number; width: number
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    canvas.width = width
    canvas.height = VIDEO_EDITOR_CONFIG.rulerHeight
    ctx.fillStyle = '#1a1a2e'
    ctx.fillRect(0, 0, width, VIDEO_EDITOR_CONFIG.rulerHeight)

    const pps = VIDEO_EDITOR_CONFIG.pixelsPerSecond * zoom
    const startSec = Math.floor(scrollX / pps)
    const endSec = Math.ceil((scrollX + width) / pps)

    ctx.font = '10px monospace'
    ctx.fillStyle = '#888899'
    ctx.strokeStyle = '#444466'

    for (let sec = startSec; sec <= endSec && sec <= duration; sec++) {
      const x = sec * pps - scrollX
      ctx.beginPath()
      ctx.moveTo(x, 16)
      ctx.lineTo(x, 24)
      ctx.stroke()
      const m = Math.floor(sec / 60)
      const s = sec % 60
      ctx.fillText(`${m}:${s.toString().padStart(2, '0')}`, x + 4, 12)
      if (sec < duration) {
        const halfX = x + pps / 2
        ctx.beginPath()
        ctx.moveTo(halfX, 20)
        ctx.lineTo(halfX, 24)
        ctx.stroke()
      }
    }
  }, [duration, scrollX, zoom, width])

  return <canvas ref={canvasRef} className="video-timeline-ruler" />
}

function AudioTrack({
  songId, scrollX, zoom, width, clips, selectedClipId, onSelectClip, onMoveClip
}: {
  songId: string; scrollX: number; zoom: number; width: number
  clips: AudioClip[]
  selectedClipId: string | null
  onSelectClip: (id: string | null) => void
  onMoveClip: (clipId: string, newStartMs: number) => void
}): React.JSX.Element {
  const [sources, setSources] = useState(() => getAudioSources(songId))
  const [dragInfo, setDragInfo] = useState<{ clipId: string; startX: number; origStartMs: number } | null>(null)
  const pps = VIDEO_EDITOR_CONFIG.pixelsPerSecond * zoom
  const ppm = pps / 1000

  useEffect(() => {
    const sync = (): void => setSources(getAudioSources(songId))
    sync()
    return onAudioLoaded(songId, sync)
  }, [songId])

  const getClipDurationMs = useCallback((clip: AudioClip): number => {
    if (clip.durationMs > 0) return clip.durationMs
    const source = sources.find((entry) => entry.filePath === clip.filePath) ?? sources.find((entry) => entry.filename === clip.filename)
    if (!source) return 0
    return Math.max(0, Math.round(source.duration * 1000) - clip.sourceStartMs)
  }, [sources])

  const handleClipMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>, clip: AudioClip) => {
    e.stopPropagation()
    onSelectClip(clip.id)
    setDragInfo({ clipId: clip.id, startX: e.clientX, origStartMs: clip.startMs })
  }, [onSelectClip])

  useEffect(() => {
    if (!dragInfo) return
    const handleMove = (e: MouseEvent): void => {
      const deltaMs = (e.clientX - dragInfo.startX) / ppm
      onMoveClip(dragInfo.clipId, Math.max(0, dragInfo.origStartMs + deltaMs))
    }
    const handleUp = (): void => setDragInfo(null)
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [dragInfo, ppm, onMoveClip])

  const laidOutClips = useMemo(() => {
    const sorted = [...clips].sort((a, b) => a.startMs - b.startMs)
    const rowEnds: number[] = []
    return sorted.map((clip) => {
      const durationMs = getClipDurationMs(clip)
      let row = rowEnds.findIndex((endMs) => clip.startMs >= endMs)
      if (row === -1) {
        row = rowEnds.length
        rowEnds.push(0)
      }
      rowEnds[row] = clip.startMs + durationMs
      return { clip, durationMs, row }
    })
  }, [clips, getClipDurationMs])

  const trackHeight = Math.max(VIDEO_EDITOR_CONFIG.waveformHeight, 28 + Math.max(0, laidOutClips.reduce((max, item) => Math.max(max, item.row), 0)) * 22)

  return (
    <div className="audio-track" style={{ minHeight: trackHeight }}>
      <div className="audio-track-label"><span>Audio</span></div>
      <div className="audio-track-timeline" style={{ width, minHeight: trackHeight }}>
        {laidOutClips.length > 0 && laidOutClips.map(({ clip, durationMs, row }) => {
          const left = clip.startMs * ppm - scrollX
          const clipWidth = Math.max(24, durationMs * ppm)
          return (
            <div
              key={clip.id}
              className={`audio-clip ${selectedClipId === clip.id ? 'selected' : ''} ${dragInfo?.clipId === clip.id ? 'dragging' : ''}`}
              style={{ left, width: clipWidth, top: 4 + row * 22, height: 18 }}
              onMouseDown={(e) => handleClipMouseDown(e, clip)}
              onClick={(e) => {
                e.stopPropagation()
                onSelectClip(clip.id)
              }}
              title={`${clip.filename} at ${(clip.startMs / 1000).toFixed(2)}s`}
            >
              <span className="audio-clip-name">{clip.filename}</span>
            </div>
          )
        })}
        {laidOutClips.length === 0 && (
          <div className="audio-track-empty"><span>No audio clips on timeline</span></div>
        )}
      </div>
    </div>
  )
}

function VideoTrack({
  videoPath, clips, scrollX, zoom, width,
  selectedClipId, onSelectClip, onMoveClip
}: {
  videoPath?: string; clips: VideoClip[]; scrollX: number; zoom: number; width: number
  selectedClipId: string | null; onSelectClip: (id: string | null) => void
  onMoveClip: (id: string, newStartMs: number) => void
}): React.JSX.Element {
  const [dragInfo, setDragInfo] = useState<{ clipId: string; startX: number; origMs: number } | null>(null)
  const pps = VIDEO_EDITOR_CONFIG.pixelsPerSecond * zoom
  const ppm = pps / 1000

  const handleClipMouseDown = useCallback((e: React.MouseEvent, clip: VideoClip) => {
    e.stopPropagation()
    onSelectClip(clip.id)
    setDragInfo({ clipId: clip.id, startX: e.clientX, origMs: clip.startMs })
  }, [onSelectClip])

  useEffect(() => {
    if (!dragInfo) return
    const handleMove = (e: MouseEvent): void => {
      const deltaMs = (e.clientX - dragInfo.startX) / ppm
      onMoveClip(dragInfo.clipId, Math.max(0, dragInfo.origMs + deltaMs))
    }
    const handleUp = (): void => setDragInfo(null)
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [dragInfo, ppm, onMoveClip])

  return (
    <div className="video-track">
      <div className="video-track-label"><span>Video</span></div>
      <div className="video-track-timeline" style={{ width }} onClick={() => onSelectClip(null)}>
        {videoPath && clips.length > 0 ? clips.map((clip) => {
          const clipX = clip.startMs * ppm - scrollX
          const clipW = Math.max(10, clip.durationMs * ppm)
          return (
            <div
              key={clip.id}
              className={`video-clip ${clip.id === selectedClipId ? 'selected' : ''} ${dragInfo?.clipId === clip.id ? 'dragging' : ''}`}
              style={{ left: clipX, width: clipW }}
              onMouseDown={(e) => handleClipMouseDown(e, clip)}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="video-clip-content">
                <span className="video-clip-name">
                  {(clip.sourceStartMs / 1000).toFixed(1)}s - {((clip.sourceStartMs + clip.durationMs) / 1000).toFixed(1)}s
                </span>
              </div>
            </div>
          )
        }) : (
          <div className="video-track-empty"><span>No video loaded. Use Import File or Import URL.</span></div>
        )}
      </div>
    </div>
  )
}

/** How many pixels apart two events must be for them to be considered "stacked" */
const STACK_THRESHOLD_PX = 12
const VENUE_MIN_DURATION_TICKS = 60

type StackPicker = {
  /** pixel x inside the timeline div */
  x: number
  /** pixel y inside the timeline div */
  y: number
  events: VenueEvent[]
}

function VenueTrack({
  laneKey,
  label,
  icon,
  tone,
  events,
  tempoEvents,
  scrollX,
  zoom,
  width,
  selectedEventId,
  onSelectEvent,
  onSelectRange,
  sharedSelectionBox,
  onSharedSelectionBoxChange,
  onMoveEvent,
  onDeleteEvent,
  onResizeEvent,
  getEventLabel,
  getEventDuration
}: VenueTrackProps): React.JSX.Element {
  const [dragInfo, setDragInfo] = useState<{ eventId: string; startX: number; originSeconds: number } | null>(null)
  const [resizeInfo, setResizeInfo] = useState<{ eventId: string; startX: number; originTick: number; originDuration: number } | null>(null)
  const [selectionBox, setSelectionBox] = useState<{ startX: number; currentX: number } | null>(null)
  const [stackPicker, setStackPicker] = useState<StackPicker | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const dragMovedRef = useRef(false)
  const pps = VIDEO_EDITOR_CONFIG.pixelsPerSecond * zoom

  const getEventLeft = useCallback((event: VenueEvent): number => {
    return tickToSeconds(event.tick, tempoEvents) * pps - scrollX
  }, [tempoEvents, pps, scrollX])

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>, event: VenueEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragMovedRef.current = false
    // Find all events whose left edge is within STACK_THRESHOLD_PX of this event
    const thisLeft = getEventLeft(event)
    const stacked = events.filter((other) => Math.abs(getEventLeft(other) - thisLeft) < STACK_THRESHOLD_PX)
    if (stacked.length > 1) {
      onSelectEvent(event.id)
      // Show stack picker instead of immediately selecting
      const rect = timelineRef.current?.getBoundingClientRect()
      const px = e.clientX - (rect?.left ?? 0)
      const py = e.clientY - (rect?.top ?? 0)
      setStackPicker({ x: px, y: py, events: stacked })
      return
    }
    onSelectEvent(event.id)
    setDragInfo({
      eventId: event.id,
      startX: e.clientX,
      originSeconds: tickToSeconds(event.tick, tempoEvents)
    })
  }, [onSelectEvent, tempoEvents, events, getEventLeft])

  const handleLaneMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    const rect = timelineRef.current?.getBoundingClientRect()
    const startX = e.clientX - (rect?.left ?? 0)
    setStackPicker(null)
    const next = { startX, currentX: startX }
    setSelectionBox(next)
    onSharedSelectionBoxChange(next)
  }, [onSharedSelectionBoxChange])

  const handlePickerSelect = useCallback((event: VenueEvent) => {
    setStackPicker(null)
    onSelectEvent(event.id)
  }, [onSelectEvent])

  // Close picker only when clicking outside this track
  useEffect(() => {
    if (!stackPicker) return
    const close = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (target && trackRef.current?.contains(target)) return
      setStackPicker(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [stackPicker])

  useEffect(() => {
    if (!dragInfo) return
    const handleMove = (e: MouseEvent): void => {
      const deltaSeconds = (e.clientX - dragInfo.startX) / pps
      if (Math.abs(e.clientX - dragInfo.startX) > 2) dragMovedRef.current = true
      const rawTick = secondsToTick(Math.max(0, dragInfo.originSeconds + deltaSeconds), tempoEvents)
      const newTick = e.shiftKey ? Math.max(0, rawTick) : snapVenueTick(rawTick)
      onMoveEvent(dragInfo.eventId, newTick)
    }
    const handleUp = (): void => {
      const didDrag = dragMovedRef.current
      dragMovedRef.current = false
      setDragInfo(null)
      if (didDrag) onSelectEvent(null)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [dragInfo, onMoveEvent, onSelectEvent, pps, tempoEvents])

  useEffect(() => {
    if (!selectionBox) return
    const handleMove = (e: MouseEvent): void => {
      const rect = timelineRef.current?.getBoundingClientRect()
      const currentX = e.clientX - (rect?.left ?? 0)
      setSelectionBox((prev) => {
        if (!prev) return prev
        const next = { ...prev, currentX }
        onSharedSelectionBoxChange(next)
        return next
      })
    }
    const handleUp = (): void => {
      setSelectionBox((box) => {
        if (!box) return null
        const x1 = Math.min(box.startX, box.currentX)
        const x2 = Math.max(box.startX, box.currentX)
        const widthPx = x2 - x1
        if (widthPx < 3) {
          onSelectEvent(null)
          return null
        }

        const startTick = secondsToTick(Math.max(0, (x1 + scrollX) / pps), tempoEvents)
        const endTick = secondsToTick(Math.max(0, (x2 + scrollX) / pps), tempoEvents)

        if (onSelectRange) {
          onSelectRange(Math.min(startTick, endTick), Math.max(startTick, endTick))
          return null
        }

        const inRange = events
          .filter((event) => event.tick >= Math.min(startTick, endTick) && event.tick <= Math.max(startTick, endTick))
          .sort((a, b) => a.tick - b.tick)

        onSelectEvent(inRange.length > 0 ? inRange[0].id : null)

        return null
      })
      onSharedSelectionBoxChange(null)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [events, laneKey, onSelectEvent, onSelectRange, onSharedSelectionBoxChange, pps, scrollX, selectionBox, tempoEvents])

  useEffect(() => {
    if (!resizeInfo || !onResizeEvent) return
    const handleMove = (e: MouseEvent): void => {
      const originEndTick = resizeInfo.originTick + resizeInfo.originDuration
      const originEndSeconds = tickToSeconds(originEndTick, tempoEvents)
      const deltaSeconds = (e.clientX - resizeInfo.startX) / pps
      const rawEndTick = secondsToTick(Math.max(0, originEndSeconds + deltaSeconds), tempoEvents)
      const nextEndTick = e.shiftKey ? Math.max(0, rawEndTick) : snapVenueTick(rawEndTick)
      const newDuration = Math.max(VENUE_MIN_DURATION_TICKS, nextEndTick - resizeInfo.originTick)
      onResizeEvent(resizeInfo.eventId, newDuration)
    }
    const handleUp = (): void => setResizeInfo(null)
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [onResizeEvent, pps, resizeInfo, tempoEvents])

  return (
    <div className="venue-track" ref={trackRef}>
      <div className="venue-track-label"><span>{icon}</span><span>{label}</span></div>
      <div
        className="venue-track-timeline"
        style={{ width }}
        ref={timelineRef}
        onMouseDown={handleLaneMouseDown}
      >
        {events.length > 0 ? events.map((event) => {
          const startSeconds = tickToSeconds(event.tick, tempoEvents)
          const durationTicks = getEventDuration?.(event) ?? 0
          const endSeconds = durationTicks > 0 ? tickToSeconds(event.tick + durationTicks, tempoEvents) : startSeconds + 1.6
          const left = startSeconds * pps - scrollX
          const itemWidth = Math.max(84, (endSeconds - startSeconds) * pps)
          return (
            <div
              key={event.id}
              className={`venue-event venue-event-${tone} ${selectedEventId === event.id ? 'selected' : ''} ${dragInfo?.eventId === event.id ? 'dragging' : ''}`}
              style={{ left, width: itemWidth }}
              onMouseDown={(e) => handleMouseDown(e, event)}
              onClick={(e) => { e.stopPropagation(); onSelectEvent(event.id) }}
              onDragStart={(e) => e.preventDefault()}
              title={`${label}: ${getEventLabel(event)} @ tick ${event.tick}`}
            >
              <span className="venue-event-name">{getEventLabel(event)}</span>
              {onResizeEvent && selectedEventId === event.id && (
                <div
                  className="venue-event-resize-handle"
                  title="Drag to change duration (hold Shift for fine adjustment)"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setResizeInfo({
                      eventId: event.id,
                      startX: e.clientX,
                      originTick: event.tick,
                      originDuration: Math.max(durationTicks, VENUE_MIN_DURATION_TICKS)
                    })
                  }}
                />
              )}
              <button
                className="venue-event-delete"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onDeleteEvent(event.id) }}
                title="Delete event"
              >✕</button>
            </div>
          )
        }) : (
          <div className="venue-track-empty"><span>No authored events</span></div>
        )}

        {/* Dense-tick stack picker popover */}
        {stackPicker && (
          <div
            className="venue-stack-picker"
            style={{ left: stackPicker.x, top: stackPicker.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="venue-stack-picker-header">Select event ({stackPicker.events.length} stacked)</div>
            {stackPicker.events.map((ev) => (
              <button
                key={ev.id}
                className={`venue-stack-picker-item venue-stack-picker-item-${tone}`}
                onClick={() => handlePickerSelect(ev)}
              >
                {getEventLabel(ev)}
                <span className="venue-stack-picker-tick">t{ev.tick}</span>
              </button>
            ))}
          </div>
        )}

        {sharedSelectionBox && (
          <div
            className="venue-selection-box"
            style={{
              left: Math.min(sharedSelectionBox.startX, sharedSelectionBox.currentX),
              width: Math.abs(sharedSelectionBox.currentX - sharedSelectionBox.startX)
            }}
          />
        )}
      </div>
    </div>
  )
}

function Playhead({
  currentTime, scrollX, zoom, height, onSeek
}: {
  currentTime: number; scrollX: number; zoom: number; height: number
  onSeek: (seconds: number) => void
}): React.JSX.Element {
  const pps = VIDEO_EDITOR_CONFIG.pixelsPerSecond * zoom
  const x = currentTime * pps - scrollX
  const [isDragging, setIsDragging] = useState(false)
  const dragRef = useRef({ startX: 0, startTime: 0 })

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setIsDragging(true)
    dragRef.current = { startX: e.clientX, startTime: currentTime }
  }, [currentTime])

  useEffect(() => {
    if (!isDragging) return
    const handleMove = (e: MouseEvent): void => {
      const deltaX = e.clientX - dragRef.current.startX
      const deltaSec = deltaX / pps
      onSeek(Math.max(0, dragRef.current.startTime + deltaSec))
    }
    const handleUp = (): void => setIsDragging(false)
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [isDragging, pps, onSeek])

  if (x < -10) return <></>
  return (
    <div
      className={`video-playhead ${isDragging ? 'dragging' : ''}`}
      style={{ left: 80 + x, height }}
      onMouseDown={handleMouseDown}
    >
      <div className="video-playhead-head" />
      <div className="video-playhead-line" />
    </div>
  )
}

function URLImportModal({
  onSubmit, onCancel, isDownloading, downloadProgress
}: {
  onSubmit: (url: string) => void; onCancel: () => void
  isDownloading: boolean; downloadProgress: number
}): React.JSX.Element {
  const [url, setUrl] = useState('')
  return (
    <div className="video-url-modal-overlay" onClick={isDownloading ? undefined : onCancel}>
      <div className="video-url-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Import Video from URL</h3>
        <p style={{ fontSize: 12, color: '#888', margin: '0 0 8px' }}>
          Supports YouTube, Vimeo, and direct video URLs. Requires yt-dlp installed.
        </p>
        <input
          type="text"
          placeholder="https://www.youtube.com/watch?v=... or direct .mp4 URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          autoFocus
          disabled={isDownloading}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && url.trim() && !isDownloading) onSubmit(url.trim())
          }}
        />
        {isDownloading && (
          <div style={{ marginTop: 8 }}>
            <div style={{ height: 4, background: '#333', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${downloadProgress}%`, background: '#4488FF', transition: 'width 0.3s' }} />
            </div>
            <span style={{ fontSize: 11, color: '#888' }}>Downloading... {Math.round(downloadProgress)}%</span>
          </div>
        )}
        <div className="video-url-modal-actions">
          <button onClick={onCancel} disabled={isDownloading}>Cancel</button>
          <button disabled={!url.trim() || isDownloading} onClick={() => onSubmit(url.trim())}>
            {isDownloading ? 'Downloading...' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function VideoEditor(): React.JSX.Element {
  const { activeSongId } = useProjectStore()
  const selectedVenueEvent = useUIStore((state) => state.selectedVenueEvent)
  const setSelectedVenueEvent = useUIStore((state) => state.setSelectedVenueEvent)
  const containerRef = useRef<HTMLDivElement>(null)
  const timelineAreaRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 200 })
  const [scrollX, setScrollX] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [showUrlModal, setShowUrlModal] = useState(false)
  const [exportProgress, setExportProgress] = useState<number | null>(null)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [isDownloading, setIsDownloading] = useState(false)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [selectedAudioClipId, setSelectedAudioClipId] = useState<string | null>(null)

  const [videoSync, setVideoSync] = useState<VideoSync>({ clips: [], offsetMs: 0, trimStartMs: 0, trimEndMs: 0 })
  const [audioSync, setAudioSync] = useState<AudioSync>({ clips: [] })
  const [venueTrack, setVenueTrack] = useState<VenueTrackData>({
    autoGenerated: false,
    lighting: [],
    postProcessing: [],
    stage: [],
    performer: [],
    cameraCuts: []
  })
  const [currentTick, setCurrentTick] = useState(0)
  const [tempoEvents, setTempoEvents] = useState([{ tick: 0, bpm: 120 }])
  const [songDuration, setSongDuration] = useState(180)
  const [venueSelectionBox, setVenueSelectionBox] = useState<{ startX: number; currentX: number } | null>(null)

  useEffect(() => {
    setSelectedVenueEvent(null)
  }, [activeSongId, setSelectedVenueEvent])

  useEffect(() => {
    if (!activeSongId) return
    const store = getSongStore(activeSongId)
    const sync = (): void => {
      const state = store.getState()
      setVideoSync(state.song.videoSync)
      setAudioSync(state.song.audioSync)
      setVenueTrack(state.song.venueTrack)
      setCurrentTick(state.currentTick)
      setTempoEvents(state.song.tempoEvents)
      setSongDuration(state.song.metadata.song_length ? state.song.metadata.song_length / 1000 : getAudioDuration(activeSongId, state.song.audioSync) || 180)
    }
    sync()
    return store.subscribe(sync)
  }, [activeSongId])

  useEffect(() => {
    if (!activeSongId) return
    const updateDuration = (): void => {
      const state = getSongStore(activeSongId).getState()
      setSongDuration(state.song.metadata.song_length ? state.song.metadata.song_length / 1000 : getAudioDuration(activeSongId, state.song.audioSync) || 180)
    }
    updateDuration()
    return onAudioLoaded(activeSongId, updateDuration)
  }, [activeSongId])

  useEffect(() => {
    const videoPath = videoSync.videoPath
    if (!videoPath) return
    let cancelled = false

    const probe = async (): Promise<void> => {
      try {
        let blobUrl: string
        if (videoPath.startsWith('http')) {
          blobUrl = videoPath
        } else {
          const protocolUrl = `song-file://${encodeURIComponent(videoPath)}`
          const response = await fetch(protocolUrl)
          const blob = await response.blob()
          if (cancelled) return
          blobUrl = URL.createObjectURL(blob)
        }

        const videoEl = document.createElement('video')
        videoEl.preload = 'metadata'
        videoEl.src = blobUrl
        videoEl.onloadedmetadata = (): void => {
          if (cancelled) return
          const durationMs = videoEl.duration * 1000
          videoEl.removeAttribute('src')
          videoEl.load()
          if (blobUrl.startsWith('blob:')) URL.revokeObjectURL(blobUrl)

          if (activeSongId) {
            const store = getSongStore(activeSongId)
            const currentVideoSync = store.getState().song.videoSync
            if (currentVideoSync.clips.length === 0) {
              store.getState().updateVideoSync({
                clips: [{ id: `clip-${Date.now()}`, startMs: 0, sourceStartMs: 0, durationMs }]
              })
            }
          }
        }
        videoEl.onerror = (): void => {
          if (!cancelled && activeSongId) {
            const fallbackDurationMs = songDuration * 1000
            const store = getSongStore(activeSongId)
            const currentVideoSync = store.getState().song.videoSync
            if (currentVideoSync.clips.length === 0) {
              store.getState().updateVideoSync({
                clips: [{ id: `clip-${Date.now()}`, startMs: 0, sourceStartMs: 0, durationMs: fallbackDurationMs }]
              })
            }
          }
          if (blobUrl.startsWith('blob:')) URL.revokeObjectURL(blobUrl)
        }
      } catch (error) {
        console.warn('[Timeline] Failed to fetch video metadata', error)
      }
    }

    probe()
    return () => { cancelled = true }
  }, [videoSync.videoPath, songDuration, activeSongId])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        setDimensions({ width: width - TIMELINE_LABEL_WIDTH, height })
      }
    })
    resizeObserver.observe(container)
    return () => resizeObserver.disconnect()
  }, [])

  const handleScroll = useCallback((e: React.WheelEvent) => {
    e.stopPropagation()
    e.preventDefault()

    if (e.ctrlKey || e.metaKey) {
      const delta = e.deltaY > 0 ? 0.9 : 1.1
      setZoom((previous) => Math.max(0.1, Math.min(10, previous * delta)))
    } else if (e.shiftKey) {
      const horizontalDelta = e.deltaX + e.deltaY
      setScrollX((previous) => Math.max(0, previous + horizontalDelta))
    } else {
      if (timelineAreaRef.current) {
        timelineAreaRef.current.scrollTop += e.deltaY
      }
      if (Math.abs(e.deltaX) > 0) {
        setScrollX((previous) => Math.max(0, previous + e.deltaX))
      }
    }
  }, [])

  const withSongStore = useCallback((callback: (store: ReturnType<typeof getSongStore>) => void) => {
    if (!activeSongId) return
    callback(getSongStore(activeSongId))
  }, [activeSongId])

  const handleImportFile = useCallback(async () => {
    if (!activeSongId) return
    const store = getSongStore(activeSongId)
    const filePath = await window.api.openVideoDialog()
    if (!filePath) return
    const songPath = store.getState().song.folderPath
    const result = await window.api.importVideo(songPath, filePath)
    if (result) {
      store.getState().updateVideoSync({ videoPath: result.filePath, clips: [] })
    }
  }, [activeSongId])

  const handleImportUrl = useCallback(async (url: string) => {
    if (!activeSongId) return
    const store = getSongStore(activeSongId)
    const songPath = store.getState().song.folderPath

    if (/\.(mp4|webm|mkv|avi|mov)(\?|$)/i.test(url)) {
      store.getState().updateVideoSync({ videoPath: url, clips: [] })
      setShowUrlModal(false)
      return
    }

    setIsDownloading(true)
    setDownloadProgress(0)
    const unsubscribe = window.api.onDownloadProgress((percent) => setDownloadProgress(percent))

    try {
      const result = await window.api.downloadVideoUrl(songPath, url)
      unsubscribe()
      setIsDownloading(false)

      if (result.success && result.filePath) {
        store.getState().updateVideoSync({ videoPath: result.filePath, clips: [] })
        setShowUrlModal(false)
      } else {
        alert(`Download failed: ${result.error || 'Unknown error'}\n\nMake sure yt-dlp is installed and the URL is valid.`)
      }
    } catch (error) {
      unsubscribe()
      setIsDownloading(false)
      alert(`Download error: ${error}`)
    }
  }, [activeSongId])

  const handleRemoveVideo = useCallback(() => {
    withSongStore((store) => {
      store.getState().updateVideoSync({
        videoPath: undefined,
        clips: [],
        offsetMs: 0,
        trimStartMs: 0,
        trimEndMs: 0
      })
    })
    setSelectedClipId(null)
  }, [withSongStore])

  const handleImportAudio = useCallback(async () => {
    if (!activeSongId) return
    const store = getSongStore(activeSongId)
    const songPath = store.getState().song.folderPath
    const insertTimeMs = Math.round(tickToSeconds(store.getState().currentTick, store.getState().song.tempoEvents) * 1000)
    const filePath = await window.api.openAudioDialog()
    if (!filePath) return
    const result = await window.api.importAudio(songPath, filePath)
    if (!result) return
    await audioService.loadAudio(activeSongId, songPath)
    const sources = getAudioSources(activeSongId)
    const source = sources.find((entry) => entry.filePath === result.filePath) ?? sources.find((entry) => entry.filename === result.filename)
    store.getState().updateAudioSync({
      clips: [
        ...store.getState().song.audioSync.clips,
        {
          id: `audio-clip-${Date.now()}`,
          filePath: result.filePath,
          filename: result.filename,
          startMs: insertTimeMs,
          sourceStartMs: 0,
          durationMs: source ? Math.round(source.duration * 1000) : 0
        }
      ]
    })
  }, [activeSongId])

  const currentTime = useMemo(() => tickToSeconds(currentTick, tempoEvents), [currentTick, tempoEvents])

  const updateVenueLane = useCallback(<T extends VenueLaneKey>(lane: T, updater: (events: VenueTrackData[T]) => VenueTrackData[T]) => {
    withSongStore((store) => {
      const currentVenueTrack = store.getState().song.venueTrack
      store.getState().updateVenueTrack({ [lane]: updater(currentVenueTrack[lane]) } as Partial<VenueTrackData>)
    })
  }, [withSongStore])

  const handleSplitAtPlayhead = useCallback(() => {
    if (!activeSongId || !videoSync.videoPath) return
    const splitMs = currentTime * 1000
    const store = getSongStore(activeSongId)
    const currentVideoSync = store.getState().song.videoSync
    const clipIndex = currentVideoSync.clips.findIndex((clip) => splitMs > clip.startMs && splitMs < clip.startMs + clip.durationMs)
    if (clipIndex < 0) return

    const clip = currentVideoSync.clips[clipIndex]
    const splitOffsetInClip = splitMs - clip.startMs
    const leftClip: VideoClip = {
      id: clip.id,
      startMs: clip.startMs,
      sourceStartMs: clip.sourceStartMs,
      durationMs: splitOffsetInClip
    }
    const rightClip: VideoClip = {
      id: `clip-${Date.now()}`,
      startMs: splitMs,
      sourceStartMs: clip.sourceStartMs + splitOffsetInClip,
      durationMs: clip.durationMs - splitOffsetInClip
    }

    const nextClips = [...currentVideoSync.clips]
    nextClips.splice(clipIndex, 1, leftClip, rightClip)
    store.getState().updateVideoSync({ clips: nextClips })
  }, [activeSongId, currentTime, videoSync.videoPath])

  const handleDeleteClip = useCallback(() => {
    if (!selectedClipId) return
    withSongStore((store) => {
      store.getState().updateVideoSync({
        clips: store.getState().song.videoSync.clips.filter((clip) => clip.id !== selectedClipId)
      })
    })
    setSelectedClipId(null)
  }, [selectedClipId, withSongStore])

  const handleDeleteAudioClip = useCallback(() => {
    if (!selectedAudioClipId) return
    withSongStore((store) => {
      store.getState().updateAudioSync({
        clips: store.getState().song.audioSync.clips.filter((clip) => clip.id !== selectedAudioClipId)
      })
    })
    setSelectedAudioClipId(null)
  }, [selectedAudioClipId, withSongStore])

  const handleMoveClip = useCallback((clipId: string, newStartMs: number) => {
    withSongStore((store) => {
      store.getState().updateVideoSync({
        clips: store.getState().song.videoSync.clips.map((clip) => (
          clip.id === clipId ? { ...clip, startMs: Math.max(0, newStartMs) } : clip
        ))
      })
    })
  }, [withSongStore])

  const handleMoveAudioClip = useCallback((clipId: string, newStartMs: number) => {
    withSongStore((store) => {
      store.getState().updateAudioSync({
        clips: store.getState().song.audioSync.clips.map((clip) => (
          clip.id === clipId ? { ...clip, startMs: Math.max(0, Math.round(newStartMs)) } : clip
        ))
      })
    })
  }, [withSongStore])

  const handleSelectAudioClip = useCallback((clipId: string | null) => {
    setSelectedAudioClipId(clipId)
    setSelectedClipId(null)
    setSelectedVenueEvent(null)
  }, [])

  const handleSelectVideoClip = useCallback((clipId: string | null) => {
    setSelectedClipId(clipId)
    setSelectedAudioClipId(null)
    setSelectedVenueEvent(null)
  }, [])

  const handleSelectVenue = useCallback((lane: VenueLaneKey, eventId: string | null) => {
    setSelectedVenueEvent(eventId ? { lane, id: eventId } : null)
    setSelectedClipId(null)
    setSelectedAudioClipId(null)
  }, [])

  const handleSelectVenueRange = useCallback((startTick: number, endTick: number) => {
    const lanes: VenueLaneKey[] = ['lighting', 'postProcessing', 'stage', 'cameraCuts', 'performer']
    const hits: SelectedVenueEventRef[] = []

    for (const lane of lanes) {
      const laneEvents = venueTrack[lane] as VenueEvent[]
      for (const event of laneEvents) {
        if (event.tick >= startTick && event.tick <= endTick) {
          hits.push({ lane, id: event.id })
        }
      }
    }

    if (hits.length === 0) {
      setSelectedVenueEvent(null)
      return
    }

    hits.sort((a, b) => {
      const aTick = (venueTrack[a.lane] as VenueEvent[]).find((event) => event.id === a.id)?.tick ?? 0
      const bTick = (venueTrack[b.lane] as VenueEvent[]).find((event) => event.id === b.id)?.tick ?? 0
      return aTick - bTick
    })

    setSelectedVenueEvent(hits[0])
    setSelectedClipId(null)
    setSelectedAudioClipId(null)
  }, [setSelectedVenueEvent, venueTrack])

  const handleMoveVenueEvent = useCallback((lane: VenueLaneKey, eventId: string, newTick: number) => {
    updateVenueLane(lane, (events) => sortByTick(events.map((event) => (
      event.id === eventId ? { ...event, tick: Math.max(0, newTick) } : event
    ))))
  }, [updateVenueLane])

  const handleResizeVenueEvent = useCallback((lane: 'stage' | 'performer', eventId: string, newDuration: number) => {
    updateVenueLane(lane, (events) => sortByTick(events.map((event) => (
      event.id === eventId ? { ...event, duration: Math.max(VENUE_MIN_DURATION_TICKS, newDuration) } : event
    ))))
  }, [updateVenueLane])

  const addLightingEvent = useCallback(() => {
    const event: VenueLightingEvent = { id: createVenueId('lighting'), tick: currentTick, type: 'verse' }
    updateVenueLane('lighting', (events) => sortByTick([...events, event]))
    setSelectedVenueEvent({ lane: 'lighting', id: event.id })
  }, [currentTick, updateVenueLane])

  const addPostProcessingEvent = useCallback(() => {
    const event: VenuePostProcessingEvent = { id: createVenueId('post'), tick: currentTick, type: 'bloom.pp' }
    updateVenueLane('postProcessing', (events) => sortByTick([...events, event]))
    setSelectedVenueEvent({ lane: 'postProcessing', id: event.id })
  }, [currentTick, updateVenueLane])

  const addStageEvent = useCallback(() => {
    const event: VenueStageEvent = { id: createVenueId('stage'), tick: currentTick, effect: 'FogOn' }
    updateVenueLane('stage', (events) => sortByTick([...events, event]))
    setSelectedVenueEvent({ lane: 'stage', id: event.id })
  }, [currentTick, updateVenueLane])

  const addCameraCutEvent = useCallback(() => {
    const event: VenueCameraCutEvent = { id: createVenueId('camera'), tick: currentTick, subject: 'coop_all_near' }
    updateVenueLane('cameraCuts', (events) => sortByTick([...events, event]))
    setSelectedVenueEvent({ lane: 'cameraCuts', id: event.id })
  }, [currentTick, updateVenueLane])

  const addPerformerEvent = useCallback(() => {
    const event: VenuePerformerEvent = { id: createVenueId('performer'), tick: currentTick, duration: 480, type: 'spotlight', performer: 'vocals' }
    updateVenueLane('performer', (events) => sortByTick([...events, event]))
    setSelectedVenueEvent({ lane: 'performer', id: event.id })
  }, [currentTick, updateVenueLane])

  const selectedVenueEventData = useMemo(() => {
    if (!selectedVenueEvent) return null
    switch (selectedVenueEvent.lane) {
      case 'lighting':
        return venueTrack.lighting.find((event) => event.id === selectedVenueEvent.id) ?? null
      case 'postProcessing':
        return venueTrack.postProcessing.find((event) => event.id === selectedVenueEvent.id) ?? null
      case 'stage':
        return venueTrack.stage.find((event) => event.id === selectedVenueEvent.id) ?? null
      case 'cameraCuts':
        return venueTrack.cameraCuts.find((event) => event.id === selectedVenueEvent.id) ?? null
      case 'performer':
        return venueTrack.performer.find((event) => event.id === selectedVenueEvent.id) ?? null
      default:
        return null
    }
  }, [selectedVenueEvent, venueTrack])

  const selectedLightingEvent = selectedVenueEvent?.lane === 'lighting'
    ? venueTrack.lighting.find((event) => event.id === selectedVenueEvent.id) ?? null
    : null
  const selectedPostProcessingEvent = selectedVenueEvent?.lane === 'postProcessing'
    ? venueTrack.postProcessing.find((event) => event.id === selectedVenueEvent.id) ?? null
    : null
  const selectedStageEvent = selectedVenueEvent?.lane === 'stage'
    ? venueTrack.stage.find((event) => event.id === selectedVenueEvent.id) ?? null
    : null
  const selectedCameraCutEvent = selectedVenueEvent?.lane === 'cameraCuts'
    ? venueTrack.cameraCuts.find((event) => event.id === selectedVenueEvent.id) ?? null
    : null
  const selectedPerformerEvent = selectedVenueEvent?.lane === 'performer'
    ? venueTrack.performer.find((event) => event.id === selectedVenueEvent.id) ?? null
    : null

  const selectedVenueHelpText = useMemo(() => {
    if (!selectedVenueEvent || !selectedVenueEventData) {
      return 'Venue events control visuals only (lights, post effects, stage FX, camera cuts, performer spotlights). Drag to place. Stage/Performer events can be resized from the right edge. Hold Shift while dragging for fine adjustment.'
    }

    if (selectedLightingEvent) {
      return `Lighting cue "${formatVenueLabel(selectedLightingEvent.type)}" changes the stage lighting look at this tick.`
    }
    if (selectedPostProcessingEvent) {
      return `Post FX "${formatVenueLabel(selectedPostProcessingEvent.type)}" applies a screen-space effect at this tick.`
    }
    if (selectedStageEvent) {
      const durationTicks = selectedStageEvent.duration ?? 0
      return `Stage FX "${formatVenueLabel(selectedStageEvent.effect)}" triggers venue stage behavior${durationTicks > 0 ? ` for ${durationTicks} ticks` : ''}.`
    }
    if (selectedCameraCutEvent) {
      return `Camera cut "${formatVenueLabel(selectedCameraCutEvent.subject)}" chooses the shot used by the venue camera at this tick.`
    }
    if (selectedPerformerEvent) {
      return `Performer event "${formatVenueLabel(selectedPerformerEvent.type)}" targets ${formatVenueLabel(selectedPerformerEvent.performer ?? 'performer')} for ${selectedPerformerEvent.duration} ticks.`
    }

    return `Selected ${getVenueLaneLabel(selectedVenueEvent.lane)} event at tick ${selectedVenueEventData.tick}.`
  }, [
    selectedVenueEvent,
    selectedVenueEventData,
    selectedLightingEvent,
    selectedPostProcessingEvent,
    selectedStageEvent,
    selectedCameraCutEvent,
    selectedPerformerEvent
  ])

  const selectedVenueEventName = useMemo(() => {
    if (selectedLightingEvent) return formatVenueLabel(selectedLightingEvent.type)
    if (selectedPostProcessingEvent) return formatVenueLabel(selectedPostProcessingEvent.type)
    if (selectedStageEvent) return formatVenueLabel(selectedStageEvent.effect)
    if (selectedCameraCutEvent) return formatVenueLabel(selectedCameraCutEvent.subject)
    if (selectedPerformerEvent) {
      return `${formatVenueLabel(selectedPerformerEvent.type)} ${formatVenueLabel(selectedPerformerEvent.performer ?? '')}`.trim()
    }
    return 'Event'
  }, [selectedLightingEvent, selectedPostProcessingEvent, selectedStageEvent, selectedCameraCutEvent, selectedPerformerEvent])

  const updateSelectedVenueEvent = useCallback((updates: Partial<VenueEvent>) => {
    if (!selectedVenueEvent) return
    updateVenueLane(selectedVenueEvent.lane, (events) => sortByTick(events.map((event) => (
      event.id === selectedVenueEvent.id ? { ...event, ...updates } : event
    ))))
  }, [selectedVenueEvent, updateVenueLane])

  const handleDeleteVenueEvent = useCallback(() => {
    if (!selectedVenueEvent) return
    switch (selectedVenueEvent.lane) {
      case 'lighting':
        updateVenueLane('lighting', (events) => events.filter((event) => event.id !== selectedVenueEvent.id))
        break
      case 'postProcessing':
        updateVenueLane('postProcessing', (events) => events.filter((event) => event.id !== selectedVenueEvent.id))
        break
      case 'stage':
        updateVenueLane('stage', (events) => events.filter((event) => event.id !== selectedVenueEvent.id))
        break
      case 'cameraCuts':
        updateVenueLane('cameraCuts', (events) => events.filter((event) => event.id !== selectedVenueEvent.id))
        break
      case 'performer':
        updateVenueLane('performer', (events) => events.filter((event) => event.id !== selectedVenueEvent.id))
        break
      default:
        break
    }
    setSelectedVenueEvent(null)
  }, [selectedVenueEvent, updateVenueLane])

  const handleDeleteVenueEventById = useCallback((lane: VenueLaneKey, id: string) => {
    updateVenueLane(lane, (events) => (events as VenueEvent[]).filter((event) => event.id !== id) as typeof events)
    if (selectedVenueEvent?.id === id) {
      setSelectedVenueEvent(null)
    }
  }, [selectedVenueEvent, setSelectedVenueEvent, updateVenueLane])

  const handleExport = useCallback(async () => {
    if (!activeSongId || !videoSync.videoPath) return
    const store = getSongStore(activeSongId)
    const state = store.getState()
    if (!state.song.audioPath) {
      alert('No audio loaded to export with video')
      return
    }

    const outputPath = await window.api.saveVideoDialog()
    if (!outputPath) return

    setExportProgress(0)
    const unsubscribe = window.api.onExportProgress((percent) => setExportProgress(percent))
    const result = await window.api.exportVideo({
      videoPath: videoSync.videoPath,
      audioPath: state.song.audioPath,
      outputPath,
      offsetMs: videoSync.offsetMs,
      trimStartMs: videoSync.trimStartMs,
      trimEndMs: videoSync.trimEndMs
    })
    unsubscribe()
    setExportProgress(null)

    if (result.success) {
      alert('Export complete!')
    } else {
      alert(`Export failed: ${result.error}`)
    }
  }, [activeSongId, videoSync])

  const handleSeek = useCallback((seconds: number) => {
    if (!activeSongId) return
    const store = getSongStore(activeSongId)
    const state = store.getState()
    const newTick = secondsToTick(Math.max(0, seconds), state.song.tempoEvents)
    store.getState().setCurrentTick(newTick)
    if (state.isPlaying) {
      audioService.seek(activeSongId, newTick, state.song.tempoEvents, state.song.audioSync)
    }
  }, [activeSongId])

  const handleTimelineClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('.video-clip') || target.closest('.audio-clip') || target.closest('.venue-event') || target.closest('.video-playhead')) return
    const timeline = target.closest('.audio-track-timeline, .video-track-timeline, .venue-track-timeline') as HTMLElement | null
    if (!timeline) return
    const rect = timeline.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const pps = VIDEO_EDITOR_CONFIG.pixelsPerSecond * zoom
    const seconds = (clickX + scrollX) / pps
    setSelectedClipId(null)
    setSelectedAudioClipId(null)
    handleSeek(seconds)
  }, [handleSeek, scrollX, zoom])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const tagName = target?.tagName.toLowerCase()
      const isTextField = tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target?.isContentEditable
      if (isTextField) return

      if (e.key === 'Delete') {
        if (selectedAudioClipId) {
          handleDeleteAudioClip()
        } else if (selectedClipId) {
          handleDeleteClip()
        } else if (selectedVenueEvent) {
          handleDeleteVenueEvent()
        }
        return
      }

      if (!selectedVenueEvent) return
      const step = e.shiftKey ? 10 : 120

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const direction = e.key === 'ArrowLeft' ? -1 : 1
        const currentTick = selectedVenueEventData?.tick ?? 0
        const nextTick = Math.max(0, currentTick + direction * step)
        handleMoveVenueEvent(selectedVenueEvent.lane, selectedVenueEvent.id, nextTick)
        return
      }

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (selectedVenueEvent.lane !== 'stage' && selectedVenueEvent.lane !== 'performer') return
        e.preventDefault()
        const direction = e.key === 'ArrowDown' ? -1 : 1
        const currentDuration = (selectedVenueEventData as VenueStageEvent | VenuePerformerEvent | null)?.duration ?? VENUE_MIN_DURATION_TICKS
        const nextDuration = Math.max(VENUE_MIN_DURATION_TICKS, currentDuration + direction * step)
        handleResizeVenueEvent(selectedVenueEvent.lane, selectedVenueEvent.id, nextDuration)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    handleDeleteAudioClip,
    handleDeleteClip,
    handleDeleteVenueEvent,
    handleMoveVenueEvent,
    handleResizeVenueEvent,
    selectedAudioClipId,
    selectedClipId,
    selectedVenueEvent,
    selectedVenueEventData
  ])

  if (!activeSongId) {
    return (
      <div className="video-editor">
        <div className="empty-state">
          <div className="empty-state-icon">🎬</div>
          <div className="empty-state-title">No Song Selected</div>
          <div className="empty-state-description">Select a song to edit media sync and venue events.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="video-editor" ref={containerRef}>
      <div className="video-toolbar">
        <button className="video-toolbar-button" onClick={handleImportFile} title="Import video from file">Import File</button>
        <button className="video-toolbar-button" onClick={handleImportAudio} title="Import an additional audio source onto the timeline">Add Audio</button>
        <button className="video-toolbar-button" onClick={() => setShowUrlModal(true)} title="Import video from URL (YouTube, etc.)">Import URL</button>
        <button className="video-toolbar-button" onClick={addLightingEvent} title="Add a lighting cue at the playhead">💡 Lighting</button>
        <button className="video-toolbar-button" onClick={addPostProcessingEvent} title="Add a post-processing effect at the playhead">✨ Post FX</button>
        <button className="video-toolbar-button" onClick={addStageEvent} title="Add a stage effect at the playhead">🎭 Stage FX</button>
        <button className="video-toolbar-button" onClick={addCameraCutEvent} title="Add a venue camera cut at the playhead">🎥 Camera Cut</button>
        <button className="video-toolbar-button" onClick={addPerformerEvent} title="Add a performer spotlight/singalong event at the playhead">🎤 Performer</button>
        {videoSync.videoPath && (
          <>
            <button className="video-toolbar-button video-toolbar-button-danger" onClick={handleRemoveVideo} title="Remove the imported video">Remove Video</button>
            <div className="video-toolbar-divider" />
            <button className="video-toolbar-button" onClick={handleSplitAtPlayhead} title="Split the selected video clip at the playhead">Split</button>
          </>
        )}
        {selectedAudioClipId && <button className="video-toolbar-button video-toolbar-button-danger" onClick={handleDeleteAudioClip} title="Delete selected audio clip">Delete Audio</button>}
        {selectedClipId && <button className="video-toolbar-button video-toolbar-button-danger" onClick={handleDeleteClip} title="Delete selected video clip">Delete Clip</button>}
        {selectedVenueEvent && (
          <button
            className="video-toolbar-button video-toolbar-button-danger"
            onClick={handleDeleteVenueEvent}
            title={`Delete selected ${getVenueLaneLabel(selectedVenueEvent.lane)} event`}
          >
            Delete {getVenueLaneLabel(selectedVenueEvent.lane)}
          </button>
        )}
        <div className="video-toolbar-spacer" />
        {videoSync.videoPath && (
          <button className="video-toolbar-button" onClick={handleExport} disabled={exportProgress !== null} title="Export video with chart audio">
            {exportProgress !== null ? `Exporting ${exportProgress}%` : 'Export'}
          </button>
        )}
        <div className="video-zoom-controls">
          <label>Zoom:</label>
          <button onClick={() => setZoom((value) => Math.max(0.1, value * 0.8))}>-</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((value) => Math.min(10, value * 1.25))}>+</button>
        </div>
      </div>

      <div className="video-toolbar video-toolbar-help" role="status" aria-live="polite">
        <span className="video-help-label">Venue Help</span>
        <span className="video-help-text">{selectedVenueHelpText}</span>
      </div>

      {selectedVenueEvent && selectedVenueEventData && (
        <div className="video-toolbar video-toolbar-secondary">
          <div className="video-toolbar-info">
            <span className="video-info-label">Lane</span>
            <span>{getVenueLaneLabel(selectedVenueEvent.lane)}</span>
          </div>
          <div className="video-toolbar-info video-toolbar-field-wide">
            <span className="video-info-label">Event</span>
            <span>{selectedVenueEventName}</span>
          </div>
          <div className="video-toolbar-info">
            <span className="video-info-label">Tick</span>
            <input
              className="video-info-input"
              type="number"
              min={0}
              value={selectedVenueEventData.tick}
              onChange={(e) => updateSelectedVenueEvent({ tick: Math.max(0, Number(e.target.value) || 0) })}
            />
          </div>
          {selectedLightingEvent && (
            <div className="video-toolbar-info video-toolbar-field-wide">
              <span className="video-info-label">Cue</span>
              <select
                className="video-toolbar-select"
                value={selectedLightingEvent.type}
                onChange={(e) => updateSelectedVenueEvent({ type: e.target.value })}
              >
                {uniqueOptions(LIGHTING_PRESETS, selectedLightingEvent.type).map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </div>
          )}
          {selectedPostProcessingEvent && (
            <div className="video-toolbar-info video-toolbar-field-wide">
              <span className="video-info-label">Effect</span>
              <select
                className="video-toolbar-select"
                value={selectedPostProcessingEvent.type}
                onChange={(e) => updateSelectedVenueEvent({ type: e.target.value })}
              >
                {uniqueOptions(POST_PROCESSING_PRESETS, selectedPostProcessingEvent.type).map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </div>
          )}
          {selectedStageEvent && (
            <div className="video-toolbar-info video-toolbar-field-wide">
              <span className="video-info-label">Stage</span>
              <select
                className="video-toolbar-select"
                value={selectedStageEvent.effect}
                onChange={(e) => updateSelectedVenueEvent({ effect: e.target.value })}
              >
                {uniqueOptions(STAGE_PRESETS, selectedStageEvent.effect).map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </div>
          )}
          {selectedCameraCutEvent && (
            <div className="video-toolbar-info video-toolbar-field-wide">
              <span className="video-info-label">Cut</span>
              <select
                className="video-toolbar-select"
                value={selectedCameraCutEvent.subject}
                onChange={(e) => updateSelectedVenueEvent({ subject: e.target.value })}
              >
                {uniqueOptions(CAMERA_CUT_PRESETS, selectedCameraCutEvent.subject).map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </div>
          )}
          {selectedPerformerEvent && (
            <>
              <div className="video-toolbar-info video-toolbar-field-wide">
                <span className="video-info-label">Type</span>
                <select
                  className="video-toolbar-select"
                  value={selectedPerformerEvent.type}
                  onChange={(e) => updateSelectedVenueEvent({ type: e.target.value })}
                >
                  {uniqueOptions(PERFORMER_TYPE_PRESETS, selectedPerformerEvent.type).map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>
              <div className="video-toolbar-info video-toolbar-field-wide">
                <span className="video-info-label">Performer</span>
                <select
                  className="video-toolbar-select"
                  value={selectedPerformerEvent.performer ?? 'vocals'}
                  onChange={(e) => updateSelectedVenueEvent({ performer: e.target.value })}
                >
                  {uniqueOptions(PERFORMER_TARGET_PRESETS, selectedPerformerEvent.performer).map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>
              <div className="video-toolbar-info">
                <span className="video-info-label">Duration</span>
                <input
                  className="video-info-input"
                  type="number"
                  min={0}
                  value={selectedPerformerEvent.duration}
                  onChange={(e) => updateSelectedVenueEvent({ duration: Math.max(0, Number(e.target.value) || 0) })}
                />
              </div>
            </>
          )}
        </div>
      )}

      <div className="video-timeline-area" ref={timelineAreaRef} onWheel={handleScroll}>
        <div className="video-ruler-row">
          <div className="video-track-label-spacer" />
          <TimelineRuler duration={songDuration} scrollX={scrollX} zoom={zoom} width={dimensions.width} />
        </div>

        <div className="video-tracks" onClick={handleTimelineClick}>
          <AudioTrack
            songId={activeSongId}
            scrollX={scrollX}
            zoom={zoom}
            width={dimensions.width}
            clips={audioSync.clips}
            selectedClipId={selectedAudioClipId}
            onSelectClip={handleSelectAudioClip}
            onMoveClip={handleMoveAudioClip}
          />
          <VideoTrack
            videoPath={videoSync.videoPath}
            clips={videoSync.clips}
            scrollX={scrollX}
            zoom={zoom}
            width={dimensions.width}
            selectedClipId={selectedClipId}
            onSelectClip={handleSelectVideoClip}
            onMoveClip={handleMoveClip}
          />
          <VenueTrack
            laneKey="lighting"
            label="Lighting"
            icon="💡"
            tone="lighting"
            events={venueTrack.lighting}
            tempoEvents={tempoEvents}
            scrollX={scrollX}
            zoom={zoom}
            width={dimensions.width}
            selectedEventId={selectedVenueEvent?.lane === 'lighting' ? selectedVenueEvent.id : null}
            onSelectEvent={(id) => handleSelectVenue('lighting', id)}
            onSelectRange={handleSelectVenueRange}
            sharedSelectionBox={venueSelectionBox}
            onSharedSelectionBoxChange={setVenueSelectionBox}
            onMoveEvent={(id, tick) => handleMoveVenueEvent('lighting', id, tick)}
            onDeleteEvent={(id) => handleDeleteVenueEventById('lighting', id)}
            getEventLabel={(event) => formatVenueLabel((event as VenueLightingEvent).type)}
          />
          <VenueTrack
            laneKey="postProcessing"
            label="Post FX"
            icon="✨"
            tone="post"
            events={venueTrack.postProcessing}
            tempoEvents={tempoEvents}
            scrollX={scrollX}
            zoom={zoom}
            width={dimensions.width}
            selectedEventId={selectedVenueEvent?.lane === 'postProcessing' ? selectedVenueEvent.id : null}
            onSelectEvent={(id) => handleSelectVenue('postProcessing', id)}
            onSelectRange={handleSelectVenueRange}
            sharedSelectionBox={venueSelectionBox}
            onSharedSelectionBoxChange={setVenueSelectionBox}
            onMoveEvent={(id, tick) => handleMoveVenueEvent('postProcessing', id, tick)}
            onDeleteEvent={(id) => handleDeleteVenueEventById('postProcessing', id)}
            getEventLabel={(event) => formatVenueLabel((event as VenuePostProcessingEvent).type)}
          />
          <VenueTrack
            laneKey="stage"
            label="Stage"
            icon="🎭"
            tone="stage"
            events={venueTrack.stage}
            tempoEvents={tempoEvents}
            scrollX={scrollX}
            zoom={zoom}
            width={dimensions.width}
            selectedEventId={selectedVenueEvent?.lane === 'stage' ? selectedVenueEvent.id : null}
            onSelectEvent={(id) => handleSelectVenue('stage', id)}
            onSelectRange={handleSelectVenueRange}
            sharedSelectionBox={venueSelectionBox}
            onSharedSelectionBoxChange={setVenueSelectionBox}
            onMoveEvent={(id, tick) => handleMoveVenueEvent('stage', id, tick)}
            onDeleteEvent={(id) => handleDeleteVenueEventById('stage', id)}
            onResizeEvent={(id, duration) => handleResizeVenueEvent('stage', id, duration)}
            getEventLabel={(event) => formatVenueLabel((event as VenueStageEvent).effect)}
            getEventDuration={(event) => (event as VenueStageEvent).duration ?? 0}
          />
          <VenueTrack
            laneKey="cameraCuts"
            label="Camera"
            icon="🎥"
            tone="camera"
            events={venueTrack.cameraCuts}
            tempoEvents={tempoEvents}
            scrollX={scrollX}
            zoom={zoom}
            width={dimensions.width}
            selectedEventId={selectedVenueEvent?.lane === 'cameraCuts' ? selectedVenueEvent.id : null}
            onSelectEvent={(id) => handleSelectVenue('cameraCuts', id)}
            onSelectRange={handleSelectVenueRange}
            sharedSelectionBox={venueSelectionBox}
            onSharedSelectionBoxChange={setVenueSelectionBox}
            onMoveEvent={(id, tick) => handleMoveVenueEvent('cameraCuts', id, tick)}
            onDeleteEvent={(id) => handleDeleteVenueEventById('cameraCuts', id)}
            getEventLabel={(event) => formatVenueLabel((event as VenueCameraCutEvent).subject)}
          />
          <VenueTrack
            laneKey="performer"
            label="Performer"
            icon="🎤"
            tone="performer"
            events={venueTrack.performer}
            tempoEvents={tempoEvents}
            scrollX={scrollX}
            zoom={zoom}
            width={dimensions.width}
            selectedEventId={selectedVenueEvent?.lane === 'performer' ? selectedVenueEvent.id : null}
            onSelectEvent={(id) => handleSelectVenue('performer', id)}
            onSelectRange={handleSelectVenueRange}
            sharedSelectionBox={venueSelectionBox}
            onSharedSelectionBoxChange={setVenueSelectionBox}
            onMoveEvent={(id, tick) => handleMoveVenueEvent('performer', id, tick)}
            onDeleteEvent={(id) => handleDeleteVenueEventById('performer', id)}
            onResizeEvent={(id, duration) => handleResizeVenueEvent('performer', id, duration)}
            getEventLabel={(event) => {
              const performerEvent = event as VenuePerformerEvent
              return `${formatVenueLabel(performerEvent.type)} ${formatVenueLabel(performerEvent.performer ?? '')}`.trim()
            }}
            getEventDuration={(event) => (event as VenuePerformerEvent).duration}
          />

          <Playhead currentTime={currentTime} scrollX={scrollX} zoom={zoom} height={VIDEO_EDITOR_CONFIG.playheadHeight} onSeek={handleSeek} />
        </div>
      </div>

      {showUrlModal && (
        <URLImportModal
          onSubmit={handleImportUrl}
          onCancel={() => setShowUrlModal(false)}
          isDownloading={isDownloading}
          downloadProgress={downloadProgress}
        />
      )}
    </div>
  )
}
