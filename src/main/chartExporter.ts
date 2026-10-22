import { copyFile, mkdir, readdir, rename, stat, unlink, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { serializeIniFile } from '../shared/iniFile'

/**
 * Files that never belong in an exported Clone Hero song folder: editor
 * sidecar JSON, OS cruft, and the backup/temp files the save path leaves
 * behind. Mirrors the exclusion list used by the .sng packer.
 */
const EXCLUDED_NAMES = new Set([
  'song.ini',
  'desktop.ini',
  '.ds_store',
  'video.json',
  'audio.json',
  'venue.json',
  // The chart is regenerated from the editor state, and a stale notes.mid
  // next to it would take precedence in Clone Hero / YARG.
  'notes.mid',
  'notes.chart'
])

const EXCLUDED_SUFFIXES = ['.bak1', '.bak2', '.bak3', '.tmp']

export function isExportableSongFile(name: string): boolean {
  const lower = name.toLowerCase()
  if (EXCLUDED_NAMES.has(lower)) return false
  return !EXCLUDED_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

/**
 * Writes a Clone Hero style song folder (issue #77):
 *
 *   <outputDir>/
 *     notes.chart   ← `chartText`, serialized by the renderer from the live song
 *     song.ini      ← built from `metadata`
 *     *.ogg, album art, … copied verbatim from `songDir`
 *
 * The output folder is created when missing and files with the same name are
 * overwritten in place; nothing else inside an existing folder is removed.
 */
export async function exportChartFolder(
  songDir: string,
  metadata: Record<string, unknown>,
  chartText: string,
  outputDir: string
): Promise<void> {
  if (!existsSync(songDir)) {
    throw new Error(`Song directory does not exist: ${songDir}`)
  }
  if (!chartText || !chartText.includes('[Song]')) {
    throw new Error('Chart data is empty — nothing to export.')
  }

  const resolvedSong = resolve(songDir)
  const resolvedOutput = resolve(outputDir)
  if (resolvedSong === resolvedOutput) {
    throw new Error('Choose a destination outside the song folder you are exporting.')
  }

  await mkdir(resolvedOutput, { recursive: true })

  // notes.chart — atomic write so a crash never leaves a half-written chart.
  const chartPath = join(resolvedOutput, 'notes.chart')
  const tempPath = `${chartPath}.tmp`
  try {
    await writeFile(tempPath, chartText, 'utf-8')
    await rename(tempPath, chartPath)
  } catch (error) {
    try {
      if (existsSync(tempPath)) await unlink(tempPath)
    } catch {
      /* ignore */
    }
    throw error
  }

  await writeFile(join(resolvedOutput, 'song.ini'), serializeIniFile(metadata), 'utf-8')

  const entries = await readdir(resolvedSong)
  for (const entry of entries) {
    if (!isExportableSongFile(entry)) continue
    const sourcePath = join(resolvedSong, entry)
    try {
      const info = await stat(sourcePath)
      if (!info.isFile()) continue
    } catch {
      continue
    }
    await copyFile(sourcePath, join(resolvedOutput, entry))
  }
}
