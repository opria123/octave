import { readdir, readFile, rename, unlink } from 'fs/promises'
import { join } from 'path'
import { existsSync, statSync, createWriteStream } from 'fs'
import { randomBytes } from 'crypto'

interface SngMetadata {
  [key: string]: string | number | boolean
}

// Generate the 256-byte keystream from a 16-byte seed
function generateKeystream(seed: Buffer): Buffer {
  const keystream = Buffer.alloc(256)
  for (let i = 0; i < 256; i++) {
    keystream[i] = seed[i % 16] ^ i
  }
  return keystream
}

/**
 * Packages all files in a song folder (except song.ini, desktop.ini, .bak files, etc.)
 * into a single Clone Hero .sng file.
 */
export async function packSng(
  songDir: string,
  metadata: SngMetadata,
  outputPath: string
): Promise<void> {
  if (!existsSync(songDir)) {
    throw new Error(`Song directory does not exist: ${songDir}`)
  }

  // 1. Gather all files to include and determine their sizes
  const allEntries = await readdir(songDir)
  const filesList: Array<{ name: string; size: number }> = []

  for (const entry of allEntries) {
    const entryPath = join(songDir, entry)
    const lowerEntry = entry.toLowerCase()
    
    // Ignore song.ini (metadata section contains its info), system files, backups/temp files,
    // and directories.
    if (
      lowerEntry === 'song.ini' ||
      lowerEntry === 'desktop.ini' ||
      lowerEntry === '.ds_store' ||
      lowerEntry === 'video.json' ||
      lowerEntry === 'audio.json' ||
      lowerEntry === 'venue.json' ||
      lowerEntry.endsWith('.bak1') ||
      lowerEntry.endsWith('.bak2') ||
      lowerEntry.endsWith('.bak3') ||
      lowerEntry.endsWith('.tmp')
    ) {
      continue
    }

    try {
      const stat = statSync(entryPath)
      if (stat.isFile()) {
        filesList.push({ name: entry, size: stat.size })
      }
    } catch {
      // Ignore unreachable files
    }
  }

  // Validation: Check that the folder isn't empty of playable files
  if (filesList.length === 0) {
    throw new Error('Song directory contains no packable files.')
  }

  const hasChartOrMidi = filesList.some((f) => {
    const lower = f.name.toLowerCase()
    return lower === 'notes.chart' || lower === 'notes.mid'
  })
  if (!hasChartOrMidi) {
    throw new Error('Song directory does not contain a notes.chart or notes.mid file.')
  }

  // 2. Generate random 16-byte seed and repeating keystream
  const seed = randomBytes(16)
  const keystream = generateKeystream(seed)

  // 3. Build Metadata Section Data Buffer
  // Format: count (uint64LE) + key/value pairs
  // Each pair: keyLength (int32LE) + key (UTF-8) + valueLength (int32LE) + value (UTF-8)
  const metaPairs: Array<{ keyBuf: Buffer; valBuf: Buffer }> = []
  for (const [key, value] of Object.entries(metadata)) {
    // Normalization rules:
    // - Clone Hero will error if a metadata value is completely empty. Empty values must be pruned.
    // - Boolean values must be normalized to capitalized strings ("True" or "False").
    let valStr = ''
    if (value === undefined || value === null) {
      continue
    } else if (typeof value === 'boolean') {
      valStr = value ? 'True' : 'False'
    } else {
      valStr = String(value).trim()
      const lowerKey = key.toLowerCase()
      const rawKeys = ['name', 'artist', 'album', 'genre', 'sub_genre', 'year', 'charter', 'frets']
      if (!rawKeys.includes(lowerKey)) {
        const lowerVal = valStr.toLowerCase()
        if (lowerVal === 'true') {
          valStr = 'True'
        } else if (lowerVal === 'false') {
          valStr = 'False'
        }
      }
    }

    if (valStr === '') {
      continue
    }

    const keyBuf = Buffer.from(key, 'utf-8')
    const valBuf = Buffer.from(valStr, 'utf-8')
    metaPairs.push({ keyBuf, valBuf })
  }

  // Calculate Metadata Section Length
  let metaDataSize = 8 // for count (uint64LE)
  for (const pair of metaPairs) {
    metaDataSize += 4 + pair.keyBuf.length + 4 + pair.valBuf.length
  }

  const metaBuffer = Buffer.alloc(8 + metaDataSize) // 8 bytes for metadataSectionLength field + metaDataSize
  metaBuffer.writeBigUInt64LE(BigInt(metaDataSize), 0)
  metaBuffer.writeBigUInt64LE(BigInt(metaPairs.length), 8)

  let metaOffset = 16
  for (const pair of metaPairs) {
    metaBuffer.writeInt32LE(pair.keyBuf.length, metaOffset)
    metaOffset += 4
    pair.keyBuf.copy(metaBuffer, metaOffset)
    metaOffset += pair.keyBuf.length

    metaBuffer.writeInt32LE(pair.valBuf.length, metaOffset)
    metaOffset += 4
    pair.valBuf.copy(metaBuffer, metaOffset)
    metaOffset += pair.valBuf.length
  }

  // 4. Calculate File Index Section Length (to determine absolute offsets)
  let indexDataSize = 8 // count (uint64LE)
  for (const file of filesList) {
    const nameBuf = Buffer.from(file.name, 'utf-8')
    if (nameBuf.length > 255) {
      throw new Error(`Filename is too long for SNG format: ${file.name}`)
    }
    indexDataSize += 1 + nameBuf.length + 8 + 8
  }

  // Calculate the absolute offset where the payload block starts
  const absoluteHeaderSize = 26 + (8 + metaDataSize) + (8 + indexDataSize) + 8

  // Build file index entries with their exact absolute offsets
  const fileEntries: Array<{ name: string; size: number; offset: number }> = []
  let currentOffset = absoluteHeaderSize

  for (const file of filesList) {
    fileEntries.push({
      name: file.name,
      size: file.size,
      offset: currentOffset
    })
    currentOffset += file.size
  }

  // Build File Index Buffer
  const indexBuffer = Buffer.alloc(8 + indexDataSize)
  indexBuffer.writeBigUInt64LE(BigInt(indexDataSize), 0)
  indexBuffer.writeBigUInt64LE(BigInt(fileEntries.length), 8)

  let indexOffset = 16
  for (const entry of fileEntries) {
    const nameBuf = Buffer.from(entry.name, 'utf-8')
    indexBuffer.writeUInt8(nameBuf.length, indexOffset)
    indexOffset += 1
    nameBuf.copy(indexBuffer, indexOffset)
    indexOffset += nameBuf.length
    indexBuffer.writeBigUInt64LE(BigInt(entry.size), indexOffset)
    indexOffset += 8
    indexBuffer.writeBigUInt64LE(BigInt(entry.offset), indexOffset)
    indexOffset += 8
  }

  // 5. Build File Data Header Buffer
  const payloadDataSize = currentOffset - absoluteHeaderSize
  const payloadHeaderBuffer = Buffer.alloc(8)
  payloadHeaderBuffer.writeBigUInt64LE(BigInt(payloadDataSize), 0)

  // 6. Build the header:
  const headerBuffer = Buffer.alloc(26)
  headerBuffer.write('SNGPKG', 0, 'ascii')
  headerBuffer.writeUInt32LE(1, 6)
  seed.copy(headerBuffer, 10)

  // 7. Write atomically using temporary file and write stream
  const tempPath = `${outputPath}.tmp`
  const writeStream = createWriteStream(tempPath)

  try {
    // Write headers
    writeStream.write(headerBuffer)
    writeStream.write(metaBuffer)
    writeStream.write(indexBuffer)
    writeStream.write(payloadHeaderBuffer)

    // Write file payloads sequentially (streaming style, low RAM profile)
    for (const entry of fileEntries) {
      const filePath = join(songDir, entry.name)
      const rawData = await readFile(filePath)
      
      // Encrypt rawData with keystream relative to each file's start (0-indexed)
      const encrypted = Buffer.from(rawData)
      for (let i = 0; i < rawData.length; i++) {
        encrypted[i] ^= keystream[i % 256]
      }

      const canWrite = writeStream.write(encrypted)
      if (!canWrite) {
        // Wait for drain event if kernel buffers are full
        await new Promise<void>((resolve) => {
          writeStream.once('drain', resolve)
        })
      }
    }

    // Wait for the stream to finish writing
    await new Promise<void>((resolve, reject) => {
      writeStream.end(() => {
        resolve()
      })
      writeStream.on('error', reject)
    })

    // Rename temp file to output path (atomic swap)
    await rename(tempPath, outputPath)
  } catch (err) {
    // Cleanup temporary file in case of error
    writeStream.destroy()
    try {
      if (existsSync(tempPath)) {
        await unlink(tempPath)
      }
    } catch {
      // Ignore cleanup error
    }
    throw err
  }
}
