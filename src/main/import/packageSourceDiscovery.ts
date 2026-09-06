import { opendir } from 'fs/promises'
import { join, resolve } from 'path'

const MAX_DISCOVERED_PACKAGE_COUNT = 1_000
const MAX_DISCOVERED_DIRECTORY_COUNT = 10_000
const DISCOVERY_TIMEOUT_MS = 15_000

export interface PackageSourceDiscovery {
  packagePaths: string[]
  /** Exact omitted count is intentionally unknown because traversal stops. */
  packageLimitReached: boolean
  directoryLimitReached: boolean
}

export interface PackageSourceDiscoveryOptions {
  signal?: AbortSignal
  onDirectoryScanned?: (directoryCount: number) => void
  /** Test/UI hook invoked per directory entry, after cancellation checks. */
  onEntryScanned?: (entryCount: number) => void
}

function isDatasetPackage(fileName: string): boolean {
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  return (
    extension === '.sng' || extension === '.con' || extension === '.rb3con' || extension === '.zip'
  )
}

function cancelled(): Error {
  return new Error('Package discovery cancelled.')
}

/**
 * This intentionally discovers files only. It does not open, hash, parse, or
 * materialize a selected package; those operations happen later through the
 * isolated, bounded inventory worker.
 */
export async function discoverDatasetPackageSources(
  folderPath: string,
  options: PackageSourceDiscoveryOptions = {}
): Promise<PackageSourceDiscovery> {
  const pending = [resolve(folderPath)]
  const packagePaths: string[] = []
  let directoryCount = 0
  let entryCount = 0
  let directoryLimitReached = false
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS
  while (pending.length > 0) {
    if (options.signal?.aborted) throw cancelled()
    if (Date.now() > deadline) throw new Error('Package discovery timed out.')
    if (directoryCount >= MAX_DISCOVERED_DIRECTORY_COUNT) {
      directoryLimitReached = true
      break
    }
    const current = pending.pop()
    if (!current) break
    const directory = await opendir(current)
    directoryCount += 1
    options.onDirectoryScanned?.(directoryCount)
    try {
      for await (const entry of directory) {
        if (options.signal?.aborted) throw cancelled()
        if (Date.now() > deadline) throw new Error('Package discovery timed out.')
        entryCount += 1
        options.onEntryScanned?.(entryCount)
        const entryPath = join(current, entry.name)
        if (entry.isDirectory()) {
          pending.push(entryPath)
        } else if (entry.isFile() && isDatasetPackage(entry.name)) {
          packagePaths.push(entryPath)
          if (packagePaths.length >= MAX_DISCOVERED_PACKAGE_COUNT) {
            return {
              packagePaths: packagePaths.sort((left, right) => left.localeCompare(right)),
              packageLimitReached: true,
              directoryLimitReached
            }
          }
        }
      }
    } finally {
      await directory.close().catch(() => undefined)
    }
    // Give Electron a chance to service cancellation and input between dirs.
    await new Promise<void>((done) => setImmediate(done))
  }
  return {
    packagePaths: packagePaths.sort((left, right) => left.localeCompare(right)),
    packageLimitReached: false,
    directoryLimitReached
  }
}
