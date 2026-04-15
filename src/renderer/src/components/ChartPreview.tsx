// Chart Preview - YARG-accurate 3D highway with FBX models and textures
// Split into modules under ./chartPreview/ for maintainability
import { useEffect, useState, useCallback, useRef, Suspense, Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { Canvas } from '@react-three/fiber'
import { PerspectiveCamera } from '@react-three/drei'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import * as THREE from 'three'
import { useProjectStore, useUIStore, getSongStore } from '../stores'
import { tickToSeconds } from '../services/audioService'
import type { Instrument, Difficulty, EditingTool, VideoSync, TempoEvent } from '../types'
import {
  CAMERA_HEIGHT, CAMERA_DISTANCE, CAMERA_ANGLE, CAMERA_FOV, STRIKE_LINE_POS
} from './chartPreviewModules'
import { AssetProvider } from './chartPreviewModules/AssetProvider'
import { AnimatedHighwayScene } from './chartPreviewModules/AnimatedHighwayScene'
import {
  InstrumentToggles, DifficultySelector, TimelineScrubber,
  VocalTrackOverlay, EditToolSelector, NoteModifierToggles, ShortcutHelpButton,
  SnapSelector
} from './chartPreviewModules/UIOverlays'
import './ChartPreview.css'

// Error boundary scoped to the 3D preview — prevents asset loading failures from crashing the entire app
class PreviewErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): { hasError: boolean; error: Error } {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ChartPreview] Render error:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="empty-state">
          <div className="empty-state-icon">⚠️</div>
          <div className="empty-state-title">Preview Error</div>
          <div className="empty-state-description">
            {this.state.error?.message || 'Failed to render 3D preview'}
          </div>
          <button
            style={{ marginTop: 12, padding: '6px 16px', cursor: 'pointer', background: '#333', color: '#ccc', border: '1px solid #555', borderRadius: 4 }}
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// -- Background Video (plays behind 3D highway like in the games) -----
function BackgroundVideo({ songId }: { songId: string }): React.JSX.Element | null {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [videoSync, setVideoSync] = useState<VideoSync>({ clips: [], offsetMs: 0, trimStartMs: 0, trimEndMs: 0 })
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTick, setCurrentTick] = useState(0)
  const [tempoEvents, setTempoEvents] = useState<TempoEvent[]>([{ tick: 0, bpm: 120 }])
  const lastSyncRef = useRef(0)

  useEffect(() => {
    const store = getSongStore(songId)
    const sync = (): void => {
      const s = store.getState()
      setVideoSync(s.song.videoSync)
      setIsPlaying(s.isPlaying)
      setCurrentTick(s.currentTick)
      setTempoEvents(s.song.tempoEvents)
    }
    sync()
    return store.subscribe(sync)
  }, [songId])

  // Sync video playback with audio using clips
  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoSync.videoPath) return

    const currentTimeMs = tickToSeconds(currentTick, tempoEvents) * 1000

    // Find active clip at current time
    const activeClip = videoSync.clips.find(
      (c) => currentTimeMs >= c.startMs && currentTimeMs < c.startMs + c.durationMs
    )

    if (activeClip) {
      const clipLocalMs = currentTimeMs - activeClip.startMs
      const videoTime = (activeClip.sourceStartMs + clipLocalMs) / 1000

      if (isPlaying) {
        if (Math.abs(video.currentTime - videoTime) > 0.3) {
          video.currentTime = Math.max(0, videoTime)
        }
        if (video.paused) {
          video.play().catch(() => {/* autoplay blocked */})
        }
      } else {
        video.pause()
        const now = performance.now()
        if (now - lastSyncRef.current > 50) {
          lastSyncRef.current = now
          video.currentTime = Math.max(0, videoTime)
        }
      }
    } else {
      // No active clip at this time — pause
      if (!video.paused) video.pause()
    }
  }, [isPlaying, currentTick, tempoEvents, videoSync])

  // Create a blob URL for local video files (song-file:// works with fetch but not <video src>)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!videoSync.videoPath) { setBlobUrl(null); return }
    if (videoSync.videoPath.startsWith('http')) { setBlobUrl(videoSync.videoPath); return }

    let revoked = false
    const protocolUrl = `song-file://${encodeURIComponent(videoSync.videoPath)}`
    fetch(protocolUrl)
      .then((res) => res.blob())
      .then((blob) => {
        if (revoked) return
        const url = URL.createObjectURL(blob)
        setBlobUrl(url)
      })
      .catch((err) => console.error('[BackgroundVideo] Failed to load video:', err))

    return () => {
      revoked = true
      setBlobUrl((prev) => { if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev); return null })
    }
  }, [videoSync.videoPath])

  // Auto-create an initial clip spanning the whole video if videoPath is set but no clips exist
  useEffect(() => {
    if (!blobUrl || videoSync.clips.length > 0) return
    let cancelled = false

    const videoEl = document.createElement('video')
    videoEl.preload = 'metadata'
    videoEl.src = blobUrl
    videoEl.onloadedmetadata = (): void => {
      if (cancelled) return
      const durMs = videoEl.duration * 1000
      videoEl.removeAttribute('src')
      videoEl.load()

      const store = getSongStore(songId)
      const vs = store.getState().song.videoSync
      if (vs.clips.length === 0) {
        store.getState().updateVideoSync({
          clips: [{ id: `clip-${Date.now()}`, startMs: 0, sourceStartMs: 0, durationMs: durMs }]
        })
      }
    }
    videoEl.onerror = (): void => {
      if (cancelled) return
      // Fallback: create a clip with a generous default duration
      const store = getSongStore(songId)
      const vs = store.getState().song.videoSync
      if (vs.clips.length === 0) {
        store.getState().updateVideoSync({
          clips: [{ id: `clip-${Date.now()}`, startMs: 0, sourceStartMs: 0, durationMs: 600000 }]
        })
      }
    }

    return () => { cancelled = true }
  }, [blobUrl, videoSync.clips.length, songId])

  if (!videoSync.videoPath || !blobUrl) return null

  return (
    <video
      ref={videoRef}
      className="chart-preview-video"
      src={blobUrl}
      muted
      playsInline
      preload="auto"
    />
  )
}

// -- Highway Wrapper (with Suspense for FBX loading) ------------------
function HighwayWrapper({ songId, editTool }: { songId: string; editTool: EditingTool }): React.JSX.Element {
  const [visibleInstruments, setVisibleInstruments] = useState<Set<Instrument>>(
    new Set(['drums', 'guitar', 'bass', 'vocals', 'keys'])
  )
  const [activeDifficulty, setActiveDifficulty] = useState<Difficulty>('expert')
  const [hasVideo, setHasVideo] = useState(false)

  useEffect(() => {
    const store = getSongStore(songId)
    const init = store.getState()
    setVisibleInstruments(new Set(init.visibleInstruments))
    setActiveDifficulty(init.activeDifficulty)
    setHasVideo(!!init.song.videoSync.videoPath)
    return store.subscribe((state, prev) => {
      if (state.visibleInstruments !== prev.visibleInstruments)
        setVisibleInstruments(new Set(state.visibleInstruments))
      if (state.activeDifficulty !== prev.activeDifficulty) setActiveDifficulty(state.activeDifficulty)
      if (state.song.videoSync.videoPath !== prev.song.videoSync.videoPath)
        setHasVideo(!!state.song.videoSync.videoPath)
    })
  }, [songId])

  // When video is loaded, make canvas transparent so video shows behind
  const glProps = hasVideo
    ? { antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.0, alpha: true }
    : { antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.0 }

  // Ensure WebGL clears to transparent when video is behind the highway
  const handleCreated = useCallback(({ gl }: { gl: THREE.WebGLRenderer }) => {
    if (hasVideo) {
      gl.setClearColor(0x000000, 0)
    }
  }, [hasVideo])

  return (
    <Canvas shadows gl={glProps} style={hasVideo ? { background: 'transparent' } : undefined} onCreated={handleCreated}>
      <PerspectiveCamera
        makeDefault
        position={[0, CAMERA_HEIGHT, STRIKE_LINE_POS + CAMERA_DISTANCE]}
        rotation={[(-CAMERA_ANGLE * Math.PI) / 180, 0, 0]}
        fov={CAMERA_FOV}
        near={0.1}
        far={50}
      />
      {!hasVideo && <fog attach="fog" args={['#050508', 10, 30]} />}
      {!hasVideo && <color attach="background" args={['#050508']} />}
      <ambientLight intensity={0.3} />
      <directionalLight position={[0, 10, 5]} intensity={0.5} color="#FFFFFF" />
      <pointLight position={[0, 3, STRIKE_LINE_POS]} intensity={0.6} color="#3366CC" distance={8} />
      <pointLight position={[0, 1.5, STRIKE_LINE_POS + 1]} intensity={0.3} color="#4488FF" distance={5} />

      <Suspense fallback={null}>
        <AssetProvider>
          <AnimatedHighwayScene
            songId={songId}
            visibleInstruments={visibleInstruments}
            activeDifficulty={activeDifficulty}
            editTool={editTool}
          />
        </AssetProvider>
      </Suspense>

      {!hasVideo && (
        <EffectComposer>
          <Bloom luminanceThreshold={0.4} luminanceSmoothing={0.9} intensity={1.2} mipmapBlur />
        </EffectComposer>
      )}
    </Canvas>
  )
}

// -- Main Chart Preview -----------------------------------------------
export function ChartPreview(): React.JSX.Element {
  const { activeSongId } = useProjectStore()
  const editTool = useUIStore((s) => s.editTool)
  const setEditTool = useUIStore((s) => s.setEditTool)

  const isPreviewFullscreen = useUIStore((s) => s.isPreviewFullscreen)
  const togglePreviewFullscreen = useUIStore((s) => s.togglePreviewFullscreen)

  // Scroll-to-scrub on 3D preview: wheel scrolls the playhead
  const handlePreviewWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!activeSongId) return
      const store = getSongStore(activeSongId)
      if (store.getState().isPlaying) return // don't fight playback
      const tickDelta = (e.deltaY + e.deltaX) * 4 // ~4 ticks per pixel of scroll
      const newTick = store.getState().currentTick + Math.round(tickDelta)
      store.getState().setCurrentTick(newTick) // store clamps to valid range
    },
    [activeSongId]
  )

  return (
    <div className="chart-preview">
      <div className="panel-header">
        <span className="panel-header-title">
          <span>Chart Preview</span>
        </span>
        <div className="panel-header-actions">
          <EditToolSelector editTool={editTool} setEditTool={setEditTool} />
          <NoteModifierToggles />
          <SnapSelector />
          <DifficultySelector />
          <InstrumentToggles />
          <ShortcutHelpButton />
          <button
            className="panel-header-btn"
            title={isPreviewFullscreen ? 'Exit Fullscreen (Esc)' : 'Fullscreen Preview'}
            onClick={togglePreviewFullscreen}
            style={{
              background: 'none', border: '1px solid #555', borderRadius: 4,
              color: '#ccc', cursor: 'pointer', padding: '2px 6px', fontSize: 14,
              lineHeight: 1
            }}
          >
            {isPreviewFullscreen ? '⊠' : '⛶'}
          </button>
        </div>
      </div>
      <div className="chart-preview-canvas" onWheel={handlePreviewWheel}>
        {activeSongId ? (
          <PreviewErrorBoundary>
            <BackgroundVideo songId={activeSongId} />
            <VocalTrackOverlay songId={activeSongId} />
            <HighwayWrapper songId={activeSongId} editTool={editTool} />
          </PreviewErrorBoundary>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">??</div>
            <div className="empty-state-title">No Song Selected</div>
            <div className="empty-state-description">
              Select a song from the explorer to preview and edit its chart
            </div>
          </div>
        )}
      </div>
      <TimelineScrubber />
    </div>
  )
}
