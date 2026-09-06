import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import type {
  StrumCheckpointOutputContracts,
  StrumPromotionJobDescriptor,
  StrumPromotionJobResult
} from '../../../shared/strumTrainingContracts'
import { useSettingsStore } from '../stores'
import './DatasetCurationModal.css'

type SourceCandidate = {
  candidateId: string
  kind: 'octave-library' | 'sng' | 'rb3con' | 'zip'
  songCount: number
  metadata: Record<string, string>
  midiValid: boolean
  instruments: Record<
    string,
    { status: 'present' | 'absent'; difficulties: string[]; trackNames: string[] }
  >
  trainingUse: 'allowed' | 'review_required'
  warnings: Array<{ code: string }>
  isStrumGenerated?: boolean
  /** A safe filter flag; original track names and package details stay private. */
  canonicalVocalMidi?: boolean
  duplicateMidi?: boolean
}

type CatalogSaveMode = 'create' | 'update' | 'clone'
export type TrainingStep = 'learn' | 'curate' | 'prepare' | 'train' | 'deploy'

export type TrainingActivity = {
  step: TrainingStep
  phase: string
  completed: number
  total: number
}

type ExistingCatalog = {
  catalogName: string
  catalogId: string
  provenance: string
  license: string
  recordCount: number
  libraryRecordCount: number
  externalRecordCount: number
}

type PackageCandidate = SourceCandidate & { groupId: string }

type PackageInventory = {
  selectedPackageCount: number
  inspectedPackageCount: number
  packageLimitReachedCount: number
  cancelled: boolean
  readablePackageCount: number
  readableHeaderCount: number
  unreadablePackageCount: number
  inspectedChartCount: number
  validNotesMidiCount: number
  invalidOrMissingNotesMidiCount: number
  chartOnlyCount: number
  exactExpertPartVocalsCount: number
  duplicateMidiCount: number
  duplicateContainerCount: number
  containerIdentityUnavailableCount: number
  decodeTimeoutCount: number
  decodeFailureCount: number
}

type PackageGroup = {
  groupId: string
  groupName: string
  strumGeneratedCount: number
  packageLimitReached: boolean
  directoryLimitReached: boolean
  candidates: PackageCandidate[]
  inventory?: PackageInventory
  /** Opaque main-owned token returned only for a partial inventory. */
  resumeCursor?: string
}

type TrainingRuntime = {
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

type TrainingPipeline = {
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
  promotion_jobs: StrumPromotionJobDescriptor[]
}

type TrainingControlValue = string | number | boolean

type TrainingSchemaControl = {
  key: string
  type: 'integer' | 'number' | 'boolean' | 'string'
  enumValues: TrainingControlValue[]
  defaultValue: TrainingControlValue | undefined
  minimum: number | undefined
  maximum: number | undefined
}

type TrainingTask = {
  taskViewId: string
  catalogId: string
  catalogName: string
  pipelineId: string
  eligibleCount: number
  contentHash: string
  createdAt: string
}

type TrainingRun = {
  runId: string
  taskViewId: string
  pipelineId: string
  checkpointCount: number
  deployable: boolean
  checkpointManifestHash: string
  artifactId?: string
  createdAt: string
}

type DiscoveredCheckpointProfile = {
  profileId: string
  capability: string
  instruments: string[]
  difficultyPolicies: string[]
  requiredComponents: string[]
  execution: { status: 'available' | 'not_available'; difficultyPolicies: string[] }
}

type DiscoveredCheckpoint = {
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

type CheckpointDiscovery = {
  candidateCount: number
  profileCount: number
  rejectedBundleCount: number
  truncated: boolean
  candidates: DiscoveredCheckpoint[]
}

type AutoChartProfile = {
  profileId: string
  runId?: string
  strumProfileId?: string
  artifactId?: string
  difficultyPolicy?: string
  pipelineId: string
  runtimeId: string
  createdAt: string
  isDefault: boolean
}

type TrainingJob = {
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
}

type TrainingPromotionResult = StrumPromotionJobResult & {
  promotionId: string
  candidateArtifactId: string
  artifactId?: string
  deploymentStatus?: 'ready' | 'not_deployable'
}

type HarmonyTrackName = 'HARM1' | 'HARM2' | 'HARM3'

type HarmonyTarget = {
  sourceId: string
  label: string
  tracks: HarmonyTrackName[]
  configuredTracks: HarmonyTrackName[]
}

type HarmonyAudioSelection = { selectionId: string; displayName: string }

const CATALOG_PARENT_STORAGE_KEY = 'octave.datasetCatalogParent'
const TRAINING_LEARN_SEEN_STORAGE_KEY = 'octave.trainingLearnSeen'

const TRAINING_STEPS = [
  'learn',
  'curate',
  'prepare',
  'train',
  'deploy'
] as const satisfies readonly TrainingStep[]

const TRAINING_STEP_TAGLINES = {
  learn: 'Understand the local, personal-use training workflow before curating a catalog.',
  curate: 'Select approved songs and sources for your STRUM catalog.',
  prepare: 'Create a STRUM task view from the approved catalog assets.',
  train: 'Run STRUM from the prepared catalog and follow progress in the background.',
  deploy: 'Discover, inspect, and validate a STRUM model bundle before making it your default.'
} as const satisfies Record<TrainingStep, string>

const TRAINING_STEP_DETAILS = [
  {
    step: 'curate',
    title: 'Curate',
    description: 'Choose music you are allowed to use and build a permission-backed catalog.'
  },
  {
    step: 'prepare',
    title: 'Prepare',
    description: 'Create a STRUM task view from approved catalog assets and metadata.'
  },
  {
    step: 'train',
    title: 'Train',
    description: 'Run STRUM in the background and evaluate the checkpoints it produces.'
  },
  {
    step: 'deploy',
    title: 'Deploy',
    description: 'Select a checkpoint as a local OCTAVE auto-chart profile and default.'
  }
] as const satisfies ReadonlyArray<{
  step: TrainingStep
  title: string
  description: string
}>

function candidateLabel(candidate: SourceCandidate): string {
  const artist = candidate.metadata.artist
  const name = candidate.metadata.name
  return artist && name ? `${artist} — ${name}` : `${candidate.kind} source`
}

function catalogRequirementInstrument(requirements: Record<string, unknown>): string {
  if (typeof requirements.instrument === 'string') return requirements.instrument
  if (Array.isArray(requirements.instruments) && typeof requirements.instruments[0] === 'string') {
    return requirements.instruments[0]
  }
  return 'training'
}

function audioPolicyLabel(policy: Record<string, unknown> | undefined): string {
  if (!policy || typeof policy.kind !== 'string') return 'See STRUM requirements'
  if (policy.kind === 'not_required') return 'Not required'
  return policy.kind.replaceAll('_', ' ')
}

function trainingSchemaControls(schema: Record<string, unknown>): TrainingSchemaControl[] {
  const properties = schema.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return []
  return Object.entries(properties).flatMap(([key, property]) => {
    if (!property || typeof property !== 'object' || Array.isArray(property)) return []
    const definition = property as Record<string, unknown>
    const type = definition.type
    if (!['integer', 'number', 'boolean', 'string'].includes(String(type))) return []
    const defaultValue = definition.default
    const validDefault =
      typeof defaultValue === 'string' ||
      typeof defaultValue === 'number' ||
      typeof defaultValue === 'boolean'
        ? defaultValue
        : undefined
    return [
      {
        key,
        type: type as TrainingSchemaControl['type'],
        enumValues: Array.isArray(definition.enum)
          ? definition.enum.filter(
              (value): value is TrainingControlValue =>
                typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
            )
          : [],
        defaultValue: validDefault,
        minimum: typeof definition.minimum === 'number' ? definition.minimum : undefined,
        maximum: typeof definition.maximum === 'number' ? definition.maximum : undefined
      }
    ]
  })
}

function schemaControlLabel(key: string): string {
  return key
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function schemaConfig(
  controls: TrainingSchemaControl[],
  values: Record<string, TrainingControlValue>
): Record<string, TrainingControlValue> {
  return Object.fromEntries(
    controls.flatMap((control) => {
      const value = values[control.key] ?? control.defaultValue
      return value === undefined ? [] : [[control.key, value]]
    })
  )
}

function TrainingSchemaControls({
  controls,
  values,
  setValues
}: {
  controls: TrainingSchemaControl[]
  values: Record<string, TrainingControlValue>
  setValues: Dispatch<SetStateAction<Record<string, TrainingControlValue>>>
}): React.JSX.Element | null {
  if (controls.length === 0) return null
  return (
    <div className="training-config-grid">
      {controls.map((control) => {
        const value = values[control.key] ?? control.defaultValue
        const setValue = (next: TrainingControlValue): void => {
          setValues((current) => ({ ...current, [control.key]: next }))
        }
        if (control.type === 'boolean') {
          return (
            <label className="training-toggle-control" key={control.key}>
              <input
                checked={Boolean(value)}
                type="checkbox"
                onChange={(event) => setValue(event.target.checked)}
              />
              <span>{schemaControlLabel(control.key)}</span>
            </label>
          )
        }
        if (control.enumValues.length > 0) {
          return (
            <label key={control.key}>
              {schemaControlLabel(control.key)}
              <select
                value={String(value ?? '')}
                onChange={(event) => {
                  const selected = control.enumValues.find(
                    (candidate) => String(candidate) === event.target.value
                  )
                  if (selected !== undefined) setValue(selected)
                }}
              >
                {control.enumValues.map((option) => (
                  <option key={String(option)} value={String(option)}>
                    {String(option)}
                  </option>
                ))}
              </select>
            </label>
          )
        }
        if (control.type === 'integer' || control.type === 'number') {
          return (
            <label key={control.key}>
              {schemaControlLabel(control.key)}
              <input
                max={control.maximum}
                min={control.minimum}
                step={control.type === 'integer' ? 1 : 'any'}
                type="number"
                value={typeof value === 'number' ? value : ''}
                onChange={(event) => {
                  const next = Number(event.target.value)
                  if (!Number.isFinite(next)) return
                  setValue(control.type === 'integer' ? Math.trunc(next) : next)
                }}
              />
            </label>
          )
        }
        return (
          <label key={control.key}>
            {schemaControlLabel(control.key)}
            <input
              type="text"
              value={typeof value === 'string' ? value : ''}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
        )
      })}
    </div>
  )
}

function TrainingStepIcon({
  step,
  complete = false
}: {
  step: TrainingStep
  complete?: boolean
}): React.JSX.Element {
  if (complete) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m5 12 4.2 4.2L19 6.5" />
      </svg>
    )
  }
  if (step === 'learn') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 10v5" />
        <path d="M12 7.2h.01" />
      </svg>
    )
  }
  if (step === 'curate') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3.5 7.5h6l1.8 2h9.2v8.8a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2Z" />
        <path d="M3.5 7.5V5.7a2.2 2.2 0 0 1 2.2-2.2h4.1l1.8 2H18" />
      </svg>
    )
  }
  if (step === 'prepare') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 4v16M12 4v16M19 4v16" />
        <path d="M3 9h4M10 15h4M17 7h4" />
        <circle cx="5" cy="9" r="2" />
        <circle cx="12" cy="15" r="2" />
        <circle cx="19" cy="7" r="2" />
      </svg>
    )
  }
  if (step === 'deploy') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3v11" />
        <path d="m8 10 4 4 4-4" />
        <path d="M5 17.5v2a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-2" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m13.5 2-9 12h6.8l-.8 8 9-12h-6.8Z" />
    </svg>
  )
}

function DatasetArtwork({
  candidateId,
  label
}: {
  candidateId: string
  label: string
}): React.JSX.Element {
  const [artwork, setArtwork] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void window.api.readDatasetCandidateArtwork(candidateId).then((dataUrl) => {
      if (current) setArtwork(dataUrl)
    })
    return () => {
      current = false
    }
  }, [candidateId])

  return artwork ? (
    <img className="dataset-artwork" src={artwork} alt={`${label} artwork`} />
  ) : (
    <span className="dataset-artwork dataset-artwork-placeholder" aria-hidden="true">
      ♪
    </span>
  )
}

export function TrainingModal({
  isOpen,
  onClose,
  onActivityChange
}: {
  isOpen: boolean
  onClose: () => void
  onActivityChange: (activity: TrainingActivity | null) => void
}): React.JSX.Element | null {
  const updateSettings = useSettingsStore((state) => state.updateSettings)
  const [songs, setSongs] = useState<SourceCandidate[]>([])
  const [packageGroups, setPackageGroups] = useState<PackageGroup[]>([])
  const [selectedPackages, setSelectedPackages] = useState<Set<string>>(new Set())
  const [catalogParent, setCatalogParent] = useState<{
    parentId: string
    name: string
  } | null>(null)
  const [existingCatalogs, setExistingCatalogs] = useState<ExistingCatalog[]>([])
  const [selectedCatalog, setSelectedCatalog] = useState<ExistingCatalog | null>(null)
  const [saveMode, setSaveMode] = useState<CatalogSaveMode>('create')
  /** Opaque reviewed-package capability used only for one audio revision. */
  const [audioEnrichmentCandidateId, setAudioEnrichmentCandidateId] = useState<string | null>(null)
  const [activeStep, setActiveStep] = useState<TrainingStep>('learn')
  const [hasSeenLearn, setHasSeenLearn] = useState(
    () => localStorage.getItem(TRAINING_LEARN_SEEN_STORAGE_KEY) === 'true'
  )
  const [hasInitializedOpening, setHasInitializedOpening] = useState(false)
  const [catalogName, setCatalogName] = useState('octave-curated-catalog')
  const [catalogId, setCatalogId] = useState('octave-curated-dataset')
  const [provenance, setProvenance] = useState('Curated in Octave')
  const [license, setLicense] = useState('')
  const [loading, setLoading] = useState(false)
  const [scanningPackages, setScanningPackages] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [scanProgress, setScanProgress] = useState<{
    phase: 'discovering' | 'inspecting'
    completed: number
    total: number
  } | null>(null)
  const [saveProgress, setSaveProgress] = useState<{
    phase: 'checking' | 'normalizing' | 'materializing' | 'validating'
    completed: number
    total: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    records: number
    skipped: number
  } | null>(null)
  const trainingRefreshEpoch = useRef(0)
  const [trainingRuntime, setTrainingRuntime] = useState<TrainingRuntime | null>(null)
  const [trainingPipelines, setTrainingPipelines] = useState<TrainingPipeline[]>([])
  const [selectedPipelineId, setSelectedPipelineId] = useState('')
  const [catalogInspection, setCatalogInspection] = useState<{
    pipelineId: string
    eligibleCount: number
    recordCount: number
    excluded: Record<string, number>
    audioPolicy: Record<string, unknown>
  } | null>(null)
  const [trainingTasks, setTrainingTasks] = useState<TrainingTask[]>([])
  const [trainingRuns, setTrainingRuns] = useState<TrainingRun[]>([])
  const [trainingProfiles, setTrainingProfiles] = useState<AutoChartProfile[]>([])
  const [compositionProfileIds, setCompositionProfileIds] = useState<Set<string>>(new Set())
  const [selectedTaskViewId, setSelectedTaskViewId] = useState('')
  const [checkpointDiscovery, setCheckpointDiscovery] = useState<CheckpointDiscovery | null>(null)
  const [selectedArtifactId, setSelectedArtifactId] = useState('')
  const [selectedDiscoveredCheckpoint, setSelectedDiscoveredCheckpoint] =
    useState<DiscoveredCheckpoint | null>(null)
  const [selectedDiscoveredProfileId, setSelectedDiscoveredProfileId] = useState('')
  const [selectedDifficultyPolicy, setSelectedDifficultyPolicy] = useState('')
  const [enablingTrainingRuntime, setEnablingTrainingRuntime] = useState(false)
  const [discoveringCheckpoints, setDiscoveringCheckpoints] = useState(false)
  const [savingAutoChartProfile, setSavingAutoChartProfile] = useState(false)
  const [trainingJob, setTrainingJob] = useState<TrainingJob | null>(null)
  const [inventoryingGroupId, setInventoryingGroupId] = useState<string | null>(null)
  const [inventoryProgress, setInventoryProgress] = useState<{
    processedPackageCount: number
    completedPackageCount: number
    totalPackageCount: number
  } | null>(null)
  const [showCanonicalVocalMidiOnly, setShowCanonicalVocalMidiOnly] = useState(false)
  const [prepareConfig, setPrepareConfig] = useState<Record<string, TrainingControlValue>>({})
  const [trainConfig, setTrainConfig] = useState<Record<string, TrainingControlValue>>({})
  const [transformRunId, setTransformRunId] = useState('')
  const [transformAudio, setTransformAudio] = useState(false)
  const [transformOutput, setTransformOutput] = useState('')
  const [parentArtifactId, setParentArtifactId] = useState('')
  const [promotionArtifactId, setPromotionArtifactId] = useState('')
  const [promotionJobs, setPromotionJobs] = useState<StrumPromotionJobDescriptor[]>([])
  const [promotionConfigs, setPromotionConfigs] = useState<
    Record<string, Record<string, TrainingControlValue>>
  >({})
  const [promotionResults, setPromotionResults] = useState<TrainingPromotionResult[]>([])

  const selectedPipeline = useMemo(
    () => trainingPipelines.find((pipeline) => pipeline.id === selectedPipelineId) ?? null,
    [selectedPipelineId, trainingPipelines]
  )
  const prepareControls = useMemo(
    () => trainingSchemaControls(selectedPipeline?.prepare_schema ?? {}),
    [selectedPipeline]
  )
  const trainControls = useMemo(
    () => trainingSchemaControls(selectedPipeline?.train_schema ?? {}),
    [selectedPipeline]
  )
  const resolvedPrepareConfig = useMemo(
    () => schemaConfig(prepareControls, prepareConfig),
    [prepareConfig, prepareControls]
  )
  const resolvedTrainConfig = useMemo(
    () => schemaConfig(trainControls, trainConfig),
    [trainConfig, trainControls]
  )
  const selectedCheckpointOutputCandidate = useMemo(() => {
    const contracts = selectedPipeline?.checkpoint_output_contracts
    if (!contracts) return null
    const selected = resolvedTrainConfig[contracts.selector.training_option]
    const candidateKind =
      typeof selected === 'string' && contracts.by_candidate_kind[selected]
        ? selected
        : contracts.selector.default
    const candidate = contracts.by_candidate_kind[candidateKind]
    return candidate ? { candidateKind, candidate } : null
  }, [resolvedTrainConfig, selectedPipeline])
  const selectedPipelineTasks = useMemo(
    () => trainingTasks.filter((task) => task.pipelineId === selectedPipelineId),
    [selectedPipelineId, trainingTasks]
  )
  const selectedPipelineName = selectedPipeline?.display_name ?? 'STRUM'
  const selectedInstrument = selectedPipeline
    ? catalogRequirementInstrument(selectedPipeline.catalog_requirements)
    : 'training'
  const selectedDiscoveredProfile = useMemo(
    () =>
      selectedDiscoveredCheckpoint?.profiles.find(
        (profile) => profile.profileId === selectedDiscoveredProfileId
      ) ?? null,
    [selectedDiscoveredCheckpoint, selectedDiscoveredProfileId]
  )
  const promotionRuns = useMemo(
    () => trainingRuns.filter((run) => Boolean(run.artifactId)),
    [trainingRuns]
  )

  const [harmonyTargets, setHarmonyTargets] = useState<HarmonyTarget[]>([])
  const [harmonyTargetId, setHarmonyTargetId] = useState('')
  const [harmonyTrackName, setHarmonyTrackName] = useState<HarmonyTrackName>('HARM1')
  const [harmonyAudio, setHarmonyAudio] = useState<HarmonyAudioSelection | null>(null)
  const [harmonyKind, setHarmonyKind] = useState<
    'isolated_source_stem/v1' | 'isolated_separation_output/v1'
  >('isolated_source_stem/v1')
  const [harmonyAttestationId, setHarmonyAttestationId] = useState('')
  const [separatorId, setSeparatorId] = useState('')
  const [separatorVersion, setSeparatorVersion] = useState('')
  const [separatorModelSha256, setSeparatorModelSha256] = useState('')
  const [separatorConfigurationSha256, setSeparatorConfigurationSha256] = useState('')
  const [harmonyLoading, setHarmonyLoading] = useState(false)
  const [harmonySaving, setHarmonySaving] = useState(false)
  const [harmonyMessage, setHarmonyMessage] = useState<string | null>(null)

  const refreshLibrary = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setSongs(await window.api.scanDatasetLibrary())
    } catch {
      setError('Could not scan the current library.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isOpen) void refreshLibrary()
  }, [isOpen, refreshLibrary])

  useEffect(() => {
    if (!isOpen || catalogParent?.parentId) return
    const storedParentId = localStorage.getItem(CATALOG_PARENT_STORAGE_KEY)
    const restore = storedParentId
      ? window.api.restoreDatasetCatalogParent(storedParentId)
      : window.api.useDefaultDatasetCatalogParent()
    void restore.then((parent) => {
      if (parent) {
        setCatalogParent(parent)
        return
      }
      void window.api.useDefaultDatasetCatalogParent().then((defaultParent) => {
        if (defaultParent) setCatalogParent(defaultParent)
      })
    })
  }, [catalogParent, isOpen])

  useEffect(() => {
    if (!catalogParent) return
    localStorage.setItem(CATALOG_PARENT_STORAGE_KEY, catalogParent.parentId)
    void window.api.listDatasetCatalogs(catalogParent.parentId).then(setExistingCatalogs)
  }, [catalogParent])

  useEffect(() => {
    if (!isOpen) {
      setHasInitializedOpening(false)
      return
    }
    if (hasInitializedOpening) return
    if (!hasSeenLearn) {
      setActiveStep('learn')
      setHasInitializedOpening(true)
      return
    }
    if (!catalogParent) return
    let current = true
    void window.api.listDatasetCatalogs(catalogParent.parentId).then((catalogs) => {
      if (!current) return
      setExistingCatalogs(catalogs)
      const existingCatalog = catalogs[0]
      if (existingCatalog) {
        setSelectedCatalog(existingCatalog)
        setSaveMode('update')
        setCatalogName(existingCatalog.catalogName)
        setCatalogId(existingCatalog.catalogId)
        setProvenance(existingCatalog.provenance)
        setLicense(existingCatalog.license)
        setActiveStep('prepare')
      } else {
        setSelectedCatalog(null)
        setSaveMode('create')
        setActiveStep('curate')
      }
      setHasInitializedOpening(true)
    })
    return () => {
      current = false
    }
  }, [catalogParent, hasInitializedOpening, hasSeenLearn, isOpen])

  useEffect(() => {
    if (!isOpen || activeStep !== 'learn') return
    localStorage.setItem(TRAINING_LEARN_SEEN_STORAGE_KEY, 'true')
    setHasSeenLearn(true)
  }, [activeStep, isOpen])

  useEffect(() => {
    const unsubscribeScan = window.api.onDatasetScanProgress(setScanProgress)
    const unsubscribeSave = window.api.onDatasetSaveProgress(setSaveProgress)
    const unsubscribeInventory = window.api.onDatasetPackageInventoryProgress(setInventoryProgress)
    return () => {
      unsubscribeScan()
      unsubscribeSave()
      unsubscribeInventory()
    }
  }, [])

  const refreshTrainingState = useCallback(async (): Promise<void> => {
    const epoch = ++trainingRefreshEpoch.current
    const [runtime, pipelines, artifacts] = await Promise.all([
      window.api.getTrainingRuntime(),
      window.api.listTrainingPipelines(),
      window.api.listTrainingArtifacts()
    ])
    if (epoch !== trainingRefreshEpoch.current) return
    setTrainingRuntime(runtime)
    setTrainingPipelines(pipelines)
    setSelectedPipelineId((current) =>
      pipelines.some((pipeline) => pipeline.id === current) ? current : (pipelines[0]?.id ?? '')
    )
    setTrainingJob((current) => current ?? artifacts.jobs.at(-1) ?? null)
    setTrainingTasks(artifacts.tasks)
    setTrainingRuns(artifacts.runs)
    setTrainingProfiles(artifacts.profiles)
    setCompositionProfileIds(
      (current) =>
        new Set(
          [...current].filter((profileId) =>
            artifacts.profiles.some((profile) => profile.profileId === profileId)
          )
        )
    )
    setSelectedTaskViewId((current) =>
      artifacts.tasks.some((task) => task.taskViewId === current)
        ? current
        : (artifacts.tasks[0]?.taskViewId ?? '')
    )
  }, [])

  useEffect(() => {
    if (isOpen) void refreshTrainingState()
  }, [isOpen, refreshTrainingState])

  useEffect(() => {
    setSelectedTaskViewId((current) =>
      selectedPipelineTasks.some((task) => task.taskViewId === current)
        ? current
        : (selectedPipelineTasks[0]?.taskViewId ?? '')
    )
  }, [selectedPipelineTasks])

  useEffect(() => {
    setPromotionArtifactId((current) =>
      promotionRuns.some((run) => run.artifactId === current)
        ? current
        : (promotionRuns[0]?.artifactId ?? '')
    )
  }, [promotionRuns])

  useEffect(() => {
    if (!promotionArtifactId) {
      setPromotionJobs([])
      return
    }
    let current = true
    void window.api
      .listTrainingPromotionJobs(promotionArtifactId)
      .then((jobs) => {
        if (current) setPromotionJobs(jobs)
      })
      .catch(() => {
        if (current) setPromotionJobs([])
      })
    return () => {
      current = false
    }
  }, [promotionArtifactId, trainingRuns])

  useEffect(() => {
    const unsubscribe = window.api.onTrainingProgress((event) => {
      setTrainingJob({
        jobId: event.jobId,
        sequence: event.sequence,
        stage: event.stage,
        progress: event.progress,
        state: event.state,
        code: event.code,
        message: event.message
      })
      if (event.state === 'succeeded') {
        const promotion = event.result as TrainingPromotionResult | undefined
        if (promotion?.format === 'strum-post-train-job-result/v1') {
          setPromotionResults((current) => [
            ...current.filter((result) => result.promotionId !== promotion.promotionId),
            promotion
          ])
          if (promotion.artifactId && promotion.deploymentStatus === 'ready') {
            setSelectedArtifactId(promotion.artifactId)
            setActiveStep('deploy')
          }
        }
        const composition = event.result as Record<string, unknown> | undefined
        if (
          composition?.format === 'octave-strum-profile-composition-result/v1' &&
          Array.isArray(composition.instruments) &&
          composition.instruments.every((instrument) => typeof instrument === 'string')
        ) {
          const supported = new Set(composition.instruments)
          updateSettings({
            autoChartEnabledTracks: {
              drums: supported.has('drums'),
              guitar: supported.has('guitar'),
              bass: supported.has('bass'),
              vocals: false,
              harmonies: false,
              keys: supported.has('keys'),
              proKeys: false
            }
          })
          setCompositionProfileIds(new Set())
          setActiveStep('deploy')
        }
        void refreshTrainingState()
      }
      if (event.state === 'failed') setError(event.message)
    })
    return unsubscribe
  }, [refreshTrainingState, updateSettings])

  useEffect(() => {
    if (
      activeStep !== 'prepare' ||
      !catalogParent ||
      !selectedCatalog ||
      !selectedPipelineId ||
      !trainingRuntime?.capabilities.includes('training')
    ) {
      setCatalogInspection(null)
      return
    }
    let current = true
    void window.api
      .inspectTrainingCatalog({
        parentId: catalogParent.parentId,
        catalogName: selectedCatalog.catalogName,
        pipelineId: selectedPipelineId,
        prepare: resolvedPrepareConfig
      })
      .then((inspection) => {
        if (current) setCatalogInspection(inspection)
      })
      .catch(() => {
        if (current) setCatalogInspection(null)
      })
    return () => {
      current = false
    }
  }, [
    activeStep,
    catalogParent,
    resolvedPrepareConfig,
    selectedCatalog,
    selectedPipelineId,
    trainingRuntime
  ])

  useEffect(() => {
    if (activeStep !== 'deploy' || !selectedArtifactId) {
      setSelectedDiscoveredCheckpoint(null)
      return
    }
    let current = true
    setSelectedDiscoveredCheckpoint(null)
    void window.api
      .inspectDiscoveredTrainingCheckpoint(selectedArtifactId)
      .then((checkpoint) => {
        if (!current) return
        setSelectedDiscoveredCheckpoint(checkpoint)
        const availableProfile = checkpoint.profiles.find(
          (profile) => profile.execution.status === 'available'
        )
        setSelectedDiscoveredProfileId(availableProfile?.profileId ?? '')
        setSelectedDifficultyPolicy(availableProfile?.execution.difficultyPolicies[0] ?? '')
      })
      .catch(() => {
        if (current) setSelectedDiscoveredCheckpoint(null)
      })
    return () => {
      current = false
    }
  }, [activeStep, selectedArtifactId])

  useEffect(() => {
    if (scanningPackages) {
      onActivityChange({
        step: 'curate',
        phase: 'Scanning sources',
        completed: scanProgress?.completed ?? 0,
        total: scanProgress?.total ?? 0
      })
      return
    }
    if (inventoryingGroupId) {
      onActivityChange({
        step: 'curate',
        phase: 'Inventorying source packages',
        completed: inventoryProgress?.processedPackageCount ?? 0,
        total: inventoryProgress?.totalPackageCount ?? 0
      })
      return
    }
    if (exporting) {
      onActivityChange({
        step: 'curate',
        phase: `Saving ${saveProgress?.phase ?? 'catalog'}`,
        completed: saveProgress?.completed ?? 0,
        total: saveProgress?.total ?? 0
      })
      return
    }
    if (trainingJob && !['succeeded', 'failed', 'cancelled'].includes(trainingJob.state ?? '')) {
      onActivityChange({
        step: trainingJob.stage === 'training' ? 'train' : 'prepare',
        phase: trainingJob.message,
        completed: Math.round((trainingJob.progress ?? 0) * 100),
        total: 100
      })
      return
    }
    onActivityChange(null)
  }, [
    exporting,
    inventoryingGroupId,
    inventoryProgress,
    onActivityChange,
    saveProgress,
    scanProgress,
    scanningPackages,
    trainingJob
  ])

  useEffect(() => {
    if (!catalogParent || !selectedCatalog) {
      setHarmonyTargets([])
      setHarmonyTargetId('')
      return
    }
    let active = true
    setHarmonyLoading(true)
    setHarmonyMessage(null)
    void window.api
      .listDatasetCatalogHarmonyTargets(catalogParent.parentId, selectedCatalog.catalogName)
      .then((targets) => {
        if (!active) return
        setHarmonyTargets(targets)
        setHarmonyTargetId((current) =>
          targets.some((target) => target.sourceId === current)
            ? current
            : (targets[0]?.sourceId ?? '')
        )
      })
      .catch(() => {
        if (active) setHarmonyMessage('Could not validate this catalog’s Harmony targets.')
      })
      .finally(() => {
        if (active) setHarmonyLoading(false)
      })
    return () => {
      active = false
    }
  }, [catalogParent, selectedCatalog])

  const allowedLibrarySongs = useMemo(
    () => songs.filter((song) => song.trainingUse === 'allowed' && song.midiValid),
    [songs]
  )

  const selectableLibrarySongs = useMemo(
    () => songs.filter((song) => song.midiValid && !song.isStrumGenerated),
    [songs]
  )
  const packageCandidates = useMemo(
    () => packageGroups.flatMap((group) => group.candidates),
    [packageGroups]
  )
  const selectedPackageCandidates = useMemo(
    () => packageCandidates.filter((candidate) => selectedPackages.has(candidate.candidateId)),
    [packageCandidates, selectedPackages]
  )
  const allLibrarySongsSelected =
    selectableLibrarySongs.length > 0 &&
    selectableLibrarySongs.every((song) => song.trainingUse === 'allowed')

  if (!isOpen) return null

  const toggleSong = async (song: SourceCandidate): Promise<void> => {
    const optedIn = song.trainingUse !== 'allowed'
    setError(null)
    setSongs((current) =>
      current.map((entry) =>
        entry.candidateId === song.candidateId
          ? { ...entry, trainingUse: optedIn ? 'allowed' : 'review_required' }
          : entry
      )
    )
    if (!(await window.api.setDatasetSongOptIn(song.candidateId, optedIn))) {
      setSongs((current) =>
        current.map((entry) =>
          entry.candidateId === song.candidateId
            ? { ...entry, trainingUse: song.trainingUse }
            : entry
        )
      )
      setError('Could not save that song’s dataset consent setting.')
    }
  }

  const toggleAllLibrarySongs = async (): Promise<void> => {
    const optedIn = !allLibrarySongsSelected
    const previousTrainingUse = new Map(
      selectableLibrarySongs.map((song) => [song.candidateId, song.trainingUse])
    )
    setError(null)
    setSongs((current) =>
      current.map((song) =>
        song.midiValid ? { ...song, trainingUse: optedIn ? 'allowed' : 'review_required' } : song
      )
    )
    const results = await Promise.all(
      selectableLibrarySongs.map(async (song) => [
        song.candidateId,
        await window.api.setDatasetSongOptIn(song.candidateId, optedIn)
      ])
    )
    const failedIds = new Set(
      results.filter(([, succeeded]) => !succeeded).map(([candidateId]) => candidateId)
    )
    if (failedIds.size) {
      setSongs((current) =>
        current.map((song) =>
          failedIds.has(song.candidateId)
            ? {
                ...song,
                trainingUse: previousTrainingUse.get(song.candidateId) ?? song.trainingUse
              }
            : song
        )
      )
      setError('Could not save consent for every selected song.')
    }
  }

  const addPackageFolder = async (): Promise<void> => {
    setScanningPackages(true)
    setScanProgress({ phase: 'discovering', completed: 0, total: 0 })
    setError(null)
    try {
      const discovered = await window.api.chooseDatasetPackageFolder()
      if (discovered) setPackageGroups((current) => [...current, discovered])
    } catch {
      setError('Could not scan the selected source folder.')
    } finally {
      setScanningPackages(false)
      setScanProgress(null)
    }
  }

  const cancelPackageFolderScan = async (): Promise<void> => {
    await window.api.cancelDatasetPackageDiscovery()
  }

  const removePackageGroup = async (group: PackageGroup): Promise<void> => {
    await window.api.removeDatasetPackageGroup(
      group.candidates.map((candidate) => candidate.candidateId),
      group.groupId
    )
    setPackageGroups((current) => current.filter((entry) => entry.groupId !== group.groupId))
    setSelectedPackages((current) => {
      const next = new Set(current)
      for (const candidate of group.candidates) next.delete(candidate.candidateId)
      return next
    })
  }

  const inventoryPackageGroup = async (group: PackageGroup): Promise<void> => {
    setInventoryingGroupId(group.groupId)
    setInventoryProgress({
      processedPackageCount: 0,
      completedPackageCount: 0,
      totalPackageCount: group.candidates.length
    })
    setError(null)
    try {
      const response = await window.api.inspectDatasetPackageGroup(
        group.groupId,
        group.resumeCursor
      )
      if (!response) throw new Error('Package inventory unavailable')
      if (response.cursorRejected) {
        setPackageGroups((current) =>
          current.map((entry) =>
            entry.groupId === group.groupId ? { ...entry, resumeCursor: undefined } : entry
          )
        )
        setError('The previous inventory cursor is no longer valid. Start a new inventory.')
        return
      }
      const inventory = response.inventory
      if (!inventory) throw new Error('Package inventory unavailable')
      const resumeCursor = response.resumeCursor ?? undefined
      setPackageGroups((current) =>
        current.map((entry) =>
          entry.groupId === group.groupId
            ? {
                ...entry,
                inventory,
                resumeCursor,
                candidates: response.reviewCandidates ?? entry.candidates
              }
            : entry
        )
      )
      if (response.reviewCandidates) {
        setSelectedPackages((current) => {
          const next = new Set(current)
          for (const candidate of group.candidates) next.delete(candidate.candidateId)
          return next
        })
      }
    } catch {
      setError('Could not inventory the selected package sources.')
    } finally {
      setInventoryingGroupId(null)
      setInventoryProgress(null)
    }
  }

  const cancelPackageInventory = async (groupId: string): Promise<void> => {
    await window.api.cancelDatasetPackageInventory(groupId)
  }

  const togglePackage = async (candidate: SourceCandidate): Promise<void> => {
    const approved = !selectedPackages.has(candidate.candidateId)
    setSelectedPackages((current) => {
      const next = new Set(current)
      if (approved) next.add(candidate.candidateId)
      else next.delete(candidate.candidateId)
      return next
    })
    if (!(await window.api.setDatasetPackageApproved(candidate.candidateId, approved))) {
      setSelectedPackages((current) => {
        const next = new Set(current)
        if (approved) next.delete(candidate.candidateId)
        else next.add(candidate.candidateId)
        return next
      })
      setError('Could not save that package review decision.')
    }
  }

  const chooseCatalogParent = async (): Promise<void> => {
    const selected = await window.api.chooseDatasetCatalogParent()
    if (selected) {
      setCatalogParent(selected)
      setSelectedCatalog(null)
      setSaveMode('create')
      setExistingCatalogs([])
      setResult(null)
      setSaveProgress(null)
    }
  }

  const chooseExistingCatalog = (catalog: ExistingCatalog): void => {
    setSelectedCatalog(catalog)
    setSaveMode('update')
    setAudioEnrichmentCandidateId(null)
    setCatalogName(catalog.catalogName)
    setCatalogId(catalog.catalogId)
    setProvenance(catalog.provenance)
    setLicense(catalog.license)
  }

  const startNewCatalog = (): void => {
    setSelectedCatalog(null)
    setSaveMode('create')
    setAudioEnrichmentCandidateId(null)
  }

  const cloneCatalogRevision = (): void => {
    if (!selectedCatalog) return
    setSaveMode('clone')
    setAudioEnrichmentCandidateId(null)
    setCatalogName(`${selectedCatalog.catalogName}-revision`)
    setCatalogId(`${selectedCatalog.catalogId}-revision`)
  }

  const beginAudioEnrichmentRevision = (): void => {
    if (!selectedCatalog || selectedPackageCandidates.length !== 1) {
      setError('Select exactly one reviewed package chart to create an audio-enriched revision.')
      return
    }
    setError(null)
    setSaveMode('clone')
    setAudioEnrichmentCandidateId(selectedPackageCandidates[0].candidateId)
    setCatalogName(`${selectedCatalog.catalogName}-audio-revision`)
    setCatalogId(`${selectedCatalog.catalogId}-audio-revision`)
  }

  const buildAudioEnrichmentRevision = async (): Promise<void> => {
    if (!catalogParent || !selectedCatalog || !audioEnrichmentCandidateId) {
      setError('Select a catalog and one reviewed package chart before audio enrichment.')
      return
    }
    const effectiveCatalogName = catalogName.trim()
    const effectiveCatalogId = catalogId.trim()
    if (!effectiveCatalogName || !effectiveCatalogId) {
      setError('Catalog ID and revision name are required.')
      return
    }
    setExporting(true)
    setSaveProgress({ phase: 'checking', completed: 0, total: 1 })
    setError(null)
    setResult(null)
    try {
      const response = await window.api.enrichSongSourceCatalogAudio({
        candidateId: audioEnrichmentCandidateId,
        parentId: catalogParent.parentId,
        catalogName: effectiveCatalogName,
        catalogId: effectiveCatalogId,
        sourceCatalogName: selectedCatalog.catalogName
      })
      const refreshedCatalogs = await window.api.listDatasetCatalogs(catalogParent.parentId)
      setExistingCatalogs(refreshedCatalogs)
      const savedCatalog = refreshedCatalogs.find(
        (catalog) => catalog.catalogName === effectiveCatalogName
      )
      if (!savedCatalog) throw new Error('Audio revision was not published.')
      setResult({ records: response.recordCount, skipped: response.skipped.length })
      setSelectedCatalog(savedCatalog)
      setAudioEnrichmentCandidateId(null)
      setSaveMode('update')
      setActiveStep('prepare')
    } catch {
      setError(
        'Audio revision was not published. The selected chart may have changed, not match this catalog, or have unsupported audio.'
      )
    } finally {
      setExporting(false)
      setSaveProgress(null)
    }
  }

  const buildCatalog = async (catalogToUpdate?: ExistingCatalog): Promise<void> => {
    const targetCatalog = catalogToUpdate ?? selectedCatalog
    const mode = catalogToUpdate ? 'update' : saveMode
    const effectiveCatalogName = catalogToUpdate?.catalogName ?? catalogName.trim()
    const effectiveCatalogId = catalogToUpdate?.catalogId ?? catalogId.trim()
    const effectiveProvenance = provenance.trim() || catalogToUpdate?.provenance || ''
    const effectiveLicense = license.trim() || catalogToUpdate?.license || ''
    if (
      !catalogParent ||
      !effectiveCatalogName ||
      !effectiveCatalogId ||
      !effectiveProvenance ||
      !effectiveLicense
    ) {
      setError(
        'Catalog ID, catalog name, provenance, license, and a parent directory are required.'
      )
      return
    }
    if ((mode === 'update' || mode === 'clone') && !targetCatalog) {
      setError('Select an existing catalog to update or clone.')
      return
    }
    const candidateIds = [
      ...songs
        .filter((song) => song.midiValid && song.trainingUse === 'allowed')
        .map((song) => song.candidateId),
      ...packageCandidates
        .filter((entry) => selectedPackages.has(entry.candidateId))
        .map((entry) => entry.candidateId)
    ]
    setExporting(true)
    setSaveProgress({ phase: 'normalizing', completed: 0, total: candidateIds.length })
    setError(null)
    setResult(null)
    try {
      const response = await window.api.buildSongSourceCatalog({
        candidateIds,
        parentId: catalogParent.parentId,
        catalogName: effectiveCatalogName,
        catalogId: effectiveCatalogId,
        provenance: effectiveProvenance,
        license: effectiveLicense,
        mode,
        sourceCatalogName: targetCatalog?.catalogName
      })
      const refreshedCatalogs = await window.api.listDatasetCatalogs(catalogParent.parentId)
      setExistingCatalogs(refreshedCatalogs)
      const savedCatalog = refreshedCatalogs.find(
        (catalog) => catalog.catalogName === effectiveCatalogName
      )
      if (!savedCatalog) {
        throw new Error('Catalog build completed without publishing the requested catalog.')
      }
      setResult({
        records: response.recordCount,
        skipped: response.skipped.length
      })
      setSelectedCatalog(savedCatalog)
      setSaveMode('update')
      setActiveStep('prepare')
    } catch {
      setError(
        'Catalog was not published. It may have been interrupted; restart OCTAVE and retry with a new catalog name.'
      )
    } finally {
      setExporting(false)
      setSaveProgress(null)
    }
  }

  const updateCatalog = (catalog: ExistingCatalog): void => {
    // Updating is intentionally independent of selection state. React state
    // updates are asynchronous, so first selecting a row here could otherwise
    // leave the save request with stale curation fields.
    void buildCatalog(catalog)
  }

  const chooseDeveloperRuntime = async (): Promise<void> => {
    if (enablingTrainingRuntime) return
    ++trainingRefreshEpoch.current
    setEnablingTrainingRuntime(true)
    setError(null)
    try {
      const runtime = await window.api.chooseDeveloperTrainingRuntime()
      if (!runtime?.capabilities.includes('training')) {
        setError('No compatible local STRUM training runtime was found.')
        return
      }
      // The main process only returns after it has persisted the validated
      // runtime lock. Keep the renderer on this exact DTO until the refresh
      // completes so a user cannot race into a bundled worker action.
      setTrainingRuntime(runtime)
      await refreshTrainingState()
    } catch {
      setError('Choose a folder containing STRUM’s versioned worker.')
    } finally {
      setEnablingTrainingRuntime(false)
    }
  }

  const chooseInstalledRuntime = async (): Promise<void> => {
    ++trainingRefreshEpoch.current
    setError(null)
    const runtime = await window.api.chooseInstalledTrainingRuntime()
    if (!runtime?.capabilities.includes('training')) {
      setError('The selected STRUM worker is not compatible with OCTAVE training.')
      return
    }
    await refreshTrainingState()
  }

  const discoverCheckpointFolder = async (): Promise<void> => {
    if (enablingTrainingRuntime) return
    setDiscoveringCheckpoints(true)
    setError(null)
    try {
      const discovery = await window.api.chooseTrainingCheckpointFolder()
      if (!discovery) return
      setCheckpointDiscovery(discovery)
      setSelectedArtifactId('')
      setSelectedDiscoveredCheckpoint(null)
      setSelectedDiscoveredProfileId('')
      setSelectedDifficultyPolicy('')
    } catch {
      setError('STRUM could not discover verified model bundles in that folder.')
    } finally {
      setDiscoveringCheckpoints(false)
    }
  }

  const saveSelectedAutoChartProfile = async (): Promise<void> => {
    if (
      enablingTrainingRuntime ||
      !selectedDiscoveredCheckpoint ||
      selectedDiscoveredCheckpoint.deploymentStatus !== 'ready' ||
      !selectedDiscoveredProfile ||
      selectedDiscoveredProfile.execution.status !== 'available' ||
      !selectedDiscoveredProfile.execution.difficultyPolicies.includes(selectedDifficultyPolicy)
    ) {
      return
    }
    setSavingAutoChartProfile(true)
    setError(null)
    try {
      await window.api.saveDiscoveredAutoChartProfile({
        artifactId: selectedDiscoveredCheckpoint.artifactId,
        profileId: selectedDiscoveredProfile.profileId,
        difficultyPolicy: selectedDifficultyPolicy
      })
      const supported = new Set(selectedDiscoveredProfile.instruments)
      // A typed profile is authoritative about which chart tracks it can
      // generate. Keep the Auto Chart dialog aligned with the saved default so
      // its explicit selection reaches STRUM unchanged instead of silently
      // requesting legacy-only tracks.
      updateSettings({
        autoChartEnabledTracks: {
          drums: supported.has('drums'),
          guitar: supported.has('guitar'),
          bass: supported.has('bass'),
          vocals: supported.has('vocals'),
          harmonies: false,
          keys: supported.has('keys'),
          proKeys: supported.has('pro_keys')
        }
      })
      await refreshTrainingState()
    } catch {
      setError('STRUM did not validate this checkpoint for Auto Chart.')
    } finally {
      setSavingAutoChartProfile(false)
    }
  }

  const prepareDataset = async (): Promise<void> => {
    if (enablingTrainingRuntime || !catalogParent || !selectedCatalog || !selectedPipelineId) return
    setError(null)
    try {
      const started = await window.api.prepareTrainingDataset({
        parentId: catalogParent.parentId,
        catalogId: selectedCatalog.catalogId,
        catalogName: selectedCatalog.catalogName,
        pipelineId: selectedPipelineId,
        prepare: resolvedPrepareConfig
      })
      setTrainingJob({
        jobId: started.jobId,
        sequence: 0,
        stage: 'queued',
        state: 'queued',
        progress: 0,
        message: 'Preparing the catalog locally.'
      })
    } catch {
      setError('STRUM could not start catalog preparation.')
    }
  }

  const transformMidi = async (): Promise<void> => {
    const runId = crypto.randomUUID()
    setTransformRunId(runId)
    setTransformOutput('')
    setError(null)
    try {
      const result = await window.api.transformTrainingMidi({ runId, includeAudio: transformAudio })
      if (!result.cancelled) setTransformOutput(result.outputName ?? '')
    } catch {
      setError(
        'STRUM could not transform the selected chart. Check the profile and its source chart/audio requirements.'
      )
    } finally {
      setTransformRunId('')
    }
  }

  const startTraining = async (): Promise<void> => {
    if (enablingTrainingRuntime || !selectedTaskViewId || !selectedPipelineId) return
    setError(null)
    try {
      const started = await window.api.startTrainingRun({
        taskViewId: selectedTaskViewId,
        pipelineId: selectedPipelineId,
        train: {
          ...resolvedTrainConfig,
          ...(resolvedTrainConfig.checkpoint_mode === 'fine_tune'
            ? { parent_artifact_id: parentArtifactId }
            : {})
        }
      })
      setTrainingJob({
        jobId: started.jobId,
        sequence: 0,
        stage: 'queued',
        state: 'queued',
        progress: 0,
        message: 'Queuing STRUM training locally.'
      })
    } catch {
      setError('STRUM could not start this training run.')
    }
  }

  const startPromotion = async (job: StrumPromotionJobDescriptor): Promise<void> => {
    if (enablingTrainingRuntime || !promotionArtifactId || job.status !== 'available') return
    setError(null)
    try {
      const controls = trainingSchemaControls(job.options_schema)
      const options = schemaConfig(controls, promotionConfigs[job.id] ?? {})
      const started = await window.api.startTrainingPromotionJob({
        candidateArtifactId: promotionArtifactId,
        jobId: job.id,
        options
      })
      setTrainingJob({
        jobId: started.jobId,
        sequence: 0,
        stage: 'post_training_promotion',
        state: 'queued',
        progress: 0,
        message: `Queuing ${job.display_name} locally.`
      })
    } catch {
      setError('STRUM could not start this post-training job.')
    }
  }

  const startProfileComposition = async (): Promise<void> => {
    if (
      enablingTrainingRuntime ||
      compositionProfileIds.size < 2 ||
      compositionProfileIds.size > 4
    ) {
      return
    }
    setError(null)
    try {
      const started = await window.api.composeAutoChartProfiles({
        profileIds: [...compositionProfileIds]
      })
      setTrainingJob({
        jobId: started.jobId,
        sequence: 0,
        stage: 'checkpoint_composition',
        state: 'queued',
        progress: 0,
        message: 'Composing selected validated STRUM profiles locally.'
      })
    } catch {
      setError('STRUM could not compose the selected validated profiles.')
    }
  }

  const cancelActiveTrainingJob = async (): Promise<void> => {
    if (!trainingJob) return
    await window.api.cancelTrainingJob(trainingJob.jobId)
  }

  const trainingStepBlocker = (step: TrainingStep): string | null => {
    if (enablingTrainingRuntime && step !== 'prepare') {
      return 'STRUM runtime setup is still being verified.'
    }
    if (step === 'prepare' && !selectedCatalog) {
      return 'Create or select a catalog before preparing a dataset.'
    }
    if (step === 'train' && selectedPipelineTasks.length === 0) {
      return 'Prepare a task view for the selected pipeline before training.'
    }
    return null
  }

  const selectedHarmonyTarget = harmonyTargets.find((target) => target.sourceId === harmonyTargetId)

  const chooseHarmonyAudio = async (): Promise<void> => {
    const selected = await window.api.chooseDatasetHarmonyAudio()
    if (selected) setHarmonyAudio(selected)
  }

  const materializeHarmonySource = async (): Promise<void> => {
    if (!catalogParent || !selectedCatalog || !selectedHarmonyTarget || !harmonyAudio) {
      setHarmonyMessage('Select a catalog HARM track and an explicit isolated audio source.')
      return
    }
    if (!selectedHarmonyTarget.tracks.includes(harmonyTrackName)) {
      setHarmonyMessage('The selected catalog source does not contain that exact HARM track.')
      return
    }
    const provenance =
      harmonyKind === 'isolated_source_stem/v1'
        ? { kind: harmonyKind, attestationId: harmonyAttestationId.trim() }
        : {
            kind: harmonyKind,
            separator: {
              id: separatorId.trim(),
              version: separatorVersion.trim(),
              modelSha256: separatorModelSha256.trim(),
              configurationSha256: separatorConfigurationSha256.trim()
            }
          }
    setHarmonySaving(true)
    setHarmonyMessage(null)
    try {
      const response = await window.api.materializeDatasetHarmonySource({
        parentId: catalogParent.parentId,
        catalogName: selectedCatalog.catalogName,
        sourceId: selectedHarmonyTarget.sourceId,
        trackName: harmonyTrackName,
        sourceSelectionId: harmonyAudio.selectionId,
        provenance
      })
      setHarmonyTargets((current) =>
        current.map((target) =>
          target.sourceId === response.sourceId
            ? { ...target, configuredTracks: response.configuredTracks }
            : target
        )
      )
      setHarmonyAudio(null)
      setHarmonyMessage(`${response.trackName} was materialized with explicit provenance.`)
    } catch {
      setHarmonyMessage('Harmony materialization failed. Verify the selected asset and provenance.')
    } finally {
      setHarmonySaving(false)
    }
  }

  const renderCandidate = (candidate: SourceCandidate, selectable: boolean): React.JSX.Element => {
    const packageCandidate = candidate as Partial<PackageCandidate>
    const packageInventory = packageCandidate.groupId
      ? packageGroups.find((group) => group.groupId === packageCandidate.groupId)?.inventory
      : undefined
    const packageReady = Boolean(packageInventory && !packageInventory.cancelled)
    const disabled =
      candidate.isStrumGenerated || (selectable ? !packageReady : !candidate.midiValid)
    return (
      <label className={disabled ? 'disabled' : ''} key={candidate.candidateId}>
        <input
          type="checkbox"
          checked={
            selectable
              ? selectedPackages.has(candidate.candidateId)
              : candidate.trainingUse === 'allowed'
          }
          disabled={disabled || exporting}
          onChange={() => {
            if (selectable) {
              void togglePackage(candidate)
            } else {
              void toggleSong(candidate)
            }
          }}
        />
        {!selectable && (
          <DatasetArtwork candidateId={candidate.candidateId} label={candidateLabel(candidate)} />
        )}
        <span>
          <strong>{candidateLabel(candidate)}</strong>
          <small>
            {candidate.kind} ·{' '}
            {selectable
              ? packageReady
                ? 'inventory complete'
                : 'inventory required'
              : candidate.midiValid
                ? 'valid MIDI'
                : 'invalid MIDI'}{' '}
            ·{' '}
            {selectable
              ? candidate.isStrumGenerated
                ? 'Generated revision unverified · training unavailable'
                : candidate.canonicalVocalMidi
                  ? 'canonical Vocal MIDI · select to explicitly include'
                  : 'MIDI-backed · select to explicitly include'
              : candidate.trainingUse.replace('_', ' ')}
            {!selectable && candidate.isStrumGenerated ? ' · STRUM generated' : ''}
            {Object.entries(candidate.instruments)
              .map(([instrument, coverage]) => `${instrument}: ${coverage.difficulties.join('/')}`)
              .join(', ')}
            {candidate.isStrumGenerated
              ? ' · Training is unavailable until manual edits and approval can be verified against a preserved baseline.'
              : ''}
            {candidate.warnings.length
              ? ` · ${candidate.warnings.map((warning) => warning.code).join(', ')}`
              : ''}
          </small>
        </span>
      </label>
    )
  }

  return (
    <div className="dataset-curation-overlay" onClick={onClose}>
      <section
        className="dataset-curation-modal"
        onClick={(event) => event.stopPropagation()}
        aria-modal="true"
        role="dialog"
      >
        <header className="training-header">
          <h2>
            <span aria-hidden="true">🧪</span> Training
          </h2>
          <nav className="training-steps" aria-label="Training steps">
            {TRAINING_STEPS.map((step, index) => {
              const activeStepIndex = TRAINING_STEPS.indexOf(activeStep)
              const blocker = trainingStepBlocker(step)
              return (
                <span
                  key={step}
                  className={`training-step ${activeStep === step ? 'active' : index < activeStepIndex ? 'complete' : ''}${blocker ? ' blocked' : ''}`}
                  aria-describedby={blocker ? `${step}-blocker` : undefined}
                  tabIndex={blocker ? 0 : undefined}
                >
                  <button
                    className={
                      activeStep === step ? 'active' : index < activeStepIndex ? 'complete' : ''
                    }
                    disabled={blocker !== null}
                    onClick={() => setActiveStep(step)}
                  >
                    <span className="training-step-orb" aria-hidden="true">
                      <TrainingStepIcon step={step} complete={index < activeStepIndex} />
                    </span>
                    <span className="training-step-label">{step}</span>
                  </button>
                  {blocker && (
                    <span className="training-step-blocker" id={`${step}-blocker`} role="tooltip">
                      {blocker}
                    </span>
                  )}
                </span>
              )
            })}
          </nav>
          <button className="dataset-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <main>
          <p className="training-step-summary">{TRAINING_STEP_TAGLINES[activeStep]}</p>
          {error && <p className="dataset-message error">{error}</p>}
          {result && (
            <p className="dataset-message success">
              Created {result.records} allowed catalog records; skipped {result.skipped}.
            </p>
          )}
          {scanningPackages && (
            <p className="dataset-message progress" aria-live="polite">
              {scanProgress?.phase === 'discovering'
                ? `Finding packages — checked ${scanProgress.completed} folders.`
                : `Scanning selected sources — ${scanProgress?.completed ?? 0} of ${scanProgress?.total ?? '?'}.`}{' '}
              You can close this window while OCTAVE checks each package.
            </p>
          )}
          {exporting && (
            <p className="dataset-message progress" aria-live="polite">
              Saving catalog — {saveProgress?.phase ?? 'preparing'} {saveProgress?.completed ?? 0}{' '}
              of {saveProgress?.total ?? '?'}.
            </p>
          )}
          {activeStep === 'learn' ? (
            <section className="training-learn">
              <div className="training-learn-intro">
                <h3>
                  <span className="dataset-heading-icon" aria-hidden="true">
                    ✦
                  </span>{' '}
                  Train thoughtfully
                </h3>
                <p>
                  Training turns a catalog of approved songs into local STRUM checkpoints. OCTAVE
                  keeps the catalog, task views, and eventual profiles as local inputs and outputs.
                </p>
              </div>
              <div className="training-learn-runtime">
                <span
                  className={`training-runtime-dot ${trainingRuntime?.capabilities.includes('training') ? 'ready' : ''}`}
                  aria-hidden="true"
                />
                <div>
                  <strong>
                    {trainingRuntime?.displayName ?? 'Checking your local STRUM runtime…'}
                  </strong>
                  <small>
                    {trainingRuntime
                      ? `${trainingRuntime.capabilities.includes('training') ? 'Training available' : 'Inference only'} · ${trainingRuntime.deviceSupport.join(', ').toUpperCase()} · all artifacts remain local`
                      : 'OCTAVE checks the runtime before it enables any training step.'}
                  </small>
                </div>
              </div>
              <ol className="training-learn-path">
                {TRAINING_STEP_DETAILS.map((detail, index) => (
                  <li key={detail.step}>
                    <span aria-hidden="true">{index + 1}</span>
                    <div>
                      <strong>{detail.title}</strong>
                      <p>{detail.description}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <aside className="training-use-notice">
                <strong>Personal and offline use</strong>
                <p>
                  Only train with music you own or have clear permission to use. Keep trained models
                  offline, and do not share them unless every training input is music you own.
                </p>
              </aside>
            </section>
          ) : activeStep === 'curate' ? (
            <>
              <section className="dataset-section dataset-details">
                <h3>
                  <span className="dataset-heading-icon" aria-hidden="true">
                    📚
                  </span>{' '}
                  Catalog editor
                </h3>
                <label className="dataset-catalog-parent">
                  Catalog parent
                  <div className="dataset-output">
                    <input
                      value={catalogParent?.name ?? ''}
                      readOnly
                      placeholder="Preparing Catalog Parent"
                    />
                    <button onClick={() => void chooseCatalogParent()} disabled={exporting}>
                      <span aria-hidden="true">📁</span> Choose
                    </button>
                  </div>
                </label>
                <div className="dataset-catalog-picker">
                  <div className="dataset-section-actions">
                    <button onClick={startNewCatalog} disabled={exporting}>
                      <span aria-hidden="true">＋</span> New catalog
                    </button>
                    {saveMode === 'create' && (
                      <button onClick={() => void buildCatalog()} disabled={exporting}>
                        <span aria-hidden="true">↗</span> Create catalog
                      </button>
                    )}
                    {saveMode === 'clone' && (
                      <>
                        {!audioEnrichmentCandidateId && (
                          <button onClick={() => void buildCatalog()} disabled={exporting}>
                            <span aria-hidden="true">⎇</span> Create revision
                          </button>
                        )}
                        {audioEnrichmentCandidateId && (
                          <button
                            onClick={() => void buildAudioEnrichmentRevision()}
                            disabled={exporting}
                          >
                            <span aria-hidden="true">♫</span> Create audio revision
                          </button>
                        )}
                      </>
                    )}
                    {selectedCatalog && (
                      <>
                        <button onClick={cloneCatalogRevision} disabled={exporting}>
                          <span aria-hidden="true">⎇</span> Clone as revision
                        </button>
                        <button
                          onClick={beginAudioEnrichmentRevision}
                          disabled={exporting || selectedPackageCandidates.length !== 1}
                          title="Select exactly one reviewed package chart, then create a new revision with only its matching audio roles."
                        >
                          <span aria-hidden="true">♫</span> Audio-enrich revision
                        </button>
                      </>
                    )}
                  </div>
                  {existingCatalogs.map((catalog) => {
                    const isSelected = selectedCatalog?.catalogName === catalog.catalogName
                    return (
                      <div
                        className={`dataset-catalog-row${isSelected ? ' selected' : ''}`}
                        key={catalog.catalogName}
                      >
                        <button
                          className="dataset-catalog-select"
                          onClick={() => chooseExistingCatalog(catalog)}
                          disabled={exporting}
                        >
                          <strong>{catalog.catalogName}</strong>
                          <small>
                            {catalog.recordCount} records · {catalog.libraryRecordCount} library ·{' '}
                            {catalog.externalRecordCount} external
                          </small>
                        </button>
                        {isSelected && saveMode === 'update' && (
                          <button
                            type="button"
                            className="dataset-catalog-update"
                            onClick={() => updateCatalog(catalog)}
                            disabled={exporting}
                          >
                            {exporting ? 'Updating…' : 'Update'}
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
                {saveMode === 'update' && selectedCatalog?.externalRecordCount ? (
                  <p className="dataset-message warning">
                    This catalog contains {selectedCatalog.externalRecordCount} package-backed
                    records. Updates retain them; removing them requires a separate confirmed
                    action.
                  </p>
                ) : null}
                {audioEnrichmentCandidateId ? (
                  <p className="dataset-message">
                    This creates a new revision only. OCTAVE verifies the reviewed chart’s MIDI hash
                    and snapshot, then replaces or adds matching audio roles without changing the
                    chart, source ID, or record-level rights.
                  </p>
                ) : null}
                <div className="dataset-editor-fields">
                  {selectedCatalog && (
                    <section className="dataset-section dataset-harmony-sources">
                      <div className="dataset-section-heading">
                        <div>
                          <h3>Vocal Harmony sources</h3>
                          <p>
                            Add only an explicit isolated <code>HARM1</code>, <code>HARM2</code>, or{' '}
                            <code>HARM3</code> source. OCTAVE never substitutes shared vocals or the
                            mix.
                          </p>
                        </div>
                      </div>
                      {harmonyLoading ? (
                        <p className="dataset-empty">Validating catalog HARM tracks…</p>
                      ) : harmonyTargets.length === 0 ? (
                        <p className="dataset-empty">
                          No allowed catalog records with exact HARM1, HARM2, or HARM3 MIDI tracks
                          are available.
                        </p>
                      ) : (
                        <>
                          <label>
                            Catalog source
                            <select
                              value={harmonyTargetId}
                              disabled={harmonySaving || exporting}
                              onChange={(event) => {
                                const sourceId = event.target.value
                                const target = harmonyTargets.find(
                                  (entry) => entry.sourceId === sourceId
                                )
                                setHarmonyTargetId(sourceId)
                                if (target && !target.tracks.includes(harmonyTrackName)) {
                                  setHarmonyTrackName(target.tracks[0])
                                }
                              }}
                            >
                              {harmonyTargets.map((target) => (
                                <option key={target.sourceId} value={target.sourceId}>
                                  {target.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Exact MIDI target
                            <select
                              value={harmonyTrackName}
                              disabled={harmonySaving || exporting}
                              onChange={(event) =>
                                setHarmonyTrackName(event.target.value as HarmonyTrackName)
                              }
                            >
                              {(selectedHarmonyTarget?.tracks ?? []).map((track) => (
                                <option key={track} value={track}>
                                  {track}
                                  {selectedHarmonyTarget?.configuredTracks.includes(track)
                                    ? ' (configured)'
                                    : ''}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Isolation provenance
                            <select
                              value={harmonyKind}
                              disabled={harmonySaving || exporting}
                              onChange={(event) =>
                                setHarmonyKind(
                                  event.target.value as
                                    | 'isolated_source_stem/v1'
                                    | 'isolated_separation_output/v1'
                                )
                              }
                            >
                              <option value="isolated_source_stem/v1">
                                Original isolated source stem
                              </option>
                              <option value="isolated_separation_output/v1">
                                Pinned separation output
                              </option>
                            </select>
                          </label>
                          {harmonyKind === 'isolated_source_stem/v1' ? (
                            <label>
                              Stem attestation ID
                              <input
                                value={harmonyAttestationId}
                                disabled={harmonySaving || exporting}
                                onChange={(event) => setHarmonyAttestationId(event.target.value)}
                                placeholder="licensed-stem-001"
                              />
                            </label>
                          ) : (
                            <div className="dataset-harmony-provenance">
                              <label>
                                Separator ID
                                <input
                                  value={separatorId}
                                  disabled={harmonySaving || exporting}
                                  onChange={(event) => setSeparatorId(event.target.value)}
                                  placeholder="demucs"
                                />
                              </label>
                              <label>
                                Separator version
                                <input
                                  value={separatorVersion}
                                  disabled={harmonySaving || exporting}
                                  onChange={(event) => setSeparatorVersion(event.target.value)}
                                  placeholder="v4"
                                />
                              </label>
                              <label>
                                Model SHA-256
                                <input
                                  value={separatorModelSha256}
                                  disabled={harmonySaving || exporting}
                                  onChange={(event) => setSeparatorModelSha256(event.target.value)}
                                  placeholder="64-character SHA-256"
                                />
                              </label>
                              <label>
                                Configuration SHA-256
                                <input
                                  value={separatorConfigurationSha256}
                                  disabled={harmonySaving || exporting}
                                  onChange={(event) =>
                                    setSeparatorConfigurationSha256(event.target.value)
                                  }
                                  placeholder="64-character SHA-256"
                                />
                              </label>
                            </div>
                          )}
                          <div className="dataset-output">
                            <input
                              value={harmonyAudio?.displayName ?? ''}
                              readOnly
                              placeholder="No audio selected"
                            />
                            <button
                              onClick={() => void chooseHarmonyAudio()}
                              disabled={harmonySaving || exporting}
                            >
                              Choose audio
                            </button>
                          </div>
                          <button
                            onClick={() => void materializeHarmonySource()}
                            disabled={harmonySaving || exporting || !harmonyAudio}
                          >
                            {harmonySaving
                              ? 'Materializing…'
                              : 'Materialize explicit Harmony source'}
                          </button>
                        </>
                      )}
                      {harmonyMessage && <p className="dataset-message">{harmonyMessage}</p>}
                    </section>
                  )}

                  <label>
                    Catalog ID
                    <input
                      value={catalogId}
                      onChange={(event) => setCatalogId(event.target.value)}
                      disabled={exporting || saveMode === 'update'}
                    />
                  </label>
                  <label>
                    License / permission basis
                    <input
                      placeholder="e.g. CC BY 4.0 or internal consent record"
                      value={license}
                      onChange={(event) => setLicense(event.target.value)}
                      disabled={exporting}
                    />
                  </label>
                  <label>
                    Catalog name
                    <input
                      value={catalogName}
                      onChange={(event) => setCatalogName(event.target.value)}
                      disabled={exporting || saveMode === 'update'}
                    />
                  </label>
                  <label>
                    Provenance
                    <input
                      value={provenance}
                      onChange={(event) => setProvenance(event.target.value)}
                      disabled={exporting}
                    />
                  </label>
                </div>
              </section>
              <section className="dataset-section">
                <div className="dataset-section-heading">
                  <div>
                    <h3>
                      <span className="dataset-heading-icon" aria-hidden="true">
                        🎵
                      </span>{' '}
                      Octave library
                    </h3>
                    <p>
                      Checking a reviewed human-authored song stores training consent in{' '}
                      <code>song.ini</code>. Recognized STRUM-generated songs remain excluded until
                      verified revision admission is available.
                    </p>
                  </div>
                  <div className="dataset-section-actions">
                    <button
                      onClick={() => void toggleAllLibrarySongs()}
                      disabled={loading || exporting || selectableLibrarySongs.length === 0}
                    >
                      <span aria-hidden="true">{allLibrarySongsSelected ? '−' : '✓'}</span>{' '}
                      {allLibrarySongsSelected ? 'Clear all' : 'Select all'}
                    </button>
                    <button onClick={() => void refreshLibrary()} disabled={loading || exporting}>
                      <span className={loading ? 'dataset-spin' : ''} aria-hidden="true">
                        ↻
                      </span>{' '}
                      {loading ? 'Refreshing…' : 'Refresh'}
                    </button>
                  </div>
                </div>
                <div className="dataset-song-list">
                  {loading ? (
                    <div className="dataset-library-loading" aria-live="polite">
                      <span className="dataset-loading-orbit" aria-hidden="true" />
                      <strong>Refreshing your library</strong>
                      <small>Finding songs, artwork, and saved curation consent…</small>
                    </div>
                  ) : (
                    songs.map((song) => renderCandidate(song, false))
                  )}
                  {!loading && songs.length === 0 && (
                    <p className="dataset-empty">
                      Open an Octave song library to curate its songs.
                    </p>
                  )}
                </div>
              </section>
              <section className="dataset-section">
                <div className="dataset-section-heading">
                  <div>
                    <h3>
                      <span className="dataset-heading-icon" aria-hidden="true">
                        📦
                      </span>{' '}
                      Additional packages
                    </h3>
                    <p>
                      Choose folders containing <code>.sng</code>, <code>.con</code>,{' '}
                      <code>.rb3con</code>, or <code>.zip</code>. OCTAVE parses and normalizes them
                      in the main process; this UI receives no source locations.
                    </p>
                  </div>
                  <button
                    aria-label={
                      scanningPackages ? 'Cancel package folder scan' : 'Add package folder'
                    }
                    className="dataset-icon-button"
                    onClick={() =>
                      void (scanningPackages ? cancelPackageFolderScan() : addPackageFolder())
                    }
                    disabled={exporting}
                    title={scanningPackages ? 'Cancel package folder scan' : 'Add package folder'}
                  >
                    <span className={scanningPackages ? 'dataset-spin' : ''} aria-hidden="true">
                      {scanningPackages ? '×' : '＋'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowCanonicalVocalMidiOnly((current) => !current)}
                    disabled={exporting || packageCandidates.length === 0}
                    aria-pressed={showCanonicalVocalMidiOnly}
                  >
                    {showCanonicalVocalMidiOnly ? 'Show all MIDI' : 'Canonical Vocal MIDI'}
                  </button>
                </div>
                <div className="dataset-package-list">
                  {packageGroups.map((group) => (
                    <section className="dataset-package-group" key={group.groupId}>
                      <header>
                        <div>
                          <strong>{group.groupName}</strong>
                          <small>
                            {group.candidates.length} package sources · inventory before approval
                            {group.strumGeneratedCount
                              ? ` · ${group.strumGeneratedCount} STRUM-charted; select individually to include`
                              : ''}
                            {group.packageLimitReached ? ' · package discovery limit reached' : ''}
                            {group.directoryLimitReached
                              ? ' · directory discovery limit reached'
                              : ''}
                          </small>
                        </div>
                        <div className="dataset-package-actions">
                          <button
                            className="dataset-secondary"
                            onClick={() =>
                              void (inventoryingGroupId === group.groupId
                                ? cancelPackageInventory(group.groupId)
                                : inventoryPackageGroup(group))
                            }
                            disabled={
                              exporting ||
                              scanningPackages ||
                              (inventoryingGroupId !== null &&
                                inventoryingGroupId !== group.groupId)
                            }
                          >
                            {inventoryingGroupId === group.groupId
                              ? 'Cancel inventory'
                              : group.resumeCursor
                                ? 'Resume inventory'
                                : 'Inventory'}
                          </button>
                          <button
                            onClick={() => void removePackageGroup(group)}
                            disabled={
                              exporting || scanningPackages || inventoryingGroupId === group.groupId
                            }
                          >
                            Remove
                          </button>
                        </div>
                      </header>
                      {group.inventory && (
                        <p className="dataset-package-inventory" aria-live="polite">
                          {group.inventory.inspectedPackageCount}/
                          {group.inventory.selectedPackageCount} completed ·{' '}
                          {group.inventory.validNotesMidiCount} valid MIDI ·{' '}
                          {group.inventory.chartOnlyCount} chart-only ·{' '}
                          {group.inventory.invalidOrMissingNotesMidiCount} invalid/missing MIDI ·{' '}
                          {group.inventory.exactExpertPartVocalsCount} exact Expert Vocals ·{' '}
                          {group.inventory.duplicateMidiCount} duplicate MIDI ·{' '}
                          {group.inventory.duplicateContainerCount} duplicate containers
                          {group.inventory.cancelled ? ' · cancelled; counts are partial' : ''}
                          {group.inventory.decodeTimeoutCount || group.inventory.decodeFailureCount
                            ? ` · ${group.inventory.decodeTimeoutCount} timed out · ${group.inventory.decodeFailureCount} failed`
                            : ''}
                        </p>
                      )}
                      {inventoryingGroupId === group.groupId && (
                        <p className="dataset-package-inventory" aria-live="polite">
                          Inventorying — {inventoryProgress?.processedPackageCount ?? 0}/{' '}
                          {inventoryProgress?.totalPackageCount ?? group.candidates.length} settled
                          · {inventoryProgress?.completedPackageCount ?? 0} completed
                        </p>
                      )}
                      {group.candidates
                        .filter((entry) => !showCanonicalVocalMidiOnly || entry.canonicalVocalMidi)
                        .map((entry) => renderCandidate(entry, true))}
                    </section>
                  ))}
                  {!scanningPackages && packageGroups.length === 0 && (
                    <p className="dataset-empty">No additional package folders selected.</p>
                  )}
                </div>
              </section>
            </>
          ) : activeStep === 'prepare' ? (
            <section className="training-step-panel">
              <div className="training-panel-heading">
                <div>
                  <h3>Prepare a task view</h3>
                  <p>
                    STRUM revalidates approved catalog assets, assigns song-disjoint splits, and
                    creates an immutable Guitar task view. Original packages stay out of the run.
                  </p>
                </div>
                {trainingJob &&
                  !['succeeded', 'failed', 'cancelled'].includes(trainingJob.state ?? '') && (
                    <button
                      className="dataset-secondary"
                      onClick={() => void cancelActiveTrainingJob()}
                    >
                      Cancel job
                    </button>
                  )}
              </div>
              <div className="training-runtime-card">
                <span
                  className={`training-runtime-dot ${trainingRuntime?.capabilities.includes('training') ? 'ready' : ''}`}
                  aria-hidden="true"
                />
                <div>
                  <strong>{trainingRuntime?.displayName ?? 'Select a STRUM runtime'}</strong>
                  <small>
                    {trainingRuntime
                      ? `${trainingRuntime.kind.replace('_', ' ')} · protocol ${trainingRuntime.protocolVersion}${trainingRuntime.sourceRevision ? ` · ${trainingRuntime.sourceRevision}` : ''}`
                      : 'Choose an installed runtime or a local developer checkout.'}
                  </small>
                </div>
                {(!trainingRuntime || trainingRuntime.trainingSetupRequired) && (
                  <div className="training-runtime-actions">
                    <button
                      className="dataset-secondary"
                      onClick={() => void chooseInstalledRuntime()}
                      disabled={enablingTrainingRuntime}
                    >
                      Select STRUM runtime
                    </button>
                    <button
                      className="dataset-secondary"
                      onClick={() => void chooseDeveloperRuntime()}
                      disabled={enablingTrainingRuntime}
                    >
                      {enablingTrainingRuntime ? 'Verifying runtime…' : 'Choose STRUM checkout'}
                    </button>
                  </div>
                )}
              </div>
              {trainingRuntime?.kind === 'developer_override' && (
                <p className="training-inline-note training-runtime-warning">
                  Developer override: OCTAVE will run this local STRUM checkout. Use it only for a
                  checkout you control; release installs do not enable it automatically.
                </p>
              )}
              {!selectedCatalog ? (
                <p className="dataset-message warning">
                  Select a catalog in Curate before preparing a task view.
                </p>
              ) : !trainingRuntime?.capabilities.includes('training') ? (
                <p className="dataset-message warning">
                  This runtime is inference-only. Select a compatible installed STRUM runtime, or
                  enable a local developer override.
                </p>
              ) : (
                <>
                  <label className="training-control">
                    Pipeline
                    <select
                      value={selectedPipelineId}
                      onChange={(event) => setSelectedPipelineId(event.target.value)}
                    >
                      {trainingPipelines.map((pipeline) => (
                        <option key={pipeline.id} value={pipeline.id}>
                          {pipeline.display_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <TrainingSchemaControls
                    controls={prepareControls}
                    setValues={setPrepareConfig}
                    values={resolvedPrepareConfig}
                  />
                  <div className="training-inspection-grid">
                    <div>
                      <span>Catalog</span>
                      <strong>{selectedCatalog.catalogName}</strong>
                    </div>
                    <div>
                      <span>Eligible {selectedInstrument} songs</span>
                      <strong>{catalogInspection?.eligibleCount ?? 'Validating…'}</strong>
                    </div>
                    <div>
                      <span>Audio policy</span>
                      <strong>{audioPolicyLabel(catalogInspection?.audioPolicy)}</strong>
                    </div>
                    <div>
                      <span>Split</span>
                      <strong>
                        Song-disjoint
                        {typeof resolvedPrepareConfig.split_seed === 'number'
                          ? ` · seed ${resolvedPrepareConfig.split_seed}`
                          : ''}
                      </strong>
                    </div>
                  </div>
                  {catalogInspection &&
                    Object.values(catalogInspection.excluded).some((count) => count > 0) && (
                      <p className="training-inline-note">
                        {Object.values(catalogInspection.excluded).reduce(
                          (sum, count) => sum + count,
                          0
                        )}{' '}
                        records are excluded because they are missing the pipeline’s required
                        labels, approved audio, or a verified asset.
                      </p>
                    )}
                  {!catalogInspection && (
                    <p className="training-inline-note">
                      STRUM will finish full asset admission during preparation. This can take a few
                      minutes for profile-grade audio because every selected stream is decoded
                      before it is admitted.
                    </p>
                  )}
                  <button
                    className="dataset-primary"
                    onClick={() => void prepareDataset()}
                    disabled={
                      catalogInspection?.eligibleCount === 0 ||
                      enablingTrainingRuntime ||
                      Boolean(
                        trainingJob &&
                        !['succeeded', 'failed', 'cancelled'].includes(trainingJob.state ?? '')
                      )
                    }
                  >
                    Prepare {selectedPipelineName} Dataset <span aria-hidden="true">→</span>
                  </button>
                </>
              )}
              {trainingTasks.length > 0 && (
                <div className="training-artifact-list">
                  <h4>Prepared task views</h4>
                  {trainingTasks.map((task) => (
                    <button
                      className={selectedTaskViewId === task.taskViewId ? 'selected' : ''}
                      key={task.taskViewId}
                      onClick={() => setSelectedTaskViewId(task.taskViewId)}
                    >
                      <span>
                        <strong>{task.catalogName}</strong>
                        <small>{task.eligibleCount} records · immutable task view</small>
                      </span>
                      <span aria-hidden="true">
                        {selectedTaskViewId === task.taskViewId ? '✓' : '○'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          ) : activeStep === 'train' ? (
            <section className="training-step-panel">
              <div className="training-panel-heading">
                <div>
                  <h3>Train {selectedPipelineName} locally</h3>
                  <p>
                    STRUM trains the selected immutable task view. Metrics, task identity,
                    configuration, and checkpoint hashes are recorded locally.
                  </p>
                </div>
                {trainingJob &&
                  !['succeeded', 'failed', 'cancelled'].includes(trainingJob.state ?? '') && (
                    <button
                      className="dataset-secondary"
                      onClick={() => void cancelActiveTrainingJob()}
                    >
                      Cancel job
                    </button>
                  )}
              </div>
              {selectedPipelineTasks.length === 0 ? (
                <p className="dataset-message warning">
                  Prepare a {selectedPipelineName} task view before starting training.
                </p>
              ) : (
                <>
                  <label className="training-control">
                    Prepared task view
                    <select
                      value={selectedTaskViewId}
                      onChange={(event) => setSelectedTaskViewId(event.target.value)}
                    >
                      {selectedPipelineTasks.map((task) => (
                        <option key={task.taskViewId} value={task.taskViewId}>
                          {task.catalogName} · {task.eligibleCount} records
                        </option>
                      ))}
                    </select>
                  </label>
                  <TrainingSchemaControls
                    controls={trainControls.filter(
                      (control) => control.key !== 'parent_artifact_id'
                    )}
                    setValues={setTrainConfig}
                    values={resolvedTrainConfig}
                  />
                  {selectedCheckpointOutputCandidate && (
                    <aside className="training-deploy-blocked">
                      <strong>
                        Raw STRUM candidate · {selectedCheckpointOutputCandidate.candidateKind}
                      </strong>
                      <p>
                        Produces{' '}
                        {selectedCheckpointOutputCandidate.candidate.component_outputs.join(', ')}
                        {' · '}preprocessing{' '}
                        {selectedCheckpointOutputCandidate.candidate.preprocessing.id}. This is an
                        experiment-only candidate: profile packaging and chart execution remain
                        unavailable.
                      </p>
                    </aside>
                  )}
                  {resolvedTrainConfig.checkpoint_mode === 'fine_tune' && (
                    <label className="training-control">
                      Parent candidate
                      <select
                        value={parentArtifactId}
                        onChange={(event) => setParentArtifactId(event.target.value)}
                      >
                        <option value="">Select a completed run</option>
                        {trainingRuns
                          .filter((run) => run.pipelineId === selectedPipelineId && run.artifactId)
                          .map((run) => (
                            <option key={run.runId} value={run.artifactId}>
                              {run.runId}
                            </option>
                          ))}
                      </select>
                      <small>
                        STRUM verifies parent compatibility before training. Fine-tuning starts a
                        new run.
                      </small>
                    </label>
                  )}
                  <p className="training-inline-note">
                    OCTAVE submits the selected task and STRUM-declared options. Completed
                    candidates remain available for evaluation and fine-tuning where supported.
                  </p>
                  <button
                    className="dataset-primary"
                    onClick={() => void startTraining()}
                    disabled={Boolean(
                      enablingTrainingRuntime ||
                      (resolvedTrainConfig.checkpoint_mode === 'fine_tune' && !parentArtifactId) ||
                      (trainingJob &&
                        !['succeeded', 'failed', 'cancelled'].includes(trainingJob.state ?? ''))
                    )}
                  >
                    Start local {selectedPipelineName} run <span aria-hidden="true">⚡</span>
                  </button>
                </>
              )}
              {trainingRuns.length > 0 && (
                <div className="training-artifact-list">
                  <h4>Recent runs</h4>
                  {trainingRuns.map((run) => (
                    <div key={run.runId}>
                      <span>
                        <strong>{run.pipelineId}</strong>
                        <small>
                          {run.checkpointCount} required components ·{' '}
                          {run.deployable ? 'deployment-ready' : 'experiment only'}
                        </small>
                      </span>
                      <span
                        className={
                          run.deployable ? 'training-status-ready' : 'training-status-neutral'
                        }
                      >
                        {run.deployable ? 'Ready' : 'Review'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {promotionRuns.length > 0 && (
                <section className="training-promotion-panel">
                  <h4>Evaluate and package a candidate</h4>
                  <p className="training-inline-note">
                    STRUM advertises the available post-training gates. OCTAVE sends only their
                    declared options and keeps candidate and evidence locations private.
                  </p>
                  <label className="training-control">
                    Trained candidate
                    <select
                      value={promotionArtifactId}
                      onChange={(event) => setPromotionArtifactId(event.target.value)}
                    >
                      {promotionRuns.map((run) => (
                        <option key={run.artifactId} value={run.artifactId}>
                          {run.pipelineId} · {run.checkpointManifestHash.slice(0, 12)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {promotionJobs.length === 0 ? (
                    <p className="dataset-message warning">
                      No available STRUM post-training jobs for this candidate.
                    </p>
                  ) : (
                    promotionJobs.map((job) => {
                      const controls = trainingSchemaControls(job.options_schema)
                      const values = schemaConfig(controls, promotionConfigs[job.id] ?? {})
                      const running =
                        trainingJob &&
                        !['succeeded', 'failed', 'cancelled'].includes(trainingJob.state ?? '')
                      return (
                        <article className="training-promotion-card" key={job.id}>
                          <div>
                            <strong>{job.display_name}</strong>
                            <small>
                              {job.kind === 'evaluation'
                                ? 'Evaluation evidence'
                                : 'Profile package'}{' '}
                              · {job.deployment_scope.replaceAll('_', ' ')}
                            </small>
                          </div>
                          <TrainingSchemaControls
                            controls={controls}
                            values={values}
                            setValues={(update) =>
                              setPromotionConfigs((current) => ({
                                ...current,
                                [job.id]:
                                  typeof update === 'function'
                                    ? update(current[job.id] ?? {})
                                    : update
                              }))
                            }
                          />
                          <button
                            className="dataset-secondary"
                            disabled={
                              enablingTrainingRuntime ||
                              Boolean(running) ||
                              job.status !== 'available'
                            }
                            onClick={() => void startPromotion(job)}
                          >
                            {job.kind === 'evaluation' ? 'Evaluate candidate' : 'Package profile'}
                          </button>
                        </article>
                      )
                    })
                  )}
                  {promotionResults
                    .filter((result) => result.candidateArtifactId === promotionArtifactId)
                    .map((result) => (
                      <article className="training-promotion-result" key={result.promotionId}>
                        <strong>{result.job_id}</strong>
                        <span>{result.output_kind.replaceAll('_', ' ')}</span>
                        {Object.entries(result.result).map(([key, value]) =>
                          typeof value === 'string' || typeof value === 'number' ? (
                            <small key={key}>
                              {key.replaceAll('_', ' ')}: {String(value)}
                            </small>
                          ) : key === 'metrics' && value && typeof value === 'object' ? (
                            <small key={key}>metrics recorded</small>
                          ) : null
                        )}
                      </article>
                    ))}
                </section>
              )}
            </section>
          ) : (
            <section className="training-step-panel training-deploy-panel">
              <div className="training-panel-heading">
                <h3>Deploy a validated profile</h3>
                {trainingJob &&
                  !['succeeded', 'failed', 'cancelled'].includes(trainingJob.state ?? '') && (
                    <button
                      className="dataset-secondary"
                      onClick={() => void cancelActiveTrainingJob()}
                    >
                      Cancel job
                    </button>
                  )}
              </div>
              <p>
                Choose a local model-bundle folder. OCTAVE asks STRUM to discover and hash-check its
                manifests, then keeps the selected folder and bundle mapping in the main process.
                Experiment folders never become Auto Chart defaults directly.
              </p>
              <button
                className="dataset-secondary"
                disabled={
                  discoveringCheckpoints ||
                  enablingTrainingRuntime ||
                  Boolean(
                    trainingJob &&
                    !['succeeded', 'failed', 'cancelled'].includes(trainingJob.state ?? '')
                  )
                }
                onClick={() => void discoverCheckpointFolder()}
              >
                {discoveringCheckpoints ? 'Discovering bundles…' : 'Choose model-bundle folder'}
              </button>
              {trainingProfiles.some(
                (profile) => profile.isDefault && profile.pipelineId === 'difficulty.transform/v1'
              ) && (
                <section className="training-promotion-panel">
                  <h4>Use the learned transform</h4>
                  <p>
                    Select an Expert MIDI chart and an output folder. STRUM writes a new chart using
                    the learned difficulty policy of the default profile.
                  </p>
                  <label className="training-toggle-control">
                    <input
                      type="checkbox"
                      checked={transformAudio}
                      disabled={Boolean(transformRunId)}
                      onChange={(event) => setTransformAudio(event.target.checked)}
                    />
                    Provide aligned audio for an audio-conditioned profile
                  </label>
                  <button
                    className="dataset-primary"
                    disabled={Boolean(transformRunId)}
                    onClick={() => void transformMidi()}
                  >
                    {transformRunId ? 'Transforming MIDI…' : 'Transform MIDI'}
                  </button>
                  {transformRunId && (
                    <button
                      className="dataset-secondary"
                      onClick={() => void window.api.cancelAutoChart(transformRunId)}
                    >
                      Cancel transform
                    </button>
                  )}
                  {transformOutput && (
                    <p className="training-inline-note">
                      Created notes.mid and run.json in {transformOutput} inside your selected
                      output folder.
                    </p>
                  )}
                </section>
              )}
              {checkpointDiscovery && (
                <>
                  <p className="training-inline-note">
                    STRUM found {checkpointDiscovery.candidateCount} verified bundle
                    {checkpointDiscovery.candidateCount === 1 ? '' : 's'} and{' '}
                    {checkpointDiscovery.profileCount} declared profile
                    {checkpointDiscovery.profileCount === 1 ? '' : 's'}.
                    {checkpointDiscovery.rejectedBundleCount > 0
                      ? ` ${checkpointDiscovery.rejectedBundleCount} invalid bundle${checkpointDiscovery.rejectedBundleCount === 1 ? '' : 's'} hidden.`
                      : ''}
                    {checkpointDiscovery.truncated
                      ? ' Discovery was bounded; narrow the folder to see more.'
                      : ''}
                  </p>
                  {checkpointDiscovery.candidates.length === 0 ? (
                    <p className="dataset-message warning">
                      No hash-verified STRUM model bundles were found in that folder.
                    </p>
                  ) : (
                    <div className="training-artifact-list training-deploy-runs">
                      <h4>Verified model bundles</h4>
                      {checkpointDiscovery.candidates.map((candidate) =>
                        candidate.deploymentStatus === 'ready' ? (
                          <button
                            className={
                              selectedArtifactId === candidate.artifactId ? 'selected' : ''
                            }
                            key={candidate.artifactId}
                            onClick={() => setSelectedArtifactId(candidate.artifactId)}
                          >
                            <span>
                              <strong>{candidate.modelId}</strong>
                              <small>
                                {candidate.components.length} verified components ·{' '}
                                {
                                  candidate.profiles.filter(
                                    (profile) => profile.execution.status === 'available'
                                  ).length
                                }{' '}
                                executable profiles
                              </small>
                            </span>
                            <span className="training-status-ready">Inspect</span>
                          </button>
                        ) : (
                          <div key={candidate.artifactId}>
                            <span>
                              <strong>{candidate.modelId}</strong>
                              <small>
                                {candidate.components.length} verified components · profile
                                execution unavailable
                              </small>
                            </span>
                            <span className="training-status-neutral">Not deployable</span>
                          </div>
                        )
                      )}
                    </div>
                  )}
                </>
              )}
              {selectedArtifactId && !selectedDiscoveredCheckpoint && (
                <p className="training-inline-note">Inspecting the selected checkpoint bundle…</p>
              )}
              {selectedDiscoveredCheckpoint && (
                <>
                  <div className="training-checkpoint-summary">
                    <div>
                      <span>Model</span>
                      <strong>{selectedDiscoveredCheckpoint.modelId}</strong>
                    </div>
                    <div>
                      <span>Verified components</span>
                      <strong>{selectedDiscoveredCheckpoint.components.length}</strong>
                    </div>
                    <div>
                      <span>Manifest</span>
                      <strong>{selectedDiscoveredCheckpoint.manifestSha256.slice(0, 12)}</strong>
                    </div>
                  </div>
                  <label className="training-control">
                    STRUM profile
                    <select
                      value={selectedDiscoveredProfileId}
                      onChange={(event) => {
                        const profile = selectedDiscoveredCheckpoint.profiles.find(
                          (entry) => entry.profileId === event.target.value
                        )
                        setSelectedDiscoveredProfileId(event.target.value)
                        setSelectedDifficultyPolicy(profile?.execution.difficultyPolicies[0] ?? '')
                      }}
                    >
                      {selectedDiscoveredCheckpoint.profiles
                        .filter((profile) => profile.execution.status === 'available')
                        .map((profile) => (
                          <option key={profile.profileId} value={profile.profileId}>
                            {profile.capability} · {profile.instruments.join(', ')}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="training-control">
                    Difficulty policy
                    <select
                      value={selectedDifficultyPolicy}
                      onChange={(event) => setSelectedDifficultyPolicy(event.target.value)}
                    >
                      {selectedDiscoveredProfile?.execution.difficultyPolicies.map((policy) => (
                        <option key={policy} value={policy}>
                          {policy}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {trainingRuns.length > 0 && (
                <aside className="training-deploy-blocked">
                  <strong>Training runs are not deployment candidates</strong>
                  <p>
                    Evaluate and package an experiment in STRUM first. Return here only with its
                    hash-verified model-bundle folder.
                  </p>
                </aside>
              )}
              {trainingProfiles.length > 0 && (
                <div className="training-profile-summary">
                  {trainingProfiles.map((profile) => (
                    <span key={profile.profileId}>
                      {profile.pipelineId} {profile.isDefault ? '· current Auto Chart default' : ''}
                    </span>
                  ))}
                </div>
              )}
              {trainingProfiles.filter((profile) =>
                [
                  'guitar.hybrid-v2-rule/v1',
                  'guitar.neural-v1-expert/v1',
                  'bass.neural-v1-expert/v1',
                  'keys.neural-v1-expert/v1',
                  'drums.v14-expert/v1'
                ].includes(profile.pipelineId)
              ).length >= 2 && (
                <section className="training-promotion-panel">
                  <h4>Compose selected Expert profiles</h4>
                  <p className="training-inline-note">
                    Choose two to four separately validated Guitar, Bass, Keys, or Drums profiles.
                    STRUM copies, revalidates, and pins each selected bundle before saving one
                    portable multi-instrument Auto Chart default.
                  </p>
                  {trainingProfiles
                    .filter((profile) =>
                      [
                        'guitar.hybrid-v2-rule/v1',
                        'guitar.neural-v1-expert/v1',
                        'bass.neural-v1-expert/v1',
                        'keys.neural-v1-expert/v1',
                        'drums.v14-expert/v1'
                      ].includes(profile.pipelineId)
                    )
                    .map((profile) => (
                      <label className="training-toggle-control" key={profile.profileId}>
                        <input
                          type="checkbox"
                          checked={compositionProfileIds.has(profile.profileId)}
                          disabled={
                            enablingTrainingRuntime ||
                            (!compositionProfileIds.has(profile.profileId) &&
                              compositionProfileIds.size >= 4)
                          }
                          onChange={(event) =>
                            setCompositionProfileIds((current) => {
                              const next = new Set(current)
                              if (event.target.checked) next.add(profile.profileId)
                              else next.delete(profile.profileId)
                              return next
                            })
                          }
                        />
                        {profile.pipelineId} {profile.isDefault ? '· current default' : ''}
                      </label>
                    ))}
                  <button
                    className="dataset-primary"
                    disabled={
                      enablingTrainingRuntime ||
                      compositionProfileIds.size < 2 ||
                      compositionProfileIds.size > 4 ||
                      Boolean(
                        trainingJob &&
                        !['succeeded', 'failed', 'cancelled'].includes(trainingJob.state ?? '')
                      )
                    }
                    onClick={() => void startProfileComposition()}
                  >
                    Compose selected profiles
                  </button>
                </section>
              )}
              <button
                className="dataset-primary"
                disabled={
                  !selectedDiscoveredCheckpoint ||
                  selectedDiscoveredCheckpoint.deploymentStatus !== 'ready' ||
                  !selectedDiscoveredProfile ||
                  selectedDiscoveredProfile.execution.status !== 'available' ||
                  !selectedDiscoveredProfile.execution.difficultyPolicies.includes(
                    selectedDifficultyPolicy
                  ) ||
                  enablingTrainingRuntime ||
                  savingAutoChartProfile
                }
                onClick={() => void saveSelectedAutoChartProfile()}
              >
                {savingAutoChartProfile
                  ? 'Validating profile…'
                  : 'Validate & save as Auto Chart default'}
              </button>
            </section>
          )}
        </main>
        <footer className={activeStep === 'learn' ? 'training-learn-footer' : undefined}>
          {activeStep === 'learn' ? (
            <button className="dataset-primary" onClick={() => setActiveStep('curate')}>
              I understand — Start Curating <span aria-hidden="true">→</span>
            </button>
          ) : activeStep === 'curate' ? (
            <>
              <span>
                {allowedLibrarySongs.length} library records allowed; {selectedPackages.size}{' '}
                package sources reviewed
              </span>
              <button
                className="dataset-primary"
                onClick={() => setActiveStep('prepare')}
                disabled={exporting || !selectedCatalog}
                title={
                  selectedCatalog
                    ? 'Prepare the selected catalog'
                    : 'Select a catalog to prepare a dataset'
                }
              >
                Prepare Dataset <span aria-hidden="true">→</span>
              </button>
            </>
          ) : (
            <>
              <span>
                {trainingJob &&
                !['succeeded', 'failed', 'cancelled'].includes(trainingJob.state ?? '')
                  ? `${trainingJob.message}${typeof trainingJob.progress === 'number' ? ` · ${Math.round(trainingJob.progress * 100)}%` : ''}`
                  : 'STRUM jobs continue locally when this window is closed.'}
              </span>
              <button className="dataset-primary" onClick={() => setActiveStep('curate')}>
                Back to Curate
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  )
}
