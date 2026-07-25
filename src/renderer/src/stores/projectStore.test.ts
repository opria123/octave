import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

let useSettingsStore: (typeof import('./projectStore'))['useSettingsStore']

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
    ;({ useSettingsStore } = await import('./projectStore'))
  })

  afterEach(() => useSettingsStore.getState().resetSettings())

  it('keeps reusable run preferences in the persisted settings store', () => {
    useSettingsStore.getState().updateSettings({
      autoChartDisableOnlineLookup: true,
      autoChartDownloadVideo: false,
      autoChartKeepStems: true,
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
})
