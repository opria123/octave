export type LibrarySort =
  | 'title'
  | 'artist'
  | 'added-newest'
  | 'added-oldest'
  | 'year-newest'
  | 'year-oldest'
export type LibraryGroup = 'none' | 'title-initial' | 'artist' | 'year'

export interface LibrarySongSummary {
  id: string
  name: string
  artist: string
  year?: string
  addedAt?: number
}

export interface LibrarySongGroup<T extends LibrarySongSummary> {
  label: string
  songs: T[]
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

// Song metadata originates in song.ini and in the on-disk library cache, so a
// numeric title ("1979") or a stale cache entry can hand us a non-string here.
// Grouping the library must never be able to take the whole app down.
function text(value: unknown): string {
  if (typeof value === 'string') return value
  return value === undefined || value === null ? '' : String(value)
}

function initialGroup(value: unknown): string {
  const first = text(value).trim().charAt(0).toLocaleUpperCase()
  return /^[A-Z]$/.test(first) ? first : '#'
}

function numericYear(year?: unknown): number | null {
  const match = text(year).match(/\d{4}/)
  return match ? Number(match[0]) : null
}

export function organizeLibrarySongs<T extends LibrarySongSummary>(
  songs: T[],
  query: string,
  sort: LibrarySort,
  group: LibraryGroup
): LibrarySongGroup<T>[] {
  const normalizedQuery = text(query).trim().toLowerCase()
  const filtered = normalizedQuery
    ? songs.filter(({ name, artist }) =>
        `${text(name)}\n${text(artist)}`.toLowerCase().includes(normalizedQuery)
      )
    : songs

  const sorted = [...filtered].sort((left, right) => {
    let primary = 0
    if (sort === 'artist') primary = collator.compare(text(left.artist), text(right.artist))
    else if (sort === 'added-newest') primary = (right.addedAt ?? -Infinity) - (left.addedAt ?? -Infinity)
    else if (sort === 'added-oldest') primary = (left.addedAt ?? Infinity) - (right.addedAt ?? Infinity)
    else if (sort === 'year-newest') primary = (numericYear(right.year) ?? -Infinity) - (numericYear(left.year) ?? -Infinity)
    else if (sort === 'year-oldest') primary = (numericYear(left.year) ?? Infinity) - (numericYear(right.year) ?? Infinity)
    else primary = collator.compare(text(left.name), text(right.name))
    if (primary !== 0) return primary
    const secondary =
      sort === 'artist'
        ? collator.compare(text(left.name), text(right.name))
        : collator.compare(text(left.artist), text(right.artist))
    return secondary || collator.compare(text(left.id), text(right.id))
  })

  if (group === 'none') return [{ label: '', songs: sorted }]

  const grouped = new Map<string, T[]>()
  for (const song of sorted) {
    const label =
      group === 'artist'
        ? text(song.artist).trim() || 'Unknown Artist'
        : group === 'year'
          ? String(numericYear(song.year) ?? 'Unknown Year')
          : initialGroup(song.name)
    const existing = grouped.get(label)
    if (existing) existing.push(song)
    else grouped.set(label, [song])
  }

  return [...grouped]
    .sort(([left], [right]) => {
      if (left === '#') return -1
      if (right === '#') return 1
      if (left === 'Unknown Year') return 1
      if (right === 'Unknown Year') return -1
      if (group === 'year') return Number(right) - Number(left)
      return collator.compare(left, right)
    })
    .map(([label, groupedSongs]) => ({ label, songs: groupedSongs }))
}
