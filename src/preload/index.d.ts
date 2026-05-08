import { ElectronAPI } from '@electron-toolkit/preload'

interface ChartEditorAPI {
  // Dialog APIs
  openFolder: () => Promise<string | null>

  // Folder APIs
  scanFolder: (folderPath: string) => Promise<Array<{ id: string; path: string; name: string }>>

  // Dialog APIs
  openAudioDialog: () => Promise<string | null>
  openAudioFilesDialog: () => Promise<string[]>
  openAudioFolderDialog: () => Promise<string | null>
  openOutputFolderDialog: () => Promise<string | null>
  getDefaultAutoChartOutputDir: () => Promise<string>
  openLyricsFileDialog: () => Promise<{ filePath: string; content: string } | null>

  // Song APIs
  createSongFolder: (parentPath: string, folderName: string, audioPath?: string) => Promise<{ id: string; path: string; name: string } | null>
  deleteSongFolder: (songPath: string) => Promise<boolean>
  readSongIni: (songPath: string) => Promise<Record<string, string | number> | null>
  writeSongIni: (songPath: string, metadata: Record<string, unknown>) => Promise<boolean>
  readSongMidi: (songPath: string) => Promise<{ type: 'midi' | 'chart'; data: string } | null>
  writeSongMidi: (songPath: string, midiBase64: string) => Promise<boolean>
  writeSongChart: (songPath: string, chartText: string) => Promise<boolean>

  // Album art APIs
  readAlbumArt: (songPath: string) => Promise<string | null>
  writeAlbumArt: (songPath: string, dataUrl: string) => Promise<boolean>

  // Audio APIs
  importAudio: (songPath: string, audioSourcePath: string) => Promise<{ filePath: string; filename: string } | null>
  readAudio: (songPath: string) => Promise<{ filePath: string; filename: string }[] | null>
  readAudioJson: (songPath: string) => Promise<Record<string, unknown> | null>
  writeAudioJson: (songPath: string, data: unknown) => Promise<boolean>
  readVenueJson: (songPath: string) => Promise<Record<string, unknown> | null>
  writeVenueJson: (songPath: string, data: unknown) => Promise<boolean>

  // Video APIs
  openVideoDialog: () => Promise<string | null>
  importVideo: (songPath: string, videoSourcePath: string) => Promise<{ filePath: string; filename: string } | null>
  scanVideo: (songPath: string) => Promise<{ filePath: string; filename: string } | null>
  readVideoJson: (songPath: string) => Promise<Record<string, unknown> | null>
  writeVideoJson: (songPath: string, data: unknown) => Promise<boolean>
  downloadVideoUrl: (songPath: string, url: string) => Promise<{ success: boolean; filePath?: string; error?: string }>
  onDownloadProgress: (callback: (percent: number) => void) => () => void
  getWaveformSource: (songPath: string) => Promise<{ filePath: string } | null>

  // Export APIs
  saveVideoDialog: () => Promise<string | null>
  exportVideo: (options: {
    videoPath: string; audioPath: string; outputPath: string
    offsetMs: number; trimStartMs: number; trimEndMs: number
  }) => Promise<{ success: boolean; error?: string }>
  onExportProgress: (callback: (percent: number) => void) => () => void

  // STRUM auto-chart APIs
  startAutoChart: (options: {
    outputDir: string
    files: string[]
    folders: string[]
    urls: string[]
    includeKeys?: boolean
  }) => Promise<{ runId: string }>
  cancelAutoChart: (runId: string) => Promise<boolean>
  onAutoChartProgress: (callback: (event: {
    runId: string
    stage: string
    message: string
    percent?: number
    currentItem?: string
  }) => void) => () => void
  onAutoChartComplete: (callback: (event: {
    runId: string
    success: boolean
    outputDir: string
    songFolders: string[]
    errors: string[]
  }) => void) => () => void
  onAutoChartError: (callback: (event: {
    runId: string
    message: string
    requirementsPath?: string
  }) => void) => () => void

  // Bootstrapped Python runtime (managed in userData on packaged builds)
  getRuntimeStatus: () => Promise<{
    managed: boolean
    ready: boolean
    installing: boolean
    pythonPath: string
    pythonBuildTag: string
    pythonVersion: string
  }>
  bootstrapRuntime: () => Promise<{ ok: boolean; skipped?: boolean; message?: string }>

  // App updater events
  onUpdaterStatus: (callback: (status: {
    state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
    version?: string
    percent?: number
    message?: string
  }) => void) => () => void

  // App menu events
  onMenuCommand: (callback: (command: string, payload?: unknown) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: ChartEditorAPI
  }
}
