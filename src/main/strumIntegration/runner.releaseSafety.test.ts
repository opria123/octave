import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/tmp/octave-release-safety' },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { runAutoChart } from './runner'

describe('release auto-chart safety', () => {
  it('fails closed instead of bootstrapping a mutable STRUM source fallback', async () => {
    await expect(
      runAutoChart({
        runId: 'release-no-profile',
        outputDir: '/tmp/octave-release-safety/output',
        files: [],
        folders: [],
        stemFolders: [],
        urls: []
      })
    ).rejects.toThrow(/verified STRUM Auto Chart profile/i)
  })
})
