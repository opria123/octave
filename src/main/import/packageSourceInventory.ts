import { createHash } from 'crypto'
import { constants } from 'fs'
import { open } from 'fs/promises'
import { join } from 'path'
import { Readable } from 'stream'
import { Worker } from 'worker_threads'
import { Midi } from '@tonejs/midi'
import AdmZip from 'adm-zip'
import { SngStream, type SngHeader } from 'parse-sng'
import { StfsParser } from './conImporter'
import { parseDta } from './dtaParser'
import type { DatasetCatalogSource } from './sngTrainingExporter'
import { normalizedPackageEntryLocator, packageEntryIdentity } from './packageSourceIdentity'

const NOTES_MIDI = 'notes.mid'
const NOTES_CHART = 'notes.chart'
const MAX_MIDI_BYTES = 64 * 1024 * 1024
const MAX_ZIP_ENTRIES = 2_000
const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_ZIP_CHART_COUNT = 256
const MAX_ZIP_EXTRACTED_CHART_BYTES = 128 * 1024 * 1024
const MAX_PACKAGE_COUNT = 1_000
const PACKAGE_TIMEOUT_MS = 15_000
/**
 * A package group can contain enough malformed or remote sources to make
 * sequential worker timeouts impractical. Keep a normal UI inventory bounded
 * and return its completed aggregate rather than relying on process shutdown.
 */
export const MAX_DATASET_PACKAGE_INVENTORY_DEADLINE_MS = 5 * 60 * 1_000
/**
 * Inventory deliberately has a much lower cap than catalog materialization.
 * STFS parsing expands directory entries and used to buffer every embedded
 * asset; accepting a two-gigabyte package here is neither useful nor safe.
 */
const MAX_INVENTORY_PACKAGE_BYTES = 256 * 1024 * 1024

export interface DatasetPackageSourceInventory {
  /** Packages requested by the opaque selection, before the bounded work limit. */
  selectedPackageCount: number
  /** Packages with a completed worker result; cancelled/timed-out work is excluded. */
  inspectedPackageCount: number
  packageLimitReachedCount: number
  /** The caller explicitly stopped inspection; counts cover completed work only. */
  cancelled: boolean
  /** Completed worker results backed by a bounded package snapshot. */
  readablePackageCount: number
  /** The container parser reached its package/header representation. */
  readableHeaderCount: number
  unreadablePackageCount: number
  /** Per-song/package chart candidates represented by a MIDI or notes.chart entry. */
  inspectedChartCount: number
  validNotesMidiCount: number
  /** Includes chart-only inputs; `chartOnlyCount` is the useful subset. */
  invalidOrMissingNotesMidiCount: number
  /** Has notes.chart but no MIDI that safely parses as a Standard MIDI File. */
  chartOnlyCount: number
  /** Exactly one canonical PART VOCALS track with observed Vocal label events. */
  exactExpertPartVocalsCount: number
  /** Later instances of a MIDI content hash; no hashes or source identities leave main. */
  duplicateMidiCount: number
  /** Later instances of a bounded container content hash; no hashes leave main. */
  duplicateContainerCount: number
  containerIdentityUnavailableCount: number
  decodeTimeoutCount: number
  decodeFailureCount: number
}

export interface InventoryChart {
  validNotesMidi: boolean
  hasChart: boolean
  exactExpertPartVocals: boolean
  /** SHA-256 is aggregate-only bookkeeping and never crosses main/renderer IPC. */
  midiHash: string | null
  /** Main-process-only adapter key used to bind a later exact extraction. */
  entryLocator: string | null
}

export interface PackageInspection {
  headerReadable: boolean
  charts: InventoryChart[]
}

export interface IsolatedPackageInspection {
  outcome: 'inspected'
  containerHash: string | null
  inspection: PackageInspection
}

export interface RejectedPackageInspection {
  /** A worker-completed safe refusal; no source-specific error crosses IPC. */
  outcome: 'rejected'
}

type IsolatedPackageResult = IsolatedPackageInspection | RejectedPackageInspection

export interface DatasetPackageInventoryOptions {
  /** Ends queued/current work without exposing source-specific failure detail. */
  signal?: AbortSignal
  /**
   * Maximum wall-clock time for this aggregate-only inventory. Values are
   * clamped to the normal UI-job bound; expiry returns `cancelled: true` with
   * only completed worker results represented in the counters.
   */
  deadlineMs?: number
  /**
   * Aggregate-only progress for a caller's own selected group. `processed`
   * includes settled timeouts/rejections; `completed` is strictly a worker
   * result and therefore matches `inspectedPackageCount`.
   */
  onProgress?: (progress: DatasetPackageInventoryProgress) => void
  /** Test and integration hook; production uses the worker isolation below. */
  inspectInIsolation?: (
    source: DatasetCatalogSource,
    signal: AbortSignal
  ) => Promise<IsolatedPackageResult>
}

export interface DatasetPackageInventoryProgress {
  processedPackageCount: number
  completedPackageCount: number
  totalPackageCount: number
}

/**
 * Main-process-only resumable state. It is deliberately opaque: MIDI and
 * container hashes, source locations, and the next package remain private to
 * the process that created it and cannot be reconstructed by a renderer.
 */
export interface DatasetPackageInventorySession {
  readonly __opaqueDatasetPackageInventorySession?: never
}

/** Private evidence retained by OCTAVE after a completed inventory. */
export interface DatasetPackageReviewEntry {
  source: DatasetCatalogSource
  containerSha256: string
  midiSha256: string
  entryLocator: string
  entryId: string
  exactExpertPartVocals: boolean
  duplicateMidi: boolean
}

interface DatasetPackageInventorySessionState {
  sources: readonly DatasetCatalogSource[]
  inventory: DatasetPackageSourceInventory
  midiHashes: Set<string>
  containerHashes: Set<string>
  nextSourceIndex: number
  reviewEntries: DatasetPackageReviewEntry[]
}

const inventorySessionStates = new WeakMap<
  DatasetPackageInventorySession,
  DatasetPackageInventorySessionState
>()

export interface InventorySnapshotOptions {
  /** Test seam for validating descriptor identity across a path replacement. */
  afterOpen?: () => Promise<void>
}

interface RawInventoryChart {
  midi: Buffer | null
  midiCount: number
  hasChart: boolean
  entryLocator: string
}

interface RawPackageInspection {
  headerReadable: boolean
  charts: RawInventoryChart[]
}

interface ZipInventoryLimits {
  maxChartCount: number
  maxExtractedChartBytes: number
}

function emptyInventory(selectedPackageCount: number): DatasetPackageSourceInventory {
  return {
    selectedPackageCount,
    inspectedPackageCount: 0,
    packageLimitReachedCount: 0,
    cancelled: false,
    readablePackageCount: 0,
    readableHeaderCount: 0,
    unreadablePackageCount: 0,
    inspectedChartCount: 0,
    validNotesMidiCount: 0,
    invalidOrMissingNotesMidiCount: 0,
    chartOnlyCount: 0,
    exactExpertPartVocalsCount: 0,
    duplicateMidiCount: 0,
    duplicateContainerCount: 0,
    containerIdentityUnavailableCount: 0,
    decodeTimeoutCount: 0,
    decodeFailureCount: 0
  }
}

/** Starts a main-owned bounded inventory session that may be resumed later. */
export function createDatasetPackageInventorySession(
  sources: readonly DatasetCatalogSource[]
): DatasetPackageInventorySession {
  const boundedSources = sources
    .slice(0, MAX_PACKAGE_COUNT)
    .map((source) => ({ kind: source.kind, sourcePath: source.sourcePath }))
  const inventory = emptyInventory(sources.length)
  inventory.packageLimitReachedCount = sources.length - boundedSources.length
  const session = Object.freeze({}) as DatasetPackageInventorySession
  inventorySessionStates.set(session, {
    sources: boundedSources,
    inventory,
    midiHashes: new Set<string>(),
    containerHashes: new Set<string>(),
    nextSourceIndex: 0,
    reviewEntries: []
  })
  return session
}

function sessionState(
  session: DatasetPackageInventorySession
): DatasetPackageInventorySessionState {
  const state = inventorySessionStates.get(session)
  if (!state) throw new Error('Unknown package inventory session.')
  return state
}

/** Returns only the renderer-safe aggregate snapshot for a main-owned session. */
export function getDatasetPackageInventorySessionResult(
  session: DatasetPackageInventorySession
): DatasetPackageSourceInventory {
  return { ...sessionState(session).inventory }
}

export function isDatasetPackageInventorySessionComplete(
  session: DatasetPackageInventorySession
): boolean {
  const state = sessionState(session)
  return state.nextSourceIndex >= state.sources.length
}

/**
 * Return only main-process evidence after a fully completed pass.  Callers
 * must replace every field with opaque renderer capabilities before IPC.
 */
export function getDatasetPackageInventorySessionReviewEntries(
  session: DatasetPackageInventorySession
): DatasetPackageReviewEntry[] {
  const state = sessionState(session)
  if (state.nextSourceIndex < state.sources.length) return []
  return state.reviewEntries.map((entry) => ({ ...entry, source: { ...entry.source } }))
}

function normalizedEntryName(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

function entryDirectory(value: string): string {
  const normalized = normalizedEntryName(value)
  const slash = normalized.lastIndexOf('/')
  return slash === -1 ? '' : normalized.slice(0, slash + 1)
}

function safeZipEntryName(entryName: string): string | null {
  const normalized = normalizedEntryName(entryName)
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.split('/').some((part) => part === '..')
  ) {
    return null
  }
  return normalized
}

function validMidiChunkLayout(midi: Buffer): boolean {
  if (
    midi.length < 14 ||
    midi.subarray(0, 4).toString('ascii') !== 'MThd' ||
    midi.readUInt32BE(4) !== 6
  ) {
    return false
  }
  const trackCount = midi.readUInt16BE(10)
  if (trackCount === 0) return false
  let offset = 14
  for (let index = 0; index < trackCount; index += 1) {
    if (
      offset + 8 > midi.length ||
      midi.subarray(offset, offset + 4).toString('ascii') !== 'MTrk'
    ) {
      return false
    }
    const trackLength = midi.readUInt32BE(offset + 4)
    offset += 8
    if (trackLength > midi.length - offset) return false
    offset += trackLength
  }
  return offset === midi.length
}

/** Reject malformed channel data that permissive MIDI readers can silently normalize. */
function hasStrictMidiEventData(midi: Buffer): boolean {
  const readVariableLength = (end: number, start: number): number | null => {
    let offset = start
    for (let count = 0; count < 4; count += 1) {
      if (offset >= end) return null
      const value = midi[offset++]
      if ((value & 0x80) === 0) return offset
    }
    return null
  }
  let offset = 14
  const tracks = midi.readUInt16BE(10)
  for (let track = 0; track < tracks; track += 1) {
    const trackLength = midi.readUInt32BE(offset + 4)
    const end = offset + 8 + trackLength
    offset += 8
    let runningStatus = 0
    while (offset < end) {
      const afterDelta = readVariableLength(end, offset)
      if (afterDelta === null || afterDelta >= end) return false
      offset = afterDelta
      let status = midi[offset]
      let dataStart = offset + 1
      if (status < 0x80) {
        if (runningStatus < 0x80 || runningStatus > 0xef) return false
        status = runningStatus
        dataStart = offset
      } else if (status >= 0x80 && status <= 0xef) {
        runningStatus = status
      } else {
        runningStatus = 0
      }
      if (status >= 0x80 && status <= 0xef) {
        const dataLength = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2
        if (dataStart + dataLength > end) return false
        for (let index = 0; index < dataLength; index += 1) {
          if (midi[dataStart + index] >= 0x80) return false
        }
        offset = dataStart + dataLength
        continue
      }
      if (status === 0xff) {
        if (dataStart >= end) return false
        const payloadStart = readVariableLength(end, dataStart + 1)
        if (payloadStart === null) return false
        let length = 0
        for (let index = dataStart + 1; index < payloadStart; index += 1) {
          length = (length << 7) | (midi[index] & 0x7f)
        }
        offset = payloadStart + length
        if (offset > end) return false
        continue
      }
      if (status === 0xf0 || status === 0xf7) {
        const payloadStart = readVariableLength(end, dataStart)
        if (payloadStart === null) return false
        let length = 0
        for (let index = dataStart; index < payloadStart; index += 1) {
          length = (length << 7) | (midi[index] & 0x7f)
        }
        offset = payloadStart + length
        if (offset > end) return false
        continue
      }
      const systemDataLength = status === 0xf1 || status === 0xf3 ? 1 : status === 0xf2 ? 2 : 0
      if (![0xf1, 0xf2, 0xf3, 0xf6, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe].includes(status)) {
        return false
      }
      if (dataStart + systemDataLength > end) return false
      for (let index = 0; index < systemDataLength; index += 1) {
        if (midi[dataStart + index] >= 0x80) return false
      }
      offset = dataStart + systemDataLength
    }
    if (offset !== end) return false
  }
  return true
}

function parseSafeMidi(midi: Buffer): Midi | null {
  if (
    midi.length > MAX_MIDI_BYTES ||
    !validMidiChunkLayout(midi) ||
    !hasStrictMidiEventData(midi)
  ) {
    return null
  }
  try {
    return new Midi(midi)
  } catch {
    return null
  }
}

function hasExactExpertPartVocals(midi: Midi): boolean {
  const tracks = midi.tracks.filter((track) => track.name === 'PART VOCALS')
  if (tracks.length !== 1) return false
  // Vocal parts do not use the five-lane difficulty bands. OCTAVE records
  // their present coverage as Expert; verify the canonical lead track has an
  // actual sung-pitch (36..84) or talky (96) label rather than a name alone.
  return tracks[0].notes.some((note) => (note.midi >= 36 && note.midi <= 84) || note.midi === 96)
}

/**
 * Open once and read that descriptor only. A rename after `open` cannot swap
 * in an oversized package between validation, hashing, and parsing.
 */
export async function readInventoryPackageSnapshot(
  filePath: string,
  options: InventorySnapshotOptions = {}
): Promise<Buffer> {
  // A symlink may have been planted after bounded discovery. Require the
  // kernel-level no-follow flag instead of resolving user-controlled paths.
  const noFollow = constants.O_NOFOLLOW
  const noBlock = constants.O_NONBLOCK
  if (
    !Number.isInteger(noFollow) ||
    noFollow === 0 ||
    !Number.isInteger(noBlock) ||
    noBlock === 0
  ) {
    throw new Error('Secure package snapshots are unsupported on this runtime.')
  }
  // O_NONBLOCK avoids hanging on a FIFO/device before fstat rejects it.
  const handle = await open(filePath, constants.O_RDONLY | noFollow | noBlock)
  try {
    await options.afterOpen?.()
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_INVENTORY_PACKAGE_BYTES)
      throw new Error('Package is unavailable or too large.')
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) throw new Error('Package changed while being read.')
      offset += bytesRead
    }
    const afterRead = await handle.stat()
    if (!afterRead.isFile() || afterRead.size !== info.size)
      throw new Error('Package changed while being read.')
    return bytes
  } finally {
    await handle.close()
  }
}

async function inspectSng(packageBytes: Buffer): Promise<RawPackageInspection> {
  return await new Promise((resolve, reject) => {
    const input = Readable.from([packageBytes])
    let settled = false
    let headerReadable = false
    let expectedFiles: number | null = null
    let completedFiles = 0
    let notesMidi: Buffer | null = null
    let notesMidiCount = 0
    let hasChart = false
    let active: ReadableStream<Uint8Array> | null = null
    const timeout = setTimeout(
      () => fail(new Error('Package decode timed out.')),
      PACKAGE_TIMEOUT_MS
    )
    const stop = (): void => {
      if (active) void active.cancel().catch(() => undefined)
      if (!input.destroyed) input.destroy()
    }
    const settle = (callback: () => void, stopStreams = false): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (stopStreams) stop()
      callback()
    }
    const fail = (error: unknown): void =>
      settle(() => reject(error instanceof Error ? error : new Error(String(error))), true)
    input.on('error', () => undefined)
    const parser = new SngStream(Readable.toWeb(input) as ReadableStream<Uint8Array>, {
      generateSongIni: false
    })
    parser.on('header', (header: SngHeader) => {
      headerReadable = true
      expectedFiles = header.fileMeta.length
      if (expectedFiles === 0) settle(() => resolve({ headerReadable, charts: [] }), true)
    })
    parser.on('file', (fileName, fileStream, nextFile) => {
      void (async () => {
        if (settled) return
        if (expectedFiles === null || completedFiles >= expectedFiles) {
          throw new Error('Invalid SNG file sequence.')
        }
        active = fileStream as ReadableStream<Uint8Array>
        const name = normalizedEntryName(fileName)
        if (name === NOTES_MIDI) {
          notesMidiCount += 1
          const chunks: Buffer[] = []
          let byteLength = 0
          for await (const chunk of Readable.fromWeb(
            fileStream as import('stream/web').ReadableStream<Uint8Array>
          )) {
            byteLength += chunk.length
            if (byteLength > MAX_MIDI_BYTES) throw new Error('MIDI entry is too large.')
            chunks.push(Buffer.from(chunk))
          }
          notesMidi = Buffer.concat(chunks)
        } else {
          if (name === NOTES_CHART) hasChart = true
          for await (const chunk of Readable.fromWeb(
            fileStream as import('stream/web').ReadableStream<Uint8Array>
          )) {
            void chunk
          }
        }
        active = null
        completedFiles += 1
        if (completedFiles === expectedFiles) {
          settle(
            () =>
              resolve({
                headerReadable,
                charts: [
                  {
                    midi: notesMidiCount === 1 ? notesMidi : null,
                    midiCount: notesMidiCount,
                    hasChart,
                    entryLocator: NOTES_MIDI
                  }
                ]
              }),
            true
          )
          return
        }
        if (!nextFile) throw new Error('SNG package ended before all files were read.')
        nextFile()
      })().catch(fail)
    })
    parser.on('error', fail)
    parser.start()
  })
}

function inspectZip(
  packageBytes: Buffer,
  limits: ZipInventoryLimits = {
    maxChartCount: MAX_ZIP_CHART_COUNT,
    maxExtractedChartBytes: MAX_ZIP_EXTRACTED_CHART_BYTES
  }
): RawPackageInspection {
  const archive = new AdmZip(packageBytes)
  const entries = archive.getEntries()
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error('ZIP archive has too many entries.')
  const charts = new Map<string, RawInventoryChart>()
  let extractedChartBytes = 0
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const name = safeZipEntryName(entry.entryName)
    if (
      !name ||
      !Number.isSafeInteger(entry.header.size) ||
      entry.header.size > MAX_ZIP_ENTRY_BYTES
    ) {
      throw new Error('ZIP archive entry is unsafe or too large.')
    }
    const base = name.slice(name.lastIndexOf('/') + 1)
    if (base !== NOTES_MIDI && base !== NOTES_CHART) continue
    const directory = entryDirectory(name)
    const chart = charts.get(directory) ?? {
      midi: null,
      midiCount: 0,
      hasChart: false,
      entryLocator: directory
    }
    if (!charts.has(directory) && charts.size >= limits.maxChartCount) {
      throw new Error('ZIP archive has too many chart candidates.')
    }
    if (base === NOTES_CHART) chart.hasChart = true
    else {
      chart.midiCount += 1
      if (chart.midiCount === 1) {
        extractedChartBytes += entry.header.size
        if (extractedChartBytes > limits.maxExtractedChartBytes) {
          throw new Error('ZIP archive chart data exceeds the aggregate limit.')
        }
        chart.midi = entry.getData()
      } else chart.midi = null
    }
    charts.set(directory, chart)
  }
  return { headerReadable: true, charts: [...charts.values()] }
}

function findConMidi(
  entries: Record<string, Buffer>,
  shortname: string,
  allowGlobalFallback: boolean
): Buffer | null {
  const short = shortname.toLowerCase()
  for (const [entryPath, value] of Object.entries(entries)) {
    const normalized = normalizedEntryName(entryPath)
    if (normalized === `${short}.mid` || normalized.endsWith(`/${short}.mid`)) return value
  }
  if (!allowGlobalFallback) return null
  return (
    Object.entries(entries).find(([entryPath]) =>
      normalizedEntryName(entryPath).endsWith('.mid')
    )?.[1] ?? null
  )
}

function inspectCon(packageBytes: Buffer): RawPackageInspection {
  const parser = new StfsParser(packageBytes)
  const { entries } = parser.parse()
  const dta = Object.entries(entries).find(([entryPath]) =>
    normalizedEntryName(entryPath).endsWith('songs/songs.dta')
  )?.[1]
  if (!dta) return { headerReadable: true, charts: [] }
  const songs = Object.values(parseDta(dta.toString('latin1')))
  const allowGlobalFallback = songs.length === 1
  const locators = new Set<string>()
  return {
    headerReadable: true,
    charts: songs.map((song) => {
      const entryLocator = normalizedPackageEntryLocator(song.shortname)
      if (!entryLocator || locators.has(entryLocator)) {
        throw new Error('RB3CON contains ambiguous song entries.')
      }
      locators.add(entryLocator)
      return {
        midi: findConMidi(entries, song.shortname, allowGlobalFallback),
        midiCount: 1,
        hasChart: false,
        entryLocator
      }
    })
  }
}

/** Runs only in the isolated inventory worker, never on Electron's main thread. */
async function inspectPackageBytesInWorker(
  source: DatasetCatalogSource,
  packageBytes: Buffer
): Promise<RawPackageInspection> {
  if (source.kind === 'sng') return inspectSng(packageBytes)
  if (source.kind === 'zip') return inspectZip(packageBytes)
  if (source.kind === 'rb3con') return inspectCon(packageBytes)
  throw new Error('Only externally selected package sources may be inventoried.')
}

function summarizeRawChart(chart: RawInventoryChart): InventoryChart {
  const midi = chart.midiCount === 1 && chart.midi ? parseSafeMidi(chart.midi) : null
  if (!midi || !chart.midi) {
    return {
      validNotesMidi: false,
      hasChart: chart.hasChart,
      exactExpertPartVocals: false,
      midiHash: null,
      entryLocator: null
    }
  }
  return {
    validNotesMidi: true,
    hasChart: chart.hasChart,
    exactExpertPartVocals: hasExactExpertPartVocals(midi),
    midiHash: createHash('sha256').update(chart.midi).digest('hex'),
    entryLocator: normalizedPackageEntryLocator(chart.entryLocator)
  }
}

function summarizePackageInspection(raw: RawPackageInspection): PackageInspection {
  return { headerReadable: raw.headerReadable, charts: raw.charts.map(summarizeRawChart) }
}

/** Test-only entry point for aggregate ZIP extraction limits. */
export function inspectZipForInventoryTest(
  packageBytes: Buffer,
  limits: ZipInventoryLimits
): PackageInspection {
  return summarizePackageInspection(inspectZip(packageBytes, limits))
}

/**
 * This worker-only operation owns the security boundary: no main-process
 * preflight is trusted, and all work uses a single cap-validated file handle.
 */
export async function inspectIsolatedPackageInWorker(
  source: DatasetCatalogSource
): Promise<IsolatedPackageInspection> {
  const packageBytes = await readInventoryPackageSnapshot(source.sourcePath)
  return {
    outcome: 'inspected',
    containerHash: createHash('sha256').update(packageBytes).digest('hex'),
    inspection: summarizePackageInspection(await inspectPackageBytesInWorker(source, packageBytes))
  }
}

function inventoryAbortError(): Error {
  return new Error('Package inventory cancelled.')
}

function inspectInWorker(
  source: DatasetCatalogSource,
  signal: AbortSignal
): Promise<IsolatedPackageResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    // `packageSourceInventory.ts` is code-split into out/main/chunks while the
    // dedicated worker is an explicit main entry at out/main. Keep this
    // relative to the compiled chunk, rather than relying on a source `.ts`
    // URL that would be absent in packaged Electron builds.
    const worker = new Worker(join(__dirname, '..', 'packageSourceInventoryWorker.js'), {
      workerData: { source }
    })
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      void worker.terminate().catch(() => undefined)
      callback()
    }
    const abort = (): void => finish(() => reject(inventoryAbortError()))
    const timeout = setTimeout(
      () => finish(() => reject(new Error('Package decode timed out.'))),
      PACKAGE_TIMEOUT_MS
    )
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    worker.once('message', (result: unknown) => {
      if (
        !result ||
        typeof result !== 'object' ||
        !('ok' in result) ||
        (result as { ok?: unknown }).ok !== true
      ) {
        finish(() => reject(new Error('Package inspection failed.')))
        return
      }
      const value = result as unknown as IsolatedPackageResult
      finish(() => resolve(value))
    })
    worker.once('error', () => finish(() => reject(new Error('Package inspection failed.'))))
    worker.once('exit', (code) => {
      if (code !== 0) finish(() => reject(new Error('Package inspection failed.')))
    })
  })
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && /timed out/i.test(error.message)
}

/**
 * Runs the next bounded segment of a main-owned session. Its result and
 * progress are aggregate-only; the state that enables resumption never leaves
 * main and is rejected if an unknown session is supplied.
 */
export async function runDatasetPackageInventorySession(
  session: DatasetPackageInventorySession,
  options: DatasetPackageInventoryOptions = {}
): Promise<DatasetPackageSourceInventory> {
  const state = sessionState(session)
  const { inventory } = state
  inventory.cancelled = false
  const controller = new AbortController()
  const publishProgress = (): void => {
    try {
      options.onProgress?.({
        processedPackageCount: state.nextSourceIndex,
        completedPackageCount: inventory.inspectedPackageCount,
        totalPackageCount: state.sources.length
      })
    } catch {
      // Progress delivery must not turn a safe aggregate inventory into a
      // source-specific failure. The caller receives the final result below.
    }
  }
  const abort = (): void => controller.abort()
  const requestedDeadlineMs = options.deadlineMs ?? MAX_DATASET_PACKAGE_INVENTORY_DEADLINE_MS
  const deadlineMs = Math.max(
    1,
    Math.min(
      Number.isFinite(requestedDeadlineMs)
        ? Math.floor(requestedDeadlineMs)
        : MAX_DATASET_PACKAGE_INVENTORY_DEADLINE_MS,
      MAX_DATASET_PACKAGE_INVENTORY_DEADLINE_MS
    )
  )
  const deadline = setTimeout(abort, deadlineMs)
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  publishProgress()
  for (; state.nextSourceIndex < state.sources.length; ) {
    if (controller.signal.aborted) {
      inventory.cancelled = true
      break
    }
    const source = state.sources[state.nextSourceIndex]
    try {
      const isolated = await (options.inspectInIsolation ?? inspectInWorker)(
        source,
        controller.signal
      )
      if (isolated.outcome === 'rejected') {
        // The worker completed a deliberate, path-free safe refusal. It is a
        // complete result, unlike a timeout/cancellation, so the aggregate
        // counters remain mutually consistent.
        inventory.inspectedPackageCount += 1
        inventory.unreadablePackageCount += 1
        inventory.decodeFailureCount += 1
        continue
      }
      // Do not expose an in-flight attempt as inspected/readable. A completed
      // worker result is the only point at which these counts become true.
      inventory.inspectedPackageCount += 1
      inventory.readablePackageCount += 1
      const containerHash = isolated.containerHash
      // A failed/unavailable identity contributes exactly once. It is not a
      // decode failure and must not be double-counted after the worker returns.
      if (containerHash === null) inventory.containerIdentityUnavailableCount += 1
      else if (state.containerHashes.has(containerHash)) inventory.duplicateContainerCount += 1
      else state.containerHashes.add(containerHash)

      const inspected = isolated.inspection
      if (inspected.headerReadable) inventory.readableHeaderCount += 1
      for (const chart of inspected.charts) {
        inventory.inspectedChartCount += 1
        if (!chart.validNotesMidi) {
          inventory.invalidOrMissingNotesMidiCount += 1
          if (chart.hasChart) inventory.chartOnlyCount += 1
          continue
        }
        inventory.validNotesMidiCount += 1
        if (chart.exactExpertPartVocals) inventory.exactExpertPartVocalsCount += 1
        const duplicateMidi = Boolean(chart.midiHash && state.midiHashes.has(chart.midiHash))
        if (duplicateMidi) inventory.duplicateMidiCount += 1
        else if (chart.midiHash) state.midiHashes.add(chart.midiHash)
        // A valid chart from a completed snapshot has all three values. Keep
        // them private for the later user-review capability; never include
        // this evidence in aggregate IPC or progress events.
        if (containerHash && chart.midiHash && chart.entryLocator !== null) {
          state.reviewEntries.push({
            source: { ...source },
            containerSha256: containerHash,
            midiSha256: chart.midiHash,
            entryLocator: chart.entryLocator,
            entryId: packageEntryIdentity(
              source.kind as 'sng' | 'rb3con' | 'zip',
              containerHash,
              chart.entryLocator,
              chart.midiHash
            ),
            exactExpertPartVocals: chart.exactExpertPartVocals,
            duplicateMidi
          })
        }
      }
    } catch (error) {
      // Terminated work never produced a completed package result, so it must
      // not make `readable + unreadable > inspected` in the renderer contract.
      if (isTimeout(error)) {
        inventory.decodeTimeoutCount += 1
      }
    } finally {
      // A cancellation terminates the in-flight worker. It must not be shown
      // as processed or completed because it has no stable aggregate result.
      if (!controller.signal.aborted) {
        state.nextSourceIndex += 1
        publishProgress()
      }
    }
  }
  if (controller.signal.aborted) inventory.cancelled = true
  clearTimeout(deadline)
  options.signal?.removeEventListener('abort', abort)
  return { ...inventory }
}

/**
 * One-shot compatibility entry point. Resumable callers retain the opaque
 * session above; this function still returns only the final aggregate.
 */
export async function inventoryDatasetPackageSources(
  sources: readonly DatasetCatalogSource[],
  options: DatasetPackageInventoryOptions = {}
): Promise<DatasetPackageSourceInventory> {
  return await runDatasetPackageInventorySession(
    createDatasetPackageInventorySession(sources),
    options
  )
}
