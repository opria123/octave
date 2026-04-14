// Video Editor - Timeline editor for background video sync
import { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import { useProjectStore, getSongStore } from '../stores'
import { tickToSeconds, secondsToTick, getAudioBuffers, getAudioDuration } from '../services/audioService'
import * as audioService from '../services/audioService'
import type { VideoSync, VideoClip } from '../types'
import './VideoEditor.css'

// Configuration
const VIDEO_EDITOR_CONFIG = {
  pixelsPerSecond: 50,
  waveformHeight: 50,
  rulerHeight: 24,
  trackHeight: 50
}

// ── Utility: generate waveform peaks from AudioBuffer ─────────────────
function generateWaveformPeaks(buffers: AudioBuffer[], samplesPerPixel: number): Float32Array {
  if (buffers.length === 0) return new Float32Array(0)
  const primary = buffers[0]
  const channel = primary.getChannelData(0)
  const totalPixels = Math.ceil(channel.length / samplesPerPixel)
  const peaks = new Float32Array(totalPixels)
  for (let i = 0; i < totalPixels; i++) {
    let max = 0
    const start = i * samplesPerPixel
    const end = Math.min(start + samplesPerPixel, channel.length)
    for (let j = start; j < end; j++) {
      const abs = Math.abs(channel[j])
      if (abs > max) max = abs
    }
    peaks[i] = max
  }
  return peaks
}

// ── Timeline Ruler ────────────────────────────────────────────────────
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
      ctx.beginPath(); ctx.moveTo(x, 16); ctx.lineTo(x, 24); ctx.stroke()
      const m = Math.floor(sec / 60)
      const s = sec % 60
      ctx.fillText(`${m}:${s.toString().padStart(2, '0')}`, x + 4, 12)
      if (sec < duration) {
        const halfX = x + pps / 2
        ctx.beginPath(); ctx.moveTo(halfX, 20); ctx.lineTo(halfX, 24); ctx.stroke()
      }
    }
  }, [duration, scrollX, zoom, width])

  return <canvas ref={canvasRef} className="video-timeline-ruler" />
}

// ── Audio Waveform Track (real data) ──────────────────────────────────
function AudioTrack({
  songId, duration: _duration, scrollX, zoom, width
}: {
  songId: string; duration: number; scrollX: number; zoom: number; width: number
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [peaks, setPeaks] = useState<Float32Array | null>(null)
  const [audioReady, setAudioReady] = useState(false)

  // Re-check for audio buffers periodically until loaded
  useEffect(() => {
    const check = (): boolean => {
      const buffers = getAudioBuffers(songId)
      if (buffers.length > 0) {
        setAudioReady(true)
        return true
      }
      return false
    }
    if (check()) return
    const interval = setInterval(() => { if (check()) clearInterval(interval) }, 500)
    return () => clearInterval(interval)
  }, [songId])

  // Generate peaks once audio is ready
  useEffect(() => {
    if (!audioReady) return
    const buffers = getAudioBuffers(songId)
    if (buffers.length === 0) { setPeaks(null); return }
    const primary = buffers[0]
    const spp = Math.floor(primary.sampleRate / VIDEO_EDITOR_CONFIG.pixelsPerSecond)
    setPeaks(generateWaveformPeaks(buffers, spp))
  }, [songId, audioReady])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const h = VIDEO_EDITOR_CONFIG.waveformHeight
    canvas.width = width
    canvas.height = h
    ctx.fillStyle = '#1a1a2e'
    ctx.fillRect(0, 0, width, h)
    if (!peaks || peaks.length === 0) return
    const centerY = h / 2
    ctx.fillStyle = '#4488FF'
    for (let x = 0; x < width; x++) {
      const peakIdx = Math.floor((x + scrollX) / zoom)
      if (peakIdx < 0 || peakIdx >= peaks.length) continue
      const amp = peaks[peakIdx] * (h / 2 - 2)
      ctx.fillRect(x, centerY - amp, 1, amp * 2)
    }
  }, [peaks, scrollX, zoom, width])

  const audioLoaded = getAudioBuffers(songId).length > 0

  return (
    <div className="audio-track">
      <div className="audio-track-label"><span>🎵</span><span>Audio</span></div>
      <div className="audio-track-timeline" style={{ width }}>
        <canvas ref={canvasRef} className="audio-waveform-canvas" />
        {!audioLoaded && (
          <div className="audio-track-empty"><span>No audio loaded</span></div>
        )}
      </div>
    </div>
  )
}

// ── Video Track with Clips ────────────────────────────────────────────
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
      <div className="video-track-label"><span>🎬</span><span>Video</span></div>
      <div className="video-track-timeline" style={{ width }} onClick={() => onSelectClip(null)}>
        {videoPath && clips.length > 0 ? clips.map((clip) => {
          const clipX = clip.startMs * ppm - scrollX
          const clipW = Math.max(10, clip.durationMs * ppm)
          const isSelected = clip.id === selectedClipId
          return (
            <div
              key={clip.id}
              className={`video-clip ${isSelected ? 'selected' : ''} ${dragInfo?.clipId === clip.id ? 'dragging' : ''}`}
              style={{ left: clipX, width: clipW }}
              onMouseDown={(e) => handleClipMouseDown(e, clip)}
            >
              <div className="video-clip-content">
                <span className="video-clip-name">
                  {(clip.sourceStartMs / 1000).toFixed(1)}s – {((clip.sourceStartMs + clip.durationMs) / 1000).toFixed(1)}s
                </span>
              </div>
            </div>
          )
        }) : !videoPath ? (
          <div className="video-track-empty"><span>No video loaded — click Import Video</span></div>
        ) : (
          <div className="video-track-empty"><span>No video loaded — click Import Video</span></div>
        )}
      </div>
    </div>
  )
}

// ── Playhead (draggable) ──────────────────────────────────────────────
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

// ── URL Import Modal ──────────────────────────────────────────────────
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
          onKeyDown={(e) => { if (e.key === 'Enter' && url.trim() && !isDownloading) onSubmit(url.trim()) }}
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

// ── Main Video Editor ─────────────────────────────────────────────────
export function VideoEditor(): React.JSX.Element {
  const { activeSongId } = useProjectStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 200 })
  const [scrollX, setScrollX] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [showUrlModal, setShowUrlModal] = useState(false)
  const [exportProgress, setExportProgress] = useState<number | null>(null)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [isDownloading, setIsDownloading] = useState(false)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)

  // Subscribe to song store state
  const [videoSync, setVideoSync] = useState<VideoSync>({ clips: [], offsetMs: 0, trimStartMs: 0, trimEndMs: 0 })
  const [currentTick, setCurrentTick] = useState(0)
  const [tempoEvents, setTempoEvents] = useState([{ tick: 0, bpm: 120 }])
  const [songDuration, setSongDuration] = useState(180)

  useEffect(() => {
    if (!activeSongId) return
    const store = getSongStore(activeSongId)
    const sync = (): void => {
      const s = store.getState()
      setVideoSync(s.song.videoSync)
      setCurrentTick(s.currentTick)
      setTempoEvents(s.song.tempoEvents)
      setSongDuration(s.song.metadata.song_length ? s.song.metadata.song_length / 1000 : getAudioDuration(activeSongId) || 180)
    }
    sync()
    return store.subscribe(sync)
  }, [activeSongId])

  // Probe video duration & auto-create initial clip if no clips exist
  useEffect(() => {
    if (!videoSync.videoPath) return
    let cancelled = false

    const probe = async (): Promise<void> => {
      try {
        let blobUrl: string
        if (videoSync.videoPath!.startsWith('http')) {
          blobUrl = videoSync.videoPath!
        } else {
          const protocolUrl = `song-file://${encodeURIComponent(videoSync.videoPath!)}`
          const res = await fetch(protocolUrl)
          const blob = await res.blob()
          if (cancelled) return
          blobUrl = URL.createObjectURL(blob)
        }

        const videoEl = document.createElement('video')
        videoEl.preload = 'metadata'
        videoEl.src = blobUrl
        videoEl.onloadedmetadata = (): void => {
          if (cancelled) return
          const durMs = videoEl.duration * 1000
          console.log('[VideoEditor] Video duration probed:', videoEl.duration, 'seconds')
          videoEl.removeAttribute('src')
          videoEl.load()
          if (blobUrl.startsWith('blob:')) URL.revokeObjectURL(blobUrl)

          // Auto-create a single clip spanning the whole video if no clips exist
          if (activeSongId) {
            const store = getSongStore(activeSongId)
            const vs = store.getState().song.videoSync
            if (vs.clips.length === 0) {
              const id = `clip-${Date.now()}`
              store.getState().updateVideoSync({
                clips: [{ id, startMs: 0, sourceStartMs: 0, durationMs: durMs }]
              })
            }
          }
        }
        videoEl.onerror = (e): void => {
          console.warn('[VideoEditor] Failed to probe video metadata', e)
          if (!cancelled && activeSongId) {
            const fallbackMs = songDuration * 1000
            const store = getSongStore(activeSongId)
            const vs = store.getState().song.videoSync
            if (vs.clips.length === 0) {
              store.getState().updateVideoSync({
                clips: [{ id: `clip-${Date.now()}`, startMs: 0, sourceStartMs: 0, durationMs: fallbackMs }]
              })
            }
          }
          if (blobUrl.startsWith('blob:')) URL.revokeObjectURL(blobUrl)
        }
      } catch (err) {
        console.warn('[VideoEditor] Failed to fetch video for probe', err)
      }
    }
    probe()
    return () => { cancelled = true }
  }, [videoSync.videoPath, songDuration, activeSongId])

  // Resize observer
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        setDimensions({ width: width - 80, height })
      }
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

  // Scroll/zoom
  const handleScroll = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const delta = e.deltaY > 0 ? 0.9 : 1.1
      setZoom((prev) => Math.max(0.1, Math.min(10, prev * delta)))
    } else {
      setScrollX((prev) => Math.max(0, prev + e.deltaX + e.deltaY))
    }
  }, [])

  // Import video from file
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

  // Import video from URL (YouTube, Vimeo, etc. via yt-dlp)
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
    } catch (err) {
      unsubscribe()
      setIsDownloading(false)
      alert(`Download error: ${err}`)
    }
  }, [activeSongId])

  // Remove video
  const handleRemoveVideo = useCallback(() => {
    if (!activeSongId) return
    getSongStore(activeSongId).getState().updateVideoSync({
      videoPath: undefined, clips: [], offsetMs: 0, trimStartMs: 0, trimEndMs: 0
    })
    setSelectedClipId(null)
  }, [activeSongId])

  // Current time from ticks
  const currentTime = useMemo(
    () => tickToSeconds(currentTick, tempoEvents),
    [currentTick, tempoEvents]
  )

  // Split clip at playhead
  const handleSplitAtPlayhead = useCallback(() => {
    if (!activeSongId || !videoSync.videoPath) return
    const splitMs = currentTime * 1000
    const store = getSongStore(activeSongId)
    const vs = store.getState().song.videoSync

    // Find the clip that the playhead falls within
    const clipIdx = vs.clips.findIndex(
      (c) => splitMs > c.startMs && splitMs < c.startMs + c.durationMs
    )
    if (clipIdx < 0) return

    const clip = vs.clips[clipIdx]
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

    const newClips = [...vs.clips]
    newClips.splice(clipIdx, 1, leftClip, rightClip)
    store.getState().updateVideoSync({ clips: newClips })
  }, [activeSongId, videoSync, currentTime])

  // Delete selected clip
  const handleDeleteClip = useCallback(() => {
    if (!activeSongId || !selectedClipId) return
    const store = getSongStore(activeSongId)
    const vs = store.getState().song.videoSync
    const newClips = vs.clips.filter((c) => c.id !== selectedClipId)
    store.getState().updateVideoSync({ clips: newClips })
    setSelectedClipId(null)
  }, [activeSongId, selectedClipId])

  // Move clip
  const handleMoveClip = useCallback((clipId: string, newStartMs: number) => {
    if (!activeSongId) return
    const store = getSongStore(activeSongId)
    const vs = store.getState().song.videoSync
    const newClips = vs.clips.map((c) =>
      c.id === clipId ? { ...c, startMs: Math.max(0, newStartMs) } : c
    )
    store.getState().updateVideoSync({ clips: newClips })
  }, [activeSongId])

  // Export video with audio
  const handleExport = useCallback(async () => {
    if (!activeSongId || !videoSync.videoPath) return
    const store = getSongStore(activeSongId)
    const state = store.getState()
    const audioFilePath = state.song.audioPath
    if (!audioFilePath) { alert('No audio loaded to export with video'); return }

    const outputPath = await window.api.saveVideoDialog()
    if (!outputPath) return

    setExportProgress(0)
    const unsubscribe = window.api.onExportProgress((percent) => setExportProgress(percent))

    const result = await window.api.exportVideo({
      videoPath: videoSync.videoPath,
      audioPath: audioFilePath,
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

  // Seek to specific time (in seconds)
  const handleSeek = useCallback((seconds: number) => {
    if (!activeSongId) return
    const store = getSongStore(activeSongId)
    const state = store.getState()
    const newTick = secondsToTick(Math.max(0, seconds), state.song.tempoEvents)
    store.getState().setCurrentTick(newTick)
    if (state.isPlaying) {
      audioService.seek(activeSongId, newTick, state.song.tempoEvents)
    }
  }, [activeSongId])

  // Click on timeline to seek
  const handleTimelineClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('.video-clip') || target.closest('.video-playhead')) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const clickX = e.clientX - rect.left - 80
    if (clickX < 0) return
    const pps = VIDEO_EDITOR_CONFIG.pixelsPerSecond * zoom
    const seconds = (clickX + scrollX) / pps
    handleSeek(seconds)
  }, [zoom, scrollX, handleSeek])

  // Delete key handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Delete' && selectedClipId) {
        handleDeleteClip()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedClipId, handleDeleteClip])

  if (!activeSongId) {
    return (
      <div className="video-editor">
        <div className="empty-state">
          <div className="empty-state-icon">🎬</div>
          <div className="empty-state-title">No Song Selected</div>
          <div className="empty-state-description">Select a song to edit its background video sync</div>
        </div>
      </div>
    )
  }

  return (
    <div className="video-editor" ref={containerRef}>
      {/* Toolbar */}
      <div className="video-toolbar">
        <button className="video-toolbar-button" onClick={handleImportFile} title="Import video from file">
          📎 Import File
        </button>
        <button className="video-toolbar-button" onClick={() => setShowUrlModal(true)} title="Import video from URL (YouTube, etc.)">
          🔗 Import URL
        </button>
        {videoSync.videoPath && (
          <>
            <button className="video-toolbar-button video-toolbar-button-danger" onClick={handleRemoveVideo} title="Remove video">
              🗑 Remove
            </button>
            <div className="video-toolbar-divider" />
            <button className="video-toolbar-button" onClick={handleSplitAtPlayhead} title="Split clip at playhead position">
              ✂ Split
            </button>
            {selectedClipId && (
              <button className="video-toolbar-button video-toolbar-button-danger" onClick={handleDeleteClip} title="Delete selected clip (Del)">
                🗑 Delete Clip
              </button>
            )}
          </>
        )}
        <div className="video-toolbar-spacer" />
        {videoSync.videoPath && (
          <button
            className="video-toolbar-button"
            onClick={handleExport}
            disabled={exportProgress !== null}
            title="Export video with chart audio"
          >
            {exportProgress !== null ? `⏳ Exporting ${exportProgress}%` : '📤 Export'}
          </button>
        )}
        <div className="video-zoom-controls">
          <label>Zoom:</label>
          <button onClick={() => setZoom((z) => Math.max(0.1, z * 0.8))}>-</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(10, z * 1.25))}>+</button>
        </div>
      </div>

      {/* Timeline area */}
      <div className="video-timeline-area" onWheel={handleScroll}>
        <div className="video-ruler-row">
          <div className="video-track-label-spacer" />
          <TimelineRuler duration={songDuration} scrollX={scrollX} zoom={zoom} width={dimensions.width} />
        </div>

        <div className="video-tracks" onClick={handleTimelineClick}>
          <AudioTrack
            songId={activeSongId}
            duration={songDuration}
            scrollX={scrollX}
            zoom={zoom}
            width={dimensions.width}
          />
          <VideoTrack
            videoPath={videoSync.videoPath}
            clips={videoSync.clips}
            scrollX={scrollX}
            zoom={zoom}
            width={dimensions.width}
            selectedClipId={selectedClipId}
            onSelectClip={setSelectedClipId}
            onMoveClip={handleMoveClip}
          />

          <Playhead currentTime={currentTime} scrollX={scrollX} zoom={zoom} height={130} onSeek={handleSeek} />
        </div>
      </div>

      {/* URL import modal */}
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
