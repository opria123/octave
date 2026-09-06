import { app, BrowserWindow, dialog } from 'electron'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { constants, createReadStream, existsSync, type Dirent } from 'fs'
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile
} from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'path'
import { parseMidi } from 'midi-file'
import type {
  StrumCheckpointCandidateInputContract,
  StrumCheckpointCandidateOutputContract,
  StrumCheckpointCandidateTargetContract,
  StrumCheckpointOutputCandidate,
  StrumCheckpointOutputContracts,
  StrumPromotionJobDescriptor,
  StrumPromotionJobResult
} from '../../shared/strumTrainingContracts'
import {
  cancelProfileUrlMaterialization,
  materializeProfileUrlAudio,
  resolvePythonCommand,
  type MaterializedProfileAudio,
  type PythonCommand
} from './runner'
import { sanitizeTrainingSchemaValues } from './trainingSchema'
import type { AutoChartRunOptions, AutoChartRunResult, TypedChartArtifacts } from './types'

const PROTOCOL_MAJOR = 1
const TRAINING_ROOT_NAME = 'strum-training'
const RUNTIME_SETTINGS_NAME = 'runtime.json'
const REGISTRY_NAME = 'registry.json'
const MODEL_BUNDLE_MANIFEST_NAME = 'strum-model-bundle.json'
const MAX_DISCOVERED_MODEL_MANIFESTS = 256
const MAX_MODEL_DISCOVERY_DEPTH = 8
const MODEL_DISCOVERY_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '__pycache__',
  'node_modules',
  // STRUM composition bundles retain private child bundles here for runtime
  // provenance. The outer manifest is the only OCTAVE-selectable artifact.
  '_composition_assets'
])
const SAFE_RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_STRUM_RUNTIME_FALLBACK_ID = /^strum-\d+\.\d+\.\d+\+git\.[a-f0-9]{7,64}$/
const SAFE_PROTOCOL_VERSION = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/
const SAFE_RUNTIME_CAPABILITY = /^[a-z][a-z0-9_]{0,63}$/
const SAFE_RUNTIME_PIPELINE_ID =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,3}$/
const SAFE_RUNTIME_DEVICE = /^[a-z][a-z0-9_]{0,31}$/
const SAFE_SOURCE_REVISION = /^[a-f0-9]{7,64}$/
const DEFAULT_WORKER_JSON_TIMEOUT_MS = 20_000
// Profile-grade catalog inspection fully decodes every candidate's dedicated
// audio stream.  Its worker-side per-stream admission timeout is intentionally
// conservative, so the UI must not reuse the short discovery/probe timeout.
const CATALOG_INSPECTION_TIMEOUT_MS = 15 * 60_000

export type TrainingPipeline = {
  id: string
  display_name: string
  kind: string
  version: number
  status: string
  preparation_status: string
  training_status: string
  catalog_requirements: Record<string, unknown>
  prepare_schema: Record<string, unknown>
  train_schema: Record<string, unknown> | null
  checkpoint_outputs: string[]
  checkpoint_output_contracts?: StrumCheckpointOutputContracts
  inference_capability: string | null
  private_request_fields: string[]
  catalog_inspection_option_keys: string[]
  training_requirements: string[]
  promotion_jobs: TrainingPromotionJob[]
}

/**
 * Public, path-free metadata for a STRUM-owned post-training operation. The
 * renderer may describe this metadata, but it never receives values for the
 * declared private request fields.
 */
export type TrainingPromotionJob = StrumPromotionJobDescriptor

export type TrainingPromotionResult = StrumPromotionJobResult & {
  /** Opaque OCTAVE identity for chaining private evidence between jobs. */
  promotionId: string
  candidateArtifactId: string
  /** Present only after OCTAVE re-inspects a packaged model bundle. */
  artifactId?: string
  deploymentStatus?: DiscoveredCheckpoint['deploymentStatus']
}

export type TrainingRuntime = {
  runtimeId: string
  displayName: string
  kind: 'bundled_inference' | 'developer_override' | 'managed_checkout' | 'installed_runtime'
  protocolVersion: string
  capabilities: string[]
  pipelineIds: string[]
  deviceSupport: string[]
  trainingSetupRequired: boolean
  dirty: boolean
  sourceRevision: string | null
}

export type TrainingCatalogInspection = {
  pipelineId: string
  eligibleCount: number
  recordCount: number
  excluded: Record<string, number>
  audioPolicy: Record<string, unknown>
  estimatedStorageBytes: number
  storageEstimateCapped: boolean
  storageEstimateSemantics: string
}

export type TrainingTask = {
  taskViewId: string
  catalogId: string
  catalogName: string
  pipelineId: string
  eligibleCount: number
  contentHash: string
  createdAt: string
}

export type TrainingRun = {
  runId: string
  taskViewId: string
  pipelineId: string
  checkpointCount: number
  deployable: boolean
  checkpointManifestHash: string
  /** Opaque identity of a worker re-inspected candidate, if registration succeeded. */
  artifactId?: string
  createdAt: string
}

export type TrainingCheckpoint = {
  runId: string
  pipelineId: string
  runtimeId: string
  taskViewId: string
  taskViewHash: string
  checkpointManifestHash: string
  deployable: boolean
  deploymentReason: string | null
  components: Array<{ id: string; sha256: string; byteLength: number }>
}

export type AutoChartProfile = {
  profileId: string
  /** OCTAVE's previous run-backed profile records retain this field. */
  runId?: string
  /** STRUM's declared profile ID. This may differ from OCTAVE's local ID. */
  strumProfileId?: string
  /** Opaque, manifest-derived identity for a discovered model bundle. */
  artifactId?: string
  /** The STRUM-declared policy validated for this default. */
  difficultyPolicy?: string
  pipelineId: string
  runtimeId: string
  createdAt: string
  isDefault: boolean
}

/**
 * Local-only registry data. `checkpointRoot` must never cross the main-process
 * boundary: renderer callers identify a verified bundle solely by its opaque
 * artifact identity.
 */
type StoredAutoChartProfile = AutoChartProfile & {
  checkpointRoot: string
  manifestSha256?: string
}

export type DiscoveredCheckpointProfile = {
  profileId: string
  capability: string
  instruments: string[]
  difficultyPolicies: string[]
  requiredComponents: string[]
  execution: {
    status: 'available' | 'not_available'
    difficultyPolicies: string[]
  }
}

export type DiscoveredCheckpoint = {
  artifactId: string
  modelId: string
  manifestSha256: string
  schemaVersion: number
  compatibility: Record<string, string | number | boolean | null>
  components: Array<{ id: string; sha256: string; byteLength: number }>
  profiles: DiscoveredCheckpointProfile[]
  rejectedProfileCount: number
  deploymentStatus: 'ready' | 'not_deployable'
}

export type CheckpointDiscovery = {
  candidateCount: number
  profileCount: number
  rejectedBundleCount: number
  truncated: boolean
  candidates: DiscoveredCheckpoint[]
}

export type TrainingJobEvent = {
  jobId: string
  sequence: number
  stage: string
  progress?: number
  state?:
    | 'queued'
    | 'validating'
    | 'provisioning'
    | 'running'
    | 'cancelling'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
  code?: string
  message: string
  result?: Record<string, unknown> | TrainingPromotionResult
}

type RuntimeSettings = {
  developerSourceRoot?: string
  developerPython?: PythonCommand
  developerRuntimeLock?: DeveloperRuntimeLock
  installedWorkerPath?: string
  installedRuntimeLock?: InstalledRuntimeLock
}

type RuntimeProbeLock = {
  runtimeId: string
  protocolVersion: string
  capabilities: string[]
  sourceRevision: string | null
  dirty: boolean
  validatedAt: string
}

type DeveloperRuntimeLock = RuntimeProbeLock & {
  sourceRoot: string
}

type InstalledRuntimeLock = RuntimeProbeLock & {
  workerSha256: string
  workerByteLength: number
}

type WorkerInvocation = {
  command: string
  baseArgs: string[]
  env: NodeJS.ProcessEnv
  cwd?: string
}

/**
 * The selected local runtime is part of OCTAVE's validated state, not merely
 * an implementation detail of a worker invocation.  STRUM probes from older
 * workers do not always repeat `runtime_kind`, so keep the lock-derived kind
 * alongside the invocation until its public DTO is normalized.
 */
type ResolvedWorkerInvocation = {
  invocation: WorkerInvocation
  runtimeKind: TrainingRuntime['kind']
  runtimeSelectionEpoch: number
}

type CandidateBinding = {
  artifactId: string
  bundleRoot: string
  taskView: string
  catalogRoot: string
}

type StoredTrainingRun = TrainingRun & {
  outputRoot: string
  /** Main-process-only promotion binding. Never expose these paths through IPC. */
  candidateBinding?: CandidateBinding
}

type StoredPromotion = TrainingPromotionResult & {
  candidateArtifactId: string
  kind: TrainingPromotionJob['kind']
  /** Main-process-only worker output location. */
  outputRoot: string
}

type PreparedTaskTree = {
  root: string
  entries: Array<
    | { path: string; kind: 'directory' }
    | { path: string; kind: 'file'; byteLength: number; sha256: string }
  >
}

type TrainingRegistry = {
  tasks: Array<
    TrainingTask & {
      taskRoot: string
      catalogRoot: string
      taskManifestSha256?: string
      taskTree?: PreparedTaskTree
    }
  >
  runs: StoredTrainingRun[]
  promotions?: StoredPromotion[]
  profiles?: StoredAutoChartProfile[]
  defaultProfileId?: string
  jobs?: Array<TrainingJobEvent & { sessionId: string }>
}

type RunningTrainingJob = {
  process: ChildProcess
  requestPath: string
  sequence: number
  cancelling: boolean
  cancellationTimer?: NodeJS.Timeout
  exited?: boolean
  runId?: string
}

type RunningProfiledAutoChart = {
  process?: ChildProcess
  requestPaths: string[]
  cancelling: boolean
  cancellationTimer?: NodeJS.Timeout
}

const trainingSessionId = randomUUID()
const latestTrainingEvents = new Map<string, TrainingJobEvent>()
const runningJobs = new Map<string, RunningTrainingJob>()
const runningProfiledAutoCharts = new Map<string, RunningProfiledAutoChart>()
/** A runtime selection is not visible to any worker action until its lock is durable. */
let runtimeSelectionActivation: Promise<TrainingRuntime | null> | null = null
let runtimeSelectionEpoch = 0
/**
 * This deliberately lives only in the main process. Renderer clients receive
 * opaque artifact IDs and cannot ask OCTAVE to run an arbitrary local path.
 */
const discoveredCheckpointRoots = new Map<string, string>()

function trainingRoot(): string {
  return join(app.getPath('userData'), TRAINING_ROOT_NAME)
}

function registryPath(): string {
  return join(trainingRoot(), REGISTRY_NAME)
}

function runtimeSettingsPath(): string {
  return join(trainingRoot(), RUNTIME_SETTINGS_NAME)
}

function workerScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', 'strum', 'strum_worker.py')
    : join(process.cwd(), 'resources', 'strum', 'strum_worker.py')
}

/**
 * An installer can ship a signed, self-contained STRUM worker beside the
 * compatibility adapter. `extraResources` already keeps this directory out
 * of the asar archive, so the worker remains directly executable. The Python
 * adapter is retained only as the development/inference compatibility path
 * until such a worker is present.
 */
function bundledRuntimeExecutablePath(): string | null {
  const root = app.isPackaged
    ? join(process.resourcesPath, 'resources', 'strum')
    : join(process.cwd(), 'resources', 'strum')
  const names =
    process.platform === 'win32'
      ? ['strum-worker.exe', 'strum-worker.cmd', 'strum-worker.bat']
      : ['strum-worker']
  return names.map((name) => join(root, name)).find((candidate) => existsSync(candidate)) ?? null
}

function broadcast(payload: TrainingJobEvent): void {
  latestTrainingEvents.set(payload.jobId, payload)
  if (latestTrainingEvents.size > 256) {
    const oldest = latestTrainingEvents.keys().next().value
    if (oldest) latestTrainingEvents.delete(oldest)
  }
  if (
    payload.state &&
    ['queued', 'cancelling', 'succeeded', 'failed', 'cancelled'].includes(payload.state)
  ) {
    // Persist lifecycle transitions, without raw events or private request values.
    // Registration and these writes share one mutation queue.
    void updateRegistry((registry) => {
      const summary = { ...payload }
      delete summary.result
      registry.jobs = [
        ...(registry.jobs ?? []).filter((entry) => entry.jobId !== payload.jobId),
        { ...summary, sessionId: trainingSessionId }
      ].slice(-256)
    }).catch(() => undefined)
  }
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('training:progress', payload)
  }
}

function broadcastAutoChartProgress(payload: {
  runId: string
  stage: string
  percent?: number
  message: string
}): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('strum:progress', payload)
  }
}

async function readRuntimeSettings(): Promise<RuntimeSettings> {
  try {
    return JSON.parse(await readFile(runtimeSettingsPath(), 'utf8')) as RuntimeSettings
  } catch {
    return {}
  }
}

let registryMutation: Promise<void> = Promise.resolve()

async function readRegistry(): Promise<TrainingRegistry> {
  try {
    const registry = JSON.parse(await readFile(registryPath(), 'utf8')) as TrainingRegistry
    return {
      tasks: Array.isArray(registry.tasks) ? registry.tasks : [],
      runs: Array.isArray(registry.runs) ? registry.runs : [],
      profiles: Array.isArray(registry.profiles) ? registry.profiles : [],
      promotions: Array.isArray(registry.promotions) ? registry.promotions : [],
      jobs: Array.isArray(registry.jobs) ? registry.jobs : [],
      defaultProfileId:
        typeof registry.defaultProfileId === 'string' ? registry.defaultProfileId : undefined
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { tasks: [], runs: [], profiles: [], promotions: [] }
    }
    // Preserve unreadable history instead of overwriting it with an empty registry.
    throw new Error('The local STRUM training registry could not be read.')
  }
}

async function updateRegistry(mutate: (registry: TrainingRegistry) => void): Promise<void> {
  const operation = registryMutation.then(async () => {
    const registry = await readRegistry()
    mutate(registry)
    await mkdir(trainingRoot(), { recursive: true })
    const stagedPath = `${registryPath()}.${randomUUID()}.tmp`
    try {
      await writeFile(stagedPath, JSON.stringify(registry, null, 2) + '\n', {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
      await rename(stagedPath, registryPath())
    } finally {
      await unlink(stagedPath).catch(() => undefined)
    }
  })
  registryMutation = operation.catch(() => undefined)
  await operation
}

function hasLegacyGuitarSources(root: string): boolean {
  return (
    existsSync(join(root, 'scripts', 'preprocess_guitar_windows.py')) &&
    existsSync(join(root, 'scripts', 'train_guitar_v1.py'))
  )
}

function hasVersionedWorkerSource(root: string): boolean {
  return existsSync(join(root, 'src', 'worker.py'))
}

function findDetectedDeveloperRoot(): string | null {
  const configured = process.env.OCTAVE_STRUM_SOURCE_DIR?.trim()
  const candidates = [configured, join(process.cwd(), '..', 'strum'), join(process.cwd(), 'strum')]
  return (
    candidates.find((candidate): candidate is string =>
      Boolean(candidate && hasVersionedWorkerSource(candidate))
    ) ?? null
  )
}

async function workerEnvironment(settings?: RuntimeSettings): Promise<NodeJS.ProcessEnv> {
  const runtimeSettings = settings ?? (await readRuntimeSettings())
  const controlRoot = join(trainingRoot(), 'control')
  await mkdir(controlRoot, { recursive: true })
  return {
    ...process.env,
    PYTHONUTF8: '1',
    OCTAVE_STRUM_TRAINING_CONTROL_ROOT: controlRoot,
    ...(runtimeSettings.developerSourceRoot
      ? {
          OCTAVE_STRUM_SOURCE_DIR: runtimeSettings.developerSourceRoot,
          OCTAVE_STRUM_LEGACY_TRAINING_ADAPTER: '1'
        }
      : {})
  }
}

async function fingerprintWorker(path: string): Promise<{ sha256: string; byteLength: number }> {
  let fileInfo: Awaited<ReturnType<typeof stat>>
  try {
    fileInfo = await stat(path)
  } catch {
    throw new Error('The selected STRUM runtime is no longer available.')
  }
  if (!fileInfo.isFile()) throw new Error('The selected STRUM runtime is no longer available.')
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk: string | Buffer) => {
      hash.update(chunk)
    })
    stream.once('error', () =>
      reject(new Error('The selected STRUM runtime is no longer available.'))
    )
    stream.once('end', () => resolve({ sha256: hash.digest('hex'), byteLength: fileInfo.size }))
  })
}

function runtimeProbeLock(runtime: TrainingRuntime): RuntimeProbeLock {
  return {
    runtimeId: runtime.runtimeId,
    protocolVersion: runtime.protocolVersion,
    capabilities: [...runtime.capabilities].sort(),
    sourceRevision: runtime.sourceRevision,
    dirty: runtime.dirty,
    validatedAt: new Date().toISOString()
  }
}

function installedRuntimeLock(
  runtime: TrainingRuntime,
  fingerprint: { sha256: string; byteLength: number }
): InstalledRuntimeLock {
  return {
    ...runtimeProbeLock(runtime),
    workerSha256: fingerprint.sha256,
    workerByteLength: fingerprint.byteLength
  }
}

function developerRuntimeLock(runtime: TrainingRuntime, sourceRoot: string): DeveloperRuntimeLock {
  return { ...runtimeProbeLock(runtime), sourceRoot }
}

function runtimeMatchesLock(runtime: TrainingRuntime, lock: RuntimeProbeLock): boolean {
  return (
    runtime.runtimeId === lock.runtimeId &&
    runtime.protocolVersion === lock.protocolVersion &&
    runtime.sourceRevision === lock.sourceRevision &&
    runtime.dirty === lock.dirty &&
    [...runtime.capabilities].sort().join('\u0000') ===
      lock.capabilities.slice().sort().join('\u0000')
  )
}

async function verifyInstalledRuntimeLock(settings: RuntimeSettings): Promise<void> {
  const lock = settings.installedRuntimeLock
  if (!settings.installedWorkerPath || !lock) {
    throw new Error('Select the STRUM runtime again to validate its installation.')
  }
  const fingerprint = await fingerprintWorker(settings.installedWorkerPath)
  if (
    fingerprint.sha256 !== lock.workerSha256 ||
    fingerprint.byteLength !== lock.workerByteLength
  ) {
    throw new Error(
      'The selected STRUM runtime changed after validation. Select it again to continue.'
    )
  }
}

async function bundledAdapterInvocation(
  purpose: string,
  settings: RuntimeSettings
): Promise<WorkerInvocation> {
  const bundledWorker = bundledRuntimeExecutablePath()
  if (bundledWorker) {
    return {
      command: bundledWorker,
      baseArgs: [],
      env: await workerEnvironment(settings)
    }
  }
  const python = settings.developerPython ?? (await resolvePythonCommand(purpose))
  const script = workerScriptPath()
  if (!existsSync(script)) throw new Error('OCTAVE could not find its STRUM runtime adapter.')
  return {
    command: python.command,
    baseArgs: [...python.baseArgs, script],
    env: await workerEnvironment(settings)
  }
}

async function developerWorkerInvocation(settings: RuntimeSettings): Promise<WorkerInvocation> {
  const root = settings.developerSourceRoot
  const python = settings.developerPython
  if (!root || !python) {
    throw new Error('Enable the developer STRUM runtime again to validate this checkout.')
  }
  if (!hasVersionedWorkerSource(root))
    return await bundledAdapterInvocation('training-probe', settings)
  return {
    command: python.command,
    baseArgs: [...python.baseArgs, '-m', 'src.worker'],
    env: await workerEnvironment(settings),
    cwd: root
  }
}

async function verifyDeveloperRuntimeLock(settings: RuntimeSettings): Promise<WorkerInvocation> {
  const lock = settings.developerRuntimeLock
  if (
    !settings.developerSourceRoot ||
    !settings.developerPython ||
    !lock ||
    lock.sourceRoot !== settings.developerSourceRoot ||
    (!hasVersionedWorkerSource(settings.developerSourceRoot) &&
      !hasLegacyGuitarSources(settings.developerSourceRoot))
  ) {
    throw new Error('Enable the developer STRUM runtime again to validate this checkout.')
  }
  const invocation = await developerWorkerInvocation(settings)
  const runtime = normalizeRuntime(
    await runWorkerJsonWithInvocation(invocation, ['probe', '--json']),
    'developer_override'
  )
  if (runtime.kind !== 'developer_override' || !runtimeMatchesLock(runtime, lock)) {
    throw new Error(
      'The developer STRUM runtime changed after validation. Enable it again to continue.'
    )
  }
  return invocation
}

async function resolveWorkerInvocation(purpose: string): Promise<ResolvedWorkerInvocation> {
  for (;;) {
    const selectionEpoch = runtimeSelectionEpoch
    const activation = runtimeSelectionActivation
    if (activation) {
      await activation
      continue
    }
    const settings = await readRuntimeSettings()
    if (selectionEpoch !== runtimeSelectionEpoch || runtimeSelectionActivation) continue
    if (settings.installedWorkerPath) {
      await verifyInstalledRuntimeLock(settings)
      if (selectionEpoch !== runtimeSelectionEpoch || runtimeSelectionActivation) continue
      return {
        runtimeSelectionEpoch: selectionEpoch,
        runtimeKind: 'installed_runtime',
        invocation: {
          command: settings.installedWorkerPath,
          baseArgs: [],
          env: await workerEnvironment(settings)
        }
      }
    }
    if (settings.developerSourceRoot) {
      const invocation = await verifyDeveloperRuntimeLock(settings)
      if (selectionEpoch !== runtimeSelectionEpoch || runtimeSelectionActivation) continue
      return {
        runtimeSelectionEpoch: selectionEpoch,
        runtimeKind: 'developer_override',
        invocation
      }
    }
    const invocation = await bundledAdapterInvocation(purpose, settings)
    if (selectionEpoch !== runtimeSelectionEpoch || runtimeSelectionActivation) continue
    return {
      runtimeSelectionEpoch: selectionEpoch,
      runtimeKind: 'bundled_inference',
      invocation
    }
  }
}

function normalizeRuntime(
  raw: unknown,
  defaultKind: TrainingRuntime['kind'] = 'bundled_inference'
): TrainingRuntime {
  if (!raw || typeof raw !== 'object')
    throw new Error('STRUM did not return a runtime description.')
  const value = raw as Record<string, unknown>
  const runtimeMetadata =
    value.runtime && typeof value.runtime === 'object' && !Array.isArray(value.runtime)
      ? (value.runtime as Record<string, unknown>)
      : {}
  const version =
    typeof value.protocol_version === 'string'
      ? value.protocol_version
      : typeof value.protocol_version === 'number' &&
          Number.isSafeInteger(value.protocol_version) &&
          value.protocol_version > 0
        ? String(value.protocol_version)
        : ''
  if (!SAFE_PROTOCOL_VERSION.test(version)) {
    throw new Error('The selected STRUM runtime reported an invalid protocol version.')
  }
  if (Number(version.split('.')[0]) !== PROTOCOL_MAJOR) {
    throw new Error('The selected STRUM runtime uses an unsupported protocol version.')
  }
  const directRuntimeId = value.runtime_id
  const fallbackRuntimeId = runtimeMetadata.id
  const runtimeId =
    typeof directRuntimeId === 'string'
      ? directRuntimeId
      : directRuntimeId === undefined || directRuntimeId === null
        ? typeof fallbackRuntimeId === 'string'
          ? fallbackRuntimeId
          : 'unknown-runtime'
        : ''
  const validRuntimeId =
    typeof directRuntimeId === 'string'
      ? SAFE_RUNTIME_ID.test(runtimeId)
      : runtimeId === 'unknown-runtime' || SAFE_STRUM_RUNTIME_FALLBACK_ID.test(runtimeId)
  if (!validRuntimeId) {
    throw new Error('The selected STRUM runtime reported an invalid runtime identity.')
  }
  const safeList = (candidate: unknown, pattern: RegExp, field: string): string[] => {
    if (candidate === undefined) return []
    if (
      !Array.isArray(candidate) ||
      !candidate.every((entry) => typeof entry === 'string' && pattern.test(entry))
    ) {
      throw new Error(`The selected STRUM runtime reported invalid ${field}.`)
    }
    return [...new Set(candidate)]
  }
  const rawCapabilities = safeList(value.capabilities, SAFE_RUNTIME_CAPABILITY, 'capabilities')
  const rawPipelines = value.pipeline_ids ?? value.pipelines
  const sourceRevision = value.source_revision ?? runtimeMetadata.source_revision
  if (
    sourceRevision !== undefined &&
    sourceRevision !== null &&
    (typeof sourceRevision !== 'string' || !SAFE_SOURCE_REVISION.test(sourceRevision))
  ) {
    throw new Error('The selected STRUM runtime reported an invalid source revision.')
  }
  return {
    runtimeId,
    displayName: `STRUM ${defaultKind.replaceAll('_', ' ')} runtime`,
    kind: defaultKind,
    protocolVersion: version,
    capabilities: [
      ...new Set([
        ...rawCapabilities,
        ...(rawCapabilities.includes('dataset_prepare') &&
        rawCapabilities.includes('training_start')
          ? ['training']
          : [])
      ])
    ],
    pipelineIds: safeList(rawPipelines, SAFE_RUNTIME_PIPELINE_ID, 'pipeline identifiers'),
    deviceSupport: safeList(value.device_support, SAFE_RUNTIME_DEVICE, 'device support'),
    trainingSetupRequired: Boolean(value.training_setup_required),
    dirty: Boolean(value.dirty ?? runtimeMetadata.source_dirty),
    sourceRevision: sourceRevision ?? null
  }
}

async function runWorkerJsonWithInvocation(
  worker: WorkerInvocation,
  args: string[],
  timeoutMs = DEFAULT_WORKER_JSON_TIMEOUT_MS
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    execFile(
      worker.command,
      [...worker.baseArgs, ...args],
      { env: worker.env, cwd: worker.cwd, timeout: timeoutMs },
      (error, stdout) => {
        const line = stdout.split(/\r?\n/).find((entry) => entry.trim())
        if (error || !line) {
          reject(new Error('The selected STRUM runtime could not be validated.'))
          return
        }
        try {
          const payload = JSON.parse(line) as Record<string, unknown>
          if (payload.error) {
            reject(new Error('The selected STRUM runtime rejected this request.'))
            return
          }
          resolve(payload)
        } catch {
          reject(new Error('The selected STRUM runtime returned an invalid response.'))
        }
      }
    )
  })
}

async function runWorkerJson(
  args: string[],
  timeoutMs = DEFAULT_WORKER_JSON_TIMEOUT_MS
): Promise<Record<string, unknown>> {
  for (;;) {
    const resolved = await resolveWorkerInvocation('training-probe')
    if (resolved.runtimeSelectionEpoch !== runtimeSelectionEpoch || runtimeSelectionActivation) {
      continue
    }
    return await runWorkerJsonWithInvocation(resolved.invocation, args, timeoutMs)
  }
}

export async function probeTrainingRuntime(): Promise<TrainingRuntime> {
  for (;;) {
    const resolved = await resolveWorkerInvocation('training-probe')
    if (resolved.runtimeSelectionEpoch !== runtimeSelectionEpoch || runtimeSelectionActivation) {
      continue
    }
    return normalizeRuntime(
      await runWorkerJsonWithInvocation(resolved.invocation, ['probe', '--json']),
      resolved.runtimeKind
    )
  }
}

async function activateDeveloperTrainingRuntime(rootPath: string): Promise<TrainingRuntime | null> {
  if (app.isPackaged) return null
  const root = await realpath(rootPath)
  if (!hasVersionedWorkerSource(root)) {
    throw new Error('The selected folder does not contain a compatible STRUM worker.')
  }
  const developerPython = await resolvePythonCommand('developer-training-runtime', {
    developerSourceRoot: root
  })
  const settings: RuntimeSettings = {
    developerSourceRoot: root,
    developerPython,
    installedWorkerPath: undefined,
    installedRuntimeLock: undefined
  }
  const runtime = normalizeRuntime(
    await runWorkerJsonWithInvocation(await developerWorkerInvocation(settings), [
      'probe',
      '--json'
    ]),
    'developer_override'
  )
  if (runtime.kind !== 'developer_override') return null
  await mkdir(trainingRoot(), { recursive: true })
  await writeFile(
    runtimeSettingsPath(),
    JSON.stringify(
      {
        ...settings,
        developerRuntimeLock: developerRuntimeLock(runtime, root),
        installedWorkerPath: undefined,
        installedRuntimeLock: undefined
      },
      null,
      2
    ) + '\n',
    'utf8'
  )
  return runtime
}

async function enableDetectedDeveloperTrainingRuntimeOnce(): Promise<TrainingRuntime | null> {
  const detectedRoot = findDetectedDeveloperRoot()
  return detectedRoot ? await activateDeveloperTrainingRuntime(detectedRoot) : null
}

function beginRuntimeSelection(
  operation: () => Promise<TrainingRuntime | null>
): Promise<TrainingRuntime | null> {
  if (runtimeSelectionActivation) return runtimeSelectionActivation
  runtimeSelectionEpoch += 1
  const activation = operation()
  runtimeSelectionActivation = activation
  return activation.finally(() => {
    if (runtimeSelectionActivation === activation) runtimeSelectionActivation = null
  })
}

export function enableDetectedDeveloperTrainingRuntime(): Promise<TrainingRuntime | null> {
  return beginRuntimeSelection(enableDetectedDeveloperTrainingRuntimeOnce)
}

async function chooseDeveloperTrainingRuntimeOnce(): Promise<TrainingRuntime | null> {
  if (app.isPackaged) return null
  const selection = await dialog.showOpenDialog({
    title: 'Select a STRUM checkout with its versioned worker',
    properties: ['openDirectory']
  })
  if (selection.canceled || selection.filePaths.length === 0) return null
  return await activateDeveloperTrainingRuntime(selection.filePaths[0])
}

/**
 * Explicitly select a contributor checkout. This is deliberately separate
 * from the installed-runtime executable picker so the release path can never
 * silently discover or execute a sibling source tree.
 */
export function chooseDeveloperTrainingRuntime(): Promise<TrainingRuntime | null> {
  return beginRuntimeSelection(chooseDeveloperTrainingRuntimeOnce)
}

async function chooseInstalledTrainingRuntimeOnce(): Promise<TrainingRuntime | null> {
  const selection = await dialog.showOpenDialog({
    title: 'Select a compatible STRUM worker',
    properties: ['openFile'],
    filters:
      process.platform === 'win32'
        ? [{ name: 'STRUM worker', extensions: ['exe', 'cmd', 'bat'] }]
        : undefined
  })
  if (selection.canceled || selection.filePaths.length === 0) return null
  const previous = await readRuntimeSettings()
  const installedWorkerPath = selection.filePaths[0]
  try {
    const runtime = normalizeRuntime(
      await runWorkerJsonWithInvocation(
        {
          command: installedWorkerPath,
          baseArgs: [],
          env: await workerEnvironment({})
        },
        ['probe', '--json']
      ),
      'installed_runtime'
    )
    if (runtime.kind !== 'installed_runtime') {
      throw new Error('The selected worker is not an installed STRUM runtime.')
    }
    const fingerprint = await fingerprintWorker(installedWorkerPath)
    await mkdir(trainingRoot(), { recursive: true })
    await writeFile(
      runtimeSettingsPath(),
      JSON.stringify(
        {
          installedWorkerPath,
          installedRuntimeLock: installedRuntimeLock(runtime, fingerprint),
          developerSourceRoot: undefined,
          developerPython: undefined,
          developerRuntimeLock: undefined
        },
        null,
        2
      ) + '\n',
      'utf8'
    )
    return runtime
  } catch {
    await mkdir(trainingRoot(), { recursive: true })
    await writeFile(runtimeSettingsPath(), JSON.stringify(previous, null, 2) + '\n', 'utf8')
    return null
  }
}

export function chooseInstalledTrainingRuntime(): Promise<TrainingRuntime | null> {
  return beginRuntimeSelection(chooseInstalledTrainingRuntimeOnce)
}

const CHECKPOINT_OUTPUT_CONTRACTS_FORMAT = 'strum-candidate-checkpoint-output-contracts/v1'
const MAX_OUTPUT_CONTRACT_CANDIDATES = 16
const MAX_OUTPUT_CONTRACT_LIST_LENGTH = 32
const MAX_PIPELINE_METADATA_DEPTH = 8
const MAX_PIPELINE_METADATA_ENTRIES = 64

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = allowed
): boolean {
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.includes(key))
  )
}

function isSafeContractName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z][A-Za-z0-9._-]{0,120}(?:\/[A-Za-z][A-Za-z0-9._-]{0,120})*\/v[1-9][0-9]*$/.test(value)
  )
}

function isSafeContractToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function isContainedPath(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate)
  return (
    Boolean(relativePath) &&
    relativePath !== '..' &&
    !relativePath.startsWith('../') &&
    !relativePath.startsWith('..\\') &&
    !isAbsolute(relativePath)
  )
}

// Prepared views may contain large paired-data files. Bound traversal and
// streaming reads without imposing an audio/model-sized memory allocation.
const MAX_PREPARED_TASK_ENTRIES = 10_000
const MAX_PREPARED_TASK_BYTES = 64 * 1024 * 1024 * 1024

async function fingerprintPreparedTaskFile(
  path: string,
  maximumBytes = MAX_PREPARED_TASK_BYTES
): Promise<{ byteLength: number; sha256: string }> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )
  try {
    const before = await handle.stat()
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size > maximumBytes)
      throw new Error('Prepared task file exceeds the supported artifact limits.')
    const hash = createHash('sha256')
    let byteLength = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      byteLength += chunk.length
      if (byteLength > before.size || byteLength > maximumBytes)
        throw new Error('Prepared task file changed while verifying.')
      hash.update(chunk)
    }
    const after = await handle.stat()
    if (
      byteLength !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error('Prepared task file changed while verifying.')
    return { byteLength, sha256: hash.digest('hex') }
  } finally {
    await handle.close()
  }
}

async function fingerprintPreparedTaskTree(root: string): Promise<PreparedTaskTree> {
  if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory())
    throw new Error('Prepared task directory changed.')
  const entries: PreparedTaskTree['entries'] = []
  const pending = [root]
  let totalBytes = 0
  while (pending.length) {
    const directory = pending.pop()!
    if ((await realpath(directory)) !== directory || !(await lstat(directory)).isDirectory())
      throw new Error('Prepared task directory changed.')
    for await (const entry of await opendir(directory)) {
      if (entries.length >= MAX_PREPARED_TASK_ENTRIES)
        throw new Error('Prepared task contains too many entries.')
      const path = join(directory, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink() || (await realpath(path)) !== path || !isContainedPath(root, path))
        throw new Error('Prepared task contains an unsafe entry.')
      const relativePath = relative(root, path)
      if (info.isDirectory()) {
        entries.push({ path: relativePath, kind: 'directory' })
        pending.push(path)
      } else if (info.isFile()) {
        const fingerprint = await fingerprintPreparedTaskFile(
          path,
          MAX_PREPARED_TASK_BYTES - totalBytes
        )
        totalBytes += fingerprint.byteLength
        if ((await realpath(path)) !== path) throw new Error('Prepared task file changed.')
        entries.push({ path: relativePath, kind: 'file', ...fingerprint })
      } else throw new Error('Prepared task contains a non-regular entry.')
    }
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { root, entries }
}

/**
 * Revalidate a registered bundle before any worker call. Both the run and its
 * bundle are canonicalized again so a later symlink replacement cannot escape
 * OCTAVE's private training-runs root.
 */
async function resolveContainedTrainingBundleRoot(
  outputRoot: string,
  bundleRoot: string
): Promise<string> {
  const [resolvedRunsRoot, resolvedOutputRoot, resolvedBundleRoot] = await Promise.all([
    realpath(join(trainingRoot(), 'runs')),
    realpath(outputRoot),
    realpath(bundleRoot)
  ])
  if (!isContainedPath(resolvedRunsRoot, resolvedOutputRoot)) {
    throw new Error('The training run is outside OCTAVE storage.')
  }
  if (
    resolvedBundleRoot !== resolvedOutputRoot &&
    !isContainedPath(resolvedOutputRoot, resolvedBundleRoot)
  ) {
    throw new Error('STRUM returned a bundle outside the training run.')
  }
  if (!(await stat(resolvedBundleRoot)).isDirectory()) {
    throw new Error('STRUM returned an invalid trained bundle location.')
  }
  return resolvedBundleRoot
}

/** Resolve STRUM's terminal single-token bundle identity inside a private run. */
async function resolveTrainingBundleRoot(outputRoot: string, bundleName: string): Promise<string> {
  return await resolveContainedTrainingBundleRoot(
    outputRoot,
    bundleName === basename(outputRoot) ? outputRoot : join(outputRoot, bundleName)
  )
}

async function resolveLegacyTrainingRunRoot(outputRoot: string): Promise<string> {
  const [resolvedRunsRoot, resolvedOutputRoot] = await Promise.all([
    realpath(join(trainingRoot(), 'runs')),
    realpath(outputRoot)
  ])
  if (
    !isContainedPath(resolvedRunsRoot, resolvedOutputRoot) ||
    !(await stat(resolvedOutputRoot)).isDirectory()
  ) {
    throw new Error('The training run is outside OCTAVE storage.')
  }
  return resolvedOutputRoot
}

function isSafeDisplayText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes('\\') &&
    !value.includes('/') &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
    !value.includes('..') &&
    !value.startsWith('/')
  )
}

function isSafeMetadataString(value: unknown): value is string {
  return isSafeDisplayText(value) || isSafeContractName(value)
}

function normalizeNonNegativeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function normalizeExclusionReasonCounts(value: unknown): Record<string, number> | null {
  if (!isRecord(value) || Object.keys(value).length > MAX_PIPELINE_METADATA_ENTRIES) return null
  const normalized: Record<string, number> = {}
  for (const [key, rawCount] of Object.entries(value)) {
    const count = normalizeNonNegativeCount(rawCount)
    if (!isSafeContractToken(key) || count === null) return null
    normalized[key] = count
  }
  return normalized
}

/**
 * Pipeline policy/schema metadata is descriptive only, but it still crosses
 * into the renderer. Keep it bounded and path-free instead of forwarding an
 * arbitrary worker object. Versioned identifiers are the sole allowed slash
 * containing values.
 */
function normalizePipelineMetadata(value: unknown, depth = 0): unknown | null {
  if (depth > MAX_PIPELINE_METADATA_DEPTH) return null
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return isSafeMetadataString(value) ? value : null
  if (Array.isArray(value)) {
    if (value.length > MAX_PIPELINE_METADATA_ENTRIES) return null
    const normalized = value.map((entry) => normalizePipelineMetadata(entry, depth + 1))
    return normalized.some((entry) => entry === null) ? null : normalized
  }
  if (!isRecord(value) || Object.keys(value).length > MAX_PIPELINE_METADATA_ENTRIES) return null
  const normalized: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!isSafeContractToken(key)) return null
    const next = normalizePipelineMetadata(entry, depth + 1)
    if (next === null) return null
    normalized[key] = next
  }
  return normalized
}

function normalizeMetadataRecord(value: unknown): Record<string, unknown> | null {
  const normalized = normalizePipelineMetadata(value)
  return isRecord(normalized) ? normalized : null
}

function normalizeContractTokenList(
  value: unknown,
  maximum = MAX_OUTPUT_CONTRACT_LIST_LENGTH
): string[] | null {
  if (!Array.isArray(value) || value.length > maximum || !value.every(isSafeContractToken))
    return null
  return new Set(value).size === value.length ? [...value] : null
}

function normalizePromotionJob(value: unknown): TrainingPromotionJob | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      [
        'id',
        'display_name',
        'kind',
        'status',
        'options_schema',
        'private_request_fields',
        'optional_private_request_fields',
        'output_kind',
        'deployment_scope',
        'quality_policy',
        'calibration_policy',
        'checkpoint_selection_policy'
      ],
      [
        'id',
        'display_name',
        'kind',
        'status',
        'options_schema',
        'private_request_fields',
        'optional_private_request_fields',
        'output_kind',
        'deployment_scope'
      ]
    ) ||
    !isSafeContractName(value.id) ||
    !isSafeDisplayText(value.display_name) ||
    (value.kind !== 'evaluation' && value.kind !== 'package') ||
    !['available', 'planned', 'unavailable'].includes(String(value.status)) ||
    !isSafeContractToken(value.output_kind) ||
    !isSafeContractToken(value.deployment_scope)
  ) {
    return null
  }
  const optionsSchema = normalizeMetadataRecord(value.options_schema)
  const privateFields = normalizeContractTokenList(value.private_request_fields)
  const optionalPrivateFields = normalizeContractTokenList(value.optional_private_request_fields)
  if (
    !optionsSchema ||
    !privateFields ||
    !optionalPrivateFields ||
    (value.kind === 'package' && hasPromotionPolicyOverride(optionsSchema))
  ) {
    return null
  }
  if (privateFields.some((field) => optionalPrivateFields.includes(field))) return null
  const policies = ['quality_policy', 'calibration_policy', 'checkpoint_selection_policy'] as const
  const normalizedPolicies = Object.fromEntries(
    policies.map((key) => [
      key,
      value[key] === undefined ? undefined : normalizeMetadataRecord(value[key])
    ])
  ) as Record<(typeof policies)[number], Record<string, unknown> | null | undefined>
  if (Object.values(normalizedPolicies).some((policy) => policy === null)) return null
  return {
    id: value.id,
    display_name: value.display_name,
    kind: value.kind,
    status: value.status as TrainingPromotionJob['status'],
    options_schema: optionsSchema,
    private_request_fields: privateFields,
    optional_private_request_fields: optionalPrivateFields,
    output_kind: value.output_kind,
    deployment_scope: value.deployment_scope,
    ...(normalizedPolicies.quality_policy
      ? { quality_policy: normalizedPolicies.quality_policy }
      : {}),
    ...(normalizedPolicies.calibration_policy
      ? { calibration_policy: normalizedPolicies.calibration_policy }
      : {}),
    ...(normalizedPolicies.checkpoint_selection_policy
      ? { checkpoint_selection_policy: normalizedPolicies.checkpoint_selection_policy }
      : {})
  }
}

function hasPromotionPolicyOverride(schema: Record<string, unknown>): boolean {
  const properties = schema.properties
  if (!isRecord(properties)) return false
  return Object.keys(properties).some((key) => /(?:threshold|minimum|policy)/i.test(key))
}

function normalizeContractStrings(
  value: unknown,
  predicate: (entry: unknown) => entry is string
): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OUTPUT_CONTRACT_LIST_LENGTH)
    return null
  if (!value.every(predicate) || new Set(value).size !== value.length) return null
  return [...value]
}

function normalizeIntegerPair(
  value: unknown,
  minimum: number,
  maximum: number
): [number, number] | null {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Number.isSafeInteger(value[0]) ||
    !Number.isSafeInteger(value[1]) ||
    value[0] < minimum ||
    value[1] > maximum ||
    value[0] > value[1]
  ) {
    return null
  }
  return [value[0], value[1]]
}

function normalizeCandidateInputContract(
  value: unknown
): StrumCheckpointCandidateInputContract | null {
  if (!isRecord(value) || !isSafeContractName(value.format)) return null
  if (Object.prototype.hasOwnProperty.call(value, 'event_time_source')) {
    if (
      !hasOnlyKeys(value, [
        'format',
        'event_time_source',
        'free_running_event_proposal',
        'sequence_decoding',
        'midi_emission'
      ]) ||
      !isSafeContractToken(value.event_time_source) ||
      typeof value.free_running_event_proposal !== 'boolean' ||
      typeof value.sequence_decoding !== 'boolean' ||
      typeof value.midi_emission !== 'boolean'
    ) {
      return null
    }
    return {
      format: value.format,
      event_time_source: value.event_time_source,
      free_running_event_proposal: value.free_running_event_proposal,
      sequence_decoding: value.sequence_decoding,
      midi_emission: value.midi_emission
    }
  }
  if (
    !hasOnlyKeys(value, [
      'format',
      'requires_midi_at_inference',
      'offline_window_scoring',
      'free_running_event_proposal',
      'sequence_decoding',
      'midi_emission'
    ]) ||
    typeof value.requires_midi_at_inference !== 'boolean' ||
    typeof value.offline_window_scoring !== 'boolean' ||
    typeof value.free_running_event_proposal !== 'boolean' ||
    typeof value.sequence_decoding !== 'boolean' ||
    typeof value.midi_emission !== 'boolean'
  ) {
    return null
  }
  return {
    format: value.format,
    requires_midi_at_inference: value.requires_midi_at_inference,
    offline_window_scoring: value.offline_window_scoring,
    free_running_event_proposal: value.free_running_event_proposal,
    sequence_decoding: value.sequence_decoding,
    midi_emission: value.midi_emission
  }
}

function normalizeCandidateOutputContract(
  value: unknown
): StrumCheckpointCandidateOutputContract | null {
  if (!isRecord(value) || !isSafeContractName(value.format)) return null
  if (Object.prototype.hasOwnProperty.call(value, 'outputs')) {
    const outputs = normalizeContractStrings(value.outputs, isSafeContractToken)
    if (
      !hasOnlyKeys(value, [
        'format',
        'outputs',
        'free_running_event_proposal',
        'sequence_decoding',
        'midi_emission'
      ]) ||
      !outputs ||
      typeof value.free_running_event_proposal !== 'boolean' ||
      typeof value.sequence_decoding !== 'boolean' ||
      typeof value.midi_emission !== 'boolean'
    ) {
      return null
    }
    return {
      format: value.format,
      outputs,
      free_running_event_proposal: value.free_running_event_proposal,
      sequence_decoding: value.sequence_decoding,
      midi_emission: value.midi_emission
    }
  }
  if (
    !hasOnlyKeys(value, ['format', 'event_attributes', 'midi_emission']) ||
    typeof value.event_attributes !== 'boolean' ||
    typeof value.midi_emission !== 'boolean'
  ) {
    return null
  }
  return {
    format: value.format,
    event_attributes: value.event_attributes,
    midi_emission: value.midi_emission
  }
}

function normalizeCandidateTargetContract(
  value: unknown
): StrumCheckpointCandidateTargetContract | null {
  if (!isRecord(value) || !isSafeContractName(value.kind)) return null
  const allowed = [
    'kind',
    'string_count',
    'fret_range',
    'techniques',
    'track_variant_head',
    'pitch_range',
    'channel_metadata',
    'range_state_head'
  ]
  if (!hasOnlyKeys(value, allowed, ['kind'])) return null
  const target: StrumCheckpointCandidateTargetContract = { kind: value.kind }
  if (Object.prototype.hasOwnProperty.call(value, 'string_count')) {
    const stringCount = value.string_count
    if (
      typeof stringCount !== 'number' ||
      !Number.isSafeInteger(stringCount) ||
      stringCount < 1 ||
      stringCount > 12
    )
      return null
    target.string_count = stringCount
  }
  if (Object.prototype.hasOwnProperty.call(value, 'fret_range')) {
    const range = normalizeIntegerPair(value.fret_range, 0, 127)
    if (!range) return null
    target.fret_range = range
  }
  if (Object.prototype.hasOwnProperty.call(value, 'techniques')) {
    const techniques = normalizeContractStrings(value.techniques, isSafeContractToken)
    if (!techniques) return null
    target.techniques = techniques
  }
  if (Object.prototype.hasOwnProperty.call(value, 'track_variant_head')) {
    const variants = normalizeContractStrings(value.track_variant_head, isSafeContractToken)
    if (!variants) return null
    target.track_variant_head = variants
  }
  if (Object.prototype.hasOwnProperty.call(value, 'pitch_range')) {
    const range = normalizeIntegerPair(value.pitch_range, 0, 127)
    if (!range) return null
    target.pitch_range = range
  }
  if (Object.prototype.hasOwnProperty.call(value, 'channel_metadata')) {
    if (!isSafeContractName(value.channel_metadata)) return null
    target.channel_metadata = value.channel_metadata
  }
  if (Object.prototype.hasOwnProperty.call(value, 'range_state_head')) {
    const states = normalizeContractStrings(value.range_state_head, isSafeContractToken)
    if (!states) return null
    target.range_state_head = states
  }
  return target
}

function normalizeCheckpointOutputCandidate(
  value: unknown,
  pipelineId: string
): StrumCheckpointOutputCandidate | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'component_outputs',
      'model_outputs',
      'preprocessing',
      'candidate_bundle',
      'deployment_scope'
    ])
  ) {
    return null
  }
  const componentOutputs = normalizeContractStrings(value.component_outputs, isSafeContractToken)
  const modelOutputs = normalizeContractStrings(value.model_outputs, isSafeContractToken)
  const preprocessing = value.preprocessing
  const bundle = value.candidate_bundle
  const scope = value.deployment_scope
  const negativePolicy =
    isRecord(preprocessing) &&
    Object.prototype.hasOwnProperty.call(preprocessing, 'negative_policy')
      ? preprocessing.negative_policy
      : undefined
  if (
    !componentOutputs ||
    !modelOutputs ||
    !isRecord(preprocessing) ||
    !hasOnlyKeys(
      preprocessing,
      ['id', 'input_contract', 'negative_policy'],
      ['id', 'input_contract']
    ) ||
    !isSafeContractName(preprocessing.id) ||
    !isSafeContractName(preprocessing.input_contract) ||
    (negativePolicy !== undefined && !isSafeContractName(negativePolicy)) ||
    !isRecord(bundle) ||
    !hasOnlyKeys(
      bundle,
      [
        'config_format',
        'task_kind',
        'pipeline_id',
        'model_implementation',
        'input_contract',
        'output_contract',
        'target_contract',
        'component_set',
        'profiles',
        'companions'
      ],
      [
        'config_format',
        'task_kind',
        'pipeline_id',
        'model_implementation',
        'input_contract',
        'output_contract',
        'component_set',
        'profiles',
        'companions'
      ]
    ) ||
    !isSafeContractName(bundle.config_format) ||
    !isSafeContractToken(bundle.task_kind) ||
    bundle.pipeline_id !== pipelineId ||
    !isSafeContractName(bundle.pipeline_id) ||
    !isSafeContractName(bundle.model_implementation) ||
    bundle.profiles !== 'forbidden' ||
    bundle.companions !== 'forbidden' ||
    !isRecord(scope) ||
    !hasOnlyKeys(scope, ['status', 'profile', 'chart_execution']) ||
    scope.status !== 'raw_experiment_candidate_only' ||
    scope.profile !== 'not_available' ||
    scope.chart_execution !== 'not_available'
  ) {
    return null
  }
  const inputContract = normalizeCandidateInputContract(bundle.input_contract)
  const outputContract = normalizeCandidateOutputContract(bundle.output_contract)
  const componentSet = normalizeContractStrings(bundle.component_set, isSafeContractToken)
  const targetContract = Object.prototype.hasOwnProperty.call(bundle, 'target_contract')
    ? normalizeCandidateTargetContract(bundle.target_contract)
    : undefined
  if (
    !inputContract ||
    !outputContract ||
    !componentSet ||
    componentSet.join('\u0000') !== componentOutputs.join('\u0000') ||
    (Object.prototype.hasOwnProperty.call(bundle, 'target_contract') && !targetContract)
  ) {
    return null
  }
  return {
    component_outputs: componentOutputs,
    model_outputs: modelOutputs,
    preprocessing: {
      id: preprocessing.id,
      input_contract: preprocessing.input_contract,
      ...(negativePolicy ? { negative_policy: negativePolicy } : {})
    },
    candidate_bundle: {
      config_format: bundle.config_format,
      task_kind: bundle.task_kind,
      pipeline_id: bundle.pipeline_id,
      model_implementation: bundle.model_implementation,
      input_contract: inputContract,
      output_contract: outputContract,
      ...(targetContract ? { target_contract: targetContract } : {}),
      component_set: componentSet,
      profiles: 'forbidden',
      companions: 'forbidden'
    },
    deployment_scope: {
      status: 'raw_experiment_candidate_only',
      profile: 'not_available',
      chart_execution: 'not_available'
    }
  }
}

function normalizeCheckpointOutputContracts(
  value: unknown,
  pipelineId: string
): StrumCheckpointOutputContracts | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['format', 'selector', 'by_candidate_kind']) ||
    value.format !== CHECKPOINT_OUTPUT_CONTRACTS_FORMAT ||
    !isRecord(value.selector) ||
    !hasOnlyKeys(value.selector, ['training_option', 'default']) ||
    !isSafeContractToken(value.selector.training_option) ||
    !isSafeContractName(value.selector.default) ||
    !isRecord(value.by_candidate_kind)
  ) {
    return null
  }
  const entries = Object.entries(value.by_candidate_kind)
  if (
    entries.length === 0 ||
    entries.length > MAX_OUTPUT_CONTRACT_CANDIDATES ||
    !entries.every(([candidateKind]) => isSafeContractName(candidateKind)) ||
    !Object.prototype.hasOwnProperty.call(value.by_candidate_kind, value.selector.default)
  ) {
    return null
  }
  const normalizedEntries = entries.map(
    ([candidateKind, candidate]) =>
      [candidateKind, normalizeCheckpointOutputCandidate(candidate, pipelineId)] as const
  )
  if (normalizedEntries.some(([, candidate]) => candidate === null)) return null
  return {
    format: CHECKPOINT_OUTPUT_CONTRACTS_FORMAT,
    selector: {
      training_option: value.selector.training_option,
      default: value.selector.default
    },
    by_candidate_kind: Object.fromEntries(
      normalizedEntries.filter(
        (entry): entry is readonly [string, StrumCheckpointOutputCandidate] => entry[1] !== null
      )
    )
  }
}

function normalizeTrainingPipeline(value: unknown): TrainingPipeline | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      [
        'id',
        'display_name',
        'kind',
        'version',
        'catalog_requirements',
        'prepare_schema',
        'train_schema',
        'checkpoint_outputs',
        'checkpoint_output_contracts',
        'inference_capability',
        'status',
        'preparation_status',
        'training_status',
        'private_request_fields',
        'catalog_inspection_option_keys',
        'training_requirements',
        'training_contract',
        'promotion_jobs'
      ],
      [
        'id',
        'display_name',
        'kind',
        'version',
        'catalog_requirements',
        'prepare_schema',
        'train_schema',
        'checkpoint_outputs',
        'inference_capability',
        'status',
        'preparation_status',
        'training_status',
        'private_request_fields',
        'catalog_inspection_option_keys',
        'training_requirements',
        'promotion_jobs'
      ]
    ) ||
    !isSafeContractName(value.id) ||
    !isSafeDisplayText(value.display_name) ||
    !isSafeContractToken(value.kind) ||
    typeof value.version !== 'number' ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !isSafeContractToken(value.status) ||
    !isSafeContractToken(value.preparation_status) ||
    !isSafeContractToken(value.training_status) ||
    (value.inference_capability !== null && !isSafeContractName(value.inference_capability))
  ) {
    return null
  }
  const version = Number(value.version)
  const catalogRequirements = normalizeMetadataRecord(value.catalog_requirements)
  const prepareSchema = normalizeMetadataRecord(value.prepare_schema)
  const trainSchema =
    value.train_schema === null ? null : normalizeMetadataRecord(value.train_schema)
  const checkpointOutputs = normalizeContractTokenList(value.checkpoint_outputs)
  const privateFields = normalizeContractTokenList(value.private_request_fields)
  const inspectionKeys = normalizeContractTokenList(value.catalog_inspection_option_keys)
  const trainingRequirements = Array.isArray(value.training_requirements)
    ? value.training_requirements.every(
        (requirement) => isSafeContractToken(requirement) || isSafeContractName(requirement)
      ) && new Set(value.training_requirements).size === value.training_requirements.length
      ? ([...value.training_requirements] as string[])
      : null
    : null
  const promotionJobs = Array.isArray(value.promotion_jobs)
    ? value.promotion_jobs.map(normalizePromotionJob)
    : null
  if (
    !catalogRequirements ||
    !prepareSchema ||
    (trainSchema === null && value.train_schema !== null) ||
    !checkpointOutputs ||
    !privateFields ||
    !inspectionKeys ||
    !trainingRequirements ||
    !promotionJobs ||
    promotionJobs.some((job) => job === null) ||
    promotionJobs.length > 16 ||
    new Set(promotionJobs.map((job) => job?.id)).size !== promotionJobs.length
  ) {
    return null
  }
  const rawContracts = value.checkpoint_output_contracts
  const contracts =
    rawContracts === undefined
      ? undefined
      : normalizeCheckpointOutputContracts(rawContracts, value.id)
  if (rawContracts !== undefined && !contracts) return null
  return {
    id: value.id,
    display_name: value.display_name,
    kind: value.kind,
    version,
    status: value.status,
    preparation_status: value.preparation_status,
    training_status: value.training_status,
    catalog_requirements: catalogRequirements,
    prepare_schema: prepareSchema,
    train_schema: trainSchema,
    checkpoint_outputs: checkpointOutputs,
    ...(contracts ? { checkpoint_output_contracts: contracts } : {}),
    inference_capability: value.inference_capability,
    private_request_fields: privateFields,
    catalog_inspection_option_keys: inspectionKeys,
    training_requirements: trainingRequirements,
    promotion_jobs: promotionJobs.filter((job): job is TrainingPromotionJob => job !== null)
  }
}

export async function listTrainingPipelines(): Promise<TrainingPipeline[]> {
  const runtime = await probeTrainingRuntime()
  if (
    !runtime.capabilities.includes('dataset_prepare') ||
    !runtime.capabilities.includes('training_start')
  )
    return []
  const promotionDiscoveryAvailable = runtime.capabilities.includes('post_train_job_discovery')
  const payload = await runWorkerJson(['pipeline', 'list', '--json'])
  const pipelines = Array.isArray(payload.pipelines) ? payload.pipelines : []
  return pipelines.flatMap((pipeline) => {
    const normalized = normalizeTrainingPipeline(pipeline)
    return normalized
      ? [
          {
            ...normalized,
            promotion_jobs: promotionDiscoveryAvailable ? normalized.promotion_jobs : []
          }
        ]
      : []
  })
}

async function resolveTrainingPipeline(pipelineId: string): Promise<TrainingPipeline> {
  const pipeline = (await listTrainingPipelines()).find((candidate) => candidate.id === pipelineId)
  if (!pipeline)
    throw new Error('That training pipeline is not available in the selected STRUM runtime.')
  return pipeline
}

function normalizePromotionResult(
  value: unknown,
  pipelineId: string,
  job: TrainingPromotionJob,
  promotionId: string,
  candidateArtifactId: string
): TrainingPromotionResult | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'schema_version',
      'format',
      'status',
      'pipeline_id',
      'job_id',
      'output_kind',
      'deployment_scope',
      'result'
    ]) ||
    value.schema_version !== 1 ||
    value.format !== 'strum-post-train-job-result/v1' ||
    value.status !== 'completed' ||
    value.pipeline_id !== pipelineId ||
    value.job_id !== job.id ||
    value.output_kind !== job.output_kind ||
    value.deployment_scope !== job.deployment_scope
  ) {
    return null
  }
  const result = normalizeMetadataRecord(value.result)
  if (!result) return null
  return {
    schema_version: 1,
    format: 'strum-post-train-job-result/v1',
    status: 'completed',
    pipeline_id: pipelineId,
    job_id: job.id,
    output_kind: job.output_kind,
    deployment_scope: job.deployment_scope,
    result,
    promotionId,
    candidateArtifactId
  }
}

async function resolveCandidateBinding(
  artifactId: string
): Promise<{ run: StoredTrainingRun; binding: CandidateBinding }> {
  if (!isArtifactId(artifactId)) throw new Error('Select a trained STRUM candidate first.')
  const registry = await readRegistry()
  const run = registry.runs.find(
    (entry) => entry.artifactId === artifactId && entry.candidateBinding?.artifactId === artifactId
  )
  if (!run?.candidateBinding) throw new Error('That trained STRUM candidate is not available.')
  const binding = run.candidateBinding
  try {
    const [bundleRoot, taskView, catalogRoot] = await Promise.all([
      resolveContainedTrainingBundleRoot(run.outputRoot, binding.bundleRoot),
      realpath(binding.taskView),
      realpath(binding.catalogRoot)
    ])
    const inspection = normalizeDiscoveredCheckpoint(
      await runWorkerJson(['checkpoint', 'inspect', '--model-root', bundleRoot, '--json'])
    )
    if (
      !inspection ||
      inspection.artifactId !== artifactId ||
      inspection.manifestSha256 !== run.checkpointManifestHash
    ) {
      throw new Error('candidate no longer matches its registered checkpoint.')
    }
    return {
      run,
      binding: { artifactId, bundleRoot, taskView, catalogRoot }
    }
  } catch {
    throw new Error('That trained STRUM candidate is no longer available.')
  }
}

function promotionOutputPath(jobId: string, job: TrainingPromotionJob): string {
  const name = job.kind === 'evaluation' ? 'result.json' : 'bundle'
  return join(trainingRoot(), 'promotions', jobId, name)
}

const SUPPORTED_PROMOTION_PRIVATE_FIELDS = new Set([
  'bundle_root',
  'experiment',
  'experiment_root',
  'task_view',
  'dataset_manifest',
  'catalog_root',
  'output',
  'evaluation'
])

function supportsPromotionPrivateFields(job: TrainingPromotionJob): boolean {
  return [...job.private_request_fields, ...job.optional_private_request_fields].every((field) =>
    SUPPORTED_PROMOTION_PRIVATE_FIELDS.has(field)
  )
}

async function resolvePromotionRequest(
  candidateArtifactId: string,
  job: TrainingPromotionJob,
  options: Record<string, unknown>,
  jobId: string
): Promise<{ request: Record<string, unknown>; outputRoot: string }> {
  const { run, binding } = await resolveCandidateBinding(candidateArtifactId)
  const outputRoot = promotionOutputPath(jobId, job)
  await mkdir(join(trainingRoot(), 'promotions', jobId), { recursive: true })
  const request: Record<string, unknown> = {
    pipeline_id: run.pipelineId,
    job_id: job.id,
    options: sanitizeTrainingSchemaValues(job.options_schema, options, 'post-training job')
  }
  const registry = await readRegistry()
  const latestEvaluation = [...(registry.promotions ?? [])]
    .reverse()
    .find(
      (entry) =>
        entry.candidateArtifactId === candidateArtifactId &&
        entry.pipeline_id === run.pipelineId &&
        entry.status === 'completed' &&
        entry.kind === 'evaluation'
    )
  let evaluationRoot: string | undefined
  if (latestEvaluation) {
    try {
      const [promotionRoot, resolvedEvaluation] = await Promise.all([
        realpath(join(trainingRoot(), 'promotions')),
        realpath(latestEvaluation.outputRoot)
      ])
      const pathWithinPromotionRoot = relative(promotionRoot, resolvedEvaluation)
      if (
        pathWithinPromotionRoot === '' ||
        isAbsolute(pathWithinPromotionRoot) ||
        pathWithinPromotionRoot.startsWith('..') ||
        pathWithinPromotionRoot.includes('..\\')
      ) {
        throw new Error('evaluation escaped private root')
      }
      evaluationRoot = resolvedEvaluation
    } catch {
      throw new Error('Required post-training evaluation evidence is unavailable.')
    }
  }
  // STRUM's experiment directory owns experiment.json and its nested bundle.
  // Package handlers consume that directory, while evaluators consume the bundle.
  const experimentRoot = await resolveLegacyTrainingRunRoot(run.outputRoot)
  if (
    binding.bundleRoot !== experimentRoot &&
    !isContainedPath(experimentRoot, binding.bundleRoot)
  ) {
    throw new Error('The candidate is outside its registered training experiment.')
  }
  const values: Record<string, string | undefined> = {
    bundle_root: binding.bundleRoot,
    experiment: experimentRoot,
    experiment_root: experimentRoot,
    task_view: binding.taskView,
    dataset_manifest: binding.taskView,
    catalog_root: binding.catalogRoot,
    output: outputRoot,
    evaluation: evaluationRoot
  }
  for (const field of job.private_request_fields) {
    const value = values[field]
    if (!value)
      throw new Error('This post-training job is not available for the selected candidate.')
    request[field] = value
  }
  for (const field of job.optional_private_request_fields) {
    const value = values[field]
    if (value) request[field] = value
  }
  return { request, outputRoot }
}

/** List only descriptor-advertised, currently available post-training actions. */
export async function listPromotionJobs(
  candidateArtifactId: string
): Promise<TrainingPromotionJob[]> {
  const runtime = await probeTrainingRuntime()
  if (
    !runtime.capabilities.includes('post_train_job_discovery') ||
    !runtime.capabilities.includes('post_train_job_start')
  ) {
    return []
  }
  const { run } = await resolveCandidateBinding(candidateArtifactId)
  const pipeline = await resolveTrainingPipeline(run.pipelineId)
  const registry = await readRegistry()
  const hasEvaluation = (registry.promotions ?? []).some(
    (entry) =>
      entry.candidateArtifactId === candidateArtifactId &&
      entry.pipeline_id === run.pipelineId &&
      entry.kind === 'evaluation' &&
      entry.status === 'completed' &&
      existsSync(entry.outputRoot)
  )
  return pipeline.promotion_jobs.filter(
    (job) =>
      job.status === 'available' &&
      supportsPromotionPrivateFields(job) &&
      (!job.private_request_fields.includes('evaluation') || hasEvaluation)
  )
}

export async function startPromotionJob(options: {
  candidateArtifactId: string
  jobId: string
  options: Record<string, unknown>
}): Promise<{ jobId: string }> {
  if (!isArtifactId(options.candidateArtifactId) || !isSafeContractName(options.jobId)) {
    throw new Error('Select a valid post-training job first.')
  }
  const runtime = await probeTrainingRuntime()
  if (!runtime.capabilities.includes('post_train_job_start')) {
    throw new Error('The selected STRUM runtime cannot run post-training jobs.')
  }
  const { run } = await resolveCandidateBinding(options.candidateArtifactId)
  const pipeline = await resolveTrainingPipeline(run.pipelineId)
  const job = pipeline.promotion_jobs.find(
    (candidate) => candidate.id === options.jobId && candidate.status === 'available'
  )
  if (!job || !supportsPromotionPrivateFields(job)) {
    throw new Error('That post-training job is not available for the selected candidate.')
  }
  const jobId = randomUUID()
  const { request, outputRoot } = await resolvePromotionRequest(
    options.candidateArtifactId,
    job,
    options.options,
    jobId
  )
  await startJsonEventJob(jobId, ['promotion', 'start'], request, async (result) => {
    const normalized = normalizePromotionResult(
      result,
      run.pipelineId,
      job,
      `promotion-${jobId}`,
      options.candidateArtifactId
    )
    if (!normalized) throw new Error('STRUM returned an invalid post-training result.')
    const packagedInspection =
      job.kind === 'package'
        ? normalizeDiscoveredCheckpoint(
            await runWorkerJson(['checkpoint', 'inspect', '--model-root', outputRoot, '--json'])
          )
        : null
    if (job.kind === 'package' && !packagedInspection) {
      throw new Error('STRUM could not re-inspect the packaged model bundle.')
    }
    const stored: StoredPromotion = {
      ...normalized,
      candidateArtifactId: options.candidateArtifactId,
      kind: job.kind,
      outputRoot
    }
    await updateRegistry((registry) => {
      registry.promotions = [
        ...(registry.promotions ?? []).filter((entry) => entry.promotionId !== stored.promotionId),
        stored
      ]
    })
    if (!packagedInspection) return normalized
    discoveredCheckpointRoots.set(packagedInspection.artifactId, outputRoot)
    return {
      ...normalized,
      artifactId: packagedInspection.artifactId,
      deploymentStatus: packagedInspection.deploymentStatus
    }
  })
  return { jobId }
}

export async function inspectTrainingCatalog(
  catalogRoot: string,
  pipelineId: string,
  requestedOptions: Record<string, unknown>
): Promise<TrainingCatalogInspection> {
  const pipeline = await resolveTrainingPipeline(pipelineId)
  const preparedOptions = sanitizeTrainingSchemaValues(
    pipeline.prepare_schema,
    requestedOptions,
    'catalog inspection'
  )
  const inspectionOptions = Object.fromEntries(
    Object.entries(preparedOptions).filter(([key]) =>
      pipeline.catalog_inspection_option_keys.includes(key)
    )
  )
  const payload = await runWorkerJson(
    [
      'catalog',
      'inspect',
      '--catalog-root',
      catalogRoot,
      '--pipeline',
      pipelineId,
      '--options',
      JSON.stringify(inspectionOptions),
      '--json'
    ],
    CATALOG_INSPECTION_TIMEOUT_MS
  )
  const expectedKeys = [
    'status',
    'catalog_id',
    'record_count',
    'allowed_record_count',
    'pipeline_id',
    'eligible_count',
    'exclusion_reason_counts',
    'audio_policy',
    'estimated_storage_bytes',
    'storage_estimate_capped',
    'storage_estimate_semantics',
    'eligibility_selection'
  ]
  const recordCount = normalizeNonNegativeCount(payload.record_count)
  const allowedRecordCount = normalizeNonNegativeCount(payload.allowed_record_count)
  const eligibleCount = normalizeNonNegativeCount(payload.eligible_count)
  const estimatedStorageBytes = normalizeNonNegativeCount(payload.estimated_storage_bytes)
  if (
    !hasOnlyKeys(
      payload,
      expectedKeys,
      expectedKeys.filter((key) => key !== 'eligibility_selection')
    ) ||
    payload.status !== 'ready' ||
    !isSafeContractToken(payload.catalog_id) ||
    payload.pipeline_id !== pipelineId ||
    recordCount === null ||
    allowedRecordCount === null ||
    eligibleCount === null ||
    estimatedStorageBytes === null ||
    (payload.storage_estimate_capped !== true && payload.storage_estimate_capped !== false) ||
    !isSafeDisplayText(payload.storage_estimate_semantics)
  ) {
    throw new Error('STRUM returned an invalid catalog inspection result.')
  }
  const excluded = normalizeExclusionReasonCounts(payload.exclusion_reason_counts)
  const audioPolicy = normalizeMetadataRecord(payload.audio_policy)
  if (
    !excluded ||
    !audioPolicy ||
    (payload.eligibility_selection !== undefined &&
      !normalizeMetadataRecord(payload.eligibility_selection))
  ) {
    throw new Error('STRUM returned an invalid catalog inspection result.')
  }
  return {
    pipelineId,
    eligibleCount,
    recordCount,
    excluded,
    audioPolicy,
    estimatedStorageBytes,
    storageEstimateCapped: payload.storage_estimate_capped,
    storageEstimateSemantics: payload.storage_estimate_semantics
  }
}

export async function listTrainingArtifacts(): Promise<{
  tasks: TrainingTask[]
  runs: TrainingRun[]
  profiles: AutoChartProfile[]
  jobs: TrainingJobEvent[]
}> {
  await registryMutation
  const registry = await readRegistry()
  return {
    jobs: (registry.jobs ?? []).flatMap<TrainingJobEvent>((entry) => {
      if (typeof entry.jobId !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.jobId)) return []
      const live = latestTrainingEvents.get(entry.jobId)
      if (live) return [{ ...live, result: undefined }]
      const state = ['succeeded', 'failed', 'cancelled'].includes(String(entry.state))
        ? (entry.state as 'succeeded' | 'failed' | 'cancelled')
        : 'failed'
      const interrupted = !['succeeded', 'failed', 'cancelled'].includes(String(entry.state))
      return [
        {
          jobId: entry.jobId,
          sequence: Number.isSafeInteger(entry.sequence) ? entry.sequence + 1 : 1,
          stage: 'complete',
          state,
          code: interrupted ? 'interrupted' : state,
          message: interrupted
            ? 'This STRUM job was interrupted when OCTAVE stopped. Start a new job to retry.'
            : state === 'succeeded'
              ? 'Completed locally.'
              : state === 'cancelled'
                ? 'The STRUM training job was cancelled.'
                : 'STRUM could not complete this local job.'
        }
      ]
    }),
    tasks: registry.tasks
      .filter((task) => existsSync(task.taskRoot))
      .map((task) => ({
        taskViewId: task.taskViewId,
        catalogId: task.catalogId,
        catalogName: task.catalogName,
        pipelineId: task.pipelineId,
        eligibleCount: task.eligibleCount,
        contentHash: task.contentHash,
        createdAt: task.createdAt
      })),
    runs: registry.runs
      .filter((run) => existsSync(run.outputRoot))
      .map((run) => ({
        runId: run.runId,
        taskViewId: run.taskViewId,
        pipelineId: run.pipelineId,
        checkpointCount: run.checkpointCount,
        deployable: run.deployable,
        checkpointManifestHash: run.checkpointManifestHash,
        ...(run.artifactId ? { artifactId: run.artifactId } : {}),
        createdAt: run.createdAt
      })),
    profiles: (registry.profiles ?? [])
      .filter((profile) => existsSync(profile.checkpointRoot))
      .map((profile) =>
        publicAutoChartProfile(profile, profile.profileId === registry.defaultProfileId)
      )
  }
}

function publicAutoChartProfile(
  profile: StoredAutoChartProfile,
  isDefault = profile.isDefault
): AutoChartProfile {
  return {
    profileId: profile.profileId,
    ...(profile.runId ? { runId: profile.runId } : {}),
    ...(profile.strumProfileId ? { strumProfileId: profile.strumProfileId } : {}),
    ...(profile.artifactId ? { artifactId: profile.artifactId } : {}),
    ...(profile.difficultyPolicy ? { difficultyPolicy: profile.difficultyPolicy } : {}),
    pipelineId: profile.pipelineId,
    runtimeId: profile.runtimeId,
    createdAt: profile.createdAt,
    isDefault
  }
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function isSafeCapability(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9._-]{0,120}\/v[0-9]+$/.test(value)
}

function isSafeDifficultyPolicy(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9._:-]{0,127}$/.test(value)
}

function isArtifactId(value: unknown): value is string {
  return typeof value === 'string' && /^strum-model-bundle\/[a-f0-9]{64}$/.test(value)
}

function normalizeComponent(
  value: unknown
): { id: string; sha256: string; byteLength: number } | null {
  if (!value || typeof value !== 'object') return null
  const component = value as Record<string, unknown>
  const id = component.id
  const sha256 = component.sha256
  const byteLength = Number(component.byte_length)
  if (
    !isSafeIdentifier(id) ||
    typeof sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0
  ) {
    return null
  }
  return { id, sha256, byteLength }
}

function normalizeDiscoveredProfile(value: unknown): DiscoveredCheckpointProfile | null {
  if (!value || typeof value !== 'object') return null
  const profile = value as Record<string, unknown>
  const execution = profile.execution
  if (!execution || typeof execution !== 'object') return null
  const executionValue = execution as Record<string, unknown>
  const profileId = profile.profile_id
  const capability = profile.capability
  const instruments = Array.isArray(profile.instruments) ? profile.instruments : null
  const difficultyPolicies = Array.isArray(profile.difficulty_policies)
    ? profile.difficulty_policies
    : null
  const requiredComponents = Array.isArray(profile.required_components)
    ? profile.required_components
    : null
  const executablePolicies = Array.isArray(executionValue.difficulty_policies)
    ? executionValue.difficulty_policies
    : null
  const executionStatus = executionValue.status
  if (
    !isSafeIdentifier(profileId) ||
    !isSafeCapability(capability) ||
    !instruments ||
    !instruments.every(isSafeIdentifier) ||
    !difficultyPolicies ||
    !difficultyPolicies.every(isSafeDifficultyPolicy) ||
    !requiredComponents ||
    !requiredComponents.every(isSafeIdentifier) ||
    !executablePolicies ||
    !executablePolicies.every(isSafeDifficultyPolicy) ||
    (executionStatus !== 'available' && executionStatus !== 'not_available')
  ) {
    return null
  }
  return {
    profileId,
    capability,
    instruments: [...instruments],
    difficultyPolicies: [...difficultyPolicies],
    requiredComponents: [...requiredComponents],
    execution: { status: executionStatus, difficultyPolicies: [...executablePolicies] }
  }
}

function normalizeDiscoveredCheckpoint(value: unknown): DiscoveredCheckpoint | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const artifactId = candidate.artifact_id
  const modelId = candidate.model_id
  const manifestSha256 = candidate.manifest_sha256
  const schemaVersion = candidate.schema_version
  const components = Array.isArray(candidate.components) ? candidate.components : null
  const profiles = Array.isArray(candidate.profiles) ? candidate.profiles : null
  const rejectedProfileCount = candidate.rejected_profile_count
  const deploymentStatus = candidate.deployment_status
  const rawCompatibility = candidate.compatibility
  if (
    !isArtifactId(artifactId) ||
    !isSafeIdentifier(modelId) ||
    typeof manifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifestSha256) ||
    typeof schemaVersion !== 'number' ||
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 1 ||
    !components ||
    !profiles ||
    typeof rejectedProfileCount !== 'number' ||
    !Number.isSafeInteger(rejectedProfileCount) ||
    rejectedProfileCount < 0 ||
    (deploymentStatus !== 'ready' && deploymentStatus !== 'not_deployable') ||
    !rawCompatibility ||
    typeof rawCompatibility !== 'object' ||
    Array.isArray(rawCompatibility)
  ) {
    return null
  }
  const normalizedComponents = components.map(normalizeComponent)
  const normalizedProfiles = profiles.map(normalizeDiscoveredProfile)
  if (normalizedComponents.some((component) => component === null)) return null
  if (normalizedProfiles.some((profile) => profile === null)) return null
  const compatibility = normalizeDiscoveredCompatibility(rawCompatibility)
  if (!compatibility) return null
  return {
    artifactId,
    modelId,
    manifestSha256,
    schemaVersion,
    compatibility,
    components: normalizedComponents.filter(
      (component): component is NonNullable<typeof component> => component !== null
    ),
    profiles: normalizedProfiles.filter(
      (profile): profile is NonNullable<typeof profile> => profile !== null
    ),
    rejectedProfileCount,
    deploymentStatus
  }
}

function normalizeDiscoveredCompatibility(
  value: unknown
): Record<string, string | number | boolean | null> | null {
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  const manifestSchema = value.manifest_schema
  const strumVersion = value.strum_version
  const allowed = new Set([
    'manifest_schema',
    'strum_version',
    'strum_revision',
    'strum_source_dirty'
  ])
  if (
    keys.length < 2 ||
    keys.length > allowed.size ||
    !keys.every((key) => allowed.has(key)) ||
    typeof manifestSchema !== 'number' ||
    !Number.isSafeInteger(manifestSchema) ||
    manifestSchema < 1 ||
    typeof strumVersion !== 'string' ||
    !/^>=\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9._-]+)?$/.test(strumVersion)
  ) {
    return null
  }
  if (
    (value.strum_revision !== undefined && !isSafeContractToken(value.strum_revision)) ||
    (value.strum_source_dirty !== undefined &&
      value.strum_source_dirty !== null &&
      typeof value.strum_source_dirty !== 'boolean')
  ) {
    return null
  }
  return {
    manifest_schema: manifestSchema,
    strum_version: strumVersion,
    ...(value.strum_revision === undefined ? {} : { strum_revision: value.strum_revision }),
    ...(value.strum_source_dirty === undefined
      ? {}
      : { strum_source_dirty: value.strum_source_dirty })
  }
}

function normalizeCheckpointDiscovery(payload: Record<string, unknown>): CheckpointDiscovery {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
  const normalizedCandidates = candidates.map(normalizeDiscoveredCheckpoint)
  if (
    payload.format !== 'strum-model-bundle-discovery/v1' ||
    payload.status !== 'ready' ||
    normalizedCandidates.some((candidate) => candidate === null)
  ) {
    throw new Error('STRUM did not return a valid checkpoint discovery response.')
  }
  const candidateCount = Number(payload.candidate_count)
  const profileCount = Number(payload.profile_count)
  const rejectedBundleCount = Number(payload.rejected_bundle_count)
  if (
    !Number.isSafeInteger(candidateCount) ||
    candidateCount !== normalizedCandidates.length ||
    !Number.isSafeInteger(profileCount) ||
    !Number.isSafeInteger(rejectedBundleCount) ||
    rejectedBundleCount < 0 ||
    typeof payload.truncated !== 'boolean'
  ) {
    throw new Error('STRUM returned an inconsistent checkpoint discovery response.')
  }
  const usable = normalizedCandidates.filter(
    (candidate): candidate is NonNullable<typeof candidate> => candidate !== null
  )
  if (profileCount !== usable.reduce((total, candidate) => total + candidate.profiles.length, 0)) {
    throw new Error('STRUM returned an inconsistent checkpoint discovery response.')
  }
  return {
    candidateCount,
    profileCount,
    rejectedBundleCount,
    truncated: payload.truncated,
    candidates: usable
  }
}

async function findPrivateModelBundleRoots(root: string): Promise<string[]> {
  const resolvedRoot = await realpath(root)
  const roots: string[] = []
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (roots.length >= MAX_DISCOVERED_MODEL_MANIFESTS) return
    let entries: Dirent<string>[]
    try {
      entries = await readdir(directory, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }
    if (
      entries.some(
        (entry) =>
          entry.name === MODEL_BUNDLE_MANIFEST_NAME && entry.isFile() && !entry.isSymbolicLink()
      )
    ) {
      roots.push(directory)
    }
    if (depth >= MAX_MODEL_DISCOVERY_DEPTH) return
    for (const entry of entries) {
      if (
        roots.length >= MAX_DISCOVERED_MODEL_MANIFESTS ||
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        MODEL_DISCOVERY_IGNORED_DIRECTORIES.has(entry.name)
      ) {
        continue
      }
      await visit(join(directory, entry.name), depth + 1)
    }
  }
  await visit(resolvedRoot, 0)
  return roots
}

async function mapPrivateArtifactRoots(
  roots: string[],
  candidates: DiscoveredCheckpoint[]
): Promise<Map<string, string>> {
  const wanted = new Set(candidates.map((candidate) => candidate.artifactId))
  const resolved = new Map<string, string>()
  let next = 0
  const workerCount = Math.min(4, roots.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < roots.length) {
        const root = roots[next]
        next += 1
        try {
          const inspection = normalizeDiscoveredCheckpoint(
            await runWorkerJson(['checkpoint', 'inspect', '--model-root', root, '--json'])
          )
          if (inspection && wanted.has(inspection.artifactId)) {
            resolved.set(inspection.artifactId, root)
          }
        } catch {
          // The discovery response remains authoritative; this private mapping
          // pass simply prevents an unmapped item from reaching the renderer.
        }
      }
    })
  )
  return resolved
}

export async function chooseCheckpointFolder(): Promise<CheckpointDiscovery | null> {
  const selection = await dialog.showOpenDialog({
    title: 'Select a folder containing STRUM model bundles',
    properties: ['openDirectory']
  })
  if (selection.canceled || selection.filePaths.length === 0) return null
  let modelRoot: string
  try {
    modelRoot = await realpath(selection.filePaths[0])
  } catch {
    throw new Error('The selected model folder is no longer available.')
  }
  // A folder selection starts a new private discovery session. Do not retain
  // artifact-to-path bindings from an earlier folder, even if an artifact ID
  // happens to collide with a later result.
  discoveredCheckpointRoots.clear()
  const discovery = normalizeCheckpointDiscovery(
    await runWorkerJson(['checkpoint', 'discover', '--model-root', modelRoot, '--json'])
  )
  const mappedRoots = await mapPrivateArtifactRoots(
    await findPrivateModelBundleRoots(modelRoot),
    discovery.candidates
  )
  const candidates = discovery.candidates.filter((candidate) =>
    mappedRoots.has(candidate.artifactId)
  )
  for (const [artifactId, root] of mappedRoots) discoveredCheckpointRoots.set(artifactId, root)
  return {
    ...discovery,
    candidateCount: candidates.length,
    profileCount: candidates.reduce((total, candidate) => total + candidate.profiles.length, 0),
    candidates
  }
}

function privateCheckpointRoot(artifactId: string): string {
  if (!isArtifactId(artifactId)) throw new Error('The selected checkpoint is invalid.')
  const root = discoveredCheckpointRoots.get(artifactId)
  if (!root) throw new Error('Select the checkpoint folder again before validation.')
  return root
}

/**
 * Profile roots are chosen through the main-process picker and saved in their
 * canonical form. Requiring that same canonical location on every use turns a
 * later symlink replacement into a stale profile rather than an arbitrary
 * model-root handoff. Content changes are caught separately by STRUM's
 * manifest re-inspection below.
 */
async function resolveRegisteredProfileRoot(profile: StoredAutoChartProfile): Promise<string> {
  const root = await realpath(profile.checkpointRoot)
  if (root !== profile.checkpointRoot || !(await stat(root)).isDirectory()) {
    throw new Error('The saved model bundle location changed.')
  }
  const manifest = await lstat(join(root, MODEL_BUNDLE_MANIFEST_NAME))
  if (!manifest.isFile() || manifest.isSymbolicLink()) {
    throw new Error('The saved model bundle location changed.')
  }
  return root
}

export async function inspectDiscoveredCheckpoint(
  artifactId: string
): Promise<DiscoveredCheckpoint> {
  const root = privateCheckpointRoot(artifactId)
  const inspection = normalizeDiscoveredCheckpoint(
    await runWorkerJson(['checkpoint', 'inspect', '--model-root', root, '--json'])
  )
  if (!inspection || inspection.artifactId !== artifactId) {
    throw new Error('The selected checkpoint changed after discovery.')
  }
  return inspection
}

export async function inspectTrainingCheckpoint(runId: string): Promise<TrainingCheckpoint> {
  const registry = await readRegistry()
  const run = registry.runs.find((entry) => entry.runId === runId && existsSync(entry.outputRoot))
  if (!run) throw new Error('The selected training run is no longer available.')
  const bundleRoot = run.candidateBinding
    ? await resolveContainedTrainingBundleRoot(run.outputRoot, run.candidateBinding.bundleRoot)
    : await resolveLegacyTrainingRunRoot(run.outputRoot)
  const candidate = normalizeDiscoveredCheckpoint(
    await runWorkerJson(['checkpoint', 'inspect', '--model-root', bundleRoot, '--json'])
  )
  if (
    !candidate ||
    candidate.manifestSha256 !== run.checkpointManifestHash ||
    (run.artifactId !== undefined && candidate.artifactId !== run.artifactId)
  ) {
    throw new Error('The checkpoint does not match the selected training run.')
  }
  return {
    runId: run.runId,
    pipelineId: run.pipelineId,
    runtimeId: (await probeTrainingRuntime()).runtimeId,
    taskViewId: run.taskViewId,
    taskViewHash:
      registry.tasks.find((task) => task.taskViewId === run.taskViewId)?.contentHash ?? '',
    checkpointManifestHash: candidate.manifestSha256,
    deployable: candidate.deploymentStatus === 'ready',
    deploymentReason:
      candidate.deploymentStatus === 'ready'
        ? null
        : 'requires STRUM profile evaluation and promotion',
    components: candidate.components
  }
}

function supportsTypedChartExecution(runtime: TrainingRuntime): boolean {
  return ['chart_preflight', 'chart_run', 'typed_chart_results'].every((capability) =>
    runtime.capabilities.includes(capability)
  )
}

export async function saveDiscoveredAutoChartProfile(options: {
  artifactId: string
  profileId: string
  difficultyPolicy: string
}): Promise<AutoChartProfile> {
  const checkpoint = await inspectDiscoveredCheckpoint(options.artifactId)
  if (checkpoint.deploymentStatus !== 'ready') {
    throw new Error('This bundle has no executable STRUM Auto Chart profile.')
  }
  const profile = checkpoint.profiles.find((entry) => entry.profileId === options.profileId)
  if (
    !profile ||
    profile.execution.status !== 'available' ||
    !profile.execution.difficultyPolicies.includes(options.difficultyPolicy)
  ) {
    throw new Error('The selected STRUM profile is not executable for that difficulty policy.')
  }
  assertProfileIsSelectableInAutoChart(profile, options.difficultyPolicy)
  const runtime = await probeTrainingRuntime()
  if (!supportsTypedChartExecution(runtime)) {
    throw new Error('The selected STRUM runtime cannot run deployed Auto Chart profiles.')
  }
  const root = await realpath(privateCheckpointRoot(options.artifactId))
  const validation = await runWorkerJson([
    'inference',
    'profile',
    'validate',
    '--model-root',
    root,
    '--profile',
    profile.profileId,
    '--difficulty-policy',
    options.difficultyPolicy,
    '--json'
  ])
  if (
    validation.status !== 'ready' ||
    validation.profile_id !== profile.profileId ||
    validation.manifest_sha256 !== checkpoint.manifestSha256
  ) {
    throw new Error('STRUM did not validate the selected checkpoint profile.')
  }
  const profileId = `octave-strum-profile-${randomUUID()}`
  const saved: StoredAutoChartProfile = {
    profileId,
    strumProfileId: profile.profileId,
    artifactId: checkpoint.artifactId,
    manifestSha256: checkpoint.manifestSha256,
    difficultyPolicy: options.difficultyPolicy,
    pipelineId: profile.capability,
    runtimeId: runtime.runtimeId,
    createdAt: new Date().toISOString(),
    isDefault: true,
    checkpointRoot: root
  }
  await updateRegistry((registry) => {
    registry.profiles = [
      ...(registry.profiles ?? []).filter(
        (entry) =>
          entry.artifactId !== checkpoint.artifactId || entry.strumProfileId !== profile.profileId
      ),
      saved
    ]
    registry.defaultProfileId = profileId
  })
  return publicAutoChartProfile(saved, true)
}

const COMPOSABLE_PROFILE_CAPABILITIES = new Set([
  'guitar.hybrid-v2-rule/v1',
  'guitar.neural-v1-expert/v1',
  'bass.neural-v1-expert/v1',
  'keys.neural-v1-expert/v1',
  'drums.v14-expert/v1'
])
const COMPOSABLE_PROFILE_INSTRUMENTS = new Set(['guitar', 'bass', 'keys', 'drums'])

/**
 * Create a portable STRUM composition from explicit saved profiles. The
 * renderer submits only OCTAVE profile IDs; bundle roots are resolved and
 * re-inspected exclusively in this main-process boundary.
 */
export async function composeSavedAutoChartProfiles(options: {
  profileIds: string[]
}): Promise<{ jobId: string }> {
  if (
    !Array.isArray(options.profileIds) ||
    !options.profileIds.every(isSafeContractToken) ||
    options.profileIds.length < 2 ||
    options.profileIds.length > 4 ||
    new Set(options.profileIds).size !== options.profileIds.length
  ) {
    throw new Error('Choose two to four distinct validated Expert profiles.')
  }
  const runtime = await probeTrainingRuntime()
  if (
    !runtime.capabilities.includes('checkpoint_composition') ||
    !supportsTypedChartExecution(runtime)
  ) {
    throw new Error('The selected STRUM runtime cannot compose validated profile bundles.')
  }
  const registry = await readRegistry()
  const storedProfiles = options.profileIds.map((profileId) =>
    (registry.profiles ?? []).find((profile) => profile.profileId === profileId)
  )
  if (storedProfiles.some((profile) => !profile)) {
    throw new Error('One of the selected Auto Chart profiles is no longer available.')
  }
  const children: Array<{ model_root: string; profile_id: string }> = []
  const instruments: string[] = []
  for (const stored of storedProfiles as StoredAutoChartProfile[]) {
    if (stored.difficultyPolicy !== 'expert_only') {
      throw new Error('Only validated Expert-only STRUM profiles can be composed.')
    }
    const root = await resolveRegisteredProfileRoot(stored)
    const inspection = normalizeDiscoveredCheckpoint(
      await runWorkerJson(['checkpoint', 'inspect', '--model-root', root, '--json'])
    )
    const strumProfileId = stored.strumProfileId ?? stored.profileId
    const profile = inspection?.profiles.find((entry) => entry.profileId === strumProfileId)
    if (
      !inspection ||
      inspection.deploymentStatus !== 'ready' ||
      inspection.manifestSha256 !== stored.manifestSha256 ||
      !profile ||
      profile.execution.status !== 'available' ||
      !profile.execution.difficultyPolicies.includes('expert_only') ||
      !COMPOSABLE_PROFILE_CAPABILITIES.has(profile.capability) ||
      profile.instruments.length !== 1 ||
      !COMPOSABLE_PROFILE_INSTRUMENTS.has(profile.instruments[0])
    ) {
      throw new Error('Each selected profile must be a current, direct Expert five-lane profile.')
    }
    children.push({ model_root: root, profile_id: strumProfileId })
    instruments.push(profile.instruments[0])
  }
  if (new Set(instruments).size !== instruments.length) {
    throw new Error('Choose one validated profile per instrument.')
  }
  const jobId = randomUUID()
  const outputRoot = join(trainingRoot(), 'compositions', jobId, 'bundle')
  await mkdir(dirname(outputRoot), { recursive: true })
  await startJsonEventJob(
    jobId,
    ['checkpoint', 'compose'],
    { output: outputRoot, profiles: children },
    async (result) => {
      if (
        result.status !== 'packaged' ||
        result.profile_id !== 'five-lane-composition' ||
        result.capability !== 'five-lane.composition/v1' ||
        !Array.isArray(result.instruments) ||
        result.instruments.length !== instruments.length ||
        result.instruments.some((instrument, index) => instrument !== instruments[index]) ||
        typeof result.manifest_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(result.manifest_sha256)
      ) {
        throw new Error('STRUM returned an invalid composed profile result.')
      }
      const inspection = normalizeDiscoveredCheckpoint(
        await runWorkerJson(['checkpoint', 'inspect', '--model-root', outputRoot, '--json'])
      )
      const composed = inspection?.profiles.find(
        (profile) => profile.profileId === 'five-lane-composition'
      )
      if (
        !inspection ||
        inspection.deploymentStatus !== 'ready' ||
        inspection.manifestSha256 !== result.manifest_sha256 ||
        !composed ||
        composed.capability !== 'five-lane.composition/v1' ||
        composed.execution.status !== 'available' ||
        !composed.execution.difficultyPolicies.includes('expert_only') ||
        composed.instruments.length !== instruments.length ||
        composed.instruments.some((instrument, index) => instrument !== instruments[index])
      ) {
        throw new Error('STRUM could not verify the composed profile bundle.')
      }
      discoveredCheckpointRoots.set(inspection.artifactId, outputRoot)
      const saved = await saveDiscoveredAutoChartProfile({
        artifactId: inspection.artifactId,
        profileId: composed.profileId,
        difficultyPolicy: 'expert_only'
      })
      return {
        format: 'octave-strum-profile-composition-result/v1',
        profile_id: saved.profileId,
        instruments: [...composed.instruments]
      }
    }
  )
  return { jobId }
}

type ResolvedAutoChartProfile = StoredAutoChartProfile & {
  instruments: string[]
}

async function discardInvalidDefaultProfile(profileId: string): Promise<void> {
  await updateRegistry((registry) => {
    registry.profiles = (registry.profiles ?? []).filter((entry) => entry.profileId !== profileId)
    if (registry.defaultProfileId === profileId) registry.defaultProfileId = undefined
  })
}

async function resolveDefaultAutoChartProfile(): Promise<ResolvedAutoChartProfile | null> {
  const registry = await readRegistry()
  const profile = (registry.profiles ?? []).find(
    (entry) => entry.profileId === registry.defaultProfileId
  )
  if (!profile) return null
  try {
    const checkpointRoot = await resolveRegisteredProfileRoot(profile)
    const runtime = await probeTrainingRuntime()
    if (runtime.runtimeId !== profile.runtimeId || !supportsTypedChartExecution(runtime)) {
      await discardInvalidDefaultProfile(profile.profileId)
      return null
    }
    // A profile is usable only when the current bundle re-inspection retains
    // the exact artifact and manifest identity that OCTAVE saved.
    if (!profile.artifactId || !profile.manifestSha256) {
      await discardInvalidDefaultProfile(profile.profileId)
      return null
    }
    const inspection = normalizeDiscoveredCheckpoint(
      await runWorkerJson(['checkpoint', 'inspect', '--model-root', checkpointRoot, '--json'])
    )
    if (
      !inspection ||
      inspection.artifactId !== profile.artifactId ||
      inspection.manifestSha256 !== profile.manifestSha256 ||
      inspection.deploymentStatus !== 'ready'
    ) {
      await discardInvalidDefaultProfile(profile.profileId)
      return null
    }
    const strumProfileId = profile.strumProfileId ?? profile.profileId
    const declaredProfile = inspection.profiles.find((entry) => entry.profileId === strumProfileId)
    if (
      !declaredProfile ||
      declaredProfile.execution.status !== 'available' ||
      !declaredProfile.execution.difficultyPolicies.includes(
        profile.difficultyPolicy ?? 'expert_only'
      )
    ) {
      await discardInvalidDefaultProfile(profile.profileId)
      return null
    }
    assertProfileIsSelectableInAutoChart(declaredProfile, profile.difficultyPolicy ?? 'expert_only')
    const validation = await runWorkerJson([
      'inference',
      'profile',
      'validate',
      '--model-root',
      checkpointRoot,
      '--profile',
      strumProfileId,
      '--difficulty-policy',
      profile.difficultyPolicy ?? 'expert_only',
      '--json'
    ])
    if (
      validation.status !== 'ready' ||
      validation.profile_id !== strumProfileId ||
      validation.manifest_sha256 !== profile.manifestSha256
    ) {
      await discardInvalidDefaultProfile(profile.profileId)
      return null
    }
    return { ...profile, checkpointRoot, instruments: declaredProfile.instruments }
  } catch {
    await discardInvalidDefaultProfile(profile.profileId)
    return null
  }
}

const STRUM_CHART_PREFLIGHT_FORMAT = 'strum-chart-preflight/v1'
const STRUM_CHART_RUN_FORMAT = 'strum-chart-run/v1'

function profiledChartStage(instruments: readonly string[]): string {
  const primary = instruments.length === 1 ? instruments[0] : undefined
  return ['drums', 'guitar', 'bass', 'vocals', 'keys'].includes(primary ?? '')
    ? (primary as string)
    : 'bootstrap'
}

function profiledChartDevice(runtime: TrainingRuntime): 'cuda' | 'mps' | 'cpu' {
  if (runtime.deviceSupport.includes('cuda')) return 'cuda'
  if (runtime.deviceSupport.includes('mps')) return 'mps'
  return 'cpu'
}

const AUTO_CHART_PROFILE_TRACKS = {
  drums: { setting: 'drums', midiTrackNames: ['PART DRUMS'] },
  guitar: { setting: 'guitar', midiTrackNames: ['PART GUITAR'] },
  bass: { setting: 'bass', midiTrackNames: ['PART BASS'] },
  vocals: { setting: 'vocals', midiTrackNames: ['PART VOCALS'] },
  keys: { setting: 'keys', midiTrackNames: ['PART KEYS'] },
  pro_keys: {
    setting: 'proKeys',
    midiTrackNames: ['PART REAL_KEYS_X', 'PART REAL_KEYS_H', 'PART REAL_KEYS_M', 'PART REAL_KEYS_E']
  }
} as const

type AutoChartProfileInstrument = keyof typeof AUTO_CHART_PROFILE_TRACKS

function profileTrackBinding(
  instrument: string
): (typeof AUTO_CHART_PROFILE_TRACKS)[AutoChartProfileInstrument] | undefined {
  return AUTO_CHART_PROFILE_TRACKS[instrument as AutoChartProfileInstrument]
}

function assertProfileIsSelectableInAutoChart(
  profile: Pick<ResolvedAutoChartProfile, 'instruments'>,
  difficultyPolicy = 'expert_only'
): void {
  const unsupported = profile.instruments.find((instrument) => !profileTrackBinding(instrument))
  if (unsupported) {
    throw new Error(
      `The selected STRUM profile declares ${unsupported}, which OCTAVE Auto Chart cannot select.`
    )
  }
  if (profile.instruments.includes('pro_keys') && difficultyPolicy !== 'expert_only') {
    throw new Error(
      'OCTAVE Auto Chart currently supports Pro Keys only with an expert_only STRUM profile.'
    )
  }
}

function expectedProfileMidiTrackNames(
  instrument: string,
  difficultyPolicy: string
): readonly string[] {
  const binding = profileTrackBinding(instrument)
  if (!binding) return []
  if (instrument === 'pro_keys') {
    return difficultyPolicy === 'expert_only' ? ['PART REAL_KEYS_X'] : []
  }
  return binding.midiTrackNames
}

function isOctavePlayableProfileNote(
  instrument: string,
  midiTrackName: string,
  noteNumber: number,
  difficultyPolicy: string
): boolean {
  if (instrument === 'pro_keys') {
    return (
      difficultyPolicy === 'expert_only' &&
      midiTrackName === 'PART REAL_KEYS_X' &&
      noteNumber >= 48 &&
      noteNumber <= 72
    )
  }
  if (instrument === 'vocals') {
    return (noteNumber >= 36 && noteNumber <= 84) || noteNumber === 96 || noteNumber === 97
  }
  const fiveLaneOffsets = difficultyPolicy === 'expert_only' ? [96] : [60, 72, 84, 96]
  if (instrument === 'drums') {
    return fiveLaneOffsets.some((offset) => noteNumber >= offset - 1 && noteNumber <= offset + 4)
  }
  return fiveLaneOffsets.some((offset) => noteNumber >= offset && noteNumber <= offset + 4)
}

/**
 * Translate OCTAVE's explicit track toggles into the ordered subset a typed
 * STRUM profile will execute.  This is intentionally strict: a selected
 * track that the profile cannot produce is an actionable error, never an
 * implicit fallback to a smaller chart.
 */
function requestedProfiledInstruments(
  profile: ResolvedAutoChartProfile,
  enabledTracks: AutoChartRunOptions['enabledTracks']
): string[] {
  if (!enabledTracks) return profile.instruments

  assertProfileIsSelectableInAutoChart(profile, profile.difficultyPolicy ?? 'expert_only')
  const profileInstruments = new Set(profile.instruments)
  const selectedUnsupported = Object.entries(AUTO_CHART_PROFILE_TRACKS).find(
    ([instrument, binding]) => enabledTracks[binding.setting] && !profileInstruments.has(instrument)
  )
  if (selectedUnsupported) {
    throw new Error(
      `The selected STRUM profile does not support ${selectedUnsupported[0]}. Choose only profile-supported tracks.`
    )
  }
  if (enabledTracks.harmonies) {
    throw new Error(
      'The selected STRUM profile does not declare Vocal Harmonies. Choose only profile-supported tracks.'
    )
  }

  const requested = profile.instruments.filter((instrument) => {
    const binding = profileTrackBinding(instrument)
    if (!binding) {
      throw new Error(
        `The selected STRUM profile declares unsupported Auto Chart track ${instrument}.`
      )
    }
    return enabledTracks[binding.setting] === true
  })
  if (requested.length === 0) {
    throw new Error('Choose at least one track supported by the selected STRUM profile.')
  }
  return requested
}

type ProfiledAudioInput = { kind: 'local'; audioPath: string } | { kind: 'url'; url: string }

function isAbsoluteLocalAudioPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    isAbsolute(value) &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)
  )
}

function resolveProfiledAudioInput(
  options: Omit<AutoChartRunOptions, 'cacheDir'>
): ProfiledAudioInput {
  const files = Array.isArray(options.files) ? options.files : []
  const folders = Array.isArray(options.folders) ? options.folders : []
  const stemFolders = Array.isArray(options.stemFolders) ? options.stemFolders : []
  const stemSongs = Array.isArray(options.stemSongs) ? options.stemSongs : []
  const urls = Array.isArray(options.urls) ? options.urls : []
  if (folders.length > 0 || stemFolders.length > 0 || stemSongs.length > 0) {
    throw new Error(
      'The selected STRUM profile accepts one local audio file or one HTTPS URL. Folder and stem inputs are not supported by this profile.'
    )
  }
  if (files.length === 1 && urls.length === 0 && isAbsoluteLocalAudioPath(files[0])) {
    return { kind: 'local', audioPath: files[0] }
  }
  if (
    files.length === 0 &&
    urls.length === 1 &&
    typeof urls[0] === 'string' &&
    /^https:\/\//i.test(urls[0])
  ) {
    return { kind: 'url', url: urls[0] }
  }
  throw new Error(
    'The selected STRUM profile accepts exactly one absolute local audio file or one HTTPS URL.'
  )
}

function validateProfiledChartPreflight(
  raw: Record<string, unknown>,
  profile: ResolvedAutoChartProfile,
  requestedInstruments: readonly string[],
  device: string
): void {
  const requestedProfileId = profile.strumProfileId ?? profile.profileId
  const requestedPolicy = profile.difficultyPolicy ?? 'expert_only'
  const rawInstruments = raw.instruments
  if (
    raw.format !== STRUM_CHART_PREFLIGHT_FORMAT ||
    raw.status !== 'ready' ||
    raw.execution !== 'available' ||
    raw.profile_id !== requestedProfileId ||
    raw.manifest_sha256 !== profile.manifestSha256 ||
    raw.difficulty_policy !== requestedPolicy ||
    raw.device !== device ||
    !Array.isArray(rawInstruments) ||
    rawInstruments.length !== requestedInstruments.length ||
    rawInstruments.some((instrument, index) => instrument !== requestedInstruments[index])
  ) {
    throw new Error('The selected STRUM profile could not be preflighted for this chart run.')
  }
}

async function fingerprintChartArtifact(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk))
    stream.once('error', () => reject(new Error('chart artifact unavailable')))
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

async function verifyTypedChartTrackCoverage(
  outputDir: string,
  requestedInstruments: readonly string[],
  difficultyPolicy: string
): Promise<void> {
  let tracks: Array<{ name: string; playableNotes: number[] }>
  try {
    const midi = parseMidi(await readFile(join(outputDir, 'notes.mid')))
    tracks = midi.tracks.map((track) => {
      const nameEvent = track.find(
        (event) => event.type === 'trackName' && typeof event.text === 'string'
      )
      return {
        name: nameEvent && 'text' in nameEvent ? nameEvent.text.trim().toUpperCase() : '',
        playableNotes: track.flatMap((event) =>
          event.type === 'noteOn' &&
          'noteNumber' in event &&
          'velocity' in event &&
          event.velocity > 0
            ? [event.noteNumber]
            : []
        )
      }
    })
  } catch {
    throw new Error('The validated STRUM profile produced unreadable MIDI chart output.')
  }
  const missing = requestedInstruments.find((instrument) => {
    const expectedTrackNames = expectedProfileMidiTrackNames(instrument, difficultyPolicy)
    return !tracks.some(
      (track) =>
        expectedTrackNames.includes(track.name) &&
        track.playableNotes.some((noteNumber) =>
          isOctavePlayableProfileNote(instrument, track.name, noteNumber, difficultyPolicy)
        )
    )
  })
  if (missing) {
    throw new Error(`The validated STRUM profile omitted playable ${missing} chart output.`)
  }
}

async function inspectTypedChartArtifacts(
  outputDir: string,
  profile: ResolvedAutoChartProfile,
  requestedInstruments: readonly string[]
): Promise<TypedChartArtifacts> {
  const manifestSha256 = profile.manifestSha256
  if (!manifestSha256) {
    throw new Error('The validated STRUM profile has no saved bundle identity.')
  }
  let manifest: Record<string, unknown>
  try {
    const raw = JSON.parse(await readFile(join(outputDir, 'run.json'), 'utf8')) as unknown
    if (!isRecord(raw)) throw new Error('invalid manifest')
    manifest = raw
  } catch {
    throw new Error('The validated STRUM profile did not produce an inspectable chart artifact.')
  }
  const notes = isRecord(manifest.artifacts) ? manifest.artifacts.notes_midi : null
  const instrumentResults = manifest.instrument_results
  if (
    manifest.format !== STRUM_CHART_RUN_FORMAT ||
    manifest.status !== 'completed' ||
    manifest.profile_id !== (profile.strumProfileId ?? profile.profileId) ||
    manifest.capability !== profile.pipelineId ||
    manifest.manifest_sha256 !== manifestSha256 ||
    !isRecord(notes) ||
    notes.name !== 'notes.mid' ||
    typeof notes.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(notes.sha256) ||
    !isRecord(instrumentResults) ||
    Object.keys(instrumentResults).length !== requestedInstruments.length ||
    requestedInstruments.some(
      (instrument) =>
        !isRecord(instrumentResults[instrument]) ||
        instrumentResults[instrument].status !== 'succeeded'
    )
  ) {
    throw new Error('The validated STRUM profile produced an invalid chart artifact.')
  }
  let notesHash: string
  let runHash: string
  try {
    ;[notesHash, runHash] = await Promise.all([
      fingerprintChartArtifact(join(outputDir, 'notes.mid')),
      fingerprintChartArtifact(join(outputDir, 'run.json'))
    ])
  } catch {
    throw new Error('The validated STRUM profile did not produce complete chart artifacts.')
  }
  if (notesHash !== notes.sha256) {
    throw new Error('The validated STRUM profile produced an invalid chart artifact.')
  }
  await verifyTypedChartTrackCoverage(
    outputDir,
    requestedInstruments,
    profile.difficultyPolicy ?? 'expert_only'
  )
  return {
    format: 'strum-typed-chart-artifacts/v1',
    profileId: profile.strumProfileId ?? profile.profileId,
    capability: profile.pipelineId,
    manifestSha256,
    artifacts: [
      { id: 'notes_midi', name: 'notes.mid', sha256: notesHash },
      { id: 'run_manifest', name: 'run.json', sha256: runHash }
    ]
  }
}

async function safeProfiledAutoChartResult(
  raw: Record<string, unknown>,
  outputDir: string,
  profile: ResolvedAutoChartProfile,
  requestedInstruments: readonly string[]
): Promise<AutoChartRunResult> {
  const requestedProfileId = profile.strumProfileId ?? profile.profileId
  if (
    raw.format !== STRUM_CHART_RUN_FORMAT ||
    raw.status !== 'completed' ||
    raw.profile_id !== requestedProfileId ||
    raw.manifest_sha256 !== profile.manifestSha256 ||
    raw.run_manifest_name !== 'run.json' ||
    raw.output_name !== 'notes.mid'
  ) {
    throw new Error('The validated STRUM profile returned an invalid chart result.')
  }
  const typedArtifacts = await inspectTypedChartArtifacts(outputDir, profile, requestedInstruments)
  // Preserve generated provenance when this output is later imported as a song
  // folder. A typed run has no legacy songFolders entry for the normal marker.
  await writeFile(
    join(outputDir, 'song.ini'),
    '[song]\nname = STRUM chart\ncharter = STRUM\nstrum_generated = true\ndataset_opt_in = false\n',
    { encoding: 'utf8', flag: 'wx' }
  )
  // A direct STRUM profile produces chart artifacts, not a legacy song-package
  // folder. Keep the output location user-selected and do not invent a package
  // that OCTAVE has not received from the worker.
  return {
    success: true,
    outputDir,
    songFolders: [],
    errors: [],
    typedArtifacts
  }
}

async function runProfiledWorkerJsonCommand(
  worker: WorkerInvocation,
  runId: string,
  requestPaths: string[],
  args: string[],
  cleanupRequests: boolean
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    if (runningProfiledAutoCharts.get(runId)?.cancelling) {
      reject(new Error('The validated STRUM profile chart run was cancelled.'))
      return
    }
    const child = spawn(worker.command, [...worker.baseArgs, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: worker.env,
      cwd: worker.cwd,
      detached: process.platform !== 'win32'
    })
    const running = runningProfiledAutoCharts.get(runId)
    runningProfiledAutoCharts.set(runId, {
      process: child,
      requestPaths,
      cancelling: running?.cancelling === true
    })
    let stdout = ''
    let failed = false
    let closed = false
    child.stdout?.on('data', (chunk: Buffer) => {
      if (failed) return
      stdout += chunk.toString('utf8')
      if (stdout.length > 1_048_576) {
        failed = true
        stdout = ''
        signalTrainingProcessTree(child, true)
      }
    })
    child.stderr?.on('data', () => {
      // Worker stderr may contain private host details; never forward it.
    })
    const clean = async (): Promise<void> => {
      if (cleanupRequests) {
        runningProfiledAutoCharts.delete(runId)
        await Promise.all(
          requestPaths.map(async (path) => await unlink(path).catch(() => undefined))
        )
      } else {
        const tracked = runningProfiledAutoCharts.get(runId)
        if (tracked?.process === child) {
          runningProfiledAutoCharts.set(runId, { ...tracked, process: undefined })
        }
      }
    }
    child.once('error', () => {
      failed = true
      // Node emits close after errors. Do not clean request files before exit.
    })
    child.once('close', (exitCode: number | null) => {
      if (closed) return
      closed = true
      const tracked = runningProfiledAutoCharts.get(runId)
      const wasCancelled = tracked?.cancelling === true
      if (tracked?.cancellationTimer) clearTimeout(tracked.cancellationTimer)
      if (wasCancelled) signalTrainingProcessTree(child, true)
      void clean().then(() => {
        if (wasCancelled) {
          reject(new Error('The validated STRUM profile chart run was cancelled.'))
          return
        }
        const lines = stdout.split(/\r?\n/).filter((line) => line.trim())
        if (failed || exitCode !== 0 || lines.length !== 1) {
          reject(new Error('The validated STRUM profile could not complete this chart run.'))
          return
        }
        try {
          const payload = JSON.parse(lines[0]) as Record<string, unknown>
          if (payload.error) throw new Error('worker error')
          resolve(payload)
        } catch {
          reject(new Error('The validated STRUM profile returned an invalid chart result.'))
        }
      })
    })
  })
}

async function runResolvedAutoChartProfile(
  profile: ResolvedAutoChartProfile,
  options: Omit<AutoChartRunOptions, 'cacheDir'> & { sourceMidiPath?: string }
): Promise<AutoChartRunResult> {
  let worker: WorkerInvocation
  for (;;) {
    const resolved = await resolveWorkerInvocation(options.runId)
    if (resolved.runtimeSelectionEpoch !== runtimeSelectionEpoch || runtimeSelectionActivation)
      continue
    worker = resolved.invocation
    break
  }
  const isTransform = profile.pipelineId === 'difficulty.transform/v1'
  const requestedInstruments = requestedProfiledInstruments(profile, options.enabledTracks)
  if (isTransform && !options.sourceMidiPath) {
    throw new Error(
      'This learned profile needs an Expert MIDI chart. Use Transform MIDI in Training Deploy.'
    )
  }
  const input =
    isTransform && options.files.length === 0 ? null : resolveProfiledAudioInput(options)
  let materialized: MaterializedProfileAudio | null = null
  const runtime = await probeTrainingRuntime()
  const device = profiledChartDevice(runtime)
  const requestPrefix = `octave-profile-chart-${options.runId}-${randomUUID()}`
  const preflightRequestPath = join(app.getPath('temp'), `${requestPrefix}-preflight.json`)
  const runRequestPath = join(app.getPath('temp'), `${requestPrefix}-run.json`)
  const requestPaths = [preflightRequestPath, runRequestPath]
  try {
    if (runningProfiledAutoCharts.get(options.runId)?.cancelling) {
      throw new Error('The validated STRUM profile chart run was cancelled.')
    }
    const audioPath =
      input === null
        ? null
        : input.kind === 'local'
          ? input.audioPath
          : (materialized = await materializeProfileUrlAudio(options.runId, input.url)).audioPath
    if (runningProfiledAutoCharts.get(options.runId)?.cancelling) {
      throw new Error('The validated STRUM profile chart run was cancelled.')
    }
    await writeFile(
      preflightRequestPath,
      JSON.stringify({
        model_root: profile.checkpointRoot,
        profile_id: profile.strumProfileId ?? profile.profileId,
        difficulty_policy: profile.difficultyPolicy ?? 'expert_only',
        instruments: requestedInstruments,
        device
      }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    )
    broadcastAutoChartProgress({
      runId: options.runId,
      stage: 'bootstrap',
      percent: 5,
      message: 'Preflighting the validated STRUM profile locally.'
    })
    const preflight = await runProfiledWorkerJsonCommand(
      worker,
      options.runId,
      requestPaths,
      ['chart', 'preflight', '--request', preflightRequestPath, '--json'],
      false
    )
    if (runningProfiledAutoCharts.get(options.runId)?.cancelling) {
      throw new Error('The validated STRUM profile chart run was cancelled.')
    }
    validateProfiledChartPreflight(preflight, profile, requestedInstruments, device)
    await writeFile(
      runRequestPath,
      JSON.stringify({
        preflight_request: preflightRequestPath,
        ...(isTransform
          ? { source_midi_path: options.sourceMidiPath, song_path: audioPath }
          : { audio_path: audioPath }),
        output_dir: options.outputDir
      }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    )
    broadcastAutoChartProgress({
      runId: options.runId,
      stage: profiledChartStage(requestedInstruments),
      percent: 25,
      message: 'Running the validated STRUM profile locally.'
    })
    return await safeProfiledAutoChartResult(
      await runProfiledWorkerJsonCommand(
        worker,
        options.runId,
        requestPaths,
        ['chart', 'run', '--request', runRequestPath, '--json'],
        true
      ),
      options.outputDir,
      profile,
      requestedInstruments
    )
  } catch (error) {
    await Promise.all(requestPaths.map(async (path) => await unlink(path).catch(() => undefined)))
    throw error
  } finally {
    await materialized?.cleanup()
  }
}

/** Select private transform inputs through native dialogs; expose only artifact identities. */
export async function chooseAndRunTrainingTransform(options: {
  runId: string
  includeAudio: boolean
}): Promise<{ cancelled: boolean; outputName?: string; artifacts?: TypedChartArtifacts }> {
  if (
    !options ||
    !/^[a-f0-9-]{36}$/.test(options.runId) ||
    typeof options.includeAudio !== 'boolean'
  ) {
    throw new Error('Invalid local transform request.')
  }
  if (runningProfiledAutoCharts.has(options.runId))
    throw new Error('This transform is already running.')
  runningProfiledAutoCharts.set(options.runId, { requestPaths: [], cancelling: false })
  try {
    const profile = await resolveDefaultAutoChartProfile()
    if (runningProfiledAutoCharts.get(options.runId)?.cancelling) return { cancelled: true }
    if (profile?.pipelineId !== 'difficulty.transform/v1') {
      throw new Error('Select a validated learned transform as the default profile first.')
    }
    const source = await dialog.showOpenDialog({
      title: 'Choose the source Expert MIDI chart',
      properties: ['openFile'],
      filters: [{ name: 'MIDI charts', extensions: ['mid', 'midi'] }]
    })
    if (
      runningProfiledAutoCharts.get(options.runId)?.cancelling ||
      source.canceled ||
      !source.filePaths[0]
    )
      return { cancelled: true }
    let audioPath: string | undefined
    if (options.includeAudio) {
      const audio = await dialog.showOpenDialog({
        title: 'Choose aligned song audio',
        properties: ['openFile'],
        filters: [{ name: 'Audio', extensions: ['wav', 'ogg', 'flac', 'mp3', 'opus', 'm4a'] }]
      })
      if (
        runningProfiledAutoCharts.get(options.runId)?.cancelling ||
        audio.canceled ||
        !audio.filePaths[0]
      )
        return { cancelled: true }
      audioPath = audio.filePaths[0]
    }
    const destination = await dialog.showOpenDialog({
      title: 'Choose a folder for the new chart output',
      properties: ['openDirectory', 'createDirectory']
    })
    if (
      runningProfiledAutoCharts.get(options.runId)?.cancelling ||
      destination.canceled ||
      !destination.filePaths[0]
    )
      return { cancelled: true }
    const outputName = `strum-transform-${options.runId}`
    const result = await runResolvedAutoChartProfile(profile, {
      runId: options.runId,
      sourceMidiPath: source.filePaths[0],
      outputDir: join(destination.filePaths[0], outputName),
      files: audioPath ? [audioPath] : [],
      folders: [],
      stemFolders: [],
      urls: []
    })
    return { cancelled: false, outputName, artifacts: result.typedArtifacts }
  } finally {
    runningProfiledAutoCharts.delete(options.runId)
  }
}

export async function runDefaultAutoChartProfile(
  options: Omit<AutoChartRunOptions, 'cacheDir'>
): Promise<AutoChartRunResult | null> {
  runningProfiledAutoCharts.set(options.runId, { requestPaths: [], cancelling: false })
  try {
    const profile = await resolveDefaultAutoChartProfile()
    if (!profile) {
      if (runningProfiledAutoCharts.get(options.runId)?.cancelling) {
        throw new Error('The validated STRUM profile chart run was cancelled.')
      }
      return null
    }
    if (runningProfiledAutoCharts.get(options.runId)?.cancelling) {
      throw new Error('The validated STRUM profile chart run was cancelled.')
    }
    return await runResolvedAutoChartProfile(profile, options)
  } finally {
    runningProfiledAutoCharts.delete(options.runId)
  }
}

export async function cancelDefaultAutoChartProfile(runId: string): Promise<boolean> {
  const job = runningProfiledAutoCharts.get(runId)
  if (!job) return false
  if (job.cancelling) return true
  job.cancelling = true
  // Signal first: URL cancellation can itself wait for a child to finish.
  if (job.process) {
    const child = job.process
    signalTrainingProcessTree(child, false)
    job.cancellationTimer = setTimeout(() => {
      if (runningProfiledAutoCharts.get(runId)?.process === child) {
        signalTrainingProcessTree(child, true)
      }
    }, 5_000)
    job.cancellationTimer.unref()
  }
  await cancelProfileUrlMaterialization(runId)
  // The process close handler and outer run finalizer own request cleanup.
  return true
}

/** Cancel the entire worker tree; Windows does not support POSIX process groups. */
function signalTrainingProcessTree(child: ChildProcess, force: boolean): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], () => {
      // The process may already have exited. Terminal handling owns cleanup.
    })
    return
  }
  try {
    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    // Process group already exited.
  }
}

async function startJsonEventJob(
  jobId: string,
  args: string[],
  request: Record<string, unknown>,
  onSucceeded: (
    result: Record<string, unknown>
  ) => Promise<Record<string, unknown> | TrainingPromotionResult>,
  runId?: string
): Promise<void> {
  const requestPath = join(app.getPath('temp'), `octave-training-${jobId}.json`)
  let child: ChildProcess
  try {
    await writeFile(requestPath, JSON.stringify(request), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    let worker: WorkerInvocation
    for (;;) {
      const resolved = await resolveWorkerInvocation(jobId)
      if (resolved.runtimeSelectionEpoch !== runtimeSelectionEpoch || runtimeSelectionActivation) {
        continue
      }
      worker = resolved.invocation
      break
    }
    child = spawn(
      worker.command,
      [...worker.baseArgs, ...args, '--request', requestPath, '--json-events'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: worker.env,
        cwd: worker.cwd,
        detached: process.platform !== 'win32'
      }
    )
  } catch {
    await unlink(requestPath).catch(() => undefined)
    throw new Error('STRUM could not start this local job.')
  }
  const job: RunningTrainingJob = {
    process: child,
    requestPath,
    sequence: 0,
    cancelling: false,
    runId
  }
  runningJobs.set(jobId, job)
  broadcast({
    jobId,
    sequence: 0,
    stage: 'queued',
    progress: 0,
    state: 'queued',
    message: 'Queued locally.'
  })
  let remainder = ''
  let terminal: Record<string, unknown> | undefined
  let finished = false
  let protocolFailed = false
  const safeStage = (value: unknown): string =>
    isSafeContractToken(value) ? String(value) : 'running'
  const safeCode = (value: unknown): string | undefined =>
    isSafeContractToken(value) ? String(value) : undefined
  const finish = async (exitCode: number | null): Promise<void> => {
    if (finished) return
    finished = true
    if (job.cancellationTimer) clearTimeout(job.cancellationTimer)
    if (job.cancelling) signalTrainingProcessTree(child, true)
    await unlink(requestPath).catch(() => undefined)
    const sequence = job.sequence + 1
    if (job.cancelling || terminal?.state === 'cancelled') {
      broadcast({
        jobId,
        sequence,
        stage: 'complete',
        state: 'cancelled',
        code: 'cancelled',
        message: 'The STRUM training job was cancelled.'
      })
      return
    }
    // A claimed success is only evidence after the worker exits successfully.
    // Registration must not race a worker still writing its artifacts.
    if (
      exitCode === 0 &&
      !protocolFailed &&
      terminal?.state === 'succeeded' &&
      isRecord(terminal.result)
    ) {
      try {
        const result = await onSucceeded(terminal.result)
        broadcast({
          jobId,
          sequence,
          stage: 'complete',
          progress: 1,
          state: 'succeeded',
          message: 'Completed locally.',
          result
        })
      } catch {
        broadcast({
          jobId,
          sequence,
          stage: 'complete',
          state: 'failed',
          code: 'result_unavailable',
          message: 'The completed job could not be registered.'
        })
      }
      return
    }
    broadcast({
      jobId,
      sequence,
      stage: 'complete',
      state: 'failed',
      code: protocolFailed
        ? 'invalid_worker_event'
        : (safeCode(terminal?.code) ?? 'worker_terminated'),
      message: 'STRUM rejected or could not complete this local job.'
    })
  }
  const consumeLine = (line: string): void => {
    if (terminal || finished || protocolFailed) return
    try {
      const event: unknown = JSON.parse(line)
      if (!isRecord(event)) return
      const legacyProgress = event.event === 'progress'
      const state = legacyProgress ? 'running' : event.state
      if (
        !['running', 'succeeded', 'failed', 'cancelled', 'validating', 'provisioning'].includes(
          String(state)
        )
      )
        return
      const sequence = event.sequence
      if (
        typeof sequence !== 'number' ||
        !Number.isSafeInteger(sequence) ||
        sequence <= job.sequence
      )
        return
      job.sequence = sequence
      if (state === 'succeeded' || state === 'failed' || state === 'cancelled') {
        terminal = { ...event, state }
        return
      }
      if (job.cancelling) return
      const stage = safeStage(event.stage)
      const progress =
        typeof event.progress === 'number' && Number.isFinite(event.progress)
          ? Math.max(0, Math.min(1, event.progress))
          : 0
      broadcast({
        jobId,
        sequence,
        stage,
        progress,
        state: state as 'running' | 'validating' | 'provisioning',
        code: safeCode(event.code),
        message: `STRUM is processing ${stage.replaceAll('_', ' ')} locally.`
      })
    } catch {
      // Human diagnostics never cross into renderer state.
    }
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    if (finished || protocolFailed || terminal) return
    remainder += chunk.toString('utf8')
    const lines = remainder.split(/\r?\n/)
    remainder = lines.pop() ?? ''
    // Bound malformed or unterminated output from a worker.
    if (remainder.length > 1_048_576 || lines.some((line) => line.length > 1_048_576)) {
      protocolFailed = true
      remainder = ''
      signalTrainingProcessTree(child, true)
      return
    }
    for (const line of lines) consumeLine(line)
  })
  // stderr is diagnostic only, never a second event stream.
  child.stderr?.on('data', () => undefined)
  child.once('error', () => {
    protocolFailed = true
    // Node emits close after error, including spawn failures. Cleanup waits for it.
  })
  child.once('close', (code: number | null) => {
    job.exited = true
    if (remainder.trim()) consumeLine(remainder)
    void finish(code).finally(() => runningJobs.delete(jobId))
  })
}

export async function startTrainingPrepare(options: {
  catalogRoot: string
  catalogId: string
  catalogName: string
  pipelineId: string
  prepare: Record<string, unknown>
}): Promise<{ jobId: string; taskViewId: string }> {
  const pipeline = await resolveTrainingPipeline(options.pipelineId)
  const prepare = sanitizeTrainingSchemaValues(pipeline.prepare_schema, options.prepare, 'prepare')
  const jobId = randomUUID()
  const taskViewId = `task-${randomUUID()}`
  // Some pipelines write one manifest; others write a directory containing
  // a manifest plus paired data. Resolve STRUM's declared output after exit.
  const taskRoot = join(trainingRoot(), 'tasks', `${taskViewId}.json`)
  await mkdir(join(trainingRoot(), 'tasks'), { recursive: true })
  await startJsonEventJob(
    jobId,
    ['dataset', 'prepare'],
    {
      catalog_root: options.catalogRoot,
      pipeline_id: options.pipelineId,
      output: taskRoot,
      options: prepare
    },
    async (result) => {
      const workerTaskViewId = result.task_view_id
      const recordCount = result.record_count
      if (
        result.status !== 'prepared' ||
        result.pipeline_id !== options.pipelineId ||
        !isSafeContractToken(workerTaskViewId) ||
        typeof recordCount !== 'number' ||
        !Number.isSafeInteger(recordCount) ||
        recordCount < 0 ||
        !isSafeContractToken(result.output_name)
      ) {
        throw new Error('STRUM returned an invalid prepared task result.')
      }
      const ownedTasksRoot = await realpath(join(trainingRoot(), 'tasks'))
      const producedRoot = await realpath(taskRoot)
      if (!isContainedPath(ownedTasksRoot, producedRoot))
        throw new Error('Task output escaped OCTAVE storage.')
      const outputInfo = await stat(producedRoot)
      const manifestPath = outputInfo.isDirectory()
        ? await realpath(join(producedRoot, result.output_name))
        : producedRoot
      if (
        (!outputInfo.isDirectory() && basename(producedRoot) !== result.output_name) ||
        (outputInfo.isDirectory() && !isContainedPath(producedRoot, manifestPath)) ||
        !(await stat(manifestPath)).isFile()
      )
        throw new Error('STRUM returned an invalid task manifest location.')
      const task: TrainingRegistry['tasks'][number] = {
        taskViewId,
        catalogId: options.catalogId,
        catalogName: options.catalogName,
        pipelineId: options.pipelineId,
        eligibleCount: recordCount,
        // This is STRUM's path-free task-view identity, retained under the
        // historical public field name for the existing renderer.
        contentHash: workerTaskViewId,
        createdAt: new Date().toISOString(),
        taskRoot: manifestPath,
        taskManifestSha256: (await fingerprintPreparedTaskFile(manifestPath)).sha256,
        ...(outputInfo.isDirectory()
          ? { taskTree: await fingerprintPreparedTaskTree(producedRoot) }
          : {}),
        catalogRoot: options.catalogRoot
      }
      await updateRegistry((registry) => {
        registry.tasks = [
          ...registry.tasks.filter((entry) => entry.taskViewId !== taskViewId),
          task
        ]
      })
      return { taskViewId, eligibleCount: task.eligibleCount, contentHash: task.contentHash }
    }
  )
  return { jobId, taskViewId }
}

export async function startTrainingRun(options: {
  taskViewId: string
  pipelineId: string
  train: Record<string, unknown>
}): Promise<{ jobId: string; runId: string }> {
  const registry = await readRegistry()
  const task = registry.tasks.find(
    (entry) =>
      entry.taskViewId === options.taskViewId &&
      existsSync(entry.taskRoot) &&
      typeof entry.catalogRoot === 'string' &&
      existsSync(entry.catalogRoot)
  )
  if (!task) throw new Error('Select a prepared task view before training.')
  try {
    const ownedTasksRoot = await realpath(join(trainingRoot(), 'tasks'))
    if (
      (await realpath(task.taskRoot)) !== task.taskRoot ||
      !isContainedPath(ownedTasksRoot, task.taskRoot) ||
      !task.taskManifestSha256 ||
      (await fingerprintPreparedTaskFile(task.taskRoot)).sha256 !== task.taskManifestSha256 ||
      (dirname(task.taskRoot) !== ownedTasksRoot && !task.taskTree)
    )
      throw new Error('Prepared task identity changed.')
    if (
      task.taskTree &&
      (!isContainedPath(ownedTasksRoot, task.taskTree.root) ||
        !isContainedPath(task.taskTree.root, task.taskRoot) ||
        JSON.stringify(await fingerprintPreparedTaskTree(task.taskTree.root)) !==
          JSON.stringify(task.taskTree))
    )
      throw new Error('Prepared task directory changed.')
  } catch {
    throw new Error(
      'The prepared task changed or predates manifest verification. Prepare a new task view.'
    )
  }
  if (task.pipelineId !== options.pipelineId) {
    throw new Error('The selected task view belongs to a different training pipeline.')
  }
  const pipeline = await resolveTrainingPipeline(options.pipelineId)
  if (!pipeline.train_schema) throw new Error('This STRUM pipeline has no training schema.')
  const train = sanitizeTrainingSchemaValues(pipeline.train_schema, options.train, 'train')
  const privateFields = pipeline.private_request_fields ?? []
  if (privateFields.some((field) => !['catalog_root', 'parent_bundle'].includes(field))) {
    throw new Error('This STRUM pipeline requires unsupported private training inputs.')
  }
  const privateInputs: Record<string, string> = {}
  if (privateFields.includes('catalog_root')) privateInputs.catalog_root = task.catalogRoot
  if (train.checkpoint_mode === 'fine_tune') {
    if (!privateFields.includes('parent_bundle') || typeof train.parent_artifact_id !== 'string') {
      throw new Error('Select a registered parent candidate before fine-tuning.')
    }
    const parent = await resolveCandidateBinding(train.parent_artifact_id)
    if (parent.run.pipelineId !== options.pipelineId) {
      throw new Error('The parent candidate belongs to a different STRUM pipeline.')
    }
    privateInputs.parent_bundle = parent.binding.bundleRoot
  } else if (train.parent_artifact_id !== undefined) {
    throw new Error('A parent candidate requires fine-tune mode.')
  }
  const jobId = randomUUID()
  const runId = `run-${randomUUID()}`
  const outputRoot = join(trainingRoot(), 'runs', runId)
  await mkdir(join(trainingRoot(), 'runs'), { recursive: true })
  await startJsonEventJob(
    jobId,
    ['train', 'start'],
    {
      pipeline_id: options.pipelineId,
      task_view: task.taskRoot,
      ...privateInputs,
      output: outputRoot,
      options: train
    },
    async (result) => {
      const bundleName = result.bundle_name
      if (
        result.status !== 'completed' ||
        result.pipeline_id !== options.pipelineId ||
        !isSafeContractToken(bundleName) ||
        !/^[a-f0-9]{64}$/.test(String(result.manifest_sha256 ?? '')) ||
        !Array.isArray(result.components)
      ) {
        throw new Error('STRUM returned an invalid training result.')
      }
      const bundleRoot = await resolveTrainingBundleRoot(outputRoot, bundleName)
      const inspection = normalizeDiscoveredCheckpoint(
        await runWorkerJson(['checkpoint', 'inspect', '--model-root', bundleRoot, '--json'])
      )
      if (
        !inspection ||
        inspection.manifestSha256 !== result.manifest_sha256 ||
        inspection.components.length !== result.components.length
      ) {
        throw new Error('STRUM could not re-inspect the trained candidate.')
      }
      const run: TrainingRun & {
        outputRoot: string
        candidateBinding: {
          artifactId: string
          bundleRoot: string
          taskView: string
          catalogRoot: string
        }
      } = {
        runId,
        taskViewId: task.taskViewId,
        pipelineId: options.pipelineId,
        checkpointCount: inspection.components.length,
        deployable: inspection.deploymentStatus === 'ready',
        checkpointManifestHash: inspection.manifestSha256,
        artifactId: inspection.artifactId,
        createdAt: new Date().toISOString(),
        outputRoot,
        candidateBinding: {
          artifactId: inspection.artifactId,
          bundleRoot,
          taskView: task.taskRoot,
          catalogRoot: task.catalogRoot
        }
      }
      await updateRegistry((current) => {
        current.runs = [...current.runs.filter((entry) => entry.runId !== runId), run]
      })
      return {
        runId,
        artifactId: run.artifactId,
        checkpointCount: run.checkpointCount,
        deployable: run.deployable
      }
    },
    runId
  )
  return { jobId, runId }
}

export async function cancelTrainingJob(jobId: string): Promise<boolean> {
  const job = runningJobs.get(jobId)
  if (!job || job.exited) return false
  if (job.cancelling) return true
  job.cancelling = true
  job.sequence += 1
  broadcast({
    jobId,
    sequence: job.sequence,
    stage: 'cancelling',
    state: 'cancelling',
    message: 'Cancelling STRUM and its local child processes…'
  })
  signalTrainingProcessTree(job.process, false)
  job.cancellationTimer = setTimeout(() => {
    if (runningJobs.get(jobId) === job) signalTrainingProcessTree(job.process, true)
  }, 5_000)
  job.cancellationTimer.unref()
  return true
}

export function killAllTrainingJobs(): void {
  for (const [runId, job] of runningProfiledAutoCharts) {
    void cancelDefaultAutoChartProfile(runId)
    if (job.process) signalTrainingProcessTree(job.process, true)
  }
  for (const [jobId, job] of runningJobs) {
    void cancelTrainingJob(jobId)
    // App shutdown cannot rely on an unref'ed grace timer firing later.
    signalTrainingProcessTree(job.process, true)
  }
}
