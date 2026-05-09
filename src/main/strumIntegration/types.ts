export type StrumDevice = 'cuda' | 'mps' | 'cpu'

export type AutoChartStage =
  | 'bootstrap'
  | 'download'
  | 'separation'
  | 'drums'
  | 'guitar'
  | 'bass'
  | 'vocals'
  | 'keys'
  | 'merge'
  | 'complete'
  | 'error'

export interface AutoChartProgressEvent {
  runId: string
  stage: AutoChartStage
  message: string
  percent?: number
  currentItem?: string
}

export interface AutoChartRunOptions {
  runId: string
  cacheDir: string
  outputDir: string
  files: string[]
  folders: string[]
  /**
   * Pre-split stem folders. Each folder must contain individual stem files
   * (drums.wav, bass.wav, vocals.wav, other.wav) plus a song mix file
   * (song.wav / song.ogg / song.opus / song.mp3). The Python pipeline will
   * skip Demucs separation and use the user-supplied stems directly.
   */
  stemFolders: string[]
  urls: string[]
  includeKeys?: boolean
  /**
   * When true, skip all online metadata/album-art/lyric lookups in the
   * Python pipeline. Useful for fully-offline charting and to avoid
   * misidentifying custom uploads as well-known commercial songs.
   */
  disableOnlineLookup?: boolean
  /**
   * When true, skip vocal harmony detection (HARM2/HARM3 generation).
   * Saves a second whisper pass on the backing-vocals stem.
   */
  skipHarmonies?: boolean
}

export interface AutoChartRunResult {
  success: boolean
  outputDir: string
  songFolders: string[]
  errors: string[]
}

