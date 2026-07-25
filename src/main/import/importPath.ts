import { promises as fs } from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'

export type ImportConflictPolicy = 'create-new' | 'skip' | 'overwrite' | 'cancel'
export type ImportConflictResolver = (destinationPath: string) => Promise<ImportConflictPolicy>

export class ImportCancelledError extends Error {
  constructor(public readonly importedDirs: string[] = []) {
    super('Import cancelled by user.')
    this.name = 'ImportCancelledError'
  }
}

export class PartialImportError extends Error {
  constructor(
    message: string,
    public readonly importedDirs: string[],
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'PartialImportError'
  }
}

export interface SongDirectoryPlan {
  workingDir: string
  destinationDir: string
  finalize: () => Promise<void>
  rollback: () => Promise<void>
}

export async function createUniqueSongDirectory(
  libraryDir: string,
  folderName: string
): Promise<string> {
  for (let suffix = 1; ; suffix += 1) {
    const candidateName = suffix === 1 ? folderName : `${folderName} (${suffix})`
    const candidate = path.join(libraryDir, candidateName)
    try {
      await fs.mkdir(candidate)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

export async function prepareSongDirectory(
  libraryDir: string,
  folderName: string,
  resolveConflict?: ImportConflictResolver
): Promise<SongDirectoryPlan | null> {
  const destinationDir = path.join(libraryDir, folderName)
  try {
    await fs.mkdir(destinationDir)
    return {
      workingDir: destinationDir,
      destinationDir,
      finalize: async () => undefined,
      rollback: async () => fs.rm(destinationDir, { recursive: true, force: true })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }

  const policy = resolveConflict ? await resolveConflict(destinationDir) : 'create-new'
  if (policy === 'cancel') throw new ImportCancelledError()
  if (policy === 'skip') return null
  if (policy === 'create-new') {
    const uniqueDir = await createUniqueSongDirectory(libraryDir, folderName)
    return {
      workingDir: uniqueDir,
      destinationDir: uniqueDir,
      finalize: async () => undefined,
      rollback: async () => fs.rm(uniqueDir, { recursive: true, force: true })
    }
  }

  const stagingDir = await createUniqueSongDirectory(libraryDir, `.${folderName}.octave-import`)
  return {
    workingDir: stagingDir,
    destinationDir,
    finalize: async () => {
      const backupDir = path.join(libraryDir, `.${folderName}.octave-backup-${randomUUID()}`)
      await fs.rename(destinationDir, backupDir)
      try {
        await fs.rename(stagingDir, destinationDir)
      } catch (error) {
        await fs.rename(backupDir, destinationDir)
        throw error
      }
      try {
        await fs.rm(backupDir, { recursive: true, force: true })
      } catch (error) {
        // The replacement is already committed. Cleanup failure must not turn a successful
        // overwrite into a reported import failure that cannot be rolled back.
        console.warn('[Importer] Replacement committed but backup cleanup failed:', error)
      }
    },
    rollback: async () => fs.rm(stagingDir, { recursive: true, force: true })
  }
}
