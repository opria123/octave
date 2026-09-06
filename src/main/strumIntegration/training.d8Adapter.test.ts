import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const scratch = mkdtempSync(join(tmpdir(), 'octave-strum-d8-adapter-'))
const sends: Array<Record<string, unknown>> = []
const requests: Array<Record<string, unknown>> = []
const workerCommands: string[][] = []
const workerInvocations: Array<{ command: string; args: string[] }> = []
const workerExecOptions: Array<{ timeout?: number }> = []
let catalogInspectionPayload: Record<string, unknown> = {
  status: 'ready',
  catalog_id: 'approved_catalog',
  record_count: 3,
  allowed_record_count: 2,
  pipeline_id: 'chart_transform.five_lane/v1',
  eligible_count: 2,
  exclusion_reason_counts: { audio_unavailable: 1 },
  audio_policy: { kind: 'not_required', required: false },
  estimated_storage_bytes: 12,
  storage_estimate_capped: false,
  storage_estimate_semantics: 'distinct approved assets',
  eligibility_selection: { mode: 'requested_prepare_options' }
}
let promotionResultOverride: Record<string, unknown> | undefined
let selectedCheckpointFolder = ''
let selectedDeveloperRoot = ''
let selectedInstalledWorker = ''
let delayProbeResponse = false
let holdBundledPythonResolution = false
let releaseBundledPythonResolution: (() => void) | null = null
let bundledPythonResolutionRequested: (() => void) | null = null
let delayedInstalledFingerprintPath = ''
let releaseInstalledFingerprint: (() => void) | null = null
let installedFingerprintRequested: (() => void) | null = null
let probePayload: Record<string, unknown> = {
  protocol_version: '1.0',
  runtime_id: 'd8-test',
  capabilities: [
    'dataset_prepare',
    'training_start',
    'post_train_job_discovery',
    'post_train_job_start'
  ]
}
let holdWorkerClose = false
let workerExitCode = 0
let terminalOnStderr = false
let spawnedWorker: EventEmitter | undefined
let directTrainingBundle = false
let directoryTaskOutput = false
let escapedTaskManifest = false
let trainingBundleRoot = ''
let trainingBundleEscapesRun = false
const originalStrumSourceDir = process.env.OCTAVE_STRUM_SOURCE_DIR
const manifestSha = 'a'.repeat(64)
const artifactId = `strum-model-bundle/${'b'.repeat(64)}`

const pipeline = {
  id: 'chart_transform.five_lane/v1',
  display_name: 'Five-lane transform',
  kind: 'chart_to_chart',
  version: 1,
  status: 'catalog_ready',
  preparation_status: 'available',
  training_status: 'available',
  catalog_requirements: { instruments: ['guitar'], source_difficulty: 'expert' },
  prepare_schema: {
    type: 'object',
    properties: {
      instrument: { type: 'string', enum: ['guitar'] },
      target_difficulty: { type: 'string', enum: ['Hard'] },
      calibration_fraction: { type: 'number', default: 0.1, exclusiveMinimum: 0 }
    },
    required: ['instrument', 'target_difficulty']
  },
  train_schema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      epochs: { type: 'integer', default: 3 },
      checkpoint_mode: { type: 'string', enum: ['fresh', 'fine_tune'] },
      parent_artifact_id: { type: 'string' }
    },
    required: ['model_id']
  },
  checkpoint_outputs: ['chart_transform'],
  inference_capability: 'difficulty.transform/v1',
  private_request_fields: ['catalog_root', 'parent_bundle'],
  catalog_inspection_option_keys: ['instrument', 'target_difficulty'],
  training_requirements: ['source_disjoint_train_calibration_test/v2'],
  promotion_jobs: [
    {
      id: 'chart-transform.profile-evaluate/v1',
      display_name: 'Evaluate',
      kind: 'evaluation',
      status: 'available',
      options_schema: { type: 'object', properties: {}, required: [] },
      private_request_fields: ['bundle_root', 'dataset_manifest', 'output'],
      optional_private_request_fields: ['catalog_root'],
      output_kind: 'evaluation_report',
      deployment_scope: 'evaluation_evidence_only'
    },
    {
      id: 'chart-transform.profile-package/v1',
      display_name: 'Package',
      kind: 'package',
      status: 'available',
      options_schema: {
        type: 'object',
        properties: { profile_id: { type: 'string', enum: ['hard'] } },
        required: ['profile_id']
      },
      private_request_fields: ['experiment', 'evaluation', 'dataset_manifest', 'output'],
      optional_private_request_fields: ['catalog_root'],
      output_kind: 'profile_bundle',
      deployment_scope: 'deployable_after_profile_validation'
    }
  ]
}

function candidate(): Record<string, unknown> {
  return {
    artifact_id: artifactId,
    model_id: 'five-lane-hard',
    manifest_sha256: manifestSha,
    schema_version: 1,
    compatibility: { manifest_schema: 1, strum_version: '>=1.0.0' },
    components: [{ id: 'chart_transform', sha256: 'c'.repeat(64), byte_length: 42 }],
    profiles: [],
    rejected_profile_count: 0,
    deployment_status: 'not_deployable'
  }
}

vi.mock('electron', () => ({
  app: { getPath: () => scratch, isPackaged: false },
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (_channel: string, payload: Record<string, unknown>) => sends.push(payload)
        }
      }
    ]
  },
  dialog: {
    showOpenDialog: async (options: { title?: string }) => {
      if (options.title === 'Select a compatible STRUM worker') {
        return selectedInstalledWorker
          ? { canceled: false, filePaths: [selectedInstalledWorker] }
          : { canceled: true, filePaths: [] }
      }
      if (options.title === 'Select a STRUM checkout with its versioned worker') {
        return selectedDeveloperRoot
          ? { canceled: false, filePaths: [selectedDeveloperRoot] }
          : { canceled: true, filePaths: [] }
      }
      return selectedCheckpointFolder
        ? { canceled: false, filePaths: [selectedCheckpointFolder] }
        : { canceled: true, filePaths: [] }
    }
  }
}))

vi.mock('fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs/promises')>()
  return {
    ...original,
    stat: async (path: string) => {
      if (path === delayedInstalledFingerprintPath) {
        installedFingerprintRequested?.()
        await new Promise<void>((resolve) => {
          releaseInstalledFingerprint = resolve
        })
      }
      return await original.stat(path)
    }
  }
})

vi.mock('./runner', () => ({
  resolvePythonCommand: async (purpose: string) => {
    if (holdBundledPythonResolution && purpose === 'training-probe') {
      bundledPythonResolutionRequested?.()
      await new Promise<void>((resolve) => {
        releaseBundledPythonResolution = resolve
      })
    }
    return { command: 'strum-test-worker', baseArgs: [] }
  }
}))

vi.mock('child_process', () => ({
  execFile: (
    command: string,
    args: string[],
    options: { timeout?: number },
    callback: (error: Error | null, stdout: string) => void
  ) => {
    workerCommands.push(args)
    workerInvocations.push({ command, args })
    workerExecOptions.push(options)
    if (args.includes('probe')) {
      const respond = (): void => callback(null, `${JSON.stringify(probePayload)}\n`)
      if (delayProbeResponse) setTimeout(respond, 20)
      else respond()
      return
    }
    if (args.includes('pipeline') && args.includes('list')) {
      callback(null, `${JSON.stringify({ pipelines: [pipeline] })}\n`)
      return
    }
    if (args.includes('catalog') && args.includes('inspect')) {
      callback(null, `${JSON.stringify(catalogInspectionPayload)}\n`)
      return
    }
    if (args.includes('checkpoint') && args.includes('inspect')) {
      const modelRoot = args[args.indexOf('--model-root') + 1]
      if (
        trainingBundleRoot &&
        modelRoot.startsWith(join(scratch, 'strum-training', 'runs')) &&
        modelRoot !== trainingBundleRoot
      ) {
        callback(null, `${JSON.stringify({ status: 'invalid', code: 'model_bundle_invalid' })}\n`)
        return
      }
      callback(null, `${JSON.stringify(candidate())}\n`)
      return
    }
    if (args.includes('checkpoint') && args.includes('discover')) {
      callback(
        null,
        `${JSON.stringify({
          format: 'strum-model-bundle-discovery/v1',
          status: 'ready',
          candidate_count: 1,
          profile_count: 0,
          rejected_bundle_count: 0,
          truncated: false,
          candidates: [candidate()]
        })}\n`
      )
      return
    }
    callback(new Error('unexpected STRUM request'), '')
  },
  spawn: (_command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      pid: number
      kill: () => boolean
    }
    spawnedWorker = child
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 123
    child.kill = () => true
    const requestPath = args[args.indexOf('--request') + 1]
    queueMicrotask(() => {
      const request = JSON.parse(readFileSync(requestPath, 'utf8')) as Record<string, unknown>
      requests.push(request)
      const output = request.output as string
      const isPromotion = args.includes('promotion')
      if (args.includes('dataset')) {
        mkdirSync(join(output, '..'), { recursive: true })
        if (directoryTaskOutput) {
          mkdirSync(output, { recursive: true })
          if (escapedTaskManifest) {
            const escaped = join(scratch, 'outside-task.json')
            writeFileSync(escaped, '{}\n')
            symlinkSync(escaped, join(output, 'task.json'))
          } else {
            writeFileSync(join(output, 'task.json'), '{}\n')
            writeFileSync(join(output, 'pairs.jsonl'), '{"target_events":[1]}\n')
          }
        } else writeFileSync(output, '{}\n')
      } else if (isPromotion && output.endsWith('.json')) {
        mkdirSync(join(output, '..'), { recursive: true })
        writeFileSync(output, '{}\n')
      } else {
        const bundleRoot =
          args.includes('train') && !directTrainingBundle ? join(output, 'bundle') : output
        if (args.includes('train')) {
          trainingBundleRoot = bundleRoot
          mkdirSync(output, { recursive: true })
          writeFileSync(join(output, 'experiment.json'), '{}\n')
        }
        if (args.includes('train') && trainingBundleEscapesRun) {
          const escapedBundle = join(scratch, 'escaped-bundle')
          mkdirSync(escapedBundle, { recursive: true })
          writeFileSync(join(escapedBundle, 'strum-model-bundle.json'), '{}\n')
          mkdirSync(output, { recursive: true })
          symlinkSync(escapedBundle, bundleRoot, 'dir')
        } else {
          mkdirSync(bundleRoot, { recursive: true })
          writeFileSync(join(bundleRoot, 'strum-model-bundle.json'), '{}\n')
        }
      }
      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({ sequence: 1, stage: 'worker_job', state: 'running', code: 'started' })}\n`
        )
      )
      const result = args.includes('dataset')
        ? {
            status: 'prepared',
            pipeline_id: pipeline.id,
            task_view_id: 'taskviewd8',
            record_count: 2,
            output_name: directoryTaskOutput ? 'task.json' : basename(output)
          }
        : isPromotion
          ? (promotionResultOverride ?? {
              schema_version: 1,
              format: 'strum-post-train-job-result/v1',
              status: 'completed',
              pipeline_id: pipeline.id,
              job_id: request.job_id,
              output_kind:
                request.job_id === 'chart-transform.profile-package/v1'
                  ? 'profile_bundle'
                  : 'evaluation_report',
              deployment_scope:
                request.job_id === 'chart-transform.profile-package/v1'
                  ? 'deployable_after_profile_validation'
                  : 'evaluation_evidence_only',
              result: { quality_gate_status: 'passed', metrics: { f1: 0.9 } }
            })
          : {
              status: 'completed',
              pipeline_id: pipeline.id,
              bundle_name: directTrainingBundle ? basename(output) : 'bundle',
              manifest_sha256: manifestSha,
              components: [{ id: 'chart_transform', sha256: 'c'.repeat(64), byte_length: 42 }]
            }
      ;(terminalOnStderr ? child.stderr : child.stdout).emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            sequence: 2,
            stage: 'worker_job',
            state: 'succeeded',
            code: 'completed',
            message: 'private diagnostic at /private/worker/output',
            result
          })}\n`
        )
      )
      if (args.includes('train')) {
        child.stdout.emit(
          'data',
          Buffer.from(
            `${JSON.stringify({
              sequence: 3,
              stage: 'worker_job',
              state: 'succeeded',
              code: 'completed',
              result
            })}\n`
          )
        )
      }
      if (!holdWorkerClose) child.emit('close', workerExitCode)
    })
    return child
  }
}))

import {
  cancelTrainingJob,
  inspectTrainingCatalog,
  inspectTrainingCheckpoint,
  listTrainingArtifacts,
  listPromotionJobs,
  chooseCheckpointFolder,
  chooseDeveloperTrainingRuntime,
  chooseInstalledTrainingRuntime,
  enableDetectedDeveloperTrainingRuntime,
  probeTrainingRuntime,
  startPromotionJob,
  startTrainingPrepare,
  startTrainingRun
} from './training'

async function settled(): Promise<void> {
  const queuedIds = new Set(
    sends.filter((event) => event.state === 'queued').map((event) => event.jobId)
  )
  await vi.waitFor(() => {
    for (const jobId of queuedIds) {
      expect(
        sends.some(
          (event) =>
            event.jobId === jobId &&
            ['succeeded', 'failed', 'cancelled'].includes(String(event.state))
        )
      ).toBe(true)
    }
  })
  // Terminal delivery follows registration, but queues its own durable summary.
  // Snapshot waits for those writes before tests inspect or replace registry files.
  // The corrupt-registry test deliberately makes this read fail after draining.
  await listTrainingArtifacts().catch(() => undefined)
}

async function workerStarted(jobId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(sends.some((event) => event.jobId === jobId && event.state === 'running')).toBe(true)
  })
}

afterEach(async () => {
  // Never remove a fixture while a completed worker still owns queued writes.
  await settled()
  vi.restoreAllMocks()
  directTrainingBundle = false
  directoryTaskOutput = false
  escapedTaskManifest = false
  holdWorkerClose = false
  workerExitCode = 0
  terminalOnStderr = false
  spawnedWorker = undefined
  sends.length = 0
  requests.length = 0
  workerCommands.length = 0
  workerInvocations.length = 0
  workerExecOptions.length = 0
  catalogInspectionPayload = {
    status: 'ready',
    catalog_id: 'approved_catalog',
    record_count: 3,
    allowed_record_count: 2,
    pipeline_id: pipeline.id,
    eligible_count: 2,
    exclusion_reason_counts: { audio_unavailable: 1 },
    audio_policy: { kind: 'not_required', required: false },
    estimated_storage_bytes: 12,
    storage_estimate_capped: false,
    storage_estimate_semantics: 'distinct approved assets',
    eligibility_selection: { mode: 'requested_prepare_options' }
  }
  promotionResultOverride = undefined
  selectedCheckpointFolder = ''
  selectedDeveloperRoot = ''
  selectedInstalledWorker = ''
  delayProbeResponse = false
  holdBundledPythonResolution = false
  releaseBundledPythonResolution = null
  bundledPythonResolutionRequested = null
  delayedInstalledFingerprintPath = ''
  releaseInstalledFingerprint = null
  installedFingerprintRequested = null
  probePayload = {
    protocol_version: '1.0',
    runtime_id: 'd8-test',
    capabilities: [
      'dataset_prepare',
      'training_start',
      'post_train_job_discovery',
      'post_train_job_start'
    ]
  }
  trainingBundleRoot = ''
  trainingBundleEscapesRun = false
  if (originalStrumSourceDir === undefined) {
    delete process.env.OCTAVE_STRUM_SOURCE_DIR
  } else {
    process.env.OCTAVE_STRUM_SOURCE_DIR = originalStrumSourceDir
  }
  rmSync(join(scratch, 'strum-training'), { recursive: true, force: true })
  rmSync(join(scratch, 'escaped-bundle'), { recursive: true, force: true })
  rmSync(join(scratch, 'post-registration-escaped-bundle'), { recursive: true, force: true })
})

describe('STRUM d8 training adapter', () => {
  const prepareFixture = async (): Promise<{ jobId: string; taskViewId: string }> => {
    const catalogRoot = join(scratch, 'lifecycle-catalog')
    mkdirSync(catalogRoot, { recursive: true })
    return await startTrainingPrepare({
      catalogRoot,
      catalogId: 'catalog',
      catalogName: 'Catalog',
      pipelineId: pipeline.id,
      prepare: { instrument: 'guitar', target_difficulty: 'Hard' }
    })
  }

  it('recovers prior unfinished jobs as safe interrupted summaries', async () => {
    mkdirSync(join(scratch, 'strum-training'), { recursive: true })
    writeFileSync(
      join(scratch, 'strum-training', 'registry.json'),
      JSON.stringify({
        tasks: [],
        runs: [],
        jobs: [
          {
            jobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            sessionId: 'prior-app',
            sequence: 4,
            state: 'running',
            stage: '/private/stage',
            message: '/private/diagnostic',
            result: { path: '/private/output' }
          }
        ]
      })
    )
    const { jobs } = await listTrainingArtifacts()
    expect(jobs).toEqual([expect.objectContaining({ state: 'failed', code: 'interrupted' })])
    expect(JSON.stringify(jobs)).not.toContain('/private/')
  })

  it('retains every artifact when preparations finish concurrently', async () => {
    const started = await Promise.all(Array.from({ length: 8 }, () => prepareFixture()))
    await settled()
    const artifacts = await listTrainingArtifacts()
    expect(artifacts.tasks.map((task) => task.taskViewId).sort()).toEqual(
      started.map((task) => task.taskViewId).sort()
    )
  })

  it('preserves a corrupt registry instead of replacing training history', async () => {
    await settled()
    mkdirSync(join(scratch, 'strum-training'), { recursive: true })
    const registryPath = join(scratch, 'strum-training', 'registry.json')
    writeFileSync(registryPath, '{incomplete history')
    await prepareFixture()
    await settled()
    expect(readFileSync(registryPath, 'utf8')).toBe('{incomplete history')
    expect(sends.at(-1)).toMatchObject({ state: 'failed', code: 'result_unavailable' })
  })

  it('waits for exit before registering success and preserves the request until exit', async () => {
    holdWorkerClose = true
    const started = await prepareFixture()
    await workerStarted(started.jobId)
    expect(sends.some((event) => event.state === 'succeeded')).toBe(false)
    expect((await listTrainingArtifacts()).tasks).toHaveLength(0)
    const requestPath = join(scratch, `octave-training-${started.jobId}.json`)
    expect(existsSync(requestPath)).toBe(true)
    spawnedWorker?.emit('close', 0)
    await expect(cancelTrainingJob(started.jobId)).resolves.toBe(false)
    await settled()
    expect((await listTrainingArtifacts()).tasks).toHaveLength(1)
    expect(existsSync(requestPath)).toBe(false)
  })

  it('rejects claimed success when the worker exits unsuccessfully', async () => {
    workerExitCode = 1
    await prepareFixture()
    await settled()
    expect((await listTrainingArtifacts()).tasks).toHaveLength(0)
    expect(sends.at(-1)).toMatchObject({ state: 'failed' })
  })

  it('does not accept a diagnostic stderr terminal as protocol success', async () => {
    terminalOnStderr = true
    await prepareFixture()
    await settled()
    expect((await listTrainingArtifacts()).tasks).toHaveLength(0)
    expect(sends.at(-1)).toMatchObject({ state: 'failed' })
  })

  it('signals the process group immediately and defers cancelled cleanup until exit', async () => {
    holdWorkerClose = true
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const started = await prepareFixture()
    await workerStarted(started.jobId)
    await expect(cancelTrainingJob(started.jobId)).resolves.toBe(true)
    expect(kill).toHaveBeenCalledWith(-123, 'SIGTERM')
    const requestPath = join(scratch, `octave-training-${started.jobId}.json`)
    expect(existsSync(requestPath)).toBe(true)
    expect(workerCommands.some((args) => args.includes('cancel'))).toBe(false)
    spawnedWorker?.emit('close', null)
    await settled()
    expect(kill).toHaveBeenCalledWith(-123, 'SIGKILL')
    expect(existsSync(requestPath)).toBe(false)
    expect((await listTrainingArtifacts()).tasks).toHaveLength(0)
    expect(sends.at(-1)).toMatchObject({ state: 'cancelled' })
  })

  it('selects and locks an explicit versioned developer checkout', async () => {
    selectedDeveloperRoot = join(scratch, 'selected-developer-runtime')
    mkdirSync(join(selectedDeveloperRoot, 'src'), { recursive: true })
    writeFileSync(join(selectedDeveloperRoot, 'src', 'worker.py'), '# worker fixture\n')

    await expect(chooseDeveloperTrainingRuntime()).resolves.toMatchObject({
      kind: 'developer_override',
      runtimeId: 'd8-test'
    })

    const stored = JSON.parse(
      readFileSync(join(scratch, 'strum-training', 'runtime.json'), 'utf8')
    ) as Record<string, unknown>
    expect(stored.developerSourceRoot).toBe(selectedDeveloperRoot)
    expect(stored).not.toHaveProperty('installedWorkerPath')
  })

  it('keeps a validated developer runtime kind in the renderer-safe runtime DTO', async () => {
    const developerRoot = join(scratch, 'developer-runtime')
    mkdirSync(join(developerRoot, 'src'), { recursive: true })
    writeFileSync(join(developerRoot, 'src', 'worker.py'), '# worker fixture\n')
    mkdirSync(join(scratch, 'strum-training'), { recursive: true })
    writeFileSync(
      join(scratch, 'strum-training', 'runtime.json'),
      JSON.stringify({
        developerSourceRoot: developerRoot,
        developerPython: { command: 'strum-test-worker', baseArgs: [] },
        developerRuntimeLock: {
          runtimeId: 'd8-test',
          protocolVersion: '1.0',
          capabilities: [
            'dataset_prepare',
            'post_train_job_discovery',
            'post_train_job_start',
            'training',
            'training_start'
          ],
          sourceRevision: null,
          dirty: false,
          validatedAt: '2026-08-24T00:00:00.000Z',
          sourceRoot: developerRoot
        }
      })
    )

    const runtime = await probeTrainingRuntime()

    expect(runtime).toMatchObject({
      runtimeId: 'd8-test',
      kind: 'developer_override',
      capabilities: expect.arrayContaining(['training'])
    })
    expect(JSON.stringify(runtime)).not.toContain(developerRoot)
    expect(JSON.stringify(runtime)).not.toMatch(/[/\\](home|tmp|run)[/\\]/)
  })

  it('fails closed on path-bearing developer probe metadata', async () => {
    const developerRoot = join(scratch, 'hostile-developer-runtime')
    mkdirSync(join(developerRoot, 'src'), { recursive: true })
    writeFileSync(join(developerRoot, 'src', 'worker.py'), '# worker fixture\n')
    process.env.OCTAVE_STRUM_SOURCE_DIR = developerRoot
    probePayload = {
      protocol_version: '1.0',
      runtime_id: 'd8-test',
      display_name: '/private/worker/name',
      capabilities: ['dataset_prepare', '/private/worker/capability'],
      pipeline_ids: ['chart_transform.five_lane/v1', '/private/worker/pipeline'],
      device_support: ['cpu', '/private/worker/device'],
      source_revision: '/private/worker/revision'
    }

    await expect(enableDetectedDeveloperTrainingRuntime()).rejects.toThrow('invalid capabilities')
  })

  it('canonicalizes STRUM’s numeric protocol and accepts its safe fallback runtime ID', async () => {
    const developerRoot = join(scratch, 'numeric-protocol-runtime')
    mkdirSync(join(developerRoot, 'src'), { recursive: true })
    writeFileSync(join(developerRoot, 'src', 'worker.py'), '# worker fixture\n')
    process.env.OCTAVE_STRUM_SOURCE_DIR = developerRoot
    probePayload = {
      protocol_version: 1,
      runtime: { id: 'strum-0.1.0+git.72ff57cd9b5a' },
      capabilities: ['dataset_prepare', 'training_start']
    }

    await expect(enableDetectedDeveloperTrainingRuntime()).resolves.toMatchObject({
      protocolVersion: '1',
      runtimeId: 'strum-0.1.0+git.72ff57cd9b5a',
      kind: 'developer_override'
    })

    for (const invalidVersion of [1.5, true, '/private/protocol']) {
      probePayload = {
        protocol_version: invalidVersion,
        runtime_id: 'd8-test',
        capabilities: ['dataset_prepare', 'training_start']
      }
      await expect(enableDetectedDeveloperTrainingRuntime()).rejects.toThrow(
        'invalid protocol version'
      )
    }
  })

  it('rejects generic, malformed, and path-bearing fallback runtime IDs', async () => {
    const developerRoot = join(scratch, 'invalid-fallback-runtime')
    mkdirSync(join(developerRoot, 'src'), { recursive: true })
    writeFileSync(join(developerRoot, 'src', 'worker.py'), '# worker fixture\n')
    process.env.OCTAVE_STRUM_SOURCE_DIR = developerRoot

    for (const runtimeId of [
      'generic-runtime',
      'strum-0.1.0+git.ABCDEF12',
      'strum-0.1.0+git.nothex',
      '/private/worker/runtime'
    ]) {
      probePayload = {
        protocol_version: 1,
        runtime: { id: runtimeId },
        capabilities: ['dataset_prepare', 'training_start']
      }
      await expect(enableDetectedDeveloperTrainingRuntime()).rejects.toThrow(
        'invalid runtime identity'
      )
    }
  })

  it('waits for a delayed activation before same-tick checkpoint discovery', async () => {
    const developerRoot = join(scratch, 'developer-runtime-for-discovery')
    const modelRoot = join(scratch, 'checkpoint-folder')
    mkdirSync(join(developerRoot, 'src'), { recursive: true })
    mkdirSync(modelRoot, { recursive: true })
    writeFileSync(join(developerRoot, 'src', 'worker.py'), '# worker fixture\n')
    writeFileSync(join(modelRoot, 'strum-model-bundle.json'), '{}\n')
    process.env.OCTAVE_STRUM_SOURCE_DIR = developerRoot
    selectedCheckpointFolder = modelRoot
    delayProbeResponse = true

    const [enabled, discovery] = await Promise.all([
      enableDetectedDeveloperTrainingRuntime(),
      chooseCheckpointFolder()
    ])

    expect(enabled).toMatchObject({ kind: 'developer_override' })
    expect(discovery).toMatchObject({ candidateCount: 1, profileCount: 0 })
    expect(
      workerCommands.some((args) => args.includes('checkpoint') && args.includes('discover'))
    ).toBe(true)
    expect(
      workerCommands.find((args) => args.includes('checkpoint') && args.includes('discover'))
    ).toEqual(expect.arrayContaining(['-m', 'src.worker']))
  })

  it('reselects the worker when activation starts after bundled selection begins', async () => {
    const developerRoot = join(scratch, 'interleaved-developer-runtime')
    const modelRoot = join(scratch, 'interleaved-checkpoint-folder')
    mkdirSync(join(developerRoot, 'src'), { recursive: true })
    mkdirSync(modelRoot, { recursive: true })
    writeFileSync(join(developerRoot, 'src', 'worker.py'), '# worker fixture\n')
    writeFileSync(join(modelRoot, 'strum-model-bundle.json'), '{}\n')
    process.env.OCTAVE_STRUM_SOURCE_DIR = developerRoot
    selectedCheckpointFolder = modelRoot
    holdBundledPythonResolution = true
    const bundledSelectionStarted = new Promise<void>((resolve) => {
      bundledPythonResolutionRequested = resolve
    })

    const discoveryPromise = chooseCheckpointFolder()
    await bundledSelectionStarted
    const enabled = await enableDetectedDeveloperTrainingRuntime()
    releaseBundledPythonResolution?.()
    const discovery = await discoveryPromise

    expect(enabled).toMatchObject({ kind: 'developer_override' })
    expect(discovery).toMatchObject({ candidateCount: 1 })
    expect(
      workerCommands.find((args) => args.includes('checkpoint') && args.includes('discover'))
    ).toEqual(expect.arrayContaining(['-m', 'src.worker']))
  })

  it('reselects installed runtime B when a worker action began fingerprinting installed runtime A', async () => {
    const workerA = join(scratch, 'installed-worker-a')
    const workerB = join(scratch, 'installed-worker-b')
    const modelRoot = join(scratch, 'installed-interleaving-checkpoint')
    writeFileSync(workerA, 'worker A\n')
    writeFileSync(workerB, 'worker B\n')
    mkdirSync(modelRoot, { recursive: true })
    writeFileSync(join(modelRoot, 'strum-model-bundle.json'), '{}\n')

    selectedInstalledWorker = workerA
    await expect(chooseInstalledTrainingRuntime()).resolves.toMatchObject({
      kind: 'installed_runtime'
    })

    selectedCheckpointFolder = modelRoot
    delayedInstalledFingerprintPath = workerA
    const fingerprintStarted = new Promise<void>((resolve) => {
      installedFingerprintRequested = resolve
    })
    const discoveryPromise = chooseCheckpointFolder()
    await fingerprintStarted

    selectedInstalledWorker = workerB
    await expect(chooseInstalledTrainingRuntime()).resolves.toMatchObject({
      kind: 'installed_runtime'
    })
    releaseInstalledFingerprint?.()
    await expect(discoveryPromise).resolves.toMatchObject({ candidateCount: 1 })

    expect(
      workerInvocations.find(
        (invocation) =>
          invocation.args.includes('checkpoint') && invocation.args.includes('discover')
      )
    ).toMatchObject({ command: workerB })
  })

  it('resolves a fine-tune parent from verified registry identity without exposing its root', async () => {
    const catalogRoot = join(scratch, 'parent-catalog')
    mkdirSync(catalogRoot, { recursive: true })
    const prepared = await startTrainingPrepare({
      catalogRoot,
      catalogId: 'parent-catalog',
      catalogName: 'Parent catalog',
      pipelineId: pipeline.id,
      prepare: { instrument: 'guitar', target_difficulty: 'Hard' }
    })
    await settled()
    const options = { taskViewId: prepared.taskViewId, pipelineId: pipeline.id }
    await startTrainingRun({ ...options, train: { model_id: 'parent' } })
    await settled()
    const parentRoot = join(String(requests[1].output), 'bundle')
    await expect(
      startTrainingRun({
        ...options,
        train: {
          model_id: 'invalid',
          checkpoint_mode: 'fine_tune',
          parent_artifact_id: '/private/unregistered'
        }
      })
    ).rejects.toThrow()
    await expect(
      startTrainingRun({
        ...options,
        train: {
          model_id: 'invalid',
          checkpoint_mode: 'fresh',
          parent_artifact_id: artifactId
        }
      })
    ).rejects.toThrow('fine-tune mode')
    await startTrainingRun({
      ...options,
      train: {
        model_id: 'child',
        checkpoint_mode: 'fine_tune',
        parent_artifact_id: artifactId
      }
    })
    await settled()
    expect(requests.at(-1)).toMatchObject({
      parent_bundle: parentRoot,
      options: {
        parent_artifact_id: artifactId,
        checkpoint_mode: 'fine_tune'
      }
    })
    expect(JSON.stringify(sends)).not.toContain(parentRoot)
  })

  it.each([false, true])(
    'trains from directory preparation with direct bundle=%s and rejects mutation',
    async (direct) => {
      directTrainingBundle = direct
      directoryTaskOutput = true
      const catalogRoot = join(scratch, 'directory-catalog')
      mkdirSync(catalogRoot, { recursive: true })
      const task = await startTrainingPrepare({
        catalogRoot,
        catalogId: 'directory',
        catalogName: 'Directory task',
        pipelineId: pipeline.id,
        prepare: { instrument: 'guitar', target_difficulty: 'Hard' }
      })
      await settled()
      const manifest = join(String(requests[0].output), 'task.json')
      await startTrainingRun({
        taskViewId: task.taskViewId,
        pipelineId: pipeline.id,
        train: { model_id: 'directory-model' }
      })
      await settled()
      expect(requests[1].task_view).toBe(manifest)
      expect((await listTrainingArtifacts()).runs).toHaveLength(1)
      expect(await listPromotionJobs(artifactId)).toHaveLength(1)
      await startPromotionJob({
        candidateArtifactId: artifactId,
        jobId: 'chart-transform.profile-evaluate/v1',
        options: {}
      })
      await settled()
      expect(requests[2].bundle_root).toBe(
        direct ? requests[1].output : join(String(requests[1].output), 'bundle')
      )
      writeFileSync(manifest, '{"modified":true}\n')
      await expect(
        startTrainingRun({
          taskViewId: task.taskViewId,
          pipelineId: pipeline.id,
          train: { model_id: 'changed-task' }
        })
      ).rejects.toThrow('Prepare a new task view')
    }
  )

  it.each(['content', 'addition', 'removal', 'symlink'])(
    'rejects prepared-directory sidecar %s changes before training',
    async (mutation) => {
      directoryTaskOutput = true
      const catalogRoot = join(scratch, 'tree-catalog')
      mkdirSync(catalogRoot, { recursive: true })
      const task = await startTrainingPrepare({
        catalogRoot,
        catalogId: 'tree',
        catalogName: 'Tree task',
        pipelineId: pipeline.id,
        prepare: { instrument: 'guitar', target_difficulty: 'Hard' }
      })
      await settled()
      const output = String(requests[0].output)
      const pairs = join(output, 'pairs.jsonl')
      const manifestBefore = readFileSync(join(output, 'task.json'), 'utf8')
      if (mutation === 'content') writeFileSync(pairs, '{"target_events":[2]}\n')
      else if (mutation === 'addition') writeFileSync(join(output, 'extra.jsonl'), '{}\n')
      else if (mutation === 'removal') rmSync(pairs)
      else {
        rmSync(pairs)
        const outside = join(scratch, 'outside-pairs.jsonl')
        writeFileSync(outside, '{"target_events":[1]}\n')
        symlinkSync(outside, pairs)
      }
      expect(readFileSync(join(output, 'task.json'), 'utf8')).toBe(manifestBefore)
      await expect(
        startTrainingRun({
          taskViewId: task.taskViewId,
          pipelineId: pipeline.id,
          train: { model_id: 'mutated-tree' }
        })
      ).rejects.toThrow('Prepare a new task view')
      expect(requests).toHaveLength(1)
      expect(JSON.stringify(await listTrainingArtifacts())).not.toContain(output)
    }
  )

  it('rejects a prepared directory manifest symlink escaping its output', async () => {
    directoryTaskOutput = true
    escapedTaskManifest = true
    const catalogRoot = join(scratch, 'escape-catalog')
    mkdirSync(catalogRoot, { recursive: true })
    await startTrainingPrepare({
      catalogRoot,
      catalogId: 'escape',
      catalogName: 'Escaped task',
      pipelineId: pipeline.id,
      prepare: { instrument: 'guitar', target_difficulty: 'Hard' }
    })
    await settled()
    expect((await listTrainingArtifacts()).tasks).toEqual([])
    expect(sends.at(-1)).toMatchObject({ state: 'failed', code: 'result_unavailable' })
  })

  it('registers a nested raw training bundle and keeps candidate roots private', async () => {
    const catalogRoot = join(scratch, 'private-catalog')
    mkdirSync(catalogRoot, { recursive: true })
    const inspection = await inspectTrainingCatalog(catalogRoot, pipeline.id, {
      instrument: 'guitar',
      target_difficulty: 'Hard',
      calibration_fraction: 0.1
    })
    expect(inspection).toMatchObject({
      eligibleCount: 2,
      excluded: { audio_unavailable: 1 },
      audioPolicy: { kind: 'not_required' }
    })
    expect(workerCommands.find((command) => command.includes('catalog'))).toEqual(
      expect.arrayContaining([
        '--catalog-root',
        catalogRoot,
        '--options',
        JSON.stringify({ instrument: 'guitar', target_difficulty: 'Hard' })
      ])
    )
    expect(
      workerExecOptions[workerCommands.findIndex((command) => command.includes('catalog'))]
    ).toMatchObject({ timeout: 15 * 60_000 })

    const prepared = await startTrainingPrepare({
      catalogRoot,
      catalogId: 'catalog',
      catalogName: 'Approved songs',
      pipelineId: pipeline.id,
      prepare: { instrument: 'guitar', target_difficulty: 'Hard' }
    })
    await settled()
    expect(Object.keys(requests[0]).sort()).toEqual([
      'catalog_root',
      'options',
      'output',
      'pipeline_id'
    ])
    expect(requests[0]).toMatchObject({ catalog_root: catalogRoot, pipeline_id: pipeline.id })

    await startTrainingRun({
      taskViewId: prepared.taskViewId,
      pipelineId: pipeline.id,
      train: { model_id: 'five-lane-hard' }
    })
    await settled()
    expect(Object.keys(requests[1]).sort()).toEqual([
      'catalog_root',
      'options',
      'output',
      'pipeline_id',
      'task_view'
    ])
    const artifacts = await listTrainingArtifacts()
    expect(artifacts.runs).toEqual([
      expect.objectContaining({ artifactId, checkpointManifestHash: manifestSha })
    ])
    expect(JSON.stringify(artifacts)).not.toContain(scratch)
    const trainingOutputRoot = String(requests[1].output)
    expect(workerCommands).toContainEqual(
      expect.arrayContaining([
        'checkpoint',
        'inspect',
        '--model-root',
        join(trainingOutputRoot, 'bundle')
      ])
    )
    expect(workerCommands).not.toContainEqual(
      expect.arrayContaining(['checkpoint', 'inspect', '--model-root', trainingOutputRoot])
    )
    expect(sends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'running', code: 'started' }),
        expect.objectContaining({ state: 'succeeded', message: 'Completed locally.' })
      ])
    )
    expect(sends.filter((event) => event.state === 'succeeded')).toHaveLength(2)
    expect(existsSync(join(scratch, 'strum-training', 'registry.json'))).toBe(true)
    const registry = JSON.parse(
      readFileSync(join(scratch, 'strum-training', 'registry.json'), 'utf8')
    ) as { runs: Array<{ candidateBinding?: { bundleRoot?: string; catalogRoot?: string } }> }
    expect(registry.runs[0]?.candidateBinding).toMatchObject({
      bundleRoot: join(trainingOutputRoot, 'bundle'),
      catalogRoot
    })
    await expect(inspectTrainingCheckpoint(artifacts.runs[0].runId)).resolves.toMatchObject({
      checkpointManifestHash: manifestSha,
      deployable: false
    })
    expect(workerCommands).toContainEqual(
      expect.arrayContaining([
        'checkpoint',
        'inspect',
        '--model-root',
        join(trainingOutputRoot, 'bundle')
      ])
    )
  })

  it('does not register a terminal bundle locator that escapes the run root', async () => {
    const catalogRoot = join(scratch, 'symlink-catalog')
    mkdirSync(catalogRoot, { recursive: true })
    trainingBundleEscapesRun = true

    const prepared = await startTrainingPrepare({
      catalogRoot,
      catalogId: 'catalog',
      catalogName: 'Approved songs',
      pipelineId: pipeline.id,
      prepare: { instrument: 'guitar', target_difficulty: 'Hard' }
    })
    await settled()
    await startTrainingRun({
      taskViewId: prepared.taskViewId,
      pipelineId: pipeline.id,
      train: { model_id: 'five-lane-hard' }
    })
    await settled()

    expect((await listTrainingArtifacts()).runs).toEqual([])
    expect(
      workerCommands.some(
        (args) =>
          args.includes('checkpoint') && args.includes('inspect') && args.includes('escaped-bundle')
      )
    ).toBe(false)
  })

  it('rejects a post-registration bundle symlink swap before worker inspection', async () => {
    const catalogRoot = join(scratch, 'post-registration-symlink-catalog')
    mkdirSync(catalogRoot, { recursive: true })
    const prepared = await startTrainingPrepare({
      catalogRoot,
      catalogId: 'catalog',
      catalogName: 'Approved songs',
      pipelineId: pipeline.id,
      prepare: { instrument: 'guitar', target_difficulty: 'Hard' }
    })
    await settled()
    await startTrainingRun({
      taskViewId: prepared.taskViewId,
      pipelineId: pipeline.id,
      train: { model_id: 'five-lane-hard' }
    })
    await settled()
    const [run] = (await listTrainingArtifacts()).runs
    const outputRoot = String(requests[1].output)
    const bundleRoot = join(outputRoot, 'bundle')
    const escapedBundle = join(scratch, 'post-registration-escaped-bundle')
    rmSync(bundleRoot, { recursive: true, force: true })
    mkdirSync(escapedBundle, { recursive: true })
    writeFileSync(join(escapedBundle, 'strum-model-bundle.json'), '{}\n')
    symlinkSync(escapedBundle, bundleRoot, 'dir')
    const inspectionCount = workerCommands.length

    await expect(inspectTrainingCheckpoint(run.runId)).rejects.toThrow('outside the training run')
    expect(workerCommands.slice(inspectionCount)).toEqual([])
  })

  it('rejects malformed, wrong-pipeline, and path-bearing catalog summaries', async () => {
    const catalogRoot = join(scratch, 'strict-private-catalog')
    mkdirSync(catalogRoot, { recursive: true })
    const baseline = {
      status: 'ready',
      catalog_id: 'approved_catalog',
      record_count: 3,
      allowed_record_count: 2,
      pipeline_id: pipeline.id,
      eligible_count: 2,
      exclusion_reason_counts: { audio_unavailable: 1 },
      audio_policy: { kind: 'not_required', required: false },
      estimated_storage_bytes: 12,
      storage_estimate_capped: false,
      storage_estimate_semantics: 'distinct approved assets',
      eligibility_selection: { mode: 'requested_prepare_options' }
    }
    catalogInspectionPayload = { ...baseline, pipeline_id: 'wrong.pipeline/v1' }
    await expect(
      inspectTrainingCatalog(catalogRoot, pipeline.id, {
        instrument: 'guitar',
        target_difficulty: 'Hard'
      })
    ).rejects.toThrow('invalid catalog inspection')
    catalogInspectionPayload = {
      ...baseline,
      exclusion_reason_counts: { '/private/catalog/secret': 1 }
    }
    await expect(
      inspectTrainingCatalog(catalogRoot, pipeline.id, {
        instrument: 'guitar',
        target_difficulty: 'Hard'
      })
    ).rejects.toThrow('invalid catalog inspection')
    catalogInspectionPayload = {
      ...baseline,
      storage_estimate_semantics: 'diagnostic at /private/catalog'
    }
    await expect(
      inspectTrainingCatalog(catalogRoot, pipeline.id, {
        instrument: 'guitar',
        target_difficulty: 'Hard'
      })
    ).rejects.toThrow('invalid catalog inspection')
  })

  it('accepts the generic catalog summary shape when selection metadata is absent', async () => {
    const catalogRoot = join(scratch, 'generic-private-catalog')
    mkdirSync(catalogRoot, { recursive: true })
    const genericSummary = { ...catalogInspectionPayload }
    delete genericSummary.eligibility_selection
    catalogInspectionPayload = genericSummary

    await expect(
      inspectTrainingCatalog(catalogRoot, pipeline.id, {
        instrument: 'guitar',
        target_difficulty: 'Hard'
      })
    ).resolves.toMatchObject({ pipelineId: pipeline.id, eligibleCount: 2 })
    await startTrainingPrepare({
      catalogRoot,
      catalogId: 'generic_catalog',
      catalogName: 'Generic approved songs',
      pipelineId: pipeline.id,
      prepare: { instrument: 'guitar', target_difficulty: 'Hard' }
    })
    await settled()
    expect(requests).toHaveLength(1)
  })

  it('constructs promotion requests from the opaque candidate binding and keeps results path-free', async () => {
    const catalogRoot = join(scratch, 'promotion-private-catalog')
    mkdirSync(catalogRoot, { recursive: true })
    const prepared = await startTrainingPrepare({
      catalogRoot,
      catalogId: 'catalog',
      catalogName: 'Approved songs',
      pipelineId: pipeline.id,
      prepare: { instrument: 'guitar', target_difficulty: 'Hard' }
    })
    await settled()
    await startTrainingRun({
      taskViewId: prepared.taskViewId,
      pipelineId: pipeline.id,
      train: { model_id: 'five-lane-hard' }
    })
    await settled()

    await expect(listPromotionJobs(artifactId)).resolves.toEqual([
      expect.objectContaining({ id: 'chart-transform.profile-evaluate/v1', kind: 'evaluation' })
    ])
    await startPromotionJob({
      candidateArtifactId: artifactId,
      jobId: 'chart-transform.profile-evaluate/v1',
      options: {}
    })
    await settled()

    const evaluationRequest = requests.at(-1)
    expect(evaluationRequest).toMatchObject({
      pipeline_id: pipeline.id,
      job_id: 'chart-transform.profile-evaluate/v1',
      options: {}
    })
    expect(Object.keys(evaluationRequest ?? {}).sort()).toEqual([
      'bundle_root',
      'catalog_root',
      'dataset_manifest',
      'job_id',
      'options',
      'output',
      'pipeline_id'
    ])
    expect(JSON.stringify(sends)).not.toContain(scratch)
    expect(JSON.stringify(sends)).not.toContain('/private/worker/output')
    const completed = sends.find(
      (event) =>
        event.state === 'succeeded' &&
        (event.result as Record<string, unknown> | undefined)?.format ===
          'strum-post-train-job-result/v1'
    )
    expect(completed?.result).toMatchObject({
      promotionId: expect.stringMatching(/^promotion-/),
      candidateArtifactId: artifactId,
      result: { quality_gate_status: 'passed' }
    })

    await expect(listPromotionJobs(artifactId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'chart-transform.profile-package/v1', kind: 'package' })
      ])
    )
    await startPromotionJob({
      candidateArtifactId: artifactId,
      jobId: 'chart-transform.profile-package/v1',
      options: { profile_id: 'hard', ignored_renderer_key: '/private/ignored' }
    })
    await settled()
    const packageRequest = requests.at(-1)
    expect(packageRequest).toMatchObject({
      pipeline_id: pipeline.id,
      job_id: 'chart-transform.profile-package/v1',
      options: { profile_id: 'hard' }
    })
    expect(packageRequest?.evaluation).toEqual(evaluationRequest?.output)
    expect(packageRequest?.experiment).toBe(requests[1].output)
    expect(packageRequest?.experiment).not.toBe(evaluationRequest?.bundle_root)
    expect(existsSync(join(String(packageRequest?.experiment), 'experiment.json'))).toBe(true)
    expect(
      existsSync(join(String(packageRequest?.experiment), 'bundle', 'strum-model-bundle.json'))
    ).toBe(true)
    expect(JSON.stringify(packageRequest)).toContain(scratch)
    expect(sends.at(-1)?.result).toMatchObject({ artifactId, deploymentStatus: 'not_deployable' })
  })

  it('fails a hostile promotion terminal without publishing worker paths', async () => {
    const catalogRoot = join(scratch, 'failure-private-catalog')
    mkdirSync(catalogRoot, { recursive: true })
    const prepared = await startTrainingPrepare({
      catalogRoot,
      catalogId: 'catalog',
      catalogName: 'Approved songs',
      pipelineId: pipeline.id,
      prepare: { instrument: 'guitar', target_difficulty: 'Hard' }
    })
    await settled()
    await startTrainingRun({
      taskViewId: prepared.taskViewId,
      pipelineId: pipeline.id,
      train: { model_id: 'five-lane-hard' }
    })
    await settled()
    promotionResultOverride = {
      schema_version: 1,
      format: 'strum-post-train-job-result/v1',
      status: 'completed',
      pipeline_id: pipeline.id,
      job_id: 'chart-transform.profile-evaluate/v1',
      output_kind: 'evaluation_report',
      deployment_scope: 'evaluation_evidence_only',
      result: { diagnostic: 'failed at /private/promotion-result' }
    }

    await startPromotionJob({
      candidateArtifactId: artifactId,
      jobId: 'chart-transform.profile-evaluate/v1',
      options: {}
    })
    await settled()

    const terminal = sends.at(-1)
    expect(terminal).toMatchObject({ state: 'failed', code: 'result_unavailable' })
    expect(JSON.stringify(sends)).not.toContain('/private/promotion-result')
    expect(JSON.stringify(sends)).not.toContain(scratch)
  })
})
