import { createHash, randomUUID } from 'crypto'
import type { DatasetCatalogSource } from './sngTrainingExporter'
import {
  createDatasetPackageInventorySession,
  type DatasetPackageInventorySession
} from './packageSourceInventory'

interface PackageInventoryCursorRecord {
  groupId: string
  sourceFingerprint: string
  session: DatasetPackageInventorySession
}

export interface PackageInventoryCursorResolution {
  session: DatasetPackageInventorySession | null
  cursorRejected: boolean
}

/**
 * A main-only opaque cursor store. Tokens are random capabilities, while the
 * private source fingerprint prevents a token from resuming a changed group.
 * Neither locations nor the fingerprint are returned to the renderer.
 */
export class PackageInventoryCursorStore {
  readonly #records = new Map<string, PackageInventoryCursorRecord>()

  begin(
    groupId: string,
    sources: readonly DatasetCatalogSource[]
  ): {
    cursor: string
    session: DatasetPackageInventorySession
  } {
    this.clearGroup(groupId)
    const cursor = randomUUID()
    const session = createDatasetPackageInventorySession(sources)
    this.#records.set(cursor, {
      groupId,
      sourceFingerprint: sourceFingerprint(sources),
      session
    })
    return { cursor, session }
  }

  resume(
    groupId: string,
    sources: readonly DatasetCatalogSource[],
    cursor: string
  ): PackageInventoryCursorResolution {
    const record = this.#records.get(cursor)
    if (!record || record.groupId !== groupId) return { session: null, cursorRejected: true }
    if (record.sourceFingerprint !== sourceFingerprint(sources)) {
      this.#records.delete(cursor)
      return { session: null, cursorRejected: true }
    }
    return { session: record.session, cursorRejected: false }
  }

  complete(cursor: string): void {
    this.#records.delete(cursor)
  }

  clearGroup(groupId: string): void {
    for (const [cursor, record] of this.#records) {
      if (record.groupId === groupId) this.#records.delete(cursor)
    }
  }
}

function sourceFingerprint(sources: readonly DatasetCatalogSource[]): string {
  const hash = createHash('sha256')
  hash.update(`${sources.length}\n`)
  for (const source of sources) {
    // Length prefixes make the private binding unambiguous without persisting
    // locations in a renderer-visible token or response.
    hash.update(`${source.kind.length}:${source.kind}`)
    hash.update(`${source.sourcePath.length}:${source.sourcePath}`)
  }
  return hash.digest('hex')
}
