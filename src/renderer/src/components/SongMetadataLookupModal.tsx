import { useCallback, useEffect, useState } from 'react'
import type { SongMetadata } from '../types'
import type { SongMetadataSearchResult } from '../../../shared/songMetadata'
import { publishAlbumArtUpdate } from '../utils/albumArtEvents'
import './SongMetadataLookupModal.css'

export function SongMetadataLookupModal({
  metadata,
  folderPath,
  onApply,
  onClose
}: {
  metadata: SongMetadata
  folderPath: string
  onApply: (metadata: Partial<SongMetadata>, artworkApplied: boolean) => void
  onClose: () => void
}): React.JSX.Element {
  const initialArtist = /^unknown(?: artist)?$/i.test(metadata.artist.trim()) ? '' : metadata.artist
  const [artist, setArtist] = useState(initialArtist)
  const [title, setTitle] = useState(metadata.name)
  const [results, setResults] = useState<SongMetadataSearchResult[]>([])
  const [selected, setSelected] = useState<SongMetadataSearchResult | null>(null)
  const [artwork, setArtwork] = useState<string | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [isLoadingArtwork, setIsLoadingArtwork] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const search = useCallback(
    async (searchArtist: string, searchTitle: string): Promise<void> => {
      const trimmedTitle = searchTitle.trim()
      if (!trimmedTitle) return
      setIsSearching(true)
      setError(null)
      setSelected(null)
      setArtwork(null)
      try {
        setResults(
          await window.api.searchSongMetadata({
            artist: searchArtist.trim(),
            title: trimmedTitle,
            durationMs: metadata.song_length
          })
        )
      } catch (searchError) {
        setResults([])
        setError(searchError instanceof Error ? searchError.message : String(searchError))
      } finally {
        setIsSearching(false)
      }
    },
    [metadata.song_length]
  )

  useEffect(() => {
    void search(initialArtist, metadata.name)
    // Search once when the freshly opened modal mounts; subsequent searches are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !isApplying) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isApplying, onClose])

  const selectResult = async (result: SongMetadataSearchResult): Promise<void> => {
    setSelected(result)
    setArtwork(null)
    setError(null)
    if (!result.artwork) return
    setIsLoadingArtwork(true)
    try {
      setArtwork(await window.api.fetchMetadataArtwork(result.artwork))
    } catch (artError) {
      setError(artError instanceof Error ? artError.message : String(artError))
    } finally {
      setIsLoadingArtwork(false)
    }
  }

  const applyResult = async (): Promise<void> => {
    if (!selected) return
    setIsApplying(true)
    setError(null)
    try {
      let artworkApplied = false
      if (artwork) {
        artworkApplied = await window.api.writeAlbumArt(folderPath, artwork)
        if (!artworkApplied) throw new Error('OCTAVE could not save the selected album artwork.')
        publishAlbumArtUpdate({ folderPath, dataUrl: artwork })
      }
      onApply(
        {
          name: selected.title,
          artist: selected.artist,
          ...(selected.album ? { album: selected.album } : {}),
          ...(selected.year ? { year: selected.year } : {}),
          ...(selected.genre ? { genre: selected.genre } : {})
        },
        artworkApplied
      )
      onClose()
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : String(applyError))
    } finally {
      setIsApplying(false)
    }
  }

  return (
    <div
      className="metadata-lookup-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isApplying) onClose()
      }}
    >
      <div
        className="metadata-lookup-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="metadata-lookup-title"
      >
        <div className="metadata-lookup-header">
          <div>
            <h2 id="metadata-lookup-title">
              <span className="metadata-lookup-title-icon" aria-hidden="true">
                ♪
              </span>
              Find song metadata
            </h2>
            <p>Search multiple music databases, choose the matching release, then apply it.</p>
          </div>
          <button
            type="button"
            className="metadata-lookup-close"
            onClick={onClose}
            disabled={isApplying}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <form
          className="metadata-lookup-search"
          onSubmit={(event) => {
            event.preventDefault()
            void search(artist, title)
          }}
        >
          <label>
            <span>Title</span>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-label="Title"
            />
          </label>
          <label>
            <span>Artist</span>
            <input
              value={artist}
              onChange={(event) => setArtist(event.target.value)}
              aria-label="Artist"
              placeholder="Optional"
            />
          </label>
          <button type="submit" disabled={isSearching || !title.trim()}>
            {isSearching ? 'Searching…' : 'Search'}
          </button>
        </form>

        {error && <div className="metadata-lookup-error">{error}</div>}

        <div className="metadata-lookup-content">
          <div className="metadata-lookup-results" role="listbox" aria-label="Metadata matches">
            {!isSearching && results.length === 0 && (
              <div className="metadata-lookup-empty">
                No matches found. Try changing the artist, title, or album.
              </div>
            )}
            {results.map((result) => (
              <button
                type="button"
                role="option"
                aria-selected={selected?.id === result.id}
                className={`metadata-lookup-result ${selected?.id === result.id ? 'selected' : ''}`}
                key={result.id}
                onClick={() => void selectResult(result)}
              >
                <div className="metadata-lookup-result-header">
                  <strong>{result.title}</strong>
                  <em>
                    {result.sources
                      .map((source) => (source === 'musicbrainz' ? 'MusicBrainz' : 'TheAudioDB'))
                      .join(' + ')}
                  </em>
                </div>
                <span>{result.artist}</span>
                <small>
                  {[result.album, result.year, result.genre].filter(Boolean).join(' · ') ||
                    'Recording metadata only'}
                </small>
              </button>
            ))}
          </div>

          <div className="metadata-lookup-preview">
            {selected ? (
              <>
                <div className="metadata-lookup-art">
                  {artwork ? (
                    <img src={artwork} alt={`${selected.album ?? selected.title} cover`} />
                  ) : (
                    <span>{isLoadingArtwork ? 'Loading artwork…' : 'No artwork found'}</span>
                  )}
                </div>
                <dl>
                  <dt>Title</dt>
                  <dd>{selected.title}</dd>
                  <dt>Artist</dt>
                  <dd>{selected.artist}</dd>
                  <dt>Album</dt>
                  <dd>{selected.album ?? '—'}</dd>
                  <dt>Year</dt>
                  <dd>{selected.year ?? '—'}</dd>
                  <dt>Genre</dt>
                  <dd>{selected.genre ?? '—'}</dd>
                </dl>
              </>
            ) : (
              <div className="metadata-lookup-empty">
                Select a result to preview its metadata and album art.
              </div>
            )}
          </div>
        </div>

        <div className="metadata-lookup-footer">
          <span>MusicBrainz + TheAudioDB metadata · Cover Art Archive + TheAudioDB artwork</span>
          <div>
            <button type="button" className="secondary" onClick={onClose} disabled={isApplying}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => void applyResult()}
              disabled={!selected || isApplying || isLoadingArtwork}
            >
              {isApplying ? 'Applying…' : 'Apply metadata'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
