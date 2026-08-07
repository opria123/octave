import { describe, expect, it } from 'vitest'
import { organizeLibrarySongs } from './libraryOrganization'

const songs = [
  { id: '3', name: '10 Years', artist: 'Zebra', year: '1999', addedAt: 300 },
  { id: '2', name: 'apple', artist: 'Beta', year: '2020', addedAt: 200 },
  { id: '1', name: 'Apple', artist: 'Alpha', year: 'Released 2010', addedAt: 100 },
  { id: '4', name: '2 Minutes', artist: 'Beta' }
]

describe('organizeLibrarySongs', () => {
  it('sorts deterministically by title using natural ordering and artist as a tie-breaker', () => {
    expect(organizeLibrarySongs(songs, '', 'title', 'none')[0].songs.map((song) => song.id)).toEqual([
      '4',
      '3',
      '1',
      '2'
    ])
  })

  it('filters title and artist case-insensitively', () => {
    expect(organizeLibrarySongs(songs, 'beta', 'title', 'none')[0].songs.map((song) => song.id)).toEqual([
      '4',
      '2'
    ])
  })

  it('groups titles under stable initial headers', () => {
    expect(organizeLibrarySongs(songs, '', 'title', 'title-initial').map((group) => group.label)).toEqual([
      '#',
      'A'
    ])
  })

  it('orders artist groups alphabetically regardless of the selected song sort', () => {
    expect(organizeLibrarySongs(songs, '', 'title', 'artist').map((group) => group.label)).toEqual([
      'Alpha',
      'Beta',
      'Zebra'
    ])
  })

  it('sorts by time added in both directions with unknown dates last', () => {
    expect(organizeLibrarySongs(songs, '', 'added-newest', 'none')[0].songs.map((song) => song.id)).toEqual([
      '3',
      '2',
      '1',
      '4'
    ])
    expect(organizeLibrarySongs(songs, '', 'added-oldest', 'none')[0].songs.map((song) => song.id)).toEqual([
      '1',
      '2',
      '3',
      '4'
    ])
  })

  it('sorts and groups by normalized song year with unknown years last', () => {
    expect(organizeLibrarySongs(songs, '', 'year-newest', 'none')[0].songs.map((song) => song.id)).toEqual([
      '2',
      '1',
      '3',
      '4'
    ])
    expect(organizeLibrarySongs(songs, '', 'title', 'year').map((group) => group.label)).toEqual([
      '2020',
      '2010',
      '1999',
      'Unknown Year'
    ])
  })

  // A numeric title in song.ini, or a stale library cache written before that
  // was fixed, must never be able to take the whole app down.
  it('tolerates non-string metadata without throwing', () => {
    const poisoned = [
      { id: '1', name: 1979 as unknown as string, artist: 99 as unknown as string, year: 1979 as unknown as string },
      { id: '2', name: 'Apple', artist: 'Alpha', year: '2020' }
    ]

    for (const group of ['none', 'title-initial', 'artist', 'year'] as const) {
      expect(() => organizeLibrarySongs(poisoned, '', 'title', group)).not.toThrow()
      expect(() => organizeLibrarySongs(poisoned, '19', 'artist', group)).not.toThrow()
    }

    expect(
      organizeLibrarySongs(poisoned, '', 'title', 'title-initial').map((g) => g.label)
    ).toEqual(['#', 'A'])
  })
})
