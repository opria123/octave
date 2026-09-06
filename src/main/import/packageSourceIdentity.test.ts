import { describe, expect, it } from 'vitest'
import { normalizedPackageEntryLocator, packageEntryIdentity } from './packageSourceIdentity'

describe('package entry identity', () => {
  it('binds multi-song ZIP and RB3CON entries to their adapter locator, not enumeration order', () => {
    const container = 'a'.repeat(64)
    const midi = 'b'.repeat(64)
    expect(packageEntryIdentity('zip', container, 'first/', midi)).not.toBe(
      packageEntryIdentity('zip', container, 'second/', midi)
    )
    expect(packageEntryIdentity('rb3con', container, 'song_one', midi)).not.toBe(
      packageEntryIdentity('rb3con', container, 'song_two', midi)
    )
  })

  it('normalizes adapter-private keys consistently across inventory and extraction', () => {
    expect(normalizedPackageEntryLocator('.\\SONGS\\Song_One\\')).toBe('songs/song_one/')
  })
})
