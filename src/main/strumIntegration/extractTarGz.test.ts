import { beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.fn()
const existsSyncMock = vi.fn()

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args)
}))

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args)
}))

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined)
}))

import { extractTarGz, _resetTarCommandCacheForTests } from './extractTarGz'

function completeWith(err: Error | null): void {
  execFileMock.mockImplementation((_cmd, _args, cb) => {
    ;(cb as (err: Error | null) => void)(err)
  })
}

describe('extractTarGz', () => {
  beforeEach(() => {
    _resetTarCommandCacheForTests()
    execFileMock.mockReset()
    existsSyncMock.mockReset()
  })

  it('prefers the absolute System32 tar.exe on Windows (issue #65: broken PATH)', async () => {
    if (process.platform !== 'win32') return
    existsSyncMock.mockReturnValue(true)
    completeWith(null)

    await extractTarGz('C:\\a.tar.gz', 'C:\\dest')

    const [command, args] = execFileMock.mock.calls[0]
    expect(command).toMatch(/System32[\\/]tar\.exe$/i)
    expect(args).toEqual(['-xzf', 'C:\\a.tar.gz', '-C', 'C:\\dest'])
  })

  it('falls back to PATH lookup when the bundled tar is missing', async () => {
    existsSyncMock.mockReturnValue(false)
    completeWith(null)

    await extractTarGz('/a.tar.gz', '/dest')

    expect(execFileMock.mock.calls[0][0]).toBe('tar')
  })

  it('rewrites spawn ENOENT into an actionable error message', async () => {
    existsSyncMock.mockReturnValue(false)
    const enoent = Object.assign(new Error('spawn tar ENOENT'), { code: 'ENOENT' })
    completeWith(enoent)

    await expect(extractTarGz('/a.tar.gz', '/dest')).rejects.toThrow(
      /Could not find the "tar" utility/
    )
  })

  it('passes through non-ENOENT tar failures unchanged', async () => {
    existsSyncMock.mockReturnValue(false)
    completeWith(new Error('tar: corrupted archive'))

    await expect(extractTarGz('/a.tar.gz', '/dest')).rejects.toThrow('tar: corrupted archive')
  })
})
