import { mkdir, rename, rm, symlink, truncate, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import AdmZip from 'adm-zip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createDatasetPackageInventorySession,
  getDatasetPackageInventorySessionReviewEntries,
  inspectIsolatedPackageInWorker,
  inspectZipForInventoryTest,
  inventoryDatasetPackageSources,
  readInventoryPackageSnapshot,
  runDatasetPackageInventorySession,
  type DatasetPackageInventoryOptions
} from './packageSourceInventory'

describe('inventoryDatasetPackageSources', () => {
  const testDir = join(__dirname, '../../../out/package_source_inventory_test_temp')
  const localInspection: DatasetPackageInventoryOptions = {
    inspectInIsolation: async (source) => {
      try {
        return await inspectIsolatedPackageInWorker(source)
      } catch {
        return { outcome: 'rejected' }
      }
    }
  }

  function midiWithTrack(trackName: string, note = 60): Buffer {
    const name = Buffer.from(trackName)
    const events = Buffer.concat([
      Buffer.from([0x00, 0xff, 0x03, name.length]),
      name,
      Buffer.from([0x00, 0x90, note, 0x40, 0x83, 0x60, 0x80, note, 0x00, 0x00, 0xff, 0x2f, 0x00])
    ])
    const header = Buffer.from([
      0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0
    ])
    const track = Buffer.alloc(8 + events.length)
    track.write('MTrk', 0)
    track.writeUInt32BE(events.length, 4)
    events.copy(track, 8)
    return Buffer.concat([header, track])
  }

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true })
  })

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('returns aggregate-only bounded preparation counts for selected package sources', async () => {
    const archive = new AdmZip()
    archive.addFile('guitar/notes.mid', midiWithTrack('PART GUITAR'))
    archive.addFile('vocals/notes.mid', midiWithTrack('PART VOCALS'))
    archive.addFile('chart-only/notes.chart', Buffer.from('[Song]\n{\n  Resolution = 192\n}\n'))
    archive.addFile('invalid/notes.mid', Buffer.from('not a midi'))
    const packagePath = join(testDir, 'private-collection.zip')
    archive.writeZip(packagePath)

    const inventory = await inventoryDatasetPackageSources(
      [
        { kind: 'zip', sourcePath: packagePath },
        { kind: 'zip', sourcePath: packagePath },
        { kind: 'sng', sourcePath: join(testDir, 'missing-private-source.sng') }
      ],
      localInspection
    )

    expect(inventory).toMatchObject({
      selectedPackageCount: 3,
      inspectedPackageCount: 3,
      readablePackageCount: 2,
      readableHeaderCount: 2,
      unreadablePackageCount: 1,
      inspectedChartCount: 8,
      validNotesMidiCount: 4,
      invalidOrMissingNotesMidiCount: 4,
      chartOnlyCount: 2,
      exactExpertPartVocalsCount: 2,
      duplicateMidiCount: 2,
      duplicateContainerCount: 1,
      decodeTimeoutCount: 0,
      decodeFailureCount: 1
    })
    const serialized = JSON.stringify(inventory)
    expect(serialized).not.toContain(packagePath)
    expect(serialized).not.toContain('private-collection')
    expect(serialized).not.toContain('missing-private-source')
  })

  it('does not treat a similarly named Vocal track as canonical STRUM lead vocals', async () => {
    const archive = new AdmZip()
    archive.addFile('alt/notes.mid', midiWithTrack('PART VOCALS ALT'))
    const packagePath = join(testDir, 'alternate-vocals.zip')
    archive.writeZip(packagePath)

    await expect(
      inventoryDatasetPackageSources([{ kind: 'zip', sourcePath: packagePath }], localInspection)
    ).resolves.toMatchObject({
      validNotesMidiCount: 1,
      exactExpertPartVocalsCount: 0
    })
  })

  it('retains canonical ZIP locators rather than parser enumeration order', async () => {
    const archive = new AdmZip()
    // `z` is first in inventory because of notes.chart, not notes.mid.
    archive.addFile('z/notes.chart', Buffer.from('[Song]\n{}\n'))
    archive.addFile('a/notes.mid', midiWithTrack('PART GUITAR'))
    archive.addFile('z/notes.mid', midiWithTrack('PART VOCALS'))
    const packagePath = join(testDir, 'canonical-locator-order.zip')
    archive.writeZip(packagePath)
    const session = createDatasetPackageInventorySession([{ kind: 'zip', sourcePath: packagePath }])
    await runDatasetPackageInventorySession(session, localInspection)
    const reviewEntries = getDatasetPackageInventorySessionReviewEntries(session)
    expect(reviewEntries.map((entry) => entry.entryLocator).sort()).toEqual(['a/', 'z/'])
    expect(new Set(reviewEntries.map((entry) => entry.entryId)).size).toBe(2)
    expect(reviewEntries.find((entry) => entry.entryLocator === 'z/')?.exactExpertPartVocals).toBe(
      true
    )
  })

  it('retains a valid root-level ZIP notes.mid review entry', async () => {
    const archive = new AdmZip()
    archive.addFile('notes.mid', midiWithTrack('PART VOCALS'))
    const packagePath = join(testDir, 'root-notes-midi.zip')
    archive.writeZip(packagePath)
    const session = createDatasetPackageInventorySession([{ kind: 'zip', sourcePath: packagePath }])
    await runDatasetPackageInventorySession(session, localInspection)
    const reviewEntries = getDatasetPackageInventorySessionReviewEntries(session)
    expect(reviewEntries).toHaveLength(1)
    expect(reviewEntries[0]).toMatchObject({
      entryLocator: '',
      exactExpertPartVocals: true,
      source: { kind: 'zip', sourcePath: packagePath }
    })
  })

  it('fails closed when channel-event data is not a valid seven-bit MIDI value', async () => {
    const malformed = midiWithTrack('PART VOCALS')
    // The first note-on pitch is byte 0xff rather than a seven-bit data byte.
    const noteOn = malformed.indexOf(Buffer.from([0x90, 0x3c, 0x40]))
    malformed[noteOn + 1] = 0xff
    const archive = new AdmZip()
    archive.addFile('bad/notes.mid', malformed)
    const packagePath = join(testDir, 'invalid-channel-data.zip')
    archive.writeZip(packagePath)

    await expect(
      inventoryDatasetPackageSources([{ kind: 'zip', sourcePath: packagePath }], localInspection)
    ).resolves.toMatchObject({
      validNotesMidiCount: 0,
      invalidOrMissingNotesMidiCount: 1,
      exactExpertPartVocalsCount: 0
    })
  })

  it('refuses ZIP chart extraction above the aggregate budget before posting chart buffers', () => {
    const archive = new AdmZip()
    archive.addFile('first/notes.mid', Buffer.alloc(1_500_000))
    archive.addFile('second/notes.mid', Buffer.alloc(1_500_000))

    expect(() =>
      inspectZipForInventoryTest(archive.toBuffer(), {
        maxChartCount: 4,
        maxExtractedChartBytes: 2_000_000
      })
    ).toThrow('aggregate limit')
  })

  it.each(['sng', 'zip', 'rb3con'] as const)(
    'records a bounded timeout without parsing %s on the main process',
    async (kind) => {
      const packagePath = join(testDir, `timeout-${kind}.${kind === 'rb3con' ? 'rb3con' : kind}`)
      await writeFile(packagePath, 'fixture')
      const inventory = await inventoryDatasetPackageSources([{ kind, sourcePath: packagePath }], {
        inspectInIsolation: async () => {
          throw new Error('Package decode timed out.')
        }
      })
      expect(inventory).toMatchObject({
        inspectedPackageCount: 0,
        unreadablePackageCount: 0,
        decodeTimeoutCount: 1,
        decodeFailureCount: 0,
        cancelled: false
      })
    }
  )

  it('keeps the opened bounded snapshot when its path is replaced', async () => {
    const packagePath = join(testDir, 'snapshot-before-replace.zip')
    const replacementPath = join(testDir, 'snapshot-oversized-replacement.zip')
    const initialBytes = Buffer.from('bounded snapshot')
    await writeFile(packagePath, initialBytes)
    await writeFile(replacementPath, '')
    await truncate(replacementPath, 256 * 1024 * 1024 + 1)

    await expect(
      readInventoryPackageSnapshot(packagePath, {
        afterOpen: async () => await rename(replacementPath, packagePath)
      })
    ).resolves.toEqual(initialBytes)
  })

  it('refuses a final symlink planted after folder discovery without exposing its target', async () => {
    const packagePath = join(testDir, 'post-discovery-source.zip')
    const targetPath = join(testDir, 'private-symlink-target.zip')
    await writeFile(packagePath, 'discovered before replacement')
    await writeFile(targetPath, 'symlink target')
    await unlink(packagePath)
    await symlink(targetPath, packagePath)

    await expect(readInventoryPackageSnapshot(packagePath)).rejects.toThrow()

    const inventory = await inventoryDatasetPackageSources(
      [{ kind: 'zip', sourcePath: packagePath }],
      localInspection
    )
    expect(inventory).toMatchObject({
      inspectedPackageCount: 1,
      readablePackageCount: 0,
      unreadablePackageCount: 1,
      decodeFailureCount: 1
    })
    const serialized = JSON.stringify(inventory)
    expect(serialized).not.toContain(packagePath)
    expect(serialized).not.toContain(targetPath)
  })

  it.each(['sng', 'zip', 'rb3con'] as const)(
    'cancels isolated %s inspection without counting it as a decode failure',
    async (kind) => {
      const packagePath = join(testDir, `cancel-${kind}.${kind === 'rb3con' ? 'rb3con' : kind}`)
      await writeFile(packagePath, 'fixture')
      const controller = new AbortController()
      const inventoryPromise = inventoryDatasetPackageSources([{ kind, sourcePath: packagePath }], {
        signal: controller.signal,
        inspectInIsolation: async (_source, signal) =>
          await new Promise((_, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new Error('Package inventory cancelled.')),
              { once: true }
            )
            setTimeout(() => controller.abort(), 0)
          })
      })
      await expect(inventoryPromise).resolves.toMatchObject({
        inspectedPackageCount: 0,
        unreadablePackageCount: 0,
        decodeTimeoutCount: 0,
        decodeFailureCount: 0,
        cancelled: true
      })
    }
  )

  it('returns a completed-only partial aggregate when the inventory deadline expires', async () => {
    const progress: Array<{
      processedPackageCount: number
      completedPackageCount: number
      totalPackageCount: number
    }> = []
    let callCount = 0
    const inventory = await inventoryDatasetPackageSources(
      [
        { kind: 'zip', sourcePath: join(testDir, 'deadline-first.zip') },
        { kind: 'zip', sourcePath: join(testDir, 'deadline-inflight.zip') }
      ],
      {
        deadlineMs: 20,
        onProgress: (value) => progress.push(value),
        inspectInIsolation: async (_source, signal) => {
          callCount += 1
          if (callCount === 1) {
            return {
              outcome: 'inspected',
              containerHash: 'first',
              inspection: { headerReadable: true, charts: [] }
            }
          }
          return await new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new Error('Package inventory cancelled.')),
              { once: true }
            )
          })
        }
      }
    )

    expect(inventory).toMatchObject({
      selectedPackageCount: 2,
      inspectedPackageCount: 1,
      readablePackageCount: 1,
      unreadablePackageCount: 0,
      decodeTimeoutCount: 0,
      decodeFailureCount: 0,
      cancelled: true
    })
    expect(progress).toEqual([
      { processedPackageCount: 0, completedPackageCount: 0, totalPackageCount: 2 },
      { processedPackageCount: 1, completedPackageCount: 1, totalPackageCount: 2 }
    ])
    const serialized = JSON.stringify({ inventory, progress })
    expect(serialized).not.toContain('deadline-first')
    expect(serialized).not.toContain('deadline-inflight')
  })

  it('returns partial progress and counters when the caller aborts after a completed worker', async () => {
    const controller = new AbortController()
    const progress: Array<{
      processedPackageCount: number
      completedPackageCount: number
      totalPackageCount: number
    }> = []
    const inventory = await inventoryDatasetPackageSources(
      [
        { kind: 'zip', sourcePath: join(testDir, 'abort-first.zip') },
        { kind: 'zip', sourcePath: join(testDir, 'abort-never-started.zip') }
      ],
      {
        signal: controller.signal,
        onProgress: (value) => {
          progress.push(value)
          if (value.completedPackageCount === 1) controller.abort()
        },
        inspectInIsolation: async () => ({
          outcome: 'inspected',
          containerHash: 'first',
          inspection: { headerReadable: true, charts: [] }
        })
      }
    )

    expect(inventory).toMatchObject({
      selectedPackageCount: 2,
      inspectedPackageCount: 1,
      readablePackageCount: 1,
      cancelled: true
    })
    expect(progress).toEqual([
      { processedPackageCount: 0, completedPackageCount: 0, totalPackageCount: 2 },
      { processedPackageCount: 1, completedPackageCount: 1, totalPackageCount: 2 }
    ])
  })

  it('counts only completed worker rejections for SNG, ZIP, and RB3CON', async () => {
    const sources = await Promise.all(
      (['sng', 'zip', 'rb3con'] as const).map(async (kind) => {
        const packagePath = join(testDir, `oversize-${kind}.${kind === 'rb3con' ? 'rb3con' : kind}`)
        await writeFile(packagePath, '')
        await truncate(packagePath, 256 * 1024 * 1024 + 1)
        return { kind, sourcePath: packagePath }
      })
    )
    let isolationCalls = 0
    const inventory = await inventoryDatasetPackageSources(sources, {
      inspectInIsolation: async () => {
        isolationCalls += 1
        return { outcome: 'rejected' }
      }
    })
    expect(isolationCalls).toBe(3)
    expect(inventory).toMatchObject({
      inspectedPackageCount: 3,
      readablePackageCount: 0,
      unreadablePackageCount: 3,
      decodeFailureCount: 3
    })
  })

  it.each(['sng', 'zip', 'rb3con'] as const)(
    'enforces the inventory cap in the worker-owned %s snapshot path',
    async (kind) => {
      const packagePath = join(
        testDir,
        `worker-cap-race-${kind}.${kind === 'rb3con' ? 'rb3con' : kind}`
      )
      await writeFile(packagePath, '')
      await truncate(packagePath, 256 * 1024 * 1024 + 1)

      await expect(
        inspectIsolatedPackageInWorker({ kind, sourcePath: packagePath })
      ).rejects.toThrow('too large')
    }
  )

  it('counts an unavailable container identity exactly once', async () => {
    const packagePath = join(testDir, 'identity-unavailable.zip')
    await writeFile(packagePath, 'fixture')
    const inventory = await inventoryDatasetPackageSources(
      [{ kind: 'zip', sourcePath: packagePath }],
      {
        inspectInIsolation: async () => ({
          outcome: 'inspected',
          containerHash: null,
          inspection: { headerReadable: true, charts: [] }
        })
      }
    )
    expect(inventory).toMatchObject({
      readablePackageCount: 1,
      readableHeaderCount: 1,
      containerIdentityUnavailableCount: 1,
      decodeFailureCount: 0
    })
  })
})
