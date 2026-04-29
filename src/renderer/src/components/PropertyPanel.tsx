// Property Panel - Right panel showing selected note/song properties
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useProjectStore, useUIStore, getSongStore } from '../stores'
import { tickToSeconds } from '../services/audioService'
import type {
  Note,
  VocalNote,
  SongMetadata,
  TempoEvent,
  TimeSignature,
  SongSection,
  VenueTrackData,
  VenueLightingEvent,
  VenuePostProcessingEvent,
  VenueStageEvent,
  VenueCameraCutEvent,
  VenuePerformerEvent,
  SelectedVenueEventRef
} from '../types'
import './PropertyPanel.css'

const VENUE_MIN_DURATION_TICKS = 60

const LIGHTING_PRESETS = [
  'verse', 'chorus', 'dischord', 'manual_cool', 'manual_warm', 'stomp',
  'blackout_fast', 'blackout_slow', 'blackout_spot', 'bre',
  'flare_fast', 'flare_slow', 'frenzy', 'harmony', 'intro',
  'loop_cool', 'loop_warm', 'searchlights',
  'silhouettes', 'silhouettes_spot',
  'strobe_fast', 'strobe_slow', 'sweep'
]

const POST_PROCESSING_PRESETS = [
  'ProFilm_a.pp', 'ProFilm_b.pp', 'ProFilm_mirror_a.pp', 'ProFilm_psychedelic_blue_red.pp',
  'bloom.pp', 'bright.pp',
  'clean_trails.pp', 'video_trails.pp', 'flicker_trails.pp', 'desat_posterize_trails.pp', 'space_woosh.pp',
  'contrast_a.pp', 'desat_blue.pp',
  'film_16mm.pp', 'film_b+w.pp', 'film_blue_filter.pp',
  'film_contrast.pp', 'film_contrast_blue.pp', 'film_contrast_green.pp', 'film_contrast_red.pp',
  'film_sepia_ink.pp', 'film_silvertone.pp',
  'horror_movie_special.pp', 'photo_negative.pp', 'photocopy.pp', 'posterize.pp',
  'shitty_tv.pp',
  'video_a.pp', 'video_bw.pp', 'video_security.pp'
]

const STAGE_PRESETS = ['FogOn', 'FogOff', 'bonusfx', 'bonusfx_optional', 'first', 'next', 'prev']

const CAMERA_CUT_PRESETS = [
  'coop_g_behind', 'coop_g_near', 'coop_g_closeup_hand', 'coop_g_closeup_head',
  'coop_b_behind', 'coop_b_near', 'coop_b_closeup_hand', 'coop_b_closeup_head',
  'coop_d_behind', 'coop_d_near', 'coop_d_closeup_hand', 'coop_d_closeup_head',
  'coop_v_behind', 'coop_v_near', 'coop_v_closeup',
  'coop_k_behind', 'coop_k_near', 'coop_k_closeup_hand', 'coop_k_closeup_head',
  'coop_gv_behind', 'coop_gv_near', 'coop_gk_behind', 'coop_gk_near',
  'coop_bg_behind', 'coop_bg_near', 'coop_bd_near',
  'coop_bv_behind', 'coop_bv_near', 'coop_bk_behind', 'coop_bk_near',
  'coop_dg_near', 'coop_dv_near',
  'coop_kv_behind', 'coop_kv_near',
  'coop_front_behind', 'coop_front_near',
  'coop_all_behind', 'coop_all_far', 'coop_all_near',
  'directed_all', 'directed_all_cam', 'directed_all_lt', 'directed_all_yeah',
  'directed_bre', 'directed_brej', 'directed_crowd',
  'directed_guitar', 'directed_guitar_np', 'directed_guitar_cls',
  'directed_guitar_cam_pr', 'directed_guitar_cam_pt', 'directed_crowd_g',
  'directed_bass', 'directed_bass_np', 'directed_bass_cam', 'directed_bass_cls', 'directed_crowd_b',
  'directed_drums', 'directed_drums_lt', 'directed_drums_np', 'directed_drums_pnt', 'directed_drums_kd',
  'directed_vocals', 'directed_vocals_np', 'directed_vocals_cls',
  'directed_vocals_cam_pr', 'directed_vocals_cam_pt',
  'directed_stagedive', 'directed_crowdsurf',
  'directed_keys', 'directed_keys_np', 'directed_keys_cam',
  'directed_duo_guitar', 'directed_duo_bass', 'directed_duo_drums', 'directed_duo_kv',
  'directed_duo_gb', 'directed_duo_kg', 'directed_duo_kb'
]

const PERFORMER_TYPE_PRESETS = ['spotlight', 'singalong']
const PERFORMER_TARGET_PRESETS = ['guitar', 'bass', 'drums', 'vocals', 'keys']

function uniqueOptions(options: string[], value?: string): string[] {
  return value && !options.includes(value) ? [...options, value] : options
}

function formatVenueLabel(value: string): string {
  return value
    .replace(/\[|\]/g, '')
    .replace(/\.pp$/i, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
}

function getVenueLaneLabel(lane: SelectedVenueEventRef['lane']): string {
  switch (lane) {
    case 'lighting': return 'Lighting'
    case 'postProcessing': return 'Post FX'
    case 'stage': return 'Stage FX'
    case 'cameraCuts': return 'Camera Cut'
    case 'performer': return 'Performer'
    default: return lane
  }
}

function VenueEventEditor({
  selectedRef,
  eventData,
  onUpdate,
  onDelete
}: {
  selectedRef: SelectedVenueEventRef
  eventData: VenueLightingEvent | VenuePostProcessingEvent | VenueStageEvent | VenueCameraCutEvent | VenuePerformerEvent
  onUpdate: (updates: Partial<VenueLightingEvent | VenuePostProcessingEvent | VenueStageEvent | VenueCameraCutEvent | VenuePerformerEvent>) => void
  onDelete: () => void
}): React.JSX.Element {
  const laneLabel = getVenueLaneLabel(selectedRef.lane)

  return (
    <div className="note-editor">
      <div className="property-section">
        <div className="property-section-title">Venue Event</div>

        <div className="property-group">
          <label className="property-label">Lane</label>
          <input className="property-input" value={laneLabel} readOnly />
        </div>

        <div className="property-group">
          <label className="property-label">Tick</label>
          <input
            type="number"
            className="property-input"
            value={eventData.tick}
            min={0}
            onChange={(e) => onUpdate({ tick: Math.max(0, Number(e.target.value) || 0) })}
          />
        </div>

        {selectedRef.lane === 'lighting' && (
          <div className="property-group">
            <label className="property-label">Cue</label>
            <select
              className="property-select"
              value={(eventData as VenueLightingEvent).type}
              onChange={(e) => onUpdate({ type: e.target.value })}
            >
              {uniqueOptions(LIGHTING_PRESETS, (eventData as VenueLightingEvent).type).map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>
        )}

        {selectedRef.lane === 'postProcessing' && (
          <div className="property-group">
            <label className="property-label">Effect</label>
            <select
              className="property-select"
              value={(eventData as VenuePostProcessingEvent).type}
              onChange={(e) => onUpdate({ type: e.target.value })}
            >
              {uniqueOptions(POST_PROCESSING_PRESETS, (eventData as VenuePostProcessingEvent).type).map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>
        )}

        {selectedRef.lane === 'stage' && (
          <>
            <div className="property-group">
              <label className="property-label">Stage FX</label>
              <select
                className="property-select"
                value={(eventData as VenueStageEvent).effect}
                onChange={(e) => onUpdate({ effect: e.target.value })}
              >
                {uniqueOptions(STAGE_PRESETS, (eventData as VenueStageEvent).effect).map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </div>
            <div className="property-group">
              <label className="property-label">Duration</label>
              <input
                type="number"
                className="property-input"
                value={(eventData as VenueStageEvent).duration ?? 0}
                min={VENUE_MIN_DURATION_TICKS}
                onChange={(e) => onUpdate({ duration: Math.max(VENUE_MIN_DURATION_TICKS, Number(e.target.value) || VENUE_MIN_DURATION_TICKS) })}
              />
            </div>
          </>
        )}

        {selectedRef.lane === 'cameraCuts' && (
          <div className="property-group">
            <label className="property-label">Cut</label>
            <select
              className="property-select"
              value={(eventData as VenueCameraCutEvent).subject}
              onChange={(e) => onUpdate({ subject: e.target.value })}
            >
              {uniqueOptions(CAMERA_CUT_PRESETS, (eventData as VenueCameraCutEvent).subject).map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>
        )}

        {selectedRef.lane === 'performer' && (
          <>
            <div className="property-group">
              <label className="property-label">Type</label>
              <select
                className="property-select"
                value={(eventData as VenuePerformerEvent).type}
                onChange={(e) => onUpdate({ type: e.target.value })}
              >
                {uniqueOptions(PERFORMER_TYPE_PRESETS, (eventData as VenuePerformerEvent).type).map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </div>
            <div className="property-group">
              <label className="property-label">Performer</label>
              <select
                className="property-select"
                value={(eventData as VenuePerformerEvent).performer ?? ''}
                onChange={(e) => onUpdate({ performer: e.target.value })}
              >
                {uniqueOptions(PERFORMER_TARGET_PRESETS, (eventData as VenuePerformerEvent).performer).map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </div>
            <div className="property-group">
              <label className="property-label">Duration</label>
              <input
                type="number"
                className="property-input"
                value={(eventData as VenuePerformerEvent).duration}
                min={VENUE_MIN_DURATION_TICKS}
                onChange={(e) => onUpdate({ duration: Math.max(VENUE_MIN_DURATION_TICKS, Number(e.target.value) || VENUE_MIN_DURATION_TICKS) })}
              />
            </div>
          </>
        )}

        <div className="property-group">
          <label className="property-label">Preview</label>
          <input className="property-input" readOnly value={formatVenueLabel(
            selectedRef.lane === 'lighting'
              ? (eventData as VenueLightingEvent).type
              : selectedRef.lane === 'postProcessing'
                ? (eventData as VenuePostProcessingEvent).type
                : selectedRef.lane === 'stage'
                  ? (eventData as VenueStageEvent).effect
                  : selectedRef.lane === 'cameraCuts'
                    ? (eventData as VenueCameraCutEvent).subject
                    : `${(eventData as VenuePerformerEvent).type} ${(eventData as VenuePerformerEvent).performer ?? ''}`
          )} />
        </div>
      </div>

      <div className="property-actions">
        <button className="property-button property-button-danger" onClick={onDelete}>
          Delete {laneLabel}
        </button>
      </div>
    </div>
  )
}

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
              {(String(note.lane) === 'kick' || note.flags?.isDoubleKick) && (
                <label className="property-checkbox">
                  <input
                    type="checkbox"
                    checked={note.flags?.isDoubleKick || false}
                    onChange={(e) =>
                      onUpdate({ flags: { ...note.flags, isDoubleKick: e.target.checked } })
                    }
                  />
                  <span>Double Bass (2x)</span>
                </label>
              )}
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
  const kickDrumNotes = notes.filter((n) => n.instrument === 'drums' && String(n.lane) === 'kick')
  const hasKickDrums = kickDrumNotes.length > 0
  const doubleBassState = hasKickDrums
    ? (() => {
      const values = kickDrumNotes.map((n) => n.flags?.isDoubleKick === true)
      const allTrue = values.every((v) => v === true)
      const allFalse = values.every((v) => v === false)
      if (allTrue) return true
      if (allFalse) return false
      return null
    })()
    : null
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
                checked={doubleBassState === true}
                ref={(el) => { if (el) el.indeterminate = doubleBassState === null }}
                onChange={(e) => onUpdateAll({ flags: { isDoubleKick: e.target.checked } })}
              />
              <span>Double Bass (2x)</span>
            </label>
          )}
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

// Editable row for a single tempo change event
function TempoChangeRow({
  event,
  tempoEvents,
  onUpdateBpm,
  onMove,
  onDelete
}: {
  event: TempoEvent
  tempoEvents: TempoEvent[]
  onUpdateBpm: (tick: number, bpm: number) => void
  onMove: (oldTick: number, newTick: number, bpm: number) => void
  onDelete: (tick: number) => void
}): React.JSX.Element {
  const [draftTick, setDraftTick] = useState<string>(String(event.tick))

  // Keep draft in sync if external change moves this event
  useEffect(() => { setDraftTick(String(event.tick)) }, [event.tick])

  const commitTick = (): void => {
    const parsed = parseInt(draftTick)
    if (!isNaN(parsed) && parsed > 0 && parsed !== event.tick) {
      onMove(event.tick, parsed, event.bpm)
    } else {
      setDraftTick(String(event.tick)) // revert invalid
    }
  }

  const measure = Math.floor(event.tick / 1920) + 1
  const beat = Math.floor((event.tick % 1920) / 480) + 1
  const secs = tickToSeconds(event.tick, tempoEvents)
  const mins = Math.floor(secs / 60)
  const remSecs = secs - mins * 60
  const timeStr = `${mins}:${remSecs < 10 ? '0' : ''}${remSecs.toFixed(1)}`

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '52px 44px 1fr 34px 22px 22px 18px',
      alignItems: 'center', gap: 4, padding: '3px 6px',
      borderBottom: '1px solid #2a2a3e', fontSize: 12
    }}>
      {/* Tick input */}
      <input
        type="number"
        style={{
          background: '#1a1a2e', border: '1px solid #555', borderRadius: 3,
          color: '#FF8C00', padding: '2px 4px', fontSize: 11,
          fontFamily: 'monospace', fontWeight: 600, width: '100%', minWidth: 0
        }}
        title="Tick position — edit to move this tempo change"
        value={draftTick}
        min={1}
        onChange={(e) => setDraftTick(e.target.value)}
        onBlur={commitTick}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur() } else if (e.key === 'Escape') { setDraftTick(String(event.tick)); e.currentTarget.blur() } }}
      />
      {/* Time display */}
      <span style={{ color: '#999', fontSize: 10, fontFamily: 'monospace', textAlign: 'right' }}
        title={`Measure ${measure}, Beat ${beat}`}>
        {timeStr}
      </span>
      {/* BPM input */}
      <input
        type="number"
        style={{
          background: '#1a1a2e', border: '1px solid #444', borderRadius: 3,
          color: '#eee', padding: '2px 4px', fontSize: 12, width: '100%', minWidth: 0
        }}
        value={event.bpm}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (v > 0 && v <= 999) onUpdateBpm(event.tick, v)
        }}
        min={1} max={999} step={0.01}
      />
      <span style={{ color: '#888', fontSize: 11 }}>BPM</span>
      {/* ± BPM nudge buttons — click = ±1, Ctrl+click = ±0.1 */}
      <button
        title="Decrease BPM (Ctrl: -0.1)"
        style={{ background: '#2a2a3e', border: '1px solid #444', borderRadius: 3, color: '#ccc', cursor: 'pointer', fontSize: 12, padding: '0 5px', lineHeight: '18px' }}
        onClick={(e) => { const delta = e.ctrlKey || e.metaKey ? 0.1 : 1; const v = Math.max(1, Math.round((event.bpm - delta) * 100) / 100); onUpdateBpm(event.tick, v) }}
      >-</button>
      <button
        title="Increase BPM (Ctrl: +0.1)"
        style={{ background: '#2a2a3e', border: '1px solid #444', borderRadius: 3, color: '#ccc', cursor: 'pointer', fontSize: 12, padding: '0 5px', lineHeight: '18px' }}
        onClick={(e) => { const delta = e.ctrlKey || e.metaKey ? 0.1 : 1; const v = Math.min(999, Math.round((event.bpm + delta) * 100) / 100); onUpdateBpm(event.tick, v) }}
      >+</button>
      <button
        style={{
          background: 'none', border: 'none', color: '#f66', cursor: 'pointer',
          fontSize: 14, padding: '0 2px', lineHeight: 1
        }}
        title="Delete tempo change"
        onClick={() => onDelete(event.tick)}
      >✕</button>
    </div>
  )
}

// Editable row for a single time signature event
function TimeSignatureRow({
  event,
  tempoEvents,
  onUpdate,
  onMove,
  onDelete
}: {
  event: TimeSignature
  tempoEvents: TempoEvent[]
  onUpdate: (tick: number, updates: Partial<TimeSignature>) => void
  onMove: (oldTick: number, newTick: number, event: TimeSignature) => void
  onDelete: (tick: number) => void
}): React.JSX.Element {
  const [draftTick, setDraftTick] = useState<string>(String(event.tick))

  useEffect(() => { setDraftTick(String(event.tick)) }, [event.tick])

  const commitTick = (): void => {
    const parsed = parseInt(draftTick)
    if (!isNaN(parsed) && parsed >= 0 && parsed !== event.tick) {
      onMove(event.tick, parsed, event)
    } else {
      setDraftTick(String(event.tick))
    }
  }

  const measure = Math.floor(event.tick / 1920) + 1
  const beat = Math.floor((event.tick % 1920) / 480) + 1
  const secs = tickToSeconds(event.tick, tempoEvents)
  const mins = Math.floor(secs / 60)
  const remSecs = secs - mins * 60
  const timeStr = `${mins}:${remSecs < 10 ? '0' : ''}${remSecs.toFixed(1)}`

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '52px 44px 36px 18px 36px 18px',
      alignItems: 'center',
      gap: 4,
      padding: '3px 6px',
      borderBottom: '1px solid #2a2a3e',
      fontSize: 12
    }}>
      <input
        type="number"
        style={{
          background: '#1a1a2e', border: '1px solid #555', borderRadius: 3,
          color: '#8dd0ff', padding: '2px 4px', fontSize: 11,
          fontFamily: 'monospace', fontWeight: 600, width: '100%', minWidth: 0
        }}
        title="Tick position — edit to move this time signature change"
        value={draftTick}
        min={0}
        onChange={(e) => setDraftTick(e.target.value)}
        onBlur={commitTick}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          else if (e.key === 'Escape') { setDraftTick(String(event.tick)); e.currentTarget.blur() }
        }}
      />
      <span style={{ color: '#999', fontSize: 10, fontFamily: 'monospace', textAlign: 'right' }}
        title={`Measure ${measure}, Beat ${beat}`}>
        {timeStr}
      </span>
      <input
        type="number"
        style={{
          background: '#1a1a2e', border: '1px solid #444', borderRadius: 3,
          color: '#eee', padding: '2px 4px', fontSize: 12, width: '100%', minWidth: 0
        }}
        value={event.numerator}
        min={1}
        max={32}
        onChange={(e) => {
          const v = parseInt(e.target.value)
          if (!isNaN(v) && v >= 1 && v <= 32) onUpdate(event.tick, { numerator: v })
        }}
      />
      <span style={{ color: '#888', fontSize: 12, textAlign: 'center' }}>/</span>
      <input
        type="number"
        style={{
          background: '#1a1a2e', border: '1px solid #444', borderRadius: 3,
          color: '#eee', padding: '2px 4px', fontSize: 12, width: '100%', minWidth: 0
        }}
        value={event.denominator}
        min={1}
        max={32}
        step={1}
        onChange={(e) => {
          const v = parseInt(e.target.value)
          if (!isNaN(v) && v >= 1 && v <= 32) onUpdate(event.tick, { denominator: v })
        }}
      />
      <button
        style={{
          background: 'none', border: 'none', color: '#f66', cursor: 'pointer',
          fontSize: 14, padding: '0 2px', lineHeight: 1
        }}
        title="Delete time signature change"
        onClick={() => onDelete(event.tick)}
      >✕</button>
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
  onMoveTempoEvent,
  onDeleteTempoEvent,
  timeSignatures,
  onAddTimeSignature,
  onUpdateTimeSignature,
  onMoveTimeSignature,
  onDeleteTimeSignature,
  songSections,
  onAddSongSection,
  onUpdateSongSection,
  onMoveSongSection,
  onDeleteSongSection,
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
  onMoveTempoEvent: (oldTick: number, newTick: number, bpm: number) => void
  onDeleteTempoEvent: (tick: number) => void
  timeSignatures: TimeSignature[]
  onAddTimeSignature: (event: TimeSignature) => void
  onUpdateTimeSignature: (tick: number, updates: Partial<TimeSignature>) => void
  onMoveTimeSignature: (oldTick: number, newTick: number, event: TimeSignature) => void
  onDeleteTimeSignature: (tick: number) => void
  songSections: SongSection[]
  onAddSongSection: (section: Omit<SongSection, 'id'>) => void
  onUpdateSongSection: (id: string, updates: Partial<SongSection>) => void
  onMoveSongSection: (id: string, newTick: number) => void
  onDeleteSongSection: (id: string) => void
  currentTick: number
}): React.JSX.Element {
  const [newTempoBpm, setNewTempoBpm] = useState('')
  const [newTimeSigNum, setNewTimeSigNum] = useState('4')
  const [newTimeSigDen, setNewTimeSigDen] = useState('4')
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
              {tempoEvents.slice(1).map((te) => (
                <TempoChangeRow
                  key={te.tick}
                  event={te}
                  tempoEvents={tempoEvents}
                  onUpdateBpm={onUpdateTempoEvent}
                  onMove={onMoveTempoEvent}
                  onDelete={onDeleteTempoEvent}
                />
              ))}
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
        <div className="property-section-title">Time Signature</div>

        <div className="property-group">
          <label className="property-label">Initial Time Signature</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="number"
              className="property-input"
              value={timeSignatures[0]?.numerator ?? 4}
              onChange={(e) => {
                const v = parseInt(e.target.value)
                if (!isNaN(v) && v >= 1 && v <= 32) onUpdateTimeSignature(0, { numerator: v })
              }}
              min={1}
              max={32}
              style={{ width: 80 }}
            />
            <span style={{ color: '#999' }}>/</span>
            <input
              type="number"
              className="property-input"
              value={timeSignatures[0]?.denominator ?? 4}
              onChange={(e) => {
                const v = parseInt(e.target.value)
                if (!isNaN(v) && v >= 1 && v <= 32) onUpdateTimeSignature(0, { denominator: v })
              }}
              min={1}
              max={32}
              style={{ width: 80 }}
            />
          </div>
        </div>

        {timeSignatures.length > 1 && (
          <div style={{ marginTop: 8, marginBottom: 8 }}>
            <label className="property-label" style={{ marginBottom: 4, display: 'block' }}>Signature Changes</label>
            <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid #333', borderRadius: 4 }}>
              {timeSignatures.slice(1).map((ts) => (
                <TimeSignatureRow
                  key={ts.tick}
                  event={ts}
                  tempoEvents={tempoEvents}
                  onUpdate={onUpdateTimeSignature}
                  onMove={onMoveTimeSignature}
                  onDelete={onDeleteTimeSignature}
                />
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 4 }}>
          <input
            type="number"
            placeholder="Num"
            style={{
              width: 70, background: '#1a1a2e', border: '1px solid #444', borderRadius: 4,
              color: '#eee', padding: '4px 6px', fontSize: 12
            }}
            value={newTimeSigNum}
            onChange={(e) => setNewTimeSigNum(e.target.value)}
            min={1}
            max={32}
          />
          <span style={{ color: '#888' }}>/</span>
          <input
            type="number"
            placeholder="Den"
            style={{
              width: 70, background: '#1a1a2e', border: '1px solid #444', borderRadius: 4,
              color: '#eee', padding: '4px 6px', fontSize: 12
            }}
            value={newTimeSigDen}
            onChange={(e) => setNewTimeSigDen(e.target.value)}
            min={1}
            max={32}
          />
          <button
            style={{
              background: '#8dd0ff', border: 'none', borderRadius: 4, color: '#081018',
              padding: '4px 8px', cursor: 'pointer', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap'
            }}
            title={`Add time signature change at current playhead position (tick ${currentTick})`}
            onClick={() => {
              const num = parseInt(newTimeSigNum)
              const den = parseInt(newTimeSigDen)
              if (!isNaN(num) && !isNaN(den) && num >= 1 && num <= 32 && den >= 1 && den <= 32 && currentTick > 0) {
                onAddTimeSignature({ tick: currentTick, numerator: num, denominator: den })
              }
            }}
          >+ At Playhead</button>
        </div>
        <div className="difficulty-hint">Add time signature changes at the current playhead position</div>
      </div>

      <div className="property-section">
        <div className="property-section-title">Song Sections</div>

        {songSections.length > 0 ? (
          <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid #333', borderRadius: 4 }}>
            {songSections.map((section) => (
              <div
                key={section.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '64px 1fr 18px',
                  gap: 4,
                  alignItems: 'center',
                  padding: '4px 6px',
                  borderBottom: '1px solid #2a2a3e'
                }}
              >
                <input
                  type="number"
                  value={section.tick}
                  min={0}
                  style={{
                    background: '#1a1a2e', border: '1px solid #555', borderRadius: 3,
                    color: '#9cd89a', padding: '2px 4px', fontSize: 11,
                    fontFamily: 'monospace', fontWeight: 600
                  }}
                  onChange={(e) => {
                    const v = parseInt(e.target.value)
                    if (!isNaN(v) && v >= 0) onMoveSongSection(section.id, v)
                  }}
                />
                <input
                  type="text"
                  value={section.name}
                  className="property-input"
                  style={{ padding: '4px 6px', fontSize: 12 }}
                  onChange={(e) => onUpdateSongSection(section.id, { name: e.target.value })}
                  placeholder="Section name"
                />
                <button
                  style={{
                    background: 'none', border: 'none', color: '#f66', cursor: 'pointer',
                    fontSize: 14, padding: '0 2px', lineHeight: 1
                  }}
                  title="Delete section"
                  onClick={() => onDeleteSongSection(section.id)}
                >x</button>
              </div>
            ))}
          </div>
        ) : (
          <div className="difficulty-hint">No sections yet</div>
        )}

        <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 8 }}>
          <button
            style={{
              background: '#9cd89a', border: 'none', borderRadius: 4, color: '#071008',
              padding: '4px 8px', cursor: 'pointer', fontSize: 11, fontWeight: 600
            }}
            title={`Add section at current playhead position (tick ${currentTick})`}
            onClick={() => onAddSongSection({ tick: currentTick, name: 'section' })}
          >+ At Playhead</button>
        </div>
        <div className="difficulty-hint">Use labels like intro, verse, chorus, solo, outro</div>
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
  const bottomPanelTab = useUIStore((state) => state.bottomPanelTab)
  const selectedVenueEvent = useUIStore((state) => state.selectedVenueEvent)
  const setSelectedVenueEvent = useUIStore((state) => state.setSelectedVenueEvent)
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([])
  const [selectedVocalNoteIds, setSelectedVocalNoteIds] = useState<string[]>([])
  const [notes, setNotes] = useState<Note[]>([])
  const [vocalNotes, setVocalNotes] = useState<VocalNote[]>([])
  const [metadata, setMetadata] = useState<SongMetadata | null>(null)
  const [tempoEvents, setTempoEvents] = useState<{ tick: number; bpm: number }[]>([])
  const [timeSignatures, setTimeSignatures] = useState<TimeSignature[]>([])
  const [songSections, setSongSections] = useState<SongSection[]>([])
  const [venueTrack, setVenueTrack] = useState<VenueTrackData>({
    autoGenerated: false,
    lighting: [],
    postProcessing: [],
    stage: [],
    performer: [],
    cameraCuts: []
  })
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
    setTimeSignatures(init.song.timeSignatures || [{ tick: 0, numerator: 4, denominator: 4 }])
    setSongSections(init.song.songSections || [])
    setVenueTrack(init.song.venueTrack)
    setFolderPath(init.song.folderPath)
    setCurrentTick(init.currentTick)

    const unsub = songStore.subscribe((state, prev) => {
      if (state.selectedNoteIds !== prev.selectedNoteIds) setSelectedNoteIds(state.selectedNoteIds)
      if (state.selectedVocalNoteIds !== prev.selectedVocalNoteIds) setSelectedVocalNoteIds(state.selectedVocalNoteIds || [])
      if (state.song.notes !== prev.song.notes) setNotes(state.song.notes)
      if (state.song.vocalNotes !== prev.song.vocalNotes) setVocalNotes(state.song.vocalNotes || [])
      if (state.song.metadata !== prev.song.metadata) setMetadata(state.song.metadata)
      if (state.song.tempoEvents !== prev.song.tempoEvents) setTempoEvents(state.song.tempoEvents)
      if (state.song.timeSignatures !== prev.song.timeSignatures) setTimeSignatures(state.song.timeSignatures || [{ tick: 0, numerator: 4, denominator: 4 }])
      if (state.song.songSections !== prev.song.songSections) setSongSections(state.song.songSections || [])
      if (state.song.venueTrack !== prev.song.venueTrack) setVenueTrack(state.song.venueTrack)
      if (state.song.folderPath !== prev.song.folderPath) setFolderPath(state.song.folderPath)
      if (state.currentTick !== prev.currentTick) setCurrentTick(state.currentTick)
    })
    return unsub
  }, [activeSongId])

  const selectedVenueEventData = useMemo(() => {
    if (!selectedVenueEvent) return null
    switch (selectedVenueEvent.lane) {
      case 'lighting':
        return venueTrack.lighting.find((event) => event.id === selectedVenueEvent.id) ?? null
      case 'postProcessing':
        return venueTrack.postProcessing.find((event) => event.id === selectedVenueEvent.id) ?? null
      case 'stage':
        return venueTrack.stage.find((event) => event.id === selectedVenueEvent.id) ?? null
      case 'cameraCuts':
        return venueTrack.cameraCuts.find((event) => event.id === selectedVenueEvent.id) ?? null
      case 'performer':
        return venueTrack.performer.find((event) => event.id === selectedVenueEvent.id) ?? null
      default:
        return null
    }
  }, [selectedVenueEvent, venueTrack])

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
    const hasDoubleKickChange = Object.prototype.hasOwnProperty.call(updates.flags || {}, 'isDoubleKick')
    for (const noteId of selectedNoteIds) {
      const note = store.song.notes.find((n) => n.id === noteId)
      if (note && updates.flags) {
        if (hasDoubleKickChange && (note.instrument !== 'drums' || String(note.lane) !== 'kick')) {
          continue
        }
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

  const handleVenueUpdate = (updates: Partial<VenueLightingEvent | VenuePostProcessingEvent | VenueStageEvent | VenueCameraCutEvent | VenuePerformerEvent>): void => {
    if (!selectedVenueEvent) return
    const lane = selectedVenueEvent.lane
    const laneEvents = songStore.getState().song.venueTrack[lane] as Array<VenueLightingEvent | VenuePostProcessingEvent | VenueStageEvent | VenueCameraCutEvent | VenuePerformerEvent>
    const nextLane = laneEvents
      .map((event) => (event.id === selectedVenueEvent.id ? { ...event, ...updates } : event))
      .sort((a, b) => a.tick - b.tick)
    songStore.getState().updateVenueTrack({ [lane]: nextLane } as Partial<VenueTrackData>)
  }

  const handleVenueDelete = (): void => {
    if (!selectedVenueEvent) return
    const lane = selectedVenueEvent.lane
    const laneEvents = songStore.getState().song.venueTrack[lane] as Array<VenueLightingEvent | VenuePostProcessingEvent | VenueStageEvent | VenueCameraCutEvent | VenuePerformerEvent>
    const nextLane = laneEvents.filter((event) => event.id !== selectedVenueEvent.id)
    songStore.getState().updateVenueTrack({ [lane]: nextLane } as Partial<VenueTrackData>)
    setSelectedVenueEvent(null)
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
        ) : bottomPanelTab === 'video' && selectedVenueEvent && selectedVenueEventData ? (
          <VenueEventEditor
            selectedRef={selectedVenueEvent}
            eventData={selectedVenueEventData}
            onUpdate={handleVenueUpdate}
            onDelete={handleVenueDelete}
          />
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
            onMoveTempoEvent={(oldTick, newTick, bpm) => songStore.getState().moveTempoEvent(oldTick, newTick, bpm)}
            onDeleteTempoEvent={(tick) => songStore.getState().deleteTempoEvent(tick)}
            timeSignatures={timeSignatures}
            onAddTimeSignature={(event) => songStore.getState().addTimeSignature(event)}
            onUpdateTimeSignature={(tick, updates) => songStore.getState().updateTimeSignature(tick, updates)}
            onMoveTimeSignature={(oldTick, newTick, event) => {
              if (oldTick === 0) return
              songStore.getState().deleteTimeSignature(oldTick)
              songStore.getState().addTimeSignature({ ...event, tick: newTick })
            }}
            onDeleteTimeSignature={(tick) => songStore.getState().deleteTimeSignature(tick)}
            songSections={songSections}
            onAddSongSection={(section) => songStore.getState().addSongSection(section)}
            onUpdateSongSection={(id, updates) => songStore.getState().updateSongSection(id, updates)}
            onMoveSongSection={(id, newTick) => songStore.getState().moveSongSection(id, newTick)}
            onDeleteSongSection={(id) => songStore.getState().deleteSongSection(id)}
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
