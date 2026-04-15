// Project Explorer - Left panel showing song folder tree
import { useState, useCallback, useEffect, useRef } from 'react'
import { useProjectStore, useSettingsStore, getSongStore, removeSongStore } from '../stores'
import { parseMidiBase64, parseChartFile } from '../utils/midiParser'
import type { SongMetadata, Instrument, VideoSync } from '../types'
import './ProjectExplorer.css'

interface SongEntry {
  id: string
  name: string
  artist: string
  folderPath: string
  isDirty: boolean
  hasDrums: boolean
  hasGuitar: boolean
  hasBass: boolean
  hasVocals: boolean
  hasKeys: boolean
}

// Album art cache
const albumArtCache = new Map<string, string | null>()

// Hook to load album art for a song
function useAlbumArt(folderPath: string): string | null {
  const [artUrl, setArtUrl] = useState<string | null>(albumArtCache.get(folderPath) ?? null)

  useEffect(() => {
    // Check cache first
    if (albumArtCache.has(folderPath)) {
      setArtUrl(albumArtCache.get(folderPath) ?? null)
      return
    }

    // Load from disk
    let mounted = true
    window.api.readAlbumArt(folderPath).then((url) => {
      if (mounted) {
        albumArtCache.set(folderPath, url)
        setArtUrl(url)
      }
    }).catch(() => {
      if (mounted) {
        albumArtCache.set(folderPath, null)
        setArtUrl(null)
      }
    })

    return () => { mounted = false }
  }, [folderPath])

  return artUrl
}

// Song item component with album art
function SongItem({
  song,
  isActive,
  onSelect,
  onDelete
}: {
  song: SongEntry
  isActive: boolean
  onSelect: () => void
  onDelete: () => void
}): React.JSX.Element {
  const artUrl = useAlbumArt(song.folderPath)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close context menu on outside click or Escape
  useEffect(() => {
    if (!contextMenu) return
    const handleClose = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setContextMenu(null)
    }
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setContextMenu(null)
    }
    document.addEventListener('mousedown', handleClose)
    document.addEventListener('keydown', handleKey)
    return () => { document.removeEventListener('mousedown', handleClose); document.removeEventListener('keydown', handleKey) }
  }, [contextMenu])

  return (
    <div
      className={`explorer-song-item ${isActive ? 'active' : ''}`}
      onClick={onSelect}
      onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY }) }}
    >
      <div className="explorer-song-icon">
        {artUrl ? (
          <img src={artUrl} alt="" className="explorer-song-art" />
        ) : (
          <span className="explorer-song-art-placeholder">🎵</span>
        )}
      </div>
      <div className="explorer-song-info">
        <div className="explorer-song-name">
          {song.name}
          {song.isDirty && <span className="dirty-indicator" />}
        </div>
        <div className="explorer-song-artist">{song.artist}</div>
      </div>
      <div className="explorer-song-instruments">
        {song.hasDrums && <span className="instrument-badge" title="Drums">🥁</span>}
        {song.hasGuitar && <span className="instrument-badge" title="Guitar">🎸</span>}
        {song.hasBass && <span className="instrument-badge" title="Bass">🎸</span>}
        {song.hasVocals && <span className="instrument-badge" title="Vocals">🎤</span>}
        {song.hasKeys && <span className="instrument-badge" title="Keys">🎹</span>}
      </div>
      {contextMenu && (
        <div ref={menuRef} className="song-context-menu" style={{ top: contextMenu.y, left: contextMenu.x }}>
          <button className="song-context-menu-item delete" onClick={(e) => { e.stopPropagation(); setContextMenu(null); onDelete() }}>
            🗑️ Delete Song
          </button>
        </div>
      )}
    </div>
  )
}

export function ProjectExplorer(): React.JSX.Element {
  const { loadedFolderPath, songIds, activeSongId, setActiveSong, setLoadedFolder, addSong, removeSong } =
    useProjectStore()
  const { lastOpenedFolder, updateSettings } = useSettingsStore()
  const [isLoading, setIsLoading] = useState(false)
  const [showNewSongDialog, setShowNewSongDialog] = useState(false)
  const [newSongName, setNewSongName] = useState('')
  const [newSongAudioPath, setNewSongAudioPath] = useState<string | null>(null)
  // For future folder tree expansion feature
  const [_expandedFolders, _setExpandedFolders] = useState<Set<string>>(new Set())

  // Load a folder's songs (shared between initial load and handleOpenFolder)
  const loadFolder = useCallback(async (folderPath: string) => {
    const songFolders = await window.api.scanFolder(folderPath)
    console.log('Found songs:', songFolders)

    // Only clear state after we've confirmed the scan succeeded
    setLoadedFolder(folderPath)

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

    if (songFolders.length > 0) {
      setActiveSong(songFolders[0].id)
    }
  }, [setLoadedFolder, addSong, setActiveSong])

  // Auto-load last opened folder on startup
  useEffect(() => {
    if (lastOpenedFolder && !loadedFolderPath && songIds.length === 0) {
      setIsLoading(true)
      loadFolder(lastOpenedFolder).finally(() => setIsLoading(false))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Only run on mount

  // Get song entries with metadata
  const songEntries: SongEntry[] = songIds.map((id) => {
    const store = getSongStore(id)
    const state = store.getState()
    const notes = state.song.notes

    return {
      id,
      name: state.song.metadata.name,
      artist: state.song.metadata.artist,
      folderPath: state.song.folderPath,
      isDirty: state.isDirty,
      hasDrums: notes.some((n) => n.instrument === 'drums'),
      hasGuitar: notes.some((n) => n.instrument === 'guitar'),
      hasBass: notes.some((n) => n.instrument === 'bass'),
      hasVocals: notes.some((n) => n.instrument === 'vocals'),
      hasKeys: notes.some((n) => n.instrument === 'keys')
    }
  })

  // Load MIDI notes for a song
  const loadSongMidi = useCallback(async (songId: string, folderPath: string) => {
    try {
      const result = await window.api.readSongMidi(folderPath)
      if (!result) {
        console.warn(`[loadSongMidi] No MIDI/chart data returned for "${folderPath}" — notes.mid/notes.chart may be missing or invalid`)
        return
      }

      const { notes, vocalNotes, vocalPhrases, starPowerPhrases, soloSections, tempoEvents, timeSignatures } =
        result.type === 'chart' ? parseChartFile(result.data) : parseMidiBase64(result.data)
      const store = getSongStore(songId)
      const currentState = store.getState()

      // Update song with parsed notes
      store.getState().loadSong({
        ...currentState.song,
        notes,
        vocalNotes,
        vocalPhrases,
        starPowerPhrases,
        soloSections,
        tempoEvents,
        timeSignatures,
        sourceFormat: result.type === 'chart' ? 'chart' : 'midi'
      })

      // Auto-select instruments that have charted notes
      const chartedInstruments = new Set<Instrument>()
      for (const note of notes) {
        chartedInstruments.add(note.instrument)
      }
      if (vocalNotes.length > 0) {
        chartedInstruments.add('vocals')
      }

      // Update visible instruments to only show charted ones (if any)
      if (chartedInstruments.size > 0) {
        // Set visible instruments to those that have notes
        const newState = store.getState()
        const allInstruments: Instrument[] = ['drums', 'guitar', 'bass', 'vocals', 'keys', 'proKeys', 'proGuitar', 'proBass']
        for (const inst of allInstruments) {
          const isCharted = chartedInstruments.has(inst)
          const isVisible = newState.visibleInstruments.has(inst)
          if (isCharted !== isVisible) {
            store.getState().toggleInstrumentVisibility(inst)
          }
        }
      }
    } catch (error) {
      console.error('Failed to load MIDI for folder:', folderPath, error)
    }
  }, [])

  // Load video sync data for a song (from video.json, or auto-detect video file)
  const loadVideoSync = useCallback(async (songId: string, folderPath: string) => {
    try {
      const store = getSongStore(songId)

      // 1. Try reading saved video.json
      const videoJson = await window.api.readVideoJson(folderPath)
      if (videoJson && (videoJson.videoPath || (Array.isArray(videoJson.clips) && videoJson.clips.length > 0))) {
        const vs: Partial<VideoSync> = {
          videoPath: videoJson.videoPath as string | undefined,
          clips: (videoJson.clips as VideoSync['clips']) || [],
          offsetMs: (videoJson.offsetMs as number) || 0
        }
        store.getState().updateVideoSync(vs)
        store.getState().markClean() // Don't trigger autosave just from loading
        return
      }

      // 2. Fallback: auto-detect a video file in the folder (like games do)
      const detected = await window.api.scanVideo(folderPath)
      if (detected) {
        store.getState().updateVideoSync({ videoPath: detected.filePath })
        store.getState().markClean()
      }
    } catch (error) {
      console.error('Failed to load video sync for:', folderPath, error)
    }
  }, [])

  // Auto-load MIDI + video when active song changes (covers initial load and clicks)
  useEffect(() => {
    if (!activeSongId) return
    const store = getSongStore(activeSongId)
    const state = store.getState()
    const folderPath = state.song.folderPath

    const load = async (): Promise<void> => {
      // Load MIDI if not yet loaded
      if (state.song.notes.length === 0 && state.song.vocalNotes.length === 0) {
        await loadSongMidi(activeSongId, folderPath)
      }
      // Load video sync if not yet loaded
      const vs = getSongStore(activeSongId).getState().song.videoSync
      if (!vs.videoPath && vs.clips.length === 0) {
        await loadVideoSync(activeSongId, folderPath)
      }
    }
    load()
  }, [activeSongId, loadSongMidi, loadVideoSync])

  // Handle song selection (just sets active — useEffect above handles loading)
  const handleSongSelect = useCallback(
    (songId: string) => {
      setActiveSong(songId)
    },
    [setActiveSong]
  )

  const handleOpenFolder = async (): Promise<void> => {
    try {
      setIsLoading(true)

      // 1. Open folder dialog
      const folderPath = await window.api.openFolder()
      if (!folderPath) {
        setIsLoading(false)
        return
      }

      // 2. Save as last opened folder
      updateSettings({ lastOpenedFolder: folderPath })

      // 3. Load the folder
      await loadFolder(folderPath)
    } catch (error) {
      console.error('Failed to open folder:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleCreateNewSong = async (): Promise<void> => {
    const name = newSongName.trim()
    if (!name || !loadedFolderPath) return

    try {
      const result = await window.api.createSongFolder(loadedFolderPath, name, newSongAudioPath ?? undefined)
      if (!result) return

      // Initialize the song store with defaults
      const store = getSongStore(result.id)
      store.getState().loadSong({
        id: result.id,
        folderPath: result.path,
        metadata: { name, artist: 'Unknown Artist' },
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

      addSong(result.id)
      setActiveSong(result.id)
      setShowNewSongDialog(false)
      setNewSongName('')
      setNewSongAudioPath(null)
    } catch (error) {
      console.error('Failed to create new song:', error)
    }
  }

  const handlePickAudio = async (): Promise<void> => {
    const path = await window.api.openAudioDialog()
    if (path) setNewSongAudioPath(path)
  }

  const handleImportAudio = async (): Promise<void> => {
    if (!activeSongId) return
    const store = getSongStore(activeSongId)
    const folderPath = store.getState().song.folderPath
    const audioPath = await window.api.openAudioDialog()
    if (!audioPath) return
    await window.api.importAudio(folderPath, audioPath)
  }

  const handleDeleteSong = async (songId: string): Promise<void> => {
    const store = getSongStore(songId)
    const songName = store.getState().song.metadata.name
    const folderPath = store.getState().song.folderPath
    if (!confirm(`Delete "${songName}"?\n\nThis will move the song folder to the trash.`)) return

    const deleted = await window.api.deleteSongFolder(folderPath)
    if (deleted) {
      removeSong(songId)
      removeSongStore(songId)
    }
  }

  // Future: folder tree expansion
  // const toggleFolder = (path: string): void => {
  //   _setExpandedFolders((prev) => {
  //     const next = new Set(prev)
  //     if (next.has(path)) {
  //       next.delete(path)
  //     } else {
  //       next.add(path)
  //     }
  //     return next
  //   })
  // }

  return (
    <div className="project-explorer">
      <div className="panel-header">
        <span className="panel-header-title">
          <span>📁</span>
          <span>Explorer</span>
        </span>
        <div className="panel-header-actions">
          <button className="icon-button" onClick={handleImportAudio} title="Import Audio" disabled={!activeSongId}>
            🔊
          </button>
          <button className="icon-button" onClick={() => loadedFolderPath ? setShowNewSongDialog(true) : undefined} title="New Song" disabled={!loadedFolderPath}>
            🎵
          </button>
          <button className="icon-button" onClick={handleOpenFolder} title="Open Folder">
            +
          </button>
        </div>
      </div>

      <div className="panel-content">
        {loadedFolderPath ? (
          <>
            {/* Folder path display */}
            <div className="explorer-folder-path" title={loadedFolderPath}>
              <span className="folder-icon">📂</span>
              <span className="folder-name">
                {loadedFolderPath.split(/[\\/]/).pop() || loadedFolderPath}
              </span>
            </div>

            {/* Song list */}
            <div className="explorer-song-list">
              {songEntries.length > 0 ? (
                songEntries.map((song) => (
                  <SongItem
                    key={song.id}
                    song={song}
                    isActive={activeSongId === song.id}
                    onSelect={() => handleSongSelect(song.id)}
                    onDelete={() => handleDeleteSong(song.id)}
                  />
                ))
              ) : (
                <div className="explorer-empty">
                  <span>No songs found</span>
                  <span className="explorer-empty-hint">
                    Add folders containing song.ini files
                  </span>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">📁</div>
            <div className="empty-state-title">{isLoading ? 'Loading...' : 'No Folder Open'}</div>
            <div className="empty-state-description">
              Open a folder containing Clone Hero songs to get started
            </div>
            <button className="explorer-open-button" onClick={handleOpenFolder}>
              Open Folder
            </button>
          </div>
        )}
      </div>

      {/* New Song Dialog */}
      {showNewSongDialog && (
        <div className="new-song-dialog-overlay" onClick={() => { setShowNewSongDialog(false); setNewSongAudioPath(null) }}>
          <div className="new-song-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="new-song-dialog-title">New Song</div>
            <label className="new-song-dialog-label">Song Name</label>
            <input
              autoFocus
              className="new-song-dialog-input"
              type="text"
              placeholder="Song name..."
              value={newSongName}
              onChange={(e) => setNewSongName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newSongName.trim()) handleCreateNewSong()
                if (e.key === 'Escape') setShowNewSongDialog(false)
              }}
            />
            <label className="new-song-dialog-label">Audio File</label>
            <div className="new-song-audio-picker">
              <span className="new-song-audio-name">
                {newSongAudioPath ? newSongAudioPath.split(/[\\/]/).pop() : 'No file selected'}
              </span>
              <button className="new-song-dialog-btn browse" onClick={handlePickAudio}>
                Browse...
              </button>
            </div>
            <div className="new-song-dialog-actions">
              <button className="new-song-dialog-btn cancel" onClick={() => { setShowNewSongDialog(false); setNewSongAudioPath(null) }}>
                Cancel
              </button>
              <button
                className="new-song-dialog-btn create"
                onClick={handleCreateNewSong}
                disabled={!newSongName.trim()}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
