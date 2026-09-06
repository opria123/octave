import { describe, expect, it } from 'vitest'
import {
  getDatasetPackageInventorySessionResult,
  isDatasetPackageInventorySessionComplete,
  runDatasetPackageInventorySession,
  type IsolatedPackageInspection
} from './packageSourceInventory'
import { PackageInventoryCursorStore } from './packageInventoryCursor'

const sources = [
  { kind: 'zip' as const, sourcePath: '/private/source-one.zip' },
  { kind: 'zip' as const, sourcePath: '/private/source-two.zip' },
  { kind: 'zip' as const, sourcePath: '/private/source-three.zip' }
]

function inspected(midiHash: string): IsolatedPackageInspection {
  return {
    outcome: 'inspected' as const,
    containerHash: `container-${midiHash}`,
    inspection: {
      headerReadable: true,
      charts: [
        {
          validNotesMidi: true,
          hasChart: false,
          exactExpertPartVocals: false,
          midiHash,
          entryLocator: 'fixture'
        }
      ]
    }
  }
}

describe('PackageInventoryCursorStore', () => {
  it('resumes from settled work without reinventorying it or recounting duplicates', async () => {
    const store = new PackageInventoryCursorStore()
    const { cursor, session } = store.begin('opaque-group', sources)
    const controller = new AbortController()
    const firstProgress: number[] = []
    const observedSources: string[] = []
    const inspectInIsolation = async (source: {
      sourcePath: string
    }): Promise<IsolatedPackageInspection> => {
      observedSources.push(source.sourcePath)
      return inspected(`midi-${observedSources.length}`)
    }

    const first = await runDatasetPackageInventorySession(session, {
      signal: controller.signal,
      onProgress: (progress) => {
        firstProgress.push(progress.processedPackageCount)
        if (progress.processedPackageCount === 1) controller.abort()
      },
      inspectInIsolation
    })

    expect(first).toMatchObject({ inspectedPackageCount: 1, cancelled: true })
    expect(firstProgress).toEqual([0, 1])
    expect(isDatasetPackageInventorySessionComplete(session)).toBe(false)

    const resumed = store.resume('opaque-group', sources, cursor)
    expect(resumed.cursorRejected).toBe(false)
    expect(resumed.session).toBe(session)
    const secondProgress: number[] = []
    const second = await runDatasetPackageInventorySession(resumed.session!, {
      onProgress: (progress) => secondProgress.push(progress.processedPackageCount),
      inspectInIsolation
    })

    expect(second).toMatchObject({
      selectedPackageCount: 3,
      inspectedPackageCount: 3,
      readablePackageCount: 3,
      duplicateMidiCount: 0,
      duplicateContainerCount: 0,
      cancelled: false
    })
    expect(secondProgress).toEqual([1, 2, 3])
    expect(observedSources).toEqual(sources.map((source) => source.sourcePath))
    expect(isDatasetPackageInventorySessionComplete(session)).toBe(true)
  })

  it('rejects unknown, cross-group, and stale cursors without selecting a source', () => {
    const store = new PackageInventoryCursorStore()
    const { cursor } = store.begin('opaque-group', sources)

    expect(store.resume('opaque-group', sources, 'forged-cursor')).toEqual({
      session: null,
      cursorRejected: true
    })
    expect(store.resume('another-group', sources, cursor)).toEqual({
      session: null,
      cursorRejected: true
    })
    expect(
      store.resume(
        'opaque-group',
        [{ kind: 'zip', sourcePath: '/private/replaced-selection.zip' }],
        cursor
      )
    ).toEqual({ session: null, cursorRejected: true })
    expect(store.resume('opaque-group', sources, cursor)).toEqual({
      session: null,
      cursorRejected: true
    })
  })

  it('keeps cancellation snapshots and progress aggregate-only', async () => {
    const store = new PackageInventoryCursorStore()
    const { cursor, session } = store.begin('opaque-group', sources)
    const controller = new AbortController()
    const progress: unknown[] = []
    controller.abort()

    const inventory = await runDatasetPackageInventorySession(session, {
      signal: controller.signal,
      onProgress: (value) => progress.push(value)
    })
    const serialized = JSON.stringify({ inventory, progress, cursor })

    expect(inventory).toMatchObject({
      selectedPackageCount: 3,
      inspectedPackageCount: 0,
      cancelled: true
    })
    expect(progress).toEqual([
      { processedPackageCount: 0, completedPackageCount: 0, totalPackageCount: 3 }
    ])
    expect(serialized).not.toContain('/private/')
    expect(serialized).not.toContain('source-one')
    expect(serialized).not.toContain('container-')
    expect(getDatasetPackageInventorySessionResult(session)).toEqual(inventory)
  })
})
