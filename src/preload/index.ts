import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  // Dialog APIs
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),

  // Folder APIs
  scanFolder: (folderPath: string): Promise<Array<{ id: string; path: string; name: string }>> =>
    ipcRenderer.invoke('folder:scan', folderPath),

  // Dialog APIs
  openAudioDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:openAudio'),

  // Song APIs
  createSongFolder: (parentPath: string, folderName: string, audioPath?: string): Promise<{ id: string; path: string; name: string } | null> =>
    ipcRenderer.invoke('song:createFolder', parentPath, folderName, audioPath),

  deleteSongFolder: (songPath: string): Promise<boolean> =>
    ipcRenderer.invoke('song:deleteFolder', songPath),

  importAudio: (songPath: string, audioSourcePath: string): Promise<{ filePath: string; filename: string } | null> =>
    ipcRenderer.invoke('song:importAudio', songPath, audioSourcePath),

  readSongIni: (songPath: string): Promise<Record<string, string | number> | null> =>
    ipcRenderer.invoke('song:readIni', songPath),

  writeSongIni: (songPath: string, metadata: Record<string, unknown>): Promise<boolean> =>
    ipcRenderer.invoke('song:writeIni', songPath, metadata),

  readSongMidi: (songPath: string): Promise<{ type: 'midi' | 'chart'; data: string } | null> =>
    ipcRenderer.invoke('song:readMidi', songPath),

  writeSongMidi: (songPath: string, midiBase64: string): Promise<boolean> =>
    ipcRenderer.invoke('song:writeMidi', songPath, midiBase64),

  writeSongChart: (songPath: string, chartText: string): Promise<boolean> =>
    ipcRenderer.invoke('song:writeChart', songPath, chartText),

  // Album art APIs
  readAlbumArt: (songPath: string): Promise<string | null> =>
    ipcRenderer.invoke('song:readAlbumArt', songPath),

  writeAlbumArt: (songPath: string, dataUrl: string): Promise<boolean> =>
    ipcRenderer.invoke('song:writeAlbumArt', songPath, dataUrl),

  // Audio APIs
  readAudio: (songPath: string): Promise<{ filePath: string; filename: string }[] | null> =>
    ipcRenderer.invoke('song:readAudio', songPath),

  // Video APIs
  openVideoDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:openVideo'),

  importVideo: (songPath: string, videoSourcePath: string): Promise<{ filePath: string; filename: string } | null> =>
    ipcRenderer.invoke('video:import', songPath, videoSourcePath),

  scanVideo: (songPath: string): Promise<{ filePath: string; filename: string } | null> =>
    ipcRenderer.invoke('video:scan', songPath),

  readVideoJson: (songPath: string): Promise<Record<string, unknown> | null> =>
    ipcRenderer.invoke('video:readJson', songPath),

  writeVideoJson: (songPath: string, data: unknown): Promise<boolean> =>
    ipcRenderer.invoke('video:writeJson', songPath, data),

  downloadVideoUrl: (songPath: string, url: string): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke('video:download-url', songPath, url),

  onDownloadProgress: (callback: (percent: number) => void): (() => void) => {
    const handler = (_event: unknown, percent: number): void => callback(percent)
    ipcRenderer.on('video:download-progress', handler)
    return () => ipcRenderer.removeListener('video:download-progress', handler)
  },

  getWaveformSource: (songPath: string): Promise<{ filePath: string } | null> =>
    ipcRenderer.invoke('audio:waveform', songPath),

  // Export APIs
  saveVideoDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveVideo'),

  exportVideo: (options: {
    videoPath: string; audioPath: string; outputPath: string
    offsetMs: number; trimStartMs: number; trimEndMs: number
  }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('video:export', options),

  onExportProgress: (callback: (percent: number) => void): (() => void) => {
    const handler = (_event: unknown, percent: number): void => callback(percent)
    ipcRenderer.on('video:export-progress', handler)
    return () => ipcRenderer.removeListener('video:export-progress', handler)
  },

  // App updater events
  onUpdaterStatus: (callback: (status: {
    state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
    version?: string
    percent?: number
    message?: string
  }) => void): (() => void) => {
    const handler = (_event: unknown, status: {
      state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
      version?: string
      percent?: number
      message?: string
    }): void => callback(status)
    ipcRenderer.on('updater:status', handler)
    return () => ipcRenderer.removeListener('updater:status', handler)
  },

  // App menu command events
  onMenuCommand: (callback: (command: string, payload?: unknown) => void): (() => void) => {
    const handler = (_event: unknown, data: { command: string; payload?: unknown }): void => {
      callback(data.command, data.payload)
    }
    ipcRenderer.on('menu:command', handler)
    return () => ipcRenderer.removeListener('menu:command', handler)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
