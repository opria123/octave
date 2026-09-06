import { existsSync, mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeMidi } from 'midi-file'
import type { MidiData } from 'midi-file'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const scratch = mkdtempSync(join(tmpdir(), 'octave-training-profile-test-'))
const manifestA = 'a'.repeat(64)
const manifestB = 'b'.repeat(64)
const artifactA = `strum-model-bundle/${'c'.repeat(64)}`
const artifactB = `strum-model-bundle/${'d'.repeat(64)}`
const artifactC = `strum-model-bundle/${'f'.repeat(64)}`
const manifestC = 'f'.repeat(64)

type CandidateOptions = {
  artifactId: string
  manifestSha256: string
  deploymentStatus?: 'ready' | 'not_deployable'
  profile?: {
    id: string
    capability: string
    instrument: 'guitar' | 'drums'
    instruments?: ReadonlyArray<'drums' | 'guitar' | 'bass' | 'keys' | 'pro_keys' | 'pro_guitar'>
    difficultyPolicy: 'expert_only'
  }
}

function candidate({
  artifactId,
  manifestSha256,
  deploymentStatus = 'ready',
  profile = {
    id: 'guitar-hybrid-v2-rule',
    capability: 'guitar.hybrid-v2-rule/v1',
    instrument: 'guitar' as const,
    difficultyPolicy: 'expert_only' as const
  }
}: CandidateOptions): Record<string, unknown> {
  return {
    artifact_id: artifactId,
    model_id: 'catalog-guitar-v1',
    manifest_sha256: manifestSha256,
    schema_version: 1,
    compatibility: { manifest_schema: 1, strum_version: '>=1.0.0' },
    components: [{ id: 'chart_transform', sha256: 'e'.repeat(64), byte_length: 42 }],
    profiles: [
      {
        profile_id: profile.id,
        capability: profile.capability,
        instruments: profile.instruments ?? [profile.instrument],
        difficulty_policies: [profile.difficultyPolicy],
        required_components: ['chart_transform'],
        execution: {
          status: deploymentStatus === 'ready' ? 'available' : 'not_available',
          difficulty_policies: deploymentStatus === 'ready' ? [profile.difficultyPolicy] : []
        }
      }
    ],
    rejected_profile_count: 0,
    deployment_status: deploymentStatus
  }
}

const typedChartCapabilities = ['chart_preflight', 'chart_run', 'typed_chart_results']
let runtimeCapabilities = [...typedChartCapabilities]
let selectedFolder = ''
const selectedDialogPaths: string[] = []
const deferredDialogs: Array<Promise<{ canceled: boolean; filePaths: string[] }>> = []
let openedDialogs = 0
const inspections = new Map<string, Record<string, unknown>>()
const preflightRequests: Record<string, unknown>[] = []
const chartRunRequests: Record<string, unknown>[] = []
const compositionRequests: Array<{
  output: string
  profiles: Array<{ model_root: string; profile_id: string }>
}> = []
const materializedUrls: string[] = []
const materializedAudioPath = join(scratch, 'materialized-url.wav')
let preflightManifestOverride: string | null = null
let omittedMidiInstrument: string | null = null
const midiTrackNameOverrides = new Map<string, string>()
const midiNoteOverrides = new Map<string, number>()
let holdPreflight = false
let heldPreflightChild: EventEmitter | undefined
let heldPreflightRequest = ''
let compositionResultInstruments: string[] | null = null

const MIDI_TRACK_NAMES: Record<string, string[]> = {
  drums: ['PART DRUMS'],
  guitar: ['PART GUITAR'],
  bass: ['PART BASS'],
  vocals: ['PART VOCALS'],
  keys: ['PART KEYS'],
  pro_keys: ['PART REAL_KEYS_X']
}

function typedMidi(instruments: readonly string[]): Buffer {
  const tracks = instruments.flatMap((instrument) => {
    const trackName = midiTrackNameOverrides.get(instrument) ?? MIDI_TRACK_NAMES[instrument]?.[0]
    return trackName ? [{ instrument, trackName }] : []
  })
  const midi: MidiData = {
    header: { format: 1, numTracks: tracks.length, ticksPerBeat: 480 },
    tracks: tracks.map(({ instrument, trackName }) => [
      { deltaTime: 0, meta: true, type: 'trackName', text: trackName },
      {
        deltaTime: 0,
        channel: 0,
        type: 'noteOn',
        noteNumber: midiNoteOverrides.get(instrument) ?? (instrument === 'pro_keys' ? 60 : 96),
        velocity: 100
      },
      {
        deltaTime: 120,
        channel: 0,
        type: 'noteOff',
        noteNumber: midiNoteOverrides.get(instrument) ?? (instrument === 'pro_keys' ? 60 : 96),
        velocity: 0
      },
      { deltaTime: 0, meta: true, type: 'endOfTrack' }
    ])
  }
  return Buffer.from(writeMidi(midi))
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

vi.mock('electron', () => ({
  app: { getPath: () => scratch, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {
    showOpenDialog: async () => {
      openedDialogs += 1
      const deferred = deferredDialogs.shift()
      return (
        deferred ?? {
          canceled: false,
          filePaths: [selectedDialogPaths.shift() ?? selectedFolder]
        }
      )
    }
  }
}))

vi.mock('./runner', () => ({
  resolvePythonCommand: async () => ({ command: 'strum-test-worker', baseArgs: [] }),
  materializeProfileUrlAudio: async (_runId: string, url: string) => {
    materializedUrls.push(url)
    await writeFile(materializedAudioPath, 'materialized-audio')
    return { audioPath: materializedAudioPath, cleanup: async () => undefined }
  },
  cancelProfileUrlMaterialization: async () => false
}))

vi.mock('child_process', () => ({
  execFile: (
    _command: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void
  ) => {
    const modelRoot = args[args.indexOf('--model-root') + 1]
    const inspection = inspections.get(modelRoot)
    if (args.includes('probe')) {
      callback(
        null,
        `${JSON.stringify({
          protocol_version: '1.0',
          runtime_id: 'test-runtime',
          capabilities: runtimeCapabilities,
          device_support: ['cpu']
        })}\n`
      )
      return
    }
    if (args.includes('checkpoint') && args.includes('discover') && inspection) {
      callback(
        null,
        `${JSON.stringify({
          format: 'strum-model-bundle-discovery/v1',
          status: 'ready',
          candidate_count: 1,
          profile_count: 1,
          rejected_bundle_count: 0,
          truncated: false,
          candidates: [inspection]
        })}\n`
      )
      return
    }
    if (args.includes('checkpoint') && args.includes('inspect') && inspection) {
      callback(null, `${JSON.stringify(inspection)}\n`)
      return
    }
    if (args.includes('inference') && args.includes('profile') && inspection) {
      callback(
        null,
        `${JSON.stringify({
          status: 'ready',
          profile_id: args[args.indexOf('--profile') + 1],
          manifest_sha256: inspection.manifest_sha256
        })}\n`
      )
      return
    }
    if (args.includes('chart') && args.includes('preflight')) {
      const requestPath = args[args.indexOf('--request') + 1]
      void readFile(requestPath, 'utf8').then((text) => {
        const request = JSON.parse(text) as Record<string, unknown>
        preflightRequests.push(request)
        const manifestSha256 =
          preflightManifestOverride ?? inspections.get(String(request.model_root))?.manifest_sha256
        callback(
          null,
          `${JSON.stringify({
            format: 'strum-chart-preflight/v1',
            status: 'ready',
            execution: 'available',
            profile_id: request.profile_id,
            difficulty_policy: request.difficulty_policy,
            instruments: request.instruments,
            device: request.device,
            manifest_sha256: manifestSha256
          })}\n`
        )
      })
      return
    }
    callback(new Error('unexpected STRUM request'), '')
  },
  spawn: (_command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      pid: number | undefined
      kill: () => boolean
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = undefined
    child.kill = () => {
      queueMicrotask(() => child.emit('close', null))
      return true
    }
    const requestPath = args[args.indexOf('--request') + 1]
    if (args.includes('checkpoint') && args.includes('compose')) {
      void readFile(requestPath, 'utf8').then(async (text) => {
        const request = JSON.parse(text) as {
          output: string
          profiles: Array<{ model_root: string; profile_id: string }>
        }
        compositionRequests.push(request)
        const instruments = request.profiles.map((profile) => {
          const inspection = inspections.get(profile.model_root)
          const declared = inspection?.profiles?.[0] as Record<string, unknown> | undefined
          return String((declared?.instruments as string[] | undefined)?.[0])
        })
        const inspection = candidate({
          artifactId: artifactC,
          manifestSha256: manifestC,
          profile: {
            id: 'five-lane-composition',
            capability: 'five-lane.composition/v1',
            instrument: 'guitar',
            instruments: instruments as Array<'drums' | 'guitar' | 'bass' | 'keys'>,
            difficultyPolicy: 'expert_only'
          }
        })
        inspections.set(request.output, inspection)
        await mkdir(request.output, { recursive: true })
        await writeFile(join(request.output, 'strum-model-bundle.json'), '{}\n')
        child.stdout.emit(
          'data',
          Buffer.from(
            `${JSON.stringify({
              sequence: 1,
              state: 'succeeded',
              result: {
                status: 'packaged',
                profile_id: 'five-lane-composition',
                capability: 'five-lane.composition/v1',
                instruments: compositionResultInstruments ?? instruments,
                manifest_sha256: manifestC
              }
            })}\n`
          )
        )
        child.emit('close', 0)
      })
      return child
    }
    if (args.includes('chart') && args.includes('preflight')) {
      if (holdPreflight) {
        child.pid = 9876
        heldPreflightChild = child
        heldPreflightRequest = requestPath
        return child
      }
      void readFile(requestPath, 'utf8').then((text) => {
        const request = JSON.parse(text) as Record<string, unknown>
        preflightRequests.push(request)
        const manifestSha256 =
          preflightManifestOverride ?? inspections.get(String(request.model_root))?.manifest_sha256
        child.stdout.emit(
          'data',
          Buffer.from(
            `${JSON.stringify({
              format: 'strum-chart-preflight/v1',
              status: 'ready',
              execution: 'available',
              profile_id: request.profile_id,
              difficulty_policy: request.difficulty_policy,
              instruments: request.instruments,
              device: request.device,
              manifest_sha256: manifestSha256
            })}\n`
          )
        )
        child.emit('close', 0)
      })
      return child
    }
    void readFile(requestPath, 'utf8').then(async (text) => {
      const request = JSON.parse(text) as Record<string, unknown>
      chartRunRequests.push(request)
      const preflight = preflightRequests.at(-1) ?? {}
      const outputDir = String(request.output_dir)
      const manifestSha256 = inspections.get(String(preflight.model_root))?.manifest_sha256
      const instruments = Array.isArray(preflight.instruments) ? preflight.instruments : []
      const notes = typedMidi(
        instruments.filter(
          (instrument): instrument is string => instrument !== omittedMidiInstrument
        )
      )
      const notesHash = sha256(notes)
      const inspection = inspections.get(String(preflight.model_root))
      const capability = Array.isArray(inspection?.profiles)
        ? (inspection.profiles[0] as Record<string, unknown> | undefined)?.capability
        : undefined
      await mkdir(outputDir, { recursive: true })
      await writeFile(join(outputDir, 'notes.mid'), notes)
      await writeFile(
        join(outputDir, 'run.json'),
        JSON.stringify({
          format: 'strum-chart-run/v1',
          status: 'completed',
          profile_id: preflight.profile_id,
          capability:
            typeof capability === 'string'
              ? capability
              : request.source_midi_path
                ? 'difficulty.transform/v1'
                : instruments[0] === 'drums'
                  ? 'drums.v14-expert/v1'
                  : 'guitar.hybrid-v2-rule/v1',
          manifest_sha256: manifestSha256,
          artifacts: { notes_midi: { name: 'notes.mid', sha256: notesHash } },
          instrument_results: Object.fromEntries(
            instruments.map((instrument) => [instrument, { status: 'succeeded' }])
          )
        })
      )
      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            format: 'strum-chart-run/v1',
            status: 'completed',
            profile_id: preflight.profile_id,
            manifest_sha256: manifestSha256,
            run_manifest_name: 'run.json',
            output_name: 'notes.mid'
          })}\n`
        )
      )
      child.emit('close', 0)
    })
    return child
  }
}))

import {
  cancelDefaultAutoChartProfile,
  chooseCheckpointFolder,
  inspectDiscoveredCheckpoint,
  chooseAndRunTrainingTransform,
  runDefaultAutoChartProfile,
  saveDiscoveredAutoChartProfile,
  composeSavedAutoChartProfiles
} from './training'

async function addBundle(folderName: string, inspection: Record<string, unknown>): Promise<string> {
  const root = join(scratch, folderName)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'strum-model-bundle.json'), '{}\n', 'utf8')
  inspections.set(root, inspection)
  return root
}

async function registry(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(scratch, 'strum-training', 'registry.json'), 'utf8'))
}

beforeEach(async () => {
  vi.restoreAllMocks()
  heldPreflightChild = undefined
  heldPreflightRequest = ''
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  inspections.clear()
  runtimeCapabilities = [...typedChartCapabilities]
  selectedFolder = ''
  selectedDialogPaths.length = 0
  deferredDialogs.length = 0
  openedDialogs = 0
  preflightRequests.length = 0
  chartRunRequests.length = 0
  compositionRequests.length = 0
  materializedUrls.length = 0
  preflightManifestOverride = null
  omittedMidiInstrument = null
  midiTrackNameOverrides.clear()
  midiNoteOverrides.clear()
  holdPreflight = false
  compositionResultInstruments = null
})

describe('discovered STRUM profile boundaries', () => {
  it('returns a path-redacted public DTO while persisting the private root and manifest identity', async () => {
    selectedFolder = await addBundle(
      'bundle-a',
      candidate({ artifactId: artifactA, manifestSha256: manifestA })
    )
    await chooseCheckpointFolder()

    const saved = await saveDiscoveredAutoChartProfile({
      artifactId: artifactA,
      profileId: 'guitar-hybrid-v2-rule',
      difficultyPolicy: 'expert_only'
    })

    expect(saved).toEqual({
      profileId: expect.stringMatching(/^octave-strum-profile-/),
      strumProfileId: 'guitar-hybrid-v2-rule',
      artifactId: artifactA,
      difficultyPolicy: 'expert_only',
      pipelineId: 'guitar.hybrid-v2-rule/v1',
      runtimeId: 'test-runtime',
      createdAt: expect.any(String),
      isDefault: true
    })
    expect(JSON.stringify(saved)).not.toContain(selectedFolder)

    const persisted = await registry()
    expect(persisted).toMatchObject({ defaultProfileId: saved.profileId })
    expect(persisted.profiles).toMatchObject([
      { checkpointRoot: selectedFolder, artifactId: artifactA, manifestSha256: manifestA }
    ])
  })

  it('composes explicitly selected saved direct profiles without exposing their bundle roots', async () => {
    runtimeCapabilities = [...typedChartCapabilities, 'checkpoint_composition']
    const guitarRoot = await addBundle(
      'composition-guitar',
      candidate({ artifactId: artifactA, manifestSha256: manifestA })
    )
    const drumsRoot = await addBundle(
      'composition-drums',
      candidate({
        artifactId: artifactB,
        manifestSha256: manifestB,
        profile: {
          id: 'drums-v14-expert',
          capability: 'drums.v14-expert/v1',
          instrument: 'drums',
          difficultyPolicy: 'expert_only'
        }
      })
    )
    selectedDialogPaths.push(guitarRoot, drumsRoot)
    await chooseCheckpointFolder()
    const guitar = await saveDiscoveredAutoChartProfile({
      artifactId: artifactA,
      profileId: 'guitar-hybrid-v2-rule',
      difficultyPolicy: 'expert_only'
    })
    await chooseCheckpointFolder()
    const drums = await saveDiscoveredAutoChartProfile({
      artifactId: artifactB,
      profileId: 'drums-v14-expert',
      difficultyPolicy: 'expert_only'
    })

    runtimeCapabilities = ['checkpoint_composition']
    await expect(
      composeSavedAutoChartProfiles({ profileIds: [guitar.profileId, drums.profileId] })
    ).rejects.toThrow('cannot compose validated profile bundles')

    runtimeCapabilities = [...typedChartCapabilities, 'checkpoint_composition']
    await composeSavedAutoChartProfiles({ profileIds: [guitar.profileId, drums.profileId] })
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(compositionRequests).toMatchObject([
      {
        profiles: [
          { model_root: guitarRoot, profile_id: 'guitar-hybrid-v2-rule' },
          { model_root: drumsRoot, profile_id: 'drums-v14-expert' }
        ]
      }
    ])

    const persisted = await registry()
    expect(persisted.defaultProfileId).toMatch(/^octave-strum-profile-/)
    expect(persisted.profiles).toMatchObject([
      { checkpointRoot: guitarRoot },
      { checkpointRoot: drumsRoot },
      {
        strumProfileId: 'five-lane-composition',
        artifactId: artifactC,
        manifestSha256: manifestC
      }
    ])
    expect(JSON.stringify(persisted)).toContain(guitarRoot)
    expect(JSON.stringify(persisted)).not.toContain('model_root')
  })

  it('rejects a composed worker result whose instruments do not match the selected profiles', async () => {
    runtimeCapabilities = [...typedChartCapabilities, 'checkpoint_composition']
    const guitarRoot = await addBundle(
      'composition-mismatch-guitar',
      candidate({ artifactId: artifactA, manifestSha256: manifestA })
    )
    const drumsRoot = await addBundle(
      'composition-mismatch-drums',
      candidate({
        artifactId: artifactB,
        manifestSha256: manifestB,
        profile: {
          id: 'drums-v14-expert',
          capability: 'drums.v14-expert/v1',
          instrument: 'drums',
          difficultyPolicy: 'expert_only'
        }
      })
    )
    selectedDialogPaths.push(guitarRoot, drumsRoot)
    await chooseCheckpointFolder()
    const guitar = await saveDiscoveredAutoChartProfile({
      artifactId: artifactA,
      profileId: 'guitar-hybrid-v2-rule',
      difficultyPolicy: 'expert_only'
    })
    await chooseCheckpointFolder()
    const drums = await saveDiscoveredAutoChartProfile({
      artifactId: artifactB,
      profileId: 'drums-v14-expert',
      difficultyPolicy: 'expert_only'
    })

    compositionResultInstruments = ['guitar']
    await composeSavedAutoChartProfiles({ profileIds: [guitar.profileId, drums.profileId] })
    await new Promise((resolve) => setTimeout(resolve, 25))

    const persisted = await registry()
    expect(persisted.defaultProfileId).toBe(drums.profileId)
    expect(persisted.profiles).toHaveLength(2)
    expect(compositionRequests).toMatchObject([
      {
        profiles: [
          { model_root: guitarRoot, profile_id: 'guitar-hybrid-v2-rule' },
          { model_root: drumsRoot, profile_id: 'drums-v14-expert' }
        ]
      }
    ])
  })

  it.each(['chart_preflight', 'chart_run', 'typed_chart_results', 'legacy-chart-only'])(
    'rejects saving a default when typed capability %s is unavailable',
    async (missing) => {
      selectedFolder = await addBundle(
        'incomplete-runtime',
        candidate({
          artifactId: artifactA,
          manifestSha256: manifestA
        })
      )
      await chooseCheckpointFolder()
      runtimeCapabilities =
        missing === 'legacy-chart-only'
          ? ['chart']
          : typedChartCapabilities.filter((capability) => capability !== missing)
      await expect(
        saveDiscoveredAutoChartProfile({
          artifactId: artifactA,
          profileId: 'guitar-hybrid-v2-rule',
          difficultyPolicy: 'expert_only'
        })
      ).rejects.toThrow('cannot run deployed Auto Chart profiles')
      await expect(registry()).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it.each(typedChartCapabilities)(
    'invalidates a saved default when runtime loses %s',
    async (missing) => {
      selectedFolder = await addBundle(
        'runtime-capability-change',
        candidate({
          artifactId: artifactA,
          manifestSha256: manifestA
        })
      )
      await chooseCheckpointFolder()
      await saveDiscoveredAutoChartProfile({
        artifactId: artifactA,
        profileId: 'guitar-hybrid-v2-rule',
        difficultyPolicy: 'expert_only'
      })
      runtimeCapabilities = typedChartCapabilities.filter((capability) => capability !== missing)
      await expect(
        runDefaultAutoChartProfile({
          runId: 'runtime-capability-loss',
          outputDir: join(scratch, 'output'),
          files: [],
          folders: [],
          stemFolders: [],
          urls: []
        })
      ).resolves.toBeNull()
      expect((await registry()).defaultProfileId).toBeUndefined()
      expect(chartRunRequests).toHaveLength(0)
    }
  )

  it('clears artifact bindings from the previous folder selection', async () => {
    selectedFolder = await addBundle(
      'bundle-a',
      candidate({ artifactId: artifactA, manifestSha256: manifestA })
    )
    await chooseCheckpointFolder()
    selectedFolder = await addBundle(
      'bundle-b',
      candidate({ artifactId: artifactB, manifestSha256: manifestB })
    )
    await chooseCheckpointFolder()

    await expect(inspectDiscoveredCheckpoint(artifactA)).rejects.toThrow(
      /Select the checkpoint folder again/
    )
    await expect(inspectDiscoveredCheckpoint(artifactB)).resolves.toMatchObject({
      artifactId: artifactB,
      manifestSha256: manifestB
    })
  })

  it('clears a saved default when its manifest no longer matches re-inspection', async () => {
    const root = await addBundle(
      'bundle-a',
      candidate({ artifactId: artifactA, manifestSha256: manifestA })
    )
    selectedFolder = root
    await chooseCheckpointFolder()
    await saveDiscoveredAutoChartProfile({
      artifactId: artifactA,
      profileId: 'guitar-hybrid-v2-rule',
      difficultyPolicy: 'expert_only'
    })
    inspections.set(root, candidate({ artifactId: artifactA, manifestSha256: manifestB }))

    await expect(
      runDefaultAutoChartProfile({
        runId: 'run-1',
        outputDir: join(scratch, 'output'),
        files: [],
        folders: [],
        stemFolders: [],
        urls: []
      })
    ).resolves.toBeNull()

    const persisted = await registry()
    expect(persisted).not.toHaveProperty('defaultProfileId')
    expect(persisted.profiles).toEqual([])
  })

  it('clears a saved default when its registered root becomes a symlink', async () => {
    const root = await addBundle(
      'bundle-a',
      candidate({ artifactId: artifactA, manifestSha256: manifestA })
    )
    const replacement = await addBundle(
      'bundle-replacement',
      candidate({ artifactId: artifactA, manifestSha256: manifestA })
    )
    selectedFolder = root
    await chooseCheckpointFolder()
    await saveDiscoveredAutoChartProfile({
      artifactId: artifactA,
      profileId: 'guitar-hybrid-v2-rule',
      difficultyPolicy: 'expert_only'
    })
    await rm(root, { recursive: true, force: true })
    await symlink(replacement, root, 'dir')

    await expect(
      runDefaultAutoChartProfile({
        runId: 'symlinked-default',
        outputDir: join(scratch, 'output'),
        files: [],
        folders: [],
        stemFolders: [],
        urls: []
      })
    ).resolves.toBeNull()

    const persisted = await registry()
    expect(persisted).not.toHaveProperty('defaultProfileId')
    expect(persisted.profiles).toEqual([])
  })

  it('rejects non-deployable bundle profiles before saving a default', async () => {
    selectedFolder = await addBundle(
      'bundle-not-deployable',
      candidate({
        artifactId: artifactA,
        manifestSha256: manifestA,
        deploymentStatus: 'not_deployable'
      })
    )
    await chooseCheckpointFolder()

    await expect(
      saveDiscoveredAutoChartProfile({
        artifactId: artifactA,
        profileId: 'guitar-hybrid-v2-rule',
        difficultyPolicy: 'expert_only'
      })
    ).rejects.toThrow(/no executable STRUM Auto Chart profile/)
  })

  it('rejects a deployable profile that the Auto Chart GUI cannot select', async () => {
    selectedFolder = await addBundle(
      'pro-guitar-bundle',
      candidate({
        artifactId: artifactA,
        manifestSha256: manifestA,
        profile: {
          id: 'pro-guitar',
          capability: 'pro.guitar/v1',
          instrument: 'guitar',
          instruments: ['pro_guitar'],
          difficultyPolicy: 'expert_only'
        }
      })
    )
    await chooseCheckpointFolder()
    await expect(
      saveDiscoveredAutoChartProfile({
        artifactId: artifactA,
        profileId: 'pro-guitar',
        difficultyPolicy: 'expert_only'
      })
    ).rejects.toThrow('cannot select')
  })

  it('rejects path-bearing compatibility metadata before checkpoint discovery reaches IPC', async () => {
    const inspection = candidate({ artifactId: artifactA, manifestSha256: manifestA })
    inspection.compatibility = {
      manifest_schema: 1,
      strum_version: '>=1.0.0',
      strum_revision: 'source:/private/bundle'
    }
    selectedFolder = await addBundle('bundle-path-metadata', inspection)
    await expect(chooseCheckpointFolder()).rejects.toThrow('valid checkpoint discovery response')
  })

  it('preserves a null STRUM dirty-state as an unknown, safe compatibility value', async () => {
    const inspection = candidate({ artifactId: artifactA, manifestSha256: manifestA })
    inspection.compatibility = {
      manifest_schema: 1,
      strum_version: '>=1.0.0',
      strum_source_dirty: null
    }
    selectedFolder = await addBundle('bundle-unknown-dirty-state', inspection)
    await expect(chooseCheckpointFolder()).resolves.toMatchObject({
      candidates: [
        expect.objectContaining({
          compatibility: expect.objectContaining({ strum_source_dirty: null })
        })
      ]
    })
  })

  it.each([
    {
      name: 'Guitar',
      profile: {
        id: 'guitar-hybrid-v2-rule',
        capability: 'guitar.hybrid-v2-rule/v1',
        instrument: 'guitar' as const,
        difficultyPolicy: 'expert_only' as const
      }
    },
    {
      name: 'Drums',
      profile: {
        id: 'drums-v14-expert',
        capability: 'drums.v14-expert/v1',
        instrument: 'drums' as const,
        difficultyPolicy: 'expert_only' as const
      }
    }
  ])(
    'runs $name through the current STRUM preflight and typed chart-result boundary',
    async ({ profile }) => {
      selectedFolder = await addBundle(
        `bundle-${profile.instrument}`,
        candidate({ artifactId: artifactA, manifestSha256: manifestA, profile })
      )
      const audioPath = join(scratch, `${profile.instrument}.wav`)
      const outputDir = join(scratch, `${profile.instrument}-output`)
      await writeFile(audioPath, 'local-audio')
      await chooseCheckpointFolder()
      await saveDiscoveredAutoChartProfile({
        artifactId: artifactA,
        profileId: profile.id,
        difficultyPolicy: profile.difficultyPolicy
      })

      await expect(
        runDefaultAutoChartProfile({
          runId: `run-${profile.instrument}`,
          outputDir,
          files: [audioPath],
          folders: [],
          stemFolders: [],
          urls: []
        })
      ).resolves.toMatchObject({
        success: true,
        outputDir,
        songFolders: [],
        errors: [],
        typedArtifacts: {
          format: 'strum-typed-chart-artifacts/v1',
          profileId: profile.id,
          capability: profile.capability,
          manifestSha256: manifestA,
          artifacts: [
            {
              id: 'notes_midi',
              name: 'notes.mid',
              sha256: sha256(typedMidi([profile.instrument]))
            },
            { id: 'run_manifest', name: 'run.json', sha256: expect.any(String) }
          ]
        }
      })

      expect(preflightRequests).toEqual([
        {
          model_root: selectedFolder,
          profile_id: profile.id,
          difficulty_policy: 'expert_only',
          instruments: [profile.instrument],
          device: 'cpu'
        }
      ])
      expect(chartRunRequests).toHaveLength(1)
      expect(chartRunRequests[0]).toMatchObject({
        audio_path: audioPath,
        output_dir: outputDir,
        preflight_request: expect.stringMatching(/-preflight\.json$/)
      })
      expect(JSON.stringify(chartRunRequests[0])).not.toContain(selectedFolder)
    }
  )

  it('forwards the exact user-selected composition tracks in declared profile order', async () => {
    const profile = {
      id: 'five-lane-composition',
      capability: 'five-lane.composition/v1',
      instrument: 'guitar' as const,
      instruments: ['drums', 'guitar', 'bass', 'keys'] as const,
      difficultyPolicy: 'expert_only' as const
    }
    selectedFolder = await addBundle(
      'composition-bundle',
      candidate({ artifactId: artifactA, manifestSha256: manifestA, profile })
    )
    const audioPath = join(scratch, 'composition.wav')
    const outputDir = join(scratch, 'composition-output')
    await writeFile(audioPath, 'local-audio')
    await chooseCheckpointFolder()
    await saveDiscoveredAutoChartProfile({
      artifactId: artifactA,
      profileId: profile.id,
      difficultyPolicy: profile.difficultyPolicy
    })

    await expect(
      runDefaultAutoChartProfile({
        runId: 'composition-selection',
        outputDir,
        files: [audioPath],
        folders: [],
        stemFolders: [],
        urls: [],
        enabledTracks: {
          drums: false,
          guitar: true,
          bass: false,
          vocals: false,
          harmonies: false,
          keys: true,
          proKeys: false
        }
      })
    ).resolves.toMatchObject({ success: true, outputDir })

    expect(preflightRequests).toEqual([
      expect.objectContaining({ instruments: ['guitar', 'keys'] })
    ])
    expect(chartRunRequests).toHaveLength(1)
    await expect(readFile(join(outputDir, 'song.ini'), 'utf8')).resolves.toContain(
      'strum_generated = true'
    )
  })

  it('rejects unsupported or empty typed profile selections before preflight', async () => {
    const profile = {
      id: 'five-lane-composition',
      capability: 'five-lane.composition/v1',
      instrument: 'guitar' as const,
      instruments: ['guitar', 'bass'] as const,
      difficultyPolicy: 'expert_only' as const
    }
    selectedFolder = await addBundle(
      'composition-selection-errors',
      candidate({ artifactId: artifactA, manifestSha256: manifestA, profile })
    )
    const audioPath = join(scratch, 'selection-errors.wav')
    await writeFile(audioPath, 'local-audio')
    await chooseCheckpointFolder()
    await saveDiscoveredAutoChartProfile({
      artifactId: artifactA,
      profileId: profile.id,
      difficultyPolicy: profile.difficultyPolicy
    })

    await expect(
      runDefaultAutoChartProfile({
        runId: 'unsupported-selection',
        outputDir: join(scratch, 'unsupported-selection-output'),
        files: [audioPath],
        folders: [],
        stemFolders: [],
        urls: [],
        enabledTracks: {
          drums: false,
          guitar: true,
          bass: false,
          vocals: true,
          harmonies: false,
          keys: false,
          proKeys: false
        }
      })
    ).rejects.toThrow('does not support vocals')
    await expect(
      runDefaultAutoChartProfile({
        runId: 'empty-selection',
        outputDir: join(scratch, 'empty-selection-output'),
        files: [audioPath],
        folders: [],
        stemFolders: [],
        urls: [],
        enabledTracks: {
          drums: false,
          guitar: false,
          bass: false,
          vocals: false,
          harmonies: false,
          keys: false,
          proKeys: false
        }
      })
    ).rejects.toThrow('Choose at least one track')
    expect(preflightRequests).toEqual([])
    expect(chartRunRequests).toEqual([])
  })

  it('rejects a typed result whose MIDI omits a selected instrument track', async () => {
    const profile = {
      id: 'five-lane-composition',
      capability: 'five-lane.composition/v1',
      instrument: 'guitar' as const,
      instruments: ['guitar', 'keys'] as const,
      difficultyPolicy: 'expert_only' as const
    }
    selectedFolder = await addBundle(
      'composition-midi-coverage',
      candidate({ artifactId: artifactA, manifestSha256: manifestA, profile })
    )
    const audioPath = join(scratch, 'composition-midi-coverage.wav')
    await writeFile(audioPath, 'local-audio')
    await chooseCheckpointFolder()
    await saveDiscoveredAutoChartProfile({
      artifactId: artifactA,
      profileId: profile.id,
      difficultyPolicy: profile.difficultyPolicy
    })
    omittedMidiInstrument = 'keys'

    await expect(
      runDefaultAutoChartProfile({
        runId: 'composition-midi-coverage',
        outputDir: join(scratch, 'composition-midi-coverage-output'),
        files: [audioPath],
        folders: [],
        stemFolders: [],
        urls: [],
        enabledTracks: {
          drums: false,
          guitar: true,
          bass: false,
          vocals: false,
          harmonies: false,
          keys: true,
          proKeys: false
        }
      })
    ).rejects.toThrow('omitted playable keys chart output')
  })

  it('rejects a named five-lane track without OCTAVE-playable notes', async () => {
    selectedFolder = await addBundle(
      'non-playable-midi-track',
      candidate({ artifactId: artifactA, manifestSha256: manifestA })
    )
    const audioPath = join(scratch, 'non-playable-midi-track.wav')
    await writeFile(audioPath, 'local-audio')
    await chooseCheckpointFolder()
    await saveDiscoveredAutoChartProfile({
      artifactId: artifactA,
      profileId: 'guitar-hybrid-v2-rule',
      difficultyPolicy: 'expert_only'
    })
    midiNoteOverrides.set('guitar', 116)

    await expect(
      runDefaultAutoChartProfile({
        runId: 'non-playable-midi-track',
        outputDir: join(scratch, 'non-playable-midi-track-output'),
        files: [audioPath],
        folders: [],
        stemFolders: [],
        urls: []
      })
    ).rejects.toThrow('omitted playable guitar chart output')
  })

  it('requires Expert Pro Keys notes on the Expert Pro Keys track', async () => {
    const profile = {
      id: 'pro-keys-expert',
      capability: 'pro.keys/v1',
      instrument: 'guitar' as const,
      instruments: ['pro_keys'] as const,
      difficultyPolicy: 'expert_only' as const
    }
    selectedFolder = await addBundle(
      'pro-keys-expert',
      candidate({ artifactId: artifactA, manifestSha256: manifestA, profile })
    )
    const audioPath = join(scratch, 'pro-keys-expert.wav')
    await writeFile(audioPath, 'local-audio')
    await chooseCheckpointFolder()
    await saveDiscoveredAutoChartProfile({
      artifactId: artifactA,
      profileId: profile.id,
      difficultyPolicy: profile.difficultyPolicy
    })
    midiTrackNameOverrides.set('pro_keys', 'PART REAL_KEYS_E')

    await expect(
      runDefaultAutoChartProfile({
        runId: 'pro-keys-expert',
        outputDir: join(scratch, 'pro-keys-expert-output'),
        files: [audioPath],
        folders: [],
        stemFolders: [],
        urls: [],
        enabledTracks: {
          drums: false,
          guitar: false,
          bass: false,
          vocals: false,
          harmonies: false,
          keys: false,
          proKeys: true
        }
      })
    ).rejects.toThrow('omitted playable pro_keys chart output')
  })

  it.each([false, true])(
    'uses private MIDI transform inputs with optional audio=%s',
    async (includeAudio) => {
      selectedFolder = await addBundle(
        'transform-bundle',
        candidate({
          artifactId: artifactA,
          manifestSha256: manifestA,
          profile: {
            id: 'learned-transform',
            capability: 'difficulty.transform/v1',
            instrument: 'guitar',
            difficultyPolicy: 'expert_only'
          }
        })
      )
      await chooseCheckpointFolder()
      await saveDiscoveredAutoChartProfile({
        artifactId: artifactA,
        profileId: 'learned-transform',
        difficultyPolicy: 'expert_only'
      })
      const sourceMidi = join(scratch, 'private-source.mid')
      const sourceAudio = join(scratch, 'private-song.wav')
      await writeFile(sourceMidi, 'MThd')
      await writeFile(sourceAudio, 'audio')
      selectedDialogPaths.push(sourceMidi, ...(includeAudio ? [sourceAudio] : []), scratch)
      const result = await chooseAndRunTrainingTransform({
        runId: 'abcdef12-1234-1234-1234-abcdef123456',
        includeAudio
      })
      expect(result.cancelled).toBe(false)
      expect(result.artifacts?.capability).toBe('difficulty.transform/v1')
      expect(chartRunRequests).toHaveLength(1)
      expect(Object.keys(chartRunRequests[0]).sort()).toEqual([
        'output_dir',
        'preflight_request',
        'song_path',
        'source_midi_path'
      ])
      expect(chartRunRequests[0]).toMatchObject({
        source_midi_path: sourceMidi,
        song_path: includeAudio ? sourceAudio : null
      })
      expect(JSON.stringify(result)).not.toContain(scratch)
      expect(
        await readFile(join(String(chartRunRequests[0].output_dir), 'song.ini'), 'utf8')
      ).toContain('strum_generated = true')
      await expect(
        runDefaultAutoChartProfile({
          runId: 'audio-only-transform',
          outputDir: scratch,
          files: [sourceAudio],
          folders: [],
          stemFolders: [],
          urls: []
        })
      ).rejects.toThrow('Transform MIDI')
    }
  )

  it.each([0, 1, 2])('stops after cancellation during transform dialog %s', async (dialogIndex) => {
    selectedFolder = await addBundle(
      'cancel-transform-bundle',
      candidate({
        artifactId: artifactA,
        manifestSha256: manifestA,
        profile: {
          id: 'learned-transform',
          capability: 'difficulty.transform/v1',
          instrument: 'guitar',
          difficultyPolicy: 'expert_only'
        }
      })
    )
    await chooseCheckpointFolder()
    await saveDiscoveredAutoChartProfile({
      artifactId: artifactA,
      profileId: 'learned-transform',
      difficultyPolicy: 'expert_only'
    })
    const paths = [join(scratch, 'source.mid'), join(scratch, 'song.wav'), scratch]
    for (let index = 0; index < dialogIndex; index += 1) {
      deferredDialogs.push(Promise.resolve({ canceled: false, filePaths: [paths[index]] }))
    }
    let releaseDialog: ((result: { canceled: boolean; filePaths: string[] }) => void) | undefined
    deferredDialogs.push(
      new Promise((resolve) => {
        releaseDialog = resolve
      })
    )
    const previousDialogs = openedDialogs
    const runId = 'abcdef12-1234-1234-1234-abcdef123456'
    const run = chooseAndRunTrainingTransform({ runId, includeAudio: true })
    await vi.waitFor(() => expect(openedDialogs).toBe(previousDialogs + dialogIndex + 1))
    await expect(cancelDefaultAutoChartProfile(runId)).resolves.toBe(true)
    releaseDialog?.({ canceled: false, filePaths: [paths[dialogIndex]] })
    await expect(run).resolves.toEqual({ cancelled: true })
    expect(openedDialogs).toBe(previousDialogs + dialogIndex + 1)
    expect(preflightRequests).toHaveLength(0)
    expect(chartRunRequests).toHaveLength(0)
    await expect(cancelDefaultAutoChartProfile(runId)).resolves.toBe(false)
  })

  it('fails closed when the typed preflight no longer matches the saved candidate manifest', async () => {
    selectedFolder = await addBundle(
      'manifest-mismatch',
      candidate({ artifactId: artifactA, manifestSha256: manifestA })
    )
    const audioPath = join(scratch, 'mismatch.wav')
    await writeFile(audioPath, 'local-audio')
    await chooseCheckpointFolder()
    await saveDiscoveredAutoChartProfile({
      artifactId: artifactA,
      profileId: 'guitar-hybrid-v2-rule',
      difficultyPolicy: 'expert_only'
    })
    preflightManifestOverride = manifestB

    await expect(
      runDefaultAutoChartProfile({
        runId: 'manifest-mismatch-run',
        outputDir: join(scratch, 'mismatch-output'),
        files: [audioPath],
        folders: [],
        stemFolders: [],
        urls: []
      })
    ).rejects.toThrow(/could not be preflighted/)
    expect(chartRunRequests).toEqual([])
  })

  it('registers and cancels a profile run while typed preflight is still running', async () => {
    selectedFolder = await addBundle(
      'cancel-preflight',
      candidate({ artifactId: artifactA, manifestSha256: manifestA })
    )
    const audioPath = join(scratch, 'cancel.wav')
    await writeFile(audioPath, 'local-audio')
    await chooseCheckpointFolder()
    await saveDiscoveredAutoChartProfile({
      artifactId: artifactA,
      profileId: 'guitar-hybrid-v2-rule',
      difficultyPolicy: 'expert_only'
    })
    holdPreflight = true
    const run = runDefaultAutoChartProfile({
      runId: 'cancel-preflight-run',
      outputDir: join(scratch, 'cancel-output'),
      files: [audioPath],
      folders: [],
      stemFolders: [],
      urls: []
    })
    await vi.waitFor(() => expect(heldPreflightChild).toBeDefined())
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    await expect(cancelDefaultAutoChartProfile('cancel-preflight-run')).resolves.toBe(true)
    expect(kill).toHaveBeenCalledWith(-9876, 'SIGTERM')
    expect(existsSync(heldPreflightRequest)).toBe(true)
    const rejected = expect(run).rejects.toThrow(/cancelled/)
    heldPreflightChild?.emit('close', null)
    await rejected
    expect(kill).toHaveBeenCalledWith(-9876, 'SIGKILL')
    expect(existsSync(heldPreflightRequest)).toBe(false)
    expect(chartRunRequests).toEqual([])
  })

  it('rejects raw candidates and remote file-shaped inputs before any chart command starts', async () => {
    selectedFolder = await addBundle(
      'raw-candidate',
      candidate({
        artifactId: artifactA,
        manifestSha256: manifestA,
        deploymentStatus: 'not_deployable'
      })
    )
    await chooseCheckpointFolder()
    await expect(
      saveDiscoveredAutoChartProfile({
        artifactId: artifactA,
        profileId: 'guitar-hybrid-v2-rule',
        difficultyPolicy: 'expert_only'
      })
    ).rejects.toThrow(/no executable STRUM Auto Chart profile/)

    selectedFolder = await addBundle(
      'guitar-candidate',
      candidate({ artifactId: artifactA, manifestSha256: manifestA })
    )
    await chooseCheckpointFolder()
    await saveDiscoveredAutoChartProfile({
      artifactId: artifactA,
      profileId: 'guitar-hybrid-v2-rule',
      difficultyPolicy: 'expert_only'
    })
    await expect(
      runDefaultAutoChartProfile({
        runId: 'remote-file-run',
        outputDir: join(scratch, 'output'),
        files: ['https://example.invalid/video'],
        folders: [],
        stemFolders: [],
        urls: []
      })
    ).rejects.toThrow(/absolute local audio file or one HTTPS URL/)
    expect(preflightRequests).toEqual([])
    expect(chartRunRequests).toEqual([])
  })

  it('materializes one HTTPS URL privately before the typed STRUM chart commands', async () => {
    selectedFolder = await addBundle(
      'guitar-url-candidate',
      candidate({ artifactId: artifactA, manifestSha256: manifestA })
    )
    const outputDir = join(scratch, 'url-output')
    await chooseCheckpointFolder()
    await saveDiscoveredAutoChartProfile({
      artifactId: artifactA,
      profileId: 'guitar-hybrid-v2-rule',
      difficultyPolicy: 'expert_only'
    })

    await expect(
      runDefaultAutoChartProfile({
        runId: 'url-materialization-run',
        outputDir,
        files: [],
        folders: [],
        stemFolders: [],
        urls: ['https://example.invalid/watch?v=private']
      })
    ).resolves.toMatchObject({ success: true, outputDir })

    expect(materializedUrls).toEqual(['https://example.invalid/watch?v=private'])
    expect(chartRunRequests).toHaveLength(1)
    expect(chartRunRequests[0]).toMatchObject({
      audio_path: materializedAudioPath,
      output_dir: outputDir
    })
    expect(JSON.stringify(chartRunRequests[0])).not.toContain('example.invalid')
    expect(JSON.stringify(preflightRequests)).not.toContain('example.invalid')
  })
})
