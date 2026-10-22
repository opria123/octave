import { useEffect, useState, useCallback } from 'react'
import { useStore } from 'zustand'
import { useSettingsStore, useUIStore, useProjectStore, getSongStore } from '../stores'
import {
  EXPORT_FORMATS,
  joinExportPath,
  resolveExportName,
  type ExportFormat
} from '../utils/exportNaming'
import { serializeSongToChartText } from '../utils/chartFile'
import './ExportModal.css'

interface ExportModalProps {
  onSaveBeforeExport: () => Promise<void>
}

const SUCCESS_MESSAGES: Record<ExportFormat, string> = {
  sng: 'Your song has been successfully packaged into a single Clone Hero .sng file.',
  chart: 'Your song has been exported as a Clone Hero song folder with a plain-text notes.chart.',
  rb3con: 'Your song has been successfully packaged into a Rock Band 3 STFS CON file.'
}

const PROGRESS_MESSAGES: Record<ExportFormat, string> = {
  sng: 'Building .sng package...',
  chart: 'Writing .chart song folder...',
  rb3con: 'Building .con package...'
}

export function ExportModal({ onSaveBeforeExport }: ExportModalProps): React.JSX.Element | null {
  const isOpen = useUIStore((s) => s.isExportModalOpen)
  const setExportModalOpen = useUIStore((s) => s.setExportModalOpen)

  const activeSongId = useProjectStore((s) => s.activeSongId)
  const autoChartOutputDir = useSettingsStore((s) => s.autoChartOutputDir)
  const sngLastExportDir = useSettingsStore((s) => s.sngLastExportDir)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  // Get current song data reactively
  const songStore = getSongStore(activeSongId || 'default')
  const song = useStore(songStore, (s) => s.song)

  const [outputFolder, setOutputFolder] = useState<string>(
    sngLastExportDir || autoChartOutputDir || ''
  )
  const [filename, setFilename] = useState<string>(() =>
    resolveExportName('', 'sng', song?.metadata.name)
  )
  const [saveBeforeExport, setSaveBeforeExport] = useState<boolean>(true)
  const [exportFormat, setExportFormat] = useState<ExportFormat>('sng')

  const [status, setStatus] = useState<'idle' | 'saving' | 'exporting' | 'success' | 'error'>(
    'idle'
  )
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [exportedPath, setExportedPath] = useState<string>('')

  const [showOverwriteWarning, setShowOverwriteWarning] = useState<boolean>(false)

  const showReset = outputFolder !== (autoChartOutputDir || '')
  const formatInfo = EXPORT_FORMATS.find((f) => f.id === exportFormat) ?? EXPORT_FORMATS[0]
  const isBusy = status === 'saving' || status === 'exporting'

  const getFullOutputPath = useCallback(
    (folder: string, name: string, formatOverride?: ExportFormat): string => {
      if (!folder.trim()) return ''
      const format = formatOverride || exportFormat
      return joinExportPath(folder, resolveExportName(name, format, song?.metadata.name))
    },
    [song, exportFormat]
  )

  const checkOverwrite = useCallback(
    async (folder: string, file: string, formatOverride?: ExportFormat) => {
      const fullPath = getFullOutputPath(folder, file, formatOverride)
      if (!fullPath) {
        setShowOverwriteWarning(false)
        return
      }
      try {
        // A .chart export is a folder, so look for anything at the path.
        const exists = await window.api.pathExists(fullPath)
        setShowOverwriteWarning(exists)
      } catch (err) {
        console.error('Error checking if export target exists:', err)
        setShowOverwriteWarning(false)
      }
    },
    [getFullOutputPath]
  )

  // Initialize checks once on mount
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    checkOverwrite(outputFolder, filename)
  }, [checkOverwrite, outputFolder, filename])

  // Dismiss modal on Escape key press
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && status !== 'saving' && status !== 'exporting') {
        setExportModalOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, status, setExportModalOpen])

  const handleFormatChange = useCallback(
    (newFormat: ExportFormat): void => {
      setExportFormat(newFormat)
      const newFilename = resolveExportName(filename, newFormat, song?.metadata.name)
      setFilename(newFilename)
      checkOverwrite(outputFolder, newFilename, newFormat)
    },
    [filename, outputFolder, checkOverwrite, song]
  )

  if (!isOpen || !activeSongId || !song) return null

  const handleBrowse = async (): Promise<void> => {
    try {
      const path = await window.api.openOutputFolderDialog()
      if (path) {
        setOutputFolder(path)
        checkOverwrite(path, filename)
      }
    } catch (err) {
      console.error('Failed to open output folder dialog:', err)
    }
  }

  const handleExport = async (): Promise<void> => {
    if (!outputFolder.trim()) {
      setErrorMessage('Please select a destination output folder.')
      setStatus('error')
      return
    }

    const finalFilename = resolveExportName(filename, exportFormat, song.metadata.name)

    setStatus('saving')
    setErrorMessage('')

    try {
      // 1. Optionally save the song first (so disk files are up to date)
      if (saveBeforeExport) {
        await onSaveBeforeExport()
      }

      // 2. Perform the export
      setStatus('exporting')

      const fullOutputPath = joinExportPath(outputFolder, finalFilename)
      const metadata = song.metadata as Record<string, unknown>

      let result
      if (exportFormat === 'rb3con') {
        result = await window.api.exportCon(song.folderPath, metadata, fullOutputPath)
      } else if (exportFormat === 'chart') {
        // The chart is serialized from the live editor state so MIDI-sourced
        // songs export without first being converted on disk (issue #77).
        const chartText = serializeSongToChartText(song)
        result = await window.api.exportChart(song.folderPath, metadata, chartText, fullOutputPath)
      } else {
        result = await window.api.exportSng(song.folderPath, metadata, fullOutputPath)
      }

      if (result.success) {
        setExportedPath(fullOutputPath)
        updateSettings({ sngLastExportDir: outputFolder })
        setStatus('success')
        setShowOverwriteWarning(false)
      } else {
        setErrorMessage(result.error || 'Failed to export the song package.')
        setStatus('error')
      }
    } catch (err) {
      console.error('Export error:', err)
      setErrorMessage(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }

  return (
    <div
      className="export-modal-overlay"
      onClick={() => status !== 'saving' && status !== 'exporting' && setExportModalOpen(false)}
    >
      <div className="export-modal" onClick={(e) => e.stopPropagation()}>
        <div className="export-modal-header">
          <div>
            <h2 className="export-modal-title">Export Song Package</h2>
            <p className="export-modal-subtitle">Package and build your song for rhythm games.</p>
          </div>
          <button
            className="export-modal-close"
            onClick={() => setExportModalOpen(false)}
            disabled={isBusy}
          >
            ✕
          </button>
        </div>

        <div className="export-modal-body">
          {status === 'success' ? (
            <div className="export-status-container success">
              <span className="export-status-icon">✅</span>
              <h3>Export Successful!</h3>
              <p className="export-success-message">{SUCCESS_MESSAGES[exportFormat]}</p>
              <div className="export-path-preview">
                <div className="export-path-code-container">
                  <strong>Destination:</strong>
                  <code>{exportedPath}</code>
                </div>
                <button
                  className="export-modal-secondary reveal-folder-button"
                  onClick={() => window.api.showItemInFolder(exportedPath)}
                >
                  📁 Show in Folder
                </button>
              </div>
            </div>
          ) : (
            <>
              {status === 'error' && (
                <div className="export-error-banner">
                  <span className="error-icon">⚠️</span>
                  <div className="error-text">
                    <strong>Export Failed</strong>
                    <p>{errorMessage}</p>
                  </div>
                </div>
              )}

              {/* Formats Section */}
              <div className="export-section">
                <h3 className="export-section-title">Format Option</h3>
                <div className="export-formats-grid">
                  {EXPORT_FORMATS.map((format) =>
                    format.id === exportFormat ? (
                      <div className="export-format-card active" key={format.id}>
                        <div className="export-format-card-header">
                          <span className="export-format-badge">Active</span>
                          <span className="export-format-icon">{format.icon}</span>
                        </div>
                        <h4>{format.title}</h4>
                        <p>{format.description}</p>
                      </div>
                    ) : (
                      <div
                        className="export-format-card inactive"
                        key={format.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleFormatChange(format.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            handleFormatChange(format.id)
                          }
                        }}
                      >
                        <h4>{format.title}</h4>
                      </div>
                    )
                  )}
                </div>
              </div>

              {/* Destination Section */}
              <div className="export-section">
                <h3 className="export-section-title">Destination & Naming</h3>

                <div className="export-preferences-body" style={{ padding: 0 }}>
                  {/* Output Folder Picker */}
                  <div className="export-field-stack">
                    <div className="export-folder-label-row">
                      <label className="export-field-label">Output Folder</label>
                      {showReset && (
                        <button
                          className="export-reset-button"
                          onClick={() => {
                            const defaultDir = autoChartOutputDir || ''
                            setOutputFolder(defaultDir)
                            checkOverwrite(defaultDir, filename)
                          }}
                          disabled={isBusy}
                        >
                          Reset to Default
                        </button>
                      )}
                    </div>
                    <div className="export-folder-picker">
                      <input
                        className="export-folder-input"
                        type="text"
                        value={outputFolder}
                        placeholder="Click browse to choose an export directory..."
                        onChange={(e) => setOutputFolder(e.target.value)}
                        onBlur={() => checkOverwrite(outputFolder, filename)}
                        disabled={isBusy}
                      />
                      <button
                        className="export-modal-secondary"
                        onClick={handleBrowse}
                        disabled={isBusy}
                      >
                        Browse
                      </button>
                    </div>
                  </div>

                  {/* Filename / folder name Input */}
                  <div className="export-field-stack" style={{ marginTop: '12px' }}>
                    <label className="export-field-label">{formatInfo.nameLabel}</label>
                    <input
                      className="export-folder-input"
                      style={{ width: '100%' }}
                      type="text"
                      value={filename}
                      placeholder={formatInfo.namePlaceholder}
                      onChange={(e) => setFilename(e.target.value)}
                      onBlur={() => checkOverwrite(outputFolder, filename)}
                      disabled={isBusy}
                    />
                  </div>

                  {showOverwriteWarning && (
                    <div className="export-warning-banner">
                      <span className="warning-icon">⚠️</span>
                      <div className="warning-text">
                        <strong>
                          {exportFormat === 'chart'
                            ? 'Folder Already Exists'
                            : 'File Already Exists'}
                        </strong>
                        <p>
                          {exportFormat === 'chart'
                            ? 'Exporting will overwrite notes.chart, song.ini and matching audio/art files inside the existing folder.'
                            : 'Exporting will overwrite the existing file at this location.'}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Save before export checkbox */}
                  <label className="export-checkbox-row" style={{ marginTop: '16px' }}>
                    <input
                      type="checkbox"
                      checked={saveBeforeExport}
                      onChange={(e) => setSaveBeforeExport(e.target.checked)}
                      disabled={isBusy}
                    />
                    <span>Save song edits to source directory before exporting</span>
                  </label>
                </div>
              </div>

              {/* Progress Overlay / State */}
              {isBusy && (
                <div className="export-loading-overlay">
                  <div className="export-loading-spinner"></div>
                  <p>
                    {status === 'saving' ? 'Saving song edits...' : PROGRESS_MESSAGES[exportFormat]}
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        <div className="export-modal-footer">
          {status === 'success' ? (
            <button className="export-modal-primary" onClick={() => setExportModalOpen(false)}>
              Done
            </button>
          ) : (
            <>
              <button
                className="export-modal-secondary"
                onClick={() => setExportModalOpen(false)}
                disabled={isBusy}
              >
                Cancel
              </button>
              <button
                className="export-modal-primary"
                onClick={handleExport}
                disabled={isBusy || !outputFolder.trim()}
              >
                Export
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
