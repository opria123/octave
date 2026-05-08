import { useCallback, useEffect, useRef, useState } from 'react'
import './SetupModal.css'

type RuntimeStatus = {
  managed: boolean
  ready: boolean
  installing: boolean
  pythonPath: string
  pythonBuildTag: string
  pythonVersion: string
}

type ProgressState = {
  stage: string
  message: string
  percent?: number
}

/**
 * First-launch setup banner / modal that proactively offers to provision the
 * managed Python runtime (python-build-standalone + AI dependencies) so the
 * first Auto-Chart run doesn't stall on a multi-minute install.
 *
 * - Only renders when the runtime is `managed` (packaged build) and not ready.
 * - Listens to `strum:progress` for `bootstrap` stage events while installing.
 * - "Not now" only hides for the current session; the modal returns next launch
 *   so the user always has a path back in. The auto-chart modal also exposes
 *   an inline setup CTA when the runtime isn't ready.
 */
export function SetupModal(): React.JSX.Element | null {
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const startedRef = useRef(false)

  const refreshStatus = useCallback(async () => {
    try {
      const next = await window.api.getRuntimeStatus()
      setStatus(next)
      if (next.installing) setInstalling(true)
    } catch (err) {
      console.error('runtime:status failed', err)
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    const offProgress = window.api.onAutoChartProgress((event) => {
      if (event.stage !== 'bootstrap') return
      setProgress({ stage: event.stage, message: event.message, percent: event.percent })
      setInstalling(true)
      setError(null)
    })
    const offError = window.api.onAutoChartError((event) => {
      if (event.runId !== 'runtime-setup') return
      setError(event.message)
      setInstalling(false)
    })
    return () => {
      offProgress()
      offError()
    }
  }, [])

  const handleInstall = useCallback(async () => {
    if (startedRef.current) return
    startedRef.current = true
    setInstalling(true)
    setError(null)
    setProgress({ stage: 'bootstrap', message: 'Starting setup\u2026', percent: 0 })
    try {
      const result = await window.api.bootstrapRuntime()
      if (!result.ok) {
        setError(result.message ?? 'Setup failed.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
      startedRef.current = false
      await refreshStatus()
    }
  }, [refreshStatus])

  const handleDismiss = useCallback(() => {
    setDismissed(true)
  }, [])

  if (!status) return null
  if (!status.managed) return null
  if (status.ready) return null
  if (dismissed && !installing) return null

  const percent = Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0)))

  return (
    <div className="setup-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="setup-modal-title">
      <div className="setup-modal">
        <h2 id="setup-modal-title">Set up AI features</h2>
        <p className="setup-modal-body">
          OCTAVE uses a self-contained Python runtime to power Auto-Chart, stem
          separation, and lyric transcription. This is a one-time download
          (~1.5 GB) installed in your user data folder. Updates to OCTAVE will
          not need to re-download it.
        </p>

        {installing ? (
          <>
            <div className="setup-modal-progress">
              <div className="setup-modal-progress-bar" style={{ width: `${percent}%` }} />
            </div>
            <div className="setup-modal-progress-meta">
              <span className="setup-modal-progress-stage">{progress?.message ?? 'Working\u2026'}</span>
              <span className="setup-modal-progress-percent">{percent}%</span>
            </div>
          </>
        ) : (
          <div className="setup-modal-actions">
            <button type="button" className="setup-modal-secondary" onClick={handleDismiss}>
              Not now
            </button>
            <button type="button" className="setup-modal-primary" onClick={handleInstall}>
              Set up now
            </button>
          </div>
        )}

        {error ? (
          <pre className="setup-modal-error">{error}</pre>
        ) : null}
      </div>
    </div>
  )
}
