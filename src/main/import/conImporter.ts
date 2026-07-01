import { promises as fs, existsSync } from 'fs'
import * as path from 'path'
import { parseDta } from './dtaParser'
import { decryptMoggBuffer } from './moggDecrypt'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

interface DirectoryEntry {
  name: string
  isDirectory: boolean
  isContiguous: boolean
  size: number
  startBlock: number
  pathIndicator: number
}

interface BlockHashRecord {
  status: number
  nextBlock: number
}

function fixBlockNumber(logicalBlock: number, isShift1: boolean): number {
  const tss = isShift1 ? 1 : 0
  let adjustment = 0
  if (logicalBlock >= 0xaa) {
    adjustment += (Math.floor(logicalBlock / 0xaa) + 1) << tss
  }
  if (logicalBlock >= 0x70e4) {
    adjustment += (Math.floor(logicalBlock / 0x70e4) + 1) << tss
  }
  return logicalBlock + adjustment
}

function getBlockOffset(logicalBlock: number, isShift1: boolean): number {
  return 0xc000 + fixBlockNumber(logicalBlock, isShift1) * 0x1000
}

function getBlockHashRecord(
  buffer: Buffer,
  logicalBlock: number,
  isShift1: boolean
): BlockHashRecord {
  const tssNum = isShift1 ? 1 : 0
  const spacing = isShift1 ? 0xac : 0xab

  const getRecord = (tableOffset: number): BlockHashRecord => {
    const recordIndex = logicalBlock % 0xaa
    let tablenum = Math.floor(logicalBlock / 0xaa) * spacing

    if (logicalBlock >= 0xaa) {
      tablenum += (Math.floor(logicalBlock / 0x70e4) + 1) << tssNum
    }
    if (logicalBlock >= 0x70e4) {
      tablenum += 1 << tssNum
    }

    tablenum += tableOffset - (1 << tssNum)

    const tableOffsetBytes = 0xc000 + tablenum * 0x1000
    const recordOffset = tableOffsetBytes + recordIndex * 24

    const status = buffer.readUInt8(recordOffset + 20)
    const nextBlock = buffer.readUIntBE(recordOffset + 21, 3)

    return { status, nextBlock }
  }

  const hsh = getRecord(0)
  if (isShift1 && hsh.status < 0x80) {
    return getRecord(1)
  }
  return hsh
}

function readFileBlocks(
  buffer: Buffer,
  startBlock: number,
  sizeBytes: number,
  isContiguous: boolean,
  isShift1: boolean,
  totalBlocks: number
): Buffer {
  const numBlocks = Math.ceil(sizeBytes / 4096)
  const blocks: Buffer[] = []
  let currentBlock = startBlock
  let bytesCopied = 0

  for (let i = 0; i < numBlocks; i++) {
    const activeBlock = isContiguous ? startBlock + i : currentBlock
    if (activeBlock < 0 || activeBlock >= totalBlocks) {
      break
    }
    const offset = getBlockOffset(activeBlock, isShift1)
    if (offset + 4096 > buffer.length) {
      break
    }
    const blockData = buffer.subarray(offset, offset + 4096)
    const copySize = Math.min(4096, sizeBytes - bytesCopied)

    const chunk = Buffer.alloc(copySize)
    blockData.copy(chunk, 0, 0, copySize)
    blocks.push(chunk)
    bytesCopied += copySize

    if (!isContiguous) {
      const hashRecord = getBlockHashRecord(buffer, currentBlock, isShift1)
      currentBlock = hashRecord.nextBlock
    }
  }

  return Buffer.concat(blocks)
}

export class StfsParser {
  private buffer: Buffer

  constructor(buffer: Buffer) {
    this.buffer = buffer
  }

  public parse(): { files: DirectoryEntry[]; entries: Record<string, Buffer> } {
    const magic = this.buffer.subarray(0, 4).toString('ascii')
    if (magic !== 'CON ' && magic !== 'LIVE' && magic !== 'PIRS') {
      throw new Error(`Invalid STFS package magic header: "${magic}".`)
    }

    const metadataOffset = magic === 'CON ' ? 0x22c : 0x104
    const volDescOffset = metadataOffset + 0x14d

    const fileTableBlockCount = this.buffer.readUInt16LE(volDescOffset + 3)
    const fileTableBlockNumber = this.buffer.readUIntLE(volDescOffset + 5, 3)

    // Read headerSize to determine table size shift
    const headerSize = this.buffer.readUInt32BE(metadataOffset + 0x114) // md_HeaderSize
    const shiftValue = ((headerSize + 0xfff) & 0xf000) >>> 12
    const isShift1 = shiftValue !== 0xb

    // Read total blocks
    const totalBlocks = this.buffer.readUInt32BE(volDescOffset + 28) // sd_TotalAllocatedBlockCount
    console.log(
      'STFS Metadata - HeaderSize:',
      headerSize,
      'isShift1:',
      isShift1,
      'TotalBlocks:',
      totalBlocks
    )

    const entries: DirectoryEntry[] = []
    // The directory file table is read via chained block traversal
    const tableBuffer = readFileBlocks(
      this.buffer,
      fileTableBlockNumber,
      fileTableBlockCount * 0x1000,
      false,
      isShift1,
      totalBlocks
    )
    console.log('STFS Directory Table Buffer Length:', tableBuffer.length)

    let cursor = 0
    while (cursor < tableBuffer.length) {
      const entryBuf = tableBuffer.subarray(cursor, cursor + 64)
      if (entryBuf.every((b) => b === 0)) break // End of table

      const name = entryBuf.subarray(0, 40).toString('ascii').replace(/\0/g, '').trim()
      const flags = entryBuf[0x28]
      const isContiguous = (flags & 0x40) !== 0
      const isDirectory = (flags & 0x80) !== 0
      const startBlock = entryBuf.readUIntLE(0x2f, 3)
      const pathIndicator = entryBuf.readUInt16BE(0x32)
      const size = entryBuf.readUInt32BE(0x34)

      entries.push({
        name,
        isDirectory,
        isContiguous,
        size,
        startBlock,
        pathIndicator
      })

      cursor += 64
    }

    const fileBuffers: Record<string, Buffer> = {}
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (entry.isDirectory || entry.size === 0) continue

      const fileBuf = readFileBlocks(
        this.buffer,
        entry.startBlock,
        entry.size,
        entry.isContiguous,
        isShift1,
        totalBlocks
      )

      let fullPath = entry.name
      let currentParent = entry.pathIndicator
      while (currentParent !== 0xffff) {
        const parentEntry = entries[currentParent]
        if (!parentEntry) break
        fullPath = path.join(parentEntry.name, fullPath)
        currentParent = parentEntry.pathIndicator
      }
      fileBuffers[fullPath.toLowerCase().replace(/\\/g, '/')] = fileBuf
    }

    return { files: entries, entries: fileBuffers }
  }
}

function findFileCaseInsensitive(
  entries: Record<string, Buffer>,
  targetPath: string
): Buffer | null {
  const normTarget = targetPath.toLowerCase().replace(/\\/g, '/')
  for (const [key, value] of Object.entries(entries)) {
    const normKey = key.toLowerCase().replace(/\\/g, '/')
    if (normKey === normTarget || normKey.endsWith('/' + normTarget)) {
      return value
    }
  }
  return null
}

function findExtensionFile(
  entries: Record<string, Buffer>,
  shortname: string,
  ext: string
): Buffer | null {
  const targetEnd = `${shortname.toLowerCase()}.${ext.toLowerCase()}`
  for (const [key, value] of Object.entries(entries)) {
    const normKey = key.toLowerCase().replace(/\\/g, '/')
    if (normKey.endsWith(targetEnd)) {
      return value
    }
  }
  for (const [key, value] of Object.entries(entries)) {
    const normKey = key.toLowerCase().replace(/\\/g, '/')
    if (normKey.endsWith('.' + ext.toLowerCase())) {
      return value
    }
  }
  return null
}

function rankToTier(rank: number | undefined): number {
  if (!rank || rank <= 0) return 0
  if (rank < 150) return 1
  if (rank < 250) return 2
  if (rank < 350) return 3
  if (rank < 450) return 4
  if (rank < 550) return 5
  return 6
}

function sanitizeDirName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim()
}

export async function importCon(conFilePath: string, libraryDir: string): Promise<string[]> {
  const buffer = await fs.readFile(conFilePath)
  const parser = new StfsParser(buffer)
  const { entries } = parser.parse()

  const dtaContent = findFileCaseInsensitive(entries, 'songs/songs.dta')
  if (!dtaContent) {
    throw new Error('Could not find songs.dta in the STFS container.')
  }

  const songs = parseDta(dtaContent.toString('latin1'))
  const importedDirs: string[] = []

  for (const [shortname, song] of Object.entries(songs)) {
    const midiBuffer = findExtensionFile(entries, shortname, 'mid')
    const moggBuffer = findExtensionFile(entries, shortname, 'mogg')

    if (!midiBuffer) {
      throw new Error(`MIDI file not found for song: ${shortname}`)
    }
    if (!moggBuffer) {
      throw new Error(`MOGG file not found for song: ${shortname}`)
    }

    const folderName = sanitizeDirName(`${song.artist || 'Unknown Artist'} - ${song.name}`)
    const songDir = path.join(libraryDir, folderName)
    await fs.mkdir(songDir, { recursive: true })

    await fs.writeFile(path.join(songDir, 'notes.mid'), midiBuffer)

    const decryptedOgg = decryptMoggBuffer(moggBuffer)
    const oggPath = path.join(songDir, 'song.ogg')
    await fs.writeFile(oggPath, decryptedOgg)

    const numChannels = decryptedOgg.readUInt8(39)
    if (numChannels > 2) {
      try {
        const tempOgg = path.join(songDir, 'song_temp.ogg')
        await fs.rename(oggPath, tempOgg)

        let leftFilter = ''
        let rightFilter = ''
        for (let c = 0; c < numChannels; c++) {
          if (c % 2 === 0) {
            leftFilter += (leftFilter ? '+' : '') + `c${c}`
          } else {
            rightFilter += (rightFilter ? '+' : '') + `c${c}`
          }
        }
        const filterStr = `pan=stereo|c0=${leftFilter}|c1=${rightFilter}`

        let ffmpegPath = 'ffmpeg'
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const staticPath = require('ffmpeg-static') as string | null
          if (staticPath) {
            let resolved = staticPath
            const pathSep = path.sep
            if (resolved.includes(`app.asar${pathSep}`)) {
              resolved = resolved.replace(`app.asar${pathSep}`, `app.asar.unpacked${pathSep}`)
            }
            if (existsSync(resolved)) {
              ffmpegPath = resolved
            }
          }
        } catch {
          // Fallback to global ffmpeg
        }

        await execAsync(`"${ffmpegPath}" -y -i "${tempOgg}" -af "${filterStr}" "${oggPath}"`)
        await fs.unlink(tempOgg)
        console.log(
          `[Importer] Successfully downmixed multitrack song.ogg (${numChannels} channels) to stereo using ffmpeg`
        )
      } catch (err) {
        console.warn(
          '[Importer] Failed to downmix multitrack song.ogg using ffmpeg, keeping original multitrack file:',
          err
        )
        const tempOgg = path.join(songDir, 'song_temp.ogg')
        try {
          const tempExists = await fs
            .stat(tempOgg)
            .then(() => true)
            .catch(() => false)
          if (tempExists) {
            await fs.rename(tempOgg, oggPath)
          }
        } catch (restoreErr) {
          console.error('[Importer] Failed to restore original multitrack song.ogg:', restoreErr)
        }
      }
    }

    const allAssignedChans = new Set<number>()
    for (const chans of Object.values(song.channels)) {
      for (const c of chans) {
        allAssignedChans.add(c)
      }
    }
    const totalChans = song.vols.length
    const backingChans: number[] = []
    for (let c = 0; c < totalChans; c++) {
      if (!allAssignedChans.has(c)) {
        backingChans.push(c)
      }
    }

    let ini = '[song]\n'
    ini += `name = ${song.name}\n`
    if (song.artist) ini += `artist = ${song.artist}\n`
    if (song.album) ini += `album = ${song.album}\n`
    if (song.genre) ini += `genre = ${song.genre}\n`
    if (song.year) ini += `year = ${song.year}\n`
    ini += `charter = C3\n`
    ini += `preview_start_time = ${Math.round(song.previewStart * 1000)}\n`
    ini += `diff_band = ${rankToTier(song.ranks.band)}\n`
    ini += `diff_guitar = ${rankToTier(song.ranks.guitar)}\n`
    ini += `diff_bass = ${rankToTier(song.ranks.bass)}\n`
    ini += `diff_drums = ${rankToTier(song.ranks.drum)}\n`
    ini += `diff_vocals = ${rankToTier(song.ranks.vocals)}\n`
    ini += `diff_keys = ${rankToTier(song.ranks.keys || song.ranks.real_keys)}\n`

    if (song.channels.guitar) {
      ini += `guitar_track_chans = ${song.channels.guitar.join(' ')}\n`
    }
    if (song.channels.bass) {
      ini += `bass_track_chans = ${song.channels.bass.join(' ')}\n`
    }
    if (song.channels.drum) {
      ini += `drums_track_chans = ${song.channels.drum.join(' ')}\n`
    }
    if (song.channels.vocals) {
      ini += `vocals_track_chans = ${song.channels.vocals.join(' ')}\n`
    }
    if (song.channels.keys || song.channels.real_keys) {
      const kchans = song.channels.keys || song.channels.real_keys
      ini += `keys_track_chans = ${kchans.join(' ')}\n`
    }
    if (backingChans.length > 0) {
      ini += `song_track_chans = ${backingChans.join(' ')}\n`
    }

    await fs.writeFile(path.join(songDir, 'song.ini'), ini, 'utf-8')
    importedDirs.push(songDir)
  }

  return importedDirs
}
