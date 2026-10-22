// Project-level store (global state)
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  LayoutPanelName,
  PanelVisibility, ProjectState, AppSettings, UIState, NoteModifiers, ValidationIssue } from '../types'
import { cloneDefaultHotkeys } from '../utils/hotkeys'

interface ProjectStore extends ProjectState {
  libraryLoadVersion: number
  pendingActiveSongId: string | null
  // Actions
  setLoadedFolder: (path: string | null) => void
  addSong: (songId: string) => void
  removeSong: (songId: string) => void
  setActiveSong: (songId: string | null) => void
  setPendingActiveSong: (songId: string | null) => void
  clearProject: () => void
}

export const useProjectStore = create<ProjectStore>()((set) => ({
  // Initial state
  loadedFolderPath: null,
  songIds: [],
  activeSongId: null,
  libraryLoadVersion: 0,
  pendingActiveSongId: null,

  // Actions
  setLoadedFolder: (path) =>
    set((state) =>
      state.loadedFolderPath === path
        ? { libraryLoadVersion: state.libraryLoadVersion + 1 }
        : {
            loadedFolderPath: path,
            songIds: [],
            activeSongId: null,
            pendingActiveSongId: null,
            libraryLoadVersion: state.libraryLoadVersion + 1
          }
    ),

  addSong: (songId) =>
    set((state) => ({
      songIds: state.songIds.includes(songId)
        ? state.songIds
        : [...state.songIds, songId]
    })),

  removeSong: (songId) =>
    set((state) => ({
      songIds: state.songIds.filter((id) => id !== songId),
      activeSongId: state.activeSongId === songId ? null : state.activeSongId
    })),

  setActiveSong: (songId) => set({ activeSongId: songId }),

  setPendingActiveSong: (songId) => set({ pendingActiveSongId: songId }),

  clearProject: () =>
    set((state) => ({
      loadedFolderPath: null,
      songIds: [],
      activeSongId: null,
      pendingActiveSongId: null,
      libraryLoadVersion: state.libraryLoadVersion + 1
    })),
}))

// App settings store (persisted)
interface SettingsStore extends AppSettings {
  updateSettings: (settings: Partial<AppSettings>) => void
  resetSettings: () => void
}

const defaultSettings: AppSettings = {
  autosaveEnabled: true,
  autosaveIntervalMs: 2000,
  theme: 'dark',
  highwaySpeed: 1.0,
  audioLatencyMs: 0,
  volume: 0.8,
  pianoRollZoom: 2.0,
  snapDivision: 4,
  lastOpenedFolder: undefined,
  leftyFlip: false,
  waveformAudioSourcePath: undefined,
  enableAutoChart: true,
  autoChartOutputDir: undefined,
  autoChartDisableOnlineLookup: false,
  autoChartDownloadVideo: true,
  autoChartKeepStems: false,
  autoChartStarPower: true,
  autoChartImproveTempo: true,
  autoChartSnapDrums: false,
  autoChartEnabledTracks: {
    drums: true,
    guitar: true,
    bass: true,
    vocals: true,
    harmonies: true,
    keys: true,
    proKeys: true
  },
  sngLastExportDir: undefined,
  librarySort: 'title',
  libraryGroup: 'title-initial',
  betaUpdates: false,
  invertPianoRollVerticalScroll: false,
  hotkeys: cloneDefaultHotkeys(),
  validationMinSustainGuitar: 48,
  validationMinSustainBass: 48,
  validationMinSustainKeys: 48,
  validationMinSustainDrums: 0,
  validationEnableOverlapsCheck: true,
  validationEnableStarPowerCheck: true,
  validationEnableDrumImpossibilityCheck: true,
  validationDrumTimeThresholdMs: 40,
  validationDrumCrossoverThresholdMs: 80
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      ...defaultSettings,

      updateSettings: (settings) => set((state) => ({ ...state, ...settings })),

      resetSettings: () => set(defaultSettings)
    }),
    {
      name: 'chart-editor-settings',
      merge: (persisted, current) => {
        const persistedSettings = persisted as Partial<SettingsStore>
        return {
          ...current,
          ...persistedSettings,
          // Deep-merge hotkeys so actions added in newer versions keep their
          // defaults for users with an older persisted hotkey map.
          hotkeys: { ...cloneDefaultHotkeys(), ...(persistedSettings?.hotkeys ?? {}) }
        }
      }
    }
  )
)

// UI state store
interface UIStore extends UIState {
  setPanelVisible: (panel: LayoutPanelName, visible: boolean) => void
  setTopPaneSizes: (sizes: number[]) => void
  setMainPaneSizes: (sizes: number[]) => void
  setLeftPanelWidth: (width: number) => void
  setRightPanelWidth: (width: number) => void
  setBottomPanelHeight: (height: number) => void
  setBottomPanelTab: (tab: 'midi' | 'video') => void
  setSelectedVenueEvent: (event: UIState['selectedVenueEvent']) => void
  setFocusedPanel: (panel: UIState['focusedPanel']) => void
  setEditTool: (tool: UIState['editTool']) => void
  toggleModifier: (key: keyof NoteModifiers) => void
  clearModifiers: () => void
  togglePreviewFullscreen: () => void
  setSettingsModalOpen: (open: boolean) => void
  setExportModalOpen: (open: boolean) => void
  toggleVocalPitchPlayback: () => void
  toggleHighwayWaveform: () => void
  setValidationIssues: (issues: ValidationIssue[] | null) => void
}

const defaultModifiers: NoteModifiers = {
  cymbalOrTap: false,
  ghostOrHopo: false,
  accent: false,
  openOrKick: false,
  starPower: false,
  solo: false,
  talkie: false
}

const defaultPanelVisible: PanelVisibility = {
  explorer: true,
  preview: true,
  properties: true,
  midi: true,
  video: true
}

// Layout state the user arranges by hand is persisted so the workspace comes
// back the way it was left (issue #73). Everything else in the UI store is
// transient and intentionally left out of `partialize`.
export const useUIStore = create<UIStore>()(
  persist(
    (set) => ({
  // Initial state
  panelVisible: { ...defaultPanelVisible },
  topPaneSizes: null,
  mainPaneSizes: null,
  leftPanelWidth: 250,
  rightPanelWidth: 300,
  bottomPanelHeight: 200,
  bottomPanelTab: 'midi',
  selectedVenueEvent: null,
  focusedPanel: null,
  editTool: 'select',
  noteModifiers: { ...defaultModifiers },
  isPreviewFullscreen: false,
  isSettingsModalOpen: false,
  isExportModalOpen: false,
  vocalPitchPlayback: false,
  showHighwayWaveform: false,
  validationIssues: null,

  // Actions
  setPanelVisible: (panel, visible) =>
    set((state) => ({ panelVisible: { ...state.panelVisible, [panel]: visible } })),
  setTopPaneSizes: (sizes) => set({ topPaneSizes: sizes }),
  setMainPaneSizes: (sizes) => set({ mainPaneSizes: sizes }),
  setLeftPanelWidth: (width) => set({ leftPanelWidth: width }),
  setRightPanelWidth: (width) => set({ rightPanelWidth: width }),
  setBottomPanelHeight: (height) => set({ bottomPanelHeight: height }),
  setBottomPanelTab: (tab) => set({ bottomPanelTab: tab }),
  setSelectedVenueEvent: (event) => set({ selectedVenueEvent: event }),
  setFocusedPanel: (panel) => set({ focusedPanel: panel }),
  setEditTool: (tool) => set({ editTool: tool }),
  toggleModifier: (key) =>
    set((state) => {
      const nextValue = !state.noteModifiers[key]
      if (!nextValue) {
        return {
          noteModifiers: { ...state.noteModifiers, [key]: false }
        }
      }

      return {
        noteModifiers: {
          cymbalOrTap: false,
          ghostOrHopo: false,
          accent: false,
          openOrKick: false,
          starPower: false,
          solo: false,
          talkie: false,
          [key]: true
        }
      }
    }),
  clearModifiers: () => set({ noteModifiers: { ...defaultModifiers } }),
  togglePreviewFullscreen: () => set((state) => ({ isPreviewFullscreen: !state.isPreviewFullscreen })),
  setSettingsModalOpen: (open) => set({ isSettingsModalOpen: open }),
  setExportModalOpen: (open) => set({ isExportModalOpen: open }),
  toggleVocalPitchPlayback: () => set((state) => ({ vocalPitchPlayback: !state.vocalPitchPlayback })),
  toggleHighwayWaveform: () => set((state) => ({ showHighwayWaveform: !state.showHighwayWaveform })),
  setValidationIssues: (issues) => set({ validationIssues: issues })
    }),
    {
      name: 'chart-editor-layout',
      partialize: (state) => ({
        panelVisible: state.panelVisible,
        topPaneSizes: state.topPaneSizes,
        mainPaneSizes: state.mainPaneSizes,
        bottomPanelTab: state.bottomPanelTab
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<UIState>
        return {
          ...current,
          ...saved,
          panelVisible: { ...current.panelVisible, ...(saved.panelVisible ?? {}) }
        }
      }
    }
  )
)
