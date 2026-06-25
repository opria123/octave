import { promises as fs, existsSync } from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

interface ConMetadata {
  [key: string]: string | number | boolean
}

function getDeterministicSongId(shortname: string): number {
  let hash = 0
  for (let i = 0; i < shortname.length; i++) {
    hash = (hash << 5) - hash + shortname.charCodeAt(i)
    hash |= 0 // 32-bit int conversion
  }
  return 1000000 + Math.abs(hash % 9000000)
}

function tierToRank(tier: string | number | boolean | null | undefined): number {
  const val = Number(tier)
  if (isNaN(val) || val <= 0) return 0
  if (val === 1) return 100
  if (val === 2) return 200
  if (val === 3) return 300
  if (val === 4) return 400
  if (val === 5) return 500
  return 600
}

interface OggPageMap {
  bytes: number
  samples: number
}

function scanOggPages(oggBuf: Buffer): OggPageMap[] {
  const maps: OggPageMap[] = []
  let offset = 0
  const len = oggBuf.length

  while (offset < len) {
    if (offset + 27 > len) break

    // Verify magic 'OggS'
    if (
      oggBuf[offset] !== 0x4f || // 'O'
      oggBuf[offset + 1] !== 0x67 || // 'g'
      oggBuf[offset + 2] !== 0x67 || // 'g'
      oggBuf[offset + 3] !== 0x53 // 'S'
    ) {
      offset++
      continue
    }

    const granule = Number(oggBuf.readBigUInt64LE(offset + 6))
    const numSegments = oggBuf[offset + 26]

    if (offset + 27 + numSegments > len) break

    let payloadSize = 0
    for (let i = 0; i < numSegments; i++) {
      payloadSize += oggBuf[offset + 27 + i]
    }

    const isInvalid = oggBuf.readBigInt64LE(offset + 6) === -1n
    if (!isInvalid) {
      maps.push({ bytes: offset, samples: granule })
    }

    offset += 27 + numSegments + payloadSize
  }

  return maps
}

function makeMoggTable(bufSize: number, audioLen: number, pairs: OggPageMap[]): OggPageMap[] {
  const result: OggPageMap[] = []
  let curSample = 0
  let prevPair = { bytes: 0, samples: 0 }
  let pIdx = 0

  while (curSample < audioLen) {
    if (pIdx >= pairs.length) {
      result.push({ ...prevPair })
      curSample += bufSize
    } else {
      const p = pairs[pIdx]
      if (p.samples <= curSample) {
        prevPair = p
        pIdx++
      } else {
        result.push({ ...prevPair })
        curSample += bufSize
      }
    }
  }
  return result
}

export function oggToMogg(oggBuf: Buffer): Buffer {
  const pairs = scanOggPages(oggBuf)
  const audioLen = pairs.length > 0 ? pairs[pairs.length - 1].samples : 0
  const bufSize = 20000
  const table = makeMoggTable(bufSize, audioLen, pairs)

  const headerSize = 20 + 8 * table.length
  const header = Buffer.alloc(headerSize)

  header.writeUInt32LE(0x0a, 0) // Version 10 (unencrypted)
  header.writeUInt32LE(headerSize, 4) // Size of header before Ogg
  header.writeUInt32LE(0x10, 8) // Ogg map version
  header.writeUInt32LE(bufSize, 12) // Buffer size
  header.writeUInt32LE(table.length, 16) // Number of pairs

  let offset = 20
  for (const pair of table) {
    header.writeUInt32LE(pair.bytes, offset)
    header.writeUInt32LE(pair.samples, offset + 4)
    offset += 8
  }

  return Buffer.concat([header, oggBuf])
}

function generateDtaContent(shortname: string, metadata: ConMetadata): string {
  const name = String(metadata.name || 'Unknown Title').replace(/"/g, '\\"')
  const artist = String(metadata.artist || 'Unknown Artist').replace(/"/g, '\\"')
  const genre = String(metadata.genre || 'rock')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  const year = Number(metadata.year || new Date().getFullYear())
  const songId = Number(metadata.song_id) || getDeterministicSongId(shortname)

  const rankBand = tierToRank(metadata.diff_band)
  const rankGuitar = tierToRank(metadata.diff_guitar)
  const rankBass = tierToRank(metadata.diff_bass)
  const rankDrums = tierToRank(metadata.diff_drums)
  const rankVocals = tierToRank(metadata.diff_vocals)
  const rankKeys = tierToRank(metadata.diff_keys)

  const previewStart = Number(metadata.preview_start_time || 0)
  const previewEnd = previewStart + 30000

  return `(${shortname}
   (name "${name}")
   (artist "${artist}")
   (master TRUE)
   (song_id ${songId})
   (song
      (name "songs/${shortname}/${shortname}")
      (tracks
         ((guitar (0 1)))
      )
      (vols (0.0 0.0))
      (pans (-1.0 1.0))
   )
   (bank sfx/guitar_coop_bank.milo)
   (anim_tempo kTempoMedium)
   (preview ${previewStart} ${previewEnd})
   (rank
      (band ${rankBand})
      (guitar ${rankGuitar})
      (drum ${rankDrums})
      (bass ${rankBass})
      (vocals ${rankVocals})
      (keys ${rankKeys})
      (real_keys 0)
      (real_guitar 0)
      (real_bass 0)
   )
   (genre genre_${genre})
   (decades the${Math.floor(year / 10) * 10}s)
   (vocal_gender male)
   (format 10)
   (version 30)
   (game_origin ugc_plus)
   (rating 2)
)
`
}

export type BlockType = 'Data' | 'L0' | 'L1' | 'L2' | 'Dummy'

export interface BlockInfo {
  type: BlockType
  logicalIndex: number
}

export function getBlockPatternShift0(totalDataBlocks: number): BlockInfo[] {
  const pattern: BlockInfo[] = []
  let dataIndex = 0
  let l0Index = 0
  let l1Index = 0
  let l2Index = 0

  const pushL0 = (): void => {
    pattern.push({ type: 'L0', logicalIndex: l0Index++ })
    for (let i = 0; i < 170; i++) {
      pattern.push({ type: 'Data', logicalIndex: dataIndex++ })
    }
  }

  const pushL1First = (): void => {
    pushL0()
    pattern.push({ type: 'L1', logicalIndex: l1Index++ })
    for (let i = 0; i < 169; i++) {
      pushL0()
    }
  }

  const pushL1Later = (): void => {
    pattern.push({ type: 'L1', logicalIndex: l1Index++ })
    for (let i = 0; i < 170; i++) {
      pushL0()
    }
  }

  pushL1First()
  pattern.push({ type: 'L2', logicalIndex: l2Index++ })
  while (dataIndex < totalDataBlocks) {
    pushL1Later()
  }

  const lastDataPhysicalIndex = pattern.findIndex(
    (b) => b.type === 'Data' && b.logicalIndex === totalDataBlocks - 1
  )

  return pattern.slice(0, lastDataPhysicalIndex + 1)
}

function serializeFileEntry(
  name: string,
  isDirectory: boolean,
  isConsecutive: boolean,
  blocksCount: number,
  startBlock: number,
  parentIndex: number,
  fileSize: number
): Buffer {
  const buf = Buffer.alloc(64)

  const nameBuf = Buffer.from(name, 'ascii')
  nameBuf.copy(buf, 0, 0, Math.min(nameBuf.length, 40))

  const nameLen = Math.min(name.length, 40) & 0x3f
  let flags = nameLen
  if (isConsecutive) flags |= 0x40
  if (isDirectory) flags |= 0x80
  buf[0x28] = flags

  buf.writeUIntLE(blocksCount, 0x29, 3)
  buf.writeUIntLE(blocksCount, 0x2c, 3)
  buf.writeUIntLE(startBlock, 0x2f, 3)
  buf.writeUInt16BE(parentIndex, 0x32)
  buf.writeUInt32BE(fileSize, 0x34)

  const timestamp = 0x20006f2d
  buf.writeUInt32LE(timestamp, 0x38)
  buf.writeUInt32LE(timestamp, 0x3c)

  return buf
}

function writeUtf16BE(str: string, buffer: Buffer, offset: number, maxLengthBytes: number): void {
  const utf16le = Buffer.from(str, 'utf16le')
  const len = Math.min(utf16le.length, maxLengthBytes)
  const swapped = Buffer.alloc(maxLengthBytes)
  for (let i = 0; i < len; i += 2) {
    if (i + 1 < len) {
      swapped[i] = utf16le[i + 1]
      swapped[i + 1] = utf16le[i]
    }
  }
  swapped.copy(buffer, offset, 0, maxLengthBytes)
}

function calculateHashes(
  conBuffer: Buffer,
  pattern: BlockInfo[],
  headerSize: number,
  totalDataBlocks: number
): void {
  const numL0Tables = Math.ceil(totalDataBlocks / 170)
  for (let i = 0; i < numL0Tables; i++) {
    const l0PhysicalIndex = pattern.findIndex((b) => b.type === 'L0' && b.logicalIndex === i)
    if (l0PhysicalIndex === -1) continue
    const l0Offset = headerSize + l0PhysicalIndex * 0x1000

    for (let j = 0; j < 170; j++) {
      const logicalDataIndex = i * 170 + j
      if (logicalDataIndex >= totalDataBlocks) break

      const dataPhysicalIndex = pattern.findIndex(
        (b) => b.type === 'Data' && b.logicalIndex === logicalDataIndex
      )
      if (dataPhysicalIndex === -1) continue

      const dataOffset = headerSize + dataPhysicalIndex * 0x1000
      const dataBytes = conBuffer.subarray(dataOffset, dataOffset + 0x1000)

      const sha1 = crypto.createHash('sha1').update(dataBytes).digest()
      const recordOffset = l0Offset + j * 24
      sha1.copy(conBuffer, recordOffset, 0, 20)
    }
  }

  if (totalDataBlocks >= 170) {
    const numL1Tables = Math.ceil(numL0Tables / 170)
    for (let i = 0; i < numL1Tables; i++) {
      const l1PhysicalIndex = pattern.findIndex((b) => b.type === 'L1' && b.logicalIndex === i)
      if (l1PhysicalIndex === -1) continue
      const l1Offset = headerSize + l1PhysicalIndex * 0x1000

      const blocksCovered = Math.min(170 * 170, totalDataBlocks - 170 * 170 * i)
      conBuffer.writeUInt32BE(blocksCovered, l1Offset + 0xff0)

      for (let j = 0; j < 170; j++) {
        const l0Index = i * 170 + j
        if (l0Index >= numL0Tables) break

        const l0PhysicalIndex = pattern.findIndex(
          (b) => b.type === 'L0' && b.logicalIndex === l0Index
        )
        if (l0PhysicalIndex === -1) continue

        const l0OffsetReal = headerSize + l0PhysicalIndex * 0x1000
        const l0Bytes = conBuffer.subarray(l0OffsetReal, l0OffsetReal + 0x1000)

        const sha1 = crypto.createHash('sha1').update(l0Bytes).digest()
        const recordOffset = l1Offset + j * 24
        sha1.copy(conBuffer, recordOffset, 0, 20)
      }
    }
  }

  if (totalDataBlocks >= 170 * 170) {
    const numL2Tables = Math.ceil(numL0Tables / (170 * 170))
    for (let i = 0; i < numL2Tables; i++) {
      const l2PhysicalIndex = pattern.findIndex((b) => b.type === 'L2' && b.logicalIndex === i)
      if (l2PhysicalIndex === -1) continue
      const l2Offset = headerSize + l2PhysicalIndex * 0x1000

      conBuffer.writeUInt32BE(totalDataBlocks, l2Offset + 0xff0)

      for (let j = 0; j < 170; j++) {
        const l1Index = i * 170 + j
        const l1PhysicalIndex = pattern.findIndex(
          (b) => b.type === 'L1' && b.logicalIndex === l1Index
        )
        if (l1PhysicalIndex === -1) break

        const l1OffsetReal = headerSize + l1PhysicalIndex * 0x1000
        const l1Bytes = conBuffer.subarray(l1OffsetReal, l1OffsetReal + 0x1000)

        const sha1 = crypto.createHash('sha1').update(l1Bytes).digest()
        const recordOffset = l2Offset + j * 24
        sha1.copy(conBuffer, recordOffset, 0, 20)
      }
    }
  }
}

export async function packRb3con(
  songDir: string,
  metadata: ConMetadata,
  outputPath: string
): Promise<void> {
  if (!existsSync(songDir)) {
    throw new Error(`Song directory does not exist: ${songDir}`)
  }

  const nameStr = String(metadata.name || 'song')
  const shortname =
    nameStr
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .substring(0, 32) || 'song'

  const midiSourcePath = path.join(songDir, 'notes.mid')
  const oggSourcePath = path.join(songDir, 'song.ogg')

  if (!existsSync(midiSourcePath)) {
    throw new Error(`notes.mid is missing from song directory: ${songDir}`)
  }
  if (!existsSync(oggSourcePath)) {
    throw new Error(`song.ogg is missing from song directory: ${songDir}`)
  }

  const midiBuffer = await fs.readFile(midiSourcePath)
  const oggBuffer = await fs.readFile(oggSourcePath)
  const moggBuffer = oggToMogg(oggBuffer)
  const dtaContent = generateDtaContent(shortname, metadata)
  const dtaBuffer = Buffer.from(dtaContent, 'utf-8')

  const dtaBlocks = Math.ceil(dtaBuffer.length / 0x1000)
  const midiBlocks = Math.ceil(midiBuffer.length / 0x1000)
  const moggBlocks = Math.ceil(moggBuffer.length / 0x1000)

  const listBlocks = 1
  const startDta = listBlocks
  const startMidi = startDta + dtaBlocks
  const startMogg = startMidi + midiBlocks
  const totalDataBlocks = startMogg + moggBlocks

  const dirBlock = Buffer.alloc(0x1000)
  const entry0 = serializeFileEntry('songs', true, false, 0, 0, 0xffff, 0)
  const entry1 = serializeFileEntry(shortname, true, false, 0, 0, 0, 0)
  const entry2 = serializeFileEntry(
    'songs.dta',
    false,
    true,
    dtaBlocks,
    startDta,
    0,
    dtaBuffer.length
  )
  const entry3 = serializeFileEntry(
    `${shortname}.mid`,
    false,
    true,
    midiBlocks,
    startMidi,
    1,
    midiBuffer.length
  )
  const entry4 = serializeFileEntry(
    `${shortname}.mogg`,
    false,
    true,
    moggBlocks,
    startMogg,
    1,
    moggBuffer.length
  )
  const entryNull = Buffer.alloc(64)

  entry0.copy(dirBlock, 0 * 64)
  entry1.copy(dirBlock, 1 * 64)
  entry2.copy(dirBlock, 2 * 64)
  entry3.copy(dirBlock, 3 * 64)
  entry4.copy(dirBlock, 4 * 64)
  entryNull.copy(dirBlock, 5 * 64)

  let baseHeaderPath = path.join(__dirname, '..', '..', 'resources', 'rb3con_header.bin')
  if (!existsSync(baseHeaderPath)) {
    baseHeaderPath = path.join(__dirname, 'resources', 'rb3con_header.bin')
  }
  if (!existsSync(baseHeaderPath)) {
    throw new Error(`Base STFS header template not found at: ${baseHeaderPath}`)
  }

  const baseHeader = await fs.readFile(baseHeaderPath)
  const headerSize = 0xb000

  const pattern = getBlockPatternShift0(totalDataBlocks)
  const conBuffer = Buffer.alloc(headerSize + pattern.length * 0x1000)

  baseHeader.copy(conBuffer, 0, 0, headerSize)

  const volDescOffset = 0x22c + 0x14d
  conBuffer.writeUInt16LE(listBlocks, volDescOffset + 3)
  conBuffer.writeUIntLE(0, volDescOffset + 5, 3)
  conBuffer.writeUInt32BE(totalDataBlocks, volDescOffset + 28)

  const songTitle = String(metadata.name || 'song')
  const artist = String(metadata.artist || 'artist')

  for (let i = 0; i < 9; i++) {
    writeUtf16BE(songTitle, conBuffer, 0x411 + i * 0x100, 0x100)
  }
  for (let i = 0; i < 9; i++) {
    writeUtf16BE(
      `${artist} (${String(metadata.charter || 'Vitest')})`,
      conBuffer,
      0xd11 + i * 0x100,
      0x100
    )
  }
  writeUtf16BE('Rock Band 3', conBuffer, 0x1711, 0x100)

  const totalPhysicalBlocks = pattern.length
  conBuffer.writeBigInt64BE(BigInt(totalPhysicalBlocks * 0x1000), 0x22c + 0x120)

  const logicalNextBlocks: number[] = new Array(totalDataBlocks).fill(0xffffff)
  for (let i = 0; i < listBlocks - 1; i++) {
    logicalNextBlocks[i] = i + 1
  }
  for (let i = 0; i < dtaBlocks - 1; i++) {
    logicalNextBlocks[startDta + i] = startDta + i + 1
  }
  for (let i = 0; i < midiBlocks - 1; i++) {
    logicalNextBlocks[startMidi + i] = startMidi + i + 1
  }
  for (let i = 0; i < moggBlocks - 1; i++) {
    logicalNextBlocks[startMogg + i] = startMogg + i + 1
  }

  for (let n = 0; n < totalDataBlocks; n++) {
    const next = logicalNextBlocks[n]
    const l0Index = Math.floor(n / 170)
    const recordIndex = n % 170

    const l0PhysicalIndex = pattern.findIndex((b) => b.type === 'L0' && b.logicalIndex === l0Index)
    if (l0PhysicalIndex !== -1) {
      const l0Offset = headerSize + l0PhysicalIndex * 0x1000
      const recordOffset = l0Offset + recordIndex * 24
      conBuffer[recordOffset + 20] = 0x80
      conBuffer.writeUIntBE(next, recordOffset + 21, 3)
    }
  }

  const writeLogicalBlockData = (logicalIndex: number, data: Buffer): void => {
    const physicalIndex = pattern.findIndex(
      (b) => b.type === 'Data' && b.logicalIndex === logicalIndex
    )
    if (physicalIndex !== -1) {
      const offset = headerSize + physicalIndex * 0x1000
      data.copy(conBuffer, offset, 0, 0x1000)
    }
  }

  writeLogicalBlockData(0, dirBlock)

  for (let i = 0; i < dtaBlocks; i++) {
    const blockData = Buffer.alloc(0x1000)
    dtaBuffer.copy(blockData, 0, i * 0x1000, (i + 1) * 0x1000)
    writeLogicalBlockData(startDta + i, blockData)
  }

  for (let i = 0; i < midiBlocks; i++) {
    const blockData = Buffer.alloc(0x1000)
    midiBuffer.copy(blockData, 0, i * 0x1000, (i + 1) * 0x1000)
    writeLogicalBlockData(startMidi + i, blockData)
  }

  for (let i = 0; i < moggBlocks; i++) {
    const blockData = Buffer.alloc(0x1000)
    moggBuffer.copy(blockData, 0, i * 0x1000, (i + 1) * 0x1000)
    writeLogicalBlockData(startMogg + i, blockData)
  }

  calculateHashes(conBuffer, pattern, headerSize, totalDataBlocks)

  let topTablePhysicalIndex = 0
  if (totalDataBlocks < 170) {
    topTablePhysicalIndex = pattern.findIndex((b) => b.type === 'L0' && b.logicalIndex === 0)
  } else if (totalDataBlocks < 170 * 170) {
    topTablePhysicalIndex = pattern.findIndex((b) => b.type === 'L1' && b.logicalIndex === 0)
  } else {
    topTablePhysicalIndex = pattern.findIndex((b) => b.type === 'L2' && b.logicalIndex === 0)
  }

  if (topTablePhysicalIndex !== -1) {
    const topTableOffset = headerSize + topTablePhysicalIndex * 0x1000
    const topTableBytes = conBuffer.subarray(topTableOffset, topTableOffset + 0x1000)
    const topTableHash = crypto.createHash('sha1').update(topTableBytes).digest()
    topTableHash.copy(conBuffer, volDescOffset + 8, 0, 20)
  }

  const headerSha1Offset = 0x22c + 0x100
  conBuffer.fill(0, headerSha1Offset, headerSha1Offset + 20)

  const headerBytesToHash = conBuffer.subarray(0x344, headerSize)
  const headerHash = crypto.createHash('sha1').update(headerBytesToHash).digest()
  headerHash.copy(conBuffer, headerSha1Offset, 0, 20)

  const parentOutputDir = path.dirname(outputPath)
  await fs.mkdir(parentOutputDir, { recursive: true })
  await fs.writeFile(outputPath, conBuffer)
}
