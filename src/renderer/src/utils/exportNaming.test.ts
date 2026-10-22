import { describe, expect, it } from 'vitest'
import { joinExportPath, resolveExportName, stripExportSuffix } from './exportNaming'

describe('export naming', () => {
  it('strips every known format suffix, case-insensitively', () => {
    expect(stripExportSuffix('Song.sng')).toBe('Song')
    expect(stripExportSuffix('Song_RB3CON')).toBe('Song')
    expect(stripExportSuffix('Song.Chart')).toBe('Song')
    expect(stripExportSuffix('Song.sng_rb3con')).toBe('Song')
    expect(stripExportSuffix('  Song  ')).toBe('Song')
  })

  it('applies the suffix for the chosen format', () => {
    expect(resolveExportName('My Song', 'sng', 'x')).toBe('My Song.sng')
    expect(resolveExportName('My Song.sng', 'rb3con', 'x')).toBe('My Song_rb3con')
    expect(resolveExportName('My Song_rb3con', 'chart', 'x')).toBe('My Song')
    expect(resolveExportName('My Song.chart', 'sng', 'x')).toBe('My Song.sng')
  })

  it('falls back to a sanitized song title when the field is empty', () => {
    expect(resolveExportName('', 'sng', 'A/B: C?')).toBe('A_B_ C_.sng')
    expect(resolveExportName('   ', 'chart', undefined)).toBe('song')
    expect(resolveExportName('.sng', 'chart', 'Title')).toBe('Title')
  })

  it('joins with the separator style of the folder', () => {
    expect(joinExportPath('C:\\Exports', 'a.sng')).toBe('C:\\Exports\\a.sng')
    expect(joinExportPath('C:\\Exports\\', 'a.sng')).toBe('C:\\Exports\\a.sng')
    expect(joinExportPath('/home/me/exports', 'a')).toBe('/home/me/exports/a')
  })
})
