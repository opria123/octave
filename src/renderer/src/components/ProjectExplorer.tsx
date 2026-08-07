// Project Explorer - Left panel showing song folder tree
import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useProjectStore, useSettingsStore, getSongStore, removeSongStore } from '../stores'
import * as audioService from '../services/audioService'
import { parseMidiBase64, parseChartFile } from '../utils/midiParser'
import type { Instrument, VideoSync, AudioSync, VenueTrackData } from '../types'
import { subscribeAlbumArtUpdates } from '../utils/albumArtEvents'
import { readLibraryCache, writeLibraryCache, type CachedLibrarySong } from '../services/libraryCache'
import {
  organizeLibrarySongs,
  type LibraryGroup,
  type LibrarySort
} from '../utils/libraryOrganization'
import './ProjectExplorer.css'

interface SongEntry {
  id: string
  name: string
  artist: string
  year?: string
  addedAt?: number
  folderPath: string
  isDirty: boolean
  hasDrums: boolean
  hasGuitar: boolean
  hasBass: boolean
  hasVocals: boolean
  hasKeys: boolean
}

// song.ini values arrive as `string | number` — a title such as "1979" is
// legitimately parsed as a number. Everything downstream treats metadata as
// text, so coerce at the boundary rather than casting and hoping.
function iniText(value: string | number | undefined): string {
  return value === undefined || value === null ? '' : String(value)
}

function isCurrentLibrarySong(songId: string, folderPath: string, loadVersion: number): boolean {
  const project = useProjectStore.getState()
  return (
    project.libraryLoadVersion === loadVersion &&
    project.songIds.includes(songId) &&
    getSongStore(songId).getState().song.folderPath === folderPath
  )
}

// Album art cache
const albumArtCache = new Map<string, string | null>()

// Hook to load album art for a song
function useAlbumArt(folderPath: string): string | null {
  const [artUrl, setArtUrl] = useState<string | null>(albumArtCache.get(folderPath) ?? null)

  useEffect(() => {
    // Check cache first
    if (albumArtCache.has(folderPath)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
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

  useEffect(() =>
    subscribeAlbumArtUpdates((update) => {
      if (update.folderPath !== folderPath) return
      albumArtCache.set(folderPath, update.dataUrl)
      setArtUrl(update.dataUrl)
    }), [folderPath])

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
  const { loadedFolderPath, songIds, activeSongId, libraryLoadVersion, setActiveSong, setLoadedFolder, addSong, removeSong } =
    useProjectStore()
  const { lastOpenedFolder, updateSettings } = useSettingsStore()
  const [isLoading, setIsLoading] = useState(false)
  const [showNewSongDialog, setShowNewSongDialog] = useState(false)
  const [newSongName, setNewSongName] = useState('')
  const [newSongAudioPath, setNewSongAudioPath] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [librarySort, setLibrarySort] = useState<LibrarySort>('title')
  const [libraryGroup, setLibraryGroup] = useState<LibraryGroup>('title-initial')
  const [songAddedTimes, setSongAddedTimes] = useState<Map<string, number>>(new Map())
  const loadGenerationRef = useRef(0)
  const handledLoadVersionRef = useRef(-1)
  // For future folder tree expansion feature
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_expandedFolders, _setExpandedFolders] = useState<Set<string>>(new Set())

  // Load a folder's songs (shared between initial load and handleOpenFolder)
  const loadFolder = useCallback(async (folderPath: string, preferredActiveId?: string | null) => {
    const generation = ++loadGenerationRef.current
    setIsLoading(true)
    const previousProject = useProjectStore.getState()
    if (previousProject.loadedFolderPath !== folderPath) {
      for (const songId of previousProject.songIds) removeSongStore(songId)
      setLoadedFolder(folderPath)
    }
    handledLoadVersionRef.current = useProjectStore.getState().libraryLoadVersion
    const isCurrentLoad = (): boolean =>
      loadGenerationRef.current === generation &&
      useProjectStore.getState().loadedFolderPath === folderPath
    const loadOwnedIds = new Set(useProjectStore.getState().songIds)

    const populateSong = (
      { id, path, metadata }: CachedLibrarySong,
      source: 'cache' | 'fresh'
    ): void => {
      if (!isCurrentLoad()) return
      const store = getSongStore(id)
      const currentState = store.getState()
      if (currentState.song.folderPath && currentState.song.folderPath !== path) {
        console.warn(`Ignoring stale library entry with colliding id "${id}" at ${path}`)
        return
      }
      if (currentState.song.folderPath === path) {
        if (source === 'fresh' && !currentState.isDirty) {
          store.setState((state) => ({
            song: { ...state.song, metadata: { ...state.song.metadata, ...metadata } }
          }))
        }
      } else {
        store.getState().loadSong({
          id,
          folderPath: path,
          metadata,
          notes: [],
          vocalNotes: [],
          vocalPhrases: [],
          starPowerPhrases: [],
          soloSections: [],
          laneMarkers: [],
          songSections: [],
          tempoEvents: [{ tick: 0, bpm: 120 }],
          timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
          videoSync: { clips: [], offsetMs: 0, trimStartMs: 0, trimEndMs: 0 },
          audioSync: { clips: [] },
          venueTrack: { autoGenerated: false, lighting: [], postProcessing: [], stage: [], performer: [], cameraCuts: [] },
          sourceFormat: 'midi'
        })
      }
      addSong(id)
      loadOwnedIds.add(id)
    }

    try {
      const cachedSongs: CachedLibrarySong[] = await readLibraryCache(folderPath).catch(
        (): CachedLibrarySong[] => []
      )
      if (!isCurrentLoad()) return
      const cachedById = new Map<string, CachedLibrarySong>(
        cachedSongs.map((song) => [song.id, song] as const)
      )
      setSongAddedTimes(
        new Map(
          cachedSongs.flatMap((song) =>
            song.addedAt === undefined ? [] : ([[song.id, song.addedAt]] as const)
          )
        )
      )
      for (const cachedSong of cachedSongs) populateSong(cachedSong, 'cache')

      const songFolders = await window.api.scanFolder(folderPath)
      if (!isCurrentLoad()) return
      const freshResults = await Promise.all(
        songFolders.map(async (songFolder): Promise<CachedLibrarySong> => {
          try {
            const iniData = await window.api.readSongIni(songFolder.path)
            return {
              id: songFolder.id,
              path: songFolder.path,
              folderName: songFolder.name,
              addedAt: songFolder.addedAt,
              metadata: {
                ...(iniData ?? {}),
                name: iniText(iniData?.name) || iniText(iniData?.title) || songFolder.name,
                artist: iniText(iniData?.artist) || 'Unknown Artist',
                album: iniText(iniData?.album) || undefined,
                genre: iniText(iniData?.genre) || undefined,
                year: iniData?.year !== undefined ? String(iniData.year) : undefined,
                charter: iniText(iniData?.charter) || undefined,
                song_length: iniData?.song_length as number,
                preview_start_time: iniData?.preview_start_time as number
              }
            }
          } catch (error) {
            console.error(`Failed to read metadata for ${songFolder.name}:`, error)
            const cachedSong = cachedById.get(songFolder.id)
            if (cachedSong?.path === songFolder.path) {
              return { ...cachedSong, addedAt: songFolder.addedAt }
            }
            return {
              id: songFolder.id,
              path: songFolder.path,
              folderName: songFolder.name,
              addedAt: songFolder.addedAt,
              metadata: { name: songFolder.name, artist: 'Unknown Artist' }
            }
          }
        })
      )
      if (!isCurrentLoad()) return
      const freshSongs = freshResults
      setSongAddedTimes(new Map(freshSongs.map((song) => [song.id, song.addedAt ?? 0])))

      const freshIds = new Set(freshSongs.map(({ id }) => id))
      for (const existingId of loadOwnedIds) {
        if (!freshIds.has(existingId)) {
          removeSong(existingId)
          removeSongStore(existingId)
        }
      }
      for (const freshSong of freshSongs) populateSong(freshSong, 'fresh')
      if (!isCurrentLoad()) return
      await writeLibraryCache(folderPath, freshSongs).catch((error) => {
        console.warn('Failed to update library cache:', error)
      })
      if (!isCurrentLoad()) return

      const currentActiveId = useProjectStore.getState().activeSongId
      if (preferredActiveId && freshIds.has(preferredActiveId)) {
        setActiveSong(preferredActiveId)
      } else if ((!currentActiveId || !freshIds.has(currentActiveId)) && freshSongs.length > 0) {
        const firstSong = organizeLibrarySongs(
          freshSongs.map(({ id, metadata }) => ({ id, name: metadata.name, artist: metadata.artist })),
          '',
          'title',
          'none'
        )[0].songs[0]
        setActiveSong(firstSong.id)
      }
    } catch (error) {
      if (isCurrentLoad()) console.error(`Failed to load library ${folderPath}:`, error)
    } finally {
      if (loadGenerationRef.current === generation) setIsLoading(false)
    }
  }, [addSong, removeSong, setActiveSong, setLoadedFolder])

  // Auto-load last opened folder on startup
  useEffect(() => {
    const folderPath = loadedFolderPath || lastOpenedFolder
    if (!folderPath || isLoading) return
    if (handledLoadVersionRef.current === libraryLoadVersion) return
    void loadFolder(folderPath)
  }, [isLoading, lastOpenedFolder, libraryLoadVersion, loadFolder, loadedFolderPath])

  // Get song entries with metadata
  const songEntries: SongEntry[] = songIds.map((id) => {
    const store = getSongStore(id)
    const state = store.getState()
    const notes = state.song.notes

    return {
      id,
      name: state.song.metadata.name,
      artist: state.song.metadata.artist,
      year: state.song.metadata.year,
      addedAt: songAddedTimes.get(id),
      folderPath: state.song.folderPath,
      isDirty: state.isDirty,
      hasDrums: notes.some((n) => n.instrument === 'drums'),
      hasGuitar: notes.some((n) => n.instrument === 'guitar'),
      hasBass: notes.some((n) => n.instrument === 'bass'),
      hasVocals: notes.some((n) => n.instrument === 'vocals'),
      hasKeys: notes.some((n) => n.instrument === 'keys')
    }
  })
  const organizedSongs = useMemo(
    () => organizeLibrarySongs(songEntries, searchQuery, librarySort, libraryGroup),
    [libraryGroup, librarySort, searchQuery, songEntries]
  )

  // Load MIDI notes for a song
  const loadSongMidi = useCallback(async (songId: string, folderPath: string) => {
    try {
      const loadVersion = useProjectStore.getState().libraryLoadVersion
      const result = await window.api.readSongMidi(folderPath)
      if (!isCurrentLibrarySong(songId, folderPath, loadVersion)) return
      if (!result) {
        console.warn(`[loadSongMidi] No MIDI/chart data returned for "${folderPath}" — notes.mid/notes.chart may be missing or invalid`)
        return
      }

      const { notes, vocalNotes, vocalPhrases, starPowerPhrases, soloSections, laneMarkers, songSections, venueTrack, tempoEvents, timeSignatures } =
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
        laneMarkers,
        songSections,
        venueTrack,
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
      const loadVersion = useProjectStore.getState().libraryLoadVersion
      const store = getSongStore(songId)

      // Always scan the song folder for a real video file. This wins over any
      // absolute `videoPath` saved in video.json — those paths are often stale
      // (song was moved, or the project was opened from a different machine /
      // staging folder) and would be blocked by the song-file:// sandbox.
      const detected = await window.api.scanVideo(folderPath)
      if (!isCurrentLibrarySong(songId, folderPath, loadVersion)) return

      const videoJson = await window.api.readVideoJson(folderPath)
      if (!isCurrentLibrarySong(songId, folderPath, loadVersion)) return
      const jsonClips = (videoJson?.clips as VideoSync['clips']) || []
      const jsonOffset = (videoJson?.offsetMs as number) || 0

      if (detected) {
        store.getState().updateVideoSync({
          videoPath: detected.filePath,
          clips: jsonClips,
          offsetMs: jsonOffset
        })
        store.getState().markClean()
        return
      }

      // No file in the folder — fall back to whatever video.json says (e.g. an
      // http(s) URL) so remote / explicitly-pathed videos still work.
      if (videoJson && (videoJson.videoPath || jsonClips.length > 0)) {
        store.getState().updateVideoSync({
          videoPath: videoJson.videoPath as string | undefined,
          clips: jsonClips,
          offsetMs: jsonOffset
        })
        store.getState().markClean()
      }
    } catch (error) {
      console.error('Failed to load video sync for:', folderPath, error)
    }
  }, [])

  const loadAudioSync = useCallback(async (songId: string, folderPath: string) => {
    try {
      const loadVersion = useProjectStore.getState().libraryLoadVersion
      const store = getSongStore(songId)

      const audioJson = await window.api.readAudioJson(folderPath)
      if (!isCurrentLibrarySong(songId, folderPath, loadVersion)) return
      if (audioJson && Array.isArray(audioJson.clips)) {
        const audioSync: Partial<AudioSync> = {
          clips: (audioJson.clips as AudioSync['clips']) || []
        }
        store.getState().updateAudioSync(audioSync)
        store.getState().markClean()
        return
      }

      const detected = await window.api.readAudio(folderPath)
      if (!isCurrentLibrarySong(songId, folderPath, loadVersion)) return
      if (detected && detected.length > 0) {
        store.getState().updateAudioSync({
          clips: detected.map((file, index) => ({
            id: `audio-${index}-${Date.now()}`,
            filePath: file.filePath,
            filename: file.filename,
            startMs: 0,
            sourceStartMs: 0,
            durationMs: 0
          }))
        })
        store.getState().markClean()
      }
    } catch (error) {
      console.error('Failed to load audio sync for:', folderPath, error)
    }
  }, [])

  const loadVenueTrack = useCallback(async (songId: string, folderPath: string) => {
    try {
      const loadVersion = useProjectStore.getState().libraryLoadVersion
      const store = getSongStore(songId)
      const venueJson = await window.api.readVenueJson(folderPath)
      if (!isCurrentLibrarySong(songId, folderPath, loadVersion)) return
      if (!venueJson) return

      const venueTrack: Partial<VenueTrackData> = {
        autoGenerated: !!venueJson.autoGenerated,
        lighting: Array.isArray(venueJson.lighting) ? venueJson.lighting as VenueTrackData['lighting'] : [],
        postProcessing: Array.isArray(venueJson.postProcessing) ? venueJson.postProcessing as VenueTrackData['postProcessing'] : [],
        stage: Array.isArray(venueJson.stage) ? venueJson.stage as VenueTrackData['stage'] : [],
        performer: Array.isArray(venueJson.performer) ? venueJson.performer as VenueTrackData['performer'] : [],
        cameraCuts: Array.isArray(venueJson.cameraCuts) ? venueJson.cameraCuts as VenueTrackData['cameraCuts'] : []
      }

      store.getState().updateVenueTrack(venueTrack)
      store.getState().markClean()
    } catch (error) {
      console.error('Failed to load venue track for:', folderPath, error)
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
      const audioSync = getSongStore(activeSongId).getState().song.audioSync
      if (audioSync.clips.length === 0) {
        await loadAudioSync(activeSongId, folderPath)
      }
      const venueTrack = getSongStore(activeSongId).getState().song.venueTrack
      if (
        !venueTrack.autoGenerated
        && venueTrack.lighting.length === 0
        && venueTrack.postProcessing.length === 0
        && venueTrack.stage.length === 0
        && venueTrack.performer.length === 0
        && venueTrack.cameraCuts.length === 0
      ) {
        await loadVenueTrack(activeSongId, folderPath)
      }
    }
    load()
  }, [activeSongId, loadSongMidi, loadVideoSync, loadAudioSync, loadVenueTrack])

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

      // Clean up existing song stores
      const preferredActiveId = activeSongId
      setActiveSong(null)
      for (const id of songIds) {
        removeSongStore(id)
      }

      // 2. Save as last opened folder
      updateSettings({ lastOpenedFolder: folderPath })

      // 3. Load the folder
      await loadFolder(folderPath, preferredActiveId)
    } catch (error) {
      console.error('Failed to open folder:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleRefresh = async (): Promise<void> => {
    if (!loadedFolderPath) return
    try {
      setIsLoading(true)

      // Clean up existing song stores
      const preferredActiveId = activeSongId
      setActiveSong(null)
      for (const id of songIds) {
        removeSongStore(id)
      }

      await loadFolder(loadedFolderPath, preferredActiveId)
    } catch (error) {
      console.error('Failed to refresh folder:', error)
    } finally {
      setIsLoading(false)
    }
  }

  // Handle native menu commands for File actions
  useEffect(() => {
    return window.api.onMenuCommand((command) => {
      if (command === 'file:open-folder') {
        void handleOpenFolder()
      }
      if (command === 'file:new-song' && loadedFolderPath) {
        setShowNewSongDialog(true)
      }
    })
  }, [handleOpenFolder, loadedFolderPath])

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
        laneMarkers: [],
        songSections: [],
        tempoEvents: [{ tick: 0, bpm: 120 }],
        timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
        videoSync: { clips: [], offsetMs: 0, trimStartMs: 0, trimEndMs: 0 },
        audioSync: { clips: [] },
        venueTrack: { autoGenerated: false, lighting: [], postProcessing: [], stage: [], performer: [], cameraCuts: [] },
        sourceFormat: 'midi'
      })

      addSong(result.id)
      setSongAddedTimes((current) => new Map(current).set(result.id, Date.now()))
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
    const result = await window.api.importAudio(folderPath, audioPath)
    if (!result) return
    await audioService.loadAudio(activeSongId, folderPath)
    const sources = audioService.getAudioSources(activeSongId)
    const source = sources.find((entry) => entry.filePath === result.filePath) ?? sources.find((entry) => entry.filename === result.filename)
    store.getState().updateAudioSync({
      clips: [
        ...store.getState().song.audioSync.clips,
        {
          id: `audio-clip-${Date.now()}`,
          filePath: result.filePath,
          filename: result.filename,
          startMs: 0,
          sourceStartMs: 0,
          durationMs: source ? Math.round(source.duration * 1000) : 0
        }
      ]
    })
  }

  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string; folderPath: string } | null>(null)

  const handleDeleteSong = (songId: string): void => {
    const store = getSongStore(songId)
    const songName = store.getState().song.metadata.name
    const folderPath = store.getState().song.folderPath
    setPendingDelete({ id: songId, name: songName, folderPath })
  }

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    const { id, folderPath } = pendingDelete
    setPendingDelete(null)
    const deleted = await window.api.deleteSongFolder(folderPath)
    if (deleted) {
      removeSong(id)
      removeSongStore(id)
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
            +
          </button>
          <button className="icon-button" onClick={handleOpenFolder} title="Open Folder">
            📂
          </button>
        </div>
      </div>

      <div className="panel-content">
        {loadedFolderPath ? (
          <>
            {/* Folder path display */}
            <div className="explorer-folder-path" title={loadedFolderPath}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                <span className="folder-icon">📂</span>
                <span className="folder-name">
                  {loadedFolderPath.split(/[\\/]/).pop() || loadedFolderPath}
                </span>
              </div>
              <button
                className={`icon-button explorer-refresh-button ${isLoading ? 'spinning' : ''}`}
                onClick={handleRefresh}
                title="Refresh Folder"
                disabled={isLoading}
                style={{ marginLeft: 'auto', flexShrink: 0 }}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  style={{ width: '14px', height: '14px' }}
                >
                  <path
                    d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"
                    fill="currentColor"
                  />
                </svg>
              </button>
            </div>

            <div className="explorer-library-tools">
              <input
                className="explorer-library-search"
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Filter songs or artists"
                aria-label="Filter song library"
              />
              <div className="explorer-library-selects">
                <select
                  value={librarySort}
                  onChange={(event) => setLibrarySort(event.target.value as LibrarySort)}
                  aria-label="Sort song library"
                >
                  <option value="title">Sort: Title</option>
                  <option value="artist">Sort: Artist</option>
                  <option value="added-newest">Sort: Added (Newest)</option>
                  <option value="added-oldest">Sort: Added (Oldest)</option>
                  <option value="year-newest">Sort: Year (Newest)</option>
                  <option value="year-oldest">Sort: Year (Oldest)</option>
                </select>
                <select
                  value={libraryGroup}
                  onChange={(event) => setLibraryGroup(event.target.value as LibraryGroup)}
                  aria-label="Group song library"
                >
                  <option value="title-initial">Group: Title A–Z</option>
                  <option value="artist">Group: Artist</option>
                  <option value="year">Group: Year</option>
                  <option value="none">Group: None</option>
                </select>
              </div>
            </div>

            {/* Song list */}
            <div className="explorer-song-list">
              {songEntries.length > 0 ? (
                organizedSongs.length > 0 && organizedSongs.some(({ songs }) => songs.length > 0) ? (
                  organizedSongs.map((group) => (
                    <div className="explorer-song-group" key={group.label || 'all'}>
                      {group.label && <div className="explorer-song-group-header">{group.label}</div>}
                      {group.songs.map((song) => (
                        <SongItem
                          key={song.id}
                          song={song}
                          isActive={activeSongId === song.id}
                          onSelect={() => handleSongSelect(song.id)}
                          onDelete={() => handleDeleteSong(song.id)}
                        />
                      ))}
                    </div>
                  ))
                ) : (
                  <div className="explorer-empty">No songs match “{searchQuery}”</div>
                )
              ) : (
                <div className="explorer-empty">
                  <span>{isLoading ? 'Loading library…' : 'No songs found'}</span>
                  <span className="explorer-empty-hint">
                    {isLoading ? 'Checking the cache and validating song folders' : 'Add folders containing song.ini files'}
                  </span>
                </div>
              )}
              {isLoading && songEntries.length > 0 && (
                <div className="explorer-cache-status" role="status">
                  <span className="explorer-cache-spinner" /> Validating library…
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">📁</div>
            <div className="empty-state-title">{isLoading ? 'Loading...' : 'No Folder Open'}</div>
            <div className="empty-state-description">
              Open a folder containing songs to get started
            </div>
            <button className="explorer-open-button" onClick={handleOpenFolder}>
              Open Folder
            </button>
          </div>
        )}
      </div>
      {pendingDelete && (
        <div
          className="delete-confirm-overlay"
          onClick={() => setPendingDelete(null)}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="delete-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="delete-confirm-title">Delete song?</div>
            <div className="delete-confirm-body">
              “{pendingDelete.name}” will be moved to the trash.
            </div>
            <div className="delete-confirm-actions">
              <button className="delete-confirm-cancel" onClick={() => setPendingDelete(null)}>
                Cancel
              </button>
              <button className="delete-confirm-delete" onClick={confirmDelete} autoFocus>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

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
