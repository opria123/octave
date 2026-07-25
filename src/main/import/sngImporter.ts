import { createReadStream, createWriteStream } from 'fs'
import { promises as fs } from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { SngStream, type SngHeader } from 'parse-sng'
import {
  prepareSongDirectory,
  type ImportConflictResolver,
  type SongDirectoryPlan
} from './importPath'

function sanitizeDirName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim()
}

function getSongFolderName(metadata: Record<string, string>): string {
  const artist = metadata.artist || 'Unknown Artist'
  const name = metadata.name || 'Unknown Song'
  return sanitizeDirName(`${artist} - ${name}`)
}

export function resolveSngOutputPath(targetDir: string, fileName: string): string {
  const root = path.resolve(targetDir)
  const outputPath = path.resolve(root, fileName)
  if (outputPath !== root && !outputPath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe path in SNG package: ${fileName}`)
  }
  return outputPath
}

/**
 * Import a Clone Hero `.sng` package into `libraryDir` as a song folder.
 * Uses the streaming parse-sng parser so large packages are not fully buffered in memory.
 */
export function importSng(sngFilePath: string, libraryDir: string): Promise<string>
export function importSng(
  sngFilePath: string,
  libraryDir: string,
  resolveConflict: ImportConflictResolver
): Promise<string | null>
export async function importSng(
  sngFilePath: string,
  libraryDir: string,
  resolveConflict?: ImportConflictResolver
): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    let settled = false
    let directoryPlan: SongDirectoryPlan | null = null
    let skipImport = false
    // Serialize file writes: parse-sng emits the next file only after nextFile() is called.
    let writeChain: Promise<void> = Promise.resolve()

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }

    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      const normalizedError = error instanceof Error ? error : new Error(String(error))
      void (directoryPlan?.rollback() ?? Promise.resolve()).finally(() => reject(normalizedError))
    }

    const webStream = Readable.toWeb(createReadStream(sngFilePath)) as ReadableStream<Uint8Array>
    const sngStream = new SngStream(webStream, { generateSongIni: true })

    sngStream.on('header', (header: SngHeader) => {
      writeChain = writeChain
        .then(async () => {
          const songFolderName = getSongFolderName(header.metadata)
          directoryPlan = await prepareSongDirectory(libraryDir, songFolderName, resolveConflict)
          skipImport = directoryPlan === null
        })
        .catch(fail)
    })

    sngStream.on('file', (fileName, fileStream, nextFile) => {
      writeChain = writeChain
        .then(async () => {
          if (skipImport) {
            for await (const chunk of Readable.fromWeb(
              fileStream as import('stream/web').ReadableStream<Uint8Array>
            )) {
              // Drain skipped package data so parse-sng can continue to the next file.
              void chunk
            }
            if (nextFile) nextFile()
            else settle(() => resolve(null))
            return
          }
          if (!directoryPlan) {
            throw new Error('SNG file event received before header was parsed.')
          }

          const outputPath = resolveSngOutputPath(directoryPlan.workingDir, fileName)
          await fs.mkdir(path.dirname(outputPath), { recursive: true })

          const nodeReadable = Readable.fromWeb(
            fileStream as import('stream/web').ReadableStream<Uint8Array>
          )
          const writeStream = createWriteStream(outputPath)
          await pipeline(nodeReadable, writeStream)

          if (nextFile) {
            nextFile()
          } else {
            await directoryPlan.finalize()
            settle(() => resolve(directoryPlan!.destinationDir))
          }
        })
        .catch(fail)
    })

    sngStream.on('error', fail)
    sngStream.start()
  })
}
