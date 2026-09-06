import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { discoverDatasetPackageSources } from './packageSourceDiscovery'

describe('discoverDatasetPackageSources', () => {
  const testDir = join(__dirname, '../../../out/package_source_discovery_test_temp')

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true })
  })

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('uses bounded stat-only discovery without opening a selected package', async () => {
    const nested = join(testDir, 'nested')
    await mkdir(nested, { recursive: true })
    const packagePath = join(nested, 'private-source.zip')
    await writeFile(packagePath, 'not an archive')

    const discovery = await discoverDatasetPackageSources(testDir)

    expect(discovery).toEqual({
      packagePaths: [packagePath],
      packageLimitReached: false,
      directoryLimitReached: false
    })
  })

  it('stops promptly when discovery is cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      discoverDatasetPackageSources(testDir, { signal: controller.signal })
    ).rejects.toThrow('cancelled')
  })

  it('checks cancellation between entries instead of buffering a whole directory', async () => {
    const incrementalDir = join(testDir, 'incremental')
    await mkdir(incrementalDir, { recursive: true })
    await Promise.all(
      Array.from(
        { length: 128 },
        async (_, index) => await writeFile(join(incrementalDir, `${index}.zip`), '')
      )
    )
    const controller = new AbortController()

    await expect(
      discoverDatasetPackageSources(incrementalDir, {
        signal: controller.signal,
        onEntryScanned: () => controller.abort()
      })
    ).rejects.toThrow('cancelled')
  })

  it('stops at the package limit instead of walking an unbounded selection', async () => {
    const limitDir = join(testDir, 'limit')
    await mkdir(limitDir, { recursive: true })
    await Promise.all(
      Array.from(
        { length: 1_001 },
        async (_, index) => await writeFile(join(limitDir, `${index}.zip`), '')
      )
    )

    const discovery = await discoverDatasetPackageSources(limitDir)

    expect(discovery.packagePaths).toHaveLength(1_000)
    expect(discovery.packageLimitReached).toBe(true)
  })
})
