import { useEffect, useState, useCallback } from 'react'
import { useStore } from 'zustand'
import { useSettingsStore, useUIStore, useProjectStore, getSongStore } from '../stores'
import './ExportModal.css'

interface ExportModalProps {
  onSaveBeforeExport: () => Promise<void>
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim()
}

export function ExportModal({ onSaveBeforeExport }: ExportModalProps): React.JSX.Element | null {
  const isOpen = useUIStore((s) => s.isExportModalOpen)
  const setExportModalOpen = useUIStore((s) => s.setExportModalOpen)
  
  const activeSongId = useProjectStore((s) => s.activeSongId)
  const autoChartOutputDir = useSettingsStore((s) => s.autoChartOutputDir)
  const sngLastExportDir = useSettingsStore((s) => s.sngLastExportDir)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const [outputFolder, setOutputFolder] = useState<string>('')
  const [filename, setFilename] = useState<string>('')
  const [saveBeforeExport, setSaveBeforeExport] = useState<boolean>(true)
  
  const [status, setStatus] = useState<'idle' | 'saving' | 'exporting' | 'success' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [exportedPath, setExportedPath] = useState<string>('')

  const [isInitialized, setIsInitialized] = useState<boolean>(false)
  const [showOverwriteWarning, setShowOverwriteWarning] = useState<boolean>(false)

  // Get current song data reactively
  const songStore = getSongStore(activeSongId || 'default')
  const song = useStore(songStore, (s) => s.song)

  const showReset = outputFolder !== (autoChartOutputDir || '')

  const getFullOutputPath = useCallback((folder: string, name: string): string => {
    if (!folder.trim()) return ''
    let finalFilename = name.trim()
    if (!finalFilename) {
      finalFilename = `${sanitizeFilename(song?.metadata.name || 'song')}.sng`
    } else if (!finalFilename.toLowerCase().endsWith('.sng')) {
      finalFilename += '.sng'
    }
    const separator = folder.includes('\\') ? '\\' : '/'
    return folder.endsWith(separator) 
      ? `${folder}${finalFilename}` 
      : `${folder}${separator}${finalFilename}`
  }, [song])

  const checkOverwrite = useCallback(async (folder: string, file: string) => {
    const fullPath = getFullOutputPath(folder, file)
    if (!fullPath) {
      setShowOverwriteWarning(false)
      return
    }
    try {
      const exists = await window.api.fileExists(fullPath)
      setShowOverwriteWarning(exists)
    } catch (err) {
      console.error('Error checking if file exists:', err)
      setShowOverwriteWarning(false)
    }
  }, [getFullOutputPath])

  // Initialize output folder and filename when the modal is opened
  useEffect(() => {
    if (song && !isInitialized) {
      const initialFolder = sngLastExportDir || autoChartOutputDir || ''
      const name = song.metadata.name || 'song'
      const initialFilename = `${sanitizeFilename(name)}.sng`
      setOutputFolder(initialFolder)
      setFilename(initialFilename)
      setIsInitialized(true)
      setStatus('idle')
      setErrorMessage('')
      setExportedPath('')
      
      checkOverwrite(initialFolder, initialFilename)
    }
  }, [song, isInitialized, autoChartOutputDir, sngLastExportDir, checkOverwrite])

  // Dismiss modal on Escape key press
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && status !== 'saving' && status !== 'exporting') {
        setExportModalOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, status, setExportModalOpen])

  if (!isOpen || !activeSongId || !song) return null

  const handleBrowse = async () => {
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

  const handleExport = async () => {
    if (!outputFolder.trim()) {
      setErrorMessage('Please select a destination output folder.')
      setStatus('error')
      return
    }

    let finalFilename = filename.trim()
    if (!finalFilename) {
      finalFilename = `${sanitizeFilename(song.metadata.name || 'song')}.sng`
    } else if (!finalFilename.toLowerCase().endsWith('.sng')) {
      finalFilename += '.sng'
    }

    setStatus('saving')
    setErrorMessage('')

    try {
      // 1. Optionally save the song first (so disk files are up to date)
      if (saveBeforeExport) {
        await onSaveBeforeExport()
      }

      // 2. Perform the export
      setStatus('exporting')
      
      const separator = outputFolder.includes('\\') ? '\\' : '/'
      const fullOutputPath = outputFolder.endsWith(separator) 
        ? `${outputFolder}${finalFilename}` 
        : `${outputFolder}${separator}${finalFilename}`

      const result = await window.api.exportSng(
        song.folderPath,
        song.metadata as Record<string, unknown>,
        fullOutputPath
      )

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
    <div className="export-modal-overlay" onClick={() => status !== 'saving' && status !== 'exporting' && setExportModalOpen(false)}>
      <div className="export-modal" onClick={(e) => e.stopPropagation()}>
        <div className="export-modal-header">
          <div>
            <h2 className="export-modal-title">Export Song Package</h2>
            <p className="export-modal-subtitle">Package and build your song for rhythm games.</p>
          </div>
          <button 
            className="export-modal-close" 
            onClick={() => setExportModalOpen(false)}
            disabled={status === 'saving' || status === 'exporting'}
          >
            ✕
          </button>
        </div>

        <div className="export-modal-body">
          {status === 'success' ? (
            <div className="export-status-container success">
              <span className="export-status-icon">✅</span>
              <h3>Export Successful!</h3>
              <p className="export-success-message">Your song has been successfully packaged into a single Clone Hero .sng file.</p>
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
                  <div className="export-format-card active">
                    <div className="export-format-card-header">
                      <span className="export-format-badge">Active</span>
                      <span className="export-format-icon">🎸</span>
                    </div>
                    <h4>Clone Hero (.sng)</h4>
                    <p>Standard encrypted archive packaging notes, audio stems, and art into a single file container.</p>
                  </div>
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
                          disabled={status === 'saving' || status === 'exporting'}
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
                        disabled={status === 'saving' || status === 'exporting'}
                      />
                      <button
                        className="export-modal-secondary"
                        onClick={handleBrowse}
                        disabled={status === 'saving' || status === 'exporting'}
                      >
                        Browse
                      </button>
                    </div>
                  </div>

                  {/* Filename Input */}
                  <div className="export-field-stack" style={{ marginTop: '12px' }}>
                    <label className="export-field-label">File Name</label>
                    <input
                      className="export-folder-input"
                      style={{ width: '100%' }}
                      type="text"
                      value={filename}
                      placeholder="e.g. My_Song.sng"
                      onChange={(e) => setFilename(e.target.value)}
                      onBlur={() => checkOverwrite(outputFolder, filename)}
                      disabled={status === 'saving' || status === 'exporting'}
                    />
                  </div>

                  {showOverwriteWarning && (
                    <div className="export-warning-banner">
                      <span className="warning-icon">⚠️</span>
                      <div className="warning-text">
                        <strong>File Already Exists</strong>
                        <p>Exporting will overwrite the existing file at this location.</p>
                      </div>
                    </div>
                  )}

                  {/* Save before export checkbox */}
                  <label className="export-checkbox-row" style={{ marginTop: '16px' }}>
                    <input
                      type="checkbox"
                      checked={saveBeforeExport}
                      onChange={(e) => setSaveBeforeExport(e.target.checked)}
                      disabled={status === 'saving' || status === 'exporting'}
                    />
                    <span>Save song edits to source directory before exporting</span>
                  </label>
                </div>
              </div>

              {/* Progress Overlay / State */}
              {(status === 'saving' || status === 'exporting') && (
                <div className="export-loading-overlay">
                  <div className="export-loading-spinner"></div>
                  <p>{status === 'saving' ? 'Saving song edits...' : 'Building .sng package...'}</p>
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
                disabled={status === 'saving' || status === 'exporting'}
              >
                Cancel
              </button>
              <button 
                className="export-modal-primary" 
                onClick={handleExport}
                disabled={status === 'saving' || status === 'exporting' || !outputFolder.trim()}
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
