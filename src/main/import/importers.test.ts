import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { parseDta } from './dtaParser'
import { decryptMoggBuffer } from './moggDecrypt'
import { importSng } from './sngImporter'
import { importCon, StfsParser } from './conImporter'
import { packRb3con } from '../conPacker'
import { packSng } from '../sngPacker'
import { join } from 'path'
import { existsSync } from 'fs'
import { mkdir, writeFile, readFile, rm } from 'fs/promises'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

describe('dtaParser', () => {
  it('parses basic DTA structures correctly', () => {
    const mockDta = `
      (song_shortname
        (name "Test Song Title")
        (artist "Test Artist")
        (album_name "Test Album")
        (year_released 2026)
        (genre genre_rock)
        (vocal_gender male)
        (preview 10000 40000)
        (rank
          (band 300)
          (guitar 200)
          (drum 250)
          (vocals 350)
          (keys 100)
        )
        (song
          (name "songs/song_shortname/song_shortname")
          (tracks
            ((drum (0 1 2))
             (bass 3)
             (guitar (4 5))
             (vocals 6)
            )
          )
          (vols (-1.0 -1.5 -2.0 -2.5 -3.0 -3.5 -4.0))
          (pans (-1.0 1.0 -1.0 1.0 -1.0 1.0 0.0))
        )
      )
    `

    const parsed = parseDta(mockDta)
    expect(parsed.song_shortname).toBeDefined()

    const song = parsed.song_shortname
    expect(song.name).toBe('Test Song Title')
    expect(song.artist).toBe('Test Artist')
    expect(song.album).toBe('Test Album')
    expect(song.year).toBe(2026)
    expect(song.genre).toBe('rock')
    expect(song.vocalsGender).toBe('male')
    expect(song.previewStart).toBe(10)
    expect(song.previewEnd).toBe(40)

    expect(song.ranks.band).toBe(300)
    expect(song.ranks.guitar).toBe(200)
    expect(song.ranks.drum).toBe(250)
    expect(song.ranks.vocals).toBe(350)
    expect(song.ranks.keys).toBe(100)

    expect(song.vols).toEqual([-1.0, -1.5, -2.0, -2.5, -3.0, -3.5, -4.0])
    expect(song.pans).toEqual([-1.0, 1.0, -1.0, 1.0, -1.0, 1.0, 0.0])

    expect(song.channels.drum).toEqual([0, 1, 2])
    expect(song.channels.bass).toEqual([3])
    expect(song.channels.guitar).toEqual([4, 5])
    expect(song.channels.vocals).toEqual([6])
  })

  it('handles LISP comments and missing fields gracefully', () => {
    const mockDta = `
      ; This is a comment at the top
      (song2
        (name "Another Song")
        ; nested comment
        (artist "Another Artist")
        (song
          (vols -2.5) ; flat single value instead of list
        )
      )
    `
    const parsed = parseDta(mockDta)
    expect(parsed.song2).toBeDefined()
    const song = parsed.song2
    expect(song.name).toBe('Another Song')
    expect(song.artist).toBe('Another Artist')
    expect(song.vols).toEqual([-2.5])
  })
})

describe('moggDecrypt', () => {
  it('throws an error for unsupported versions', () => {
    const mockMogg = Buffer.alloc(32)
    mockMogg.writeInt32LE(0x01, 0) // version 1 (unsupported)
    expect(() => decryptMoggBuffer(mockMogg)).toThrow()
  })
})

describe('sngImporter Integration', () => {
  const testTempDir = join(__dirname, '../../../out/sng_importer_test_temp')

  beforeAll(async () => {
    await mkdir(testTempDir, { recursive: true })
  })

  afterAll(async () => {
    if (existsSync(testTempDir)) {
      await rm(testTempDir, { recursive: true, force: true })
    }
  })

  it('performs a complete round-trip import of a packed .sng package', async () => {
    const sourceSongDir = join(testTempDir, 'source_song')
    await mkdir(sourceSongDir, { recursive: true })

    // Create mock song assets
    await writeFile(join(sourceSongDir, 'notes.chart'), '[Song]\n{\n  Resolution = 192\n}\n')
    await writeFile(join(sourceSongDir, 'guitar.ogg'), 'MOCK GUITAR AUDIO')
    await writeFile(
      join(sourceSongDir, 'song.ini'),
      '[song]\nname = Test SNG\nartist = Test Artist\n'
    )

    const metadata = {
      name: 'Test SNG',
      artist: 'Test Artist',
      charter: 'Vitest',
      diff_guitar: 4,
      is_valid: true
    }

    const packedSngPath = join(testTempDir, 'test_song.sng')

    // 1. Pack SNG
    await packSng(sourceSongDir, metadata, packedSngPath)
    expect(existsSync(packedSngPath)).toBe(true)

    // 2. Import SNG into a library directory
    const libraryDir = join(testTempDir, 'library')
    await mkdir(libraryDir, { recursive: true })

    const importedDir = await importSng(packedSngPath, libraryDir)
    expect(existsSync(importedDir)).toBe(true)

    // Verify imported folder structure
    expect(existsSync(join(importedDir, 'song.ini'))).toBe(true)
    expect(existsSync(join(importedDir, 'notes.chart'))).toBe(true)
    expect(existsSync(join(importedDir, 'guitar.ogg'))).toBe(true)

    // Verify file contents were decrypted correctly
    const chartContent = await readFile(join(importedDir, 'notes.chart'), 'utf-8')
    expect(chartContent).toBe('[Song]\n{\n  Resolution = 192\n}\n')

    const audioContent = await readFile(join(importedDir, 'guitar.ogg'), 'utf-8')
    expect(audioContent).toBe('MOCK GUITAR AUDIO')

    const iniContent = await readFile(join(importedDir, 'song.ini'), 'utf-8')
    expect(iniContent).toContain('name = Test SNG')
    expect(iniContent).toContain('artist = Test Artist')
    expect(iniContent).toContain('charter = Vitest')
    expect(iniContent).toContain('diff_guitar = 4')
    expect(iniContent).toContain('is_valid = True')
  })
})

describe('CON Importer actual file validation', () => {
  const conPath = join(__dirname, 'fixtures/SheepQueen_OldTownRMX_rb3con')
  const targetLibrary = join(__dirname, '../../../out/real_import_library')
  const testTempDir = join(__dirname, '../../../out/con_export_test_temp')

  afterAll(async () => {
    if (existsSync(targetLibrary)) {
      await rm(targetLibrary, { recursive: true, force: true })
    }
    if (existsSync(testTempDir)) {
      await rm(testTempDir, { recursive: true, force: true })
    }
  })

  it('imports a real rb3con file and verifies the output files exist and are non-empty', async () => {
    if (!existsSync(conPath)) {
      console.log('Test file not found, skipping real CON import validation')
      return
    }
    await mkdir(targetLibrary, { recursive: true })

    const buffer = await readFile(conPath)

    const parser = new StfsParser(buffer)
    const { entries } = parser.parse()

    const moggKey = Object.keys(entries).find((k) => k.endsWith('.mogg'))
    if (moggKey) {
      const rawMogg = entries[moggKey]
      const decrypted = decryptMoggBuffer(rawMogg)
      expect(decrypted.subarray(0, 4).toString('ascii')).toBe('OggS')
    }

    const importedDirs = await importCon(conPath, targetLibrary)
    expect(importedDirs.length).toBeGreaterThan(0)
    const importedDir = importedDirs[0]

    expect(existsSync(join(importedDir, 'song.ini'))).toBe(true)
    expect(existsSync(join(importedDir, 'notes.mid'))).toBe(true)
    expect(existsSync(join(importedDir, 'song.ogg'))).toBe(true)

    const oggPath = join(importedDir, 'song.ogg')
    let ffmpegPath = 'ffmpeg'
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const staticPath = require('ffmpeg-static') as string | null
      if (staticPath) {
        let resolved = staticPath
        const pathSep = join('a', 'b').includes('/') ? '/' : '\\'
        if (resolved.includes(`app.asar${pathSep}`)) {
          resolved = resolved.replace(`app.asar${pathSep}`, `app.asar.unpacked${pathSep}`)
        }
        if (existsSync(resolved)) {
          ffmpegPath = resolved
        }
      }
    } catch {
      // Fallback to path ffmpeg
    }

    const { stderr } = await execAsync(
      `"${ffmpegPath}" -i "${oggPath}" -filter_complex volumedetect -f null /dev/null`
    )
    const meanMatch = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/)
    const maxMatch = stderr.match(/max_volume:\s*([-\d.]+)\s*dB/)
    const meanVolume = meanMatch ? parseFloat(meanMatch[1]) : -999
    const maxVolume = maxMatch ? parseFloat(maxMatch[1]) : -999

    console.log(
      `[Test Validation] Imported song.ogg Volume Stats - Mean: ${meanVolume} dB, Max: ${maxVolume} dB`
    )

    expect(meanVolume).toBeGreaterThan(-40) // Silence is typically -91 dB or lower
    expect(maxVolume).toBeGreaterThan(-10) // Ensure it has some active audio peaks

    const iniContent = await readFile(join(importedDir, 'song.ini'), 'utf-8')
    expect(iniContent).toContain('[song]')
  })

  it('exports a song folder back into a valid .con package and verifies the round-trip', async () => {
    if (!existsSync(conPath)) {
      return
    }

    await mkdir(testTempDir, { recursive: true })

    // 1. Re-import the original CON package first to get the song folder path
    const library = join(testTempDir, 'library')
    await mkdir(library, { recursive: true })
    const importedDirs = await importCon(conPath, library)
    expect(importedDirs.length).toBeGreaterThan(0)
    const importedDir = importedDirs[0]

    // 2. Export the song folder back to a CON package
    const exportedConPath = join(testTempDir, 're_exported_rb3con')
    const metadata = {
      name: 'Old Town Road (Remix)',
      artist: 'Lil Nas X',
      genre: 'Country/Rap',
      year: 2019,
      diff_guitar: 3,
      diff_band: 4
    }

    await packRb3con(importedDir, metadata, exportedConPath)
    expect(existsSync(exportedConPath)).toBe(true)

    // 3. Import the newly exported package back into another directory and verify
    const reImportLibrary = join(testTempDir, 're_imported_library')
    await mkdir(reImportLibrary, { recursive: true })

    const reImportedDirs = await importCon(exportedConPath, reImportLibrary)
    expect(reImportedDirs.length).toBeGreaterThan(0)
    const reImportedDir = reImportedDirs[0]

    expect(existsSync(join(reImportedDir, 'song.ini'))).toBe(true)
    expect(existsSync(join(reImportedDir, 'notes.mid'))).toBe(true)
    expect(existsSync(join(reImportedDir, 'song.ogg'))).toBe(true)

    const iniContent = await readFile(join(reImportedDir, 'song.ini'), 'utf-8')
    expect(iniContent).toContain('name = Old Town Road (Remix)')
    expect(iniContent).toContain('artist = Lil Nas X')
  }, 60000)
})
