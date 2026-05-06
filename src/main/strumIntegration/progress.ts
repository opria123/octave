import type { AutoChartProgressEvent, AutoChartStage } from './types'

const STAGE_PATTERNS: Array<{ stage: AutoChartStage; pattern: RegExp }> = [
  { stage: 'download', pattern: /hugging face|snapshot_download|downloading checkpoints/i },
  { stage: 'separation', pattern: /separating stems|demucs|^processing:\s/i },
  { stage: 'drums', pattern: /transcribing drums|loading drums/i },
  { stage: 'guitar', pattern: /transcribing guitar|loading guitar/i },
  { stage: 'bass', pattern: /transcribing bass|loading bass/i },
  { stage: 'vocals', pattern: /transcribing vocals|loading vocals charter|whisper/i },
  { stage: 'keys', pattern: /transcribing keys|loading keys charter/i },
  { stage: 'merge', pattern: /creating combined chart|chart enhancement|creating song\.ini|fetch album art/i },
  // Keep complete inference strict; broad matches like "successfully" can cause
  // premature 100% progress while the pipeline is still running.
  { stage: 'complete', pattern: /\b(complete:|finished processing|all done|auto-chart complete|pipeline complete|successfully processed)\b/i },
  { stage: 'error', pattern: /traceback|\bfailed\b|\bexception\b|\berror:\b|^error\b/i }
]

const STAGE_ORDER: AutoChartStage[] = [
  'bootstrap',
  'download',
  'separation',
  'drums',
  'guitar',
  'bass',
  'vocals',
  'keys',
  'merge',
  'complete'
]

const STAGE_PERCENT: Partial<Record<AutoChartStage, number>> = {
  bootstrap: 5,
  download: 20,
  separation: 30,
  drums: 45,
  guitar: 58,
  bass: 68,
  vocals: 78,
  keys: 86,
  merge: 94,
  complete: 100,
  error: 0
}

function getStagePercent(stage: AutoChartStage): number | undefined {
  const mapped = STAGE_PERCENT[stage]
  if (typeof mapped === 'number') {
    return mapped
  }

  const index = STAGE_ORDER.indexOf(stage)
  if (index === -1) return undefined
  return Math.round((index / (STAGE_ORDER.length - 1)) * 100)
}

export function parseAutoChartProgressLine(runId: string, line: string): AutoChartProgressEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  const match = STAGE_PATTERNS.find(({ pattern }) => pattern.test(trimmed))
  if (!match) {
    return {
      runId,
      stage: 'bootstrap',
      message: trimmed,
      percent: getStagePercent('bootstrap')
    }
  }

  return {
    runId,
    stage: match.stage,
    message: trimmed,
    percent: getStagePercent(match.stage)
  }
}
