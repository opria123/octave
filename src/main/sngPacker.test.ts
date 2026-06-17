import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { packSng } from './sngPacker'
import { join } from 'path'
import { mkdir, writeFile, readFile, rm } from 'fs/promises'
import { existsSync } from 'fs'

// Mock fs/promises to simulate long filenames that the OS might prevent writing directly
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    readdir: async (path: string, options?: any) => {
      if (String(path).includes('bad_song_long_name')) {
        return ['notes.chart', 'a'.repeat(260) + '.ogg']
      }
      return actual.readdir(path, options)
    },
    readFile: async (path: string, options?: any) => {
      if (String(path).includes('bad_song_long_name') && String(path).includes('a'.repeat(260))) {
        return Buffer.from('MOCK DATA')
      }
      return actual.readFile(path, options)
    }
  }
})

// Mock fs to simulate stats for the simulated long filename
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    statSync: (path: string) => {
      if (String(path).includes('bad_song_long_name') && String(path).includes('a'.repeat(260))) {
        return { isFile: () => true, size: 100 } as any
      }
      return actual.statSync(path)
    }
  }
})

describe('sngPacker', () => {
  const testDir = join(__dirname, '../../out/sng_test_temp')

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true })
  })

  afterAll(async () => {
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  it('packs a folder into .sng package and validates the output structure', async () => {
    const songDir = join(testDir, 'my_song')
    await mkdir(songDir, { recursive: true })

    // Create mock song files
    await writeFile(join(songDir, 'song.ini'), '[Song]\nname = Test Song\n') // should be ignored
    await writeFile(join(songDir, 'notes.chart'), '[Song]\n{\n  Resolution = 192\n}\n')
    await writeFile(join(songDir, 'guitar.ogg'), 'OGG MOCK DATA')
    await writeFile(join(songDir, 'desktop.ini'), 'ignore this') // should be ignored

    const metadata = {
      name: 'Test Song',
      artist: 'Test Artist',
      charter: 'Test Charter',
      is_valid: true // should become "True"
    }

    const sngOutPath = join(testDir, 'test_song.sng')

    // Run packSng
    await packSng(songDir, metadata, sngOutPath)

    expect(existsSync(sngOutPath)).toBe(true)

    // Decode and verify SNG file
    const fileBuf = await readFile(sngOutPath)

    // Header
    const magic = fileBuf.subarray(0, 6).toString('ascii')
    expect(magic).toBe('SNGPKG')

    const version = fileBuf.readUInt32LE(6)
    expect(version).toBe(1)

    const seed = fileBuf.subarray(10, 26)
    expect(seed.length).toBe(16)

    // Helper: generate keystream
    const keystream = Buffer.alloc(256)
    for (let i = 0; i < 256; i++) {
      keystream[i] = seed[i % 16] ^ i
    }

    let cursor = 26

    // Metadata Section
    const metadataSecLen = fileBuf.readBigUInt64LE(cursor)
    cursor += 8

    const count = fileBuf.readBigUInt64LE(cursor)
    expect(count).toBe(4n) // name, artist, charter, is_valid
    
    const parsedMetadata: Record<string, string> = {}
    let metaOffset = cursor + 8
    for (let i = 0; i < Number(count); i++) {
      const keyLen = fileBuf.readInt32LE(metaOffset)
      metaOffset += 4
      const key = fileBuf.subarray(metaOffset, metaOffset + keyLen).toString('utf-8')
      metaOffset += keyLen

      const valLen = fileBuf.readInt32LE(metaOffset)
      metaOffset += 4
      const val = fileBuf.subarray(metaOffset, metaOffset + valLen).toString('utf-8')
      metaOffset += valLen

      parsedMetadata[key] = val
    }
    expect(parsedMetadata.name).toBe('Test Song')
    expect(parsedMetadata.artist).toBe('Test Artist')
    expect(parsedMetadata.charter).toBe('Test Charter')
    expect(parsedMetadata.is_valid).toBe('True')

    cursor += Number(metadataSecLen)

    // File Index Section
    const fileIndexSecLen = fileBuf.readBigUInt64LE(cursor)
    cursor += 8

    const fileCount = fileBuf.readBigUInt64LE(cursor)
    expect(fileCount).toBe(2n) // notes.chart, guitar.ogg (song.ini & desktop.ini are ignored)

    const indexEntries: Array<{ name: string; size: bigint; offset: bigint }> = []
    let idxOffset = cursor + 8
    for (let i = 0; i < Number(fileCount); i++) {
      const nameLen = fileBuf.readUInt8(idxOffset)
      idxOffset += 1
      const name = fileBuf.subarray(idxOffset, idxOffset + nameLen).toString('utf-8')
      idxOffset += nameLen

      const size = fileBuf.readBigUInt64LE(idxOffset)
      idxOffset += 8
      const offset = fileBuf.readBigUInt64LE(idxOffset)
      idxOffset += 8

      indexEntries.push({ name, size, offset })
    }

    expect(indexEntries.map(e => e.name)).toContain('notes.chart')
    expect(indexEntries.map(e => e.name)).toContain('guitar.ogg')

    cursor += Number(fileIndexSecLen)

    // File Data Section
    const fileDataSecLen = fileBuf.readBigUInt64LE(cursor)
    cursor += 8

    const payloadBlock = fileBuf.subarray(cursor)
    expect(BigInt(payloadBlock.length)).toBe(fileDataSecLen)

    // Decrypt and verify files using relative offsets (keystream starts at 0 for each file)
    for (const file of indexEntries) {
      const start = Number(file.offset)
      const end = start + Number(file.size)
      const encryptedData = fileBuf.subarray(start, end)
      
      const decryptedData = Buffer.from(encryptedData)
      for (let i = 0; i < decryptedData.length; i++) {
        decryptedData[i] ^= keystream[i % 256]
      }

      if (file.name === 'notes.chart') {
        expect(decryptedData.toString('utf-8')).toBe('[Song]\n{\n  Resolution = 192\n}\n')
      } else if (file.name === 'guitar.ogg') {
        expect(decryptedData.toString('utf-8')).toBe('OGG MOCK DATA')
      }
    }
  })

  it('throws an error if the song directory does not exist', async () => {
    const nonExistent = join(testDir, 'non_existent_folder_abc')
    const sngOutPath = join(testDir, 'should_fail.sng')
    await expect(packSng(nonExistent, {}, sngOutPath)).rejects.toThrow()
  })

  it('throws an error if the song folder contains no playable files (no notes.chart or notes.mid)', async () => {
    const badSongDir = join(testDir, 'bad_song_no_chart')
    await mkdir(badSongDir, { recursive: true })
    await writeFile(join(badSongDir, 'guitar.ogg'), 'OGG MOCK DATA')
    
    const sngOutPath = join(testDir, 'should_fail.sng')
    await expect(packSng(badSongDir, {}, sngOutPath)).rejects.toThrow('Song directory does not contain a notes.chart or notes.mid file.')
  })

  it('throws an error if a filename in the folder exceeds 255 bytes', async () => {
    const badSongDir = join(testDir, 'bad_song_long_name')
    await mkdir(badSongDir, { recursive: true })
    await writeFile(join(badSongDir, 'notes.chart'), 'MOCK CHART')
    
    const sngOutPath = join(testDir, 'should_fail.sng')
    await expect(packSng(badSongDir, {}, sngOutPath)).rejects.toThrow('Filename is too long for SNG format')
  })
})
