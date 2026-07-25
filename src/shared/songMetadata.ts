export type MetadataSource = 'musicbrainz' | 'theaudiodb'

export type MetadataArtwork =
  | { source: 'cover-art-archive'; releaseGroupId: string }
  | { source: 'theaudiodb'; url: string }

export interface SongMetadataSearchRequest {
  artist: string
  title: string
  durationMs?: number
}

export interface SongMetadataSearchResult {
  id: string
  title: string
  artist: string
  album?: string
  year?: string
  genre?: string
  durationMs?: number
  artwork?: MetadataArtwork
  sources: MetadataSource[]
  score: number
}

type MusicBrainzRelease = {
  title?: string
  date?: string
  status?: string
  'release-group'?: {
    id?: string
    'first-release-date'?: string
    'primary-type'?: string
    'secondary-types'?: string[]
  }
}

type MusicBrainzRecording = {
  id?: string
  title?: string
  score?: number
  length?: number
  'first-release-date'?: string
  'artist-credit'?: Array<{ name?: string; joinphrase?: string }>
  releases?: MusicBrainzRelease[]
  genres?: Array<{ name?: string; count?: number }>
  tags?: Array<{ name?: string; count?: number }>
}

type TheAudioDbTrack = {
  idTrack?: string
  strTrack?: string
  strArtist?: string
  strAlbum?: string
  intYearReleased?: string
  strGenre?: string
  strStyle?: string
  strTrackThumb?: string
  strMusicBrainzID?: string
  intDuration?: string
}

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/\b(feat|featuring|ft)\.?\b/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// Non-Latin text (e.g. Japanese titles) normalizes to '' above, which would
// make every such title compare equal. Fall back to a Unicode-aware form that
// keeps letters from any script.
function normalizeUnicode(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, ' ')
    .trim()
}

function sameNormalized(a: string, b: string): boolean {
  const latinA = normalize(a)
  const latinB = normalize(b)
  if (latinA && latinB) return latinA === latinB
  const unicodeA = normalizeUnicode(a)
  return unicodeA !== '' && unicodeA === normalizeUnicode(b)
}

function firstYear(...dates: Array<string | undefined>): string | undefined {
  for (const date of dates) {
    const match = date?.match(/^\d{4}/)
    if (match) return match[0]
  }
  return undefined
}

function topName(values?: Array<{ name?: string; count?: number }>): string | undefined {
  return values?.filter((value) => value.name).sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0]
    ?.name
}

function releaseScore(release: MusicBrainzRelease): number {
  const status = release.status?.toLocaleLowerCase()
  const primaryType = release['release-group']?.['primary-type']?.toLocaleLowerCase()
  const secondaryTypes = (release['release-group']?.['secondary-types'] ?? []).map((type) =>
    type.toLocaleLowerCase()
  )
  let score = status === 'official' ? 40 : status === 'bootleg' ? -50 : 0
  if (primaryType && ['album', 'single', 'ep'].includes(primaryType)) score += 15
  if (secondaryTypes.some((type) => ['live', 'remix', 'dj-mix'].includes(type))) score -= 90
  if (secondaryTypes.includes('compilation')) score -= 15
  return score
}

function bestRelease(releases: MusicBrainzRelease[] = []): MusicBrainzRelease | undefined {
  return [...releases].sort((a, b) => {
    const scoreDifference = releaseScore(b) - releaseScore(a)
    if (scoreDifference !== 0) return scoreDifference
    return (a.date ?? '9999').localeCompare(b.date ?? '9999')
  })[0]
}

function matchScore(
  result: { title: string; artist: string; durationMs?: number },
  request?: SongMetadataSearchRequest
): number {
  if (!request) return 0
  let score = 0
  const resultTitle = normalize(result.title)
  const resultArtist = normalize(result.artist)
  const requestedTitle = normalize(request.title)
  const requestedArtist = normalize(request.artist)
  if (requestedTitle && resultTitle === requestedTitle) score += 45
  else if (requestedTitle && resultTitle.includes(requestedTitle)) score += 20
  if (requestedArtist && resultArtist === requestedArtist) score += 40
  else if (requestedArtist && resultArtist.includes(requestedArtist)) score += 18
  if (request.durationMs && result.durationMs) {
    const difference = Math.abs(request.durationMs - result.durationMs)
    score += Math.max(0, 20 - difference / 1000)
  }
  const variantWords = ['live', 'remix', 'karaoke', 'instrumental', 'tribute']
  for (const word of variantWords) {
    if (resultTitle.includes(word) && !requestedTitle.includes(word)) score -= 18
  }
  return score
}

function escapeLucenePhrase(value: string): string {
  return value.replace(/([\\"])/g, '\\$1')
}

export function buildMusicBrainzQuery(request: SongMetadataSearchRequest): string {
  const clauses: string[] = []
  if (request.title.trim()) clauses.push(`recording:"${escapeLucenePhrase(request.title.trim())}"`)
  if (request.artist.trim()) clauses.push(`artist:"${escapeLucenePhrase(request.artist.trim())}"`)
  return clauses.join(' AND ')
}

export function parseMusicBrainzSearchResponse(
  payload: unknown,
  request?: SongMetadataSearchRequest
): SongMetadataSearchResult[] {
  const recordings = (payload as { recordings?: MusicBrainzRecording[] })?.recordings
  if (!Array.isArray(recordings)) return []

  return recordings
    .flatMap((recording) => {
      if (!recording || typeof recording !== 'object' || !recording.id || !recording.title)
        return []
      const release = bestRelease(recording.releases)
      const artist = (recording['artist-credit'] ?? [])
        .map((credit) => `${credit.name ?? ''}${credit.joinphrase ?? ''}`)
        .join('')
        .trim()
      if (!artist) return []
      const durationMs = Number.isFinite(recording.length) ? recording.length : undefined
      const releaseGroupId = release?.['release-group']?.id
      const result: SongMetadataSearchResult = {
        id: recording.id,
        title: recording.title,
        artist,
        album: release?.title,
        year: firstYear(
          recording['first-release-date'],
          release?.['release-group']?.['first-release-date'],
          release?.date
        ),
        genre: topName(recording.genres) ?? topName(recording.tags),
        durationMs,
        artwork: releaseGroupId ? { source: 'cover-art-archive', releaseGroupId } : undefined,
        sources: ['musicbrainz'],
        score: recording.score ?? 0
      }
      result.score += matchScore(result, request) + (release ? releaseScore(release) : 0)
      return [result]
    })
    .sort((a, b) => b.score - a.score)
}

export function parseTheAudioDbSearchResponse(
  payload: unknown,
  request?: SongMetadataSearchRequest
): SongMetadataSearchResult[] {
  const tracks = (payload as { track?: TheAudioDbTrack[] })?.track
  if (!Array.isArray(tracks)) return []
  return tracks.flatMap((track) => {
    if (!track?.idTrack || !track.strTrack || !track.strArtist) return []
    const durationMs = Number(track.intDuration)
    const result: SongMetadataSearchResult = {
      id: track.strMusicBrainzID || `theaudiodb:${track.idTrack}`,
      title: track.strTrack,
      artist: track.strArtist,
      album: track.strAlbum || undefined,
      year: firstYear(track.intYearReleased),
      genre: track.strGenre || track.strStyle || undefined,
      durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : undefined,
      artwork: track.strTrackThumb ? { source: 'theaudiodb', url: track.strTrackThumb } : undefined,
      sources: ['theaudiodb'],
      score: 75
    }
    result.score += matchScore(result, request)
    return [result]
  })
}

export function mergeMetadataResults(
  ...providerResults: SongMetadataSearchResult[][]
): SongMetadataSearchResult[] {
  const merged: SongMetadataSearchResult[] = []
  for (const result of providerResults.flat()) {
    const existing = merged.find(
      (candidate) =>
        candidate.id === result.id ||
        (sameNormalized(candidate.title, result.title) &&
          sameNormalized(candidate.artist, result.artist))
    )
    if (!existing) {
      merged.push({ ...result, sources: [...result.sources] })
      continue
    }
    existing.album ||= result.album
    existing.year ||= result.year
    existing.genre ||= result.genre
    existing.durationMs ||= result.durationMs
    // Prefer TheAudioDB's direct track image; fall back to release-group artwork.
    if (result.artwork?.source === 'theaudiodb' || !existing.artwork)
      existing.artwork = result.artwork
    existing.sources = [...new Set([...existing.sources, ...result.sources])]
    existing.score = Math.max(existing.score, result.score) + 10
  }
  return merged.sort((a, b) => b.score - a.score)
}
