import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { createApplicationMenuTemplate } from './applicationMenu'

describe('application menu', () => {
  it('registers native editing roles so macOS forwards shortcuts to focused inputs', () => {
    const template = createApplicationMenuTemplate({
      version: '1.0.0',
      sendCommand: vi.fn(),
      openExternal: vi.fn()
    })
    const editMenu = template.find((item) => item.label === 'Edit')
    const submenu = editMenu?.submenu as MenuItemConstructorOptions[]

    expect(submenu.map((item) => item.role).filter(Boolean)).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'selectAll'
    ])
  })
})
