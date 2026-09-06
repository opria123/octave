import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
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

// Custom APIs for renderer
const api = {
  // Dialog APIs
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),

  importSongPackage: (): Promise<string | null> => ipcRenderer.invoke('dialog:importSongPackage'),

  // Folder APIs
  scanFolder: (
    folderPath: string
  ): Promise<Array<{ id: string; path: string; name: string; addedAt: number }>> =>
    ipcRenderer.invoke('folder:scan', folderPath),

  // Dialog APIs
  openAudioDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openAudio'),

  openAudioFilesDialog: (): Promise<string[]> => ipcRenderer.invoke('dialog:openAudioFiles'),

  openAudioFolderDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openAudioFolder'),

  openOutputFolderDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:openOutputFolder'),

  showItemInFolder: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('dialog:showItemInFolder', filePath),

  getDefaultAutoChartOutputDir: (): Promise<string> =>
    ipcRenderer.invoke('strum:getDefaultOutputFolder'),

  chooseDatasetPackageFolder: (): Promise<{
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
  } | null> => ipcRenderer.invoke('dataset:choosePackageFolder'),

  cancelDatasetPackageDiscovery: (): Promise<boolean> =>
    ipcRenderer.invoke('dataset:cancelPackageDiscovery'),

  removeDatasetPackageGroup: (candidateIds: string[], groupId?: string): Promise<void> =>
    ipcRenderer.invoke('dataset:removePackageGroup', candidateIds, groupId),

  inspectDatasetPackageGroup: (
    groupId: string,
    resumeCursor?: string
  ): Promise<{
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
    /** Opaque main-owned resume capability, not a source identifier. */
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
  } | null> => ipcRenderer.invoke('dataset:inspectPackageGroup', groupId, resumeCursor),

  cancelDatasetPackageInventory: (groupId: string): Promise<boolean> =>
    ipcRenderer.invoke('dataset:cancelPackageInventory', groupId),

  onDatasetPackageInventoryProgress: (
    callback: (progress: {
      processedPackageCount: number
      completedPackageCount: number
      totalPackageCount: number
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      progress: {
        processedPackageCount: number
        completedPackageCount: number
        totalPackageCount: number
      }
    ): void => callback(progress)
    ipcRenderer.on('dataset:packageInventoryProgress', listener)
    return () => ipcRenderer.removeListener('dataset:packageInventoryProgress', listener)
  },

  onDatasetScanProgress: (
    callback: (progress: {
      phase: 'discovering' | 'inspecting'
      completed: number
      total: number
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      progress: { phase: 'discovering' | 'inspecting'; completed: number; total: number }
    ): void => callback(progress)
    ipcRenderer.on('dataset:scanProgress', listener)
    return () => ipcRenderer.removeListener('dataset:scanProgress', listener)
  },

  onDatasetSaveProgress: (
    callback: (progress: {
      phase: 'checking' | 'normalizing' | 'materializing' | 'validating'
      completed: number
      total: number
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      progress: {
        phase: 'checking' | 'normalizing' | 'materializing' | 'validating'
        completed: number
        total: number
      }
    ): void => callback(progress)
    ipcRenderer.on('dataset:saveProgress', listener)
    return () => ipcRenderer.removeListener('dataset:saveProgress', listener)
  },

  chooseDatasetCatalogParent: (): Promise<{
    parentId: string
    name: string
  } | null> => ipcRenderer.invoke('dataset:chooseCatalogParent'),

  useDefaultDatasetCatalogParent: (): Promise<{
    parentId: string
    name: string
  } | null> => ipcRenderer.invoke('dataset:useDefaultCatalogParent'),

  restoreDatasetCatalogParent: (
    parentId: string
  ): Promise<{ parentId: string; name: string } | null> =>
    ipcRenderer.invoke('dataset:restoreCatalogParent', parentId),

  listDatasetCatalogs: (
    parentId: string
  ): Promise<
    Array<{
      catalogName: string
      catalogId: string
      provenance: string
      license: string
      recordCount: number
      libraryRecordCount: number
      externalRecordCount: number
    }>
  > => ipcRenderer.invoke('dataset:listCatalogs', parentId),

  listDatasetCatalogHarmonyTargets: (
    parentId: string,
    catalogName: string
  ): Promise<
    Array<{
      sourceId: string
      label: string
      tracks: Array<'HARM1' | 'HARM2' | 'HARM3'>
      configuredTracks: Array<'HARM1' | 'HARM2' | 'HARM3'>
    }>
  > => ipcRenderer.invoke('dataset:listHarmonyTargets', parentId, catalogName),

  chooseDatasetHarmonyAudio: (): Promise<{ selectionId: string; displayName: string } | null> =>
    ipcRenderer.invoke('dataset:chooseHarmonyAudio'),

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
  }): Promise<{
    sourceId: string
    trackName: 'HARM1' | 'HARM2' | 'HARM3'
    configuredTracks: Array<'HARM1' | 'HARM2' | 'HARM3'>
  }> => ipcRenderer.invoke('dataset:materializeHarmonySource', options),

  scanDatasetLibrary: (): Promise<
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
  > => ipcRenderer.invoke('dataset:scanLibrary'),

  setDatasetSongOptIn: (candidateId: string, optedIn: boolean): Promise<boolean> =>
    ipcRenderer.invoke('dataset:setSongOptIn', candidateId, optedIn),

  setDatasetPackageApproved: (candidateId: string, approved: boolean): Promise<boolean> =>
    ipcRenderer.invoke('dataset:setPackageApproved', candidateId, approved),

  readDatasetCandidateArtwork: (candidateId: string): Promise<string | null> =>
    ipcRenderer.invoke('dataset:readCandidateArtwork', candidateId),

  buildSongSourceCatalog: (options: {
    candidateIds: string[]
    parentId: string
    catalogName: string
    catalogId: string
    provenance: string
    license: string
    mode: 'create' | 'update' | 'clone'
    sourceCatalogName?: string
  }): Promise<{
    recordCount: number
    skipped: Array<{ reason: string }>
  }> => ipcRenderer.invoke('dataset:export', options),

  /**
   * Creates a new catalog revision from one already-reviewed package chart.
   * The candidate ID is opaque; the renderer never receives package paths,
   * hashes, entry locators, or asset bytes.
   */
  enrichSongSourceCatalogAudio: (options: {
    candidateId: string
    parentId: string
    catalogName: string
    catalogId: string
    sourceCatalogName: string
  }): Promise<{
    recordCount: number
    skipped: Array<{ reason: string }>
  }> => ipcRenderer.invoke('dataset:enrichCatalogAudio', options),

  getTrainingRuntime: (): Promise<{
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
  } | null> => ipcRenderer.invoke('training:runtime'),

  enableDeveloperTrainingRuntime: (): Promise<{
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
  } | null> => ipcRenderer.invoke('training:enableDeveloperRuntime'),

  chooseDeveloperTrainingRuntime: (): Promise<{
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
  } | null> => ipcRenderer.invoke('training:chooseDeveloperRuntime'),

  chooseInstalledTrainingRuntime: (): Promise<{
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
  } | null> => ipcRenderer.invoke('training:chooseInstalledRuntime'),

  listTrainingPipelines: (): Promise<
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
  > => ipcRenderer.invoke('training:pipelines'),

  listTrainingArtifacts: (): Promise<{
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
  }> => ipcRenderer.invoke('training:artifacts'),

  listTrainingPromotionJobs: (
    candidateArtifactId: string
  ): Promise<StrumPromotionJobDescriptor[]> =>
    ipcRenderer.invoke('training:promotionJobs', candidateArtifactId),

  chooseTrainingCheckpointFolder: (): Promise<{
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
  } | null> => ipcRenderer.invoke('training:chooseCheckpointFolder'),

  inspectDiscoveredTrainingCheckpoint: (
    artifactId: string
  ): Promise<{
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
  }> => ipcRenderer.invoke('training:inspectDiscoveredCheckpoint', artifactId),

  saveDiscoveredAutoChartProfile: (options: {
    artifactId: string
    profileId: string
    difficultyPolicy: string
  }): Promise<{
    profileId: string
    strumProfileId?: string
    artifactId?: string
    difficultyPolicy?: string
    pipelineId: string
    runtimeId: string
    createdAt: string
    isDefault: boolean
  }> => ipcRenderer.invoke('training:saveDiscoveredAutoChartProfile', options),

  composeAutoChartProfiles: (options: { profileIds: string[] }): Promise<{ jobId: string }> =>
    ipcRenderer.invoke('training:composeAutoChartProfiles', options),

  inspectTrainingCheckpoint: (
    runId: string
  ): Promise<{
    runId: string
    pipelineId: string
    runtimeId: string
    taskViewId: string
    taskViewHash: string
    checkpointManifestHash: string
    deployable: boolean
    deploymentReason: string | null
    components: Array<{ id: string; sha256: string; byteLength: number }>
  }> => ipcRenderer.invoke('training:inspectCheckpoint', runId),

  inspectTrainingCatalog: (options: {
    parentId: string
    catalogName: string
    pipelineId: string
    prepare: Record<string, unknown>
  }): Promise<{
    pipelineId: string
    eligibleCount: number
    recordCount: number
    excluded: Record<string, number>
    audioPolicy: Record<string, unknown>
    estimatedStorageBytes: number
    storageEstimateCapped: boolean
    storageEstimateSemantics: string
  }> => ipcRenderer.invoke('training:inspectCatalog', options),

  prepareTrainingDataset: (options: {
    parentId: string
    catalogId: string
    catalogName: string
    pipelineId: string
    prepare: Record<string, unknown>
  }): Promise<{ jobId: string; taskViewId: string }> =>
    ipcRenderer.invoke('training:prepare', options),

  startTrainingRun: (options: {
    taskViewId: string
    pipelineId: string
    train: Record<string, unknown>
  }): Promise<{ jobId: string; runId: string }> => ipcRenderer.invoke('training:start', options),

  startTrainingPromotionJob: (options: {
    candidateArtifactId: string
    jobId: string
    options: Record<string, unknown>
  }): Promise<{ jobId: string }> => ipcRenderer.invoke('training:startPromotionJob', options),

  transformTrainingMidi: (options: {
    runId: string
    includeAudio: boolean
  }): Promise<{
    cancelled: boolean
    outputName?: string
    artifacts?: {
      profileId: string
      capability: string
      manifestSha256: string
      artifacts: Array<{ id: string; name: string; sha256: string }>
    }
  }> => ipcRenderer.invoke('training:transformMidi', options),
  cancelTrainingJob: (jobId: string): Promise<boolean> =>
    ipcRenderer.invoke('training:cancel', jobId),

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
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      progress: {
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
      }
    ): void => callback(progress)
    ipcRenderer.on('training:progress', listener)
    return () => ipcRenderer.removeListener('training:progress', listener)
  },

  openLyricsFileDialog: (): Promise<{ filePath: string; content: string } | null> =>
    ipcRenderer.invoke('dialog:openLyricsFile'),

  // Song APIs
  createSongFolder: (
    parentPath: string,
    folderName: string,
    audioPath?: string
  ): Promise<{ id: string; path: string; name: string } | null> =>
    ipcRenderer.invoke('song:createFolder', parentPath, folderName, audioPath),

  deleteSongFolder: (songPath: string): Promise<boolean> =>
    ipcRenderer.invoke('song:deleteFolder', songPath),

  importAudio: (
    songPath: string,
    audioSourcePath: string
  ): Promise<{ filePath: string; filename: string } | null> =>
    ipcRenderer.invoke('song:importAudio', songPath, audioSourcePath),

  readSongIni: (songPath: string): Promise<Record<string, string | number> | null> =>
    ipcRenderer.invoke('song:readIni', songPath),

  writeSongIni: (songPath: string, metadata: Record<string, unknown>): Promise<boolean> =>
    ipcRenderer.invoke('song:writeIni', songPath, metadata),

  searchSongMetadata: (request: SongMetadataSearchRequest): Promise<SongMetadataSearchResult[]> =>
    ipcRenderer.invoke('song:searchMetadata', request),

  fetchMetadataArtwork: (artwork: MetadataArtwork): Promise<string | null> =>
    ipcRenderer.invoke('song:fetchMetadataArtwork', artwork),

  readSongMidi: (songPath: string): Promise<{ type: 'midi' | 'chart'; data: string } | null> =>
    ipcRenderer.invoke('song:readMidi', songPath),

  writeSongMidi: (songPath: string, midiBase64: string): Promise<boolean> =>
    ipcRenderer.invoke('song:writeMidi', songPath, midiBase64),

  writeSongChart: (songPath: string, chartText: string): Promise<boolean> =>
    ipcRenderer.invoke('song:writeChart', songPath, chartText),

  exportSng: (
    songPath: string,
    metadata: Record<string, unknown>,
    outputPath: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('song:exportSng', songPath, metadata, outputPath),

  exportCon: (
    songPath: string,
    metadata: Record<string, unknown>,
    outputPath: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('song:exportCon', songPath, metadata, outputPath),

  fileExists: (filePath: string): Promise<boolean> => ipcRenderer.invoke('fs:fileExists', filePath),

  // Album art APIs
  readAlbumArt: (songPath: string): Promise<string | null> =>
    ipcRenderer.invoke('song:readAlbumArt', songPath),

  writeAlbumArt: (songPath: string, dataUrl: string): Promise<boolean> =>
    ipcRenderer.invoke('song:writeAlbumArt', songPath, dataUrl),

  // Audio APIs
  readAudio: (songPath: string): Promise<{ filePath: string; filename: string }[] | null> =>
    ipcRenderer.invoke('song:readAudio', songPath),

  readAudioJson: (songPath: string): Promise<Record<string, unknown> | null> =>
    ipcRenderer.invoke('audio:readJson', songPath),

  writeAudioJson: (songPath: string, data: unknown): Promise<boolean> =>
    ipcRenderer.invoke('audio:writeJson', songPath, data),

  readVenueJson: (songPath: string): Promise<Record<string, unknown> | null> =>
    ipcRenderer.invoke('venue:readJson', songPath),

  writeVenueJson: (songPath: string, data: unknown): Promise<boolean> =>
    ipcRenderer.invoke('venue:writeJson', songPath, data),

  // Video APIs
  openVideoDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openVideo'),

  importVideo: (
    songPath: string,
    videoSourcePath: string
  ): Promise<{ filePath: string; filename: string } | null> =>
    ipcRenderer.invoke('video:import', songPath, videoSourcePath),

  scanVideo: (songPath: string): Promise<{ filePath: string; filename: string } | null> =>
    ipcRenderer.invoke('video:scan', songPath),

  readVideoJson: (songPath: string): Promise<Record<string, unknown> | null> =>
    ipcRenderer.invoke('video:readJson', songPath),

  writeVideoJson: (songPath: string, data: unknown): Promise<boolean> =>
    ipcRenderer.invoke('video:writeJson', songPath, data),

  downloadVideoUrl: (
    songPath: string,
    url: string
  ): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke('video:download-url', songPath, url),

  onDownloadProgress: (callback: (percent: number) => void): (() => void) => {
    const handler = (_event: unknown, percent: number): void => callback(percent)
    ipcRenderer.on('video:download-progress', handler)
    return () => ipcRenderer.removeListener('video:download-progress', handler)
  },

  getWaveformSource: (songPath: string): Promise<{ filePath: string } | null> =>
    ipcRenderer.invoke('audio:waveform', songPath),

  // Export APIs
  saveVideoDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:saveVideo'),

  exportVideo: (options: {
    videoPath: string
    audioPath: string
    outputPath: string
    offsetMs: number
    trimStartMs: number
    trimEndMs: number
  }): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('video:export', options),

  onExportProgress: (callback: (percent: number) => void): (() => void) => {
    const handler = (_event: unknown, percent: number): void => callback(percent)
    ipcRenderer.on('video:export-progress', handler)
    return () => ipcRenderer.removeListener('video:export-progress', handler)
  },

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
  }): Promise<{ runId: string }> => ipcRenderer.invoke('strum:start', options),

  cancelAutoChart: (runId: string): Promise<boolean> => ipcRenderer.invoke('strum:cancel', runId),

  onAutoChartProgress: (
    callback: (event: {
      runId: string
      stage: string
      message: string
      percent?: number
      currentItem?: string
    }) => void
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: {
        runId: string
        stage: string
        message: string
        percent?: number
        currentItem?: string
      }
    ): void => callback(payload)
    ipcRenderer.on('strum:progress', handler)
    return () => ipcRenderer.removeListener('strum:progress', handler)
  },

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
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: {
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
      }
    ): void => callback(payload)
    ipcRenderer.on('strum:complete', handler)
    return () => ipcRenderer.removeListener('strum:complete', handler)
  },

  onAutoChartError: (
    callback: (event: { runId: string; message: string }) => void
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: {
        runId: string
        message: string
      }
    ): void => callback(payload)
    ipcRenderer.on('strum:error', handler)
    return () => ipcRenderer.removeListener('strum:error', handler)
  },

  getRuntimeStatus: (): Promise<{
    managed: boolean
    ready: boolean
    installing: boolean
    pythonPath: string
    pythonBuildTag: string
    pythonVersion: string
    isUpgrade: boolean
  }> => ipcRenderer.invoke('runtime:status'),

  bootstrapRuntime: (): Promise<{ ok: boolean; skipped?: boolean; message?: string }> =>
    ipcRenderer.invoke('runtime:bootstrap'),

  // App update channel (stable vs. beta/pre-release)
  getUpdateChannel: (): Promise<{ betaChannel: boolean }> =>
    ipcRenderer.invoke('updater:getChannel'),

  setUpdateChannel: (betaEnabled: boolean): Promise<{ ok: boolean; betaChannel: boolean }> =>
    ipcRenderer.invoke('updater:setChannel', betaEnabled),

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
  ): (() => void) => {
    const handler = (
      _event: unknown,
      status: {
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
      }
    ): void => callback(status)
    ipcRenderer.on('updater:status', handler)
    return () => ipcRenderer.removeListener('updater:status', handler)
  },

  // App menu command events
  onMenuCommand: (callback: (command: string, payload?: unknown) => void): (() => void) => {
    const handler = (_event: unknown, data: { command: string; payload?: unknown }): void => {
      callback(data.command, data.payload)
    }
    ipcRenderer.on('menu:command', handler)
    return () => ipcRenderer.removeListener('menu:command', handler)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
