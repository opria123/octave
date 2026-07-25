import { describe, expect, it } from 'vitest'
import {
  buildMusicBrainzQuery,
  mergeMetadataResults,
  parseMusicBrainzSearchResponse,
  parseTheAudioDbSearchResponse
} from './songMetadata'

const request = { artist: 'Queen', title: 'Under Pressure', durationMs: 248_000 }

describe('song metadata search', () => {
  it('builds a fielded MusicBrainz query and supports a missing artist', () => {
    expect(buildMusicBrainzQuery(request)).toBe('recording:"Under Pressure" AND artist:"Queen"')
    expect(buildMusicBrainzQuery({ artist: '', title: 'Under Pressure' })).toBe(
      'recording:"Under Pressure"'
    )
  })

  it('prefers official studio releases and ranks exact duration matches', () => {
    const results = parseMusicBrainzSearchResponse(
      {
        recordings: [
          {
            id: 'live-recording',
            title: 'Under Pressure (Live)',
            score: 100,
            length: 300_000,
            'artist-credit': [{ name: 'Queen' }],
            releases: [
              {
                title: 'Live Bootleg',
                status: 'Bootleg',
                'release-group': {
                  id: 'live-release-group',
                  'primary-type': 'Album',
                  'secondary-types': ['Live']
                }
              }
            ]
          },
          {
            id: 'studio-recording',
            title: 'Under Pressure',
            score: 95,
            length: 248_000,
            'first-release-date': '1981-10-26',
            'artist-credit': [{ name: 'Queen' }],
            releases: [
              {
                title: 'Hot Space',
                status: 'Official',
                date: '1982-05-21',
                'release-group': {
                  id: 'studio-release-group',
                  'primary-type': 'Album'
                }
              }
            ]
          }
        ]
      },
      request
    )

    expect(results[0]).toMatchObject({
      id: 'studio-recording',
      title: 'Under Pressure',
      album: 'Hot Space',
      year: '1981',
      durationMs: 248_000,
      artwork: {
        source: 'cover-art-archive',
        releaseGroupId: 'studio-release-group'
      },
      sources: ['musicbrainz']
    })
  })

  it('maps TheAudioDB fields and merges them into a MusicBrainz match', () => {
    const musicBrainz = parseMusicBrainzSearchResponse(
      {
        recordings: [
          {
            id: 'shared-mbid',
            title: 'Under Pressure',
            score: 100,
            'artist-credit': [{ name: 'Queen' }],
            releases: [{ title: 'Hot Space' }]
          }
        ]
      },
      request
    )
    const theAudioDb = parseTheAudioDbSearchResponse(
      {
        track: [
          {
            idTrack: '32724045',
            strTrack: 'Under Pressure',
            strArtist: 'Queen',
            strAlbum: 'Hot Space',
            strGenre: 'Rock',
            strTrackThumb: 'https://r2.theaudiodb.com/images/cover.jpg',
            strMusicBrainzID: 'shared-mbid',
            intDuration: '248000'
          }
        ]
      },
      request
    )

    expect(mergeMetadataResults(musicBrainz, theAudioDb)[0]).toMatchObject({
      id: 'shared-mbid',
      genre: 'Rock',
      sources: ['musicbrainz', 'theaudiodb'],
      artwork: {
        source: 'theaudiodb',
        url: 'https://r2.theaudiodb.com/images/cover.jpg'
      }
    })
  })

  it('keeps distinct non-Latin titles separate while still merging identical ones', () => {
    const gurenge = {
      id: 'mb-gurenge',
      title: '紅蓮華',
      artist: 'LiSA',
      sources: ['musicbrainz'] as string[],
      score: 90
    }
    const homura = {
      id: 'adb-homura',
      title: '炎',
      artist: 'LiSA',
      genre: 'J-Pop',
      sources: ['theaudiodb'] as string[],
      score: 80
    }
    const gurengeFromAudioDb = {
      id: 'adb-gurenge',
      title: '紅蓮華',
      artist: 'LiSA',
      genre: 'Anime',
      sources: ['theaudiodb'] as string[],
      score: 75
    }

    const merged = mergeMetadataResults([gurenge], [homura, gurengeFromAudioDb])

    expect(merged).toHaveLength(2)
    const mergedGurenge = merged.find((result) => result.id === 'mb-gurenge')
    expect(mergedGurenge).toMatchObject({
      genre: 'Anime',
      sources: ['musicbrainz', 'theaudiodb']
    })
    expect(merged.find((result) => result.id === 'adb-homura')).toMatchObject({ genre: 'J-Pop' })
  })

  it('drops malformed provider records', () => {
    expect(parseMusicBrainzSearchResponse({ recordings: [{ title: 'No ID' }, null] })).toEqual([])
    expect(parseTheAudioDbSearchResponse({ track: [{ strTrack: 'No ID' }, null] })).toEqual([])
  })
})
