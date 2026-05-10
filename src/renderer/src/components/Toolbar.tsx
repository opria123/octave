// Top toolbar with playback controls and global actions
import { useState, useEffect, useCallback, useRef } from 'react'
import { useProjectStore, useSettingsStore, getSongStore } from '../stores'
import * as audioService from '../services/audioService'
import * as playbackController from '../services/playbackController'
import { parseMidiBase64, parseChartFile, serializeMidiBase64, serializeChartFile } from '../utils/midiParser'
import { validateChart, type ValidationIssue } from '../utils/chartValidation'
import type { SongMetadata } from '../types'
import { SettingsModal } from './SettingsModal'
import './Toolbar.css'

type AutoChartProgressState = {
  runId: string | null
  stage: string
  message: string
  percent: number
  currentItem?: string
  isRunning: boolean
  outputDir: string
  error: string | null
  warnings: string[]
}

const EMPTY_AUTO_CHART_URL = ''
const AUTO_CHART_STAGE_ORDER: Record<string, number> = {
  bootstrap: 0,
  download: 1,
  separation: 2,
  drums: 3,
  guitar: 4,
  bass: 5,
  vocals: 6,
  keys: 7,
  merge: 8,
  complete: 9,
  error: 10
}

export function Toolbar(): React.JSX.Element {
  const { activeSongId, setLoadedFolder, addSong, setActiveSong } = useProjectStore()
  const {
    autosaveEnabled,
    highwaySpeed,
    volume,
    leftyFlip,
    enableAutoChart,
    autoChartOutputDir,
    updateSettings
  } = useSettingsStore()
  const [isAudioLoaded, setIsAudioLoaded] = useState(false)
  const [isAutoChartModalOpen, setIsAutoChartModalOpen] = useState(false)
  const [autoChartFiles, setAutoChartFiles] = useState<string[]>([])
  const [autoChartFolders, setAutoChartFolders] = useState<string[]>([])
  const [autoChartStemFolders, setAutoChartStemFolders] = useState<string[]>([])
  const [autoChartInputTab, setAutoChartInputTab] = useState<'mix' | 'stems'>('mix')
  const [autoChartFullMixSubTab, setAutoChartFullMixSubTab] = useState<'files' | 'folders' | 'urls'>('files')
  type StemSong = {
    id: string
    name: string
    stems: { drums: string; bass: string; vocals: string; other: string; guitar: string; piano: string; vocalsHarm2: string; vocalsHarm3: string }
    extras: string[]
  }
  const makeEmptyStemSong = (): StemSong => ({
    id: `stem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    stems: { drums: '', bass: '', vocals: '', other: '', guitar: '', piano: '', vocalsHarm2: '', vocalsHarm3: '' },
    extras: []
  })
  const [autoChartStemSongs, setAutoChartStemSongs] = useState<StemSong[]>([makeEmptyStemSong()])
  const [autoChartUrls, setAutoChartUrls] = useState<string[]>([EMPTY_AUTO_CHART_URL])
  const [autoChartDisableOnlineLookup, setAutoChartDisableOnlineLookup] = useState(false)
  const [autoChartAdvancedOpen, setAutoChartAdvancedOpen] = useState(false)
  // Optional user-supplied tempo map. Empty = use STRUM's auto-detection.
  // First entry's BPM (sorted by timeSec) overrides initial detected tempo.
  const [autoChartTempoEvents, setAutoChartTempoEvents] = useState<Array<{ timeSec: string; bpm: string }>>([])
  const [autoChartEnabledTracks, setAutoChartEnabledTracks] = useState<{
    drums: boolean
    guitar: boolean
    bass: boolean
    vocals: boolean
    harmonies: boolean
    keys: boolean
    proKeys: boolean
  }>({ drums: true, guitar: true, bass: true, vocals: true, harmonies: true, keys: true, proKeys: true })
  const [autoChartCloseCountdown, setAutoChartCloseCountdown] = useState<number | null>(null)
  const [defaultAutoChartOutputDir, setDefaultAutoChartOutputDir] = useState('')
  const [autoChartErrorCopied, setAutoChartErrorCopied] = useState(false)
  const [autoChartProgress, setAutoChartProgress] = useState<AutoChartProgressState>({
    runId: null,
    stage: 'bootstrap',
    message: '',
    percent: 0,
    isRunning: false,
    outputDir: autoChartOutputDir ?? '',
    error: null,
    warnings: []
  })
  const [runtimeStatus, setRuntimeStatus] = useState<{
    managed: boolean
    ready: boolean
    installing: boolean
  } | null>(null)
  const [isInstallingRuntime, setIsInstallingRuntime] = useState(false)
  const [runtimeSetupError, setRuntimeSetupError] = useState<string | null>(null)
  const [runtimeSetupErrorCopied, setRuntimeSetupErrorCopied] = useState(false)

  const refreshRuntimeStatus = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.getRuntimeStatus()
      setRuntimeStatus({ managed: next.managed, ready: next.ready, installing: next.installing })
      if (!next.installing) setIsInstallingRuntime(false)
    } catch (err) {
      console.error('runtime:status failed', err)
    }
  }, [])

  const handleSetupRuntime = useCallback(async (): Promise<void> => {
    setIsInstallingRuntime(true)
    setRuntimeSetupError(null)
    setRuntimeSetupErrorCopied(false)
    try {
      const result = await window.api.bootstrapRuntime()
      if (!result.ok) setRuntimeSetupError(result.message ?? 'Setup failed.')
    } catch (err) {
      setRuntimeSetupError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsInstallingRuntime(false)
      await refreshRuntimeStatus()
    }
  }, [refreshRuntimeStatus])

  const handleCopyRuntimeSetupError = useCallback(async (): Promise<void> => {
    if (!runtimeSetupError) return
    try {
      await navigator.clipboard.writeText(runtimeSetupError)
      setRuntimeSetupErrorCopied(true)
      window.setTimeout(() => setRuntimeSetupErrorCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy runtime setup error:', err)
    }
  }, [runtimeSetupError])

  const getPreferredAutoChartOutputDir = useCallback((): string => {
    return autoChartOutputDir?.trim() || defaultAutoChartOutputDir
  }, [autoChartOutputDir, defaultAutoChartOutputDir])

  // Get active song store if available
  const songStore = activeSongId ? getSongStore(activeSongId) : null

  // Reactively subscribe to song store state so UI updates when isPlaying/folderPath changes
  const [isPlaying, setIsPlaying] = useState(false)
  const [_folderPath, setFolderPath] = useState<string | null>(null)
  const [songName, setSongName] = useState('')
  const [songArtist, setSongArtist] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [validationIssues, setValidationIssues] = useState<ValidationIssue[] | null>(null)
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

  useEffect(() => {
    let cancelled = false

    void window.api.getDefaultAutoChartOutputDir().then((defaultPath) => {
      if (cancelled) return

      setDefaultAutoChartOutputDir(defaultPath)

      const currentSettings = useSettingsStore.getState()
      const nextSettings: Partial<ReturnType<typeof useSettingsStore.getState>> = {}
      if (!currentSettings.autoChartOutputDir?.trim()) {
        nextSettings.autoChartOutputDir = defaultPath
      }
      if (!currentSettings.enableAutoChart && !currentSettings.autoChartOutputDir?.trim()) {
        nextSettings.enableAutoChart = true
      }
      if (Object.keys(nextSettings).length > 0) {
        updateSettings(nextSettings)
      }
    })

    return () => {
      cancelled = true
    }
  }, [updateSettings])

  const loadProjectFolder = useCallback(async (folderPath: string): Promise<void> => {
    setLoadedFolder(folderPath)
    const songFolders = await window.api.scanFolder(folderPath)

    for (const songFolder of songFolders) {
      try {
        const iniData = await window.api.readSongIni(songFolder.path)

        const metadata: SongMetadata = {
          ...(iniData ?? {}),
          name: (iniData?.name as string) || (iniData?.title as string) || songFolder.name,
          artist: (iniData?.artist as string) || 'Unknown Artist',
          album: iniData?.album as string,
          genre: iniData?.genre as string,
          year: iniData?.year !== undefined ? String(iniData.year) : undefined,
          charter: iniData?.charter as string,
          song_length: iniData?.song_length as number,
          preview_start_time: iniData?.preview_start_time as number
        }

        let parsedData: ReturnType<typeof parseMidiBase64> | null = null
        let sourceFormat: 'midi' | 'chart' = 'midi'

        const midiResult = await window.api.readSongMidi(songFolder.path)
        if (midiResult) {
          parsedData = midiResult.type === 'chart'
            ? parseChartFile(midiResult.data)
            : parseMidiBase64(midiResult.data)
          sourceFormat = midiResult.type === 'chart' ? 'chart' : 'midi'
        }

        const store = getSongStore(songFolder.id)
        store.getState().loadSong({
          id: songFolder.id,
          folderPath: songFolder.path,
          metadata,
          notes: parsedData?.notes ?? [],
          vocalNotes: parsedData?.vocalNotes ?? [],
          vocalPhrases: parsedData?.vocalPhrases ?? [],
          starPowerPhrases: parsedData?.starPowerPhrases ?? [],
          soloSections: parsedData?.soloSections ?? [],
          laneMarkers: parsedData?.laneMarkers ?? [],
          songSections: parsedData?.songSections ?? [],
          tempoEvents: parsedData?.tempoEvents ?? [{ tick: 0, bpm: 120 }],
          timeSignatures: parsedData?.timeSignatures ?? [{ tick: 0, numerator: 4, denominator: 4 }],
          videoSync: { clips: [], offsetMs: 0, trimStartMs: 0, trimEndMs: 0 },
          audioSync: { clips: [] },
          venueTrack: parsedData?.venueTrack ?? { autoGenerated: false, lighting: [], postProcessing: [], stage: [], performer: [], cameraCuts: [] },
          sourceFormat
        })

        addSong(songFolder.id)
      } catch (error) {
        console.error(`Failed to load song ${songFolder.name}:`, error)
      }
    }

    if (songFolders.length > 0) {
      setActiveSong(songFolders[0].id)
    }
  }, [addSong, setActiveSong, setLoadedFolder])

  const handleOpenFolder = async (): Promise<void> => {
    try {
      const folderPath = await window.api.openFolder()
      if (!folderPath) return
      await loadProjectFolder(folderPath)
    } catch (error) {
      console.error('Failed to open folder:', error)
    }
  }

  useEffect(() => {
    return window.api.onAutoChartProgress((event) => {
      // Runtime setup progress (Python install on first launch) is owned by
      // SetupModal; ignore here so it doesn't latch isRunning=true on the
      // Auto-Chart modal until the next app restart.
      if (event.runId === 'runtime-setup') return
      setAutoChartProgress((prev) => {
        if (prev.runId && event.runId !== prev.runId) return prev

        const currentRank = AUTO_CHART_STAGE_ORDER[prev.stage] ?? -1
        const incomingRank = AUTO_CHART_STAGE_ORDER[event.stage] ?? -1
        if (incomingRank < currentRank && event.stage !== 'error' && event.stage !== 'complete') {
          return prev
        }

        const incomingPercent = event.percent ?? prev.percent
        const nextPercent = incomingRank === currentRank
          ? Math.max(prev.percent, incomingPercent)
          : incomingPercent

        return {
          ...prev,
          runId: event.runId,
          stage: event.stage,
          message: event.message,
          percent: nextPercent,
          currentItem: event.currentItem,
          isRunning: event.stage !== 'complete' && event.stage !== 'error',
          error: null
        }
      })
    })
  }, [])

  useEffect(() => {
    return window.api.onAutoChartComplete((event) => {
      if (event.runId === 'runtime-setup') return
      setAutoChartProgress((prev) => {
        if (prev.runId !== event.runId) return prev
        return {
          ...prev,
          isRunning: false,
          percent: 100,
          stage: 'complete',
          message: event.success ? 'Auto-chart complete.' : 'Auto-chart finished with no successful songs.',
          warnings: event.errors
        }
      })

      if (event.success) {
        updateSettings({ autoChartOutputDir: event.outputDir, lastOpenedFolder: event.outputDir })
        void loadProjectFolder(event.outputDir)
        setAutoChartCloseCountdown(5)
      }
    })
  }, [loadProjectFolder, updateSettings])

  useEffect(() => {
    return window.api.onAutoChartError((event) => {
      if (event.runId === 'runtime-setup') return
      setAutoChartProgress((prev) => {
        if (prev.runId !== event.runId) return prev
        return {
          ...prev,
          isRunning: false,
          stage: 'error',
          error: event.message,
          message: event.message
        }
      })
    })
  }, [])

  // Tick the post-success countdown and auto-close the modal at 0.
  useEffect(() => {
    if (autoChartCloseCountdown === null) return
    if (autoChartCloseCountdown <= 0) {
      setIsAutoChartModalOpen(false)
      setAutoChartCloseCountdown(null)
      return
    }
    const timer = window.setTimeout(() => {
      setAutoChartCloseCountdown((prev) => (prev === null ? null : prev - 1))
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [autoChartCloseCountdown])

  const openAutoChartModal = useCallback((): void => {
    setAutoChartCloseCountdown(null)
    setAutoChartProgress((prev) => ({
      ...prev,
      outputDir: getPreferredAutoChartOutputDir(),
      error: null
    }))
    setAutoChartUrls((prev) => (prev.length > 0 ? prev : [EMPTY_AUTO_CHART_URL]))
    setRuntimeSetupError(null)
    void refreshRuntimeStatus()
    setIsAutoChartModalOpen(true)
  }, [getPreferredAutoChartOutputDir, refreshRuntimeStatus])

  const handleAddAutoChartUrl = useCallback((): void => {
    setAutoChartUrls((prev) => [...prev, EMPTY_AUTO_CHART_URL])
  }, [])

  const handleUpdateAutoChartUrl = useCallback((index: number, value: string): void => {
    setAutoChartUrls((prev) => prev.map((entry, entryIndex) => (entryIndex === index ? value : entry)))
  }, [])

  const handleRemoveAutoChartUrl = useCallback((index: number): void => {
    setAutoChartUrls((prev) => {
      if (prev.length === 1) {
        return [EMPTY_AUTO_CHART_URL]
      }

      return prev.filter((_, entryIndex) => entryIndex !== index)
    })
  }, [])

  const handleCopyAutoChartError = useCallback(async (): Promise<void> => {
    if (!autoChartProgress.error) return

    try {
      await navigator.clipboard.writeText(autoChartProgress.error)
      setAutoChartErrorCopied(true)
      window.setTimeout(() => setAutoChartErrorCopied(false), 2000)
    } catch (error) {
      console.error('Failed to copy auto-chart error:', error)
    }
  }, [autoChartProgress.error])

  const handleStartAutoChart = useCallback(async (): Promise<void> => {
    setAutoChartCloseCountdown(null)
    const outputDir = autoChartProgress.outputDir.trim()
    const urls = autoChartUrls.map((entry) => entry.trim()).filter(Boolean)

    // Build payload-ready stem songs: drop entries that don't have at least
    // a name and one stem, and trim empty stem slots so the worker doesn't
    // try to ingest blank paths.
    const stemSongs = autoChartStemSongs
      .map((song) => {
        const stems: Record<string, string> = {}
        for (const [key, value] of Object.entries(song.stems)) {
          const trimmed = value.trim()
          if (trimmed) stems[key] = trimmed
        }
        const extras = song.extras.map((v) => v.trim()).filter(Boolean)
        return { name: song.name.trim(), stems, extras }
      })
      .filter((song) => Object.keys(song.stems).length > 0 || song.extras.length > 0)

    if (runtimeStatus && runtimeStatus.managed && !runtimeStatus.ready) {
      setAutoChartProgress((prev) => ({
        ...prev,
        error: 'Set up the Python runtime before starting Auto-Chart.'
      }))
      return
    }

    if (!outputDir) {
      setAutoChartProgress((prev) => ({ ...prev, error: 'Choose an output folder before starting.' }))
      return
    }

    if (
      autoChartFiles.length === 0 &&
      autoChartFolders.length === 0 &&
      autoChartStemFolders.length === 0 &&
      stemSongs.length === 0 &&
      urls.length === 0
    ) {
      setAutoChartProgress((prev) => ({ ...prev, error: 'Add at least one audio file, folder, URL, or stem song.' }))
      return
    }

    // Each stem song needs a name and at least one charted/playable input
    // so the pipeline can produce a usable mix.
    for (const song of stemSongs) {
      if (!song.name) {
        setAutoChartProgress((prev) => ({ ...prev, error: 'Every stem song needs a name.' }))
        return
      }
      const hasInstrument = ['drums', 'bass', 'vocals', 'other', 'guitar', 'piano', 'vocalsHarm2', 'vocalsHarm3'].some((k) => song.stems[k])
      if (!hasInstrument && song.extras.length === 0) {
        setAutoChartProgress((prev) => ({ ...prev, error: `Stem song "${song.name}" has no stems selected.` }))
        return
      }
    }

    updateSettings({ autoChartOutputDir: outputDir })
    setAutoChartErrorCopied(false)
    setAutoChartProgress((prev) => ({
      ...prev,
      isRunning: true,
      error: null,
      warnings: [],
      message: 'Launching STRUM...',
      percent: 0
    }))

    try {
      const { runId } = await window.api.startAutoChart({
        outputDir,
        files: autoChartFiles,
        folders: autoChartFolders,
        stemFolders: autoChartStemFolders,
        stemSongs,
        urls,
        includeKeys: autoChartEnabledTracks.keys,
        disableOnlineLookup: autoChartDisableOnlineLookup,
        skipHarmonies: !autoChartEnabledTracks.harmonies,
        enabledTracks: autoChartEnabledTracks,
        tempoMap: (() => {
          const parsed = autoChartTempoEvents
            .map((e) => ({ timeSec: parseFloat(e.timeSec), bpm: parseFloat(e.bpm) }))
            .filter((e) => Number.isFinite(e.timeSec) && Number.isFinite(e.bpm) && e.bpm > 0 && e.timeSec >= 0)
            .sort((a, b) => a.timeSec - b.timeSec)
          return parsed.length > 0 ? parsed : undefined
        })()
      })
      setAutoChartProgress((prev) => ({ ...prev, runId }))
    } catch (error) {
      setAutoChartProgress((prev) => ({
        ...prev,
        isRunning: false,
        error: error instanceof Error ? error.message : String(error)
      }))
    }
  }, [autoChartDisableOnlineLookup, autoChartEnabledTracks, autoChartFiles, autoChartFolders, autoChartStemFolders, autoChartStemSongs, autoChartProgress.outputDir, autoChartTempoEvents, autoChartUrls, runtimeStatus, updateSettings])

  const handleCancelAutoChart = useCallback(async (): Promise<void> => {
    if (!autoChartProgress.runId) return
    await window.api.cancelAutoChart(autoChartProgress.runId)
  }, [autoChartProgress.runId])

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
            state.song.songSections,
            state.song.metadata as Record<string, unknown>,
            192,
            state.song.laneMarkers,
            state.song.venueTrack
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
            state.song.soloSections,
            state.song.songSections,
            state.song.laneMarkers,
            state.song.venueTrack
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

      if (state.song.audioSync.clips.length > 0) {
        await window.api.writeAudioJson(state.song.folderPath, {
          clips: state.song.audioSync.clips
        })
      }

      const venueTrack = state.song.venueTrack
      if (
        venueTrack.autoGenerated
        || venueTrack.lighting.length > 0
        || venueTrack.postProcessing.length > 0
        || venueTrack.stage.length > 0
        || venueTrack.performer.length > 0
        || venueTrack.cameraCuts.length > 0
      ) {
        await window.api.writeVenueJson(state.song.folderPath, venueTrack)
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
          style={{ ['--slider-fill' as string]: `${volume * 100}%` }}
        />
        <StemMixerButton activeSongId={activeSongId} />
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
          style={{ ['--slider-fill' as string]: `${((highwaySpeed - 0.25) / (3 - 0.25)) * 100}%` }}
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
        <label className="toolbar-toggle" title="Lefty Flip: mirror highway for left-handed players">
          <input
            type="checkbox"
            checked={leftyFlip ?? false}
            onChange={(e) => updateSettings({ leftyFlip: e.target.checked })}
          />
          <span className="toolbar-toggle-label">Lefty Flip</span>
        </label>
      </div>

      <div className="toolbar-separator" />

      {/* Auto-charter integration (placeholder) */}
      <div className="toolbar-group">
        <button
          className="toolbar-button toolbar-button-accent"
          disabled={!enableAutoChart}
          title={enableAutoChart ? 'Generate a chart package from audio with STRUM' : 'Enable STRUM auto-charting in Settings'}
          onClick={openAutoChartModal}
        >
          <span className="toolbar-icon">🤖</span>
          <span className="toolbar-label">Auto-Chart</span>
          <span className="toolbar-experimental-tag" title="Auto-charting is experimental — results vary by song.">experimental</span>
        </button>
      </div>

      <div className="toolbar-separator" />

      {/* Validate chart */}
      <div className="toolbar-group">
        <button
          className="toolbar-button"
          disabled={!activeSongId}
          title="Validate Chart"
          onClick={() => {
            if (!activeSongId) return
            const state = getSongStore(activeSongId).getState()
            const issues = validateChart(state.song)
            setValidationIssues(issues)
          }}
        >
          <span className="toolbar-icon">✓</span>
          <span className="toolbar-label">Validate</span>
        </button>
      </div>

      {/* Validation results modal */}
      {validationIssues !== null && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            backgroundColor: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}
          onClick={() => setValidationIssues(null)}
        >
          <div
            style={{
              backgroundColor: '#1e1e2e', border: '1px solid #444', borderRadius: 8,
              padding: '20px 24px', minWidth: 400, maxWidth: 600, maxHeight: '70vh',
              overflow: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ margin: 0, color: '#fff', fontSize: 16 }}>Chart Validation</h3>
              <button
                style={{ background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}
                onClick={() => setValidationIssues(null)}
              >✕</button>
            </div>
            {validationIssues.length === 0 ? (
              <p style={{ color: '#9CF69A', margin: 0 }}>✓ No issues found!</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {validationIssues.map((issue, i) => (
                  <li key={i} style={{
                    padding: '6px 10px', marginBottom: 6, borderRadius: 4,
                    backgroundColor: issue.severity === 'error' ? 'rgba(220,50,50,0.15)' : 'rgba(255,180,0,0.12)',
                    borderLeft: `3px solid ${issue.severity === 'error' ? '#dc3232' : '#ffb400'}`,
                    color: '#ddd', fontSize: 13
                  }}>
                    <span style={{ fontWeight: 600, color: issue.severity === 'error' ? '#f88' : '#ffcc44' }}>
                      {issue.severity === 'error' ? '✖ Error' : '⚠ Warning'}
                    </span>
                    <span style={{ marginLeft: 8 }}>{issue.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {isAutoChartModalOpen && (
        <div className="settings-modal-overlay" onClick={() => !autoChartProgress.isRunning && setIsAutoChartModalOpen(false)}>
          <div className="settings-modal auto-chart-modal" onClick={(event) => event.stopPropagation()}>
            <div className="settings-modal-header">
              <div>
                <h2 className="settings-modal-title">Auto-Chart from Audio</h2>
                <p className="settings-modal-subtitle">Run STRUM on local audio files, folders, or URLs and load the generated chart package output.</p>
              </div>
              <button
                className="settings-modal-close"
                onClick={() => !autoChartProgress.isRunning && setIsAutoChartModalOpen(false)}
                aria-label="Close auto-chart dialog"
              >
                X
              </button>
            </div>

            <div className="settings-modal-body auto-chart-body">
              {runtimeStatus && runtimeStatus.managed && !runtimeStatus.ready && (
                <div className="auto-chart-runtime-warning">
                  <h3>Python runtime not installed</h3>
                  <p>
                    Auto-Chart needs the bundled Python runtime (one-time download, ~1.5 GB).
                    Install it now to enable charting.
                  </p>
                  <div className="auto-chart-runtime-actions">
                    <button
                      type="button"
                      className="settings-modal-primary"
                      onClick={() => void handleSetupRuntime()}
                      disabled={isInstallingRuntime || runtimeStatus.installing}
                    >
                      {isInstallingRuntime || runtimeStatus.installing ? 'Installing\u2026' : 'Set up Python runtime'}
                    </button>
                  </div>
                  {runtimeSetupError && (
                    <div className="auto-chart-error">
                      <div className="auto-chart-error-header">
                        <strong>Setup Error</strong>
                        <button
                          className="auto-chart-error-copy"
                          onClick={() => void handleCopyRuntimeSetupError()}
                          type="button"
                        >
                          {runtimeSetupErrorCopied ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                      <pre className="auto-chart-error-text">{runtimeSetupError}</pre>
                    </div>
                  )}
                </div>
              )}
              <section className="settings-preferences-group">
                <h3 className="settings-hotkey-group-title">Inputs</h3>
                <fieldset
                  disabled={autoChartProgress.isRunning}
                  style={{ border: 'none', padding: 0, margin: 0, opacity: autoChartProgress.isRunning ? 0.55 : 1 }}
                >
                <div className="settings-preferences-body auto-chart-inputs">
                  {/* Top-level: Full Mix vs Stems */}
                  <div
                    role="tablist"
                    style={{
                      display: 'flex',
                      gap: 2,
                      borderBottom: '1px solid #444',
                      marginBottom: 12
                    }}
                  >
                    {([
                      { id: 'mix', label: 'Full Mix', count: autoChartFiles.length + autoChartFolders.length + autoChartUrls.filter((u) => u.trim()).length },
                      { id: 'stems', label: 'Stems', count: autoChartStemSongs.filter((s) => Object.values(s.stems).some((v) => v.trim()) || s.extras.some((e) => e.trim())).length }
                    ] as const).map((tab) => {
                      const active = autoChartInputTab === tab.id
                      return (
                        <button
                          key={tab.id}
                          role="tab"
                          aria-selected={active}
                          onClick={() => setAutoChartInputTab(tab.id)}
                          style={{
                            padding: '10px 18px',
                            border: 'none',
                            borderBottom: active ? '2px solid #4a9eff' : '2px solid transparent',
                            background: active ? '#2a2a2a' : 'transparent',
                            color: active ? '#fff' : '#bbb',
                            cursor: 'pointer',
                            fontWeight: active ? 600 : 500,
                            fontSize: 14
                          }}
                        >
                          {tab.label}
                          {tab.count > 0 && (
                            <span
                              style={{
                                marginLeft: 8,
                                padding: '1px 7px',
                                background: '#4a9eff',
                                color: '#fff',
                                borderRadius: 10,
                                fontSize: 11
                              }}
                            >
                              {tab.count}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>

                  {autoChartInputTab === 'mix' && (
                    <div>
                      {/* Sub-tabs: Audio Files / Audio Folders / URLs */}
                      <div
                        role="tablist"
                        style={{
                          display: 'flex',
                          gap: 2,
                          borderBottom: '1px solid #2f2f2f',
                          marginBottom: 12
                        }}
                      >
                        {([
                          { id: 'files', label: 'Audio Files', count: autoChartFiles.length },
                          { id: 'folders', label: 'Audio Folders', count: autoChartFolders.length },
                          { id: 'urls', label: 'URLs', count: autoChartUrls.filter((u) => u.trim()).length }
                        ] as const).map((tab) => {
                          const active = autoChartFullMixSubTab === tab.id
                          return (
                            <button
                              key={tab.id}
                              role="tab"
                              aria-selected={active}
                              onClick={() => setAutoChartFullMixSubTab(tab.id)}
                              style={{
                                padding: '6px 12px',
                                border: 'none',
                                borderBottom: active ? '2px solid #4a9eff' : '2px solid transparent',
                                background: 'transparent',
                                color: active ? '#fff' : '#999',
                                cursor: 'pointer',
                                fontWeight: active ? 600 : 400,
                                fontSize: 12
                              }}
                            >
                              {tab.label}
                              {tab.count > 0 && (
                                <span style={{ marginLeft: 6, padding: '1px 6px', background: '#4a9eff', color: '#fff', borderRadius: 10, fontSize: 10 }}>{tab.count}</span>
                              )}
                            </button>
                          )
                        })}
                      </div>

                      {autoChartFullMixSubTab === 'files' && (
                        <>
                          <div className="auto-chart-actions-row">
                            <button className="settings-modal-secondary" onClick={async () => {
                              const files = await window.api.openAudioFilesDialog()
                              if (files.length > 0) {
                                setAutoChartFiles((prev) => Array.from(new Set([...prev, ...files])))
                              }
                            }}>Add Files</button>
                          </div>
                          <p style={{ fontSize: 12, opacity: 0.7, margin: '6px 0 4px' }}>
                            Pick one or more individual audio files (.wav/.ogg/.opus/.mp3/.flac).
                          </p>
                          <div className="auto-chart-chip-list">
                            {autoChartFiles.map((file) => (
                              <button key={file} className="auto-chart-chip" onClick={() => setAutoChartFiles((prev) => prev.filter((entry) => entry !== file))}>
                                {file.split(/[\\/]/).pop()} ×
                              </button>
                            ))}
                          </div>
                        </>
                      )}

                      {autoChartFullMixSubTab === 'folders' && (
                        <>
                          <div className="auto-chart-actions-row">
                            <button className="settings-modal-secondary" onClick={async () => {
                              const folder = await window.api.openAudioFolderDialog()
                              if (folder) {
                                setAutoChartFolders((prev) => Array.from(new Set([...prev, folder])))
                              }
                            }}>Add Folder</button>
                          </div>
                          <p style={{ fontSize: 12, opacity: 0.7, margin: '6px 0 4px' }}>
                            Each folder is scanned for supported audio files; every file is processed as its own song.
                          </p>
                          <div className="auto-chart-chip-list">
                            {autoChartFolders.map((folder) => (
                              <button key={folder} className="auto-chart-chip" onClick={() => setAutoChartFolders((prev) => prev.filter((entry) => entry !== folder))}>
                                {folder.split(/[\\/]/).pop()} ×
                              </button>
                            ))}
                          </div>
                        </>
                      )}

                      {autoChartFullMixSubTab === 'urls' && (
                        <div className="settings-field-stack">
                          <div className="auto-chart-url-header">
                            <label className="settings-field-label" htmlFor="auto-chart-url-0">Audio / YouTube URLs</label>
                            <button className="auto-chart-icon-button" onClick={handleAddAutoChartUrl} title="Add URL row" aria-label="Add URL row">+</button>
                          </div>
                          <div className="auto-chart-url-list">
                            {autoChartUrls.map((url, index) => (
                              <div key={`auto-chart-url-${index}`} className="auto-chart-url-row">
                                <input
                                  id={`auto-chart-url-${index}`}
                                  className="settings-folder-input auto-chart-url-input"
                                  type="text"
                                  value={url}
                                  onChange={(event) => handleUpdateAutoChartUrl(index, event.target.value)}
                                  placeholder="Paste an audio or YouTube URL"
                                />
                                <button
                                  className="auto-chart-icon-button auto-chart-delete-button"
                                  onClick={() => handleRemoveAutoChartUrl(index)}
                                  title="Remove URL row"
                                  aria-label="Remove URL row"
                                >
                                  🗑
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {autoChartInputTab === 'stems' && (
                    <div>
                      <p style={{ fontSize: 12, opacity: 0.75, margin: '0 0 10px' }}>
                        Provide one file or URL per instrument. Empty slots are skipped — that instrument will not be charted, and the Demucs separation phase is skipped entirely (your stems are used as-is). The full mix is always auto-generated by summing your stems and extras. Lead vocals are charted strictly as PART VOCALS; backing vocals 1/2 drive HARM2/HARM3 and play back as vocals_1.ogg/vocals_2.ogg.
                      </p>
                      {autoChartStemSongs.map((song, songIdx) => (
                        <div key={song.id} style={{ border: '1px solid #333', borderRadius: 6, padding: 12, marginBottom: 10, background: '#1c1c1c' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                            <input
                              type="text"
                              className="settings-folder-input"
                              value={song.name}
                              onChange={(event) => {
                                const v = event.target.value
                                setAutoChartStemSongs((prev) => prev.map((s, i) => i === songIdx ? { ...s, name: v } : s))
                              }}
                              placeholder="Song name (used for output folder)"
                              style={{ flex: 1 }}
                            />
                            {autoChartStemSongs.length > 1 && (
                              <button
                                type="button"
                                className="auto-chart-icon-button auto-chart-delete-button"
                                onClick={() => setAutoChartStemSongs((prev) => prev.filter((_, i) => i !== songIdx))}
                                title="Remove this stem song"
                                aria-label="Remove stem song"
                              >🗑</button>
                            )}
                          </div>
                          <div style={{ display: 'grid', gap: 6 }}>
                            {([
                              { key: 'drums', label: 'Drums' },
                              { key: 'bass', label: 'Bass' },
                              { key: 'vocals', label: 'Vocals (lead)' },
                              { key: 'vocalsHarm2', label: 'Backing Vocals 1' },
                              { key: 'vocalsHarm3', label: 'Backing Vocals 2' },
                              { key: 'other', label: 'Other' },
                              { key: 'guitar', label: 'Guitar' },
                              { key: 'piano', label: 'Piano / Keys' }
                            ] as const).map((row) => (
                              <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <label style={{ width: 140, fontSize: 12, opacity: 0.85 }}>{row.label}</label>
                                <input
                                  type="text"
                                  className="settings-folder-input"
                                  value={song.stems[row.key]}
                                  onChange={(event) => {
                                    const v = event.target.value
                                    setAutoChartStemSongs((prev) => prev.map((s, i) => i === songIdx ? { ...s, stems: { ...s.stems, [row.key]: v } } : s))
                                  }}
                                  placeholder="File path or URL — leave blank to skip"
                                  style={{ flex: 1 }}
                                />
                                <button
                                  type="button"
                                  className="settings-modal-secondary"
                                  style={{ padding: '4px 10px', fontSize: 12 }}
                                  onClick={async () => {
                                    const files = await window.api.openAudioFilesDialog()
                                    const picked = files[0]
                                    if (picked) {
                                      setAutoChartStemSongs((prev) => prev.map((s, i) => i === songIdx ? { ...s, stems: { ...s.stems, [row.key]: picked } } : s))
                                    }
                                  }}
                                >Browse…</button>
                              </div>
                            ))}
                          </div>
                          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed #333' }}>
                            <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>
                              Extra audio (uncharted) — added to the full mix and exported as crowd.ogg.
                            </div>
                            <div style={{ display: 'grid', gap: 6 }}>
                              {song.extras.map((extra, extraIdx) => (
                                <div key={extraIdx} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <label style={{ width: 140, fontSize: 12, opacity: 0.85 }}>Extra {extraIdx + 1}</label>
                                  <input
                                    type="text"
                                    className="settings-folder-input"
                                    value={extra}
                                    onChange={(event) => {
                                      const v = event.target.value
                                      setAutoChartStemSongs((prev) => prev.map((s, i) => i === songIdx ? { ...s, extras: s.extras.map((e, j) => j === extraIdx ? v : e) } : s))
                                    }}
                                    placeholder="File path or URL"
                                    style={{ flex: 1 }}
                                  />
                                  <button
                                    type="button"
                                    className="settings-modal-secondary"
                                    style={{ padding: '4px 10px', fontSize: 12 }}
                                    onClick={async () => {
                                      const files = await window.api.openAudioFilesDialog()
                                      const picked = files[0]
                                      if (picked) {
                                        setAutoChartStemSongs((prev) => prev.map((s, i) => i === songIdx ? { ...s, extras: s.extras.map((e, j) => j === extraIdx ? picked : e) } : s))
                                      }
                                    }}
                                  >Browse…</button>
                                  <button
                                    type="button"
                                    className="auto-chart-icon-button auto-chart-delete-button"
                                    onClick={() => setAutoChartStemSongs((prev) => prev.map((s, i) => i === songIdx ? { ...s, extras: s.extras.filter((_, j) => j !== extraIdx) } : s))}
                                    title="Remove this extra"
                                    aria-label="Remove extra"
                                  >🗑</button>
                                </div>
                              ))}
                              <button
                                type="button"
                                className="settings-modal-secondary"
                                style={{ alignSelf: 'flex-start', padding: '4px 10px', fontSize: 12 }}
                                onClick={() => setAutoChartStemSongs((prev) => prev.map((s, i) => i === songIdx ? { ...s, extras: [...s.extras, ''] } : s))}
                              >+ Add extra audio</button>
                            </div>
                          </div>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="settings-modal-secondary"
                        onClick={() => setAutoChartStemSongs((prev) => [...prev, makeEmptyStemSong()])}
                      >+ Add another stem song</button>
                    </div>
                  )}

                  <div className="settings-field-stack" style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #333' }}>
                    <label className="settings-field-label" htmlFor="auto-chart-output">Output folder</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        id="auto-chart-output"
                        className="settings-folder-input"
                        type="text"
                        value={autoChartProgress.outputDir}
                        onChange={(event) => setAutoChartProgress((prev) => ({ ...prev, outputDir: event.target.value }))}
                        placeholder="Generated song folders will be written here"
                        style={{ flex: 1 }}
                      />
                      <button className="settings-modal-secondary" onClick={async () => {
                        const folder = await window.api.openOutputFolderDialog()
                        if (folder) {
                          setAutoChartProgress((prev) => ({ ...prev, outputDir: folder, error: null }))
                        }
                      }}>Browse…</button>
                    </div>
                  </div>
                </div>
                </fieldset>
              </section>

              <section className="settings-preferences-group">
                <button
                  type="button"
                  className="auto-chart-collapse-toggle"
                  onClick={() => setAutoChartAdvancedOpen((v) => !v)}
                  aria-expanded={autoChartAdvancedOpen}
                >
                  <span className="auto-chart-collapse-chevron" aria-hidden="true">
                    <svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M4 2.5L8 6L4 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <span>Advanced</span>
                </button>
                {autoChartAdvancedOpen && (
                <div className="settings-preferences-body">
                  <label className="settings-checkbox-row">
                    <input
                      type="checkbox"
                      checked={autoChartDisableOnlineLookup}
                      onChange={(event) => setAutoChartDisableOnlineLookup(event.target.checked)}
                      disabled={autoChartProgress.isRunning}
                    />
                    <span>
                      Offline mode (disable online lookups)
                      <small style={{ display: 'block', opacity: 0.7 }}>
                        Skips MusicBrainz, album art, and lyric searches. Use this for custom uploads to avoid them being misidentified as other songs.
                      </small>
                    </span>
                  </label>

                  <div style={{ marginTop: 12 }}>
                    {autoChartInputTab === 'stems' ? (
                      <p style={{ fontSize: 12, opacity: 0.7, margin: 0 }}>
                        Tracks to chart are determined automatically from the stems you provide on the Stems tab — only instruments with a stem will be charted.
                      </p>
                    ) : (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                          <strong style={{ fontSize: 13 }}>Tracks to chart</strong>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              type="button"
                              className="settings-modal-secondary"
                              style={{ fontSize: 11, padding: '2px 8px' }}
                              disabled={autoChartProgress.isRunning}
                              onClick={() => setAutoChartEnabledTracks({ drums: true, guitar: true, bass: true, vocals: true, harmonies: true, keys: true, proKeys: true })}
                            >All</button>
                            <button
                              type="button"
                              className="settings-modal-secondary"
                              style={{ fontSize: 11, padding: '2px 8px' }}
                              disabled={autoChartProgress.isRunning}
                              onClick={() => setAutoChartEnabledTracks({ drums: false, guitar: false, bass: false, vocals: false, harmonies: false, keys: false, proKeys: false })}
                            >None</button>
                          </div>
                        </div>
                        <p style={{ fontSize: 12, opacity: 0.7, margin: '0 0 8px' }}>
                          Uncheck any track you do not want STRUM to generate. All are charted by default.
                        </p>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px 16px' }}>
                          {([
                            { key: 'drums', label: 'Drums' },
                            { key: 'guitar', label: 'Guitar' },
                            { key: 'bass', label: 'Bass' },
                            { key: 'keys', label: 'Keys' },
                            { key: 'proKeys', label: 'Pro Keys' },
                            { key: 'vocals', label: 'Vocals' },
                            { key: 'harmonies', label: 'Vocal Harmonies (HARM2/3)' }
                          ] as const).map((track) => (
                            <label key={track.key} className="settings-checkbox-row" style={{ margin: 0 }}>
                              <input
                                type="checkbox"
                                checked={autoChartEnabledTracks[track.key]}
                                disabled={autoChartProgress.isRunning || (track.key === 'harmonies' && !autoChartEnabledTracks.vocals)}
                                onChange={(event) => setAutoChartEnabledTracks((prev) => {
                                  const next = { ...prev, [track.key]: event.target.checked }
                                  // Disabling vocals also disables harmonies.
                                  if (track.key === 'vocals' && !event.target.checked) next.harmonies = false
                                  return next
                                })}
                              />
                              <span>{track.label}</span>
                            </label>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  <div className="auto-chart-tempo-override">
                    <div className="auto-chart-tempo-header">
                      <strong>Tempo override</strong>
                      <button
                        type="button"
                        className="settings-modal-secondary"
                        style={{ fontSize: 11, padding: '2px 8px' }}
                        disabled={autoChartProgress.isRunning}
                        onClick={() => setAutoChartTempoEvents((prev) => [
                          ...prev,
                          { timeSec: prev.length === 0 ? '0' : '', bpm: '' }
                        ])}
                      >+ Add tempo</button>
                    </div>
                    <p className="auto-chart-tempo-help">
                      Leave empty to auto-detect. Add a row with time 0 to override the initial BPM, plus more rows to declare tempo changes at specific timestamps (in seconds). Note positions are retimed to keep audio sync.
                    </p>
                    {autoChartTempoEvents.length > 0 && (
                      <div className="auto-chart-tempo-list">
                        <div className="auto-chart-tempo-row auto-chart-tempo-row-head">
                          <span>Time (s)</span>
                          <span>BPM</span>
                          <span />
                        </div>
                        {autoChartTempoEvents.map((event, index) => (
                          <div key={index} className="auto-chart-tempo-row">
                            <input
                              type="number"
                              min={0}
                              step={0.01}
                              value={event.timeSec}
                              placeholder="0"
                              disabled={autoChartProgress.isRunning}
                              onChange={(e) => {
                                const v = e.target.value
                                setAutoChartTempoEvents((prev) => prev.map((row, i) => i === index ? { ...row, timeSec: v } : row))
                              }}
                            />
                            <input
                              type="number"
                              min={1}
                              step={0.001}
                              value={event.bpm}
                              placeholder="120"
                              disabled={autoChartProgress.isRunning}
                              onChange={(e) => {
                                const v = e.target.value
                                setAutoChartTempoEvents((prev) => prev.map((row, i) => i === index ? { ...row, bpm: v } : row))
                              }}
                            />
                            <button
                              type="button"
                              className="auto-chart-tempo-remove"
                              title="Remove"
                              disabled={autoChartProgress.isRunning}
                              onClick={() => setAutoChartTempoEvents((prev) => prev.filter((_, i) => i !== index))}
                            >×</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                )}
              </section>

              <section className="settings-preferences-group">
                <h3 className="settings-hotkey-group-title">Progress</h3>
                <div className="settings-preferences-body auto-chart-progress-panel">
                  <div className="auto-chart-progress-header">
                    <strong>{autoChartProgress.stage.toUpperCase()}</strong>
                    <span>{autoChartProgress.percent}%</span>
                  </div>
                  <div className="toolbar-updater-bar auto-chart-progress-bar">
                    <div className="toolbar-updater-bar-fill" style={{ width: `${autoChartProgress.percent}%` }} />
                  </div>
                  <div className="auto-chart-progress-message">
                    {autoChartCloseCountdown !== null
                      ? `All songs auto-charted. Closing in ${autoChartCloseCountdown}…`
                      : (autoChartProgress.message || 'Idle')}
                  </div>
                  {autoChartProgress.currentItem && (
                    <div className="auto-chart-progress-subtle">Current: {autoChartProgress.currentItem}</div>
                  )}
                  {autoChartProgress.error && (
                    <div className="auto-chart-error">
                      <div className="auto-chart-error-header">
                        <strong>Run Error</strong>
                        <button
                          className="auto-chart-error-copy"
                          onClick={() => void handleCopyAutoChartError()}
                          type="button"
                        >
                          {autoChartErrorCopied ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                      <div className="auto-chart-error-text">{autoChartProgress.error}</div>
                    </div>
                  )}
                  {autoChartProgress.warnings.length > 0 && (
                    <div className="auto-chart-warning-list">
                      {autoChartProgress.warnings.map((warning) => (
                        <div key={warning} className="auto-chart-warning-item">{warning}</div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            </div>

            <div className="settings-modal-footer">
              <button className="settings-modal-secondary" onClick={() => {
                setAutoChartFiles([])
                setAutoChartFolders([])
                setAutoChartStemFolders([])
                setAutoChartStemSongs([makeEmptyStemSong()])
                setAutoChartUrls([EMPTY_AUTO_CHART_URL])
                setAutoChartErrorCopied(false)
                setAutoChartProgress({
                  runId: null,
                  stage: 'bootstrap',
                  message: '',
                  percent: 0,
                  isRunning: false,
                  outputDir: getPreferredAutoChartOutputDir(),
                  error: null,
                  warnings: []
                })
              }} disabled={autoChartProgress.isRunning}>Reset</button>
              <button className="settings-modal-secondary" onClick={() => autoChartProgress.isRunning ? void handleCancelAutoChart() : setIsAutoChartModalOpen(false)}>
                {autoChartProgress.isRunning ? 'Cancel Run' : 'Close'}
              </button>
              <button className="settings-modal-primary" onClick={() => void handleStartAutoChart()} disabled={autoChartProgress.isRunning || (runtimeStatus?.managed === true && !runtimeStatus.ready)}>
                Start Auto-Chart
              </button>
            </div>
          </div>
        </div>
      )}

      <SettingsModal />
    </div>
  )
}

// Stem mixer popover button — lets the user mute/solo individual audio
// stems (drums.ogg, bass.ogg, vocals.ogg, etc.) loaded for the song.
function StemMixerButton({ activeSongId }: { activeSongId: string | null }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [stems, setStems] = useState<audioService.StemControl[]>([])
  const [popoverPos, setPopoverPos] = useState<{ top: number; right: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!activeSongId) {
      setStems([])
      return
    }
    const refresh = (): void => setStems(audioService.getStemControls(activeSongId))
    refresh()
    const off = audioService.onStemControlsChange(activeSongId, refresh)
    const offLoad = audioService.onAudioLoaded(activeSongId, refresh)
    return () => {
      off()
      offLoad()
    }
  }, [activeSongId])

  if (!activeSongId) return null

  const togglePopover = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    setStems(audioService.getStemControls(activeSongId))
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) {
      setPopoverPos({
        top: rect.bottom + 6,
        right: window.innerWidth - rect.right
      })
    }
    setOpen(true)
  }

  return (
    <div className="stem-mixer-wrapper">
      <button
        ref={buttonRef}
        className="toolbar-icon-button stem-mixer-button"
        onClick={togglePopover}
        title="Stem mixer (mute / solo individual tracks)"
        aria-label="Stem mixer"
      >
        <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <line x1="3" y1="2" x2="3" y2="14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <line x1="8" y1="2" x2="8" y2="14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <line x1="13" y1="2" x2="13" y2="14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <rect x="1.5" y="9" width="3" height="3" rx="0.6" fill="currentColor" />
          <rect x="6.5" y="4" width="3" height="3" rx="0.6" fill="currentColor" />
          <rect x="11.5" y="7" width="3" height="3" rx="0.6" fill="currentColor" />
        </svg>
      </button>
      {open && popoverPos && (
        <div
          className="stem-mixer-popover"
          style={{ position: 'fixed', top: popoverPos.top, right: popoverPos.right, zIndex: 1000 }}
        >
          <div className="stem-mixer-header">
            <span>Stem Mixer</span>
            <button className="stem-mixer-close" onClick={() => setOpen(false)} aria-label="Close">×</button>
          </div>
          {stems.length === 0 ? (
            <div className="stem-mixer-empty">No stems loaded.</div>
          ) : (
            <div className="stem-mixer-list">
              {stems.map((s) => (
                <div key={s.filePath} className="stem-mixer-row">
                  <div className="stem-mixer-row-header">
                    <span className="stem-mixer-row-name" title={s.filename}>
                      {s.filename}
                    </span>
                    <button
                      className={`stem-mixer-toggle${s.muted ? ' is-mute-active' : ''}`}
                      onClick={() => audioService.setStemMute(activeSongId, s.filePath, !s.muted)}
                      title="Mute"
                    >
                      M
                    </button>
                    <button
                      className={`stem-mixer-toggle${s.soloed ? ' is-solo-active' : ''}`}
                      onClick={() => audioService.setStemSolo(activeSongId, s.filePath, !s.soloed)}
                      title="Solo"
                    >
                      S
                    </button>
                  </div>
                  <div className="stem-mixer-row-volume">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={s.volume}
                      onChange={(e) =>
                        audioService.setStemVolume(activeSongId, s.filePath, parseFloat(e.target.value))
                      }
                      className="toolbar-volume-slider stem-mixer-volume-slider"
                      title={`Volume: ${Math.round(s.volume * 100)}%`}
                      style={{ ['--slider-fill' as string]: `${s.volume * 100}%` }}
                    />
                    <span className="stem-mixer-volume-value">{Math.round(s.volume * 100)}%</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
