import { describe, expect, it, vi } from 'vitest'

let pipelinePayload: unknown[] = []
let runtimeCapabilities = ['dataset_prepare', 'training_start', 'post_train_job_discovery']

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/octave-training-contract-test', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
}))

vi.mock('./runner', () => ({
  resolvePythonCommand: async () => ({ command: 'strum-test-worker', baseArgs: [] })
}))

vi.mock('child_process', () => ({
  execFile: (
    _command: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void
  ) => {
    if (args.includes('probe')) {
      callback(
        null,
        `${JSON.stringify({
          protocol_version: '1.0',
          runtime_id: 'test-runtime',
          capabilities: runtimeCapabilities
        })}\n`
      )
      return
    }
    if (args.includes('pipeline') && args.includes('list')) {
      callback(null, `${JSON.stringify({ pipelines: pipelinePayload })}\n`)
      return
    }
    callback(new Error('unexpected STRUM request'), '')
  }
}))

import { listTrainingPipelines } from './training'

const pipelineId = 'strum.instrument-chart/pro-guitar/v1'

function pipelineDescriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: pipelineId,
    display_name: 'Pro Guitar',
    kind: 'instrument_chart',
    version: 1,
    status: 'catalog_ready',
    preparation_status: 'available',
    training_status: 'available',
    catalog_requirements: { instrument: 'guitar' },
    prepare_schema: { type: 'object', properties: {}, required: [] },
    train_schema: { type: 'object', properties: {}, required: [] },
    checkpoint_outputs: ['pro.guitar.event_attributes'],
    inference_capability: 'chart.transform/v1',
    private_request_fields: ['catalog_root'],
    catalog_inspection_option_keys: [],
    training_requirements: ['profile_evaluation'],
    promotion_jobs: [],
    ...overrides
  }
}

function outputContracts(): Record<string, unknown> {
  return {
    format: 'strum-candidate-checkpoint-output-contracts/v1',
    selector: { training_option: 'candidate_kind', default: 'known_event_attributes/v1' },
    by_candidate_kind: {
      'known_event_attributes/v1': {
        component_outputs: ['pro.guitar.event_attributes'],
        model_outputs: ['string_fret_technique', 'track_variant'],
        preprocessing: {
          id: 'pro-logmel-event-windows/v1',
          input_contract: 'strum-pro-known-reference-event-window/v1'
        },
        candidate_bundle: {
          config_format: 'strum-pro-event-attribute-candidate-config/v1',
          task_kind: 'pro_guitar',
          pipeline_id: pipelineId,
          model_implementation: 'ProEventAttributeCNN/v1',
          input_contract: {
            format: 'strum-pro-known-reference-event-window/v1',
            event_time_source: 'held_out_catalog_label_only',
            free_running_event_proposal: false,
            sequence_decoding: false,
            midi_emission: false
          },
          output_contract: {
            format: 'strum-pro-known-event-attributes/v1',
            outputs: ['string_fret_technique', 'track_variant'],
            free_running_event_proposal: false,
            sequence_decoding: false,
            midi_emission: false
          },
          target_contract: {
            kind: 'pro_string_fret_technique/v1',
            string_count: 6,
            fret_range: [0, 22],
            techniques: ['normal', 'muted'],
            track_variant_head: ['standard', '22_fret']
          },
          component_set: ['pro.guitar.event_attributes'],
          profiles: 'forbidden',
          companions: 'forbidden'
        },
        deployment_scope: {
          status: 'raw_experiment_candidate_only',
          profile: 'not_available',
          chart_execution: 'not_available'
        }
      },
      'free_running_event_proposal/v1': {
        component_outputs: ['pro.guitar.event_proposal'],
        model_outputs: ['audio_event_proposal_scores'],
        preprocessing: {
          id: 'pro-logmel-event-proposal-windows/v1',
          input_contract: 'strum-pro-arbitrary-audio-window/v1',
          negative_policy: 'pro-event-proposal-negative-policy/v1'
        },
        candidate_bundle: {
          config_format: 'strum-pro-event-proposal-candidate-config/v1',
          task_kind: 'pro_guitar',
          pipeline_id: pipelineId,
          model_implementation: 'ProEventProposalCNN/v1',
          input_contract: {
            format: 'strum-pro-arbitrary-audio-window/v1',
            requires_midi_at_inference: false,
            offline_window_scoring: true,
            free_running_event_proposal: true,
            sequence_decoding: false,
            midi_emission: false
          },
          output_contract: {
            format: 'strum-pro-event-proposal-scores/v1',
            event_attributes: false,
            midi_emission: false
          },
          component_set: ['pro.guitar.event_proposal'],
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
  }
}

describe('STRUM checkpoint output-contract descriptors', () => {
  it('exposes a selected-candidate map without private paths or deployment authority', async () => {
    pipelinePayload = [pipelineDescriptor({ checkpoint_output_contracts: outputContracts() })]

    const [pipeline] = await listTrainingPipelines()
    expect(pipeline.checkpoint_output_contracts).toEqual({
      format: 'strum-candidate-checkpoint-output-contracts/v1',
      selector: { training_option: 'candidate_kind', default: 'known_event_attributes/v1' },
      by_candidate_kind: expect.objectContaining({
        'known_event_attributes/v1': expect.objectContaining({
          component_outputs: ['pro.guitar.event_attributes'],
          deployment_scope: {
            status: 'raw_experiment_candidate_only',
            profile: 'not_available',
            chart_execution: 'not_available'
          }
        }),
        'free_running_event_proposal/v1': expect.objectContaining({
          component_outputs: ['pro.guitar.event_proposal']
        })
      })
    })
    expect(JSON.stringify(pipeline.checkpoint_output_contracts)).not.toMatch(
      /[/\\](home|tmp|run)[/\\]/
    )
  })

  it('rejects a descriptor with an unknown candidate field instead of passing it through', async () => {
    const contracts = outputContracts()
    const candidates = contracts.by_candidate_kind as Record<string, Record<string, unknown>>
    candidates['known_event_attributes/v1'].unsafe_path = '/private/checkpoint'
    pipelinePayload = [pipelineDescriptor({ checkpoint_output_contracts: contracts })]

    await expect(listTrainingPipelines()).resolves.toEqual([])
  })

  it('keeps existing descriptors that do not use candidate output contracts', async () => {
    pipelinePayload = [pipelineDescriptor({ checkpoint_output_contracts: undefined })]

    await expect(listTrainingPipelines()).resolves.toEqual([
      expect.objectContaining({
        id: pipelineId,
        checkpoint_outputs: ['pro.guitar.event_attributes']
      })
    ])
  })

  it('rejects path-bearing promotion metadata instead of forwarding it to the renderer', async () => {
    pipelinePayload = [
      pipelineDescriptor({
        promotion_jobs: [
          {
            id: 'chart-transform.profile-evaluate/v1',
            display_name: 'Evaluate',
            kind: 'evaluation',
            status: 'available',
            options_schema: { type: 'object', properties: {}, required: [] },
            private_request_fields: ['bundle_root'],
            optional_private_request_fields: [],
            output_kind: 'evaluation_report',
            deployment_scope: 'evaluation_evidence_only',
            quality_policy: { policy_id: 'private/path' }
          }
        ]
      })
    ]

    await expect(listTrainingPipelines()).resolves.toEqual([])
  })

  it('fails closed for package descriptors that expose caller policy overrides', async () => {
    pipelinePayload = [
      pipelineDescriptor({
        promotion_jobs: [
          {
            id: 'guitar.profile-package/v1',
            display_name: 'Package',
            kind: 'package',
            status: 'available',
            options_schema: {
              type: 'object',
              properties: { minimum_onset_f1: { type: 'number', default: 0 } },
              required: []
            },
            private_request_fields: ['experiment', 'output'],
            optional_private_request_fields: [],
            output_kind: 'profile_bundle',
            deployment_scope: 'deployable_after_profile_validation'
          }
        ]
      })
    ]
    await expect(listTrainingPipelines()).resolves.toEqual([])
  })

  it('exposes a normalized, path-free promotion descriptor without making it executable', async () => {
    pipelinePayload = [
      pipelineDescriptor({
        promotion_jobs: [
          {
            id: 'chart-transform.profile-evaluate/v1',
            display_name: 'Evaluate held-out transform',
            kind: 'evaluation',
            status: 'available',
            options_schema: {
              type: 'object',
              properties: { device: { type: 'string', enum: ['cpu', 'cuda'], default: 'cpu' } },
              required: []
            },
            private_request_fields: ['bundle_root', 'dataset_manifest', 'output'],
            optional_private_request_fields: ['catalog_root'],
            output_kind: 'evaluation_report',
            deployment_scope: 'evaluation_evidence_only',
            quality_policy: { policy_id: 'chart-transform-held-out/v1', schema_version: 1 }
          }
        ]
      })
    ]

    const [descriptor] = await listTrainingPipelines()
    expect(descriptor.promotion_jobs).toEqual([
      expect.objectContaining({
        id: 'chart-transform.profile-evaluate/v1',
        private_request_fields: ['bundle_root', 'dataset_manifest', 'output']
      })
    ])
    expect(JSON.stringify(descriptor.promotion_jobs)).not.toMatch(/[/\\](home|tmp|run)[/\\]/)
  })

  it('withholds promotion metadata unless the runtime advertises discovery support', async () => {
    runtimeCapabilities = ['dataset_prepare', 'training_start']
    pipelinePayload = [
      pipelineDescriptor({
        promotion_jobs: [
          {
            id: 'chart-transform.profile-evaluate/v1',
            display_name: 'Evaluate',
            kind: 'evaluation',
            status: 'available',
            options_schema: { type: 'object', properties: {}, required: [] },
            private_request_fields: ['bundle_root'],
            optional_private_request_fields: [],
            output_kind: 'evaluation_report',
            deployment_scope: 'evaluation_evidence_only'
          }
        ]
      })
    ]
    await expect(listTrainingPipelines()).resolves.toEqual([
      expect.objectContaining({ promotion_jobs: [] })
    ])
    runtimeCapabilities = ['dataset_prepare', 'training_start', 'post_train_job_discovery']
  })

  it('rejects a renderer-visible display string containing a private path', async () => {
    pipelinePayload = [pipelineDescriptor({ display_name: 'Diagnostic at /private/catalog' })]
    await expect(listTrainingPipelines()).resolves.toEqual([])
  })
})
