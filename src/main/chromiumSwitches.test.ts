import { describe, expect, it } from 'vitest'
import { chromiumSwitchesFor } from './chromiumSwitches'

describe('chromiumSwitchesFor', () => {
  it('always lets audio start without a user gesture', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(chromiumSwitchesFor(platform)).toContainEqual({
        name: 'autoplay-policy',
        value: 'no-user-gesture-required'
      })
    }
  })

  it('forces full-frame redraws on Windows so driver post-processing cannot accumulate (issue #80)', () => {
    expect(chromiumSwitchesFor('win32').map((s) => s.name)).toContain('ui-disable-partial-swap')
  })

  it('leaves partial swap enabled on other platforms', () => {
    expect(chromiumSwitchesFor('darwin').map((s) => s.name)).not.toContain(
      'ui-disable-partial-swap'
    )
    expect(chromiumSwitchesFor('linux').map((s) => s.name)).not.toContain('ui-disable-partial-swap')
  })
})
