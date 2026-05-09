// Notes Renderer - Bot-hit detection via refs, no useState
import { useMemo, useCallback } from 'react'
import { STRIKE_LINE_POS, HIGHWAY_LENGTH, COLORS, DRUM_KICK_COLOR, DOUBLE_KICK_COLOR, getLaneConfig, getFretX, PRO_GUITAR_COLORS, PRO_KEYS_COLOR, VOCAL_COLOR, PRO_KEYS_MIN, PRO_KEYS_VISIBLE, TRACK_WIDTH } from './constants'
import type { InstrumentRenderType } from './constants'
import { NoteGem, KickNoteBar } from './NoteGem'
import type { Note, Instrument, Difficulty, VocalNote } from '../../types'
import { SUSTAIN_THRESHOLD_MID, SUSTAIN_THRESHOLD_CHART } from '../../types'
import type { HighwayAssets } from './types'

export function NotesRenderer({
  notes,
  currentTick,
  selectedNoteIds,
  instrument,
  difficulty,
  pixelsPerTick,
  offsetX = 0,
  onNoteClick,
  hitNotesRef,
  onNoteHit,
  assets,
  isPlaying,
  proKeysViewStart,
  sourceFormat
}: {
  notes: Note[]
  currentTick: number
  selectedNoteIds: string[]
  instrument: Instrument
  difficulty: Difficulty
  pixelsPerTick: number
  offsetX?: number
  onNoteClick: (noteId: string, event?: MouseEvent) => void
  hitNotesRef: React.MutableRefObject<Set<string>>
  onNoteHit: (noteId: string, laneIndex: number, color: string, x: number, endTick: number) => void
  assets: HighwayAssets | null
  isPlaying: boolean
  proKeysViewStart?: number
  sourceFormat?: 'midi' | 'chart'
}): React.JSX.Element {
  const sustainThreshold = instrument === 'drums' ? Infinity
    : sourceFormat === 'chart' ? SUSTAIN_THRESHOLD_CHART : SUSTAIN_THRESHOLD_MID
  const instrumentType: InstrumentRenderType = instrument === 'drums' ? 'drums'
    : instrument === 'proKeys' ? 'proKeys'
    : instrument === 'vocals' ? 'vocals'
    : (instrument === 'proGuitar' || instrument === 'proBass') ? 'proGuitar'
    : 'guitar'
  const colors = instrumentType === 'proGuitar' ? PRO_GUITAR_COLORS
    : instrumentType === 'proKeys' ? [PRO_KEYS_COLOR]
    : instrumentType === 'vocals' ? [VOCAL_COLOR]
    : COLORS[instrumentType === 'drums' ? 'drums' : 'guitar'].notes
  const { laneCount } = getLaneConfig(instrumentType)

  // Static filter: instrument + difficulty (stable between note edits)
  const instrumentNotes = useMemo(() => {
    return notes.filter(
      (note) => {
        if (note.instrument !== instrument) return false
        if (instrument !== 'vocals' && note.difficulty !== difficulty) return false
        // Pro Keys: hide notes outside the sliding viewport
        if (instrument === 'proKeys' && proKeysViewStart != null) {
          const pitch = typeof note.lane === 'number' ? note.lane : parseInt(String(note.lane))
          if (pitch < proKeysViewStart || pitch >= proKeysViewStart + PRO_KEYS_VISIBLE) return false
        }
        return true
      }
    )
  }, [notes, instrument, difficulty, proKeysViewStart])

  // Viewport cull: cheap linear scan, not inside useMemo so it doesn't bust the memo on every tick
  const visibleTicks = HIGHWAY_LENGTH / pixelsPerTick + 500
  const visibleNotes = instrumentNotes.filter(
    (note) => (note.tick + note.duration) >= currentTick - 400 && note.tick <= currentTick + visibleTicks
  )

  const getLaneIndex = useCallback(
    (note: Note): number => {
      const laneStr = String(note.lane)
      if (instrument === 'drums') {
        switch (laneStr) {
          case 'snare': return 0
          case 'yellowTom': case 'yellowCymbal': return 1
          case 'blueTom': case 'blueCymbal': return 2
          case 'greenTom': case 'greenCymbal': return 3
          default: return 0
        }
      }
      // Pro Guitar/Bass: lane is string number 1-6, map to lane index 0-5
      if (instrument === 'proGuitar' || instrument === 'proBass') {
        const stringNum = typeof note.lane === 'number' ? note.lane : parseInt(laneStr)
        return Math.max(0, Math.min(5, stringNum - 1))
      }
      // Pro Keys: lane is MIDI pitch, map relative to sliding viewport
      if (instrument === 'proKeys') {
        const pitch = typeof note.lane === 'number' ? note.lane : parseInt(laneStr)
        const viewBase = proKeysViewStart ?? PRO_KEYS_MIN
        const lane = pitch - viewBase
        // Clamp to visible range; notes outside viewport sit at edges
        return Math.max(0, Math.min(PRO_KEYS_VISIBLE - 1, lane))
      }
      // Vocals: lane is MIDI pitch, map to track width proportionally
      if (instrument === 'vocals') {
        const pitch = typeof note.lane === 'number' ? note.lane : parseInt(laneStr)
        return Math.max(0, Math.min(11, Math.round(((pitch - 36) / 48) * 11)))
      }
      const lanes = ['green', 'red', 'yellow', 'blue', 'orange']
      const idx = lanes.indexOf(laneStr)
      return idx >= 0 && idx < laneCount ? idx : 0
    },
    [instrument, laneCount, proKeysViewStart]
  )

  const isCymbalNote = useCallback(
    (note: Note): boolean => {
      if (instrument !== 'drums') return false
      const laneStr = String(note.lane)
      return laneStr === 'yellowCymbal' || laneStr === 'blueCymbal' || laneStr === 'greenCymbal'
        || !!note.flags?.isCymbal
    },
    [instrument]
  )

  // Bot-hit detection
  if (isPlaying) {
    for (const note of visibleNotes) {
      if (note.tick <= currentTick && !hitNotesRef.current.has(note.id)) {
        hitNotesRef.current.add(note.id)
        const isKick = instrument === 'drums' && String(note.lane) === 'kick'
        const isOpen = (instrument === 'guitar' || instrument === 'bass' || instrument === 'keys') && String(note.lane) === 'open'
        const laneIndex = (isKick || isOpen) ? -1 : getLaneIndex(note)
        const x = (isKick || isOpen) ? 0 : getFretX(laneIndex, laneCount)
        const kickColor = note.flags?.isDoubleKick ? DOUBLE_KICK_COLOR : DRUM_KICK_COLOR
        const color = isKick ? kickColor : isOpen ? '#CC44FF' : (colors[laneIndex % colors.length] || '#FFFFFF')
        const endTick = note.tick + note.duration
        onNoteHit(note.id, laneIndex, color, x, endTick)
      }
    }
  }

  // Prune old tracking entries
  for (const id of hitNotesRef.current) {
    const note = notes.find((n) => n.id === id)
    if (!note || note.tick < currentTick - 2000) {
      hitNotesRef.current.delete(id)
    }
  }

  return (
    <group position={[offsetX, 0, 0]}>
      {visibleNotes.map((note) => {
        const isKick = instrument === 'drums' && String(note.lane) === 'kick'
        const isOpen = (instrument === 'guitar' || instrument === 'bass' || instrument === 'keys') && String(note.lane) === 'open'
        const laneIndex = getLaneIndex(note)
        const x = getFretX(laneIndex, laneCount)
        const z = STRIKE_LINE_POS - (note.tick - currentTick) * pixelsPerTick
        const isSelected = selectedNoteIds.includes(note.id)
        const isSustain = note.duration >= sustainThreshold
        const totalSustainLength = isSustain ? note.duration * pixelsPerTick : 0

        // For sustain notes, compute how much sustain remains after the playhead
        const noteEndTick = note.tick + note.duration
        const isHeadHit = note.tick <= currentTick
        const isSustainActive = isHeadHit && isSustain && noteEndTick > currentTick
        const remainingSustainLength = isSustainActive
          ? (noteEndTick - currentTick) * pixelsPerTick
          : totalSustainLength

        // Skip notes that have fully passed (head hit + no active sustain)
        if (isHeadHit && !isSustainActive) return null

        // Skip notes too far ahead
        if (z > STRIKE_LINE_POS + 1 && !isSustainActive) return null

        if (isKick || isOpen) {
          if (isHeadHit) return null // no sustain, just hide
          return (
            <group key={note.id} onClick={(e) => { e.stopPropagation?.(); onNoteClick(note.id, (e as unknown as { nativeEvent?: MouseEvent }).nativeEvent) }}>
              <KickNoteBar
                z={z}
                color={isOpen ? '#CC44FF' : (note.flags?.isDoubleKick ? DOUBLE_KICK_COLOR : DRUM_KICK_COLOR)}
                assets={assets}
                isSelected={isSelected}
                sustainLength={isSustain ? totalSustainLength : 0}
                isSustainActive={isSustainActive}
                showDoubleKickBadge={!!note.flags?.isDoubleKick}
              />
            </group>
          )
        }

        const color = colors[laneIndex % colors.length] || '#FFFFFF'
        const isCymbal = isCymbalNote(note)
        const isProGtr = instrument === 'proGuitar' || instrument === 'proBass'

        // Talkies: full-width gray bar spanning the entire vocal track
        const isTalkie = instrument === 'vocals' && !!(note as VocalNote).isPitchless
        if (isTalkie) {
          const barLength = Math.max(note.duration * pixelsPerTick, 0.04)
          const barStartZ = isSustainActive ? STRIKE_LINE_POS : z
          const actualLength = isSustainActive ? remainingSustainLength : barLength
          if (isHeadHit && !isSustainActive) return null
          return (
            <group key={note.id} position={[0, 0.015, barStartZ - actualLength / 2]}
              onClick={(e) => { e.stopPropagation?.(); onNoteClick(note.id, (e as unknown as { nativeEvent?: MouseEvent }).nativeEvent) }}>
              <mesh rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[TRACK_WIDTH, actualLength]} />
                <meshBasicMaterial color={isSelected ? '#BBBBFF' : '#888888'} transparent opacity={0.82} />
              </mesh>
              {/* Leading edge marker */}
              {!isHeadHit && (
                <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, actualLength / 2]}>
                  <planeGeometry args={[TRACK_WIDTH, 0.04]} />
                  <meshBasicMaterial color={isSelected ? '#CCCCFF' : '#AAAAAA'} transparent opacity={0.95} />
                </mesh>
              )}
            </group>
          )
        }

        return (
          <group key={note.id} onClick={(e) => { e.stopPropagation?.(); onNoteClick(note.id, (e as unknown as { nativeEvent?: MouseEvent }).nativeEvent) }}>
            <NoteGem
              position={isSustainActive ? [x, 0.01, STRIKE_LINE_POS] : [x, 0.01, z]}
              color={color}
              isSelected={isSelected}
              sustainLength={isSustainActive ? remainingSustainLength : totalSustainLength}
              sustainOffset={isSustainActive ? (currentTick - note.tick) * pixelsPerTick : 0}
              noteFlags={note.flags}
              isHeadVisible={!isHeadHit}
              assets={assets}
              isCymbal={isCymbal}
              fretNumber={isProGtr ? note.fret : undefined}
            />
          </group>
        )
      })}
    </group>
  )
}
