// Exercises runAutoChart's "YouTube rejected the download → refresh yt-dlp →
// retry once" orchestration with a fake worker process.
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const scratch = mkdtempSync(join(tmpdir(), 'octave-runner-test-'))
const sent: Array<{ channel: string; payload: unknown }> = []

vi.mock('electron', () => ({
  app: { getPath: () => scratch, isPackaged: false },
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: unknown) => sent.push({ channel, payload })
        }
      }
    ]
  },
  shell: { openPath: async () => '' }
}))

vi.mock('./runtimeBootstrap', () => ({
  ensureBootstrappedPython: async () => 'unused',
  isBootstrapTarget: () => false,
  detectAccelerator: () => 'cpu',
  getRuntimeRoot: () => scratch
}))
vi.mock('./demucsCppBootstrap', () => ({
  ensureDemucsCpp: async () => {
    throw new Error('no demucs.cpp in test')
  }
}))
vi.mock('./whisperCppBootstrap', () => ({
  ensureWhisperCpp: async () => {
    throw new Error('no whisper.cpp in test')
  }
}))

const refreshMock = vi.fn()
vi.mock('./ytDlpRefresh', async () => {
  const actual = await vi.importActual<typeof import('./ytDlpRefresh')>('./ytDlpRefresh')
  return { ...actual, ensureFreshYtDlp: (...args: unknown[]) => refreshMock(...args) }
})

// Fake worker: each spawn() pops the next scripted outcome.
type Outcome = { errorMessage: string } | { success: true }
const outcomes: Outcome[] = []
const spawnCalls: string[][] = []

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill(): boolean {
    return true
  }
}

const execFileMock = vi.fn()

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
  spawn: (_cmd: string, args: string[]) => {
    spawnCalls.push(args)
    const child = new FakeChild()
    const outcome = outcomes.shift()
    setTimeout(() => {
      if (!outcome) {
        child.emit('close', 1, null)
        return
      }
      if ('errorMessage' in outcome) {
        child.stdout.emit(
          'data',
          Buffer.from(
            `__OCTAVE_EVENT__${JSON.stringify({ kind: 'error', runId: 'run-1', message: outcome.errorMessage })}\n`
          )
        )
        child.emit('close', 1, null)
      } else {
        child.stdout.emit(
          'data',
          Buffer.from(
            `__OCTAVE_EVENT__${JSON.stringify({ kind: 'complete', runId: 'run-1', success: true, outputDir: scratch, songFolders: [], errors: [] })}\n`
          )
        )
        child.emit('close', 0, null)
      }
    }, 5)
    return child
  }
}))

import {
  cancelProfileUrlMaterialization,
  materializeProfileUrlAudio,
  resolvePythonCommand,
  runAutoChart
} from './runner'

const YT_403 =
  'yt-dlp 2026.03.17 could not download https://youtu.be/x: ERROR: unable to download video data: HTTP Error 403: Forbidden'

const baseOptions = {
  runId: 'run-1',
  outputDir: scratch,
  files: [] as string[],
  folders: [] as string[],
  stemFolders: [] as string[],
  urls: ['https://youtu.be/x']
}

beforeEach(() => {
  sent.length = 0
  outcomes.length = 0
  spawnCalls.length = 0
  refreshMock.mockReset()
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => cb(null)
  )
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.OCTAVE_STRUM_PYTHON
})

describe('runAutoChart yt-dlp refresh + retry', () => {
  it('uses OCTAVE managed Python in development when no candidate has STRUM dependencies', async () => {
    process.env.OCTAVE_STRUM_PYTHON = 'bare-development-python'
    execFileMock.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        cb(args.includes('-c') ? new Error('module unavailable') : null)
      }
    )

    await expect(resolvePythonCommand('bootstrap-dev-runtime')).resolves.toEqual({
      command: 'unused',
      baseArgs: []
    })
  })

  it('does not spawn yt-dlp when cancellation wins during its managed refresh', async () => {
    let releaseRefresh: (() => void) | undefined
    refreshMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseRefresh = resolve
        })
    )

    const materialization = materializeProfileUrlAudio('materialize-cancel', 'https://youtu.be/x')
    await vi.waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1))

    await expect(cancelProfileUrlMaterialization('materialize-cancel')).resolves.toBe(true)
    releaseRefresh?.()

    await expect(materialization).rejects.toThrow(/cancelled/)
    expect(spawnCalls).toHaveLength(0)
  })

  it('refreshes before a URL run, and retries once after a 403 when the refresh produced a newer build', async () => {
    refreshMock
      // proactive (throttled) check before the run
      .mockResolvedValueOnce({
        attempted: false,
        succeeded: false,
        changed: false,
        version: '2026.3.17',
        previousVersion: '2026.3.17'
      })
      // forced refresh after the 403
      .mockResolvedValueOnce({
        attempted: true,
        succeeded: true,
        changed: true,
        version: '2026.8.18.dev0',
        previousVersion: '2026.3.17'
      })
    outcomes.push({ errorMessage: YT_403 }, { success: true })

    const result = await runAutoChart(baseOptions)

    expect(result.success).toBe(true)
    expect(spawnCalls).toHaveLength(2)
    expect(refreshMock).toHaveBeenCalledTimes(2)
    expect(refreshMock.mock.calls[0][1]).toMatchObject({ runId: 'run-1' })
    expect(refreshMock.mock.calls[1][1]).toMatchObject({ runId: 'run-1', force: true })

    // The first attempt's worker error must NOT reach the renderer as a
    // terminal strum:error (it would lock the modal into its error state).
    expect(sent.filter((e) => e.channel === 'strum:error')).toHaveLength(0)
    const messages = sent
      .filter((e) => e.channel === 'strum:progress')
      .map((e) => (e.payload as { message: string }).message)
    expect(messages.some((m) => /yt-dlp updated to 2026\.8\.18\.dev0/.test(m))).toBe(true)
  })

  it('does not retry when the refresh found nothing newer, and explains why', async () => {
    refreshMock
      .mockResolvedValueOnce({
        attempted: false,
        succeeded: false,
        changed: false,
        version: '2026.8.18.dev0',
        previousVersion: '2026.8.18.dev0'
      })
      .mockResolvedValueOnce({
        attempted: true,
        succeeded: true,
        changed: false,
        version: '2026.8.18.dev0',
        previousVersion: '2026.8.18.dev0'
      })
    outcomes.push({ errorMessage: YT_403 })

    await expect(runAutoChart(baseOptions)).rejects.toThrow(
      /HTTP Error 403[\s\S]*already the newest available build \(yt-dlp 2026\.8\.18\.dev0\)/
    )
    expect(spawnCalls).toHaveLength(1)
    expect(refreshMock).toHaveBeenCalledTimes(2)
  })

  it('does not touch yt-dlp for runs without remote inputs', async () => {
    outcomes.push({ errorMessage: 'FFmpeg was not found on PATH.' })

    await expect(runAutoChart({ ...baseOptions, urls: [] })).rejects.toThrow(/FFmpeg was not found/)
    expect(refreshMock).not.toHaveBeenCalled()
    expect(spawnCalls).toHaveLength(1)
    // Non-yt-dlp errors are broadcast immediately as before.
    expect(sent.filter((e) => e.channel === 'strum:error')).toHaveLength(1)
  })

  it('does not retry non-yt-dlp failures on URL runs', async () => {
    refreshMock.mockResolvedValue({
      attempted: false,
      succeeded: false,
      changed: false,
      version: null,
      previousVersion: null
    })
    outcomes.push({ errorMessage: 'STRUM auto-chart run was cancelled.' })

    await expect(runAutoChart(baseOptions)).rejects.toThrow(/cancelled/)
    expect(spawnCalls).toHaveLength(1)
    expect(refreshMock).toHaveBeenCalledTimes(1)
    expect(sent.filter((e) => e.channel === 'strum:error')).toHaveLength(1)
  })

  it('treats URL stems in stem-song entries as remote inputs', async () => {
    refreshMock.mockResolvedValue({
      attempted: false,
      succeeded: false,
      changed: false,
      version: null,
      previousVersion: null
    })
    outcomes.push({ success: true })

    await runAutoChart({
      ...baseOptions,
      urls: [],
      stemSongs: [{ name: 'x', stems: { drums: 'https://youtu.be/d' } }]
    })
    expect(refreshMock).toHaveBeenCalledTimes(1)
  })
})
