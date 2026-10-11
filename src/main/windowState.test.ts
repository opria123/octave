import { describe, expect, it } from 'vitest'
import { fitBoundsToDisplays } from './windowState'

const primary = { x: 0, y: 0, width: 1920, height: 1040 }
const secondary = { x: 1920, y: 0, width: 1920, height: 1040 }
const defaults = { width: 1400, height: 900 }
const minimum = { width: 1024, height: 600 }

describe('fitBoundsToDisplays', () => {
  it('uses defaults when nothing was saved', () => {
    expect(fitBoundsToDisplays(null, [primary], defaults, minimum)).toEqual({
      width: 1400,
      height: 900
    })
  })

  it('keeps a saved size and position that is still on a display', () => {
    const saved = { x: 2000, y: 100, width: 1600, height: 800, isMaximized: false }
    expect(fitBoundsToDisplays(saved, [primary, secondary], defaults, minimum)).toEqual({
      x: 2000,
      y: 100,
      width: 1600,
      height: 800
    })
  })

  it('drops the position when the window would open on a display that is gone', () => {
    const saved = { x: 2000, y: 100, width: 1600, height: 800, isMaximized: false }
    expect(fitBoundsToDisplays(saved, [primary], defaults, minimum)).toEqual({
      width: 1600,
      height: 800
    })
  })

  it('never opens smaller than the window minimum', () => {
    const saved = { x: 10, y: 10, width: 300, height: 200, isMaximized: false }
    expect(fitBoundsToDisplays(saved, [primary], defaults, minimum)).toEqual({
      x: 10,
      y: 10,
      width: 1024,
      height: 600
    })
  })

  it('ignores garbage values', () => {
    const saved = {
      x: Number.NaN,
      y: 10,
      width: Number.POSITIVE_INFINITY,
      height: 700,
      isMaximized: false
    }
    expect(fitBoundsToDisplays(saved, [primary], defaults, minimum)).toEqual({
      width: 1400,
      height: 700
    })
  })
})
