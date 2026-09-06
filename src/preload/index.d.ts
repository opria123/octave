import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  StrumCheckpointOutputContracts,
  StrumPromotionJobDescriptor,
  StrumPromotionJobResult
} from '../shared/strumTrainingContracts'
import type {
  MetadataArtwork,
  SongMetadataSearchRequest,
  SongMetadataSearchResult
} from '../shared/songMetadata'

interface ChartEditorAPI {
  // Dialog APIs
  openFolder: () => Promise<string | null>
  importSongPackage: () => Promise<string | null>

  // Folder APIs
  scanFolder: (
    folderPath: string
  ) => Promise<Array<{ id: string; path: string; name: string; addedAt: number }>>

  // Dialog APIs
  openAudioDialog: () => Promise<string | null>
  openAudioFilesDialog: () => Promise<string[]>
  openAudioFolderDialog: () => Promise<string | null>
  openOutputFolderDialog: () => Promise<string | null>
  showItemInFolder: (filePath: string) => Promise<boolean>
  getDefaultAutoChartOutputDir: () => Promise<string>
  chooseDatasetPackageFolder: () => Promise<{
    groupId: string
    groupName: string
    strumGeneratedCount: number
    packageLimitReached: boolean
    directoryLimitReached: boolean
    candidates: Array<{
      candidateId: string
      groupId: string
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
      isStrumGenerated: boolean
    }>
  } | null>
  cancelDatasetPackageDiscovery: () => Promise<boolean>
  removeDatasetPackageGroup: (candidateIds: string[], groupId?: string) => Promise<void>
  inspectDatasetPackageGroup: (
    groupId: string,
    resumeCursor?: string
  ) => Promise<{
    inventory: {
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
    } | null
    resumeCursor: string | null
    cursorRejected: boolean
    reviewCandidates: Array<{
      candidateId: string
      groupId: string
      kind: 'sng' | 'rb3con' | 'zip'
      songCount: number
      metadata: Record<string, string>
      midiValid: true
      instruments: Record<
        string,
        { status: 'present'; difficulties: string[]; trackNames: string[] }
      >
      trainingUse: 'review_required'
      warnings: Array<{ code: string }>
      isStrumGenerated: false
      canonicalVocalMidi: boolean
      duplicateMidi: boolean
    }> | null
  } | null>
  cancelDatasetPackageInventory: (groupId: string) => Promise<boolean>
  onDatasetPackageInventoryProgress: (
    callback: (progress: {
      processedPackageCount: number
      completedPackageCount: number
      totalPackageCount: number
    }) => void
  ) => () => void
  onDatasetScanProgress: (
    callback: (progress: {
      phase: 'discovering' | 'inspecting'
      completed: number
      total: number
    }) => void
  ) => () => void
  onDatasetSaveProgress: (
    callback: (progress: {
      phase: 'checking' | 'normalizing' | 'materializing' | 'validating'
      completed: number
      total: number
    }) => void
  ) => () => void
  chooseDatasetCatalogParent: () => Promise<{ parentId: string; name: string } | null>
  useDefaultDatasetCatalogParent: () => Promise<{
    parentId: string
    name: string
  } | null>
  restoreDatasetCatalogParent: (
    parentId: string
  ) => Promise<{ parentId: string; name: string } | null>
  listDatasetCatalogs: (parentId: string) => Promise<
    Array<{
      catalogName: string
      catalogId: string
      provenance: string
      license: string
      recordCount: number
      libraryRecordCount: number
      externalRecordCount: number
    }>
  >
  listDatasetCatalogHarmonyTargets: (
    parentId: string,
    catalogName: string
  ) => Promise<
    Array<{
      sourceId: string
      label: string
      tracks: Array<'HARM1' | 'HARM2' | 'HARM3'>
      configuredTracks: Array<'HARM1' | 'HARM2' | 'HARM3'>
    }>
  >
  chooseDatasetHarmonyAudio: () => Promise<{ selectionId: string; displayName: string } | null>
  materializeDatasetHarmonySource: (options: {
    parentId: string
    catalogName: string
    sourceId: string
    trackName: 'HARM1' | 'HARM2' | 'HARM3'
    sourceSelectionId: string
    provenance:
      | { kind: 'isolated_source_stem/v1'; attestationId: string }
      | {
          kind: 'isolated_separation_output/v1'
          separator: {
            id: string
            version: string
            modelSha256: string
            configurationSha256: string
          }
        }
  }) => Promise<{
    sourceId: string
    trackName: 'HARM1' | 'HARM2' | 'HARM3'
    configuredTracks: Array<'HARM1' | 'HARM2' | 'HARM3'>
  }>
  scanDatasetLibrary: () => Promise<
    Array<{
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
      isStrumGenerated: boolean
    }>
  >
  setDatasetSongOptIn: (candidateId: string, optedIn: boolean) => Promise<boolean>
  setDatasetPackageApproved: (candidateId: string, approved: boolean) => Promise<boolean>
  readDatasetCandidateArtwork: (candidateId: string) => Promise<string | null>
  buildSongSourceCatalog: (options: {
    candidateIds: string[]
    parentId: string
    catalogName: string
    catalogId: string
    provenance: string
    license: string
    mode: 'create' | 'update' | 'clone'
    sourceCatalogName?: string
  }) => Promise<{
    recordCount: number
    skipped: Array<{ reason: string }>
  }>
  /** Opaque reviewed package candidate only; source details remain in main. */
  enrichSongSourceCatalogAudio: (options: {
    candidateId: string
    parentId: string
    catalogName: string
    catalogId: string
    sourceCatalogName: string
  }) => Promise<{
    recordCount: number
    skipped: Array<{ reason: string }>
  }>
  getTrainingRuntime: () => Promise<{
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
  } | null>
  enableDeveloperTrainingRuntime: () => Promise<{
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
  } | null>
  chooseDeveloperTrainingRuntime: () => Promise<{
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
  } | null>
  chooseInstalledTrainingRuntime: () => Promise<{
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
  } | null>
  listTrainingPipelines: () => Promise<
    Array<{
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
    }>
  >
  listTrainingArtifacts: () => Promise<{
    jobs: Array<{
      jobId: string
      sequence: number
      stage: string
      progress?: number
      state?: 'queued' | 'running' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed'
      message: string
      code?: string
    }>
    tasks: Array<{
      taskViewId: string
      catalogId: string
      catalogName: string
      pipelineId: string
      eligibleCount: number
      contentHash: string
      createdAt: string
    }>
    runs: Array<{
      runId: string
      taskViewId: string
      pipelineId: string
      checkpointCount: number
      deployable: boolean
      checkpointManifestHash: string
      artifactId?: string
      createdAt: string
    }>
    profiles: Array<{
      profileId: string
      runId?: string
      strumProfileId?: string
      artifactId?: string
      difficultyPolicy?: string
      pipelineId: string
      runtimeId: string
      createdAt: string
      isDefault: boolean
    }>
  }>
  listTrainingPromotionJobs: (candidateArtifactId: string) => Promise<StrumPromotionJobDescriptor[]>
  chooseTrainingCheckpointFolder: () => Promise<{
    candidateCount: number
    profileCount: number
    rejectedBundleCount: number
    truncated: boolean
    candidates: Array<{
      artifactId: string
      modelId: string
      manifestSha256: string
      schemaVersion: number
      compatibility: Record<string, string | number | boolean | null>
      components: Array<{ id: string; sha256: string; byteLength: number }>
      profiles: Array<{
        profileId: string
        capability: string
        instruments: string[]
        difficultyPolicies: string[]
        requiredComponents: string[]
        execution: { status: 'available' | 'not_available'; difficultyPolicies: string[] }
      }>
      rejectedProfileCount: number
      deploymentStatus: 'ready' | 'not_deployable'
    }>
  } | null>
  inspectDiscoveredTrainingCheckpoint: (artifactId: string) => Promise<{
    artifactId: string
    modelId: string
    manifestSha256: string
    schemaVersion: number
    compatibility: Record<string, string | number | boolean | null>
    components: Array<{ id: string; sha256: string; byteLength: number }>
    profiles: Array<{
      profileId: string
      capability: string
      instruments: string[]
      difficultyPolicies: string[]
      requiredComponents: string[]
      execution: { status: 'available' | 'not_available'; difficultyPolicies: string[] }
    }>
    rejectedProfileCount: number
    deploymentStatus: 'ready' | 'not_deployable'
  }>
  saveDiscoveredAutoChartProfile: (options: {
    artifactId: string
    profileId: string
    difficultyPolicy: string
  }) => Promise<{
    profileId: string
    strumProfileId?: string
    artifactId?: string
    difficultyPolicy?: string
    pipelineId: string
    runtimeId: string
    createdAt: string
    isDefault: boolean
  }>
  composeAutoChartProfiles: (options: { profileIds: string[] }) => Promise<{ jobId: string }>
  inspectTrainingCheckpoint: (runId: string) => Promise<{
    runId: string
    pipelineId: string
    runtimeId: string
    taskViewId: string
    taskViewHash: string
    checkpointManifestHash: string
    deployable: boolean
    deploymentReason: string | null
    components: Array<{ id: string; sha256: string; byteLength: number }>
  }>
  inspectTrainingCatalog: (options: {
    parentId: string
    catalogName: string
    pipelineId: string
    prepare: Record<string, unknown>
  }) => Promise<{
    pipelineId: string
    eligibleCount: number
    recordCount: number
    excluded: Record<string, number>
    audioPolicy: Record<string, unknown>
    estimatedStorageBytes: number
    storageEstimateCapped: boolean
    storageEstimateSemantics: string
  }>
  prepareTrainingDataset: (options: {
    parentId: string
    catalogId: string
    catalogName: string
    pipelineId: string
    prepare: Record<string, unknown>
  }) => Promise<{ jobId: string; taskViewId: string }>
  startTrainingRun: (options: {
    taskViewId: string
    pipelineId: string
    train: Record<string, unknown>
  }) => Promise<{ jobId: string; runId: string }>
  startTrainingPromotionJob: (options: {
    candidateArtifactId: string
    jobId: string
    options: Record<string, unknown>
  }) => Promise<{ jobId: string }>
  transformTrainingMidi: (options: { runId: string; includeAudio: boolean }) => Promise<{
    cancelled: boolean
    outputName?: string
    artifacts?: {
      profileId: string
      capability: string
      manifestSha256: string
      artifacts: Array<{ id: string; name: string; sha256: string }>
    }
  }>
  cancelTrainingJob: (jobId: string) => Promise<boolean>
  onTrainingProgress: (
    callback: (event: {
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
      result?:
        | Record<string, unknown>
        | (StrumPromotionJobResult & {
            promotionId: string
            candidateArtifactId: string
            artifactId?: string
            deploymentStatus?: 'ready' | 'not_deployable'
          })
    }) => void
  ) => () => void
  openLyricsFileDialog: () => Promise<{ filePath: string; content: string } | null>

  // Song APIs
  createSongFolder: (
    parentPath: string,
    folderName: string,
    audioPath?: string
  ) => Promise<{ id: string; path: string; name: string } | null>
  deleteSongFolder: (songPath: string) => Promise<boolean>
  readSongIni: (songPath: string) => Promise<Record<string, string | number> | null>
  writeSongIni: (songPath: string, metadata: Record<string, unknown>) => Promise<boolean>
  searchSongMetadata: (request: SongMetadataSearchRequest) => Promise<SongMetadataSearchResult[]>
  fetchMetadataArtwork: (artwork: MetadataArtwork) => Promise<string | null>
  readSongMidi: (songPath: string) => Promise<{ type: 'midi' | 'chart'; data: string } | null>
  writeSongMidi: (songPath: string, midiBase64: string) => Promise<boolean>
  writeSongChart: (songPath: string, chartText: string) => Promise<boolean>
  exportSng: (
    songPath: string,
    metadata: Record<string, unknown>,
    outputPath: string
  ) => Promise<{ success: boolean; error?: string }>
  exportCon: (
    songPath: string,
    metadata: Record<string, unknown>,
    outputPath: string
  ) => Promise<{ success: boolean; error?: string }>
  fileExists: (filePath: string) => Promise<boolean>

  // Album art APIs
  readAlbumArt: (songPath: string) => Promise<string | null>
  writeAlbumArt: (songPath: string, dataUrl: string) => Promise<boolean>

  // Audio APIs
  importAudio: (
    songPath: string,
    audioSourcePath: string
  ) => Promise<{ filePath: string; filename: string } | null>
  readAudio: (songPath: string) => Promise<{ filePath: string; filename: string }[] | null>
  readAudioJson: (songPath: string) => Promise<Record<string, unknown> | null>
  writeAudioJson: (songPath: string, data: unknown) => Promise<boolean>
  readVenueJson: (songPath: string) => Promise<Record<string, unknown> | null>
  writeVenueJson: (songPath: string, data: unknown) => Promise<boolean>

  // Video APIs
  openVideoDialog: () => Promise<string | null>
  importVideo: (
    songPath: string,
    videoSourcePath: string
  ) => Promise<{ filePath: string; filename: string } | null>
  scanVideo: (songPath: string) => Promise<{ filePath: string; filename: string } | null>
  readVideoJson: (songPath: string) => Promise<Record<string, unknown> | null>
  writeVideoJson: (songPath: string, data: unknown) => Promise<boolean>
  downloadVideoUrl: (
    songPath: string,
    url: string
  ) => Promise<{ success: boolean; filePath?: string; error?: string }>
  onDownloadProgress: (callback: (percent: number) => void) => () => void
  getWaveformSource: (songPath: string) => Promise<{ filePath: string } | null>

  // Export APIs
  saveVideoDialog: () => Promise<string | null>
  exportVideo: (options: {
    videoPath: string
    audioPath: string
    outputPath: string
    offsetMs: number
    trimStartMs: number
    trimEndMs: number
  }) => Promise<{ success: boolean; error?: string }>
  onExportProgress: (callback: (percent: number) => void) => () => void

  // STRUM auto-chart APIs
  startAutoChart: (options: {
    outputDir: string
    files: string[]
    folders: string[]
    stemFolders?: string[]
    stemSongs?: Array<{
      name?: string
      stems: Partial<
        Record<
          | 'drums'
          | 'bass'
          | 'vocals'
          | 'other'
          | 'guitar'
          | 'piano'
          | 'vocalsHarm2'
          | 'vocalsHarm3'
          | 'crowd',
          string
        >
      >
      extras?: string[]
    }>
    urls: string[]
    includeKeys?: boolean
    disableOnlineLookup?: boolean
    skipHarmonies?: boolean
    keepStems?: boolean
    starPower?: boolean
    snapDrums?: boolean
    snapDrumsDivision?: number
    snapDrumsWindowMs?: number
    autoTempo?: boolean
    autoTempoDrift?: boolean
    autoTempoSnap?: boolean
    enabledTracks?: {
      drums?: boolean
      guitar?: boolean
      bass?: boolean
      vocals?: boolean
      harmonies?: boolean
      keys?: boolean
      proKeys?: boolean
    }
    /**
     * Optional user-supplied tempo map. If provided, the first event
     * (sorted by timeSec) overrides STRUM's auto-detected BPM and the
     * full list is written to notes.mid; note ticks are retimed so
     * real-world note positions stay aligned with the audio.
     */
    tempoMap?: Array<{ timeSec: number; bpm: number }>
    /** Single global BPM hint (the user's authoritative Manual BPM). */
    manualBpm?: number
  }) => Promise<{ runId: string }>
  cancelAutoChart: (runId: string) => Promise<boolean>
  onAutoChartProgress: (
    callback: (event: {
      runId: string
      stage: string
      message: string
      percent?: number
      currentItem?: string
    }) => void
  ) => () => void
  onAutoChartComplete: (
    callback: (event: {
      runId: string
      success: boolean
      outputDir: string
      songFolders: string[]
      errors: string[]
      urlSongFolders?: Array<{ url: string; songFolder: string }>
      typedArtifacts?: {
        format: 'strum-typed-chart-artifacts/v1'
        profileId: string
        capability: string
        manifestSha256: string
        artifacts: Array<{ id: 'notes_midi' | 'run_manifest'; name: string; sha256: string }>
      }
    }) => void
  ) => () => void
  onAutoChartError: (callback: (event: { runId: string; message: string }) => void) => () => void

  // Bootstrapped Python runtime (managed in userData on packaged builds)
  getRuntimeStatus: () => Promise<{
    managed: boolean
    ready: boolean
    installing: boolean
    pythonPath: string
    pythonBuildTag: string
    pythonVersion: string
    isUpgrade: boolean
  }>
  bootstrapRuntime: () => Promise<{ ok: boolean; skipped?: boolean; message?: string }>

  // App update channel (stable vs. beta/pre-release)
  getUpdateChannel: () => Promise<{ betaChannel: boolean }>
  setUpdateChannel: (betaEnabled: boolean) => Promise<{ ok: boolean; betaChannel: boolean }>

  // App updater events
  onUpdaterStatus: (
    callback: (status: {
      state:
        | 'idle'
        | 'checking'
        | 'available'
        | 'downloading'
        | 'downloaded'
        | 'not-available'
        | 'error'
      version?: string
      percent?: number
      message?: string
    }) => void
  ) => () => void

  // App menu events
  onMenuCommand: (callback: (command: string, payload?: unknown) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: ChartEditorAPI
  }
}
