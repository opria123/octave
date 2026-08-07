import { describe, expect, it } from 'vitest'
import { parseIniFile, serializeIniFile } from './iniFile'

describe('parseIniFile', () => {
  it('keeps titles that merely start with digits as strings', () => {
    // Regression: parseFloat("99 Problems") is 99, so these titles used to be
    // handed to the renderer as numbers and crashed the library view.
    const parsed = parseIniFile(
      ['[song]', 'name = 99 Problems', 'artist = 2 Live Crew', 'album = 3 Feet High'].join('\n')
    )

    expect(parsed.name).toBe('99 Problems')
    expect(parsed.artist).toBe('2 Live Crew')
    expect(parsed.album).toBe('3 Feet High')
  })

  it('still parses fully numeric values as numbers', () => {
    const parsed = parseIniFile(
      ['[song]', 'song_length = 257400', 'delay = -1200', 'preview_start_time = 30.5'].join('\n')
    )

    expect(parsed.song_length).toBe(257400)
    expect(parsed.delay).toBe(-1200)
    expect(parsed.preview_start_time).toBe(30.5)
  })

  it('reads values containing "=" and ignores keys outside [song]', () => {
    const parsed = parseIniFile(
      ['[other]', 'name = Ignored', '[song]', 'name = a=b', 'charter = STRUM'].join('\r\n')
    )

    expect(parsed.name).toBe('a=b')
    expect(parsed.charter).toBe('STRUM')
  })
})

describe('serializeIniFile', () => {
  it('round-trips a digit-leading title', () => {
    const ini = serializeIniFile({ name: '99 Problems', song_length: 257400, album: '' })

    expect(parseIniFile(ini).name).toBe('99 Problems')
    expect(parseIniFile(ini).song_length).toBe(257400)
    expect(ini).not.toContain('album')
  })
})
