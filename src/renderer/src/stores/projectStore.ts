// Project-level store (global state)
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ProjectState, AppSettings, UIState, NoteModifiers } from '../types'
import { cloneDefaultHotkeys } from '../utils/hotkeys'

interface ProjectStore extends ProjectState {
  // Actions
  setLoadedFolder: (path: string | null) => void
  addSong: (songId: string) => void
  removeSong: (songId: string) => void
  setActiveSong: (songId: string | null) => void
  clearProject: () => void
}

export const useProjectStore = create<ProjectStore>()((set) => ({
  // Initial state
  loadedFolderPath: null,
  songIds: [],
  activeSongId: null,

  // Actions
  setLoadedFolder: (path) =>
    set({ loadedFolderPath: path, songIds: [], activeSongId: null }),

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

  clearProject: () => set({ loadedFolderPath: null, songIds: [], activeSongId: null })
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
  hotkeys: cloneDefaultHotkeys()
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
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<SettingsStore>)
      })
    }
  )
)

// UI state store
interface UIStore extends UIState {
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

export const useUIStore = create<UIStore>()((set) => ({
  // Initial state
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

  // Actions
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
  setSettingsModalOpen: (open) => set({ isSettingsModalOpen: open })
}))
