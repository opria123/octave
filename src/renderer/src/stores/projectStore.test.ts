import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

let useSettingsStore: (typeof import('./projectStore'))['useSettingsStore']
let useProjectStore: (typeof import('./projectStore'))['useProjectStore']
let useUIStore: (typeof import('./projectStore'))['useUIStore']

describe('Auto-Chart settings', () => {
  beforeAll(async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size
      }
    })
    ;({ useProjectStore, useSettingsStore, useUIStore } = await import('./projectStore'))
  })

  afterEach(() => {
    useSettingsStore.getState().resetSettings()
    useProjectStore.getState().clearProject()
  })

  it('keeps reusable run preferences in the persisted settings store', () => {
    useSettingsStore.getState().updateSettings({
      autoChartDisableOnlineLookup: true,
      autoChartDownloadVideo: false,
      autoChartKeepStems: true,
      autoChartStarPower: false,
      autoChartImproveTempo: false,
      autoChartSnapDrums: true,
      autoChartEnabledTracks: {
        drums: true,
        guitar: false,
        bass: true,
        vocals: false,
        harmonies: false,
        keys: false,
        proKeys: false
      }
    })

    expect(useSettingsStore.getState()).toMatchObject({
      autoChartDisableOnlineLookup: true,
      autoChartDownloadVideo: false,
      autoChartKeepStems: true,
      autoChartStarPower: false,
      autoChartImproveTempo: false,
      autoChartSnapDrums: true,
      autoChartEnabledTracks: {
        drums: true,
        guitar: false,
        bass: true,
        vocals: false,
        harmonies: false,
        keys: false,
        proKeys: false
      }
    })

    const persisted = JSON.parse(localStorage.getItem('chart-editor-settings') ?? '{}')
    expect(persisted.state).toMatchObject({
      autoChartDisableOnlineLookup: true,
      autoChartDownloadVideo: false,
      autoChartKeepStems: true,
      autoChartStarPower: false,
      autoChartImproveTempo: false,
      autoChartSnapDrums: true,
      autoChartEnabledTracks: {
        drums: true,
        guitar: false,
        bass: true,
        vocals: false,
        harmonies: false,
        keys: false,
        proKeys: false
      }
    })
  })

  it('keeps an auto-chart selection for an in-place refresh only', () => {
    const project = useProjectStore.getState()
    project.setLoadedFolder('/songs')
    project.setPendingActiveSong('new-song')
    project.setLoadedFolder('/songs')

    expect(useProjectStore.getState().pendingActiveSongId).toBe('new-song')

    useProjectStore.getState().setLoadedFolder('/other-songs')

    expect(useProjectStore.getState().pendingActiveSongId).toBeNull()
  })
})

describe('Layout persistence (issue #73)', () => {
  it('persists panel visibility, split sizes and the bottom tab, but not transient UI state', () => {
    useUIStore.getState().setPanelVisible('properties', false)
    useUIStore.getState().setTopPaneSizes([200, 700, 0])
    useUIStore.getState().setMainPaneSizes([600, 250])
    useUIStore.getState().setBottomPanelTab('video')
    useUIStore.getState().setFocusedPanel('midi')

    const persisted = JSON.parse(localStorage.getItem('chart-editor-layout') ?? '{}')
    expect(persisted.state).toEqual({
      panelVisible: { explorer: true, preview: true, properties: false, midi: true, video: true },
      topPaneSizes: [200, 700, 0],
      mainPaneSizes: [600, 250],
      bottomPanelTab: 'video'
    })
    expect(persisted.state.focusedPanel).toBeUndefined()
  })
})
