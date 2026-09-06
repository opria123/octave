import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  bootstrap: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/octave-developer-runtime-test' },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openPath: vi.fn() }
}))
vi.mock('child_process', () => ({ execFile: mocks.execFile, spawn: vi.fn() }))
vi.mock('./runtimeBootstrap', () => ({
  ensureBootstrappedPython: mocks.bootstrap,
  isBootstrapTarget: () => true,
  detectAccelerator: () => 'cpu'
}))
vi.mock('./demucsCppBootstrap', () => ({ ensureDemucsCpp: vi.fn() }))
vi.mock('./whisperCppBootstrap', () => ({ ensureWhisperCpp: vi.fn() }))

import { resolvePythonCommand } from './runner'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'octave-developer-runtime-'))
  vi.stubEnv('OCTAVE_STRUM_PYTHON', '')
  mocks.bootstrap.mockReset()
  mocks.execFile.mockReset()
  mocks.execFile.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null) => void
    ) => {
      callback(null)
    }
  )
})

afterEach(async () => {
  expect(mocks.bootstrap).not.toHaveBeenCalled()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

async function createSelectedVenv(): Promise<string> {
  const executable =
    process.platform === 'win32'
      ? join(root, '.venv', 'Scripts', 'python.exe')
      : join(root, '.venv', 'bin', 'python')
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(executable, 'fixture interpreter')
  return executable
}

describe('developer STRUM interpreter selection on bootstrap platforms', () => {
  it('uses the explicit interpreter without requiring inference-only modules', async () => {
    vi.stubEnv('OCTAVE_STRUM_PYTHON', '/private/training/python')
    await expect(
      resolvePythonCommand('developer-training-runtime', { developerSourceRoot: root })
    ).resolves.toEqual({ command: '/private/training/python', baseArgs: [] })
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    expect(mocks.execFile.mock.calls[0].slice(0, 2)).toEqual([
      '/private/training/python',
      ['--version']
    ])
  })

  it('uses the selected checkout virtualenv instead of the app working directory', async () => {
    const executable = await createSelectedVenv()
    await expect(
      resolvePythonCommand('developer-training-runtime', { developerSourceRoot: root })
    ).resolves.toEqual({ command: executable, baseArgs: [] })
    expect(mocks.execFile.mock.calls[0].slice(0, 2)).toEqual([executable, ['--version']])
  })

  it('fails without downloading or trying system Python when the checkout has no environment', async () => {
    await expect(
      resolvePythonCommand('developer-training-runtime', { developerSourceRoot: root })
    ).rejects.toThrow('developer STRUM Python environment is unavailable')
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it('rejects a broken explicit interpreter without falling back to another environment', async () => {
    await createSelectedVenv()
    vi.stubEnv('OCTAVE_STRUM_PYTHON', '/private/broken/python')
    mocks.execFile.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: (error: Error) => void) => {
        callback(new Error('private interpreter failure'))
      }
    )
    await expect(
      resolvePythonCommand('developer-training-runtime', { developerSourceRoot: root })
    ).rejects.toThrow('developer STRUM Python environment is unavailable')
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
  })
})
