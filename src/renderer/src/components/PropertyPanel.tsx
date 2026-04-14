// Property Panel - Right panel showing selected note/song properties
import { useState, useEffect, useCallback, useRef } from 'react'
import { useProjectStore, getSongStore } from '../stores'
import { tickToSeconds } from '../services/audioService'
import type { Note, VocalNote, SongMetadata, TempoEvent } from '../types'
import './PropertyPanel.css'

// Album art component with drag/drop
function AlbumArt({
  songId,
  folderPath
}: {
  songId: string
  folderPath: string
}): React.JSX.Element {
  const [artUrl, setArtUrl] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Load album art on mount
  useEffect(() => {
    const loadArt = async (): Promise<void> => {
      try {
        const url = await window.api.readAlbumArt(folderPath)
        setArtUrl(url)
      } catch (error) {
        console.error('Failed to load album art:', error)
      }
    }
    loadArt()
  }, [folderPath, songId])

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) return

      const reader = new FileReader()
      reader.onload = async (e) => {
        const dataUrl = e.target?.result as string
        if (dataUrl) {
          setArtUrl(dataUrl)
          await window.api.writeAlbumArt(folderPath, dataUrl)
        }
      }
      reader.readAsDataURL(file)
    },
    [folderPath]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)

      const file = e.dataTransfer.files[0]
      if (file) handleFile(file)
    },
    [handleFile]
  )

  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (): void => {
    setIsDragging(false)
  }

  const handleClick = (): void => {
    fileInputRef.current?.click()
  }

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }

  return (
    <div
      className={`album-art-container ${isDragging ? 'dragging' : ''}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onClick={handleClick}
    >
      {artUrl ? (
        <img src={artUrl} alt="Album Art" className="album-art-image" />
      ) : (
        <div className="album-art-placeholder">
          <span className="album-art-icon">🎨</span>
          <span className="album-art-text">Drop image or click to add album art</span>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg"
        onChange={handleFileInput}
        style={{ display: 'none' }}
      />
      <div className="album-art-overlay">
        <span>Drop to replace</span>
      </div>
    </div>
  )
}

// Note editor component
function NoteEditor({
  note,
  onUpdate,
  onDelete
}: {
  note: Note
  onUpdate: (updates: Partial<Note>) => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <div className="note-editor">
      <div className="property-group">
        <label className="property-label">Position (Tick)</label>
        <input
          type="number"
          className="property-input"
          value={note.tick}
          onChange={(e) => onUpdate({ tick: parseInt(e.target.value) || 0 })}
          min={0}
        />
      </div>

      <div className="property-group">
        <label className="property-label">Duration (Ticks)</label>
        <input
          type="number"
          className="property-input"
          value={note.duration}
          onChange={(e) => onUpdate({ duration: parseInt(e.target.value) || 0 })}
          min={0}
        />
      </div>

      <div className="property-group">
        <label className="property-label">Instrument</label>
        <select
          className="property-select"
          value={note.instrument}
          onChange={(e) => onUpdate({ instrument: e.target.value as Note['instrument'] })}
        >
          <option value="drums">Drums</option>
          <option value="guitar">Guitar</option>
          <option value="bass">Bass</option>
          <option value="vocals">Vocals</option>
          <option value="keys">Keys</option>
        </select>
      </div>

      <div className="property-group">
        <label className="property-label">Difficulty</label>
        <select
          className="property-select"
          value={note.difficulty}
          onChange={(e) => onUpdate({ difficulty: e.target.value as Note['difficulty'] })}
        >
          <option value="expert">Expert</option>
          <option value="hard">Hard</option>
          <option value="medium">Medium</option>
          <option value="easy">Easy</option>
        </select>
      </div>

      <div className="property-group">
        <label className="property-label">Lane</label>
        <input
          type="text"
          className="property-input"
          value={note.lane}
          onChange={(e) => onUpdate({ lane: e.target.value as Note['lane'] })}
        />
      </div>

      <div className="property-group">
        <label className="property-label">Velocity</label>
        <input
          type="number"
          className="property-input"
          value={note.velocity}
          onChange={(e) =>
            onUpdate({ velocity: Math.max(0, Math.min(127, parseInt(e.target.value) || 0)) })
          }
          min={0}
          max={127}
        />
      </div>

      {/* Note flags */}
      <div className="property-group">
        <label className="property-label">Flags</label>
        <div className="property-flags">
          {(note.instrument === 'guitar' || note.instrument === 'bass') && (
            <>
              <label className="property-checkbox">
                <input
                  type="checkbox"
                  checked={note.flags?.isHOPO || false}
                  onChange={(e) =>
                    onUpdate({ flags: { ...note.flags, isHOPO: e.target.checked } })
                  }
                />
                <span>HOPO</span>
              </label>
              <label className="property-checkbox">
                <input
                  type="checkbox"
                  checked={note.flags?.isTap || false}
                  onChange={(e) =>
                    onUpdate({ flags: { ...note.flags, isTap: e.target.checked } })
                  }
                />
                <span>Tap</span>
              </label>
              <label className="property-checkbox">
                <input
                  type="checkbox"
                  checked={note.flags?.isAccent || false}
                  onChange={(e) =>
                    onUpdate({ flags: { ...note.flags, isAccent: e.target.checked } })
                  }
                />
                <span>Accent</span>
              </label>
            </>
          )}
          {note.instrument === 'drums' && (
            <>
              <label className="property-checkbox">
                <input
                  type="checkbox"
                  checked={note.flags?.isCymbal || false}
                  onChange={(e) =>
                    onUpdate({ flags: { ...note.flags, isCymbal: e.target.checked } })
                  }
                />
                <span>Cymbal</span>
              </label>
              <label className="property-checkbox">
                <input
                  type="checkbox"
                  checked={note.flags?.isAccent || false}
                  onChange={(e) =>
                    onUpdate({ flags: { ...note.flags, isAccent: e.target.checked } })
                  }
                />
                <span>Accent</span>
              </label>
              <label className="property-checkbox">
                <input
                  type="checkbox"
                  checked={note.flags?.isGhost || false}
                  onChange={(e) =>
                    onUpdate({ flags: { ...note.flags, isGhost: e.target.checked } })
                  }
                />
                <span>Ghost</span>
              </label>
            </>
          )}
        </div>
      </div>

      <div className="property-actions">
        <button className="property-button property-button-danger" onClick={onDelete}>
          Delete Note
        </button>
      </div>
    </div>
  )
}

// Multiple notes selected - supports bulk flag editing
function MultiNoteEditor({
  notes,
  onUpdateAll,
  onDeleteAll
}: {
  notes: Note[]
  onUpdateAll: (updates: Partial<Note>) => void
  onDeleteAll: () => void
}): React.JSX.Element {
  // Determine which instruments are in the selection
  const hasDrums = notes.some((n) => n.instrument === 'drums')
  const hasGuitarBass = notes.some((n) => n.instrument === 'guitar' || n.instrument === 'bass')

  // Compute mixed state for each flag: true if all set, false if none set, null if mixed
  const flagState = (getter: (n: Note) => boolean | undefined): boolean | null => {
    const values = notes.map(getter)
    const allTrue = values.every((v) => v === true)
    const allFalse = values.every((v) => !v)
    if (allTrue) return true
    if (allFalse) return false
    return null // mixed
  }

  const cymbalState = hasDrums ? flagState((n) => n.flags?.isCymbal) : null
  const accentState = flagState((n) => n.flags?.isAccent)
  const ghostState = hasDrums ? flagState((n) => n.flags?.isGhost) : null
  const hopoState = hasGuitarBass ? flagState((n) => n.flags?.isHOPO) : null
  const tapState = hasGuitarBass ? flagState((n) => n.flags?.isTap) : null

  return (
    <div className="multi-note-editor">
      <div className="multi-note-info">
        <span className="multi-note-count">{notes.length}</span>
        <span className="multi-note-label">notes selected</span>
      </div>

      <div className="property-section">
        <div className="property-section-title">Flags</div>
        <div className="property-flags">
          {hasDrums && (
            <label className="property-checkbox">
              <input
                type="checkbox"
                checked={cymbalState === true}
                ref={(el) => { if (el) el.indeterminate = cymbalState === null }}
                onChange={(e) => onUpdateAll({ flags: { isCymbal: e.target.checked } })}
              />
              <span>Cymbal</span>
            </label>
          )}
          {hasGuitarBass && (
            <>
              <label className="property-checkbox">
                <input
                  type="checkbox"
                  checked={hopoState === true}
                  ref={(el) => { if (el) el.indeterminate = hopoState === null }}
                  onChange={(e) => onUpdateAll({ flags: { isHOPO: e.target.checked } })}
                />
                <span>HOPO</span>
              </label>
              <label className="property-checkbox">
                <input
                  type="checkbox"
                  checked={tapState === true}
                  ref={(el) => { if (el) el.indeterminate = tapState === null }}
                  onChange={(e) => onUpdateAll({ flags: { isTap: e.target.checked } })}
                />
                <span>Tap</span>
              </label>
            </>
          )}
          <label className="property-checkbox">
            <input
              type="checkbox"
              checked={accentState === true}
              ref={(el) => { if (el) el.indeterminate = accentState === null }}
              onChange={(e) => onUpdateAll({ flags: { isAccent: e.target.checked } })}
            />
            <span>Accent</span>
          </label>
          {hasDrums && (
            <label className="property-checkbox">
              <input
                type="checkbox"
                checked={ghostState === true}
                ref={(el) => { if (el) el.indeterminate = ghostState === null }}
                onChange={(e) => onUpdateAll({ flags: { isGhost: e.target.checked } })}
              />
              <span>Ghost</span>
            </label>
          )}
        </div>
      </div>

      <div className="property-actions">
        <button className="property-button property-button-danger" onClick={onDeleteAll}>
          Delete All Selected
        </button>
      </div>
    </div>
  )
}

// Vocal note editor - edits lyric, pitch, slide, percussion flags
function VocalNoteEditor({
  note,
  onUpdate,
  onDelete
}: {
  note: VocalNote
  onUpdate: (updates: Partial<VocalNote>) => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <div className="note-editor">
      <div className="property-section">
        <div className="property-section-title">Vocal Note</div>

        <div className="property-group">
          <label className="property-label">Lyric</label>
          <input
            type="text"
            className="property-input"
            value={note.lyric || ''}
            onChange={(e) => onUpdate({ lyric: e.target.value })}
            placeholder="Enter lyric syllable..."
          />
        </div>

        <div className="property-row">
          <div className="property-group property-group-half">
            <label className="property-label">Position (Tick)</label>
            <input
              type="number"
              className="property-input"
              value={note.tick}
              onChange={(e) => onUpdate({ tick: parseInt(e.target.value) || 0 })}
              min={0}
            />
          </div>
          <div className="property-group property-group-half">
            <label className="property-label">Duration</label>
            <input
              type="number"
              className="property-input"
              value={note.duration}
              onChange={(e) => onUpdate({ duration: parseInt(e.target.value) || 0 })}
              min={0}
            />
          </div>
        </div>

        <div className="property-group">
          <label className="property-label">Pitch (MIDI)</label>
          <input
            type="number"
            className="property-input"
            value={typeof note.lane === 'number' ? note.lane : 60}
            onChange={(e) => {
              const raw = e.target.value
              if (raw === '' || raw === '-') return // let user clear the field
              const parsed = parseInt(raw)
              if (isNaN(parsed)) return
              const pitch = Math.max(36, Math.min(84, parsed))
              onUpdate({ lane: pitch as unknown as VocalNote['lane'] })
            }}
            onBlur={(e) => {
              // On blur, ensure we have a valid value
              const parsed = parseInt(e.target.value)
              if (isNaN(parsed) || parsed < 36 || parsed > 84) {
                onUpdate({ lane: (typeof note.lane === 'number' ? note.lane : 60) as unknown as VocalNote['lane'] })
              }
            }}
            min={36}
            max={84}
          />
        </div>

        <div className="property-group">
          <label className="property-label">Harmony Part</label>
          <select
            className="property-select"
            value={note.harmonyPart}
            onChange={(e) => onUpdate({ harmonyPart: parseInt(e.target.value) as VocalNote['harmonyPart'] })}
          >
            <option value={0}>Main Vocals</option>
            <option value={1}>Harmony 1</option>
            <option value={2}>Harmony 2</option>
            <option value={3}>Harmony 3</option>
          </select>
        </div>
      </div>

      <div className="property-group">
        <label className="property-label">Flags</label>
        <div className="property-flags">
          <label className="property-checkbox">
            <input
              type="checkbox"
              checked={note.isSlide || false}
              onChange={(e) => onUpdate({ isSlide: e.target.checked })}
            />
            <span>Slide</span>
          </label>
          <label className="property-checkbox">
            <input
              type="checkbox"
              checked={note.isPercussion || false}
              onChange={(e) => onUpdate({ isPercussion: e.target.checked })}
            />
            <span>Percussion</span>
          </label>
          <label className="property-checkbox">
            <input
              type="checkbox"
              checked={note.isPitchless || false}
              onChange={(e) => onUpdate({ isPitchless: e.target.checked })}
            />
            <span>Pitchless</span>
          </label>
        </div>
      </div>

      <div className="property-actions">
        <button className="property-button property-button-danger" onClick={onDelete}>
          Delete Note
        </button>
      </div>
    </div>
  )
}

// Song metadata editor
function MetadataEditor({
  metadata,
  onUpdate,
  songId,
  folderPath,
  bpm,
  onBpmUpdate,
  tempoEvents,
  onAddTempoEvent,
  onUpdateTempoEvent,
  onDeleteTempoEvent,
  currentTick
}: {
  metadata: SongMetadata
  onUpdate: (updates: Partial<SongMetadata>) => void
  songId: string
  folderPath: string
  bpm: number
  onBpmUpdate: (bpm: number) => void
  tempoEvents: TempoEvent[]
  onAddTempoEvent: (tick: number, bpm: number) => void
  onUpdateTempoEvent: (tick: number, bpm: number) => void
  onDeleteTempoEvent: (tick: number) => void
  currentTick: number
}): React.JSX.Element {
  const [newTempoBpm, setNewTempoBpm] = useState('')
  return (
    <div className="metadata-editor">
      {/* Album Art at top */}
      <div className="property-section">
        <div className="property-section-title">Album Art</div>
        <AlbumArt songId={songId} folderPath={folderPath} />
      </div>

      <div className="property-section">
        <div className="property-section-title">Song Info</div>

        <div className="property-group">
          <label className="property-label">Title</label>
          <input
            type="text"
            className="property-input"
            value={metadata.name}
            onChange={(e) => onUpdate({ name: e.target.value })}
          />
        </div>

        <div className="property-group">
          <label className="property-label">Artist</label>
          <input
            type="text"
            className="property-input"
            value={metadata.artist}
            onChange={(e) => onUpdate({ artist: e.target.value })}
          />
        </div>

        <div className="property-group">
          <label className="property-label">Album</label>
          <input
            type="text"
            className="property-input"
            value={metadata.album || ''}
            onChange={(e) => onUpdate({ album: e.target.value })}
          />
        </div>

        <div className="property-row">
          <div className="property-group property-group-half">
            <label className="property-label">Year</label>
            <input
              type="text"
              className="property-input"
              value={metadata.year || ''}
              onChange={(e) => onUpdate({ year: e.target.value })}
            />
          </div>

          <div className="property-group property-group-half">
            <label className="property-label">Genre</label>
            <input
              type="text"
              className="property-input"
              value={metadata.genre || ''}
              onChange={(e) => onUpdate({ genre: e.target.value })}
            />
          </div>
        </div>

        <div className="property-group">
          <label className="property-label">Charter</label>
          <input
            type="text"
            className="property-input"
            value={metadata.charter || ''}
            onChange={(e) => onUpdate({ charter: e.target.value })}
          />
        </div>
      </div>

      <div className="property-section">
        <div className="property-section-title">Tempo</div>
        
        <div className="property-group">
          <label className="property-label">Initial BPM</label>
          <input
            type="number"
            className="property-input"
            value={bpm}
            onChange={(e) => {
              const newBpm = parseFloat(e.target.value)
              if (newBpm > 0 && newBpm <= 999) {
                onBpmUpdate(newBpm)
              }
            }}
            min={1}
            max={999}
            step={0.01}
          />
        </div>

        {/* Tempo changes list */}
        {tempoEvents.length > 1 && (
          <div style={{ marginTop: 8, marginBottom: 8 }}>
            <label className="property-label" style={{ marginBottom: 4, display: 'block' }}>Tempo Changes</label>
            <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid #333', borderRadius: 4 }}>
              {tempoEvents.slice(1).map((te) => {
                const measure = Math.floor(te.tick / 1920) + 1
                const beat = Math.floor((te.tick % 1920) / 480) + 1
                const secs = tickToSeconds(te.tick, tempoEvents)
                const mins = Math.floor(secs / 60)
                const remSecs = secs - mins * 60
                const timeStr = `${mins}:${remSecs < 10 ? '0' : ''}${remSecs.toFixed(1)}`
                return (
                  <div
                    key={te.tick}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px',
                      borderBottom: '1px solid #2a2a3e', fontSize: 12
                    }}
                  >
                    <span style={{ color: '#FF8C00', fontWeight: 600, minWidth: 55, fontFamily: 'monospace' }}>
                      M{measure}.{beat}
                    </span>
                    <span style={{ color: '#999', fontSize: 10, fontFamily: 'monospace', minWidth: 45 }}>
                      {timeStr}
                    </span>
                    <input
                      type="number"
                      style={{
                        flex: 1, background: '#1a1a2e', border: '1px solid #444', borderRadius: 3,
                        color: '#eee', padding: '2px 4px', fontSize: 12, minWidth: 0
                      }}
                      value={te.bpm}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        if (v > 0 && v <= 999) onUpdateTempoEvent(te.tick, v)
                      }}
                      min={1} max={999} step={0.01}
                    />
                    <span style={{ color: '#888', fontSize: 11 }}>BPM</span>
                    <button
                      style={{
                        background: 'none', border: 'none', color: '#f66', cursor: 'pointer',
                        fontSize: 14, padding: '0 2px', lineHeight: 1
                      }}
                      title="Delete tempo change"
                      onClick={() => onDeleteTempoEvent(te.tick)}
                    >✕</button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Add tempo change at current tick */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 4 }}>
          <input
            type="number"
            placeholder="BPM"
            style={{
              flex: 1, background: '#1a1a2e', border: '1px solid #444', borderRadius: 4,
              color: '#eee', padding: '4px 6px', fontSize: 12
            }}
            value={newTempoBpm}
            onChange={(e) => setNewTempoBpm(e.target.value)}
            min={1} max={999} step={0.01}
          />
          <button
            style={{
              background: '#FF8C00', border: 'none', borderRadius: 4, color: '#000',
              padding: '4px 8px', cursor: 'pointer', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap'
            }}
            title={`Add tempo change at current playhead position (tick ${currentTick})`}
            onClick={() => {
              const v = parseFloat(newTempoBpm)
              if (v > 0 && v <= 999 && currentTick > 0) {
                onAddTempoEvent(currentTick, v)
                setNewTempoBpm('')
              }
            }}
          >+ At Playhead</button>
        </div>
        <div className="difficulty-hint">Add tempo changes at the current playhead position</div>
      </div>

      <div className="property-section">
        <div className="property-section-title">Difficulty Ratings</div>

        <div className="property-row">
          <div className="property-group property-group-half">
            <label className="property-label">Drums</label>
            <input
              type="number"
              className="property-input"
              value={metadata.diff_drums ?? -1}
              onChange={(e) => onUpdate({ diff_drums: parseInt(e.target.value) })}
              min={-1}
              max={6}
            />
          </div>

          <div className="property-group property-group-half">
            <label className="property-label">Guitar</label>
            <input
              type="number"
              className="property-input"
              value={metadata.diff_guitar ?? -1}
              onChange={(e) => onUpdate({ diff_guitar: parseInt(e.target.value) })}
              min={-1}
              max={6}
            />
          </div>
        </div>

        <div className="property-row">
          <div className="property-group property-group-half">
            <label className="property-label">Bass</label>
            <input
              type="number"
              className="property-input"
              value={metadata.diff_bass ?? -1}
              onChange={(e) => onUpdate({ diff_bass: parseInt(e.target.value) })}
              min={-1}
              max={6}
            />
          </div>

          <div className="property-group property-group-half">
            <label className="property-label">Vocals</label>
            <input
              type="number"
              className="property-input"
              value={metadata.diff_vocals ?? -1}
              onChange={(e) => onUpdate({ diff_vocals: parseInt(e.target.value) })}
              min={-1}
              max={6}
            />
          </div>
        </div>

        <div className="difficulty-hint">-1 = disabled, 0-6 = difficulty tier</div>
      </div>

      <div className="property-section">
        <div className="property-section-title">Preview</div>

        <div className="property-group">
          <label className="property-label">Preview Start (ms)</label>
          <input
            type="number"
            className="property-input"
            value={metadata.preview_start_time || 0}
            onChange={(e) => onUpdate({ preview_start_time: parseInt(e.target.value) || 0 })}
            min={0}
          />
        </div>

        <div className="property-group">
          <label className="property-label">Loading Phrase</label>
          <input
            type="text"
            className="property-input"
            value={metadata.loading_phrase || ''}
            onChange={(e) => onUpdate({ loading_phrase: e.target.value })}
            placeholder="Tips or messages..."
          />
        </div>
      </div>
    </div>
  )
}

// Main Property Panel component
export function PropertyPanel(): React.JSX.Element {
  const { activeSongId } = useProjectStore()
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([])
  const [selectedVocalNoteIds, setSelectedVocalNoteIds] = useState<string[]>([])
  const [notes, setNotes] = useState<Note[]>([])
  const [vocalNotes, setVocalNotes] = useState<VocalNote[]>([])
  const [metadata, setMetadata] = useState<SongMetadata | null>(null)
  const [tempoEvents, setTempoEvents] = useState<{ tick: number; bpm: number }[]>([])
  const [folderPath, setFolderPath] = useState('')
  const [currentTick, setCurrentTick] = useState(0)

  // Subscribe reactively to the song store
  useEffect(() => {
    if (!activeSongId) return
    const songStore = getSongStore(activeSongId)
    if (!songStore) return

    // Initial sync
    const init = songStore.getState()
    setSelectedNoteIds(init.selectedNoteIds)
    setSelectedVocalNoteIds(init.selectedVocalNoteIds || [])
    setNotes(init.song.notes)
    setVocalNotes(init.song.vocalNotes || [])
    setMetadata(init.song.metadata)
    setTempoEvents(init.song.tempoEvents)
    setFolderPath(init.song.folderPath)
    setCurrentTick(init.currentTick)

    const unsub = songStore.subscribe((state, prev) => {
      if (state.selectedNoteIds !== prev.selectedNoteIds) setSelectedNoteIds(state.selectedNoteIds)
      if (state.selectedVocalNoteIds !== prev.selectedVocalNoteIds) setSelectedVocalNoteIds(state.selectedVocalNoteIds || [])
      if (state.song.notes !== prev.song.notes) setNotes(state.song.notes)
      if (state.song.vocalNotes !== prev.song.vocalNotes) setVocalNotes(state.song.vocalNotes || [])
      if (state.song.metadata !== prev.song.metadata) setMetadata(state.song.metadata)
      if (state.song.tempoEvents !== prev.song.tempoEvents) setTempoEvents(state.song.tempoEvents)
      if (state.song.folderPath !== prev.song.folderPath) setFolderPath(state.song.folderPath)
      if (state.currentTick !== prev.currentTick) setCurrentTick(state.currentTick)
    })
    return unsub
  }, [activeSongId])

  if (!activeSongId) {
    return (
      <div className="property-panel">
        <div className="panel-header">
          <span className="panel-header-title">
            <span>ℹ️</span>
            <span>Properties</span>
          </span>
        </div>
        <div className="empty-state">
          <div className="empty-state-icon">📝</div>
          <div className="empty-state-title">No Song Selected</div>
          <div className="empty-state-description">
            Select a song to view and edit its properties
          </div>
        </div>
      </div>
    )
  }

  const songStore = getSongStore(activeSongId)

  const handleNoteUpdate = (noteId: string, updates: Partial<Note>): void => {
    songStore.getState().updateNote(noteId, updates)
  }

  const handleVocalNoteUpdate = (noteId: string, updates: Partial<VocalNote>): void => {
    songStore.getState().updateVocalNote(noteId, updates)
  }

  const handleBulkFlagUpdate = (updates: Partial<Note>): void => {
    const store = songStore.getState()
    for (const noteId of selectedNoteIds) {
      const note = store.song.notes.find((n) => n.id === noteId)
      if (note && updates.flags) {
        store.updateNote(noteId, { flags: { ...note.flags, ...updates.flags } })
      }
    }
  }

  const handleNoteDelete = (noteId: string): void => {
    songStore.getState().deleteNote(noteId)
  }

  const handleVocalNoteDelete = (noteId: string): void => {
    songStore.getState().deleteVocalNote(noteId)
  }

  const handleDeleteSelected = (): void => {
    songStore.getState().deleteSelectedNotes()
  }

  const handleMetadataUpdate = (updates: Partial<SongMetadata>): void => {
    songStore.getState().updateMetadata(updates)
  }

  const handleBpmUpdate = (newBpm: number): void => {
    songStore.getState().updateTempoEvent(0, newBpm)
  }

  // Get selected notes
  const selectedNotes = notes.filter((note) => selectedNoteIds.includes(note.id))
  const selectedVocalNotes = vocalNotes.filter((n) => selectedVocalNoteIds.includes(n.id))
  
  // Get initial BPM from tempo events
  const bpm = tempoEvents[0]?.bpm ?? 120

  return (
    <div className="property-panel">
      <div className="panel-header">
        <span className="panel-header-title">
          <span>ℹ️</span>
          <span>Properties</span>
        </span>
      </div>

      <div className="panel-content">
        {!metadata ? (
          // Still loading store data
          <div className="empty-state">
            <div className="empty-state-description">Loading...</div>
          </div>
        ) : selectedVocalNotes.length === 1 ? (
          // Single vocal note selected
          <VocalNoteEditor
            note={selectedVocalNotes[0]}
            onUpdate={(updates) => handleVocalNoteUpdate(selectedVocalNotes[0].id, updates)}
            onDelete={() => handleVocalNoteDelete(selectedVocalNotes[0].id)}
          />
        ) : selectedVocalNotes.length > 1 ? (
          // Multiple vocal notes - show count + delete
          <div className="multi-note-editor">
            <div className="multi-note-info">
              <span className="multi-note-count">{selectedVocalNotes.length}</span>
              <span className="multi-note-label">vocal notes selected</span>
            </div>
            <div className="property-actions">
              <button className="property-button property-button-danger" onClick={() => songStore.getState().deleteSelectedVocalNotes()}>
                Delete All Selected
              </button>
            </div>
          </div>
        ) : selectedNotes.length === 0 ? (
          // No notes selected - show song metadata
          <MetadataEditor
            metadata={metadata!}
            onUpdate={handleMetadataUpdate}
            songId={activeSongId}
            folderPath={folderPath}
            bpm={bpm}
            onBpmUpdate={handleBpmUpdate}
            tempoEvents={tempoEvents}
            onAddTempoEvent={(tick, bpm) => songStore.getState().addTempoEvent({ tick, bpm })}
            onUpdateTempoEvent={(tick, bpm) => songStore.getState().updateTempoEvent(tick, bpm)}
            onDeleteTempoEvent={(tick) => songStore.getState().deleteTempoEvent(tick)}
            currentTick={currentTick}
          />
        ) : selectedNotes.length === 1 ? (
          // Single note selected
          <NoteEditor
            note={selectedNotes[0]}
            onUpdate={(updates) => handleNoteUpdate(selectedNotes[0].id, updates)}
            onDelete={() => handleNoteDelete(selectedNotes[0].id)}
          />
        ) : (
          // Multiple notes selected
          <MultiNoteEditor
            notes={selectedNotes}
            onUpdateAll={handleBulkFlagUpdate}
            onDeleteAll={handleDeleteSelected}
          />
        )}
      </div>
    </div>
  )
}
