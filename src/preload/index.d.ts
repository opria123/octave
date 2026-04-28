import { ElectronAPI } from '@electron-toolkit/preload'

interface ChartEditorAPI {
  // Dialog APIs
  openFolder: () => Promise<string | null>

  // Folder APIs
  scanFolder: (folderPath: string) => Promise<Array<{ id: string; path: string; name: string }>>

  // Dialog APIs
  openAudioDialog: () => Promise<string | null>

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
