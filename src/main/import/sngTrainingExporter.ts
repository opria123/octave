import { createHash, randomUUID } from 'crypto'
import { constants, createReadStream } from 'fs'
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from 'fs/promises'
import { hostname } from 'os'
import * as path from 'path'
import { Readable } from 'stream'
import { Midi } from '@tonejs/midi'
import AdmZip from 'adm-zip'
import Ajv2020 from 'ajv/dist/2020'
import { SngStream, type SngHeader } from 'parse-sng'
import { parseIniFile } from '../../shared/iniFile'
import catalogSchema from '../../../docs/reference/song-source-catalog.schema.json'
import { StfsParser } from './conImporter'
import { parseDta } from './dtaParser'
import { decryptMoggBuffer } from './moggDecrypt'
import { readInventoryPackageSnapshot } from './packageSourceInventory'
import { normalizedPackageEntryLocator, packageEntryIdentity } from './packageSourceIdentity'

const EXPORT_FORMAT = 'octave-training-midi-export/v1'
const NOTES_MIDI = 'notes.mid'
const EXPORTED_METADATA_KEYS = ['name', 'artist', 'album', 'genre', 'year', 'charter'] as const
const MAX_METADATA_VALUE_LENGTH = 512
const MAX_ZIP_ENTRIES = 2_000
const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_AUDIO_ASSET_BYTES = 512 * 1024 * 1024
// A malformed package must not hold a catalog mutation indefinitely. This is
// deliberately generous for legitimate packages with several large audio
// streams, while still giving every selected package a bounded outcome.
const SNG_EXTRACTION_TIMEOUT_MS = 2 * 60 * 1000
const AUDIO_EXTENSIONS = ['ogg', 'mp3', 'opus', 'wav', 'flac'] as const
const CATALOG_SCHEMA_ID =
  'https://octavestudio.tools/schemas/song-source-catalog/v1/catalog.schema.json'
const catalogAjv = new Ajv2020({ allErrors: true, strict: false })
const validateCatalogManifestSchema = catalogAjv.compile(catalogSchema)
const validateCatalogRecordSchema = catalogAjv.compile({
  $ref: `${CATALOG_SCHEMA_ID}#/$defs/record`
})

export interface SngTrainingExportOptions {
  /** Explicitly selected Clone Hero packages. */
  sngPaths: readonly string[]
  /** Explicitly selected Rock Band CON/RB3CON packages. */
  conPaths?: readonly string[]
  /** Octave song folders. Only entries with dataset_opt_in = true are exported. */
  librarySongPaths?: readonly string[]
  outputDir: string
  datasetId: string
  provenance: string
  license: string
}

interface ExportedSong {
  songId: string
  midi: string
  notesSha256: string
  /** Hash of the selected package, when the source is a package. */
  packageSha256?: string
  source: 'octave-library' | 'sng' | 'rb3con'
  metadata: Record<string, string>
}

export interface SngTrainingExportResult {
  manifestPath: string
  exported: ExportedSong[]
  skipped: Array<{ sourceIndex: number; reason: string }>
}

export interface DatasetLibrarySong {
  path: string
  name: string
  artist: string
  charter?: string
  datasetOptIn: boolean
  isStrumGenerated: boolean
  hasNotesMidi: boolean
}

export type DatasetSourceKind = 'octave-library' | 'sng' | 'rb3con' | 'zip'

/** Source locations stay in the main process and are never rendered or written to a catalog. */
export interface DatasetCatalogSource {
  kind: DatasetSourceKind
  sourcePath: string
  /**
   * Opaque, content-addressed selection for one song contained in a multi-song
   * package. This is kept in the main process and is never written to a catalog.
   */
  entryId?: string
  /**
   * Main-process-only review proof for an external package entry.  This is
   * intentionally absent from catalogs, IPC DTOs, task views, and logs.
   */
  packageReview?: {
    containerSha256: string
    midiSha256: string
    entryLocator: string
  }
}

export interface DatasetSourceSummary {
  kind: DatasetSourceKind
  songCount: number
  metadata: Record<string, string>
  midiValid: boolean
  instruments: Record<
    string,
    { status: 'present' | 'absent'; difficulties: string[]; trackNames: string[] }
  >
  trainingUse: 'allowed' | 'review_required'
  warnings: Array<{ code: string }>
  isStrumGenerated: boolean
}

interface CatalogCandidate {
  kind: DatasetSourceKind
  midi: Buffer
  metadata: Record<string, string>
  audio: Partial<Record<CatalogAudioRole, CatalogAudioInput>>
  isStrumGenerated: boolean
  containerSha256?: string
  /** Adapter-private stable key used only for matching an opaque entry ID. */
  entryLocator: string
  /** Main-process UI admission state; never serialized to a catalog record. */
  requiresOptIn: boolean
}

type CatalogAudioRole =
  | 'mix'
  | 'drums'
  | 'guitar'
  | 'bass'
  | 'keys'
  | 'vocals'
  | 'harm1'
  | 'harm2'
  | 'harm3'
  | 'other'

type HarmonyTrackName = 'HARM1' | 'HARM2' | 'HARM3'
type HarmonyAudioRole = 'harm1' | 'harm2' | 'harm3'

const HARMONY_TRACK_AUDIO_ROLE: Record<HarmonyTrackName, HarmonyAudioRole> = {
  HARM1: 'harm1',
  HARM2: 'harm2',
  HARM3: 'harm3'
}
const HARMONY_SOURCE_POLICY_FILENAME = 'vocal-harmony-sources.json'
const HARMONY_SOURCE_POLICY_FORMAT = 'octave-vocal-harmony-source-policy/v1'
const HARMONY_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/
const HARMONY_SHA256_PATTERN = /^[a-f0-9]{64}$/
const CATALOG_MUTATION_RESERVATION_FORMAT = 'octave-catalog-mutation-reservation/v2'
const CATALOG_MUTATION_LEASE_MS = 10 * 60 * 1000
const CATALOG_MUTATION_HEARTBEAT_MS = 15 * 1000
const MAX_CATALOG_MUTATION_RESERVATION_BYTES = 1024
const CATALOG_MUTATION_COORDINATION_SUFFIX = '.coordination'
const CATALOG_MUTATION_OWNER_INSTANCE_PREFIX = 'boot:'

interface CatalogAudioInput {
  bytes: Buffer
  extension: (typeof AUDIO_EXTENSIONS)[number]
  mediaType: string
}

interface CatalogAsset {
  asset_id: string
  sha256: string
  relative_path: string
  byte_length: number
  media_type: string
}

export interface CatalogHarmonyTarget {
  sourceId: string
  label: string
  tracks: HarmonyTrackName[]
  configuredTracks: HarmonyTrackName[]
}

export interface MaterializeCatalogHarmonySourceOptions {
  parentDir: string
  catalogName: string
  sourceId: string
  trackName: HarmonyTrackName
  sourceAudioPath: string
  provenance:
    | {
        kind: 'isolated_source_stem/v1'
        attestationId: string
      }
    | {
        kind: 'isolated_separation_output/v1'
        separator: {
          id: string
          version: string
          modelSha256: string
          configurationSha256: string
        }
      }
}

export interface MaterializeCatalogHarmonySourceResult {
  sourceId: string
  trackName: HarmonyTrackName
  configuredTracks: HarmonyTrackName[]
}

export interface SongSourceCatalogResult {
  catalogPath: string
  recordCount: number
  skipped: Array<{ sourceIndex: number; reason: string }>
}

/** A renderer-safe per-song summary for a selected package. */
export interface DatasetSourceEntrySummary extends DatasetSourceSummary {
  /** Opaque content hash used only by OCTAVE to keep a multi-song selection stable. */
  entryId: string
}

export type SongSourceCatalogWriteMode = 'create' | 'update' | 'clone'

export interface SongSourceCatalogSummary {
  catalogName: string
  catalogId: string
  provenance: string
  license: string
  recordCount: number
  libraryRecordCount: number
  externalRecordCount: number
}

type CatalogCuration = {
  provenance: string
  license: string
}

export interface SongSourceCatalogProgress {
  phase: 'normalizing' | 'materializing' | 'validating'
  completed: number
  total: number
}

/**
 * A narrow, clone-only revision operation. It binds one already-reviewed
 * package chart to an existing materialized chart by MIDI hash, then changes
 * only same-named audio roles. Source locations and review evidence remain
 * main-process-only in `source`.
 */
export interface SongSourceCatalogAudioEnrichmentOptions {
  source: DatasetCatalogSource
  parentDir: string
  /** New revision directory name. It must not exist. */
  catalogName: string
  /** New revision catalog ID. */
  catalogId: string
  /** Existing catalog to clone. */
  sourceCatalogName: string
  octaveVersion: string
  onProgress?: (progress: SongSourceCatalogProgress) => void
}

function slug(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return normalized || 'unknown-song'
}

function sanitizeMetadata(
  metadata: Record<string, string | number | undefined>
): Record<string, string> {
  const sanitized: Record<string, string> = {}
  for (const key of EXPORTED_METADATA_KEYS) {
    const rawValue = metadata[key]
    if (rawValue === undefined || rawValue === '') continue
    const value = String(rawValue)
    const withoutControls = Array.from(value, (character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character
    }).join('')
    const normalized = withoutControls.normalize('NFKC').trim().slice(0, MAX_METADATA_VALUE_LENGTH)
    if (normalized) sanitized[key] = normalized
  }
  return sanitized
}

const GENERATED_REVISION_UNVERIFIED = 'generated_revision_unverified'
const GENERATED_TRAINING_BLOCKED_MESSAGE =
  'Generated chart training is unavailable until OCTAVE can verify manual edits and approval against a preserved baseline.'

// A consent boolean, changed metadata, or changed MIDI bytes is not evidence of
// a meaningful human correction. No canonical baseline/accepted-revision store
// exists yet, so recognized generated sources remain inadmissible in every path.
function assertSupervisedSourceAdmission(candidate: { isStrumGenerated: boolean }): void {
  if (candidate.isStrumGenerated) throw new Error(GENERATED_TRAINING_BLOCKED_MESSAGE)
}

function isDatasetOptedIn(value: unknown): boolean {
  return value === true || value === 1 || /^(?:1|true|yes)$/i.test(String(value ?? '').trim())
}

function isStrumGenerated(metadata: Record<string, string | number>): boolean {
  return (
    /^strum$/i.test(String(metadata.charter ?? '').trim()) ||
    /^(?:1|true|yes)$/i.test(String(metadata.strum_generated ?? '').trim())
  )
}

function hasValidMidiChunkLayout(midiBytes: Buffer): boolean {
  if (
    midiBytes.length < 14 ||
    midiBytes.subarray(0, 4).toString('ascii') !== 'MThd' ||
    midiBytes.readUInt32BE(4) !== 6
  ) {
    return false
  }

  const trackCount = midiBytes.readUInt16BE(10)
  if (trackCount === 0) return false
  let offset = 14
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    if (
      offset + 8 > midiBytes.length ||
      midiBytes.subarray(offset, offset + 4).toString('ascii') !== 'MTrk'
    ) {
      return false
    }
    const trackLength = midiBytes.readUInt32BE(offset + 4)
    offset += 8
    if (trackLength > midiBytes.length - offset) return false
    offset += trackLength
  }
  return offset === midiBytes.length
}

function isValidMidi(midiBytes: Buffer): boolean {
  try {
    return hasValidMidiChunkLayout(midiBytes) && Boolean(new Midi(midiBytes))
  } catch {
    return false
  }
}

function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

async function sha256File(filePath: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) digest.update(chunk)
  return digest.digest('hex')
}

async function drain(fileStream: ReadableStream<Uint8Array>): Promise<void> {
  for await (const chunk of Readable.fromWeb(
    fileStream as import('stream/web').ReadableStream<Uint8Array>
  )) {
    void chunk
  }
}

type SngFileContinuation = (() => void) | null

export interface SngExtractionParser {
  on(event: 'header', listener: (header: SngHeader) => void): void
  on(
    event: 'file',
    listener: (
      fileName: string,
      fileStream: ReadableStream<Uint8Array>,
      nextFile: SngFileContinuation
    ) => void
  ): void
  on(event: 'error', listener: (error: unknown) => void): void
  start(): void
}

export interface SngExtractionTestHooks {
  /** Kept test-only so production ingestion always uses the bounded default. */
  timeoutMs?: number
  /** Allows a stalled parser harness without exposing parser failures through IPC. */
  createParser?: (source: ReadableStream<Uint8Array>) => SngExtractionParser
}

let sngExtractionTestHooks: SngExtractionTestHooks | undefined

/** Test-only parser seam; it is never reachable through IPC or catalog records. */
export function setSngExtractionTestHooksForTesting(
  hooks: SngExtractionTestHooks | undefined
): void {
  sngExtractionTestHooks = hooks
}

function sngExtractionTimeoutMs(): number {
  const timeoutMs = sngExtractionTestHooks?.timeoutMs
  return timeoutMs !== undefined && Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : SNG_EXTRACTION_TIMEOUT_MS
}

function isCatalogAudioExtension(value: string): value is (typeof AUDIO_EXTENSIONS)[number] {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(value)
}

function catalogAudioInput(
  fileName: string,
  bytes: Buffer
): [CatalogAudioRole, CatalogAudioInput] | null {
  if (bytes.length > MAX_AUDIO_ASSET_BYTES) throw new Error('Audio asset is too large.')
  const normalized = fileName.replace(/\\/g, '/')
  const baseName = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  const match = /^(.+)\.(ogg|mp3|opus|wav|flac)$/.exec(baseName)
  if (!match) return null
  const [, stem, extension] = match
  if (!isCatalogAudioExtension(extension)) return null
  const role: CatalogAudioRole | undefined =
    stem === 'song' || stem === 'backing'
      ? 'mix'
      : stem === 'drums' || stem === 'drum'
        ? 'drums'
        : stem === 'guitar'
          ? 'guitar'
          : stem === 'bass'
            ? 'bass'
            : stem === 'keys' || stem === 'key'
              ? 'keys'
              : stem === 'vocals' || /^vocals_[0-9]+$/.test(stem)
                ? 'vocals'
                : stem === 'other'
                  ? 'other'
                  : undefined
  if (!role) return null
  const mediaType =
    extension === 'ogg'
      ? 'audio/ogg'
      : extension === 'opus'
        ? 'audio/opus'
        : extension === 'mp3'
          ? 'audio/mpeg'
          : extension === 'wav'
            ? 'audio/wav'
            : 'audio/flac'
  return [role, { bytes, extension, mediaType }]
}

function addCatalogAudioInput(
  audio: Partial<Record<CatalogAudioRole, CatalogAudioInput>>,
  input: [CatalogAudioRole, CatalogAudioInput]
): void {
  const [role, value] = input
  // The catalog has one asset per role. Retaining the first matching filename
  // makes a package's entry order part of training provenance; it is unsafe
  // for alternate mix/vocal inputs in particular.
  if (audio[role]) throw new Error(`Package contains multiple ${role} audio assets.`)
  audio[role] = value
}

function isValidCatalogAudioBytes(input: CatalogAudioInput): boolean {
  const { bytes, extension } = input
  if (!bytes.length) return false
  if (extension === 'ogg' || extension === 'opus') {
    return bytes.subarray(0, 4).equals(Buffer.from('OggS'))
  }
  if (extension === 'wav') {
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).equals(Buffer.from('RIFF')) &&
      bytes.subarray(8, 12).equals(Buffer.from('WAVE'))
    )
  }
  if (extension === 'flac') return bytes.subarray(0, 4).equals(Buffer.from('fLaC'))
  // An MP3 may have an ID3 tag or begin directly with a valid MPEG frame.
  return (
    bytes.subarray(0, 3).equals(Buffer.from('ID3')) ||
    (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  )
}

function assertSafeAlternateAudio(
  audio: Partial<Record<CatalogAudioRole, CatalogAudioInput>>
): void {
  const entries = Object.entries(audio) as Array<[CatalogAudioRole, CatalogAudioInput]>
  if (!entries.length) throw new Error('Selected chart has no supported alternate audio assets.')
  for (const [, input] of entries) {
    if (!isValidCatalogAudioBytes(input))
      throw new Error('Selected chart has invalid alternate audio.')
  }
  const mix = audio.mix
  const vocals = audio.vocals
  if (mix && vocals && sha256Buffer(mix.bytes) === sha256Buffer(vocals.bytes)) {
    throw new Error('Selected chart reuses one audio asset for mix and vocals.')
  }
}

async function readCatalogAudioFromFolder(
  sourcePath: string,
  rejectDuplicateRoles = false
): Promise<Partial<Record<CatalogAudioRole, CatalogAudioInput>>> {
  const audio: Partial<Record<CatalogAudioRole, CatalogAudioInput>> = {}
  const entries = await readdir(sourcePath, { withFileTypes: true })
  for (const entry of entries
    .filter((candidate) => candidate.isFile() && /\.(ogg|mp3|opus|wav|flac)$/i.test(candidate.name))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const bytes = await readFile(path.join(sourcePath, entry.name))
    const input = catalogAudioInput(entry.name, bytes)
    if (input && (rejectDuplicateRoles || !audio[input[0]])) addCatalogAudioInput(audio, input)
  }
  return audio
}

async function extractSngNotesMidi(
  sngSource: string | Buffer,
  includeAudio = true,
  rejectDuplicateRoles = false
): Promise<{
  midi: Buffer
  entryLocator: string
  metadata: Record<string, string>
  audio: Partial<Record<CatalogAudioRole, CatalogAudioInput>>
  isStrumGenerated: boolean
} | null> {
  return await new Promise((resolve, reject) => {
    let settled = false
    let metadata: Record<string, string> | null = null
    let generatedByStrum = false
    let notesMidi: Buffer | null = null
    let expectedFileCount: number | null = null
    let completedFileCount = 0
    let activeFileStream: ReadableStream<Uint8Array> | null = null
    const audio: Partial<Record<CatalogAudioRole, CatalogAudioInput>> = {}
    const input =
      typeof sngSource === 'string' ? createReadStream(sngSource) : Readable.from([sngSource])
    // A close caused by our cleanup should not become an unhandled Node stream
    // error. The parser still receives read failures through its Web stream.
    input.on('error', () => undefined)
    const timeout = setTimeout(() => {
      fail(new Error('SNG package extraction timed out.'))
    }, sngExtractionTimeoutMs())
    const stopStreams = (): void => {
      if (activeFileStream) {
        void activeFileStream.cancel('SNG package extraction stopped.').catch(() => undefined)
      }
      if (!input.destroyed) input.destroy()
    }
    const settle = (callback: () => void, stop = false): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (stop) stopStreams()
      callback()
    }
    const fail = (error: unknown): void =>
      settle(() => reject(error instanceof Error ? error : new Error(String(error))), true)
    const source = Readable.toWeb(input) as ReadableStream<Uint8Array>
    const sngStream =
      sngExtractionTestHooks?.createParser?.(source) ??
      new SngStream(source, { generateSongIni: false })

    sngStream.on('header', (header: SngHeader) => {
      metadata = sanitizeMetadata(header.metadata)
      generatedByStrum = isStrumGenerated(header.metadata)
      expectedFileCount = header.fileMeta.length
      if (expectedFileCount === 0) settle(() => resolve(null), true)
    })
    sngStream.on('file', (fileName, fileStream, nextFile) => {
      void (async () => {
        if (settled) {
          await fileStream.cancel('SNG package extraction already settled.').catch(() => undefined)
          return
        }
        if (expectedFileCount === null || completedFileCount >= expectedFileCount) {
          throw new Error('SNG package file sequence is invalid.')
        }
        activeFileStream = fileStream
        if (fileName.toLowerCase() === NOTES_MIDI) {
          if (notesMidi) throw new Error(`Package contains multiple ${NOTES_MIDI} files`)
          const chunks: Buffer[] = []
          for await (const chunk of Readable.fromWeb(
            fileStream as import('stream/web').ReadableStream<Uint8Array>
          )) {
            chunks.push(Buffer.from(chunk))
          }
          notesMidi = Buffer.concat(chunks)
        } else if (includeAudio && /\.(ogg|mp3|opus|wav|flac)$/i.test(fileName)) {
          const chunks: Buffer[] = []
          let byteLength = 0
          for await (const chunk of Readable.fromWeb(
            fileStream as import('stream/web').ReadableStream<Uint8Array>
          )) {
            byteLength += chunk.length
            if (byteLength > MAX_AUDIO_ASSET_BYTES) throw new Error('Package audio is too large.')
            chunks.push(Buffer.from(chunk))
          }
          const input = catalogAudioInput(fileName, Buffer.concat(chunks))
          if (input && (rejectDuplicateRoles || !audio[input[0]]))
            addCatalogAudioInput(audio, input)
        } else {
          await drain(fileStream as ReadableStream<Uint8Array>)
        }
        activeFileStream = null
        completedFileCount += 1
        // parse-sng exposes completion only through the final file's null
        // continuation. Some real streams drain that final payload but never
        // provide the expected terminal continuation. The authenticated header
        // already declares the exact file count, so only accept after every
        // declared stream has drained; never accept a partial package.
        if (completedFileCount === expectedFileCount) {
          settle(
            () =>
              resolve(
                notesMidi && metadata
                  ? {
                      midi: notesMidi,
                      entryLocator: NOTES_MIDI,
                      metadata,
                      audio,
                      isStrumGenerated: generatedByStrum
                    }
                  : null
              ),
            true
          )
          return
        }
        if (!nextFile) throw new Error('SNG package ended before all declared files were read.')
        nextFile()
      })().catch(fail)
    })
    sngStream.on('error', fail)
    sngStream.start()
  })
}

function findConMidi(
  entries: Record<string, Buffer>,
  shortname: string,
  allowGlobalFallback: boolean
): Buffer | null {
  const short = shortname.toLowerCase()
  for (const [entryPath, value] of Object.entries(entries)) {
    const normalized = entryPath.toLowerCase().replace(/\\/g, '/')
    if (normalized === `${short}.mid` || normalized.endsWith(`/${short}.mid`)) return value
  }
  if (!allowGlobalFallback) return null
  for (const [entryPath, value] of Object.entries(entries)) {
    if (entryPath.toLowerCase().endsWith('.mid')) return value
  }
  return null
}

function findConMogg(
  entries: Record<string, Buffer>,
  shortname: string,
  allowGlobalFallback: boolean,
  requireUnique = false
): Buffer | null {
  const short = shortname.toLowerCase()
  const exactMatches: Buffer[] = []
  for (const [entryPath, value] of Object.entries(entries)) {
    const normalized = entryPath.toLowerCase().replace(/\\/g, '/')
    if (normalized === `${short}.mogg` || normalized.endsWith(`/${short}.mogg`)) {
      exactMatches.push(value)
    }
  }
  if (exactMatches.length) {
    if (requireUnique && exactMatches.length !== 1) {
      throw new Error('RB3CON contains ambiguous audio assets.')
    }
    return exactMatches[0]
  }
  if (!allowGlobalFallback) return null
  const fallbackMatches: Buffer[] = []
  for (const [entryPath, value] of Object.entries(entries)) {
    if (entryPath.toLowerCase().endsWith('.mogg')) fallbackMatches.push(value)
  }
  if (requireUnique && fallbackMatches.length > 1) {
    throw new Error('RB3CON contains ambiguous audio assets.')
  }
  return fallbackMatches[0] ?? null
}

async function extractConNotesMidi(
  conSource: string | Buffer,
  includeAudio = true,
  rejectDuplicateRoles = false
): Promise<
  Array<{
    midi: Buffer
    entryLocator: string
    metadata: Record<string, string>
    audio: Partial<Record<CatalogAudioRole, CatalogAudioInput>>
    isStrumGenerated: boolean
  }>
> {
  const parser = new StfsParser(
    typeof conSource === 'string' ? await readFile(conSource) : conSource
  )
  const { entries } = parser.parse()
  const dta = Object.entries(entries).find(([entryPath]) =>
    entryPath.toLowerCase().endsWith('songs/songs.dta')
  )?.[1]
  if (!dta) throw new Error('Could not find songs.dta in the STFS container.')
  const songs = Object.values(parseDta(dta.toString('latin1')))
  const isSingleSongPack = songs.length === 1
  return songs.flatMap((song) => {
    const midi = findConMidi(entries, song.shortname, isSingleSongPack)
    if (!midi) return []
    const mogg = findConMogg(entries, song.shortname, isSingleSongPack, rejectDuplicateRoles)
    let audio: Partial<Record<CatalogAudioRole, CatalogAudioInput>> = {}
    if (mogg && includeAudio) {
      try {
        const ogg = decryptMoggBuffer(mogg)
        const input = catalogAudioInput('song.ogg', ogg)
        if (input) audio = { [input[0]]: input[1] }
      } catch {
        // A catalog can contain a valid chart without an audio mix.
      }
    }
    return [
      {
        midi,
        entryLocator: normalizedPackageEntryLocator(song.shortname),
        metadata: sanitizeMetadata({
          name: song.name,
          artist: song.artist,
          album: song.album,
          genre: song.genre,
          year: song.year,
          charter: 'C3'
        }),
        audio,
        isStrumGenerated: false
      }
    ]
  })
}

async function ensureEmptyOutputDir(outputDir: string): Promise<void> {
  try {
    if ((await readdir(outputDir)).length > 0)
      throw new Error(`Training export output directory must be empty: ${outputDir}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(outputDir, { recursive: true })
  }
}

function redactLocationText(value: string, fallback = 'Unknown'): string {
  const normalized = Array.from(value.normalize('NFKC'), (character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character
  })
    .join('')
    .replace(/(?:https?|smb|file):\/\/\S+/gi, '[redacted]')
    .replace(/(?:^|\s)(?:~?\/|[A-Za-z]:[\\/]|\\\\)[^\s]*/g, ' [redacted]')
    .replace(/\\/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_METADATA_VALUE_LENGTH)
  return normalized || fallback
}

function redactMetadata(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, redactLocationText(value)])
  )
}

const TRACK_INSTRUMENTS: Array<[string, string]> = [
  ['PART DRUMS', 'drums'],
  ['PART GUITAR', 'guitar'],
  ['PART BASS', 'bass'],
  ['PART KEYS', 'keys'],
  ['PART VOCALS', 'vocals'],
  ['PART REAL_KEYS', 'pro_keys'],
  ['PART REAL_GUITAR', 'pro_guitar'],
  ['PART REAL_BASS', 'pro_bass']
]

const HARMONY_TRACK_NAMES: readonly HarmonyTrackName[] = ['HARM1', 'HARM2', 'HARM3']

function discoverInstrumentCoverage(midiBytes: Buffer): DatasetSourceSummary['instruments'] {
  const coverage: DatasetSourceSummary['instruments'] = {}
  const midi = new Midi(midiBytes)
  for (const track of midi.tracks) {
    const trackName = track.name.trim()
    const harmonyTrack = HARMONY_TRACK_NAMES.find((name) => name === trackName.toUpperCase())
    const mapped = harmonyTrack
      ? ([harmonyTrack, 'vocals'] as const)
      : TRACK_INSTRUMENTS.find(([prefix]) => trackName.toUpperCase().startsWith(prefix))
    if (!mapped || track.notes.length === 0) continue
    const safeTrackName = redactLocationText(trackName, mapped[0])
    const [, instrument] = mapped
    const difficulties = new Set<string>()
    for (const note of track.notes) {
      if (note.midi >= 60 && note.midi <= 66) difficulties.add('easy')
      else if (note.midi >= 72 && note.midi <= 78) difficulties.add('medium')
      else if (note.midi >= 84 && note.midi <= 90) difficulties.add('hard')
      else if (note.midi >= 96 && note.midi <= 102) difficulties.add('expert')
    }
    // Vocal and pro tracks do not use the five-lane difficulty note ranges;
    // catalog v1 still requires a non-empty coverage level when present.
    if (difficulties.size === 0) difficulties.add('expert')
    coverage[instrument] = {
      status: 'present',
      difficulties: [...difficulties],
      trackNames: [...new Set([...(coverage[instrument]?.trackNames ?? []), safeTrackName])]
    }
  }
  return coverage
}

function safeZipEntryName(entryName: string): string | null {
  const normalized = entryName.replace(/\\/g, '/')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((part) => part === '..')
  ) {
    return null
  }
  return normalized
}

function extractZipNotesMidi(
  source: string | Buffer,
  includeAudio = true,
  rejectDuplicateRoles = false
): Array<{
  midi: Buffer
  entryLocator: string
  metadata: Record<string, string>
  audio: Partial<Record<CatalogAudioRole, CatalogAudioInput>>
  isStrumGenerated: boolean
}> {
  const archive = new AdmZip(source)
  const entries = archive.getEntries()
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error('ZIP archive has too many entries.')
  const files = new Map<string, AdmZip.IZipEntry>()
  for (const entry of entries) {
    const name = safeZipEntryName(entry.entryName)
    if (!name || entry.isDirectory) continue
    if (!Number.isSafeInteger(entry.header.size) || entry.header.size > MAX_ZIP_ENTRY_BYTES) {
      throw new Error('ZIP archive entry is too large.')
    }
    const normalizedName = name.toLowerCase()
    // ZIP names are case-sensitive, but catalog role selection is not. A
    // collision would otherwise overwrite one input before role validation
    // observes it (for example song.ogg and SONG.ogg).
    if (files.has(normalizedName)) throw new Error('ZIP archive has ambiguous entry names.')
    files.set(normalizedName, entry)
  }

  const candidates: Array<{
    midi: Buffer
    entryLocator: string
    metadata: Record<string, string>
    audio: Partial<Record<CatalogAudioRole, CatalogAudioInput>>
    isStrumGenerated: boolean
  }> = []
  for (const [name, entry] of files) {
    if (!name.endsWith(`/${NOTES_MIDI}`) && name !== NOTES_MIDI) continue
    const midi = entry.getData()
    if (midi.length > MAX_ZIP_ENTRY_BYTES) throw new Error('ZIP archive entry is too large.')
    const directory = name.slice(0, -NOTES_MIDI.length)
    const songIni = files.get(`${directory}song.ini`)
    const rawMetadata = songIni ? parseIniFile(songIni.getData().toString('utf8')) : {}
    const metadata = sanitizeMetadata(rawMetadata)
    const audio: Partial<Record<CatalogAudioRole, CatalogAudioInput>> = {}
    if (includeAudio) {
      for (const [entryName, audioEntry] of files) {
        const childName = entryName.slice(directory.length)
        if (!childName || childName.includes('/')) continue
        if (!/\.(ogg|mp3|opus|wav|flac)$/i.test(childName)) continue
        const bytes = audioEntry.getData()
        const input = catalogAudioInput(childName, bytes)
        if (input && (rejectDuplicateRoles || !audio[input[0]])) addCatalogAudioInput(audio, input)
      }
    }
    candidates.push({
      midi,
      entryLocator: normalizedPackageEntryLocator(directory),
      metadata,
      audio,
      isStrumGenerated: isStrumGenerated(rawMetadata)
    })
  }
  return candidates
}

async function inspectDatasetSource(
  source: DatasetCatalogSource,
  includeAudio = true,
  rejectDuplicateRoles = false
): Promise<CatalogCandidate[]> {
  const reviewedBytes = source.packageReview
    ? await readInventoryPackageSnapshot(source.sourcePath)
    : undefined
  if (
    source.packageReview &&
    sha256Buffer(reviewedBytes as Buffer) !== source.packageReview.containerSha256
  ) {
    throw new Error('Reviewed package changed or is unavailable.')
  }
  if (source.kind === 'sng') {
    const extracted = await extractSngNotesMidi(
      reviewedBytes ?? source.sourcePath,
      includeAudio,
      rejectDuplicateRoles
    )
    if (!extracted) return []
    const candidates = [
      {
        kind: source.kind,
        midi: extracted.midi,
        entryLocator: extracted.entryLocator,
        metadata: redactMetadata(extracted.metadata),
        audio: extracted.audio,
        isStrumGenerated: extracted.isStrumGenerated,
        containerSha256:
          source.packageReview?.containerSha256 ?? (await sha256File(source.sourcePath)),
        requiresOptIn: false
      }
    ]
    return selectedReviewedCatalogEntries(candidates, source)
  }
  if (source.kind === 'rb3con') {
    const containerSha256 =
      source.packageReview?.containerSha256 ?? (await sha256File(source.sourcePath))
    const candidates = (
      await extractConNotesMidi(
        reviewedBytes ?? source.sourcePath,
        includeAudio,
        rejectDuplicateRoles
      )
    ).map((candidate) => ({
      kind: source.kind,
      midi: candidate.midi,
      entryLocator: candidate.entryLocator,
      metadata: redactMetadata(candidate.metadata),
      audio: candidate.audio,
      isStrumGenerated: candidate.isStrumGenerated,
      containerSha256,
      requiresOptIn: false
    }))
    return selectedReviewedCatalogEntries(candidates, source)
  }
  if (source.kind === 'zip') {
    const containerSha256 =
      source.packageReview?.containerSha256 ?? (await sha256File(source.sourcePath))
    const candidates = extractZipNotesMidi(
      reviewedBytes ?? source.sourcePath,
      includeAudio,
      rejectDuplicateRoles
    ).map((candidate) => ({
      kind: source.kind,
      midi: candidate.midi,
      entryLocator: candidate.entryLocator,
      metadata: redactMetadata(candidate.metadata),
      audio: candidate.audio,
      isStrumGenerated: candidate.isStrumGenerated,
      containerSha256,
      requiresOptIn: false
    }))
    return selectedReviewedCatalogEntries(candidates, source)
  }
  const metadata = parseIniFile(await readFile(path.join(source.sourcePath, 'song.ini'), 'utf8'))
  const candidates = [
    {
      kind: source.kind,
      midi: await readFile(path.join(source.sourcePath, NOTES_MIDI)),
      entryLocator: NOTES_MIDI,
      metadata: redactMetadata(sanitizeMetadata(metadata)),
      audio: includeAudio
        ? await readCatalogAudioFromFolder(source.sourcePath, rejectDuplicateRoles)
        : {},
      isStrumGenerated: isStrumGenerated(metadata),
      requiresOptIn: !isDatasetOptedIn(metadata.dataset_opt_in)
    }
  ]
  return selectedReviewedCatalogEntries(candidates, source)
}

function catalogEntryId(candidate: CatalogCandidate): string {
  if (candidate.kind === 'sng' || candidate.kind === 'rb3con' || candidate.kind === 'zip') {
    return packageEntryIdentity(
      candidate.kind,
      candidate.containerSha256 ?? '',
      normalizedPackageEntryLocator(candidate.entryLocator),
      sha256Buffer(candidate.midi)
    )
  }
  return sha256Buffer(
    Buffer.from(
      `${candidate.kind}\u0000${normalizedPackageEntryLocator(candidate.entryLocator)}\u0000${sha256Buffer(candidate.midi)}`,
      'utf8'
    )
  )
}

function selectCatalogEntries(
  candidates: CatalogCandidate[],
  entryId: string | undefined
): CatalogCandidate[] {
  if (!entryId) return candidates
  if (!/^[a-f0-9]{64}$/.test(entryId)) return []
  return candidates.filter((candidate) => catalogEntryId(candidate) === entryId)
}

function selectedReviewedCatalogEntries(
  candidates: CatalogCandidate[],
  source: DatasetCatalogSource
): CatalogCandidate[] {
  const selected = selectCatalogEntries(candidates, source.entryId)
  if (!source.packageReview) return selected
  const review = source.packageReview
  const exact = selected.filter(
    (candidate) =>
      candidate.containerSha256 === review.containerSha256 &&
      normalizedPackageEntryLocator(candidate.entryLocator) ===
        normalizedPackageEntryLocator(review.entryLocator) &&
      sha256Buffer(candidate.midi) === review.midiSha256 &&
      catalogEntryId(candidate) === source.entryId
  )
  if (exact.length !== 1)
    throw new Error('Reviewed package changed or selected chart is unavailable.')
  return exact
}

function summarizeCatalogCandidate(candidate: CatalogCandidate): DatasetSourceSummary {
  const midiValid = isValidMidi(candidate.midi)
  return {
    kind: candidate.kind,
    songCount: 1,
    metadata: candidate.metadata,
    midiValid,
    instruments: midiValid ? discoverInstrumentCoverage(candidate.midi) : {},
    // This is a UI-only review state. Catalog records always serialize allowed.
    trainingUse:
      candidate.isStrumGenerated || candidate.requiresOptIn ? 'review_required' : 'allowed',
    warnings: [
      ...(midiValid ? [] : [{ code: 'invalid_notes_midi' }]),
      ...(candidate.isStrumGenerated ? [{ code: GENERATED_REVISION_UNVERIFIED }] : [])
    ],
    isStrumGenerated: candidate.isStrumGenerated
  }
}

/**
 * Returns one opaque, safe summary per contained song. In particular, ZIP
 * archives are deliberately not collapsed to their first song.
 */
export async function summarizeDatasetSourceEntries(
  source: DatasetCatalogSource
): Promise<DatasetSourceEntrySummary[]> {
  try {
    return (await inspectDatasetSource(source, false)).map((candidate) => ({
      ...summarizeCatalogCandidate(candidate),
      entryId: catalogEntryId(candidate)
    }))
  } catch {
    return []
  }
}

/** Returns a renderer-safe summary; original source locations and parser errors never leave main. */
export async function summarizeDatasetSource(
  source: DatasetCatalogSource
): Promise<DatasetSourceSummary> {
  try {
    const candidates = await inspectDatasetSource(source, false)
    const first = candidates[0]
    if (!first) {
      return {
        kind: source.kind,
        songCount: 0,
        metadata: {},
        midiValid: false,
        instruments: {},
        trainingUse: 'review_required',
        warnings: [{ code: 'missing_notes_midi' }],
        isStrumGenerated: false
      }
    }
    const midiValid = candidates.every((candidate) => isValidMidi(candidate.midi))
    return {
      kind: source.kind,
      songCount: candidates.length,
      metadata: first.metadata,
      midiValid,
      instruments: midiValid ? discoverInstrumentCoverage(first.midi) : {},
      trainingUse: summarizeCatalogCandidate(first).trainingUse,
      warnings: [
        ...(midiValid ? [] : [{ code: 'invalid_notes_midi' }]),
        ...(candidates.some((candidate) => candidate.isStrumGenerated)
          ? [{ code: GENERATED_REVISION_UNVERIFIED }]
          : [])
      ],
      isStrumGenerated: first.isStrumGenerated
    }
  } catch {
    return {
      kind: source.kind,
      songCount: 0,
      metadata: {},
      midiValid: false,
      instruments: {},
      trainingUse: 'review_required',
      warnings: [{ code: 'source_unavailable' }],
      isStrumGenerated: false
    }
  }
}

function validateCatalogName(name: string): string {
  const normalized = name.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error(
      'Catalog names may contain letters, numbers, dots, underscores, and dashes only.'
    )
  }
  return normalized
}

function catalogRecord(
  candidate: CatalogCandidate,
  notesAsset: CatalogAsset,
  notesSha256: string,
  audio: Partial<Record<CatalogAudioRole, CatalogAsset>>
): Record<string, unknown> {
  const sourceId = `octave-src-${notesSha256.slice(0, 24)}`
  const importRecord: Record<string, unknown> = {
    kind: candidate.kind === 'octave-library' ? 'song_folder' : candidate.kind,
    adapter_version:
      candidate.kind === 'sng'
        ? 'octave-sng/1'
        : candidate.kind === 'rb3con'
          ? 'octave-rb3con/1'
          : candidate.kind === 'zip'
            ? 'octave-zip/1'
            : 'octave-song-folder/1'
  }
  if (candidate.containerSha256) importRecord.container_sha256 = candidate.containerSha256
  return {
    source_id: sourceId,
    import: importRecord,
    rights: { training_use: 'allowed', provenance: '', license: '' },
    metadata: candidate.metadata,
    chart: {
      notes_midi: notesAsset,
      instruments: Object.fromEntries(
        Object.entries(discoverInstrumentCoverage(candidate.midi)).map(([instrument, coverage]) => [
          instrument,
          {
            status: coverage.status,
            difficulties: coverage.difficulties,
            track_names: coverage.trackNames
          }
        ])
      )
    },
    ...(Object.keys(audio).length ? { audio } : {})
  }
}

function validateCatalogRecord(record: Record<string, unknown>): void {
  if (!validateCatalogRecordSchema(record)) throw new Error('Catalog record validation failed.')
  const sourceId = record.source_id
  const rights = record.rights as { training_use?: string; provenance?: string; license?: string }
  const chart = record.chart as {
    notes_midi?: CatalogAsset
    instruments?: Record<
      string,
      { status?: string; difficulties?: unknown[]; track_names?: unknown[] }
    >
  }
  if (typeof sourceId !== 'string' || !/^octave-src-[a-z0-9][a-z0-9-]{7,127}$/.test(sourceId)) {
    throw new Error('Catalog record validation failed.')
  }
  if (!rights || rights.training_use !== 'allowed') {
    throw new Error('Catalog record validation failed.')
  }
  for (const value of [rights.provenance, rights.license]) {
    if (
      !value ||
      value.length > MAX_METADATA_VALUE_LENGTH ||
      /(?:https?:|smb:|file:|[A-Za-z]:[\\/])|(?:^|\s)\//i.test(value)
    ) {
      throw new Error('Catalog record validation failed.')
    }
  }
  for (const value of Object.values((record.metadata ?? {}) as Record<string, unknown>)) {
    if (
      typeof value !== 'string' ||
      !value ||
      value.length > MAX_METADATA_VALUE_LENGTH ||
      /(?:https?:|smb:|file:|[A-Za-z]:[\\/])|(?:^|\s)\//i.test(value)
    ) {
      throw new Error('Catalog record validation failed.')
    }
  }
  const notes = chart?.notes_midi
  const audio = record.audio as Partial<Record<CatalogAudioRole, CatalogAsset>> | undefined
  for (const asset of [notes, ...Object.values(audio ?? {})]) {
    if (
      !asset ||
      asset.asset_id !== `sha256:${asset.sha256}` ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !new RegExp(`^assets/sha256/${asset.sha256}/[A-Za-z0-9._-]+$`).test(asset.relative_path)
    ) {
      throw new Error('Catalog record validation failed.')
    }
  }
  for (const coverage of Object.values(chart.instruments ?? {})) {
    if (
      coverage.status !== 'present' ||
      !coverage.difficulties?.length ||
      !coverage.track_names?.length
    ) {
      throw new Error('Catalog record validation failed.')
    }
  }
}

function assertPathWithinCatalogRoot(catalogRoot: string, candidatePath: string): void {
  const relative = path.relative(catalogRoot, candidatePath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Catalog asset validation failed.')
  }
}

async function validateMaterializedAsset(catalogRoot: string, asset: CatalogAsset): Promise<void> {
  if (!new RegExp(`^assets/sha256/${asset.sha256}/[A-Za-z0-9._-]+$`).test(asset.relative_path)) {
    throw new Error('Catalog asset validation failed.')
  }
  const assetPath = path.resolve(catalogRoot, ...asset.relative_path.split('/'))
  assertPathWithinCatalogRoot(catalogRoot, assetPath)
  const assetInfo = await lstat(assetPath)
  if (assetInfo.isSymbolicLink() || !assetInfo.isFile() || assetInfo.size !== asset.byte_length) {
    throw new Error('Catalog asset validation failed.')
  }
  const realAssetPath = await realpath(assetPath)
  assertPathWithinCatalogRoot(catalogRoot, realAssetPath)
  const bytes = await readFile(realAssetPath)
  if (sha256Buffer(bytes) !== asset.sha256 || asset.asset_id !== `sha256:${asset.sha256}`) {
    throw new Error('Catalog asset validation failed.')
  }
}

async function materializeCatalogAsset(
  catalogRoot: string,
  bytes: Buffer,
  fileName: string,
  mediaType: string
): Promise<CatalogAsset> {
  const sha256 = sha256Buffer(bytes)
  const relativePath = path.posix.join('assets', 'sha256', sha256, fileName)
  const assetPath = path.resolve(catalogRoot, ...relativePath.split('/'))
  assertPathWithinCatalogRoot(catalogRoot, assetPath)
  await mkdir(path.dirname(assetPath), { recursive: true })
  const realAssetDir = await realpath(path.dirname(assetPath))
  assertPathWithinCatalogRoot(catalogRoot, realAssetDir)
  try {
    await writeFile(assetPath, bytes, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const asset: CatalogAsset = {
    asset_id: `sha256:${sha256}`,
    sha256,
    relative_path: relativePath,
    byte_length: bytes.length,
    media_type: mediaType
  }
  await validateMaterializedAsset(catalogRoot, asset)
  return asset
}

async function validateStagedCatalog(catalogRoot: string): Promise<void> {
  const catalog = JSON.parse(
    await readFile(path.join(catalogRoot, 'catalog.json'), 'utf8')
  ) as Record<string, unknown>
  if (!validateCatalogManifestSchema(catalog)) {
    throw new Error('Catalog manifest validation failed.')
  }
  const lines = (await readFile(path.join(catalogRoot, 'records.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
  if (!lines.length) throw new Error('Catalog manifest validation failed.')
  for (const line of lines) {
    const record = JSON.parse(line) as Record<string, unknown>
    validateCatalogRecord(record)
    const chart = record.chart as { notes_midi: CatalogAsset }
    await validateMaterializedAsset(catalogRoot, chart.notes_midi)
    for (const asset of Object.values(
      (record.audio ?? {}) as Partial<Record<CatalogAudioRole, CatalogAsset>>
    )) {
      if (asset) await validateMaterializedAsset(catalogRoot, asset)
    }
  }
}

async function readCatalogRecords(catalogRoot: string): Promise<Record<string, unknown>[]> {
  const lines = (await readFile(path.join(catalogRoot, 'records.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') {
    // Python's ``ensure_ascii=True`` is part of STRUM's catalog-control
    // fingerprint. Keep the producer byte-for-byte compatible with it.
    return JSON.stringify(value).replace(/[\u0080-\u{10ffff}]/gu, (character) =>
      character
        .split('')
        .map((codeUnit) => `\\u${codeUnit.charCodeAt(0).toString(16).padStart(4, '0')}`)
        .join('')
    )
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${canonicalJson(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  throw new Error('Catalog control data is invalid.')
}

function catalogControlSha256(catalog: Record<string, unknown>, recordsText: string): string {
  return sha256Buffer(Buffer.from(canonicalJson({ catalog, records_jsonl: recordsText }), 'utf8'))
}

function isHarmonyTrackName(value: unknown): value is HarmonyTrackName {
  return typeof value === 'string' && HARMONY_TRACK_NAMES.includes(value as HarmonyTrackName)
}

function validateHarmonyIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HARMONY_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Harmony ${label} is invalid.`)
  }
  return value
}

function validateHarmonySha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HARMONY_SHA256_PATTERN.test(value)) {
    throw new Error(`Harmony ${label} must be a SHA-256.`)
  }
  return value
}

type FileIdentity = {
  dev: number
  ino: number
  size: number
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
}

function sameFileNodeIdentity(
  left: Pick<FileIdentity, 'dev' | 'ino'>,
  right: Pick<FileIdentity, 'dev' | 'ino'>
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * Do not silently degrade O_NOFOLLOW to zero. Every pathname that can carry
 * catalog control or selected source data is hostile until its descriptor and
 * inode have been verified. Platforms without O_NOFOLLOW therefore cannot
 * perform catalog mutations rather than accepting a symlink race.
 */
function noFollowOpenFlags(flags: number): number {
  const noFollow = constants.O_NOFOLLOW
  if (!Number.isSafeInteger(noFollow) || noFollow === 0) {
    throw new Error('Safe catalog file opens are unavailable on this runtime.')
  }
  return flags | noFollow
}

function mediaTypeForAudioExtension(extension: (typeof AUDIO_EXTENSIONS)[number]): string {
  switch (extension) {
    case 'ogg':
      return 'audio/ogg'
    case 'opus':
      return 'audio/opus'
    case 'mp3':
      return 'audio/mpeg'
    case 'wav':
      return 'audio/wav'
    case 'flac':
      return 'audio/flac'
  }
}

async function readExplicitHarmonyAudio(sourcePath: string): Promise<CatalogAudioInput> {
  const extension = path.extname(sourcePath).slice(1).toLowerCase()
  if (!isCatalogAudioExtension(extension)) {
    throw new Error('Select an OGG, MP3, Opus, WAV, or FLAC Harmony source.')
  }

  let selectedInfo: Awaited<ReturnType<typeof lstat>>
  try {
    selectedInfo = await lstat(sourcePath)
  } catch {
    // The chooser's location is private main-process state. In particular,
    // an ENOENT/EACCES error includes it in Node's message, so never let that
    // diagnostic escape through the Dataset Curation IPC handler.
    throw new Error('Selected Harmony audio is unavailable or unsupported.')
  }
  if (
    !selectedInfo.isFile() ||
    selectedInfo.isSymbolicLink() ||
    (selectedInfo.mode & 0o444) === 0 ||
    selectedInfo.size > MAX_AUDIO_ASSET_BYTES
  ) {
    throw new Error('Selected Harmony audio is unavailable or unsupported.')
  }

  let sourceHandle: Awaited<ReturnType<typeof open>>
  try {
    // Read only from this descriptor. O_NOFOLLOW rejects a final-path symlink
    // and O_NONBLOCK prevents a swapped FIFO/device from stalling the main
    // process before fstat can reject it.
    sourceHandle = await open(
      sourcePath,
      noFollowOpenFlags(constants.O_RDONLY | constants.O_NONBLOCK)
    )
  } catch {
    throw new Error('Selected Harmony audio is unavailable or unsupported.')
  }

  try {
    const openedInfo = await sourceHandle.stat()
    if (
      !openedInfo.isFile() ||
      (openedInfo.mode & 0o444) === 0 ||
      openedInfo.size > MAX_AUDIO_ASSET_BYTES ||
      !sameFileIdentity(selectedInfo, openedInfo)
    ) {
      throw new Error('Selected Harmony audio is unavailable or unsupported.')
    }
    const bytes = await sourceHandle.readFile()
    const readInfo = await sourceHandle.stat()
    const currentInfo = await lstat(sourcePath)
    if (
      bytes.length !== openedInfo.size ||
      bytes.length > MAX_AUDIO_ASSET_BYTES ||
      !sameFileIdentity(openedInfo, readInfo) ||
      !currentInfo.isFile() ||
      currentInfo.isSymbolicLink() ||
      !sameFileIdentity(openedInfo, currentInfo) ||
      currentInfo.mtimeMs !== readInfo.mtimeMs
    ) {
      throw new Error('Selected Harmony audio is unavailable or unsupported.')
    }
    return { bytes, extension, mediaType: mediaTypeForAudioExtension(extension) }
  } catch {
    // Protect against deletion, relocation, permission changes, and every
    // failure after selection. Diagnostics can contain a private path.
    throw new Error('Selected Harmony audio is unavailable or unsupported.')
  } finally {
    await sourceHandle.close().catch(() => undefined)
  }
}

async function readExactHarmonyTracks(
  catalogRoot: string,
  record: Record<string, unknown>
): Promise<HarmonyTrackName[]> {
  const chart = record.chart as { notes_midi?: CatalogAsset }
  const notes = chart.notes_midi
  if (!notes) throw new Error('Catalog source is missing notes MIDI.')
  await validateMaterializedAsset(catalogRoot, notes)
  const midi = new Midi(
    await readFile(path.resolve(catalogRoot, ...notes.relative_path.split('/')))
  )
  const tracks = new Set(
    midi.tracks.map((track) => track.name.trim().toUpperCase()).filter(isHarmonyTrackName)
  )
  return HARMONY_TRACK_NAMES.filter((track) => tracks.has(track))
}

function harmonySourceLabel(record: Record<string, unknown>): string {
  const metadata = (record.metadata ?? {}) as Record<string, unknown>
  const artist = typeof metadata.artist === 'string' ? metadata.artist : ''
  const name = typeof metadata.name === 'string' ? metadata.name : ''
  return redactLocationText(
    artist && name ? `${artist} — ${name}` : name || artist || 'Catalog source',
    'Catalog source'
  )
}

type HarmonyPolicyRecord = {
  source_id: string
  track_name: HarmonyTrackName
  audio: { role: HarmonyAudioRole; asset_id: string; sha256: string }
  provenance:
    | {
        kind: 'isolated_source_stem/v1'
        timeline: 'same-master-timeline/v1'
        attestation_id: string
      }
    | {
        kind: 'isolated_separation_output/v1'
        timeline: 'same-master-timeline/v1'
        input: { asset_id: string; sha256: string }
        separator: {
          id: string
          version: string
          model_sha256: string
          configuration_sha256: string
        }
      }
}

function catalogAssetIdentity(asset: CatalogAsset): { asset_id: string; sha256: string } {
  return { asset_id: asset.asset_id, sha256: asset.sha256 }
}

function validateExistingHarmonyPolicy(
  raw: unknown,
  catalog: Record<string, unknown>,
  records: readonly Record<string, unknown>[],
  controlSha256: string
): { policyId: string; records: HarmonyPolicyRecord[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Existing Harmony source policy is invalid.')
  }
  const policy = raw as Record<string, unknown>
  if (
    Object.keys(policy).length !== 6 ||
    policy.schema_version !== 1 ||
    policy.format !== HARMONY_SOURCE_POLICY_FORMAT ||
    policy.catalog_id !== catalog.catalog_id ||
    policy.catalog_control_sha256 !== controlSha256 ||
    !Array.isArray(policy.records)
  ) {
    throw new Error('Existing Harmony source policy does not match this catalog.')
  }
  const policyId = validateHarmonyIdentifier(policy.policy_id, 'policy ID')
  const bySourceId = new Map(records.map((record) => [String(record.source_id), record]))
  const seen = new Set<string>()
  const validRows: HarmonyPolicyRecord[] = []
  for (const value of policy.records) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Existing Harmony source policy is invalid.')
    }
    const row = value as Record<string, unknown>
    if (Object.keys(row).length !== 4 || !isHarmonyTrackName(row.track_name)) {
      throw new Error('Existing Harmony source policy is invalid.')
    }
    const sourceId = validateHarmonyIdentifier(row.source_id, 'source ID')
    const key = `${sourceId}:${row.track_name}`
    if (seen.has(key)) throw new Error('Existing Harmony source policy is invalid.')
    seen.add(key)
    const record = bySourceId.get(sourceId)
    if (!record) throw new Error('Existing Harmony source policy is invalid.')
    const expectedRole = HARMONY_TRACK_AUDIO_ROLE[row.track_name]
    const audio = row.audio as Record<string, unknown> | undefined
    const recordAudio = (record.audio ?? {}) as Partial<Record<CatalogAudioRole, CatalogAsset>>
    const asset = recordAudio[expectedRole]
    if (
      !asset ||
      !audio ||
      Object.keys(audio).length !== 3 ||
      audio.role !== expectedRole ||
      audio.asset_id !== asset.asset_id ||
      audio.sha256 !== asset.sha256
    ) {
      throw new Error('Existing Harmony source policy is invalid.')
    }
    const provenance = row.provenance as Record<string, unknown> | undefined
    if (!provenance || provenance.timeline !== 'same-master-timeline/v1') {
      throw new Error('Existing Harmony source policy is invalid.')
    }
    if (provenance.kind === 'isolated_source_stem/v1') {
      if (Object.keys(provenance).length !== 3)
        throw new Error('Existing Harmony source policy is invalid.')
      validRows.push({
        source_id: sourceId,
        track_name: row.track_name,
        audio: { role: expectedRole, ...catalogAssetIdentity(asset) },
        provenance: {
          kind: 'isolated_source_stem/v1',
          timeline: 'same-master-timeline/v1',
          attestation_id: validateHarmonyIdentifier(provenance.attestation_id, 'attestation ID')
        }
      })
      continue
    }
    if (
      provenance.kind !== 'isolated_separation_output/v1' ||
      Object.keys(provenance).length !== 4
    ) {
      throw new Error('Existing Harmony source policy is invalid.')
    }
    const mix = recordAudio.mix
    const input = provenance.input as Record<string, unknown> | undefined
    const separator = provenance.separator as Record<string, unknown> | undefined
    if (
      !mix ||
      !input ||
      Object.keys(input).length !== 2 ||
      input.asset_id !== mix.asset_id ||
      input.sha256 !== mix.sha256 ||
      !separator ||
      Object.keys(separator).length !== 4
    ) {
      throw new Error('Existing Harmony source policy is invalid.')
    }
    validRows.push({
      source_id: sourceId,
      track_name: row.track_name,
      audio: { role: expectedRole, ...catalogAssetIdentity(asset) },
      provenance: {
        kind: 'isolated_separation_output/v1',
        timeline: 'same-master-timeline/v1',
        input: catalogAssetIdentity(mix),
        separator: {
          id: validateHarmonyIdentifier(separator.id, 'separator ID'),
          version: validateHarmonyIdentifier(separator.version, 'separator version'),
          model_sha256: validateHarmonySha256(separator.model_sha256, 'separator model hash'),
          configuration_sha256: validateHarmonySha256(
            separator.configuration_sha256,
            'separator configuration hash'
          )
        }
      }
    })
  }
  return { policyId, records: validRows }
}

async function readExistingHarmonyPolicy(
  catalogRoot: string,
  catalog: Record<string, unknown>,
  records: readonly Record<string, unknown>[],
  controlSha256: string
): Promise<{ policyId: string; records: HarmonyPolicyRecord[] } | null> {
  const policyPath = path.join(catalogRoot, HARMONY_SOURCE_POLICY_FILENAME)
  try {
    const policyInfo = await lstat(policyPath)
    if (!policyInfo.isFile() || policyInfo.isSymbolicLink()) {
      throw new Error('Existing Harmony source policy is invalid.')
    }
    return validateExistingHarmonyPolicy(
      JSON.parse(await readFile(policyPath, 'utf8')),
      catalog,
      records,
      controlSha256
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function replaceCatalogAtomically(
  parentDir: string,
  catalogName: string,
  stagingPath: string
): Promise<void> {
  const catalogPath = path.join(parentDir, catalogName)
  const backupPath = path.join(parentDir, `.${catalogName}.backup-${randomUUID()}`)
  await rename(catalogPath, backupPath)
  try {
    await rename(stagingPath, catalogPath)
  } catch (error) {
    await rename(backupPath, catalogPath)
    throw error
  }
  await rm(backupPath, { recursive: true, force: true }).catch(() => undefined)
}

type CatalogMutationReservationMetadata = {
  format: typeof CATALOG_MUTATION_RESERVATION_FORMAT
  owner_id: string
  owner_host: string
  owner_instance: string
  owner_pid: number
  created_at_ms: number
  lease_duration_ms: typeof CATALOG_MUTATION_LEASE_MS
}

type CatalogMutationReservation = {
  path: string
  handle: Awaited<ReturnType<typeof open>>
  identity: FileIdentity
  heartbeat?: ReturnType<typeof setInterval>
  leaseHealthy: boolean
}

type CatalogMutationCoordination = {
  path: string
  handle: Awaited<ReturnType<typeof open>>
  identity: FileIdentity
}

export type CatalogMutationTestHooks = {
  afterStaleReservationRemoved?: () => Promise<void>
}

let catalogMutationTestHooks: CatalogMutationTestHooks | undefined
let localCatalogMutationOwnerInstance: Promise<string | null> | undefined

/** Test-only synchronization hook; it is never reachable through IPC. */
export function setCatalogMutationTestHooksForTesting(
  hooks: CatalogMutationTestHooks | undefined
): void {
  catalogMutationTestHooks = hooks
}

function getLocalCatalogMutationOwnerInstance(): Promise<string | null> {
  localCatalogMutationOwnerInstance ??= readFile('/proc/sys/kernel/random/boot_id', 'utf8')
    .then((value) => {
      const bootId = value.trim().toLowerCase()
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId)) return null
      return `${CATALOG_MUTATION_OWNER_INSTANCE_PREFIX}${bootId}`
    })
    .catch(() => null)
  return localCatalogMutationOwnerInstance
}

async function reservationMetadata(
  ownerId: string,
  createdAtMs: number
): Promise<CatalogMutationReservationMetadata> {
  const ownerInstance = await getLocalCatalogMutationOwnerInstance()
  if (!ownerInstance) {
    throw new Error('Safe catalog mutation ownership is unavailable on this runtime.')
  }
  return {
    format: CATALOG_MUTATION_RESERVATION_FORMAT,
    owner_id: ownerId,
    owner_host: hostname(),
    owner_instance: ownerInstance,
    owner_pid: process.pid,
    created_at_ms: createdAtMs,
    lease_duration_ms: CATALOG_MUTATION_LEASE_MS
  }
}

function parseReservationMetadata(value: unknown): CatalogMutationReservationMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    record.format !== CATALOG_MUTATION_RESERVATION_FORMAT ||
    !HARMONY_IDENTIFIER_PATTERN.test(String(record.owner_id ?? '')) ||
    typeof record.owner_host !== 'string' ||
    !record.owner_host ||
    record.owner_host.length > 255 ||
    typeof record.owner_instance !== 'string' ||
    !HARMONY_IDENTIFIER_PATTERN.test(record.owner_instance) ||
    !Number.isSafeInteger(record.owner_pid) ||
    Number(record.owner_pid) <= 0 ||
    !Number.isSafeInteger(record.created_at_ms) ||
    !Number.isSafeInteger(record.lease_duration_ms) ||
    record.lease_duration_ms !== CATALOG_MUTATION_LEASE_MS
  ) {
    return null
  }
  return record as CatalogMutationReservationMetadata
}

async function isCatalogMutationOwnerActive(
  metadata: CatalogMutationReservationMetadata
): Promise<boolean> {
  // PID probing is only meaningful for this exact host boot. A same-host PID
  // can be reused after a reboot, and a matching hostname on shared storage
  // says nothing about where a mutation runs. Unknown or remote owners stay
  // active so recovery never claims a potentially live catalog mutation.
  const ownerInstance = await getLocalCatalogMutationOwnerInstance()
  if (
    !ownerInstance ||
    metadata.owner_host !== hostname() ||
    metadata.owner_instance !== ownerInstance
  ) {
    return true
  }
  try {
    process.kill(metadata.owner_pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but is not signalable. Other unexpected
    // errors remain fail-closed; only a confirmed missing PID is reclaimable.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function readCatalogMutationReservation(reservationPath: string): Promise<{
  metadata: CatalogMutationReservationMetadata
  identity: FileIdentity
  mtimeMs: number
} | null> {
  let selectedInfo: Awaited<ReturnType<typeof lstat>>
  try {
    selectedInfo = await lstat(reservationPath)
  } catch {
    return null
  }
  if (
    !selectedInfo.isFile() ||
    selectedInfo.isSymbolicLink() ||
    selectedInfo.size > MAX_CATALOG_MUTATION_RESERVATION_BYTES
  ) {
    return null
  }
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(
      reservationPath,
      noFollowOpenFlags(constants.O_RDONLY | constants.O_NONBLOCK)
    )
  } catch {
    return null
  }
  try {
    const openedInfo = await handle.stat()
    if (!openedInfo.isFile() || !sameFileIdentity(selectedInfo, openedInfo)) return null
    const bytes = await handle.readFile()
    const readInfo = await handle.stat()
    const currentInfo = await lstat(reservationPath)
    if (
      bytes.length > MAX_CATALOG_MUTATION_RESERVATION_BYTES ||
      !sameFileIdentity(openedInfo, readInfo) ||
      !currentInfo.isFile() ||
      currentInfo.isSymbolicLink() ||
      !sameFileIdentity(openedInfo, currentInfo) ||
      currentInfo.mtimeMs !== readInfo.mtimeMs
    ) {
      return null
    }
    const metadata = parseReservationMetadata(JSON.parse(bytes.toString('utf8')))
    if (!metadata) return null
    return {
      metadata,
      identity: { dev: openedInfo.dev, ino: openedInfo.ino, size: openedInfo.size },
      mtimeMs: readInfo.mtimeMs
    }
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function recoverExpiredCatalogMutationReservation(reservationPath: string): Promise<boolean> {
  const reservation = await readCatalogMutationReservation(reservationPath)
  if (
    !reservation ||
    Date.now() <= reservation.mtimeMs + reservation.metadata.lease_duration_ms ||
    (await isCatalogMutationOwnerActive(reservation.metadata))
  ) {
    return false
  }

  // reserveCatalogMutation owns the short-lived coordination file while it
  // calls this function. Release and every competing acquire own that same
  // file too, so between this identity check and the new owner creation no
  // in-process actor can replace this pathname. In particular, never rename
  // here: a stale reader that renamed after another reclaimer released could
  // move a brand-new owner's reservation.
  try {
    const currentInfo = await lstat(reservationPath)
    if (
      !currentInfo.isFile() ||
      currentInfo.isSymbolicLink() ||
      !sameFileIdentity(reservation.identity, currentInfo)
    ) {
      throw new Error('Catalog mutation reservation identity changed.')
    }
    await unlink(reservationPath)
    await catalogMutationTestHooks?.afterStaleReservationRemoved?.()
    return true
  } catch {
    return false
  }
}

function catalogMutationCoordinationPath(reservationPath: string): string {
  return `${reservationPath}${CATALOG_MUTATION_COORDINATION_SUFFIX}`
}

async function acquireCatalogMutationCoordination(
  reservationPath: string
): Promise<CatalogMutationCoordination> {
  // This coordinator intentionally has no automatic stale recovery. Trying
  // to reclaim the coordinator itself would recreate the unsafe window this
  // protocol closes. A crashed coordinator therefore remains fail-closed
  // until an operator has independently verified and removed it.
  const coordinationPath = catalogMutationCoordinationPath(reservationPath)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(
      coordinationPath,
      noFollowOpenFlags(constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL),
      0o600
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('A catalog mutation with that name is already in progress.')
    }
    throw new Error('The catalog mutation could not be started.')
  }

  let createdIdentity: Pick<FileIdentity, 'dev' | 'ino'> | undefined
  try {
    const createdInfo = await handle.stat()
    createdIdentity = { dev: createdInfo.dev, ino: createdInfo.ino }
    await handle.writeFile(`${process.pid}\n`, 'utf8')
    await handle.sync()
    const info = await handle.stat()
    return {
      path: coordinationPath,
      handle,
      identity: { dev: info.dev, ino: info.ino, size: info.size }
    }
  } catch {
    await handle.close().catch(() => undefined)
    try {
      const pathInfo = await lstat(coordinationPath)
      if (
        pathInfo.isFile() &&
        !pathInfo.isSymbolicLink() &&
        createdIdentity &&
        sameFileNodeIdentity(createdIdentity, pathInfo)
      ) {
        await unlink(coordinationPath)
      }
    } catch {
      // A failed coordinator setup must never delete an unknown replacement.
    }
    throw new Error('The catalog mutation could not be started.')
  }
}

async function releaseCatalogMutationCoordination(
  coordination: CatalogMutationCoordination
): Promise<void> {
  await coordination.handle.close().catch(() => undefined)
  try {
    const pathInfo = await lstat(coordination.path)
    if (
      pathInfo.isFile() &&
      !pathInfo.isSymbolicLink() &&
      sameFileIdentity(coordination.identity, pathInfo)
    ) {
      await unlink(coordination.path)
    }
  } catch {
    // A failed or externally replaced coordinator stays fail-closed.
  }
}

async function assertCatalogMutationReservation(
  reservation: CatalogMutationReservation
): Promise<void> {
  if (!reservation.leaseHealthy) {
    throw new Error('The catalog mutation reservation was lost.')
  }
  try {
    // Renew through the owning descriptor. A recovered reservation cannot
    // renew a replacement path and will fail the identity check.
    const now = new Date()
    await reservation.handle.utimes(now, now)
    const handleInfo = await reservation.handle.stat()
    const pathInfo = await lstat(reservation.path)
    if (
      !sameFileIdentity(reservation.identity, handleInfo) ||
      !pathInfo.isFile() ||
      pathInfo.isSymbolicLink() ||
      !sameFileIdentity(reservation.identity, pathInfo)
    ) {
      throw new Error('Catalog mutation reservation identity changed.')
    }
  } catch {
    throw new Error('The catalog mutation reservation was lost.')
  }
}

/**
 * Mutating operations replace a complete catalog directory after staging. A
 * single catalog-level reservation therefore protects both the generic
 * create/update/clone flow and Harmony materialization from lost replacements.
 */
async function reserveCatalogMutation(
  parentDir: string,
  catalogName: string
): Promise<CatalogMutationReservation> {
  const reservationPath = path.join(parentDir, `.${catalogName}.mutation-reservation`)
  const coordination = await acquireCatalogMutationCoordination(reservationPath)
  try {
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(
        reservationPath,
        noFollowOpenFlags(constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL),
        0o600
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        // fs errors expose the parent directory. It is private main-process state.
        throw new Error('The catalog mutation could not be started.')
      }
      if (!(await recoverExpiredCatalogMutationReservation(reservationPath))) {
        throw new Error('A catalog mutation with that name is already in progress.')
      }
      try {
        handle = await open(
          reservationPath,
          noFollowOpenFlags(constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL),
          0o600
        )
      } catch {
        throw new Error('A catalog mutation with that name is already in progress.')
      }
    }

    let createdIdentity: Pick<FileIdentity, 'dev' | 'ino'> | undefined
    try {
      const createdInfo = await handle.stat()
      createdIdentity = { dev: createdInfo.dev, ino: createdInfo.ino }
      const ownerId = randomUUID()
      await handle.writeFile(
        `${JSON.stringify(await reservationMetadata(ownerId, Date.now()))}\n`,
        'utf8'
      )
      await handle.sync()
      const info = await handle.stat()
      const reservation: CatalogMutationReservation = {
        path: reservationPath,
        handle,
        identity: { dev: info.dev, ino: info.ino, size: info.size },
        leaseHealthy: true
      }
      reservation.heartbeat = setInterval(() => {
        void reservation.handle.utimes(new Date(), new Date()).catch(() => {
          reservation.leaseHealthy = false
        })
      }, CATALOG_MUTATION_HEARTBEAT_MS)
      reservation.heartbeat.unref()
      return reservation
    } catch {
      await handle.close().catch(() => undefined)
      try {
        const pathInfo = await lstat(reservationPath)
        if (
          pathInfo.isFile() &&
          !pathInfo.isSymbolicLink() &&
          createdIdentity &&
          sameFileNodeIdentity(createdIdentity, pathInfo)
        ) {
          await unlink(reservationPath)
        }
      } catch {
        // Never unlink an unknown replacement reservation during failed setup.
      }
      throw new Error('The catalog mutation could not be started.')
    }
  } finally {
    await releaseCatalogMutationCoordination(coordination)
  }
}

async function releaseCatalogMutation(reservation: CatalogMutationReservation): Promise<void> {
  if (reservation.heartbeat) clearInterval(reservation.heartbeat)
  await reservation.handle.close().catch(() => undefined)
  let coordination: CatalogMutationCoordination
  try {
    coordination = await acquireCatalogMutationCoordination(reservation.path)
  } catch {
    // A coordinator we do not own may protect a replacement reservation.
    // Leaving our old inode in place is safer than deleting an unknown owner.
    return
  }
  try {
    const pathInfo = await lstat(reservation.path)
    if (
      pathInfo.isFile() &&
      !pathInfo.isSymbolicLink() &&
      sameFileIdentity(reservation.identity, pathInfo)
    ) {
      await unlink(reservation.path)
    }
  } catch {
    // A recovered reservation may already be absent. Never unlink an unknown
    // replacement reservation during cleanup.
  } finally {
    await releaseCatalogMutationCoordination(coordination)
  }
}

async function reserveCatalogMutations(
  parentDir: string,
  catalogNames: readonly string[]
): Promise<CatalogMutationReservation[]> {
  const names = [...new Set(catalogNames)].sort((left, right) => left.localeCompare(right))
  const reservations: CatalogMutationReservation[] = []
  try {
    for (const catalogName of names) {
      reservations.push(await reserveCatalogMutation(parentDir, catalogName))
    }
    return reservations
  } catch (error) {
    for (const reservation of reservations.reverse()) await releaseCatalogMutation(reservation)
    throw error
  }
}

async function releaseCatalogMutations(
  reservations: readonly CatalogMutationReservation[]
): Promise<void> {
  for (const reservation of [...reservations].reverse()) await releaseCatalogMutation(reservation)
}

async function assertCatalogMutationReservations(
  reservations: readonly CatalogMutationReservation[]
): Promise<void> {
  for (const reservation of reservations) await assertCatalogMutationReservation(reservation)
}

export async function listCatalogHarmonyTargets(
  parentDir: string,
  requestedCatalogName: string
): Promise<CatalogHarmonyTarget[]> {
  const catalogName = validateCatalogName(requestedCatalogName)
  const catalogRoot = path.join(path.resolve(parentDir), catalogName)
  await validateStagedCatalog(catalogRoot)
  const catalog = JSON.parse(
    await readFile(path.join(catalogRoot, 'catalog.json'), 'utf8')
  ) as Record<string, unknown>
  const records = await readCatalogRecords(catalogRoot)
  const policy = await readExistingHarmonyPolicy(
    catalogRoot,
    catalog,
    records,
    catalogControlSha256(catalog, await readFile(path.join(catalogRoot, 'records.jsonl'), 'utf8'))
  )
  const configured = new Map<string, Set<HarmonyTrackName>>()
  for (const row of policy?.records ?? []) {
    const tracks = configured.get(row.source_id) ?? new Set<HarmonyTrackName>()
    tracks.add(row.track_name)
    configured.set(row.source_id, tracks)
  }
  const targets = await Promise.all(
    records.map(async (record) => ({
      record,
      tracks: await readExactHarmonyTracks(catalogRoot, record)
    }))
  )
  return targets
    .filter(
      ({ record, tracks }) =>
        (record.rights as { training_use?: string }).training_use === 'allowed' && tracks.length
    )
    .map(({ record, tracks }) => ({
      sourceId: String(record.source_id),
      label: harmonySourceLabel(record),
      tracks,
      configuredTracks: HARMONY_TRACK_NAMES.filter((track) =>
        configured.get(String(record.source_id))?.has(track)
      )
    }))
}

export async function materializeCatalogHarmonySource(
  options: MaterializeCatalogHarmonySourceOptions
): Promise<MaterializeCatalogHarmonySourceResult> {
  const catalogName = validateCatalogName(options.catalogName)
  const sourceId = validateHarmonyIdentifier(options.sourceId, 'source ID')
  if (!isHarmonyTrackName(options.trackName)) throw new Error('Harmony track is invalid.')
  const parentDir = path.resolve(options.parentDir)
  const catalogPath = path.join(parentDir, catalogName)
  const reservation = await reserveCatalogMutation(parentDir, catalogName)
  const stagingPath = path.join(parentDir, `.${catalogName}.harmony-staging-${randomUUID()}`)
  try {
    await validateStagedCatalog(catalogPath)
    const sourceAudio = await readExplicitHarmonyAudio(options.sourceAudioPath)
    const catalog = JSON.parse(
      await readFile(path.join(catalogPath, 'catalog.json'), 'utf8')
    ) as Record<string, unknown>
    const existingRecords = await readCatalogRecords(catalogPath)
    const recordsText = await readFile(path.join(catalogPath, 'records.jsonl'), 'utf8')
    const existingPolicy = await readExistingHarmonyPolicy(
      catalogPath,
      catalog,
      existingRecords,
      catalogControlSha256(catalog, recordsText)
    )
    const target = existingRecords.find((record) => record.source_id === sourceId)
    if (!target || (target.rights as { training_use?: string }).training_use !== 'allowed') {
      throw new Error('Choose an allowed catalog source for Harmony materialization.')
    }
    const availableTracks = await readExactHarmonyTracks(catalogPath, target)
    if (!availableTracks.includes(options.trackName)) {
      throw new Error('The selected catalog source does not contain that exact HARM track.')
    }
    const targetAudio = (target.audio ?? {}) as Partial<Record<CatalogAudioRole, CatalogAsset>>
    const role = HARMONY_TRACK_AUDIO_ROLE[options.trackName]
    const forbiddenHashes = new Set(
      [targetAudio.mix?.sha256, targetAudio.vocals?.sha256].filter(Boolean)
    )
    const sourceSha256 = sha256Buffer(sourceAudio.bytes)
    if (forbiddenHashes.has(sourceSha256)) {
      throw new Error('Harmony audio must not duplicate the catalog mix or shared vocals asset.')
    }
    let provenance: HarmonyPolicyRecord['provenance']
    if (options.provenance.kind === 'isolated_source_stem/v1') {
      provenance = {
        kind: 'isolated_source_stem/v1',
        timeline: 'same-master-timeline/v1',
        attestation_id: validateHarmonyIdentifier(
          options.provenance.attestationId,
          'attestation ID'
        )
      }
    } else if (options.provenance.kind === 'isolated_separation_output/v1') {
      const mix = targetAudio.mix
      if (!mix) throw new Error('Pinned separation output requires a catalog mix asset.')
      provenance = {
        kind: 'isolated_separation_output/v1',
        timeline: 'same-master-timeline/v1',
        input: catalogAssetIdentity(mix),
        separator: {
          id: validateHarmonyIdentifier(options.provenance.separator.id, 'separator ID'),
          version: validateHarmonyIdentifier(
            options.provenance.separator.version,
            'separator version'
          ),
          model_sha256: validateHarmonySha256(
            options.provenance.separator.modelSha256,
            'separator model hash'
          ),
          configuration_sha256: validateHarmonySha256(
            options.provenance.separator.configurationSha256,
            'separator configuration hash'
          )
        }
      }
    } else {
      throw new Error('Harmony provenance is invalid.')
    }
    await cp(catalogPath, stagingPath, {
      recursive: true,
      errorOnExist: true,
      verbatimSymlinks: true
    })
    const stagingRoot = await realpath(stagingPath)
    const stagedRecords = await readCatalogRecords(stagingRoot)
    const stagedTarget = stagedRecords.find((record) => record.source_id === sourceId)
    if (!stagedTarget) throw new Error('Catalog source is unavailable.')
    const asset = await materializeCatalogAsset(
      stagingRoot,
      sourceAudio.bytes,
      `${role}.${sourceAudio.extension}`,
      sourceAudio.mediaType
    )
    const stagedAudio = (stagedTarget.audio ??= {}) as Partial<
      Record<CatalogAudioRole, CatalogAsset>
    >
    stagedAudio[role] = asset
    for (const record of stagedRecords) validateCatalogRecord(record)
    const stagedRecordsText = `${stagedRecords.map((record) => JSON.stringify(record)).join('\n')}\n`
    await writeFile(path.join(stagingRoot, 'records.jsonl'), stagedRecordsText, 'utf8')
    const stagedCatalog = JSON.parse(
      await readFile(path.join(stagingRoot, 'catalog.json'), 'utf8')
    ) as Record<string, unknown>
    const updatedRows = (existingPolicy?.records ?? []).filter(
      (row) => row.source_id !== sourceId || row.track_name !== options.trackName
    )
    updatedRows.push({
      source_id: sourceId,
      track_name: options.trackName,
      audio: { role, ...catalogAssetIdentity(asset) },
      provenance
    })
    updatedRows.sort((left, right) =>
      `${left.source_id}:${left.track_name}`.localeCompare(`${right.source_id}:${right.track_name}`)
    )
    const policy = {
      schema_version: 1,
      format: HARMONY_SOURCE_POLICY_FORMAT,
      policy_id: existingPolicy?.policyId ?? `octave-harmony-${randomUUID()}`,
      catalog_id: stagedCatalog.catalog_id,
      catalog_control_sha256: catalogControlSha256(stagedCatalog, stagedRecordsText),
      records: updatedRows
    }
    // Read back through the strict policy validator before replacing the live
    // catalog. That proves every retained row still binds to catalog assets.
    await writeFile(
      path.join(stagingRoot, HARMONY_SOURCE_POLICY_FILENAME),
      `${JSON.stringify(policy, null, 2)}\n`,
      'utf8'
    )
    await validateStagedCatalog(stagingRoot)
    await readExistingHarmonyPolicy(
      stagingRoot,
      stagedCatalog,
      stagedRecords,
      catalogControlSha256(stagedCatalog, stagedRecordsText)
    )
    await assertCatalogMutationReservation(reservation)
    await replaceCatalogAtomically(parentDir, catalogName, stagingRoot)
    return {
      sourceId,
      trackName: options.trackName,
      configuredTracks: HARMONY_TRACK_NAMES.filter((track) =>
        updatedRows.some((row) => row.source_id === sourceId && row.track_name === track)
      )
    }
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true })
    throw error
  } finally {
    await releaseCatalogMutation(reservation)
  }
}

export async function listSongSourceCatalogs(
  parentDir: string
): Promise<SongSourceCatalogSummary[]> {
  const entries = await readdir(parentDir, { withFileTypes: true })
  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(async (entry) => {
        try {
          const catalogRoot = path.join(parentDir, entry.name)
          const catalog = JSON.parse(
            await readFile(path.join(catalogRoot, 'catalog.json'), 'utf8')
          ) as Record<string, unknown>
          if (!validateCatalogManifestSchema(catalog)) return null
          await validateStagedCatalog(catalogRoot)
          const records = await readCatalogRecords(catalogRoot)
          // v1 catalogs created before catalog-level curation metadata keep
          // their rights on every record. Preserve that compatibility while
          // preferring the durable catalog-wide values for the editor.
          const legacyRights = records[0].rights as CatalogCuration
          const curation = catalog.curation as CatalogCuration | undefined
          const rights = curation ?? legacyRights
          const libraryRecordCount = records.filter(
            (record) => (record.import as { kind?: string }).kind === 'song_folder'
          ).length
          return {
            catalogName: entry.name,
            catalogId: String(catalog.catalog_id),
            provenance: rights.provenance,
            license: rights.license,
            recordCount: records.length,
            libraryRecordCount,
            externalRecordCount: records.length - libraryRecordCount
          }
        } catch {
          return null
        }
      })
  )
  return summaries
    .filter((summary): summary is SongSourceCatalogSummary => summary !== null)
    .sort((left, right) => left.catalogName.localeCompare(right.catalogName))
}

/**
 * Main-process catalog service. It is intentionally the sole adapter boundary
 * between package/folder sources and STRUM; its returned catalog is path-free.
 */
export async function buildSongSourceCatalog(options: {
  sources: readonly DatasetCatalogSource[]
  parentDir: string
  catalogName: string
  catalogId: string
  provenance: string
  license: string
  octaveVersion: string
  mode?: SongSourceCatalogWriteMode
  sourceCatalogName?: string
  onProgress?: (progress: SongSourceCatalogProgress) => void
}): Promise<SongSourceCatalogResult> {
  if (!options.sources.length && options.mode !== 'update') {
    throw new Error('Select at least one reviewed source.')
  }
  const mode = options.mode ?? 'create'
  const catalogName = validateCatalogName(options.catalogName)
  const catalogId = redactLocationText(options.catalogId, 'octave-catalog').slice(0, 128)
  const provenance = redactLocationText(options.provenance, 'Reviewed in Octave')
  const license = redactLocationText(options.license, 'Permission recorded by catalog owner')
  const parentDir = path.resolve(options.parentDir)
  const catalogPath = path.join(parentDir, catalogName)
  const sourceCatalogName = options.sourceCatalogName
    ? validateCatalogName(options.sourceCatalogName)
    : catalogName
  const sourceCatalogPath = path.join(parentDir, sourceCatalogName)
  const reservations = await reserveCatalogMutations(
    parentDir,
    mode === 'clone' ? [catalogName, sourceCatalogName] : [catalogName]
  )
  try {
    if (mode === 'update' || mode === 'clone') {
      try {
        await stat(sourceCatalogPath)
        await validateStagedCatalog(sourceCatalogPath)
      } catch {
        throw new Error('The selected catalog is unavailable or invalid.')
      }
    }
    if (mode !== 'update') {
      try {
        await stat(catalogPath)
        throw new Error('A catalog with that name already exists.')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  } catch (error) {
    await releaseCatalogMutations(reservations)
    throw error
  }

  const stagingPath = path.join(parentDir, `.${catalogName}.staging-${randomUUID()}`)
  const records: Record<string, unknown>[] = []
  const skipped: SongSourceCatalogResult['skipped'] = []
  const seenMidi = new Set<string>()
  try {
    if (mode === 'update' || mode === 'clone') {
      await cp(sourceCatalogPath, stagingPath, {
        recursive: true,
        errorOnExist: true,
        verbatimSymlinks: true
      })
    } else {
      await mkdir(stagingPath)
    }
    const stagingRoot = await realpath(stagingPath)
    await mkdir(path.join(stagingRoot, 'assets', 'sha256'), { recursive: true })
    // A copied policy is valid only for its exact catalog-control identity.
    // Catalog edits below can change records, rights, or catalog_id, so never
    // carry a stale Harmony admission policy into an update/clone. A curator
    // can explicitly recreate rows through the dedicated Harmony flow.
    if (mode === 'update' || mode === 'clone') {
      await unlink(path.join(stagingRoot, HARMONY_SOURCE_POLICY_FILENAME)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
    if (mode === 'update' || mode === 'clone') {
      const existingRecords = await readCatalogRecords(stagingRoot)
      if (mode === 'update' || mode === 'clone') {
        for (const record of existingRecords) {
          record.rights = { training_use: 'allowed', provenance, license }
          validateCatalogRecord(record)
        }
      }
      records.push(...existingRecords)
      for (const record of existingRecords) {
        const notes = (record.chart as { notes_midi: CatalogAsset }).notes_midi
        seenMidi.add(notes.sha256)
      }
    }
    for (const [sourceIndex, source] of options.sources.entries()) {
      options.onProgress?.({
        phase: 'normalizing',
        completed: sourceIndex,
        total: options.sources.length
      })
      let candidates: CatalogCandidate[]
      try {
        candidates = await inspectDatasetSource(source)
      } catch {
        if (source.packageReview) {
          // An explicit review selection must never quietly turn into a
          // partial catalog when the source was replaced after approval.
          throw new Error('A reviewed package changed or selected chart is unavailable.')
        }
        skipped.push({ sourceIndex, reason: 'Source could not be normalized' })
        continue
      }
      if (!candidates.length) {
        skipped.push({ sourceIndex, reason: 'Source has no notes.mid' })
        continue
      }
      for (const candidate of candidates) {
        assertSupervisedSourceAdmission(candidate)
        if (!isValidMidi(candidate.midi)) {
          skipped.push({ sourceIndex, reason: 'Source has invalid notes.mid' })
          continue
        }
        const notesSha256 = sha256Buffer(candidate.midi)
        if (seenMidi.has(notesSha256)) {
          skipped.push({ sourceIndex, reason: 'Duplicate MIDI asset' })
          continue
        }
        const notesAsset = await materializeCatalogAsset(
          stagingRoot,
          candidate.midi,
          NOTES_MIDI,
          'audio/midi'
        )
        const audio = Object.fromEntries(
          await Promise.all(
            Object.entries(candidate.audio).map(async ([role, input]) => [
              role,
              await materializeCatalogAsset(
                stagingRoot,
                input.bytes,
                `${role}.${input.extension}`,
                input.mediaType
              )
            ])
          )
        ) as Partial<Record<CatalogAudioRole, CatalogAsset>>
        options.onProgress?.({
          phase: 'materializing',
          completed: sourceIndex + 1,
          total: options.sources.length
        })
        const record = catalogRecord(candidate, notesAsset, notesSha256, audio) as {
          rights: { training_use: string; provenance: string; license: string }
        }
        // OCTAVE curation is the admission gate. A materialized catalog is
        // therefore a trainable artifact and can never carry an unresolved
        // review state, including when this service is called directly.
        record.rights = { training_use: 'allowed', provenance, license }
        validateCatalogRecord(record)
        records.push(record)
        seenMidi.add(notesSha256)
      }
    }
    const recordsPath = path.join(stagingPath, 'records.jsonl')
    await writeFile(
      recordsPath,
      records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''),
      'utf8'
    )
    const existingCatalog =
      mode === 'update'
        ? (JSON.parse(await readFile(path.join(stagingRoot, 'catalog.json'), 'utf8')) as Record<
            string,
            unknown
          >)
        : null
    const catalog = {
      schema_version: 1,
      format: 'octave-song-source-catalog/v1',
      catalog_id: existingCatalog?.catalog_id ?? catalogId,
      records: 'records.jsonl',
      curation: { provenance, license },
      created_by: { product: 'octave', version: options.octaveVersion }
    }
    if (!records.length) throw new Error('No valid source records were available for the catalog.')
    await writeFile(
      path.join(stagingPath, 'catalog.json'),
      JSON.stringify(catalog, null, 2) + '\n',
      'utf8'
    )
    options.onProgress?.({
      phase: 'validating',
      completed: options.sources.length,
      total: options.sources.length
    })
    await validateStagedCatalog(stagingRoot)
    await assertCatalogMutationReservations(reservations)
    if (mode === 'update') {
      const backupPath = path.join(parentDir, `.${catalogName}.backup-${randomUUID()}`)
      await rename(catalogPath, backupPath)
      try {
        await rename(stagingRoot, catalogPath)
      } catch (error) {
        await rename(backupPath, catalogPath)
        throw error
      }
      await rm(backupPath, { recursive: true, force: true })
    } else {
      try {
        await stat(catalogPath)
        throw new Error('A catalog with that name already exists.')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await rename(stagingRoot, catalogPath)
    }
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true })
    throw error
  } finally {
    await releaseCatalogMutations(reservations)
  }
  return {
    catalogPath,
    recordCount: records.length,
    skipped
  }
}

function recordNotesAsset(record: Record<string, unknown>): CatalogAsset {
  return (record.chart as { notes_midi: CatalogAsset }).notes_midi
}

function recordAudioAssets(
  record: Record<string, unknown>
): Partial<Record<CatalogAudioRole, CatalogAsset>> {
  return { ...((record.audio ?? {}) as Partial<Record<CatalogAudioRole, CatalogAsset>>) }
}

function assertNoSharedMixAndVocals(audio: Partial<Record<CatalogAudioRole, CatalogAsset>>): void {
  if (audio.mix && audio.vocals && audio.mix.sha256 === audio.vocals.sha256) {
    throw new Error('Catalog revision would reuse one audio asset for mix and vocals.')
  }
}

/**
 * Clone a catalog into a new revision and enrich precisely one pre-existing
 * chart with alternate audio. Unlike an ordinary clone, this operation never
 * adds records, changes a chart asset, rewrites record rights, or falls back
 * to an unreviewed/ambiguous package entry.
 */
export async function buildSongSourceCatalogAudioEnrichmentRevision(
  options: SongSourceCatalogAudioEnrichmentOptions
): Promise<SongSourceCatalogResult> {
  const { source } = options
  if (
    source.kind === 'octave-library' ||
    !source.entryId ||
    !source.packageReview ||
    !/^[a-f0-9]{64}$/.test(source.entryId)
  ) {
    throw new Error('Select one explicitly reviewed package chart for audio enrichment.')
  }
  const catalogName = validateCatalogName(options.catalogName)
  const catalogId = redactLocationText(options.catalogId, 'octave-catalog').slice(0, 128)
  const sourceCatalogName = validateCatalogName(options.sourceCatalogName)
  const parentDir = path.resolve(options.parentDir)
  const catalogPath = path.join(parentDir, catalogName)
  const sourceCatalogPath = path.join(parentDir, sourceCatalogName)
  if (catalogPath === sourceCatalogPath) {
    throw new Error('Audio enrichment must publish a new catalog revision.')
  }
  const reservationPath = path.join(parentDir, `.${catalogName}.catalog-reservation`)
  let reservation: Awaited<ReturnType<typeof open>>
  try {
    reservation = await open(reservationPath, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('A catalog build with that name is already in progress.')
    }
    throw error
  }

  const stagingPath = path.join(parentDir, `.${catalogName}.staging-${randomUUID()}`)
  try {
    try {
      await stat(sourceCatalogPath)
      await validateStagedCatalog(sourceCatalogPath)
    } catch {
      throw new Error('The selected catalog is unavailable or invalid.')
    }
    try {
      await stat(catalogPath)
      throw new Error('A catalog with that name already exists.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    options.onProgress?.({ phase: 'normalizing', completed: 0, total: 1 })
    // `inspectDatasetSource` reads a no-follow, capped descriptor snapshot
    // and checks the inventory container hash, locator, entry ID, and MIDI
    // hash together. It therefore fails closed if the reviewed source changed.
    let candidates: CatalogCandidate[]
    try {
      candidates = await inspectDatasetSource(source, true, true)
    } catch {
      // Adapter errors can include a package-controlled name or a private
      // location. This operation exposes only a stable review failure.
      throw new Error('Reviewed package changed or selected chart is unavailable.')
    }
    if (candidates.length !== 1 || !isValidMidi(candidates[0].midi)) {
      throw new Error('Reviewed package changed or selected chart is unavailable.')
    }
    const candidate = candidates[0]
    assertSupervisedSourceAdmission(candidate)
    const notesSha256 = sha256Buffer(candidate.midi)
    assertSafeAlternateAudio(candidate.audio)

    await cp(sourceCatalogPath, stagingPath, {
      recursive: true,
      errorOnExist: true,
      verbatimSymlinks: true
    })
    const stagingRoot = await realpath(stagingPath)
    const records = await readCatalogRecords(stagingRoot)
    const matchingRecords = records.filter(
      (record) => recordNotesAsset(record).sha256 === notesSha256
    )
    if (matchingRecords.length !== 1) {
      throw new Error('Selected chart is not a unique MIDI match in the target catalog.')
    }

    const record = matchingRecords[0]
    const audio = recordAudioAssets(record)
    for (const [role, input] of Object.entries(candidate.audio) as Array<
      [CatalogAudioRole, CatalogAudioInput]
    >) {
      const nextAsset = await materializeCatalogAsset(
        stagingRoot,
        input.bytes,
        `${role}.${input.extension}`,
        input.mediaType
      )
      // A same-role, byte-identical asset is a no-op, not an enrichment. Do
      // not silently accept it because callers could mistake it for a revised
      // training input.
      if (audio[role]?.sha256 === nextAsset.sha256) {
        throw new Error('Selected chart provides duplicate audio already present in the catalog.')
      }
      audio[role] = nextAsset
    }
    assertNoSharedMixAndVocals(audio)
    // Only audio changes. The JSON record retains its original import,
    // metadata, chart hash, source ID, and record-level rights/provenance.
    record.audio = audio
    validateCatalogRecord(record)

    options.onProgress?.({ phase: 'materializing', completed: 1, total: 1 })
    await writeFile(
      path.join(stagingRoot, 'records.jsonl'),
      records.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf8'
    )
    const sourceManifest = JSON.parse(
      await readFile(path.join(stagingRoot, 'catalog.json'), 'utf8')
    ) as Record<string, unknown>
    const sourceCuration = sourceManifest.curation as CatalogCuration | undefined
    const legacyRecordRights = records[0].rights as CatalogCuration
    const catalog = {
      schema_version: 1,
      format: 'octave-song-source-catalog/v1',
      catalog_id: catalogId,
      records: 'records.jsonl',
      // Record-level rights remain untouched above. The manifest makes the
      // derived nature of the revision explicit without leaking its source.
      curation: {
        provenance: 'Audio enrichment revision in OCTAVE',
        license:
          sourceCuration?.license ??
          legacyRecordRights.license ??
          'Permission recorded by catalog owner'
      },
      created_by: {
        product: 'octave',
        version: options.octaveVersion,
        source_revision: 'audio-enrichment'
      }
    }
    await writeFile(
      path.join(stagingRoot, 'catalog.json'),
      JSON.stringify(catalog, null, 2) + '\n',
      'utf8'
    )
    options.onProgress?.({ phase: 'validating', completed: 1, total: 1 })
    await validateStagedCatalog(stagingRoot)
    try {
      await stat(catalogPath)
      throw new Error('A catalog with that name already exists.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rename(stagingRoot, catalogPath)
    return { catalogPath, recordCount: records.length, skipped: [] }
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true })
    throw error
  } finally {
    await reservation.close()
    await unlink(reservationPath)
  }
}

export async function listDatasetLibrarySongs(libraryDir: string): Promise<DatasetLibrarySong[]> {
  const entries = await readdir(libraryDir, { withFileTypes: true })
  const songs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const songPath = path.join(libraryDir, entry.name)
        try {
          const metadata = parseIniFile(await readFile(path.join(songPath, 'song.ini'), 'utf8'))
          let hasNotesMidi = true
          try {
            await readFile(path.join(songPath, NOTES_MIDI))
          } catch {
            hasNotesMidi = false
          }
          return {
            path: songPath,
            name: String(metadata.name ?? entry.name),
            artist: String(metadata.artist ?? 'Unknown Artist'),
            charter: typeof metadata.charter === 'string' ? metadata.charter : undefined,
            datasetOptIn: isDatasetOptedIn(metadata.dataset_opt_in),
            isStrumGenerated: isStrumGenerated(metadata),
            hasNotesMidi
          }
        } catch {
          return null
        }
      })
  )
  return songs.filter((song) => song !== null) as DatasetLibrarySong[]
}

type Candidate = {
  source: ExportedSong['source']
  midi: Buffer
  metadata: Record<string, string>
  packageSha256?: string
  isStrumGenerated: boolean
}

/**
 * Export reviewed MIDI only. Library songs are deliberately consent-gated by
 * `dataset_opt_in = true`; package sources are explicit selections made in the
 * curation UI and never carry source paths into the export.
 */
export async function exportSngTrainingMidi(
  options: SngTrainingExportOptions
): Promise<SngTrainingExportResult> {
  const sourceCount =
    options.sngPaths.length +
    (options.conPaths?.length ?? 0) +
    (options.librarySongPaths?.length ?? 0)
  if (!sourceCount) throw new Error('At least one package or library song is required')
  for (const [name, value] of Object.entries({
    datasetId: options.datasetId,
    provenance: options.provenance,
    license: options.license
  })) {
    if (!value.trim()) throw new Error(`${name} must be non-empty`)
  }

  const outputDir = path.resolve(options.outputDir)
  await ensureEmptyOutputDir(outputDir)
  const songsDir = path.join(outputDir, 'songs')
  await mkdir(songsDir, { recursive: true })
  const exported: ExportedSong[] = []
  const skipped: Array<{ sourceIndex: number; reason: string }> = []
  const seenMidi = new Set<string>()
  let sourceIndex = 0

  const exportCandidate = async (candidate: Candidate, index: number): Promise<void> => {
    if (candidate.isStrumGenerated) {
      skipped.push({ sourceIndex: index, reason: GENERATED_REVISION_UNVERIFIED })
      return
    }
    if (!isValidMidi(candidate.midi)) {
      skipped.push({ sourceIndex: index, reason: 'Package could not be read or exported' })
      return
    }
    const notesSha256 = sha256Buffer(candidate.midi)
    if (seenMidi.has(notesSha256)) {
      skipped.push({
        sourceIndex: index,
        reason: `Duplicate notes.mid: ${notesSha256.slice(0, 12)}`
      })
      return
    }
    const songId = `${slug(`${candidate.metadata.artist ?? ''}-${candidate.metadata.name ?? ''}`)}-${notesSha256.slice(0, 12)}`
    const songDir = path.join(songsDir, songId)
    await mkdir(songDir)
    await writeFile(path.join(songDir, NOTES_MIDI), candidate.midi)
    await writeFile(
      path.join(songDir, 'source-metadata.json'),
      JSON.stringify(
        {
          source: candidate.source,
          metadata: candidate.metadata,
          notesSha256,
          packageSha256: candidate.packageSha256
        },
        null,
        2
      ) + '\n',
      'utf8'
    )
    seenMidi.add(notesSha256)
    exported.push({
      songId,
      midi: path.posix.join('songs', songId, NOTES_MIDI),
      notesSha256,
      packageSha256: candidate.packageSha256,
      source: candidate.source,
      metadata: candidate.metadata
    })
  }

  for (const sngPath of options.sngPaths) {
    const index = sourceIndex++
    try {
      const extracted = await extractSngNotesMidi(sngPath)
      if (!extracted) {
        skipped.push({ sourceIndex: index, reason: `Package has no ${NOTES_MIDI}` })
        continue
      }
      await exportCandidate(
        { ...extracted, source: 'sng', packageSha256: await sha256File(sngPath) },
        index
      )
    } catch {
      skipped.push({ sourceIndex: index, reason: 'Package could not be read or exported' })
    }
  }
  for (const conPath of options.conPaths ?? []) {
    const index = sourceIndex++
    try {
      const packageSha256 = await sha256File(conPath)
      const candidates = await extractConNotesMidi(conPath)
      if (!candidates.length) {
        skipped.push({ sourceIndex: index, reason: `Package has no ${NOTES_MIDI}` })
        continue
      }
      for (const candidate of candidates)
        await exportCandidate({ ...candidate, source: 'rb3con', packageSha256 }, index)
    } catch {
      skipped.push({ sourceIndex: index, reason: 'Package could not be read or exported' })
    }
  }
  for (const songPath of options.librarySongPaths ?? []) {
    const index = sourceIndex++
    try {
      const metadata = parseIniFile(await readFile(path.join(songPath, 'song.ini'), 'utf8'))
      if (!isDatasetOptedIn(metadata.dataset_opt_in)) {
        skipped.push({ sourceIndex: index, reason: 'Song is not opted into dataset curation' })
        continue
      }
      await exportCandidate(
        {
          source: 'octave-library',
          isStrumGenerated: isStrumGenerated(metadata),
          midi: await readFile(path.join(songPath, NOTES_MIDI)),
          metadata: sanitizeMetadata(metadata)
        },
        index
      )
    } catch {
      skipped.push({ sourceIndex: index, reason: 'Package could not be read or exported' })
    }
  }

  const manifestPath = path.join(outputDir, 'source-manifest.json')
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        format: EXPORT_FORMAT,
        datasetId: options.datasetId,
        provenance: options.provenance,
        license: options.license,
        exported,
        skipped
      },
      null,
      2
    ) + '\n',
    'utf8'
  )
  return { manifestPath, exported, skipped }
}
