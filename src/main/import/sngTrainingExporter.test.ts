import { createHash } from 'crypto'
import { existsSync } from 'fs'
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile
} from 'fs/promises'
import { hostname } from 'os'
import { join } from 'path'
import AdmZip from 'adm-zip'
import { type SngHeader } from 'parse-sng'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { packRb3con } from '../conPacker'
import { packSng } from '../sngPacker'
import {
  buildSongSourceCatalogAudioEnrichmentRevision,
  buildSongSourceCatalog,
  exportSngTrainingMidi,
  listCatalogHarmonyTargets,
  listDatasetLibrarySongs,
  listSongSourceCatalogs,
  materializeCatalogHarmonySource,
  setCatalogMutationTestHooksForTesting,
  setSngExtractionTestHooksForTesting,
  type SngExtractionParser,
  summarizeDatasetSource,
  summarizeDatasetSourceEntries
} from './sngTrainingExporter'
import {
  createDatasetPackageInventorySession,
  getDatasetPackageInventorySessionReviewEntries,
  runDatasetPackageInventorySession
} from './packageSourceInventory'
import { packageEntryIdentity } from './packageSourceIdentity'

describe('exportSngTrainingMidi', () => {
  const testDir = join(__dirname, '../../../out/sng_training_exporter_test_temp')
  const validMidi = Buffer.from([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x01, 0x00, 0x01, 0x01, 0xe0, 0x4d, 0x54,
    0x72, 0x6b, 0x00, 0x00, 0x00, 0x04, 0x00, 0xff, 0x2f, 0x00
  ])
  const truncatedMidi = Buffer.from([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x01, 0x00, 0x01, 0x01, 0xe0, 0x4d, 0x54,
    0x72, 0x6b, 0x00, 0x00, 0x00, 0x04, 0x00, 0xff
  ])

  function guitarMidi(trackName = 'PART GUITAR'): Buffer {
    const events = Buffer.concat([
      Buffer.from([0x00, 0xff, 0x03, trackName.length]),
      Buffer.from(trackName),
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

  function namedTracksMidi(trackNames: string[]): Buffer {
    const tracks = trackNames.map((trackName) => {
      const events = Buffer.concat([
        Buffer.from([0x00, 0xff, 0x03, trackName.length]),
        Buffer.from(trackName),
        Buffer.from([0x00, 0x90, 0x3c, 0x40, 0x83, 0x60, 0x80, 0x3c, 0x00, 0x00, 0xff, 0x2f, 0x00])
      ])
      const track = Buffer.alloc(8 + events.length)
      track.write('MTrk', 0)
      track.writeUInt32BE(events.length, 4)
      events.copy(track, 8)
      return track
    })
    const header = Buffer.alloc(14)
    header.write('MThd', 0)
    header.writeUInt32BE(6, 4)
    header.writeUInt16BE(1, 8)
    header.writeUInt16BE(tracks.length, 10)
    header.writeUInt16BE(480, 12)
    return Buffer.concat([header, ...tracks])
  }

  async function localMutationOwnerInstance(): Promise<string> {
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim().toLowerCase()
    return `boot:${bootId}`
  }

  async function writeMutationReservation(
    path: string,
    options: { ageMs?: number; ownerPid?: number; ownerInstance?: string } = {}
  ): Promise<void> {
    const ageMs = options.ageMs ?? 0
    const ownerPid = options.ownerPid ?? process.pid
    const ownerInstance = options.ownerInstance ?? (await localMutationOwnerInstance())
    await writeFile(
      path,
      `${JSON.stringify({
        format: 'octave-catalog-mutation-reservation/v2',
        owner_id: 'test-mutation-owner',
        owner_host: hostname(),
        owner_instance: ownerInstance,
        owner_pid: ownerPid,
        created_at_ms: Date.now() - ageMs,
        lease_duration_ms: 10 * 60 * 1000
      })}\n`,
      'utf8'
    )
    const timestamp = new Date(Date.now() - ageMs)
    await utimes(path, timestamp, timestamp)
  }

  function emptySngPackage(): Buffer {
    const header = Buffer.alloc(26)
    header.write('SNGPKG')
    header.writeUInt32LE(1, 6)
    const metadata = Buffer.alloc(16)
    metadata.writeBigUInt64LE(8n, 0)
    const fileIndex = Buffer.alloc(16)
    fileIndex.writeBigUInt64LE(8n, 0)
    const payloadLength = Buffer.alloc(8)
    return Buffer.concat([header, metadata, fileIndex, payloadLength])
  }

  class NonterminalSngParser implements SngExtractionParser {
    private headerListener: ((header: SngHeader) => void) | undefined
    private fileListener:
      | ((
          fileName: string,
          fileStream: ReadableStream<Uint8Array>,
          nextFile: (() => void) | null
        ) => void)
      | undefined

    constructor(
      private readonly midi: Buffer,
      private readonly emitDeclaredFinalAudio = false
    ) {}

    on(event: 'header', listener: (header: SngHeader) => void): void
    on(
      event: 'file',
      listener: (
        fileName: string,
        fileStream: ReadableStream<Uint8Array>,
        nextFile: (() => void) | null
      ) => void
    ): void
    on(event: 'error', listener: (error: unknown) => void): void
    on(
      event: 'header' | 'file' | 'error',
      listener:
        | ((header: SngHeader) => void)
        | ((
            fileName: string,
            fileStream: ReadableStream<Uint8Array>,
            nextFile: (() => void) | null
          ) => void)
        | ((error: unknown) => void)
    ): void {
      if (event === 'header') this.headerListener = listener as typeof this.headerListener
      else if (event === 'file') this.fileListener = listener as typeof this.fileListener
      else void listener
    }

    start(): void {
      this.headerListener?.({
        fileIdentifier: 'SNGPKG',
        version: 1,
        xorMask: new Uint8Array(16),
        metadata: { artist: 'Stalled Artist', name: 'Stalled Song' },
        fileMeta: [
          { filename: 'notes.mid', contentsLen: BigInt(this.midi.length), contentsIndex: 0n },
          { filename: 'song.ogg', contentsLen: 4n, contentsIndex: BigInt(this.midi.length) }
        ]
      })
      const emitFinalAudio = (): void => {
        this.fileListener?.(
          'song.ogg',
          new ReadableStream({
            start: (controller) => {
              controller.enqueue(Buffer.from('OggS'))
              controller.close()
            }
          }),
          // Deliberately nonterminal: this mimics the observed parser failure
          // after the final payload has been drained.
          () => undefined
        )
      }
      this.fileListener?.(
        'notes.mid',
        new ReadableStream({
          start: (controller) => {
            controller.enqueue(this.midi)
            controller.close()
          }
        }),
        this.emitDeclaredFinalAudio ? emitFinalAudio : () => undefined
      )
    }
  }

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true })
  })

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('exports notes.mid and metadata without copying audio or source paths', async () => {
    const songDir = join(testDir, 'source-song')
    await mkdir(songDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), validMidi)
    await writeFile(join(songDir, 'guitar.ogg'), 'AUDIO MUST NOT BE EXPORTED')
    const sngPath = join(testDir, 'source.sng')
    await packSng(
      songDir,
      {
        artist: 'Test Artist',
        name: 'Test Song',
        charter: 'Test Charter',
        source_path: '/private/metadata/path'
      },
      sngPath
    )

    const outputDir = join(testDir, 'dataset')
    const result = await exportSngTrainingMidi({
      sngPaths: [sngPath],
      outputDir,
      datasetId: 'test-private-export',
      provenance: 'synthetic test fixture',
      license: 'test-only'
    })

    expect(result.exported).toHaveLength(1)
    expect(result.skipped).toEqual([])
    const [song] = result.exported
    expect(await readFile(join(outputDir, song.midi))).toEqual(validMidi)
    expect(existsSync(join(outputDir, 'songs', song.songId, 'guitar.ogg'))).toBe(false)
    const manifest = await readFile(result.manifestPath, 'utf8')
    expect(manifest).toContain('octave-training-midi-export/v1')
    expect(manifest).not.toContain(sngPath)
    expect(manifest).not.toContain('/private/metadata/path')
    const metadata = await readFile(
      join(outputDir, 'songs', song.songId, 'source-metadata.json'),
      'utf8'
    )
    expect(metadata).not.toContain('/private/metadata/path')
  })

  it('refuses to write into a non-empty output directory', async () => {
    const outputDir = join(testDir, 'non-empty')
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, 'keep.txt'), 'keep')

    await expect(
      exportSngTrainingMidi({
        sngPaths: [join(testDir, 'missing.sng')],
        outputDir,
        datasetId: 'test-private-export',
        provenance: 'synthetic test fixture',
        license: 'test-only'
      })
    ).rejects.toThrow('must be empty')
  })

  it('records path-free skips for missing and no-MIDI packages', async () => {
    const chartOnlySong = join(testDir, 'chart-only')
    await mkdir(chartOnlySong, { recursive: true })
    await writeFile(join(chartOnlySong, 'notes.chart'), '[Song]\n{\n  Resolution = 192\n}\n')
    const chartOnlySng = join(testDir, 'chart-only.sng')
    await packSng(chartOnlySong, { artist: 'No Midi', name: 'Chart Only' }, chartOnlySng)
    const missingSng = join(testDir, 'missing-private-package.sng')
    const outputDir = join(testDir, 'skips')

    const result = await exportSngTrainingMidi({
      sngPaths: [chartOnlySng, missingSng],
      outputDir,
      datasetId: 'test-private-export',
      provenance: 'synthetic test fixture',
      license: 'test-only'
    })

    expect(result.exported).toEqual([])
    expect(result.skipped).toEqual([
      { sourceIndex: 0, reason: 'Package has no notes.mid' },
      { sourceIndex: 1, reason: 'Package could not be read or exported' }
    ])
    const manifest = await readFile(result.manifestPath, 'utf8')
    expect(manifest).not.toContain(chartOnlySng)
    expect(manifest).not.toContain(missingSng)
    expect(manifest).not.toContain('missing-private-package.sng')
  })

  it('skips packages with an empty file index without hanging or exposing paths', async () => {
    const emptySng = join(testDir, 'empty-private-package.sng')
    await writeFile(emptySng, emptySngPackage())
    const outputDir = join(testDir, 'empty-package-dataset')

    const result = await exportSngTrainingMidi({
      sngPaths: [emptySng],
      outputDir,
      datasetId: 'test-private-export',
      provenance: 'synthetic test fixture',
      license: 'test-only'
    })

    expect(result.exported).toEqual([])
    expect(result.skipped).toEqual([{ sourceIndex: 0, reason: 'Package has no notes.mid' }])
    expect(await readFile(result.manifestPath, 'utf8')).not.toContain('empty-private-package.sng')
  })

  it('fails closed when a declared later SNG stream never arrives', async () => {
    const stalledSng = join(testDir, 'stalled-private-package.sng')
    await writeFile(stalledSng, 'fixture parser owns this stream')
    const outputDir = join(testDir, 'stalled-package-dataset')
    setSngExtractionTestHooksForTesting({
      timeoutMs: 100,
      createParser: () => new NonterminalSngParser(validMidi)
    })

    try {
      const result = await exportSngTrainingMidi({
        sngPaths: [stalledSng],
        outputDir,
        datasetId: 'test-private-export',
        provenance: 'synthetic test fixture',
        license: 'test-only'
      })

      expect(result.exported).toEqual([])
      expect(result.skipped).toEqual([
        { sourceIndex: 0, reason: 'Package could not be read or exported' }
      ])
      const manifest = await readFile(result.manifestPath, 'utf8')
      expect(manifest).not.toContain(stalledSng)
      expect(manifest).not.toContain('stalled-private-package.sng')
    } finally {
      setSngExtractionTestHooksForTesting(undefined)
    }
  })

  it('completes a fully drained declared SNG file set without a terminal continuation', async () => {
    const nonterminalSng = join(testDir, 'nonterminal-private-package.sng')
    await writeFile(nonterminalSng, 'fixture parser owns this stream')
    const outputDir = join(testDir, 'nonterminal-package-dataset')
    setSngExtractionTestHooksForTesting({
      timeoutMs: 100,
      createParser: () => new NonterminalSngParser(validMidi, true)
    })

    try {
      const result = await exportSngTrainingMidi({
        sngPaths: [nonterminalSng],
        outputDir,
        datasetId: 'test-private-export',
        provenance: 'synthetic test fixture',
        license: 'test-only'
      })

      expect(result.exported).toHaveLength(1)
      expect(result.skipped).toEqual([])
      const manifest = await readFile(result.manifestPath, 'utf8')
      expect(manifest).not.toContain(nonterminalSng)
      expect(manifest).not.toContain('nonterminal-private-package.sng')
    } finally {
      setSngExtractionTestHooksForTesting(undefined)
    }
  })

  it('skips packages with malformed notes.mid data, even when the header looks valid', async () => {
    const invalidSong = join(testDir, 'invalid-midi')
    await mkdir(invalidSong, { recursive: true })
    await writeFile(join(invalidSong, 'notes.mid'), truncatedMidi)
    const invalidSng = join(testDir, 'invalid-midi.sng')
    await packSng(invalidSong, { artist: 'Invalid', name: 'Midi' }, invalidSng)
    const outputDir = join(testDir, 'invalid-midi-dataset')

    const result = await exportSngTrainingMidi({
      sngPaths: [invalidSng],
      outputDir,
      datasetId: 'test-private-export',
      provenance: 'synthetic test fixture',
      license: 'test-only'
    })

    expect(result.exported).toEqual([])
    expect(result.skipped).toEqual([
      { sourceIndex: 0, reason: 'Package could not be read or exported' }
    ])
  })

  it('requires an explicit song.ini opt-in before exporting Octave library songs', async () => {
    const optedIn = join(testDir, 'library-opted-in')
    const optedOut = join(testDir, 'library-opted-out')
    await mkdir(optedIn, { recursive: true })
    await mkdir(optedOut, { recursive: true })
    await writeFile(join(optedIn, 'notes.mid'), validMidi)
    await writeFile(join(optedOut, 'notes.mid'), validMidi)
    await writeFile(
      join(optedIn, 'song.ini'),
      '[song]\nname = Reviewed\nartist = Tester\ndataset_opt_in = true\n'
    )
    await writeFile(
      join(optedOut, 'song.ini'),
      '[song]\nname = Generated\nartist = Tester\ncharter = STRUM\nstrum_generated = true\ndataset_opt_in = false\n'
    )

    const librarySongs = await listDatasetLibrarySongs(testDir)
    expect(librarySongs.find((song) => song.path === optedIn)?.datasetOptIn).toBe(true)
    expect(librarySongs.find((song) => song.path === optedOut)).toMatchObject({
      datasetOptIn: false,
      isStrumGenerated: true
    })

    const outputDir = join(testDir, 'library-dataset')
    const result = await exportSngTrainingMidi({
      sngPaths: [],
      librarySongPaths: [optedIn, optedOut],
      outputDir,
      datasetId: 'reviewed-library',
      provenance: 'local review',
      license: 'test-only'
    })

    expect(result.exported).toHaveLength(1)
    expect(result.exported[0].source).toBe('octave-library')
    expect(result.skipped).toEqual([
      { sourceIndex: 1, reason: 'Song is not opted into dataset curation' }
    ])
  })

  it('exports MIDI directly from an explicitly selected RB3CON package', async () => {
    const songDir = join(testDir, 'con-source')
    await mkdir(songDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), validMidi)
    await writeFile(join(songDir, 'song.ogg'), Buffer.from('OggS'))
    const conPath = join(testDir, 'source.rb3con')
    await packRb3con(songDir, { name: 'CON Song', artist: 'CON Artist' }, conPath)

    const result = await exportSngTrainingMidi({
      sngPaths: [],
      conPaths: [conPath],
      outputDir: join(testDir, 'con-dataset'),
      datasetId: 'con-export',
      provenance: 'synthetic test fixture',
      license: 'test-only'
    })

    expect(result.exported).toHaveLength(1)
    expect(result.exported[0]).toMatchObject({ source: 'rb3con', metadata: { name: 'CON Song' } })
    expect(await readFile(join(testDir, 'con-dataset', result.exported[0].midi))).toEqual(validMidi)
  })

  it('materializes a path-free atomically created source catalog for STRUM', async () => {
    const songDir = join(testDir, 'catalog-library-song')
    const parentDir = join(testDir, 'catalog-parent')
    await mkdir(songDir, { recursive: true })
    await mkdir(parentDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), validMidi)
    await writeFile(join(songDir, 'song.ogg'), Buffer.from('OggS catalog audio'))
    await writeFile(
      join(songDir, 'song.ini'),
      '[song]\nname = Catalog Song\nartist = Catalog Artist\ndataset_opt_in = true\n'
    )

    const progress: Array<{ phase: string; completed: number; total: number }> = []
    const result = await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'strum-reviewed',
      catalogId: 'strum-reviewed',
      provenance: 'Reviewed local collection',
      license: 'test-only',
      octaveVersion: 'test',
      onProgress: (update) => progress.push(update)
    })

    expect(result).toMatchObject({ recordCount: 1, skipped: [] })
    const catalogPath = join(parentDir, 'strum-reviewed')
    const catalog = await readFile(join(catalogPath, 'catalog.json'), 'utf8')
    const records = await readFile(join(catalogPath, 'records.jsonl'), 'utf8')
    expect(catalog).toContain('octave-song-source-catalog/v1')
    expect(catalog).not.toContain(songDir)
    expect(records).not.toContain(songDir)
    expect(records).toContain('"training_use":"allowed"')
    const record = JSON.parse(records) as {
      chart: { notes_midi: { relative_path: string } }
      audio: { mix: { relative_path: string; media_type: string } }
    }
    expect(await readFile(join(catalogPath, record.chart.notes_midi.relative_path))).toEqual(
      validMidi
    )
    expect(await readFile(join(catalogPath, record.audio.mix.relative_path), 'utf8')).toBe(
      'OggS catalog audio'
    )
    expect(record.audio.mix.media_type).toBe('audio/ogg')
    expect(existsSync(join(parentDir, '.strum-reviewed.staging'))).toBe(false)
    expect(progress).toEqual([
      { phase: 'normalizing', completed: 0, total: 1 },
      { phase: 'materializing', completed: 1, total: 1 },
      { phase: 'validating', completed: 1, total: 1 }
    ])
  })

  it.each([
    ['unchanged', 'name = Generated\nartist = STRUM'],
    ['metadata-only', 'name = Renamed by user\nartist = Edited metadata'],
    [
      'self-attested',
      'name = Generated\ntraining_approved_revision = fabricated\nmanual_edit = true'
    ]
  ])('rejects %s generated charts even with explicit opt-in', async (variant, metadata) => {
    const songDir = join(testDir, `catalog-strum-${variant}`)
    const parentDir = join(testDir, `catalog-strum-parent-${variant}`)
    await mkdir(songDir, { recursive: true })
    await mkdir(parentDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), validMidi)
    await writeFile(
      join(songDir, 'song.ini'),
      `[song]\n${metadata}\nstrum_generated = true\ndataset_opt_in = true\n`
    )
    await expect(
      summarizeDatasetSource({ kind: 'octave-library', sourcePath: songDir })
    ).resolves.toMatchObject({
      trainingUse: 'review_required',
      warnings: [{ code: 'generated_revision_unverified' }]
    })
    await expect(
      buildSongSourceCatalog({
        sources: [{ kind: 'octave-library', sourcePath: songDir }],
        parentDir,
        catalogName: 'strum-catalog',
        catalogId: 'strum-catalog',
        provenance: 'Explicitly reviewed',
        license: 'test-only',
        octaveVersion: 'test'
      })
    ).rejects.toThrow('Generated chart training is unavailable')
    expect(existsSync(join(parentDir, 'strum-catalog'))).toBe(false)
    const exported = await exportSngTrainingMidi({
      sngPaths: [],
      librarySongPaths: [songDir],
      outputDir: join(testDir, `generated-export-${variant}`),
      datasetId: 'generated-export',
      provenance: 'Explicitly reviewed',
      license: 'test-only'
    })
    expect(exported.exported).toEqual([])
    expect(exported.skipped).toEqual([{ sourceIndex: 0, reason: 'generated_revision_unverified' }])
  })

  it('writes schema-shaped instrument coverage with track_names', async () => {
    const songDir = join(testDir, 'catalog-guitar-song')
    const parentDir = join(testDir, 'catalog-guitar-parent')
    await mkdir(songDir, { recursive: true })
    await mkdir(parentDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), guitarMidi())
    await writeFile(join(songDir, 'song.ini'), '[song]\nname = Guitar\ndataset_opt_in = true\n')

    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'guitar-coverage',
      catalogId: 'guitar-coverage',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })

    const record = JSON.parse(
      await readFile(join(parentDir, 'guitar-coverage', 'records.jsonl'), 'utf8')
    ) as { chart: { instruments: { guitar: Record<string, unknown> } } }
    expect(record.chart.instruments.guitar).toMatchObject({
      status: 'present',
      difficulties: ['expert'],
      track_names: ['PART GUITAR']
    })
    expect(record.chart.instruments.guitar).not.toHaveProperty('trackNames')
  })

  it('redacts parser-derived locations from catalog metadata and track names', async () => {
    const songDir = join(testDir, 'catalog-redaction-song')
    const parentDir = join(testDir, 'catalog-redaction-parent')
    await mkdir(songDir, { recursive: true })
    await mkdir(parentDir, { recursive: true })
    await writeFile(
      join(songDir, 'notes.mid'),
      guitarMidi('PART GUITAR https://example.invalid/private')
    )
    await writeFile(
      join(songDir, 'song.ini'),
      '[song]\nname = file:///private/song\nartist = \\\\\\\\server\\share\ncharter = C:\\\\private\\\\charter\ndataset_opt_in = true\n'
    )

    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'redacted-catalog',
      catalogId: 'redacted-catalog',
      provenance: 'https://example.invalid/provenance',
      license: 'file:///private/license',
      octaveVersion: 'test'
    })

    const serialized = await readFile(join(parentDir, 'redacted-catalog', 'records.jsonl'), 'utf8')
    expect(serialized).not.toMatch(/https?:\/\/|file:\/\/|C:\\\\/)
    expect(serialized).not.toContain('private')
    expect(serialized).not.toContain('server')
    expect(serialized).toContain('[redacted]')
  })

  it('normalizes selected ZIP sources in the main-process catalog service', async () => {
    const archivePath = join(testDir, 'catalog-source.zip')
    const parentDir = join(testDir, 'catalog-zip-parent')
    const archive = new AdmZip()
    archive.addFile('song/notes.mid', validMidi)
    archive.addFile(
      'song/song.ini',
      Buffer.from('[song]\nname = ZIP Song\ncharter = Human author\n')
    )
    archive.writeZip(archivePath)
    await mkdir(parentDir, { recursive: true })

    await expect(
      summarizeDatasetSource({ kind: 'zip', sourcePath: archivePath })
    ).resolves.toMatchObject({ isStrumGenerated: false })

    const result = await buildSongSourceCatalog({
      sources: [{ kind: 'zip', sourcePath: archivePath }],
      parentDir,
      catalogName: 'zip-catalog',
      catalogId: 'zip-catalog',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })

    expect(result).toMatchObject({ recordCount: 1 })
    expect(await readFile(join(parentDir, 'zip-catalog', 'records.jsonl'), 'utf8')).toContain(
      '"kind":"zip"'
    )
  })

  it('returns independently selectable summaries for every song in a ZIP package', async () => {
    const archivePath = join(testDir, 'multi-song-source.zip')
    const archive = new AdmZip()
    archive.addFile('approved/notes.mid', validMidi)
    archive.addFile('approved/song.ini', Buffer.from('[song]\nname = Approved\nartist = Tester\n'))
    // Byte-identical charts must still be independently selectable when they
    // belong to different songs in the same package.
    archive.addFile('strum/notes.mid', validMidi)
    archive.addFile(
      'strum/song.ini',
      Buffer.from('[song]\nname = STRUM Song\nartist = Tester\ncharter = STRUM\n')
    )
    archive.writeZip(archivePath)

    const entries = await summarizeDatasetSourceEntries({ kind: 'zip', sourcePath: archivePath })

    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.entryId)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/)])
    )
    expect(new Set(entries.map((entry) => entry.entryId)).size).toBe(2)
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({ name: 'STRUM Song' }),
          isStrumGenerated: true
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({ name: 'Approved' }),
          isStrumGenerated: false
        })
      ])
    )

    const strumEntry = entries.find((entry) => entry.isStrumGenerated)
    expect(strumEntry).toBeDefined()
    if (!strumEntry) throw new Error('Expected STRUM ZIP entry fixture')
    const parentDir = join(testDir, 'multi-song-catalog-parent')
    await mkdir(parentDir, { recursive: true })
    await expect(
      buildSongSourceCatalog({
        sources: [{ kind: 'zip', sourcePath: archivePath, entryId: strumEntry.entryId }],
        parentDir,
        catalogName: 'selected-entry',
        catalogId: 'selected-entry',
        provenance: 'Reviewed',
        license: 'test-only',
        octaveVersion: 'test'
      })
    ).rejects.toThrow('Generated chart training is unavailable')
    expect(existsSync(join(parentDir, 'selected-entry'))).toBe(false)
  })

  it('materializes only a review-selected ZIP chart from its exact snapshot', async () => {
    const archivePath = join(testDir, 'reviewed-shifted-order.zip')
    const archive = new AdmZip()
    // The inventory sees `z` when this chart-only entry appears first, while
    // the legacy exporter used to enumerate MIDI entries in a different order.
    archive.addFile('z/notes.chart', Buffer.from('[Song]\n{\n  Resolution = 192\n}\n'))
    archive.addFile('a/notes.mid', guitarMidi('PART GUITAR'))
    archive.addFile('a/song.ini', Buffer.from('[song]\nname = First MIDI\n'))
    archive.addFile('z/notes.mid', guitarMidi('PART VOCALS'))
    archive.addFile('z/song.ini', Buffer.from('[song]\nname = Reviewed Vocal\n'))
    archive.writeZip(archivePath)

    const session = createDatasetPackageInventorySession([{ kind: 'zip', sourcePath: archivePath }])
    await runDatasetPackageInventorySession(session, {
      inspectInIsolation: async () => {
        const bytes = await readFile(archivePath)
        const zip = new AdmZip(bytes)
        // Use the real worker path in production; this focused seam verifies
        // only the review-to-catalog identity binding below.
        const entries = zip.getEntries()
        const zMidi = entries.find((entry) => entry.entryName === 'z/notes.mid')?.getData()
        const aMidi = entries.find((entry) => entry.entryName === 'a/notes.mid')?.getData()
        if (!zMidi || !aMidi) throw new Error('fixture missing MIDI')
        return {
          outcome: 'inspected' as const,
          containerHash: createHash('sha256').update(bytes).digest('hex'),
          inspection: {
            headerReadable: true,
            charts: [
              {
                validNotesMidi: true,
                hasChart: true,
                exactExpertPartVocals: true,
                midiHash: createHash('sha256').update(zMidi).digest('hex'),
                entryLocator: 'z/'
              },
              {
                validNotesMidi: true,
                hasChart: false,
                exactExpertPartVocals: false,
                midiHash: createHash('sha256').update(aMidi).digest('hex'),
                entryLocator: 'a/'
              }
            ]
          }
        }
      }
    })
    const reviewed = getDatasetPackageInventorySessionReviewEntries(session).find(
      (entry) => entry.entryLocator === 'z/'
    )
    if (!reviewed) throw new Error('Expected reviewed Vocal entry')
    const parentDir = join(testDir, 'reviewed-shifted-parent')
    await mkdir(parentDir, { recursive: true })
    await buildSongSourceCatalog({
      sources: [
        {
          ...reviewed.source,
          entryId: reviewed.entryId,
          packageReview: {
            containerSha256: reviewed.containerSha256,
            midiSha256: reviewed.midiSha256,
            entryLocator: reviewed.entryLocator
          }
        }
      ],
      parentDir,
      catalogName: 'reviewed-shifted',
      catalogId: 'reviewed-shifted',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    const record = JSON.parse(
      await readFile(join(parentDir, 'reviewed-shifted', 'records.jsonl'), 'utf8')
    ) as { metadata: { name: string }; import: { container_sha256: string } }
    expect(record.metadata.name).toBe('Reviewed Vocal')
    expect(record.import.container_sha256).toBe(reviewed.containerSha256)

    const replacementPath = join(testDir, 'reviewed-replacement.zip')
    const replacement = new AdmZip()
    replacement.addFile('z/notes.mid', guitarMidi('PART GUITAR'))
    replacement.writeZip(replacementPath)
    await unlink(archivePath)
    await symlink(replacementPath, archivePath)
    await expect(
      buildSongSourceCatalog({
        sources: [
          {
            ...reviewed.source,
            entryId: reviewed.entryId,
            packageReview: {
              containerSha256: reviewed.containerSha256,
              midiSha256: reviewed.midiSha256,
              entryLocator: reviewed.entryLocator
            }
          }
        ],
        parentDir,
        catalogName: 'reviewed-replaced',
        catalogId: 'reviewed-replaced',
        provenance: 'Reviewed',
        license: 'test-only',
        octaveVersion: 'test',
        mode: 'clone',
        sourceCatalogName: 'reviewed-shifted'
      })
    ).rejects.toThrow('reviewed package')
    expect(existsSync(join(parentDir, 'reviewed-replaced'))).toBe(false)
    expect(
      JSON.parse(await readFile(join(parentDir, 'reviewed-shifted', 'records.jsonl'), 'utf8'))
    ).toMatchObject({ metadata: { name: 'Reviewed Vocal' } })
  })

  it('returns only a safe code for parser failures and cleans failed staging directories', async () => {
    const packagePath = join(testDir, 'private-broken-package.sng')
    const parentDir = join(testDir, 'catalog-failure-parent')
    await writeFile(packagePath, Buffer.from('not an sng package'))
    await mkdir(parentDir, { recursive: true })

    await expect(summarizeDatasetSource({ kind: 'sng', sourcePath: packagePath })).resolves.toEqual(
      expect.objectContaining({ warnings: [{ code: 'source_unavailable' }] })
    )
    await expect(
      buildSongSourceCatalog({
        sources: [{ kind: 'sng', sourcePath: packagePath }],
        parentDir,
        catalogName: 'failed-catalog',
        catalogId: 'failed-catalog',
        provenance: 'Reviewed',
        license: 'test-only',
        octaveVersion: 'test'
      })
    ).rejects.toThrow('No valid source records')
    expect(await readdir(parentDir)).toEqual([])
  })

  it('creates a path-free audio-enrichment revision for a reviewed duplicate MIDI', async () => {
    const parentDir = join(testDir, 'audio-enrichment-parent')
    const catalogSong = join(testDir, 'audio-enrichment-catalog-song')
    const packagePath = join(testDir, 'private-audio-enrichment-source.zip')
    await mkdir(parentDir, { recursive: true })
    await mkdir(catalogSong, { recursive: true })
    const midi = guitarMidi()
    await writeFile(join(catalogSong, 'notes.mid'), midi)
    await writeFile(join(catalogSong, 'song.ogg'), Buffer.from('OggS original catalog mix'))
    await writeFile(join(catalogSong, 'song.ini'), '[song]\ndataset_opt_in = true\n')
    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: catalogSong }],
      parentDir,
      catalogName: 'base-catalog',
      catalogId: 'base-catalog',
      provenance: 'Original curator',
      license: 'test-only',
      octaveVersion: 'test'
    })
    const archive = new AdmZip()
    archive.addFile('notes.mid', midi)
    archive.addFile('song.ogg', Buffer.from('OggS alternate reviewed mix'))
    archive.writeZip(packagePath)
    const packageBytes = await readFile(packagePath)
    const containerSha256 = createHash('sha256').update(packageBytes).digest('hex')
    const midiSha256 = createHash('sha256').update(midi).digest('hex')
    const source = {
      kind: 'zip' as const,
      sourcePath: packagePath,
      entryId: packageEntryIdentity('zip', containerSha256, '', midiSha256),
      packageReview: { containerSha256, midiSha256, entryLocator: '' }
    }

    const baseRecord = JSON.parse(
      await readFile(join(parentDir, 'base-catalog', 'records.jsonl'), 'utf8')
    ) as Record<string, unknown>
    const result = await buildSongSourceCatalogAudioEnrichmentRevision({
      source,
      parentDir,
      catalogName: 'base-catalog-audio-revision',
      catalogId: 'base-catalog-audio-revision',
      sourceCatalogName: 'base-catalog',
      octaveVersion: 'test'
    })
    expect(result).toMatchObject({ recordCount: 1, skipped: [] })
    const revisionPath = join(parentDir, 'base-catalog-audio-revision')
    const revisionRecord = JSON.parse(
      await readFile(join(revisionPath, 'records.jsonl'), 'utf8')
    ) as Record<string, unknown>
    const baseChart = baseRecord.chart as { notes_midi: { sha256: string } }
    const revisionChart = revisionRecord.chart as { notes_midi: { sha256: string } }
    const baseRights = baseRecord.rights
    expect(revisionChart.notes_midi.sha256).toBe(baseChart.notes_midi.sha256)
    expect(revisionRecord.rights).toEqual(baseRights)
    expect(revisionRecord.source_id).toBe(baseRecord.source_id)
    expect(revisionRecord.audio).not.toEqual(baseRecord.audio)
    const baseMix = (baseRecord.audio as { mix: { relative_path: string } }).mix
    expect(await readFile(join(parentDir, 'base-catalog', baseMix.relative_path), 'utf8')).toBe(
      'OggS original catalog mix'
    )
    const serializedRevision = await readFile(join(revisionPath, 'records.jsonl'), 'utf8')
    expect(serializedRevision).not.toContain(packagePath)
    expect(serializedRevision).not.toContain(containerSha256)
    expect(serializedRevision).not.toContain('private-audio-enrichment-source')
    expect(JSON.parse(await readFile(join(revisionPath, 'catalog.json'), 'utf8'))).toMatchObject({
      curation: { provenance: 'Audio enrichment revision in OCTAVE', license: 'test-only' }
    })
    await expect(
      buildSongSourceCatalogAudioEnrichmentRevision({
        source,
        parentDir,
        catalogName: 'duplicate-audio-revision',
        catalogId: 'duplicate-audio-revision',
        sourceCatalogName: 'base-catalog-audio-revision',
        octaveVersion: 'test'
      })
    ).rejects.toThrow('duplicate audio already present')
    expect(existsSync(join(parentDir, 'duplicate-audio-revision'))).toBe(false)
  })

  it('keeps an ordinary clone audio-identical when duplicate MIDI is skipped', async () => {
    const parentDir = join(testDir, 'ordinary-clone-parent')
    const songDir = join(testDir, 'ordinary-clone-song')
    await mkdir(parentDir, { recursive: true })
    await mkdir(songDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), guitarMidi())
    await writeFile(join(songDir, 'song.ogg'), Buffer.from('OggS unchanged base mix'))
    await writeFile(join(songDir, 'song.ini'), '[song]\ndataset_opt_in = true\n')
    const source = { kind: 'octave-library' as const, sourcePath: songDir }
    await buildSongSourceCatalog({
      sources: [source],
      parentDir,
      catalogName: 'ordinary-base',
      catalogId: 'ordinary-base',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    await buildSongSourceCatalog({
      sources: [source],
      parentDir,
      catalogName: 'ordinary-clone',
      catalogId: 'ordinary-clone',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test',
      mode: 'clone',
      sourceCatalogName: 'ordinary-base'
    })
    const base = JSON.parse(
      await readFile(join(parentDir, 'ordinary-base', 'records.jsonl'), 'utf8')
    ) as { audio: unknown; chart: unknown }
    const clone = JSON.parse(
      await readFile(join(parentDir, 'ordinary-clone', 'records.jsonl'), 'utf8')
    ) as { audio: unknown; chart: unknown }
    expect(clone.audio).toEqual(base.audio)
    expect(clone.chart).toEqual(base.chart)
  })

  it('fails closed for reviewed-source replacement, invalid alternate audio, and staged revision rollback', async () => {
    const parentDir = join(testDir, 'audio-enrichment-rollback-parent')
    const catalogSong = join(testDir, 'audio-enrichment-rollback-song')
    const packagePath = join(testDir, 'audio-enrichment-rollback-source.zip')
    await mkdir(parentDir, { recursive: true })
    await mkdir(catalogSong, { recursive: true })
    const midi = guitarMidi()
    await writeFile(join(catalogSong, 'notes.mid'), midi)
    await writeFile(join(catalogSong, 'song.ogg'), Buffer.from('OggS protected base mix'))
    await writeFile(join(catalogSong, 'song.ini'), '[song]\ndataset_opt_in = true\n')
    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: catalogSong }],
      parentDir,
      catalogName: 'rollback-base',
      catalogId: 'rollback-base',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    const archive = new AdmZip()
    archive.addFile('notes.mid', midi)
    archive.addFile('song.ogg', Buffer.from('not a valid audio container'))
    archive.writeZip(packagePath)
    const packageBytes = await readFile(packagePath)
    const containerSha256 = createHash('sha256').update(packageBytes).digest('hex')
    const midiSha256 = createHash('sha256').update(midi).digest('hex')
    const source = {
      kind: 'zip' as const,
      sourcePath: packagePath,
      entryId: packageEntryIdentity('zip', containerSha256, '', midiSha256),
      packageReview: { containerSha256, midiSha256, entryLocator: '' }
    }
    await expect(
      buildSongSourceCatalogAudioEnrichmentRevision({
        source,
        parentDir,
        catalogName: 'invalid-audio-revision',
        catalogId: 'invalid-audio-revision',
        sourceCatalogName: 'rollback-base',
        octaveVersion: 'test'
      })
    ).rejects.toThrow('invalid alternate audio')
    expect(existsSync(join(parentDir, 'invalid-audio-revision'))).toBe(false)
    expect((await readdir(parentDir)).some((entry) => entry.includes('.staging-'))).toBe(false)

    const replacement = new AdmZip()
    replacement.addFile('notes.mid', guitarMidi('PART BASS'))
    replacement.addFile('song.ogg', Buffer.from('OggS replacement'))
    replacement.writeZip(packagePath)
    await expect(
      buildSongSourceCatalogAudioEnrichmentRevision({
        source,
        parentDir,
        catalogName: 'replaced-source-revision',
        catalogId: 'replaced-source-revision',
        sourceCatalogName: 'rollback-base',
        octaveVersion: 'test'
      })
    ).rejects.toThrow('Reviewed package changed')
    expect(existsSync(join(parentDir, 'replaced-source-revision'))).toBe(false)
    const rollbackRecord = JSON.parse(
      await readFile(join(parentDir, 'rollback-base', 'records.jsonl'), 'utf8')
    ) as { audio: { mix: { relative_path: string } } }
    expect(
      await readFile(
        join(parentDir, 'rollback-base', rollbackRecord.audio.mix.relative_path),
        'utf8'
      )
    ).toBe('OggS protected base mix')
  })

  it('rejects one reviewed alternate asset reused as both mix and vocals', async () => {
    const parentDir = join(testDir, 'audio-enrichment-role-parent')
    const catalogSong = join(testDir, 'audio-enrichment-role-song')
    const packagePath = join(testDir, 'audio-enrichment-role-source.zip')
    await mkdir(parentDir, { recursive: true })
    await mkdir(catalogSong, { recursive: true })
    const midi = guitarMidi()
    await writeFile(join(catalogSong, 'notes.mid'), midi)
    await writeFile(join(catalogSong, 'song.ini'), '[song]\ndataset_opt_in = true\n')
    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: catalogSong }],
      parentDir,
      catalogName: 'role-base',
      catalogId: 'role-base',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    const sharedAudio = Buffer.from('OggS shared role bytes')
    const archive = new AdmZip()
    archive.addFile('notes.mid', midi)
    archive.addFile('song.ogg', sharedAudio)
    archive.addFile('vocals.ogg', sharedAudio)
    archive.writeZip(packagePath)
    const packageBytes = await readFile(packagePath)
    const containerSha256 = createHash('sha256').update(packageBytes).digest('hex')
    const midiSha256 = createHash('sha256').update(midi).digest('hex')
    await expect(
      buildSongSourceCatalogAudioEnrichmentRevision({
        source: {
          kind: 'zip',
          sourcePath: packagePath,
          entryId: packageEntryIdentity('zip', containerSha256, '', midiSha256),
          packageReview: { containerSha256, midiSha256, entryLocator: '' }
        },
        parentDir,
        catalogName: 'role-revision',
        catalogId: 'role-revision',
        sourceCatalogName: 'role-base',
        octaveVersion: 'test'
      })
    ).rejects.toThrow('reuses one audio asset for mix and vocals')
    expect(existsSync(join(parentDir, 'role-revision'))).toBe(false)

    const caseCollisionPath = join(testDir, 'audio-enrichment-case-collision.zip')
    const caseCollision = new AdmZip()
    caseCollision.addFile('notes.mid', midi)
    caseCollision.addFile('song.ogg', Buffer.from('OggS lower-case mix'))
    caseCollision.addFile('SONG.ogg', Buffer.from('OggS upper-case mix'))
    caseCollision.writeZip(caseCollisionPath)
    const caseCollisionBytes = await readFile(caseCollisionPath)
    const caseCollisionHash = createHash('sha256').update(caseCollisionBytes).digest('hex')
    await expect(
      buildSongSourceCatalogAudioEnrichmentRevision({
        source: {
          kind: 'zip',
          sourcePath: caseCollisionPath,
          entryId: packageEntryIdentity('zip', caseCollisionHash, '', midiSha256),
          packageReview: {
            containerSha256: caseCollisionHash,
            midiSha256,
            entryLocator: ''
          }
        },
        parentDir,
        catalogName: 'case-collision-revision',
        catalogId: 'case-collision-revision',
        sourceCatalogName: 'role-base',
        octaveVersion: 'test'
      })
    ).rejects.toThrow('Reviewed package changed')
    expect(existsSync(join(parentDir, 'case-collision-revision'))).toBe(false)
  })

  it('refuses an existing empty catalog destination', async () => {
    const songDir = join(testDir, 'catalog-existing-song')
    const parentDir = join(testDir, 'catalog-existing-parent')
    const destination = join(parentDir, 'existing-catalog')
    await mkdir(songDir, { recursive: true })
    await mkdir(destination, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), validMidi)
    await writeFile(join(songDir, 'song.ini'), '[song]\ndataset_opt_in = true\n')

    await expect(
      buildSongSourceCatalog({
        sources: [{ kind: 'octave-library', sourcePath: songDir }],
        parentDir,
        catalogName: 'existing-catalog',
        catalogId: 'existing-catalog',
        provenance: 'Reviewed',
        license: 'test-only',
        octaveVersion: 'test'
      })
    ).rejects.toThrow('already exists')
    expect(await readdir(destination)).toEqual([])
  })

  it('updates a selected catalog in place and clones it as a revision', async () => {
    const parentDir = join(testDir, 'catalog-editor-parent')
    const firstSong = join(testDir, 'catalog-editor-first')
    const secondSong = join(testDir, 'catalog-editor-second')
    await mkdir(parentDir, { recursive: true })
    await mkdir(firstSong, { recursive: true })
    await mkdir(secondSong, { recursive: true })
    await writeFile(join(firstSong, 'notes.mid'), validMidi)
    await writeFile(join(secondSong, 'notes.mid'), guitarMidi())
    await writeFile(join(firstSong, 'song.ini'), '[song]\nname = First\ndataset_opt_in = true\n')
    await writeFile(join(secondSong, 'song.ini'), '[song]\nname = Second\ndataset_opt_in = true\n')

    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: firstSong }],
      parentDir,
      catalogName: 'editable-catalog',
      catalogId: 'editable-catalog',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    const updated = await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: secondSong }],
      parentDir,
      catalogName: 'editable-catalog',
      catalogId: 'ignored-when-updating',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test',
      mode: 'update'
    })
    expect(updated).toMatchObject({ recordCount: 2 })
    expect(await listSongSourceCatalogs(parentDir)).toEqual([
      expect.objectContaining({
        catalogName: 'editable-catalog',
        provenance: 'Reviewed',
        license: 'test-only',
        recordCount: 2
      })
    ])
    const updatedManifest = JSON.parse(
      await readFile(join(parentDir, 'editable-catalog', 'catalog.json'), 'utf8')
    ) as { curation: { provenance: string; license: string } }
    expect(updatedManifest.curation).toEqual({ provenance: 'Reviewed', license: 'test-only' })

    const clone = await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: secondSong }],
      parentDir,
      catalogName: 'editable-catalog-revision',
      catalogId: 'editable-catalog-revision',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test',
      mode: 'clone',
      sourceCatalogName: 'editable-catalog'
    })
    expect(clone).toMatchObject({ recordCount: 2 })
  })

  it('materializes only an explicit isolated HARM stem into a hash-bound policy sidecar', async () => {
    const parentDir = join(testDir, 'harmony-stem-parent')
    const songDir = join(testDir, 'harmony-stem-song')
    const explicitStem = join(testDir, 'private-source-harm1.wav')
    await mkdir(parentDir, { recursive: true })
    await mkdir(songDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), namedTracksMidi(['PART VOCALS', 'HARM1']))
    await writeFile(join(songDir, 'song.ogg'), Buffer.from('catalog mix'))
    await writeFile(join(songDir, 'vocals.ogg'), Buffer.from('catalog shared vocals'))
    await writeFile(
      join(songDir, 'song.ini'),
      '[song]\nname = Harmony Song\nartist = Tester\ndataset_opt_in = true\n'
    )
    await writeFile(explicitStem, Buffer.from('isolated harm one'))
    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'harmony-stem-catalog',
      catalogId: 'harmony-stem-catalog',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })

    const initialTargets = await listCatalogHarmonyTargets(parentDir, 'harmony-stem-catalog')
    expect(initialTargets).toEqual([
      expect.objectContaining({ tracks: ['HARM1'], configuredTracks: [] })
    ])
    const sourceId = initialTargets[0].sourceId
    await expect(
      materializeCatalogHarmonySource({
        parentDir,
        catalogName: 'harmony-stem-catalog',
        sourceId,
        trackName: 'HARM1',
        sourceAudioPath: explicitStem,
        provenance: { kind: 'isolated_source_stem/v1', attestationId: 'licensed-stem-001' }
      })
    ).resolves.toEqual({ sourceId, trackName: 'HARM1', configuredTracks: ['HARM1'] })

    const catalogRoot = join(parentDir, 'harmony-stem-catalog')
    const record = JSON.parse(await readFile(join(catalogRoot, 'records.jsonl'), 'utf8')) as {
      audio: { harm1: { relative_path: string; sha256: string; asset_id: string } }
    }
    expect(await readFile(join(catalogRoot, record.audio.harm1.relative_path))).toEqual(
      Buffer.from('isolated harm one')
    )
    const policyText = await readFile(join(catalogRoot, 'vocal-harmony-sources.json'), 'utf8')
    const policy = JSON.parse(policyText) as {
      catalog_control_sha256: string
      records: Array<{
        track_name: string
        audio: { role: string; sha256: string }
        provenance: { kind: string }
      }>
    }
    expect(policy.catalog_control_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(policy.records).toEqual([
      expect.objectContaining({
        source_id: sourceId,
        track_name: 'HARM1',
        audio: expect.objectContaining({ role: 'harm1', sha256: record.audio.harm1.sha256 }),
        provenance: expect.objectContaining({ kind: 'isolated_source_stem/v1' })
      })
    ])
    expect(policyText).not.toContain(explicitStem)
    expect((await listCatalogHarmonyTargets(parentDir, 'harmony-stem-catalog'))[0]).toMatchObject({
      configuredTracks: ['HARM1']
    })
    await buildSongSourceCatalog({
      sources: [],
      parentDir,
      catalogName: 'harmony-stem-catalog',
      catalogId: 'ignored-for-update',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test',
      mode: 'update'
    })
    await expect(
      readFile(join(catalogRoot, 'vocal-harmony-sources.json'), 'utf8')
    ).rejects.toThrow()
  })

  it('requires pinned catalog mix and separator identities for a separation output', async () => {
    const parentDir = join(testDir, 'harmony-separation-parent')
    const songDir = join(testDir, 'harmony-separation-song')
    const separatedOutput = join(testDir, 'private-separated-harm2.flac')
    await mkdir(parentDir, { recursive: true })
    await mkdir(songDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), namedTracksMidi(['PART VOCALS', 'HARM2']))
    await writeFile(join(songDir, 'song.ogg'), Buffer.from('catalog separation mix'))
    await writeFile(
      join(songDir, 'song.ini'),
      '[song]\nname = Separation Song\ndataset_opt_in = true\n'
    )
    await writeFile(separatedOutput, Buffer.from('isolated harm two'))
    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'harmony-separation-catalog',
      catalogId: 'harmony-separation-catalog',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    const sourceId = (await listCatalogHarmonyTargets(parentDir, 'harmony-separation-catalog'))[0]
      .sourceId
    await materializeCatalogHarmonySource({
      parentDir,
      catalogName: 'harmony-separation-catalog',
      sourceId,
      trackName: 'HARM2',
      sourceAudioPath: separatedOutput,
      provenance: {
        kind: 'isolated_separation_output/v1',
        separator: {
          id: 'demucs',
          version: 'v4',
          modelSha256: 'a'.repeat(64),
          configurationSha256: 'b'.repeat(64)
        }
      }
    })
    const catalogRoot = join(parentDir, 'harmony-separation-catalog')
    const record = JSON.parse(await readFile(join(catalogRoot, 'records.jsonl'), 'utf8')) as {
      audio: { mix: { asset_id: string; sha256: string } }
    }
    const policy = JSON.parse(
      await readFile(join(catalogRoot, 'vocal-harmony-sources.json'), 'utf8')
    ) as {
      records: Array<{
        provenance: {
          input: { asset_id: string; sha256: string }
          separator: { model_sha256: string }
        }
      }>
    }
    expect(policy.records[0].provenance.input).toEqual({
      asset_id: record.audio.mix.asset_id,
      sha256: record.audio.mix.sha256
    })
    expect(policy.records[0].provenance.separator.model_sha256).toBe('a'.repeat(64))
  })

  it('refuses shared catalog mix or vocals as a Harmony source and leaves the catalog untouched', async () => {
    const parentDir = join(testDir, 'harmony-no-fallback-parent')
    const songDir = join(testDir, 'harmony-no-fallback-song')
    await mkdir(parentDir, { recursive: true })
    await mkdir(songDir, { recursive: true })
    const sharedMix = Buffer.from('shared catalog mix')
    await writeFile(join(songDir, 'notes.mid'), namedTracksMidi(['PART VOCALS', 'HARM3']))
    await writeFile(join(songDir, 'song.ogg'), sharedMix)
    await writeFile(join(songDir, 'vocals.ogg'), Buffer.from('shared catalog vocals'))
    await writeFile(
      join(songDir, 'song.ini'),
      '[song]\nname = No Fallback\ndataset_opt_in = true\n'
    )
    const sharedSource = join(testDir, 'private-copy-of-mix.wav')
    await writeFile(sharedSource, sharedMix)
    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'harmony-no-fallback-catalog',
      catalogId: 'harmony-no-fallback-catalog',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    const catalogRoot = join(parentDir, 'harmony-no-fallback-catalog')
    const before = await readFile(join(catalogRoot, 'records.jsonl'), 'utf8')
    const sourceId = (await listCatalogHarmonyTargets(parentDir, 'harmony-no-fallback-catalog'))[0]
      .sourceId
    await expect(
      materializeCatalogHarmonySource({
        parentDir,
        catalogName: 'harmony-no-fallback-catalog',
        sourceId,
        trackName: 'HARM3',
        sourceAudioPath: sharedSource,
        provenance: { kind: 'isolated_source_stem/v1', attestationId: 'not-a-fallback' }
      })
    ).rejects.toThrow('must not duplicate')
    expect(await readFile(join(catalogRoot, 'records.jsonl'), 'utf8')).toBe(before)
    await expect(
      readFile(join(catalogRoot, 'vocal-harmony-sources.json'), 'utf8')
    ).rejects.toThrow()
  })

  it('keeps moved, deleted, and unreadable Harmony selections path-safe', async () => {
    const parentDir = join(testDir, 'harmony-private-source-errors-parent')
    const songDir = join(testDir, 'harmony-private-source-errors-song')
    await mkdir(parentDir, { recursive: true })
    await mkdir(songDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), namedTracksMidi(['PART VOCALS', 'HARM1']))
    await writeFile(
      join(songDir, 'song.ini'),
      '[song]\nname = Private source test\ndataset_opt_in = true\n'
    )
    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'harmony-private-source-errors',
      catalogId: 'harmony-private-source-errors',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    const sourceId = (
      await listCatalogHarmonyTargets(parentDir, 'harmony-private-source-errors')
    )[0].sourceId
    const materialize = async (sourceAudioPath: string): Promise<Error> => {
      try {
        await materializeCatalogHarmonySource({
          parentDir,
          catalogName: 'harmony-private-source-errors',
          sourceId,
          trackName: 'HARM1',
          sourceAudioPath,
          provenance: { kind: 'isolated_source_stem/v1', attestationId: 'private-source-test' }
        })
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        return error as Error
      }
      throw new Error('Expected Harmony materialization to reject the selected source.')
    }
    const expectUnavailable = async (sourceAudioPath: string): Promise<void> => {
      const error = await materialize(sourceAudioPath)
      expect(error.message).toBe('Selected Harmony audio is unavailable or unsupported.')
      expect(error.message).not.toContain(sourceAudioPath)
      expect(error.message).not.toContain('private-harmony-source')
    }

    const deleted = join(testDir, 'private-harmony-source-deleted.wav')
    await writeFile(deleted, 'deleted audio')
    await rm(deleted)
    await expectUnavailable(deleted)

    const moved = join(testDir, 'private-harmony-source-moved.wav')
    await writeFile(moved, 'moved audio')
    await rename(moved, join(testDir, 'moved-private-harmony-source.wav'))
    await expectUnavailable(moved)

    const unreadable = join(testDir, 'private-harmony-source-unreadable.wav')
    await writeFile(unreadable, 'unreadable audio')
    await chmod(unreadable, 0o000)
    try {
      await expectUnavailable(unreadable)
    } finally {
      await chmod(unreadable, 0o600)
    }
  })

  it('rejects a selected Harmony symlink without revealing its private target', async () => {
    const parentDir = join(testDir, 'harmony-symlink-parent')
    const songDir = join(testDir, 'harmony-symlink-song')
    const privateTarget = join(testDir, 'private-harmony-target.wav')
    const selectedLink = join(testDir, 'selected-harmony-link.wav')
    await mkdir(parentDir, { recursive: true })
    await mkdir(songDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), namedTracksMidi(['PART VOCALS', 'HARM1']))
    await writeFile(
      join(songDir, 'song.ini'),
      '[song]\nname = Symlink source\ndataset_opt_in = true\n'
    )
    await writeFile(privateTarget, 'isolated but private harmony')
    await symlink(privateTarget, selectedLink)
    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'harmony-symlink-catalog',
      catalogId: 'harmony-symlink-catalog',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    const sourceId = (await listCatalogHarmonyTargets(parentDir, 'harmony-symlink-catalog'))[0]
      .sourceId
    let error: Error | undefined
    try {
      await materializeCatalogHarmonySource({
        parentDir,
        catalogName: 'harmony-symlink-catalog',
        sourceId,
        trackName: 'HARM1',
        sourceAudioPath: selectedLink,
        provenance: { kind: 'isolated_source_stem/v1', attestationId: 'symlink-test' }
      })
    } catch (reason) {
      error = reason as Error
    }
    expect(error?.message).toBe('Selected Harmony audio is unavailable or unsupported.')
    expect(error?.message).not.toContain(privateTarget)
    expect(error?.message).not.toContain(selectedLink)
  })

  it('recovers an expired valid mutation lease while preserving a live lease', async () => {
    const parentDir = join(testDir, 'harmony-lease-parent')
    const songDir = join(testDir, 'harmony-lease-song')
    const harmonySource = join(testDir, 'private-harmony-lease.wav')
    await mkdir(parentDir, { recursive: true })
    await mkdir(songDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), namedTracksMidi(['PART VOCALS', 'HARM1']))
    await writeFile(join(songDir, 'song.ini'), '[song]\nname = Lease\ndataset_opt_in = true\n')
    await writeFile(harmonySource, 'isolated harmony lease')
    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'harmony-lease-catalog',
      catalogId: 'harmony-lease-catalog',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    const sourceId = (await listCatalogHarmonyTargets(parentDir, 'harmony-lease-catalog'))[0]
      .sourceId
    const reservationPath = join(parentDir, '.harmony-lease-catalog.mutation-reservation')
    await writeMutationReservation(reservationPath)
    await expect(
      materializeCatalogHarmonySource({
        parentDir,
        catalogName: 'harmony-lease-catalog',
        sourceId,
        trackName: 'HARM1',
        sourceAudioPath: harmonySource,
        provenance: { kind: 'isolated_source_stem/v1', attestationId: 'live-lease' }
      })
    ).rejects.toThrow('A catalog mutation with that name is already in progress.')
    await rm(reservationPath, { force: true })

    await writeMutationReservation(reservationPath, {
      ageMs: 11 * 60 * 1000,
      // Linux PID values are bounded well below this and kill(..., 0) reports
      // ESRCH, proving this is a crash-stale lease rather than a live owner.
      ownerPid: 2 ** 31 - 1
    })
    await expect(
      materializeCatalogHarmonySource({
        parentDir,
        catalogName: 'harmony-lease-catalog',
        sourceId,
        trackName: 'HARM1',
        sourceAudioPath: harmonySource,
        provenance: { kind: 'isolated_source_stem/v1', attestationId: 'expired-lease' }
      })
    ).resolves.toMatchObject({ sourceId, trackName: 'HARM1', configuredTracks: ['HARM1'] })
  })

  it('does not reclaim an expired lease when its hostname matches but its boot instance differs', async () => {
    const parentDir = join(testDir, 'harmony-remote-owner-parent')
    const songDir = join(testDir, 'harmony-remote-owner-song')
    const harmonySource = join(testDir, 'private-harmony-remote-owner.wav')
    await mkdir(parentDir, { recursive: true })
    await mkdir(songDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), namedTracksMidi(['PART VOCALS', 'HARM1']))
    await writeFile(
      join(songDir, 'song.ini'),
      '[song]\nname = Remote owner\ndataset_opt_in = true\n'
    )
    await writeFile(harmonySource, 'isolated harmony remote owner')
    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'harmony-remote-owner-catalog',
      catalogId: 'harmony-remote-owner-catalog',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    const sourceId = (await listCatalogHarmonyTargets(parentDir, 'harmony-remote-owner-catalog'))[0]
      .sourceId
    const reservationPath = join(parentDir, '.harmony-remote-owner-catalog.mutation-reservation')
    await writeMutationReservation(reservationPath, {
      ageMs: 11 * 60 * 1000,
      ownerPid: 2 ** 31 - 1,
      ownerInstance: 'boot:00000000-0000-0000-0000-000000000000'
    })
    try {
      await expect(
        materializeCatalogHarmonySource({
          parentDir,
          catalogName: 'harmony-remote-owner-catalog',
          sourceId,
          trackName: 'HARM1',
          sourceAudioPath: harmonySource,
          provenance: { kind: 'isolated_source_stem/v1', attestationId: 'remote-owner' }
        })
      ).rejects.toThrow('A catalog mutation with that name is already in progress.')
    } finally {
      await rm(reservationPath, { force: true })
    }
  })

  it('serializes competing stale recovery until the new owner has acquired its reservation', async () => {
    const parentDir = join(testDir, 'harmony-recovery-race-parent')
    const songDir = join(testDir, 'harmony-recovery-race-song')
    const harmonySource = join(testDir, 'private-harmony-recovery-race.wav')
    await mkdir(parentDir, { recursive: true })
    await mkdir(songDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), namedTracksMidi(['PART VOCALS', 'HARM1']))
    await writeFile(
      join(songDir, 'song.ini'),
      '[song]\nname = Recovery race\ndataset_opt_in = true\n'
    )
    await writeFile(harmonySource, 'isolated harmony recovery race')
    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'harmony-recovery-race-catalog',
      catalogId: 'harmony-recovery-race-catalog',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    const sourceId = (
      await listCatalogHarmonyTargets(parentDir, 'harmony-recovery-race-catalog')
    )[0].sourceId
    const reservationPath = join(parentDir, '.harmony-recovery-race-catalog.mutation-reservation')
    await writeMutationReservation(reservationPath, {
      ageMs: 11 * 60 * 1000,
      ownerPid: 2 ** 31 - 1
    })

    let resumeRecovery: (() => void) | undefined
    let notifyStaleRemoved: (() => void) | undefined
    const staleRemoved = new Promise<void>((resolve) => {
      notifyStaleRemoved = resolve
    })
    const recoveryCanContinue = new Promise<void>((resolve) => {
      resumeRecovery = resolve
    })
    setCatalogMutationTestHooksForTesting({
      afterStaleReservationRemoved: async () => {
        notifyStaleRemoved?.()
        await recoveryCanContinue
      }
    })

    const materialize = (
      attestationId: string
    ): ReturnType<typeof materializeCatalogHarmonySource> =>
      materializeCatalogHarmonySource({
        parentDir,
        catalogName: 'harmony-recovery-race-catalog',
        sourceId,
        trackName: 'HARM1',
        sourceAudioPath: harmonySource,
        provenance: { kind: 'isolated_source_stem/v1', attestationId }
      })

    const first = materialize('recovery-owner')
    try {
      await staleRemoved
      // This contender observed the recovery-to-owner interval in the old
      // protocol. It must be stopped by the coordination inode before it can
      // read, rename, or remove either reservation.
      await expect(materialize('competing-reclaimer')).rejects.toThrow(
        'A catalog mutation with that name is already in progress.'
      )
      resumeRecovery?.()
      await expect(first).resolves.toMatchObject({
        sourceId,
        trackName: 'HARM1',
        configuredTracks: ['HARM1']
      })
      expect(
        await readFile(join(parentDir, 'harmony-recovery-race-catalog', 'records.jsonl'), 'utf8')
      ).toContain(sourceId)
    } finally {
      resumeRecovery?.()
      setCatalogMutationTestHooksForTesting(undefined)
      await first.catch(() => undefined)
    }
  })

  it('serializes real concurrent Harmony and catalog clone mutations', async () => {
    const parentDir = join(testDir, 'harmony-concurrency-parent')
    const songDir = join(testDir, 'harmony-concurrency-song')
    const harmonySource = join(testDir, 'private-harmony-concurrency.wav')
    await mkdir(parentDir, { recursive: true })
    await mkdir(songDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), namedTracksMidi(['PART VOCALS', 'HARM1']))
    await writeFile(
      join(songDir, 'song.ini'),
      '[song]\nname = Concurrency\ndataset_opt_in = true\n'
    )
    await writeFile(harmonySource, 'isolated harmony concurrency')
    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'harmony-concurrency-catalog',
      catalogId: 'harmony-concurrency-catalog',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    const sourceId = (await listCatalogHarmonyTargets(parentDir, 'harmony-concurrency-catalog'))[0]
      .sourceId
    const results = await Promise.allSettled([
      materializeCatalogHarmonySource({
        parentDir,
        catalogName: 'harmony-concurrency-catalog',
        sourceId,
        trackName: 'HARM1',
        sourceAudioPath: harmonySource,
        provenance: { kind: 'isolated_source_stem/v1', attestationId: 'concurrency-stem' }
      }),
      buildSongSourceCatalog({
        sources: [{ kind: 'octave-library', sourcePath: songDir }],
        parentDir,
        catalogName: 'harmony-concurrency-clone',
        catalogId: 'harmony-concurrency-clone',
        provenance: 'Reviewed',
        license: 'test-only',
        octaveVersion: 'test',
        mode: 'clone',
        sourceCatalogName: 'harmony-concurrency-catalog'
      })
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect((rejected as PromiseRejectedResult).reason).toEqual(
      expect.objectContaining({
        message: 'A catalog mutation with that name is already in progress.'
      })
    )
  })

  it('shares one catalog mutation reservation across Harmony and generic catalog updates/clones', async () => {
    const parentDir = join(testDir, 'harmony-mutation-reservation-parent')
    const songDir = join(testDir, 'harmony-mutation-reservation-song')
    const harmonySource = join(testDir, 'private-harmony-mutation.wav')
    await mkdir(parentDir, { recursive: true })
    await mkdir(songDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), namedTracksMidi(['PART VOCALS', 'HARM1']))
    await writeFile(
      join(songDir, 'song.ini'),
      '[song]\nname = Reservation\ndataset_opt_in = true\n'
    )
    await writeFile(harmonySource, 'isolated harmony')
    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'harmony-mutation-reservation',
      catalogId: 'harmony-mutation-reservation',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    const sourceId = (await listCatalogHarmonyTargets(parentDir, 'harmony-mutation-reservation'))[0]
      .sourceId
    const catalogRoot = join(parentDir, 'harmony-mutation-reservation')
    const beforeRecords = await readFile(join(catalogRoot, 'records.jsonl'), 'utf8')
    const reservationPath = join(parentDir, '.harmony-mutation-reservation.mutation-reservation')
    await writeFile(reservationPath, 'active mutation')
    try {
      const results = await Promise.allSettled([
        materializeCatalogHarmonySource({
          parentDir,
          catalogName: 'harmony-mutation-reservation',
          sourceId,
          trackName: 'HARM1',
          sourceAudioPath: harmonySource,
          provenance: { kind: 'isolated_source_stem/v1', attestationId: 'reservation-stem' }
        }),
        buildSongSourceCatalog({
          sources: [],
          parentDir,
          catalogName: 'harmony-mutation-reservation',
          catalogId: 'ignored-update-id',
          provenance: 'Reviewed',
          license: 'test-only',
          octaveVersion: 'test',
          mode: 'update'
        }),
        buildSongSourceCatalog({
          sources: [{ kind: 'octave-library', sourcePath: songDir }],
          parentDir,
          catalogName: 'harmony-mutation-reservation-clone',
          catalogId: 'harmony-mutation-reservation-clone',
          provenance: 'Reviewed',
          license: 'test-only',
          octaveVersion: 'test',
          mode: 'clone',
          sourceCatalogName: 'harmony-mutation-reservation'
        })
      ])
      for (const result of results) {
        expect(result.status).toBe('rejected')
        if (result.status === 'rejected') {
          expect((result.reason as Error).message).toBe(
            'A catalog mutation with that name is already in progress.'
          )
        }
      }
      expect(await readFile(join(catalogRoot, 'records.jsonl'), 'utf8')).toBe(beforeRecords)
      await expect(
        readFile(join(catalogRoot, 'vocal-harmony-sources.json'), 'utf8')
      ).rejects.toThrow()
    } finally {
      await rm(reservationPath, { force: true })
    }

    const cloneReservationPath = join(
      parentDir,
      '.harmony-mutation-reservation-clone.mutation-reservation'
    )
    await writeFile(cloneReservationPath, 'active mutation')
    try {
      await expect(
        buildSongSourceCatalog({
          sources: [{ kind: 'octave-library', sourcePath: songDir }],
          parentDir,
          catalogName: 'harmony-mutation-reservation-clone',
          catalogId: 'harmony-mutation-reservation-clone',
          provenance: 'Reviewed',
          license: 'test-only',
          octaveVersion: 'test',
          mode: 'clone',
          sourceCatalogName: 'harmony-mutation-reservation'
        })
      ).rejects.toThrow('A catalog mutation with that name is already in progress.')
      expect(await readFile(join(catalogRoot, 'records.jsonl'), 'utf8')).toBe(beforeRecords)
    } finally {
      await rm(cloneReservationPath, { force: true })
    }
  })
})
