import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { exportChartFolder, isExportableSongFile } from './chartExporter'

const CHART_TEXT = '[Song]\n{\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = B 120000\n}\n'

describe('exportChartFolder (issue #77)', () => {
  let root: string
  let songDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'octave-chart-export-'))
    songDir = join(root, 'source')
    await mkdir(songDir)
    await writeFile(join(songDir, 'notes.mid'), 'MThd fake')
    await writeFile(join(songDir, 'song.ini'), '[song]\nname = Old Name\n')
    await writeFile(join(songDir, 'guitar.ogg'), 'OggS guitar')
    await writeFile(join(songDir, 'album.png'), 'PNG')
    await writeFile(join(songDir, 'notes.mid.bak1'), 'backup')
    await writeFile(join(songDir, 'notes.chart.tmp'), 'partial')
    await writeFile(join(songDir, 'venue.json'), '{}')
    await mkdir(join(songDir, 'nested'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes notes.chart + song.ini and copies only the playable assets', async () => {
    const outputDir = join(root, 'exported')
    await exportChartFolder(
      songDir,
      { name: 'New Name', artist: 'Someone', song_length: 1234 },
      CHART_TEXT,
      outputDir
    )

    const files = (await readdir(outputDir)).sort()
    expect(files).toEqual(['album.png', 'guitar.ogg', 'notes.chart', 'song.ini'])
    expect(await readFile(join(outputDir, 'notes.chart'), 'utf-8')).toBe(CHART_TEXT)
    expect(await readFile(join(outputDir, 'guitar.ogg'), 'utf-8')).toBe('OggS guitar')

    const ini = await readFile(join(outputDir, 'song.ini'), 'utf-8')
    expect(ini).toContain('name = New Name')
    expect(ini).toContain('artist = Someone')
    expect(ini).not.toContain('Old Name')
  })

  it('overwrites an existing export folder in place without deleting other files', async () => {
    const outputDir = join(root, 'exported')
    await mkdir(outputDir)
    await writeFile(join(outputDir, 'notes.chart'), 'stale')
    await writeFile(join(outputDir, 'keep-me.txt'), 'untouched')

    await exportChartFolder(songDir, { name: 'X' }, CHART_TEXT, outputDir)

    expect(await readFile(join(outputDir, 'notes.chart'), 'utf-8')).toBe(CHART_TEXT)
    expect(await readFile(join(outputDir, 'keep-me.txt'), 'utf-8')).toBe('untouched')
  })

  it('refuses to export a song folder onto itself', async () => {
    await expect(exportChartFolder(songDir, {}, CHART_TEXT, songDir)).rejects.toThrow(
      /outside the song folder/
    )
    expect(await readFile(join(songDir, 'notes.mid'), 'utf-8')).toBe('MThd fake')
  })

  it('rejects empty chart data and missing song folders', async () => {
    await expect(exportChartFolder(songDir, {}, '', join(root, 'out'))).rejects.toThrow(/empty/)
    await expect(
      exportChartFolder(join(root, 'missing'), {}, CHART_TEXT, join(root, 'out'))
    ).rejects.toThrow(/does not exist/)
  })

  it('keeps the exclusion rules aligned with the .sng packer', () => {
    expect(isExportableSongFile('song.ogg')).toBe(true)
    expect(isExportableSongFile('Album.PNG')).toBe(true)
    expect(isExportableSongFile('notes.mid')).toBe(false)
    expect(isExportableSongFile('NOTES.CHART')).toBe(false)
    expect(isExportableSongFile('song.ini')).toBe(false)
    expect(isExportableSongFile('notes.mid.bak2')).toBe(false)
    expect(isExportableSongFile('audio.json')).toBe(false)
  })
})
