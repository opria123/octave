import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const mockedRb3con = vi.hoisted(() => ({ entries: {} as Record<string, Buffer> }))

vi.mock('./conImporter', () => ({
  StfsParser: class {
    parse(): { entries: Record<string, Buffer> } {
      return { entries: mockedRb3con.entries }
    }
  }
}))

vi.mock('./dtaParser', () => ({
  parseDta: () => ({ mockSong: { shortname: 'mock-song', name: 'Mock Song' } })
}))

vi.mock('./moggDecrypt', () => ({
  decryptMoggBuffer: () => Buffer.from('OggS mocked audio')
}))

import { packageEntryIdentity } from './packageSourceIdentity'
import {
  buildSongSourceCatalog,
  buildSongSourceCatalogAudioEnrichmentRevision
} from './sngTrainingExporter'

const scratch = await mkdtemp(join(tmpdir(), 'octave-rb3con-audio-enrichment-test-'))

function validMidi(): Buffer {
  const name = Buffer.from('PART GUITAR')
  const events = Buffer.concat([
    Buffer.from([0x00, 0xff, 0x03, name.length]),
    name,
    Buffer.from([0x00, 0x90, 0x60, 0x40, 0x83, 0x60, 0x80, 0x60, 0x00, 0x00, 0xff, 0x2f, 0x00])
  ])
  const header = Buffer.from([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0
  ])
  const track = Buffer.alloc(8 + events.length)
  track.write('MTrk', 0)
  track.writeUInt32BE(events.length, 4)
  events.copy(track, 8)
  return Buffer.concat([header, track])
}

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('RB3CON audio-enrichment ambiguity', () => {
  it('rejects ambiguous MOGGs before publishing a reviewed audio revision', async () => {
    const parentDir = join(scratch, 'catalogs')
    const librarySong = join(scratch, 'library-song')
    const packagePath = join(scratch, 'private-source.rb3con')
    const midi = validMidi()
    await mkdir(parentDir, { recursive: true })
    await mkdir(librarySong, { recursive: true })
    await writeFile(join(librarySong, 'notes.mid'), midi)
    await writeFile(join(librarySong, 'song.ini'), '[song]\ndataset_opt_in = true\n')
    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: librarySong }],
      parentDir,
      catalogName: 'base',
      catalogId: 'base',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    await writeFile(packagePath, 'mock RB3CON bytes')
    const containerSha256 = createHash('sha256').update('mock RB3CON bytes').digest('hex')
    const midiSha256 = createHash('sha256').update(midi).digest('hex')
    mockedRb3con.entries = {
      'songs/songs.dta': Buffer.from('mock DTA'),
      'songs/mock-song/mock-song.mid': midi,
      'songs/mock-song/mock-song.mogg': Buffer.from('first MOGG'),
      'backup/mock-song.mogg': Buffer.from('second MOGG')
    }

    await expect(
      buildSongSourceCatalogAudioEnrichmentRevision({
        source: {
          kind: 'rb3con',
          sourcePath: packagePath,
          entryId: packageEntryIdentity('rb3con', containerSha256, 'mock-song', midiSha256),
          packageReview: { containerSha256, midiSha256, entryLocator: 'mock-song' }
        },
        parentDir,
        catalogName: 'ambiguous-audio-revision',
        catalogId: 'ambiguous-audio-revision',
        sourceCatalogName: 'base',
        octaveVersion: 'test'
      })
    ).rejects.toThrow('Reviewed package changed')
    expect(existsSync(join(parentDir, 'ambiguous-audio-revision'))).toBe(false)
  })
})
