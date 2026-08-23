// Shared .tar.gz extraction for the bootstrap modules (Python runtime,
// whisper.cpp, demucs.cpp).
//
// tar is built into Windows 10 1803+, macOS, and Linux, and `-xzf` works
// identically across all three. However, spawning plain `tar` relies on the
// user's PATH containing the right directory (System32 on Windows), and a
// surprising number of Windows machines have a mangled PATH — which surfaces
// as `spawn tar ENOENT` (issue #65). To be immune to that, prefer the
// absolute path to the bundled Windows tar and only fall back to PATH lookup.

import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { join } from 'path'

let cachedTarCommand: string | null = null

function resolveTarCommand(): string {
  if (cachedTarCommand) return cachedTarCommand
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
    const systemTar = join(systemRoot, 'System32', 'tar.exe')
    if (existsSync(systemTar)) {
      cachedTarCommand = systemTar
      return systemTar
    }
  }
  cachedTarCommand = 'tar'
  return cachedTarCommand
}

/** Extract a .tar.gz archive into destDir (created if missing). */
export async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  const tarCommand = resolveTarCommand()
  await new Promise<void>((resolve, reject) => {
    execFile(tarCommand, ['-xzf', archivePath, '-C', destDir], (err) => {
      if (!err) {
        resolve()
        return
      }
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // tar itself could not be found — give the user something actionable
        // instead of the cryptic "spawn tar ENOENT".
        reject(
          new Error(
            process.platform === 'win32'
              ? 'Could not find the "tar" utility needed to extract the downloaded archive. ' +
                'It ships with Windows 10 (1803+) at C:\\Windows\\System32\\tar.exe. ' +
                'Please verify that file exists, or reinstall the optional "tar" feature / update Windows, then try again.'
              : 'Could not find the "tar" utility needed to extract the downloaded archive. ' +
                'Please install tar via your system package manager and try again.'
          )
        )
        return
      }
      reject(err)
    })
  })
}

/** Test-only: reset the cached tar command resolution. */
export function _resetTarCommandCacheForTests(): void {
  cachedTarCommand = null
}
