// Top toolbar with playback controls and global actions
import { useState, useEffect, useCallback, useRef } from 'react'
import { useProjectStore, useSettingsStore, getSongStore } from '../stores'
import * as audioService from '../services/audioService'
import * as playbackController from '../services/playbackController'
import { serializeMidiBase64, serializeChartFile } from '../utils/midiParser'
import type { SongMetadata } from '../types'
import './Toolbar.css'

export function Toolbar(): React.JSX.Element {
  const { activeSongId, setLoadedFolder, addSong, setActiveSong } = useProjectStore()
  const { autosaveEnabled, highwaySpeed, volume, updateSettings } = useSettingsStore()
  const [isAudioLoaded, setIsAudioLoaded] = useState(false)

  // Get active song store if available
  const songStore = activeSongId ? getSongStore(activeSongId) : null

  // Reactively subscribe to song store state so UI updates when isPlaying/folderPath changes
  const [isPlaying, setIsPlaying] = useState(false)
  const [_folderPath, setFolderPath] = useState<string | null>(null)
  const [songName, setSongName] = useState('')
  const [songArtist, setSongArtist] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [_snapDivision, setSnapDivision] = useState(4)
  const [_currentBpm, setCurrentBpm] = useState(120)

  useEffect(() => {
    if (!songStore) {
      setIsPlaying(false)
      setFolderPath(null)
      setSongName('')
      setSongArtist('')
      setIsDirty(false)
      return
    }

    // Seed on mount
    const s = songStore.getState()
    setIsPlaying(s.isPlaying)
    setFolderPath(s.song.folderPath)
    setSongName(s.song.metadata.name)
    setSongArtist(s.song.metadata.artist)
    setIsDirty(s.isDirty)
    setSnapDivision(s.snapDivision)
    setCurrentBpm(s.song.tempoEvents[0]?.bpm ?? 120)

    return songStore.subscribe((state, prev) => {
      if (state.isPlaying !== prev.isPlaying) setIsPlaying(state.isPlaying)
      if (state.song.folderPath !== prev.song.folderPath) setFolderPath(state.song.folderPath)
      if (state.song.metadata.name !== prev.song.metadata.name) setSongName(state.song.metadata.name)
      if (state.song.metadata.artist !== prev.song.metadata.artist) setSongArtist(state.song.metadata.artist)
      if (state.isDirty !== prev.isDirty) setIsDirty(state.isDirty)
      if (state.snapDivision !== prev.snapDivision) setSnapDivision(state.snapDivision)
      if (state.song.tempoEvents !== prev.song.tempoEvents) setCurrentBpm(state.song.tempoEvents[0]?.bpm ?? 120)
    })
  }, [songStore])

  // Single effect for song switching: stop old playback, load new audio
  // Only depends on activeSongId — reads folderPath directly from store, not React state
  const prevSongIdRef = useRef<string | null>(null)

  useEffect(() => {
    // 1. Stop old song completely
    const prevId = prevSongIdRef.current
    if (prevId) {
      // Stop ALL playback (audio + visual RAF) as a safety net
      playbackController.stopAll()
      if (prevId !== activeSongId) {
        const prevStore = getSongStore(prevId)
        prevStore.getState().setIsPlaying(false)
        prevStore.getState().setCurrentTick(0)
        console.log('[Toolbar] Song changed, stopped old song:', prevId)
      }
    }
    prevSongIdRef.current = activeSongId

    // 2. Load new song audio
    if (!activeSongId) {
      setIsAudioLoaded(false)
      return
    }

    const newStore = getSongStore(activeSongId)
    const newFolderPath = newStore.getState().song.folderPath
    
    if (!newFolderPath) {
      setIsAudioLoaded(false)
      return
    }

    setIsAudioLoaded(false)
    audioService.setActiveSong(activeSongId)

    const songId = activeSongId
    let cancelled = false
    console.log('[Toolbar] Loading audio for song:', songId, 'path:', newFolderPath)
    audioService.loadAudio(songId, newFolderPath).then(async (loaded) => {
      if (!cancelled) {
        console.log('[Toolbar] Audio loaded result:', loaded, 'for:', songId)
        setIsAudioLoaded(loaded)
        // Apply persisted volume to newly-created gain node
        if (loaded) {
          const vol = useSettingsStore.getState().volume
          audioService.setVolume(vol ?? 0.8)

          // If song is already playing (visual-only fallback), upgrade to audio
          const store = getSongStore(songId)
          if (store.getState().isPlaying) {
            const currentTick = store.getState().currentTick
            playbackController.stopPlayback(songId)
            store.getState().setCurrentTick(currentTick)
            await playbackController.startPlayback(songId)
          }
        }
      }
    })

    return () => {
      cancelled = true
    }
  }, [activeSongId])

  // Apply volume changes
  useEffect(() => {
    audioService.setVolume(volume ?? 0.8)
  }, [volume])

  const handleOpenFolder = async (): Promise<void> => {
    try {
      // 1. Open folder dialog
      const folderPath = await window.api.openFolder()
      if (!folderPath) return

      // 2. Set loaded folder path (clears existing songs)
      setLoadedFolder(folderPath)

      // 3. Scan for song folders
      const songFolders = await window.api.scanFolder(folderPath)

      // 4. Load each song
      for (const songFolder of songFolders) {
        try {
          const iniData = await window.api.readSongIni(songFolder.path)

          const metadata: SongMetadata = {
            name: (iniData?.name as string) || (iniData?.title as string) || songFolder.name,
            artist: (iniData?.artist as string) || 'Unknown Artist',
            album: iniData?.album as string,
            genre: iniData?.genre as string,
            year: iniData?.year !== undefined ? String(iniData.year) : undefined,
            charter: iniData?.charter as string,
            song_length: iniData?.song_length as number,
            preview_start_time: iniData?.preview_start_time as number
          }

          const store = getSongStore(songFolder.id)
          store.getState().loadSong({
            id: songFolder.id,
            folderPath: songFolder.path,
            metadata,
            notes: [],
            vocalNotes: [],
            vocalPhrases: [],
            starPowerPhrases: [],
            soloSections: [],
            tempoEvents: [{ tick: 0, bpm: 120 }],
            timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
            videoSync: { clips: [], offsetMs: 0, trimStartMs: 0, trimEndMs: 0 },
            sourceFormat: 'midi'
          })

          addSong(songFolder.id)
        } catch (error) {
          console.error(`Failed to load song ${songFolder.name}:`, error)
        }
      }

      // 5. Select first song
      if (songFolders.length > 0) {
        setActiveSong(songFolders[0].id)
      }
    } catch (error) {
      console.error('Failed to open folder:', error)
    }
  }

  const handleSave = async (): Promise<void> => {
    if (!songStore) return
    const state = songStore.getState()
    try {
      // Save song.ini
      await window.api.writeSongIni(state.song.folderPath, state.song.metadata)

      // Save notes in the original format
      const hasNotes = state.song.notes.length > 0 || state.song.vocalNotes.length > 0
      if (hasNotes) {
        if (state.song.sourceFormat === 'chart') {
          const chartText = serializeChartFile(
            state.song.notes,
            state.song.tempoEvents,
            state.song.timeSignatures,
            state.song.starPowerPhrases,
            state.song.vocalNotes,
            state.song.vocalPhrases,
            state.song.soloSections,
            state.song.metadata as Record<string, unknown>
          )
          await window.api.writeSongChart(state.song.folderPath, chartText)
        } else {
          const midiBase64 = serializeMidiBase64(
            state.song.notes,
            state.song.tempoEvents,
            state.song.timeSignatures,
            480,
            state.song.starPowerPhrases,
            state.song.vocalNotes,
            state.song.vocalPhrases,
            state.song.soloSections
          )
          await window.api.writeSongMidi(state.song.folderPath, midiBase64)
        }
      }

      // Save video.json
      const vs = state.song.videoSync
      if (vs.videoPath || vs.clips.length > 0) {
        await window.api.writeVideoJson(state.song.folderPath, {
          videoPath: vs.videoPath,
          clips: vs.clips,
          offsetMs: vs.offsetMs
        })
      }

      state.markClean()
      console.log(`Saved: ${state.song.metadata.name}`)
    } catch (error) {
      console.error('Manual save failed:', error)
    }
  }

  const handleUndo = (): void => {
    if (songStore) {
      const temporal = songStore.temporal
      temporal.getState().undo()
    }
  }

  const handleRedo = (): void => {
    if (songStore) {
      const temporal = songStore.temporal
      temporal.getState().redo()
    }
  }

  // Updater state
  type UpdaterStatusState = {
    state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
    version?: string
    percent?: number
    message?: string
  }
  const [updaterStatus, setUpdaterStatus] = useState<UpdaterStatusState>({ state: 'idle' })
  const updaterDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!window.api.onUpdaterStatus) return
    const cleanup = window.api.onUpdaterStatus((status) => {
      setUpdaterStatus(status)
      // Auto-dismiss non-active states after a few seconds
      if (updaterDismissTimer.current) clearTimeout(updaterDismissTimer.current)
      if (status.state === 'not-available') {
        updaterDismissTimer.current = setTimeout(() => setUpdaterStatus({ state: 'idle' }), 4000)
      }
    })
    return () => {
      cleanup()
      if (updaterDismissTimer.current) clearTimeout(updaterDismissTimer.current)
    }
  }, [])

  // Guard against overlapping play/pause calls
  const playPauseBusy = useRef(false)

  const handlePlayPause = useCallback(async (): Promise<void> => {
    if (!activeSongId) {
      console.log('[Toolbar] No active song')
      return
    }

    // Prevent overlapping calls
    if (playPauseBusy.current) {
      console.log('[Toolbar] Play/pause already in progress, ignoring')
      return
    }
    playPauseBusy.current = true

    try {
      await playbackController.togglePlayback(activeSongId)
    } finally {
      playPauseBusy.current = false
    }
  }, [activeSongId])

  const handleStop = useCallback((): void => {
    if (!activeSongId) return
    playbackController.stopAndReset(activeSongId)
  }, [activeSongId])

  return (
    <div className="toolbar">
      {/* File actions */}
      <div className="toolbar-group">
        <button className="toolbar-button" onClick={handleOpenFolder} title="Open Folder">
          <span className="toolbar-icon">📁</span>
          <span className="toolbar-label">Open</span>
        </button>
        <button
          className="toolbar-button"
          onClick={handleSave}
          disabled={!activeSongId}
          title="Save"
        >
          <span className="toolbar-icon">💾</span>
          <span className="toolbar-label">Save</span>
        </button>
      </div>

      <div className="toolbar-separator" />

      {/* Edit actions */}
      <div className="toolbar-group">
        <button
          className="toolbar-button"
          onClick={handleUndo}
          disabled={!activeSongId}
          title="Undo (Ctrl+Z)"
        >
          <span className="toolbar-icon">↩</span>
        </button>
        <button
          className="toolbar-button"
          onClick={handleRedo}
          disabled={!activeSongId}
          title="Redo (Ctrl+Y)"
        >
          <span className="toolbar-icon">↪</span>
        </button>
      </div>

      <div className="toolbar-separator" />

      {/* Playback controls */}
      <div className="toolbar-group toolbar-playback">
        <button
          className="toolbar-button toolbar-button-play"
          onClick={handlePlayPause}
          disabled={!activeSongId}
          title={isAudioLoaded ? "Play/Pause (Space)" : "Play/Pause (no audio)"}
        >
          <span className="toolbar-icon">{isPlaying ? '⏸' : '▶'}</span>
        </button>
        <button
          className="toolbar-button"
          onClick={handleStop}
          disabled={!activeSongId}
          title="Stop"
        >
          <span className="toolbar-icon">⏹</span>
        </button>
      </div>

      {/* Volume control */}
      <div className="toolbar-group toolbar-volume">
        <span className="toolbar-icon toolbar-volume-icon">🔊</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={volume}
          onChange={(e) => updateSettings({ volume: parseFloat(e.target.value) })}
          className="toolbar-volume-slider"
          title={`Volume: ${Math.round(volume * 100)}%`}
        />
      </div>

      <div className="toolbar-separator" />

      {/* Highway speed control */}
      <div className="toolbar-group toolbar-speed">
        <span className="toolbar-label toolbar-speed-label">Speed</span>
        <input
          type="range"
          min="0.25"
          max="3"
          step="0.25"
          value={highwaySpeed}
          onChange={(e) => updateSettings({ highwaySpeed: parseFloat(e.target.value) })}
          className="toolbar-speed-slider"
          title={`Highway Speed: ${highwaySpeed}x`}
        />
        <span className="toolbar-speed-value">{highwaySpeed}x</span>
      </div>

      {/* Song info */}
      <div className="toolbar-song-info">
        {songName ? (
          <>
            <span className="toolbar-song-name">{songName}</span>
            <span className="toolbar-song-artist">{songArtist}</span>
            {isDirty && <span className="dirty-indicator" title="Unsaved changes" />}
          </>
        ) : (
          <span className="toolbar-no-song">No song loaded</span>
        )}
      </div>

      {/* Update status indicator */}
      {updaterStatus.state !== 'idle' && (
        <div className={`toolbar-updater toolbar-updater--${updaterStatus.state}`}>
          {updaterStatus.state === 'checking' && (
            <span className="toolbar-updater-label">Checking for updates…</span>
          )}
          {updaterStatus.state === 'not-available' && (
            <span className="toolbar-updater-label">Up to date</span>
          )}
          {updaterStatus.state === 'available' && (
            <span className="toolbar-updater-label">⬇ Update v{updaterStatus.version} available…</span>
          )}
          {updaterStatus.state === 'downloading' && (
            <>
              <span className="toolbar-updater-label">Downloading update {updaterStatus.message ?? ''}</span>
              <div className="toolbar-updater-bar">
                <div
                  className="toolbar-updater-bar-fill"
                  style={{ width: `${updaterStatus.percent ?? 0}%` }}
                />
              </div>
            </>
          )}
          {updaterStatus.state === 'downloaded' && (
            <span className="toolbar-updater-label">✔ Update ready — see prompt</span>
          )}
          {updaterStatus.state === 'error' && (
            <span className="toolbar-updater-label" title={updaterStatus.message}>⚠ Update error</span>
          )}
        </div>
      )}

      {/* Spacer */}
      <div className="toolbar-spacer" />

      {/* Settings */}
      <div className="toolbar-group">
        <label className="toolbar-toggle" title="Auto-save">
          <input
            type="checkbox"
            checked={autosaveEnabled}
            onChange={(e) => updateSettings({ autosaveEnabled: e.target.checked })}
          />
          <span className="toolbar-toggle-label">Auto-save</span>
        </label>
      </div>

      <div className="toolbar-separator" />

      {/* Auto-charter integration (placeholder) */}
      <div className="toolbar-group">
        <button
          className="toolbar-button toolbar-button-accent"
          disabled={!activeSongId}
          title="Generate Chart with AI"
        >
          <span className="toolbar-icon">🤖</span>
          <span className="toolbar-label">Auto-Chart</span>
        </button>
      </div>
    </div>
  )
}
