/**
 * Public, path-free STRUM metadata for pipelines which expose mutually
 * exclusive raw checkpoint candidates. This is descriptive only: a candidate
 * contract never makes a bundle runnable in OCTAVE.
 */
export interface StrumCheckpointOutputContracts {
  format: 'strum-candidate-checkpoint-output-contracts/v1'
  selector: {
    training_option: string
    default: string
  }
  by_candidate_kind: Record<string, StrumCheckpointOutputCandidate>
}

/**
 * Path-free STRUM-owned post-training metadata. This is descriptive only:
 * later main-process APIs resolve its private fields from opaque candidates.
 */
export interface StrumPromotionJobDescriptor {
  id: string
  display_name: string
  kind: 'evaluation' | 'package'
  status: 'available' | 'planned' | 'unavailable'
  options_schema: Record<string, unknown>
  private_request_fields: string[]
  optional_private_request_fields: string[]
  output_kind: string
  deployment_scope: string
  quality_policy?: Record<string, unknown>
  calibration_policy?: Record<string, unknown>
  checkpoint_selection_policy?: Record<string, unknown>
}

/**
 * The path-free terminal result emitted by STRUM's post-training job protocol.
 * OCTAVE may add its own opaque `promotionId` when it records this result, but
 * it must not add or expose any worker request locations.
 */
export interface StrumPromotionJobResult {
  schema_version: 1
  format: 'strum-post-train-job-result/v1'
  status: 'completed'
  pipeline_id: string
  job_id: string
  output_kind: string
  deployment_scope: string
  result: Record<string, unknown>
}

export interface StrumCheckpointOutputCandidate {
  component_outputs: string[]
  model_outputs: string[]
  preprocessing: {
    id: string
    input_contract: string
    negative_policy?: string
  }
  candidate_bundle: {
    config_format: string
    task_kind: string
    pipeline_id: string
    model_implementation: string
    input_contract: StrumCheckpointCandidateInputContract
    output_contract: StrumCheckpointCandidateOutputContract
    target_contract?: StrumCheckpointCandidateTargetContract
    component_set: string[]
    profiles: 'forbidden'
    companions: 'forbidden'
  }
  deployment_scope: {
    status: 'raw_experiment_candidate_only'
    profile: 'not_available'
    chart_execution: 'not_available'
  }
}

export type StrumCheckpointCandidateInputContract =
  | {
      format: string
      event_time_source: string
      free_running_event_proposal: boolean
      sequence_decoding: boolean
      midi_emission: boolean
    }
  | {
      format: string
      requires_midi_at_inference: boolean
      offline_window_scoring: boolean
      free_running_event_proposal: boolean
      sequence_decoding: boolean
      midi_emission: boolean
    }

export type StrumCheckpointCandidateOutputContract =
  | {
      format: string
      outputs: string[]
      free_running_event_proposal: boolean
      sequence_decoding: boolean
      midi_emission: boolean
    }
  | {
      format: string
      event_attributes: boolean
      midi_emission: boolean
    }

export interface StrumCheckpointCandidateTargetContract {
  kind: string
  string_count?: number
  fret_range?: [number, number]
  techniques?: string[]
  track_variant_head?: string[]
  pitch_range?: [number, number]
  channel_metadata?: string
  range_state_head?: string[]
}
