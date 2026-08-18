import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { isManagedPython, isYtDlpBlockedError } from './ytDlpRefresh'

describe('isYtDlpBlockedError', () => {
  it('matches the YouTube 403 error as surfaced by the STRUM worker', () => {
    expect(
      isYtDlpBlockedError(
        'Unhandled STRUM worker error: ERROR: unable to download video data: HTTP Error 403: Forbidden'
      )
    ).toBe(true)
  })

  it('matches the yt-dlp CLI failure text returned by execFile', () => {
    expect(
      isYtDlpBlockedError(
        'Command failed: python -m yt_dlp ...\nERROR: unable to download video data: HTTP Error 403: Forbidden'
      )
    ).toBe(true)
  })

  it('matches missing-format and signature failures', () => {
    expect(isYtDlpBlockedError('ERROR: [youtube] abc: Requested format is not available')).toBe(
      true
    )
    expect(isYtDlpBlockedError('WARNING: [youtube] abc: nsig extraction failed')).toBe(true)
  })

  it('ignores unrelated failures so they are not retried', () => {
    expect(isYtDlpBlockedError('STRUM auto-chart run was cancelled.')).toBe(false)
    expect(isYtDlpBlockedError('FFmpeg was not found on PATH.')).toBe(false)
    expect(isYtDlpBlockedError('ERROR: [youtube] abc: Video unavailable')).toBe(false)
    expect(isYtDlpBlockedError('HTTP Error 404: Not Found')).toBe(false)
  })
})

describe('isManagedPython', () => {
  const originalEnv = process.env.OCTAVE_YTDLP_AUTO_REFRESH

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OCTAVE_YTDLP_AUTO_REFRESH
    else process.env.OCTAVE_YTDLP_AUTO_REFRESH = originalEnv
  })

  it('allows a workspace-local .venv in dev', () => {
    delete process.env.OCTAVE_YTDLP_AUTO_REFRESH
    expect(isManagedPython({ command: 'F:\\repo\\.venv\\Scripts\\python.exe', baseArgs: [] })).toBe(
      true
    )
    expect(isManagedPython({ command: '/repo/.venv/bin/python', baseArgs: [] })).toBe(true)
  })

  it('refuses system interpreters in dev', () => {
    delete process.env.OCTAVE_YTDLP_AUTO_REFRESH
    expect(isManagedPython({ command: 'py', baseArgs: ['-3.11'] })).toBe(false)
    expect(isManagedPython({ command: 'python3', baseArgs: [] })).toBe(false)
  })

  it('can be disabled via OCTAVE_YTDLP_AUTO_REFRESH=0', () => {
    process.env.OCTAVE_YTDLP_AUTO_REFRESH = '0'
    expect(isManagedPython({ command: '/repo/.venv/bin/python', baseArgs: [] })).toBe(false)
  })
})
