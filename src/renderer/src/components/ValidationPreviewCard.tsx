import React, { useMemo, useState, useEffect, useCallback } from 'react'
import type { ValidationIssue, SongData, Note, Instrument, Difficulty } from '../types'
import { getSongStore, useSettingsStore, useUIStore } from '../stores'
import {
  validateChartAsync,
  tickToMs,
  getDrumHandAssignments,
  isHandHit,
  getDrumLaneIndex,
  getDrumTransitionLimit
} from '../utils/chartValidation'

interface Props {
  issue: ValidationIssue
  song: SongData
  activeSongId: string
}

interface QuickSuggestion {
  label: string
  action: () => Note[]
}

const W = 800
const H = 95

const getIssueTypeKey = (issue: ValidationIssue): string => {
  const msg = issue.message.toLowerCase()
  if (msg.includes('overlapping')) return 'overlapping'
  if (msg.includes('crossover')) return 'crossover'
  if (msg.includes('transition')) return 'transition'
  if (msg.includes('simultaneous hand')) return 'simultaneous'
  if (msg.includes('sustain')) return 'sustain'
  return 'other'
}

function GridCell({
  x,
  y,
  laneColor,
  existingNote,
  onToggle
}: {
  x: number
  y: number
  laneColor: string
  existingNote: Note | undefined
  onToggle: () => void
}): React.JSX.Element {
  const [hovered, setHovered] = React.useState(false)

  return (
    <circle
      cx={x}
      cy={y}
      r={existingNote ? 5.5 : 4}
      fill={existingNote ? laneColor : hovered ? laneColor : 'transparent'}
      stroke={hovered ? '#ffffff' : existingNote ? 'rgba(255,255,255,0.4)' : 'transparent'}
      strokeWidth={hovered || existingNote ? 1.5 : 0}
      opacity={existingNote ? 1.0 : hovered ? 0.6 : 0.03}
      cursor="pointer"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      style={{
        transition: 'all 0.1s ease',
        filter: existingNote ? `drop-shadow(0 0 3px ${laneColor})` : 'none'
      }}
    />
  )
}

export function ValidationPreviewCard({ issue, song, activeSongId }: Props): React.JSX.Element {
  const tick = issue.tick ?? 0
  const instrument = issue.instrument ?? 'drums'
  const difficulty = issue.difficulty ?? 'expert'
  const isVocals = instrument === 'vocals'
  const songStore = getSongStore(activeSongId)

  // Find all notes of this instrument/difficulty in the entire song to compute dynamic preview window
  const instrumentNotes = useMemo(() => {
    if (isVocals) {
      return song.vocalNotes || []
    } else {
      return (song.notes || []).filter(
        (n) => n.instrument === instrument && n.difficulty === difficulty
      )
    }
  }, [song, instrument, difficulty, isVocals])

  // Dynamically load enough ticks to visualize at least 3 notes in either direction with buffer
  const { startTick, endTick } = useMemo(() => {
    const notesBefore = instrumentNotes.filter((n) => n.tick < tick).sort((a, b) => b.tick - a.tick)
    const notesAfter = instrumentNotes.filter((n) => n.tick > tick).sort((a, b) => a.tick - b.tick)

    let maxDiff = 1440 // Minimum half-window size (1440 ticks = 12 snap intervals)

    // Visualize at least 3 notes in the left direction
    if (notesBefore.length >= 3) {
      const thirdNoteTick = notesBefore[2].tick
      const diff = tick - thirdNoteTick + 240
      if (diff > maxDiff) {
        maxDiff = diff
      }
    } else if (notesBefore.length > 0) {
      const firstNoteTick = notesBefore[notesBefore.length - 1].tick
      const diff = tick - firstNoteTick + 240
      if (diff > maxDiff) {
        maxDiff = diff
      }
    }

    // Visualize at least 3 notes in the right direction
    if (notesAfter.length >= 3) {
      const thirdNoteTick = notesAfter[2].tick
      const diff = thirdNoteTick - tick + 240
      if (diff > maxDiff) {
        maxDiff = diff
      }
    } else if (notesAfter.length > 0) {
      const lastNoteTick = notesAfter[notesAfter.length - 1].tick
      const diff = lastNoteTick - tick + 240
      if (diff > maxDiff) {
        maxDiff = diff
      }
    }

    // Align half-width to the nearest 120-tick boundary (1/16 note snap grid step)
    const halfWidth = Math.ceil(maxDiff / 120) * 120
    return { startTick: tick - halfWidth, endTick: tick + halfWidth }
  }, [instrumentNotes, tick])

  // Filter notes to the computed dynamic preview window
  const windowNotes = useMemo(() => {
    return instrumentNotes.filter((n) => n.tick >= startTick && n.tick <= endTick)
  }, [instrumentNotes, startTick, endTick])

  // Local draft notes for the sandbox view
  const [draftNotes, setDraftNotes] = useState<Note[]>(() => [...windowNotes])

  // Keep draft in sync with song updates if the user doesn't have an unsaved draft
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraftNotes([...windowNotes])
  }, [windowNotes])

  const hasActiveDraft = useMemo(() => {
    if (draftNotes.length !== windowNotes.length) return true
    return draftNotes.some((dn) => {
      const wn = windowNotes.find((w) => w.id === dn.id)
      if (!wn) return true
      return (
        wn.tick !== dn.tick ||
        wn.lane !== dn.lane ||
        wn.duration !== dn.duration ||
        wn.velocity !== dn.velocity ||
        JSON.stringify(wn.flags) !== JSON.stringify(dn.flags)
      )
    })
  }, [draftNotes, windowNotes])

  const handleRevert = (): void => {
    setDraftNotes([...windowNotes])
  }

  const lanes = useMemo(() => {
    if (instrument === 'drums') {
      return [
        'kick',
        'doubleKick',
        'snare',
        'yellowTom',
        'yellowCymbal',
        'blueTom',
        'blueCymbal',
        'greenTom',
        'greenCymbal'
      ]
    }
    if (instrument === 'guitar' || instrument === 'bass') {
      return ['open', 'green', 'red', 'yellow', 'blue', 'orange']
    }
    return []
  }, [instrument])

  const getLaneIndex = useCallback(
    (note: Note): number => {
      if (instrument === 'drums') {
        if (String(note.lane) === 'kick') {
          return note.flags?.isDoubleKick ? 1 : 0
        }
        const idx = lanes.indexOf(String(note.lane))
        return idx !== -1 ? idx : -1
      }
      return lanes.indexOf(String(note.lane))
    },
    [instrument, lanes]
  )

  const pitchRange = useMemo((): { min: number; max: number } => {
    if (draftNotes.length === 0) return { min: 60, max: 60 }
    let min = Infinity
    let max = -Infinity
    for (const n of draftNotes) {
      const pitch = typeof n.lane === 'number' ? n.lane : 60
      if (pitch < min) min = pitch
      if (pitch > max) max = pitch
    }
    return { min, max }
  }, [draftNotes])

  const getNoteY = useCallback(
    (note: Note): number => {
      if (lanes.length > 0) {
        const idx = getLaneIndex(note)
        if (idx === -1) return H / 2
        const padding = 10
        const spacing = (H - padding * 2) / (lanes.length - 1)
        return padding + idx * spacing
      } else {
        const { min, max } = pitchRange
        if (min === max) return H / 2
        const padding = 12
        const pct = ((typeof note.lane === 'number' ? note.lane : 60) - min) / (max - min)
        return padding + (1 - pct) * (H - padding * 2)
      }
    },
    [lanes, pitchRange, getLaneIndex]
  )

  // Setup snap divisions for interactive timeline cells (1/16 beat intervals in dynamic window)
  const snapTicks = useMemo(() => {
    const list: number[] = []
    for (let t = startTick; t <= endTick; t += 120) {
      list.push(t)
    }
    return list
  }, [startTick, endTick])

  const pixelsPerTick = W / (endTick - startTick)

  const verticalGridLines = useMemo(() => {
    return snapTicks.map((t) => {
      const x = (t - startTick) * pixelsPerTick
      const isCenter = t === tick
      return (
        <line
          key={t}
          x1={x}
          y1={0}
          x2={x}
          y2={H}
          stroke={isCenter ? '#ff4d4d' : '#222230'}
          strokeWidth={isCenter ? 1.5 : 1}
          strokeDasharray={isCenter ? '3,3' : 'none'}
          opacity={isCenter ? 0.8 : 0.4}
        />
      )
    })
  }, [snapTicks, startTick, pixelsPerTick, tick])

  const backgroundLines = useMemo(() => {
    if (lanes.length > 0) {
      return lanes.map((lane, idx) => {
        const padding = 10
        const spacing = (H - padding * 2) / (lanes.length - 1)
        const y = padding + idx * spacing

        let label = ''
        if (instrument === 'drums') {
          if (lane === 'kick') label = 'K'
          else if (lane === 'doubleKick') label = '2K'
          else if (lane === 'snare') label = 'S'
          else if (lane === 'yellowTom') label = 'YT'
          else if (lane === 'yellowCymbal') label = 'YC'
          else if (lane === 'blueTom') label = 'BT'
          else if (lane === 'blueCymbal') label = 'BC'
          else if (lane === 'greenTom') label = 'GT'
          else if (lane === 'greenCymbal') label = 'GC'
        } else if (instrument === 'guitar' || instrument === 'bass') {
          if (lane === 'open') label = 'O'
          else if (lane === 'green') label = 'G'
          else if (lane === 'red') label = 'R'
          else if (lane === 'yellow') label = 'Y'
          else if (lane === 'blue') label = 'B'
          else if (lane === 'orange') label = 'O'
        }

        return (
          <g key={lane}>
            <line x1="0" y1={y} x2={W} y2={y} stroke="#2a2a3a" strokeWidth="1" />
            <text
              x="4"
              y={y + 3}
              fill="#555577"
              fontSize="8"
              fontFamily="monospace"
              fontWeight="bold"
            >
              {label}
            </text>
          </g>
        )
      })
    } else {
      return [0.25, 0.5, 0.75].map((pct, idx) => {
        const y = 12 + pct * (H - 24)
        return <line key={idx} x1="0" y1={y} x2={W} y2={y} stroke="#2a2a3a" strokeWidth="1" />
      })
    }
  }, [lanes, instrument])

  const renderedNotes = draftNotes.map((note) => {
    const noteX = (note.tick - startTick) * pixelsPerTick
    const noteY = getNoteY(note)

    let color = '#9b59b6'
    if (instrument === 'guitar' || instrument === 'bass') {
      if (note.lane === 'green') color = '#79D304'
      else if (note.lane === 'red') color = '#FF1D23'
      else if (note.lane === 'yellow') color = '#FFE900'
      else if (note.lane === 'blue') color = '#00BFFF'
      else if (note.lane === 'orange') color = '#FF8400'
      else if (note.lane === 'open') color = '#C800FF'
    } else if (instrument === 'drums') {
      const laneStr = String(note.lane)
      if (laneStr === 'kick') color = note.flags?.isDoubleKick ? '#B85100' : '#FF8400'
      else if (laneStr === 'snare') color = '#FF1D23'
      else if (laneStr === 'yellowTom') color = '#FFE900'
      else if (laneStr === 'yellowCymbal') color = '#FFE900'
      else if (laneStr === 'blueTom') color = '#00BFFF'
      else if (laneStr === 'blueCymbal') color = '#00BFFF'
      else if (laneStr === 'greenTom') color = '#79D304'
      else if (laneStr === 'greenCymbal') color = '#79D304'
    }

    const isSustain = note.duration > 0
    const tailW = note.duration * pixelsPerTick

    return (
      <g key={note.id}>
        {isSustain && (
          <line
            x1={noteX}
            y1={noteY}
            x2={noteX + tailW}
            y2={noteY}
            stroke={color}
            strokeWidth="4"
            opacity="0.5"
            strokeLinecap="round"
          />
        )}
      </g>
    )
  })

  const handleToggleDraftNote = useCallback(
    (lane: string, t: number): void => {
      if (isVocals) return
      setDraftNotes((prev: Note[]): Note[] => {
        const existingIdx = prev.findIndex((n) => {
          if (n.tick !== t) return false
          if (lane === 'doubleKick') {
            return String(n.lane) === 'kick' && !!n.flags?.isDoubleKick
          }
          if (lane === 'kick') {
            return String(n.lane) === 'kick' && !n.flags?.isDoubleKick
          }
          return String(n.lane) === lane
        })

        if (existingIdx !== -1) {
          return prev.filter((_, idx) => idx !== existingIdx)
        } else {
          const isCym = lane === 'yellowCymbal' || lane === 'blueCymbal' || lane === 'greenCymbal'
          const isDouble = lane === 'doubleKick'

          const newNote: Note = {
            id: `draft-${Math.random().toString(36).substring(2, 11)}`,
            tick: t,
            duration: 0,
            instrument: instrument as Instrument,
            difficulty: difficulty as Difficulty,
            lane: (isDouble ? 'kick' : lane) as Note['lane'],
            velocity: 100,
            flags: isDouble ? { isDoubleKick: true } : isCym ? { isCymbal: true } : undefined
          }
          return [...prev, newNote]
        }
      })
    },
    [isVocals, instrument, difficulty]
  )

  // Interactive grid elements
  const gridCells = useMemo(() => {
    const cells: React.JSX.Element[] = []
    if (lanes.length === 0) return cells

    for (const lane of lanes) {
      const idx = lanes.indexOf(lane)
      const padding = 10
      const spacing = (H - padding * 2) / (lanes.length - 1)
      const y = padding + idx * spacing

      let laneColor = '#888888'
      if (instrument === 'guitar' || instrument === 'bass') {
        if (lane === 'green') laneColor = '#79D304'
        else if (lane === 'red') laneColor = '#FF1D23'
        else if (lane === 'yellow') laneColor = '#FFE900'
        else if (lane === 'blue') laneColor = '#00BFFF'
        else if (lane === 'orange') laneColor = '#FF8400'
        else if (lane === 'open') laneColor = '#C800FF'
      } else if (instrument === 'drums') {
        if (lane === 'kick') laneColor = '#FF8400'
        else if (lane === 'doubleKick') laneColor = '#B85100'
        else if (lane === 'snare') laneColor = '#FF1D23'
        else if (lane === 'yellowTom') laneColor = '#FFE900'
        else if (lane === 'yellowCymbal') laneColor = '#FFE900'
        else if (lane === 'blueTom') laneColor = '#00BFFF'
        else if (lane === 'blueCymbal') laneColor = '#00BFFF'
        else if (lane === 'greenTom') laneColor = '#79D304'
        else if (lane === 'greenCymbal') laneColor = '#79D304'
      }

      for (const t of snapTicks) {
        const x = (t - startTick) * pixelsPerTick

        const existingNote = draftNotes.find((n) => {
          if (n.tick !== t) return false
          if (lane === 'doubleKick') {
            return String(n.lane) === 'kick' && !!n.flags?.isDoubleKick
          }
          if (lane === 'kick') {
            return String(n.lane) === 'kick' && !n.flags?.isDoubleKick
          }
          return String(n.lane) === lane
        })

        cells.push(
          <GridCell
            key={`${lane}-${t}`}
            x={x}
            y={y}
            laneColor={laneColor}
            existingNote={existingNote}
            onToggle={() => handleToggleDraftNote(lane, t)}
          />
        )
      }
    }

    return cells
  }, [lanes, draftNotes, snapTicks, startTick, pixelsPerTick, instrument, handleToggleDraftNote])

  // --- Drum Hands and Path Calculations ---
  const handNotes = useMemo(() => {
    if (instrument !== 'drums') return []
    return draftNotes.filter(isHandHit).sort((a, b) => a.tick - b.tick)
  }, [draftNotes, instrument])

  const noteAssignments = useMemo(() => {
    if (instrument !== 'drums' || handNotes.length === 0) return new Map<string, 'LH' | 'RH'>()
    return getDrumHandAssignments(handNotes, song.tempoEvents)
  }, [handNotes, instrument, song.tempoEvents])

  const checkIsViolating = useCallback(
    (nA: Note, nB: Note): boolean => {
      const dt = tickToMs(nB.tick, song.tempoEvents) - tickToMs(nA.tick, song.tempoEvents)
      if (dt >= 200) return false

      const settings = useSettingsStore.getState()
      const { limit } = getDrumTransitionLimit(nA, nB, settings)
      if (limit === 0) return false

      return dt < limit - 1
    },
    [song.tempoEvents]
  )

  const handPaths = useMemo(() => {
    if (instrument !== 'drums') return null

    const lhNotes = handNotes.filter((n) => noteAssignments.get(n.id) === 'LH')
    const rhNotes = handNotes.filter((n) => noteAssignments.get(n.id) === 'RH')

    const lines: React.JSX.Element[] = []

    // Left hand path (Blue / Cyan)
    for (let i = 1; i < lhNotes.length; i++) {
      const nA = lhNotes[i - 1]
      const nB = lhNotes[i]
      const x1 = (nA.tick - startTick) * pixelsPerTick
      const y1 = getNoteY(nA)
      const x2 = (nB.tick - startTick) * pixelsPerTick
      const y2 = getNoteY(nB)
      const isViolating = checkIsViolating(nA, nB)

      lines.push(
        <line
          key={`lh-${nA.id}-${nB.id}`}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke={isViolating ? '#ff4d4d' : '#00BFFF'}
          strokeWidth="2.5"
          opacity="0.65"
          markerEnd={isViolating ? 'url(#arrow-red)' : 'url(#arrow-lh)'}
        />
      )
    }

    // Right hand path (Green)
    for (let i = 1; i < rhNotes.length; i++) {
      const nA = rhNotes[i - 1]
      const nB = rhNotes[i]
      const x1 = (nA.tick - startTick) * pixelsPerTick
      const y1 = getNoteY(nA)
      const x2 = (nB.tick - startTick) * pixelsPerTick
      const y2 = getNoteY(nB)
      const isViolating = checkIsViolating(nA, nB)

      lines.push(
        <line
          key={`rh-${nA.id}-${nB.id}`}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke={isViolating ? '#ff4d4d' : '#79D304'}
          strokeWidth="2.5"
          opacity="0.65"
          markerEnd={isViolating ? 'url(#arrow-red)' : 'url(#arrow-rh)'}
        />
      )
    }

    return lines
  }, [
    handNotes,
    noteAssignments,
    instrument,
    startTick,
    pixelsPerTick,
    song.tempoEvents,
    getNoteY,
    checkIsViolating
  ])

  const svgDefs = useMemo(
    () => (
      <defs>
        <marker
          id="arrow-lh"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M 0 1.5 L 10 5 L 0 8.5 z" fill="#00BFFF" />
        </marker>
        <marker
          id="arrow-rh"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M 0 1.5 L 10 5 L 0 8.5 z" fill="#79D304" />
        </marker>
        <marker
          id="arrow-red"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M 0 1.5 L 10 5 L 0 8.5 z" fill="#ff4d4d" />
        </marker>
      </defs>
    ),
    []
  )

  // Run validation checks locally on the draftNotes sandbox
  const [isDraftValid, setIsDraftValid] = useState(true)

  useEffect(() => {
    let active = true
    const checkValidity = async (): Promise<void> => {
      try {
        const nonWindowNotes = (song.notes || []).filter(
          (n) =>
            !(
              n.instrument === instrument &&
              n.difficulty === difficulty &&
              n.tick >= startTick &&
              n.tick <= endTick
            )
        )
        const combinedNotes = [...nonWindowNotes, ...draftNotes]
        const dummySong = { ...song, notes: combinedNotes }

        const settings = useSettingsStore.getState()
        const issues = await validateChartAsync(dummySong, settings)

        if (!active) return

        // Check if the specific issue that this card represents is resolved
        const stillHasThisIssue = issues.some(
          (i) =>
            i.tick === tick &&
            i.instrument === instrument &&
            i.difficulty === difficulty &&
            getIssueTypeKey(i) === getIssueTypeKey(issue)
        )
        setIsDraftValid(!stillHasThisIssue)
      } catch (err) {
        console.error('[isDraftValid check failed]', err)
        if (active) {
          setIsDraftValid(false)
        }
      }
    }

    checkValidity()
    return () => {
      active = false
    }
  }, [draftNotes, song, startTick, endTick, instrument, difficulty])

  // Generate quick suggestions
  const suggestions = useMemo<QuickSuggestion[]>(() => {
    const list: QuickSuggestion[] = []

    if (issue.message.toLowerCase().includes('simultaneous hand hits')) {
      const handNotes = draftNotes.filter((n) => n.tick === tick && isHandHit(n))

      if (handNotes.length >= 3) {
        for (let i = 0; i < handNotes.length; i++) {
          for (let j = i + 1; j < handNotes.length; j++) {
            const n1 = handNotes[i]
            const n2 = handNotes[j]
            const label = `Keep only ${n1.lane} & ${n2.lane}`

            list.push({
              label,
              action: () => {
                return draftNotes.filter(
                  (n) => n.tick !== tick || !isHandHit(n) || n.id === n1.id || n.id === n2.id
                )
              }
            })
          }
        }
      }
    } else if (
      issue.message.toLowerCase().includes('impossible crossover') ||
      issue.message.toLowerCase().includes('impossible transition')
    ) {
      const notesAtTick = draftNotes.filter((n) => n.tick === tick && isHandHit(n))
      const prevTicks = Array.from(new Set(draftNotes.map((n) => n.tick)))
        .filter((t) => t < tick)
        .sort((a, b) => b - a)

      if (prevTicks.length > 0) {
        const prevTick = prevTicks[0]
        const notesAtPrev = draftNotes.filter((n) => n.tick === prevTick && isHandHit(n))

        for (const n2 of notesAtTick) {
          for (const n1 of notesAtPrev) {
            const l1 = getDrumLaneIndex(n1)
            const l2 = getDrumLaneIndex(n2)
            if (l1 === -1 || l2 === -1 || l1 === l2) continue

            list.push({
              label: `Make roll: change ${n2.lane} to ${n1.lane}`,
              action: () => {
                return draftNotes.map((n) =>
                  n.id === n2.id ? { ...n, lane: n1.lane, flags: n1.flags } : n
                )
              }
            })

            list.push({
              label: `Make roll: change ${n1.lane} to ${n2.lane}`,
              action: () => {
                return draftNotes.map((n) =>
                  n.id === n1.id ? { ...n, lane: n2.lane, flags: n2.flags } : n
                )
              }
            })
          }
        }
      }

      for (const note of notesAtTick) {
        list.push({
          label: `Delete ${note.lane}`,
          action: () => {
            return draftNotes.filter((n) => n.id !== note.id)
          }
        })
      }
    } else if (issue.message.toLowerCase().includes('overlapping note')) {
      const overlapping = draftNotes.filter((n) => n.tick === tick)
      const laneGroups = new Map<string | number, Note[]>()
      for (const n of overlapping) {
        let arr = laneGroups.get(n.lane)
        if (!arr) {
          arr = []
          laneGroups.set(n.lane, arr)
        }
        arr.push(n)
      }

      for (const [lane, notesInLane] of laneGroups.entries()) {
        if (notesInLane.length >= 2) {
          list.push({
            label: `Remove duplicate note on ${lane}`,
            action: () => {
              const idsToRemove = notesInLane.slice(1).map((n) => n.id)
              return draftNotes.filter((n) => !idsToRemove.includes(n.id))
            }
          })
        }
      }
    }

    return list
  }, [issue.message, draftNotes, tick])

  const uniqueSuggestions = useMemo(() => {
    const seen = new Set<string>()
    return suggestions.filter((sug) => {
      if (seen.has(sug.label)) return false
      seen.add(sug.label)
      return true
    })
  }, [suggestions])

  const handleApply = async (): Promise<void> => {
    // 1. Delete all existing notes of this instrument & difficulty in the window [startTick, endTick]
    const existingInWindow = songStore
      .getState()
      .song.notes.filter(
        (n) =>
          n.instrument === instrument &&
          n.difficulty === difficulty &&
          n.tick >= startTick &&
          n.tick <= endTick
      )

    for (const note of existingInWindow) {
      songStore.getState().deleteNote(note.id)
    }

    // 2. Add the sandbox notes back
    for (const note of draftNotes) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id: _id, ...noteData } = note
      songStore.getState().addNote(noteData)
    }

    // 3. Re-run validation so the list updates live
    try {
      const updatedState = songStore.getState()
      const settings = useSettingsStore.getState()
      const newIssues = await validateChartAsync(updatedState.song, settings)
      useUIStore.getState().setValidationIssues(newIssues)
    } catch (err) {
      console.error('[handleApply re-validation failed]', err)
    }
  }

  const handleJumpToTick = (): void => {
    songStore.getState().setCurrentTick(tick)
  }

  if (issue.tick === undefined || !issue.instrument || !issue.difficulty) {
    return (
      <div
        style={{
          padding: '12px 16px',
          marginBottom: '8px',
          borderRadius: '6px',
          backgroundColor:
            issue.severity === 'error' ? 'rgba(220,50,50,0.1)' : 'rgba(255,180,0,0.08)',
          borderLeft: `4px solid ${issue.severity === 'error' ? '#dc3232' : '#ffb400'}`,
          color: '#ddd',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              fontSize: '11px',
              fontWeight: 700,
              textTransform: 'uppercase',
              color: issue.severity === 'error' ? '#ff6b6b' : '#ffcc44'
            }}
          >
            {issue.severity === 'error' ? '✖ Error' : '⚠ Warning'}
          </span>
        </div>
        <div style={{ fontSize: '13px', lineHeight: 1.4 }}>{issue.message}</div>
      </div>
    )
  }

  return (
    <div
      style={{
        padding: '16px',
        marginBottom: '12px',
        borderRadius: '8px',
        backgroundColor: '#1b1b26',
        border: '1px solid #2d2d3d',
        borderLeft: `4px solid ${isDraftValid ? '#2ecc71' : issue.severity === 'error' ? '#ff4d4d' : '#ffa502'}`,
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        transition: 'border-left 0.2s ease'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              fontSize: '11px',
              fontWeight: 700,
              textTransform: 'uppercase',
              color: isDraftValid ? '#2ecc71' : issue.severity === 'error' ? '#ff6b6b' : '#ffa502',
              padding: '2px 6px',
              backgroundColor: isDraftValid
                ? 'rgba(46,204,113,0.15)'
                : issue.severity === 'error'
                  ? 'rgba(255,107,107,0.15)'
                  : 'rgba(255,165,2,0.15)',
              borderRadius: '4px',
              transition: 'all 0.2s'
            }}
          >
            {isDraftValid ? 'Resolved' : issue.severity === 'error' ? '✖ Error' : '⚠ Warning'}
          </span>
          <span style={{ fontSize: '12px', color: '#888', fontWeight: 600 }}>
            {instrument} • {difficulty} • Tick {tick}
          </span>
        </div>
        <button
          onClick={handleJumpToTick}
          style={{
            padding: '4px 8px',
            fontSize: '11px',
            fontWeight: 600,
            background: 'rgba(255,255,255,0.06)',
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: '4px',
            cursor: 'pointer',
            transition: 'background 0.2s'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.12)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.06)'
          }}
        >
          Jump to Tick
        </button>
      </div>

      <div style={{ fontSize: '13px', color: '#eee', lineHeight: 1.4, fontWeight: 500 }}>
        {issue.message}
      </div>

      {/* SVG timeline preview full width */}
      <div
        style={{
          backgroundColor: '#111118',
          border: '1px solid #222230',
          borderRadius: '6px',
          width: '100%',
          position: 'relative',
          overflow: 'hidden'
        }}
      >
        <svg viewBox="0 0 800 95" style={{ width: '100%', height: 'auto', display: 'block' }}>
          {svgDefs}
          {backgroundLines}
          {verticalGridLines}
          {handPaths}
          {renderedNotes}
          {gridCells}
        </svg>
      </div>

      {/* Controls container below preview */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' }}>
        {/* Quick Edit lane buttons */}
        {lanes.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span
              style={{
                fontSize: '11px',
                color: '#666',
                fontWeight: 700,
                textTransform: 'uppercase'
              }}
            >
              Quick Edit:
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {lanes.map((lane) => {
                const isActive = draftNotes.some((n) => {
                  if (n.tick !== tick) return false
                  if (lane === 'doubleKick') {
                    return String(n.lane) === 'kick' && !!n.flags?.isDoubleKick
                  }
                  if (lane === 'kick') {
                    return String(n.lane) === 'kick' && !n.flags?.isDoubleKick
                  }
                  return String(n.lane) === lane
                })

                let btnLabel = lane
                let btnColor = 'rgba(255,255,255,0.05)'
                let activeColor = '#666'

                if (instrument === 'drums') {
                  if (lane === 'kick') {
                    btnLabel = 'Kick'
                    btnColor = 'rgba(255, 132, 0, 0.15)'
                    activeColor = '#FF8400'
                  } else if (lane === 'doubleKick') {
                    btnLabel = '2Kick'
                    btnColor = 'rgba(184, 81, 0, 0.15)'
                    activeColor = '#B85100'
                  } else if (lane === 'snare') {
                    btnLabel = 'Snare'
                    btnColor = 'rgba(255, 29, 35, 0.15)'
                    activeColor = '#FF1D23'
                  } else if (lane === 'yellowTom') {
                    btnLabel = 'Y-Tom'
                    btnColor = 'rgba(255, 233, 0, 0.15)'
                    activeColor = '#FFE900'
                  } else if (lane === 'yellowCymbal') {
                    btnLabel = 'Y-Cym'
                    btnColor = 'rgba(255, 233, 0, 0.15)'
                    activeColor = '#FFE900'
                  } else if (lane === 'blueTom') {
                    btnLabel = 'B-Tom'
                    btnColor = 'rgba(0, 191, 255, 0.15)'
                    activeColor = '#00BFFF'
                  } else if (lane === 'blueCymbal') {
                    btnLabel = 'B-Cym'
                    btnColor = 'rgba(0, 191, 255, 0.15)'
                    activeColor = '#00BFFF'
                  } else if (lane === 'greenTom') {
                    btnLabel = 'G-Tom'
                    btnColor = 'rgba(121, 211, 4, 0.15)'
                    activeColor = '#79D304'
                  } else if (lane === 'greenCymbal') {
                    btnLabel = 'G-Cym'
                    btnColor = 'rgba(121, 211, 4, 0.15)'
                    activeColor = '#79D304'
                  }
                } else if (instrument === 'guitar' || instrument === 'bass') {
                  if (lane === 'open') {
                    btnLabel = 'Open'
                    btnColor = 'rgba(200, 0, 255, 0.15)'
                    activeColor = '#C800FF'
                  } else if (lane === 'green') {
                    btnLabel = 'Green'
                    btnColor = 'rgba(121, 211, 4, 0.15)'
                    activeColor = '#79D304'
                  } else if (lane === 'red') {
                    btnLabel = 'Red'
                    btnColor = 'rgba(255, 29, 35, 0.15)'
                    activeColor = '#FF1D23'
                  } else if (lane === 'yellow') {
                    btnLabel = 'Yellow'
                    btnColor = 'rgba(255, 233, 0, 0.15)'
                    activeColor = '#FFE900'
                  } else if (lane === 'blue') {
                    btnLabel = 'Blue'
                    btnColor = 'rgba(0, 191, 255, 0.15)'
                    activeColor = '#00BFFF'
                  } else if (lane === 'orange') {
                    btnLabel = 'Orange'
                    btnColor = 'rgba(255, 132, 0, 0.15)'
                    activeColor = '#FF8400'
                  }
                }

                return (
                  <button
                    key={lane}
                    onClick={() => handleToggleDraftNote(lane, tick)}
                    style={{
                      padding: '4px 8px',
                      fontSize: '11px',
                      fontFamily: 'monospace',
                      fontWeight: 'bold',
                      borderRadius: '4px',
                      border: `1px solid ${isActive ? activeColor : 'rgba(255,255,255,0.1)'}`,
                      background: isActive ? activeColor : btnColor,
                      color: isActive ? '#000' : '#aaa',
                      cursor: 'pointer',
                      boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                      transition: 'all 0.15s ease'
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive) {
                        e.currentTarget.style.border = `1px solid ${activeColor}`
                        e.currentTarget.style.color = '#fff'
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) {
                        e.currentTarget.style.border = '1px solid rgba(255,255,255,0.1)'
                        e.currentTarget.style.color = '#aaa'
                      }
                    }}
                  >
                    {btnLabel}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Quick Suggestions list */}
        {uniqueSuggestions.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span
              style={{
                fontSize: '11px',
                color: '#666',
                fontWeight: 700,
                textTransform: 'uppercase'
              }}
            >
              Quick suggestions:
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {uniqueSuggestions.map((sug, idx) => (
                <button
                  key={idx}
                  onClick={() => setDraftNotes(sug.action())}
                  style={{
                    padding: '4px 8px',
                    fontSize: '11px',
                    borderRadius: '4px',
                    border: '1px solid rgba(0, 204, 255, 0.25)',
                    background: 'rgba(0, 204, 255, 0.05)',
                    color: '#00ccff',
                    cursor: 'pointer',
                    transition: 'all 0.15s'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(0, 204, 255, 0.12)'
                    e.currentTarget.style.borderColor = 'rgba(0, 204, 255, 0.45)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(0, 204, 255, 0.05)'
                    e.currentTarget.style.borderColor = 'rgba(0, 204, 255, 0.25)'
                  }}
                >
                  {sug.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Sandbox Status & Action row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderTop: '1px solid #2d2d3d',
            paddingTop: '8px',
            marginTop: '4px'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: isDraftValid ? '#2ecc71' : '#ff9f43',
                boxShadow: isDraftValid ? '0 0 6px #2ecc71' : '0 0 6px #ff9f43',
                transition: 'all 0.2s'
              }}
            />
            <span
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: isDraftValid ? '#2ecc71' : '#ff9f43',
                transition: 'color 0.2s'
              }}
            >
              {isDraftValid ? 'Resolved (passes validation)' : 'Unresolved draft'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {hasActiveDraft && (
              <button
                onClick={handleRevert}
                style={{
                  padding: '6px 12px',
                  fontSize: '12px',
                  fontWeight: 600,
                  background: 'rgba(255,255,255,0.05)',
                  color: '#aaa',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.1)'
                  e.currentTarget.style.color = '#fff'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                  e.currentTarget.style.color = '#aaa'
                }}
              >
                Revert
              </button>
            )}
            <button
              disabled={!isDraftValid}
              onClick={handleApply}
              style={{
                padding: '6px 12px',
                fontSize: '12px',
                fontWeight: 700,
                background: isDraftValid ? '#2ecc71' : 'rgba(255,255,255,0.03)',
                color: isDraftValid ? '#000' : '#666',
                border: isDraftValid ? 'none' : '1px solid rgba(255,255,255,0.05)',
                borderRadius: '4px',
                cursor: isDraftValid ? 'pointer' : 'not-allowed',
                boxShadow: isDraftValid ? '0 0 10px rgba(46,204,113,0.3)' : 'none',
                transition: 'all 0.15s ease'
              }}
              onMouseEnter={(e) => {
                if (isDraftValid) e.currentTarget.style.transform = 'scale(1.03)'
              }}
              onMouseLeave={(e) => {
                if (isDraftValid) e.currentTarget.style.transform = 'scale(1)'
              }}
            >
              Apply Fix
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
