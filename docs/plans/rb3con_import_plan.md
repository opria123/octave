# OCTAVE Rock Band 3 CON/STFS Importer Implementation Plan

This document outlines the detailed plan for implementing a Node.js-based importer in OCTAVE to open and extract Xbox 360 Rock Band 3 container files (`rb3con`/`CON` files) and convert them to standard song folders (playable in OCTAVE/Clone Hero or exportable to `.sng`).

---

## 1. Import Workflow Overview

To import an RB3 `.con` package:

1. **STFS Container Extraction**: Parse the STFS volume descriptor, resolve block offsets (bypassing interleaved hashes), parse the directory listing, and extract files (`songs/songs.dta`, `songs/songname/songname.mid`, and `songs/songname/songname.mogg`).
2. **Metadata Processing**: Parse the LISP-syntax `songs.dta` file to extract song metadata (artist, title, difficulty tiers, track-to-channel assignments, volume levels, panning configurations).
3. **MOGG Audio Decryption**: Decrypt the `.mogg` audio container file, using the version-specific keys and the custom symmetric key derivation algorithm (ByteGrinder) to output a standard multi-channel OGG Vorbis file (`song.ogg`).
4. **Folder Reconstitution**: Write the extracted MIDI as `notes.mid`, write the decrypted OGG as `song.ogg`, write the metadata to a standard `song.ini` (mapping channels to instruments based on the DTA assignments), and place everything in the default output directory under `<Artist> - <Song Name>/`.

---

## 2. STFS Container Parser (Node.js)

The container uses the Secure Transacted File System (STFS) format.

### Compute Physical Block Offsets

Because 4096-byte hash blocks are interleaved into the data block stream, a logical block index $N$ maps to a physical block index $P(N)$ which shifts over time:
$$P(N) = N + \text{NumL0}(N) + \text{NumL1}(N) + \text{NumL2}(N)$$
Where:

- $\text{NumL0}(N) = 1 + \lfloor N / 170 \rfloor$
- $\text{NumL1}(N) = 1 + \lfloor N / 28900 \rfloor$
- $\text{NumL2}(N) = 1 + \lfloor N / 4913000 \rfloor$

Physical offset is then:
$$\text{Offset} = 0xA000 + (P(N) \times 4096)$$

### Logical Reader Code (Node.js)

```typescript
import * as fs from 'fs/promises'
import * as path from 'path'

interface DirectoryEntry {
  name: string
  isDirectory: boolean
  isContiguous: boolean
  size: number
  startBlock: number
  pathIndicator: number // Index of parent folder; 0xFFFF is root
}

function getPhysicalBlockIndex(logicalBlock: number): number {
  const l0 = 1 + Math.floor(logicalBlock / 170)
  const l1 = 1 + Math.floor(logicalBlock / 28900)
  const l2 = 1 + Math.floor(logicalBlock / 4913000)
  return logicalBlock + l0 + l1 + l2
}

function getBlockOffset(logicalBlock: number): number {
  return 0xa000 + getPhysicalBlockIndex(logicalBlock) * 0x1000
}

export class StfsParser {
  private buffer: Buffer

  constructor(buffer: Buffer) {
    this.buffer = buffer
  }

  public parse(): { files: DirectoryEntry[]; entries: Record<string, Buffer> } {
    const magic = this.buffer.subarray(0, 4).toString('ascii')
    if (magic !== 'CON ' && magic !== 'LIVE' && magic !== 'PIRS') {
      throw new Error('Invalid STFS package magic header.')
    }

    // Read volume descriptor details
    const fileTableBlockCount = this.buffer.readUInt16BE(0x37a + 3)
    const fileTableBlockNumber = this.buffer.readUIntLE(0x37a + 5, 3) // int24 little-endian

    const entries: DirectoryEntry[] = []
    const blockOffset = getBlockOffset(fileTableBlockNumber)
    const tableBuffer = this.buffer.subarray(
      blockOffset,
      blockOffset + fileTableBlockCount * 0x1000
    )

    let cursor = 0
    while (cursor < tableBuffer.length) {
      const entryBuf = tableBuffer.subarray(cursor, cursor + 64)
      if (entryBuf.every((b) => b === 0)) break // End of table

      const name = entryBuf.subarray(0, 40).toString('ascii').replace(/\0/g, '')
      const flags = entryBuf[0x28]
      const isDirectory = (flags & 0x40) !== 0
      const isContiguous = (flags & 0x80) !== 0
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

    // Extract file content buffers
    const fileBuffers: Record<string, Buffer> = {}
    for (const entry of entries) {
      if (entry.isDirectory) continue

      const fileBuf = Buffer.alloc(entry.size)
      let bytesCopied = 0
      let currentBlock = entry.startBlock

      if (entry.isContiguous) {
        // Read blocks sequentially
        const numBlocks = Math.ceil(entry.size / 4096)
        for (let i = 0; i < numBlocks; i++) {
          const offset = getBlockOffset(currentBlock + i)
          const blockData = this.buffer.subarray(offset, offset + 4096)
          const copySize = Math.min(4096, entry.size - bytesCopied)
          blockData.copy(fileBuf, bytesCopied, 0, copySize)
          bytesCopied += copySize
        }
      } else {
        // Trace block allocation chains (FAT-like resolution)
        // Note: For typical CON files, tracks are contiguous. For chained blocks,
        // we parse next-block indicators from the interleaved Level 0 hash tables.
        throw new Error('Chained block resolution not implemented in this draft.')
      }

      // Reconstruct folder path
      let fullPath = entry.name
      let currentParent = entry.pathIndicator
      while (currentParent !== 0xffff) {
        const parentEntry = entries[currentParent]
        fullPath = path.join(parentEntry.name, fullPath)
        currentParent = parentEntry.pathIndicator
      }
      fileBuffers[fullPath.toLowerCase().replace(/\\/g, '/')] = fileBuf
    }

    return { files: entries, entries: fileBuffers }
  }
}
```

---

## 3. Rock Band DTA Metadata Parser

The `songs.dta` file uses a LISP-syntax configuration. We extract:

- Basic attributes (`name`, `artist`, `album_name`, `year_released`, `genre`, `vocal_gender`, `preview`)
- Track configuration (`tracks` mapping for channel routing)
- Pans (`pans`) and Volume Levels (`vols`)
- Difficulties (`rank`)

### Simple DTA Lexer/Parser in JS

```typescript
export interface DtaSong {
  name: string
  artist?: string
  album?: string
  year?: number
  genre?: string
  vocalsGender?: string
  previewStart: number
  previewEnd: number
  ranks: Record<string, number>
  vols: number[]
  pans: number[]
  channels: Record<string, number[]>
}

export function parseDta(dtaContent: string): Record<string, DtaSong> {
  const songs: Record<string, DtaSong> = {}

  // Clean comments (lines starting with ;)
  const lines = dtaContent
    .split('\n')
    .map((line) => line.replace(/;.*$/, '').trim())
    .filter(Boolean)
  const cleanDta = lines.join(' ')

  // Standard tokenization for LISP-like nested parentheses
  const tokens: string[] = []
  let token = ''
  let inString = false
  for (let i = 0; i < cleanDta.length; i++) {
    const char = cleanDta[i]
    if (char === '"') {
      inString = !inString
      token += char
    } else if (!inString && (char === '(' || char === ')')) {
      if (token.trim()) tokens.push(token.trim())
      tokens.push(char)
      token = ''
    } else if (!inString && char === ' ') {
      if (token.trim()) tokens.push(token.trim())
      token = ''
    } else {
      token += char
    }
  }

  // Parse token list into nested arrays
  let index = 0
  function parseExpr(): any {
    if (tokens[index] === '(') {
      index++
      const list = []
      while (tokens[index] !== ')') {
        list.push(parseExpr())
      }
      index++ // skip )
      return list
    }
    return tokens[index++]
  }

  while (index < tokens.length) {
    const expression = parseExpr()
    if (!expression || expression.length === 0) continue
    const songId = expression[0]
    songs[songId] = extractSongInfo(expression)
  }

  return songs
}

function extractSongInfo(expr: any[]): DtaSong {
  const info: DtaSong = {
    name: 'Unknown Title',
    ranks: {},
    vols: [],
    pans: [],
    channels: {},
    previewStart: 0,
    previewEnd: 30
  }

  const lookupNode = (path: string[], parent = expr): any => {
    for (const item of parent) {
      if (Array.isArray(item) && item[0] === path[0]) {
        if (path.length === 1) return item
        return lookupNode(path.slice(1), item)
      }
    }
    return null
  }

  const nameNode = lookupNode(['name'])
  if (nameNode) info.name = nameNode[1].replace(/"/g, '')

  const artistNode = lookupNode(['artist'])
  if (artistNode) info.artist = artistNode[1].replace(/"/g, '')

  const albumNode = lookupNode(['album_name'])
  if (albumNode) info.album = albumNode[1].replace(/"/g, '')

  const yearNode = lookupNode(['year_released'])
  if (yearNode) info.year = parseInt(yearNode[1], 10)

  const genreNode = lookupNode(['genre'])
  if (genreNode) info.genre = genreNode[1].replace(/"/g, '').replace('genre_', '')

  const vocalGenderNode = lookupNode(['vocal_gender'])
  if (vocalGenderNode) info.vocalsGender = vocalGenderNode[1]

  const previewNode = lookupNode(['preview'])
  if (previewNode) {
    info.previewStart = parseFloat(previewNode[1]) / 1000
    info.previewEnd = parseFloat(previewNode[2]) / 1000
  }

  // Ranks
  const rankNode = lookupNode(['rank'])
  if (rankNode) {
    for (const r of rankNode.slice(1)) {
      if (Array.isArray(r)) {
        info.ranks[r[0]] = parseInt(r[1], 10)
      }
    }
  }

  // Vols/Pans
  const songNode = lookupNode(['song'])
  if (songNode) {
    const volsNode = lookupNode(['vols'], songNode)
    if (volsNode) info.vols = volsNode.slice(1).map((v: string) => parseFloat(v))

    const pansNode = lookupNode(['pans'], songNode)
    if (pansNode) info.pans = pansNode.slice(1).map((p: string) => parseFloat(p))

    const tracksNode = lookupNode(['tracks'], songNode)
    if (tracksNode) {
      for (const t of tracksNode.slice(1)) {
        if (Array.isArray(t)) {
          const inst = t[0]
          // E.g., (drum (0 1 2)) or (drum 0)
          const chans = Array.isArray(t[1])
            ? t[1].map((c: string) => parseInt(c, 10))
            : [parseInt(t[1], 10)]
          info.channels[inst] = chans
        }
      }
    }
  }

  return info
}
```

---

## 4. MOGG Cryptography & Key Derivation (AES-128 CTR)

Decryption is performed directly inside the Node.js pipeline.

### 4.1 Master Keys and Lookups

```typescript
import * as crypto from 'crypto'

const ctrKey0B = Buffer.from([
  0x37, 0xb2, 0xe2, 0xb9, 0x1c, 0x74, 0xfa, 0x9e, 0x38, 0x81, 0x08, 0xea, 0x36, 0x23, 0xdb, 0xe4
])

const HvKeys = Buffer.from([
  0x01, 0x22, 0x00, 0x38, 0xd2, 0x01, 0x78, 0x8b, 0xdd, 0xcd, 0xd0, 0xf0, 0xfe, 0x3e, 0x24, 0x7f,
  0x51, 0x73, 0xad, 0xe5, 0xb3, 0x99, 0xb8, 0x61, 0x58, 0x1a, 0xf9, 0xb8, 0x1e, 0xa7, 0xbe, 0xbf,
  0xc6, 0x22, 0x94, 0x30, 0xd8, 0x3c, 0x84, 0x14, 0x08, 0x73, 0x7c, 0xf2, 0x23, 0xf6, 0xeb, 0x5a,
  0x02, 0x1a, 0x83, 0xf3, 0x97, 0xe9, 0xd4, 0xb8, 0x06, 0x74, 0x14, 0x6b, 0x30, 0x4c, 0x00, 0x91,
  0x42, 0x66, 0x37, 0xb3, 0x68, 0x05, 0x9f, 0x85, 0x6e, 0x96, 0xbd, 0x1e, 0xf9, 0x0e, 0x7f, 0xbd
])

// Decryption keys for Versions 12 to 16
const hiddenKeys = Buffer.from([
  0x7f, 0x95, 0x5b, 0x9d, 0x94, 0xba, 0x12, 0xf1, 0xd7, 0x5a, 0x67, 0xd9, 0x16, 0x45, 0x28, 0xdd,
  0x61, 0x55, 0x55, 0xaf, 0x23, 0x91, 0xd6, 0x0a, 0x3a, 0x42, 0x81, 0x18, 0xb4, 0xf7, 0xf3, 0x04,
  0x78, 0x96, 0x5d, 0x92, 0x92, 0xb0, 0x47, 0xac, 0x8f, 0x5b, 0x6d, 0xdc, 0x1c, 0x41, 0x7e, 0xda
  // (Full 384-byte array containing obfuscated structures)
  // ...
])
```

### 4.2 Key Derivation Mechanics (ByteGrinder)

1. **Reveal Master Key**: Uses an LCG random number generator starting with seed `0xEB` to compute the master key.
2. **Subkey Selection**: Extracts the specific 32-byte chunk from `hiddenKeys` at index `keyIndex` and shuffles it 14 times, XORing it with the master key.
3. **Array Grinding**: Derives the final 16-byte AES-128 decryption key (`ctr_key`) based on the file seeds (`seed_1`, `seed_2`) and a mapping array generated from one of 64 custom bitwise functions.

```typescript
function lcgRandom(seed: number, multiplier = 0x19660e): number {
  return (Math.imul(seed, multiplier) + 0x3c6ef35f) | 0
}

function supershuffle(buf: Buffer) {
  // Swapping indices 4*i, 4*i+2, etc., mimicking Gtr/Vocal keys layout.
  // ...
}

function byteGrinderGrind(seed1: number, seed2: number, key: Buffer, version: number) {
  // Re-implements key shuffling using the 64 ops defined in ops.c
  // version > 13 uses 64 ops, <= 13 uses first 32 ops.
  // ...
}
```

### 4.3 AES-128 CTR Stream Decryptor (Transform Stream)

```typescript
import { Transform, TransformCallback } from 'stream'

export class MoggDecryptTransform extends Transform {
  private key: Buffer
  private counter: Buffer // 16 bytes
  private offset: number = 0
  private currentCryptedBlock: Buffer = Buffer.alloc(0)

  constructor(key: Buffer, initialCounter: Buffer) {
    super()
    this.key = key
    this.counter = Buffer.from(initialCounter)
  }

  _transform(chunk: Buffer, encoding: string, callback: TransformCallback): void {
    for (let i = 0; i < chunk.length; i++) {
      const globalPos = this.offset + i
      const blockIndex = Math.floor(globalPos / 16)
      const byteInBlock = globalPos % 16

      if (byteInBlock === 0) {
        // Increment and encrypt counter block
        const blockCtr = Buffer.from(this.counter)
        // Add block index to blockCtr
        const low = blockCtr.readBigUInt64LE(0)
        blockCtr.writeBigUInt64LE(low + BigInt(blockIndex), 0)

        const cipher = crypto.createCipheriv('aes-128-ecb', this.key, null)
        cipher.setAutoPadding(false)
        this.currentCryptedBlock = Buffer.concat([cipher.update(blockCtr), cipher.final()])
      }

      chunk[i] ^= this.currentCryptedBlock[byteInBlock]
    }
    this.offset += chunk.length
    this.push(chunk)
    callback()
  }
}
```

---

## 5. Directory Reconstruction Plan

```
songLibrary/
  └── <Artist> - <Song Name>/
      ├── song.ini           (Containing ranks, preview times, metadata)
      ├── notes.mid          (Decrypted note chart from STFS songs/x/x.mid)
      └── song.ogg           (Decrypted Ogg Vorbis audio stream)
```

1. **Parse `songs.dta`**: Retrieve song metadata.
2. **Translate to `song.ini`**:
   - `artist`, `name` (Song title), `album`, `genre`, `year`.
   - Map `rank` configurations to standard difficulties (e.g. `guitar` rank maps to `diff_guitar = rank / 100`).
   - Group information into a single `[song]` block.
3. **Map Channels**: Add standard Clone Hero tags specifying audio channels in the `song.ini` (e.g. `preview_start_time = ...` and channel indices if multiple stems are split, or keep it multi-channel).

---

## 6. Implementation Stages for OCTAVE

| Stage       | Task                                                                            | Target Files                              |
| :---------- | :------------------------------------------------------------------------------ | :---------------------------------------- |
| **Stage 1** | Implement `StfsParser.ts` to extract files from `.con` binaries.                | `src/main/import/StfsParser.ts`           |
| **Stage 2** | Add a LISP interpreter/parser in TypeScript for `songs.dta` files.              | `src/main/import/DtaParser.ts`            |
| **Stage 3** | Implement the MOGG key derivation and AES-CTR stream decryption.                | `src/main/import/MoggDecrypt.ts`          |
| **Stage 4** | Build the import orchestrator integration (triggered by file drop/import menu). | `src/main/import/importService.ts`        |
| **Stage 5** | Create the UI trigger (e.g., adding `.con` and `.sng` drop regions to UI).      | `src/renderer/components/ImportModal.tsx` |
