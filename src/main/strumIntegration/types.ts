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
  urls: string[]
  includeKeys?: boolean
}

export interface AutoChartRunResult {
  success: boolean
  outputDir: string
  songFolders: string[]
  errors: string[]
}

