import { promises as fs } from 'fs'
import * as fsSync from 'fs'
import * as path from 'path'
import { pipeline } from 'stream/promises'
import { Transform, TransformCallback } from 'stream'

export class SngDecryptTransform extends Transform {
  private keystream: Buffer
  private bytesProcessed = 0

  constructor(keystream: Buffer) {
    super()
    this.keystream = keystream
  }

  _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    for (let i = 0; i < chunk.length; i++) {
      const fileIndex = this.bytesProcessed + i
      chunk[i] ^= this.keystream[fileIndex % 256]
    }
    this.bytesProcessed += chunk.length
    this.push(chunk)
    callback()
  }
}

function generateKeystream(seed: Buffer): Buffer {
  const keystream = Buffer.alloc(256)
  for (let i = 0; i < 256; i++) {
    keystream[i] = seed[i % 16] ^ i
  }
  return keystream
}

interface FileEntry {
  name: string
  size: bigint
  offset: bigint
}

function sanitizeDirName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim()
}

function getSongFolderName(metadata: Record<string, string>): string {
  const artist = metadata.artist || 'Unknown Artist'
  const name = metadata.name || 'Unknown Song'
  return sanitizeDirName(`${artist} - ${name}`)
}

function buildIniContent(metadata: Record<string, string>): string {
  let ini = '[song]\n'
  for (const [key, value] of Object.entries(metadata)) {
    ini += `${key} = ${value}\n`
  }
  return ini
}

export async function importSng(sngFilePath: string, libraryDir: string): Promise<string> {
  const buffer = await fs.readFile(sngFilePath)

  if (buffer.length < 26) {
    throw new Error('SNG file is too small or truncated.')
  }

  const magic = buffer.subarray(0, 6).toString('ascii')
  if (magic !== 'SNGPKG') {
    throw new Error('Invalid file format: Magic signature "SNGPKG" not found.')
  }

  const version = buffer.readUInt32LE(6)
  if (version !== 1) {
    throw new Error(`Unsupported SNG version: ${version}. Only version 1 is supported.`)
  }

  const seed = buffer.subarray(10, 26)
  const keystream = generateKeystream(seed)

  let cursor = 26
  const metaSecLen = Number(buffer.readBigUInt64LE(cursor))
  cursor += 8

  const metadataCount = Number(buffer.readBigUInt64LE(cursor))
  let metaOffset = cursor + 8
  const metadata: Record<string, string> = {}

  for (let i = 0; i < metadataCount; i++) {
    const keyLen = buffer.readInt32LE(metaOffset)
    metaOffset += 4
    const key = buffer.subarray(metaOffset, metaOffset + keyLen).toString('utf-8')
    metaOffset += keyLen

    const valLen = buffer.readInt32LE(metaOffset)
    metaOffset += 4
    const val = buffer.subarray(metaOffset, metaOffset + valLen).toString('utf-8')
    metaOffset += valLen

    metadata[key] = val
  }
  cursor += metaSecLen

  buffer.readBigUInt64LE(cursor)
  cursor += 8

  const fileCount = Number(buffer.readBigUInt64LE(cursor))
  let idxOffset = cursor + 8
  const files: FileEntry[] = []

  for (let i = 0; i < fileCount; i++) {
    const nameLen = buffer.readUInt8(idxOffset)
    idxOffset += 1
    const name = buffer.subarray(idxOffset, idxOffset + nameLen).toString('utf-8')
    idxOffset += nameLen

    const size = buffer.readBigUInt64LE(idxOffset)
    idxOffset += 8
    const offset = buffer.readBigUInt64LE(idxOffset)
    idxOffset += 8

    files.push({ name, size, offset })
  }

  const songFolderName = getSongFolderName(metadata)
  const targetDir = path.join(libraryDir, songFolderName)
  await fs.mkdir(targetDir, { recursive: true })

  const iniContent = buildIniContent(metadata)
  await fs.writeFile(path.join(targetDir, 'song.ini'), iniContent, 'utf-8')

  for (const file of files) {
    const outputPath = path.join(targetDir, file.name)

    const readStream = fsSync.createReadStream(sngFilePath, {
      start: Number(file.offset),
      end: Number(file.offset) + Number(file.size) - 1
    })

    const decryptStream = new SngDecryptTransform(keystream)
    const writeStream = fsSync.createWriteStream(outputPath)

    await pipeline(readStream, decryptStream, writeStream)
  }

  return targetDir
}
