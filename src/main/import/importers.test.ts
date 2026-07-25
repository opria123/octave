import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { parseDta } from './dtaParser'
import { decryptBytes, decryptMoggBuffer } from './moggDecrypt'
import { importSng, resolveSngOutputPath } from './sngImporter'
import { importCon, StfsParser } from './conImporter'
import { getBlockPatternShift0, packRb3con, oggToMogg } from '../conPacker'
import { packSng } from '../sngPacker'
import { join, resolve } from 'path'
import { existsSync } from 'fs'
import { mkdir, writeFile, readFile, rm } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createCipheriv, createHash } from 'crypto'

const execFileAsync = promisify(execFile)

/** Minimal Standard MIDI File (format 0, one short note). */
function buildMinimalMidi(): Buffer {
  const header = Buffer.alloc(14)
  header.write('MThd', 0)
  header.writeUInt32BE(6, 4)
  header.writeUInt16BE(0, 8) // format 0
  header.writeUInt16BE(1, 10) // 1 track
  header.writeUInt16BE(480, 12) // division

  // note on C4, note off after 480 ticks, end of track
  const events = Buffer.from([
    0x00, 0x90, 0x3c, 0x40, 0x83, 0x60, 0x80, 0x3c, 0x40, 0x00, 0xff, 0x2f, 0x00
  ])
  const track = Buffer.alloc(8 + events.length)
  track.write('MTrk', 0)
  track.writeUInt32BE(events.length, 4)
  events.copy(track, 8)

  return Buffer.concat([header, track])
}

function resolveFfmpegPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const staticPath = require('ffmpeg-static') as string | null
    if (staticPath) {
      let resolved = staticPath
      const pathSep = join('a', 'b').includes('/') ? '/' : '\\'
      if (resolved.includes(`app.asar${pathSep}`)) {
        resolved = resolved.replace(`app.asar${pathSep}`, `app.asar.unpacked${pathSep}`)
      }
      if (existsSync(resolved)) return resolved
    }
  } catch {
    // fall through
  }
  return 'ffmpeg'
}

/** Generate a tiny mono Vorbis OGG via ffmpeg-static (or system ffmpeg). */
async function generateTinyOgg(outputPath: string): Promise<void> {
  const ffmpegPath = resolveFfmpegPath()
  await execFileAsync(ffmpegPath, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=0.25',
    '-c:a',
    'libvorbis',
    '-q:a',
    '3',
    outputPath
  ])
}

/** Generate a tiny four-channel Vorbis OGG to exercise the importer's FFmpeg downmix. */
async function generateTinyQuadOgg(outputPath: string): Promise<void> {
  const ffmpegPath = resolveFfmpegPath()
  await execFileAsync(ffmpegPath, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=channel_layout=quad:sample_rate=44100',
    '-t',
    '0.25',
    '-c:a',
    'libvorbis',
    outputPath
  ])
}

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

  it('passthrough-decrypts unencrypted version 0x0A mogg (oggToMogg output)', async () => {
    const tempDir = join(__dirname, '../../../out/mogg_unit_temp')
    await mkdir(tempDir, { recursive: true })
    try {
      const oggPath = join(tempDir, 'tone.ogg')
      await generateTinyOgg(oggPath)
      const ogg = await readFile(oggPath)
      const mogg = oggToMogg(ogg)
      expect(mogg.readInt32LE(0)).toBe(0x0a)

      const decrypted = decryptMoggBuffer(mogg)
      expect(decrypted.subarray(0, 4).toString('ascii')).toBe('OggS')
      expect(decrypted.equals(ogg)).toBe(true)
    } finally {
      if (existsSync(tempDir)) {
        await rm(tempDir, { recursive: true, force: true })
      }
    }
  }, 30000)
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
    // parse-sng may omit spaces around '=', but every value must remain tied to its key.
    expect(iniContent).toMatch(/^name\s*=\s*Test SNG$/mi)
    expect(iniContent).toMatch(/^artist\s*=\s*Test Artist$/mi)
    expect(iniContent).toMatch(/^charter\s*=\s*Vitest$/mi)
    expect(iniContent).toMatch(/^diff_guitar\s*=\s*4$/mi)
    expect(iniContent).toMatch(/^is_valid\s*=\s*True$/mi)

    const duplicateImportDir = await importSng(packedSngPath, libraryDir)
    expect(duplicateImportDir).not.toBe(importedDir)
    expect(duplicateImportDir).toMatch(/\(2\)$/)
    expect(await readFile(join(duplicateImportDir, 'guitar.ogg'), 'utf-8')).toBe(
      'MOCK GUITAR AUDIO'
    )
  })
})

describe('resolveSngOutputPath', () => {
  it('keeps package files inside the target song directory', () => {
    // resolve() so the expectation carries a drive letter on Windows, matching
    // the resolved path the function returns.
    const targetDir = resolve('/tmp', 'octave-song')
    expect(resolveSngOutputPath(targetDir, 'audio/guitar.ogg')).toBe(
      join(targetDir, 'audio/guitar.ogg')
    )
  })

  it.each(['../outside.txt', 'audio/../../outside.txt'])(
    'rejects traversal path %s',
    (fileName) => {
      expect(() => resolveSngOutputPath('/tmp/octave-song', fileName)).toThrow(
        'Unsafe path in SNG package'
      )
    }
  )
})

describe('decryptBytes', () => {
  const mask64 = 0xffffffffffffffffn

  /** Straightforward per-block CTR reference: one ECB encryption per 16-byte counter. */
  function referenceDecrypt(
    buffer: Buffer,
    startPos: number,
    count: number,
    key: Buffer,
    initialCounter: Buffer
  ): void {
    const low0 = initialCounter.readBigUInt64LE(0)
    const high0 = initialCounter.readBigUInt64LE(8)
    for (let i = 0; i < count; i++) {
      const pos = startPos + i
      const counter = Buffer.alloc(16)
      const newLow = (low0 + BigInt(Math.floor(pos / 16))) & mask64
      const newHigh = newLow < low0 ? (high0 + 1n) & mask64 : high0
      counter.writeBigUInt64LE(newLow, 0)
      counter.writeBigUInt64LE(newHigh, 8)
      const cipher = createCipheriv('aes-128-ecb', key, null)
      cipher.setAutoPadding(false)
      const keystream = Buffer.concat([cipher.update(counter), cipher.final()])
      buffer[i] ^= keystream[pos % 16]
    }
  }

  function deterministicBytes(size: number, seed: string): Buffer {
    const out = Buffer.alloc(size)
    let digest = createHash('sha256').update(seed).digest()
    for (let offset = 0; offset < size; offset += digest.length) {
      digest.copy(out, offset, 0, Math.min(digest.length, size - offset))
      digest = createHash('sha256').update(digest).digest()
    }
    return out
  }

  const key = createHash('md5').update('decrypt-bytes-key').digest()

  it('matches the per-block reference at an unaligned mid-stream offset', () => {
    const counter = createHash('md5').update('decrypt-bytes-counter').digest()
    const data = deterministicBytes(5000, 'payload')
    const expected = Buffer.from(data)
    referenceDecrypt(expected, 32, expected.length, key, counter)
    decryptBytes(data, 32, data.length, key, counter)
    expect(data.equals(expected)).toBe(true)
  })

  it('carries into the high counter half when the low half wraps', () => {
    const counter = Buffer.alloc(16)
    counter.writeBigUInt64LE(mask64 - 1n, 0)
    counter.writeBigUInt64LE(0x0123456789abcdefn, 8)
    const data = deterministicBytes(256, 'wrap-payload')
    const expected = Buffer.from(data)
    referenceDecrypt(expected, 0, expected.length, key, counter)
    decryptBytes(data, 0, data.length, key, counter)
    expect(data.equals(expected)).toBe(true)
  })
})

describe('CON packer/importer synthetic round-trip', () => {
  const testTempDir = join(__dirname, '../../../out/con_roundtrip_test_temp')
  const metadata = {
    name: 'Dummy Song',
    artist: 'Test Artist',
    genre: 'rock',
    year: 2026,
    charter: 'Vitest',
    diff_guitar: 3,
    diff_band: 4,
    diff_drums: 2,
    diff_bass: 1,
    diff_vocals: 0,
    diff_keys: 0
  }

  let sourceSongDir: string
  let packedConPath: string

  beforeAll(async () => {
    await rm(testTempDir, { recursive: true, force: true }).catch(() => undefined)
    await mkdir(testTempDir, { recursive: true })

    // 1. Build a dummy song folder (midi + real tiny ogg)
    sourceSongDir = join(testTempDir, 'source_song')
    await mkdir(sourceSongDir, { recursive: true })
    await writeFile(join(sourceSongDir, 'notes.mid'), buildMinimalMidi())
    await generateTinyOgg(join(sourceSongDir, 'song.ogg'))

    // 2. Pack → rb3con
    packedConPath = join(testTempDir, 'dummy_song_rb3con')
    await packRb3con(sourceSongDir, metadata, packedConPath)
  }, 60000)

  afterAll(async () => {
    if (existsSync(testTempDir)) {
      await rm(testTempDir, { recursive: true, force: true })
    }
  })

  it('packs a synthetic song folder into a non-empty .con container', async () => {
    expect(existsSync(packedConPath)).toBe(true)
    const conBuf = await readFile(packedConPath)
    expect(conBuf.length).toBeGreaterThan(0xb000) // header template size
  })

  it('STFS-parses the packed .con and decrypts the embedded mogg to OggS', async () => {
    const buffer = await readFile(packedConPath)
    const parser = new StfsParser(buffer)
    const { entries } = parser.parse()

    const dtaKey = Object.keys(entries).find((k) => k.toLowerCase().endsWith('songs.dta'))
    expect(dtaKey).toBeDefined()

    const moggKey = Object.keys(entries).find((k) => k.toLowerCase().endsWith('.mogg'))
    expect(moggKey).toBeDefined()
    const rawMogg = entries[moggKey!]
    const decrypted = decryptMoggBuffer(rawMogg)
    expect(decrypted.subarray(0, 4).toString('ascii')).toBe('OggS')

    const midKey = Object.keys(entries).find((k) => k.toLowerCase().endsWith('.mid'))
    expect(midKey).toBeDefined()
    expect(entries[midKey!].subarray(0, 4).toString('ascii')).toBe('MThd')
  })

  it('produces valid generated L0, L1, and top-level SHA1 hash chains', async () => {
    const hashSource = join(testTempDir, 'hash_source')
    await mkdir(hashSource, { recursive: true })
    await writeFile(join(hashSource, 'notes.mid'), buildMinimalMidi())
    const generatedOgg = Buffer.alloc(171 * 0x1000)
    generatedOgg.write('OggS')
    await writeFile(join(hashSource, 'song.ogg'), generatedOgg)

    const hashConPath = join(testTempDir, 'hash_validation_rb3con')
    await packRb3con(hashSource, metadata, hashConPath)
    const con = await readFile(hashConPath)
    const headerSize = 0xb000
    const volumeDescriptorOffset = 0x22c + 0x14d
    const totalDataBlocks = con.readUInt32BE(volumeDescriptorOffset + 28)
    expect(totalDataBlocks).toBeGreaterThan(170)

    const pattern = getBlockPatternShift0(totalDataBlocks)
    const physicalIndexes = new Map<string, number>()
    pattern.forEach(({ type, logicalIndex }, physicalIndex) => {
      physicalIndexes.set(`${type}:${logicalIndex}`, physicalIndex)
    })

    for (let logicalIndex = 0; logicalIndex < totalDataBlocks; logicalIndex++) {
      const dataPhysicalIndex = physicalIndexes.get(`Data:${logicalIndex}`)!
      const l0PhysicalIndex = physicalIndexes.get(`L0:${Math.floor(logicalIndex / 170)}`)!
      const recordOffset = headerSize + l0PhysicalIndex * 0x1000 + (logicalIndex % 170) * 24
      const dataOffset = headerSize + dataPhysicalIndex * 0x1000
      const expected = createHash('sha1')
        .update(con.subarray(dataOffset, dataOffset + 0x1000))
        .digest()

      expect(con.subarray(recordOffset, recordOffset + 20).equals(expected)).toBe(true)
      expect(con[recordOffset + 20]).toBe(0x80)
    }

    const l1PhysicalIndex = physicalIndexes.get('L1:0')!
    const l1Offset = headerSize + l1PhysicalIndex * 0x1000
    const l0Count = Math.ceil(totalDataBlocks / 170)
    for (let l0Index = 0; l0Index < l0Count; l0Index++) {
      const l0PhysicalIndex = physicalIndexes.get(`L0:${l0Index}`)!
      const l0Offset = headerSize + l0PhysicalIndex * 0x1000
      const expected = createHash('sha1')
        .update(con.subarray(l0Offset, l0Offset + 0x1000))
        .digest()
      expect(con.subarray(l1Offset + l0Index * 24, l1Offset + l0Index * 24 + 20).equals(expected)).toBe(
        true
      )
    }

    const expectedTopHash = createHash('sha1')
      .update(con.subarray(l1Offset, l1Offset + 0x1000))
      .digest()
    expect(
      con
        .subarray(volumeDescriptorOffset + 8, volumeDescriptorOffset + 28)
        .equals(expectedTopHash)
    ).toBe(true)
  })

  it('imports (de-converts) the packed .con into a song folder with midi, ogg, and song.ini', async () => {
    const libraryDir = join(testTempDir, 'import_library')
    await mkdir(libraryDir, { recursive: true })

    const importedDirs = await importCon(packedConPath, libraryDir)
    expect(importedDirs.length).toBe(1)
    const importedDir = importedDirs[0]

    expect(existsSync(join(importedDir, 'song.ini'))).toBe(true)
    expect(existsSync(join(importedDir, 'notes.mid'))).toBe(true)
    expect(existsSync(join(importedDir, 'song.ogg'))).toBe(true)

    const midi = await readFile(join(importedDir, 'notes.mid'))
    expect(midi.subarray(0, 4).toString('ascii')).toBe('MThd')
    expect(midi.equals(buildMinimalMidi())).toBe(true)

    const ogg = await readFile(join(importedDir, 'song.ogg'))
    expect(ogg.subarray(0, 4).toString('ascii')).toBe('OggS')
    // Round-trip should preserve the original packed ogg bytes for unencrypted v10 mogg
    const originalOgg = await readFile(join(sourceSongDir, 'song.ogg'))
    expect(ogg.equals(originalOgg)).toBe(true)

    const iniContent = await readFile(join(importedDir, 'song.ini'), 'utf-8')
    expect(iniContent).toContain('[song]')
    expect(iniContent).toContain('name = Dummy Song')
    expect(iniContent).toContain('artist = Test Artist')
    expect(iniContent).toContain('diff_guitar = 3')
    expect(iniContent).toContain('diff_band = 4')
  })

  it('supports a second pack → import cycle from the de-converted folder', async () => {
    const libraryDir = join(testTempDir, 'import_library')
    const importedDirs = await importCon(packedConPath, libraryDir)
    const importedDir = importedDirs[0]

    const reExportPath = join(testTempDir, 're_exported_rb3con')
    await packRb3con(importedDir, metadata, reExportPath)
    expect(existsSync(reExportPath)).toBe(true)

    const reImportLibrary = join(testTempDir, 're_import_library')
    await mkdir(reImportLibrary, { recursive: true })
    const reImportedDirs = await importCon(reExportPath, reImportLibrary)
    expect(reImportedDirs.length).toBe(1)

    const reImportedDir = reImportedDirs[0]
    expect(existsSync(join(reImportedDir, 'song.ini'))).toBe(true)
    expect(existsSync(join(reImportedDir, 'notes.mid'))).toBe(true)
    expect(existsSync(join(reImportedDir, 'song.ogg'))).toBe(true)

    const iniContent = await readFile(join(reImportedDir, 'song.ini'), 'utf-8')
    expect(iniContent).toContain('name = Dummy Song')
    expect(iniContent).toContain('artist = Test Artist')

    const midi = await readFile(join(reImportedDir, 'notes.mid'))
    expect(midi.equals(buildMinimalMidi())).toBe(true)
  }, 60000)

  it('treats shell metacharacters in imported metadata as literal path text', async () => {
    const markerName = 'octave-import-command-injection-marker'
    const markerPath = join(process.cwd(), markerName)
    await rm(markerPath, { force: true })

    const hostileSource = join(testTempDir, 'hostile_source')
    await mkdir(hostileSource, { recursive: true })
    await writeFile(join(hostileSource, 'notes.mid'), buildMinimalMidi())
    await generateTinyQuadOgg(join(hostileSource, 'song.ogg'))

    const hostileCon = join(testTempDir, 'hostile_rb3con')
    await packRb3con(
      hostileSource,
      { ...metadata, artist: `\`touch ${markerName}\`` },
      hostileCon
    )

    const hostileLibrary = join(testTempDir, 'hostile_library')
    await mkdir(hostileLibrary, { recursive: true })
    const importedDirs = await importCon(hostileCon, hostileLibrary)

    expect(importedDirs).toHaveLength(1)
    expect(existsSync(join(importedDirs[0], 'song.ogg'))).toBe(true)
    expect(existsSync(markerPath)).toBe(false)
  }, 60000)
})
