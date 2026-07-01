import type { SongData, Note, Instrument, Difficulty, AppSettings, ValidationIssue } from '../types'

export function tickToMs(tick: number, tempoEvents: { tick: number; bpm: number }[]): number {
  if (tempoEvents.length === 0) {
    return (tick / ((480 * 120) / 60)) * 1000
  }

  let totalSeconds = 0
  let currentTick = 0
  let currentBpm = tempoEvents[0].bpm

  for (let i = 0; i < tempoEvents.length; i++) {
    const event = tempoEvents[i]
    if (tick <= event.tick) {
      break
    }
    const deltaTicks = event.tick - currentTick
    totalSeconds += deltaTicks / ((480 * currentBpm) / 60)

    currentTick = event.tick
    currentBpm = event.bpm
  }

  if (tick > currentTick) {
    const deltaTicks = tick - currentTick
    totalSeconds += deltaTicks / ((480 * currentBpm) / 60)
  }

  return totalSeconds * 1000
}

export const isHandHit = (note: Note): boolean => {
  const laneStr = String(note.lane)
  return laneStr !== 'kick' && laneStr !== 'doubleKick' && !note.flags?.isDoubleKick
}

export const isCymbal = (note: Note): boolean => {
  const laneStr = String(note.lane)
  return laneStr.includes('Cymbal') || note.flags?.isCymbal === true
}

export const getDrumLaneIndex = (note: Note): number => {
  const laneStr = String(note.lane)
  if (laneStr === 'snare') return 0
  if (laneStr.startsWith('yellow')) return 1
  if (laneStr.startsWith('blue')) return 2
  if (laneStr.startsWith('green')) return 3
  return -1
}

export function getDrumTransitionLimit(
  n1: Note,
  n2: Note,
  settings: {
    validationDrumTimeThresholdMs: number
    validationDrumCrossoverThresholdMs: number
  }
): { limit: number; isCrossover: boolean } {
  const l1 = getDrumLaneIndex(n1)
  const l2 = getDrumLaneIndex(n2)
  if (l1 === -1 || l2 === -1 || l1 === l2) return { limit: 0, isCrossover: false }

  const distance = Math.abs(l1 - l2)
  const hasCymbal = isCymbal(n1) || isCymbal(n2)
  const isCrossover = distance === 3

  let limit = 0
  if (isCrossover) {
    limit = hasCymbal
      ? settings.validationDrumCrossoverThresholdMs * 1.5
      : settings.validationDrumCrossoverThresholdMs
  } else {
    limit = hasCymbal
      ? settings.validationDrumTimeThresholdMs * 1.25
      : settings.validationDrumTimeThresholdMs
  }
  return { limit, isCrossover }
}

export function getDrumHandAssignments(
  notes: Note[],
  tempoEvents: { tick: number; bpm: number }[]
): Map<string, 'LH' | 'RH'> {
  const assignments = new Map<string, 'LH' | 'RH'>()
  if (notes.length === 0) return assignments

  // Group notes by tick
  const ticksMap = new Map<number, Note[]>()
  for (const n of notes) {
    let list = ticksMap.get(n.tick)
    if (!list) {
      list = []
      ticksMap.set(n.tick, list)
    }
    list.push(n)
  }

  const sortedTicks = Array.from(ticksMap.keys()).sort((a, b) => a - b)

  let lastLHNote: Note | null = null
  let lastRHNote: Note | null = null

  for (const t of sortedTicks) {
    const notesAtTick = ticksMap.get(t) || []

    // If there are 2 or more notes at this tick (chord)
    if (notesAtTick.length >= 2) {
      // Sort from leftmost lane (index 0) to rightmost lane (index 3)
      const sorted = [...notesAtTick].sort((a, b) => getDrumLaneIndex(a) - getDrumLaneIndex(b))

      // Leftmost note is LH
      assignments.set(sorted[0].id, 'LH')
      // Rightmost note is RH
      assignments.set(sorted[sorted.length - 1].id, 'RH')

      // Any middle notes
      for (let i = 1; i < sorted.length - 1; i++) {
        const mid = sorted[i]
        const idx = getDrumLaneIndex(mid)
        // Assign to closest hand
        const lastLHLane = lastLHNote ? getDrumLaneIndex(lastLHNote) : -1
        const lastRHLane = lastRHNote ? getDrumLaneIndex(lastRHNote) : -1
        const distLH = lastLHLane !== -1 ? Math.abs(idx - lastLHLane) : idx
        const distRH = lastRHLane !== -1 ? Math.abs(idx - lastRHLane) : 3 - idx
        if (distLH <= distRH) {
          assignments.set(mid.id, 'LH')
        } else {
          assignments.set(mid.id, 'RH')
        }
      }

      lastLHNote = sorted[0]
      lastRHNote = sorted[sorted.length - 1]
    }
    // If there is only 1 note at this tick (single hit)
    else if (notesAtTick.length === 1) {
      const n = notesAtTick[0]
      const idx = getDrumLaneIndex(n) // 0=snare, 1=yellow, 2=blue, 3=green

      let chosenHand: 'LH' | 'RH' = 'LH'

      // Helper to check if a transition for a hand is "possible"
      const canLHPlay = (): boolean => {
        if (!lastLHNote) return true
        const dt = tickToMs(t, tempoEvents) - tickToMs(lastLHNote.tick, tempoEvents)
        const lastIdx = getDrumLaneIndex(lastLHNote)
        const dist = Math.abs(idx - lastIdx)
        if (dist === 0) return true
        const isCym = isCymbal(n) || isCymbal(lastLHNote)
        if (dist === 3) {
          const limit = isCym ? 120 : 80
          return dt >= limit - 1
        } else {
          const limit = isCym ? 50 : 40
          return dt >= limit - 1
        }
      }

      const canRHPlay = (): boolean => {
        if (!lastRHNote) return true
        const dt = tickToMs(t, tempoEvents) - tickToMs(lastRHNote.tick, tempoEvents)
        const lastIdx = getDrumLaneIndex(lastRHNote)
        const dist = Math.abs(idx - lastIdx)
        if (dist === 0) return true
        const isCym = isCymbal(n) || isCymbal(lastRHNote)
        if (dist === 3) {
          const limit = isCym ? 120 : 80
          return dt >= limit - 1
        } else {
          const limit = isCym ? 50 : 40
          return dt >= limit - 1
        }
      }

      const lhFeasible = canLHPlay()
      const rhFeasible = canRHPlay()

      // If only one hand is physically feasible, we MUST use it!
      if (lhFeasible && !rhFeasible) {
        chosenHand = 'LH'
      } else if (!lhFeasible && rhFeasible) {
        chosenHand = 'RH'
      } else {
        // If both or neither are feasible, we decide based on natural lanes and alternation:
        if (idx === 0) {
          chosenHand = 'LH'
        } else if (idx === 3) {
          chosenHand = 'RH'
        } else {
          const timeSinceLastLH = lastLHNote
            ? tickToMs(t, tempoEvents) - tickToMs(lastLHNote.tick, tempoEvents)
            : Infinity
          const timeSinceLastRH = lastRHNote
            ? tickToMs(t, tempoEvents) - tickToMs(lastRHNote.tick, tempoEvents)
            : Infinity

          const lastActiveHand = (lastLHNote?.tick ?? -1) > (lastRHNote?.tick ?? -1) ? 'LH' : 'RH'
          const minTime = Math.min(timeSinceLastLH, timeSinceLastRH)

          if (minTime < 250) {
            chosenHand = lastActiveHand === 'LH' ? 'RH' : 'LH'
          } else {
            chosenHand = idx === 1 ? 'LH' : 'RH'
          }
        }
      }

      assignments.set(n.id, chosenHand)
      if (chosenHand === 'LH') {
        lastLHNote = n
      } else {
        lastRHNote = n
      }
    }
  }

  return assignments
}

export function validateChart(song: SongData, settings?: Partial<AppSettings>): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  try {
    if (!song) {
      issues.push({ severity: 'error', message: 'No song data provided.' })
      return issues
    }

    const notes = song.notes || []
    const starPowerPhrases = song.starPowerPhrases || []
    const vocalNotes = song.vocalNotes || []
    const tempoEvents = song.tempoEvents || []

    if (notes.length === 0 && vocalNotes.length === 0) {
      issues.push({ severity: 'warning', message: 'Chart has no notes on any instrument.' })
      return issues
    }

    // Load configuration defaults if settings are not passed
    const config = {
      validationMinSustainGuitar: settings?.validationMinSustainGuitar ?? 48,
      validationMinSustainBass: settings?.validationMinSustainBass ?? 48,
      validationMinSustainKeys: settings?.validationMinSustainKeys ?? 48,
      validationMinSustainDrums: settings?.validationMinSustainDrums ?? 0,
      validationEnableOverlapsCheck: settings?.validationEnableOverlapsCheck ?? true,
      validationEnableStarPowerCheck: settings?.validationEnableStarPowerCheck ?? true,
      validationEnableDrumImpossibilityCheck:
        settings?.validationEnableDrumImpossibilityCheck ?? true,
      validationDrumTimeThresholdMs: settings?.validationDrumTimeThresholdMs ?? 40,
      validationDrumCrossoverThresholdMs: settings?.validationDrumCrossoverThresholdMs ?? 80
    }

    // --- 1. Overlapping notes (same instrument + difficulty + lane at same tick) ---
    if (config.validationEnableOverlapsCheck) {
      const noteMap = new Map<string, Note>()
      for (const note of notes) {
        const key = `${note.instrument}|${note.difficulty}|${note.lane}|${note.tick}`
        if (noteMap.has(key)) {
          issues.push({
            severity: 'error',
            message: `Overlapping note at tick ${note.tick} (${note.instrument} ${note.difficulty} lane ${note.lane})`,
            tick: note.tick,
            instrument: note.instrument,
            difficulty: note.difficulty
          })
        } else {
          noteMap.set(key, note)
        }
      }
    }

    // --- 2. Very short sustains (likely authoring mistake) ---
    for (const note of notes) {
      if (note.duration > 0) {
        let minSustain = 0
        if (note.instrument === 'guitar') minSustain = config.validationMinSustainGuitar
        else if (note.instrument === 'bass') minSustain = config.validationMinSustainBass
        else if (note.instrument === 'keys' || note.instrument === 'proKeys')
          minSustain = config.validationMinSustainKeys
        else if (note.instrument === 'drums') minSustain = config.validationMinSustainDrums

        if (minSustain > 0 && note.duration < minSustain) {
          issues.push({
            severity: 'warning',
            message: `Very short sustain (${note.duration} ticks) at tick ${note.tick} on ${note.instrument} ${note.difficulty} (min threshold: ${minSustain})`,
            tick: note.tick,
            instrument: note.instrument,
            difficulty: note.difficulty
          })
        }
      }
    }

    // --- 3. Instruments with notes but no star power ---
    if (config.validationEnableStarPowerCheck) {
      const instrumentsWithNotes = new Set<string>()
      for (const note of notes) {
        instrumentsWithNotes.add(`${note.instrument}|${note.difficulty}`)
      }
      const instrumentsWithSP = new Set<string>()
      for (const sp of starPowerPhrases) {
        for (const diff of ['expert', 'hard', 'medium', 'easy'] as Difficulty[]) {
          instrumentsWithSP.add(`${sp.instrument}|${diff}`)
        }
      }
      for (const key of instrumentsWithNotes) {
        if (!instrumentsWithSP.has(key)) {
          const [inst, diff] = key.split('|')
          issues.push({
            severity: 'warning',
            message: `No star power phrases for ${inst} (${diff})`,
            instrument: inst as Instrument,
            difficulty: diff as Difficulty
          })
        }
      }
    }

    // --- 4. Notes beyond end of tempo map last event ---
    const lastTempoTick = tempoEvents.length > 0 ? tempoEvents[tempoEvents.length - 1].tick : 0
    if (notes.length > 0) {
      const lastNoteTick = Math.max(...notes.map((n) => n.tick))
      if (lastTempoTick > 0 && lastNoteTick > lastTempoTick * 4) {
        issues.push({
          severity: 'warning',
          message: `Notes extend far beyond last tempo event (last note: tick ${lastNoteTick}, last tempo: tick ${lastTempoTick}). Check tempo map.`
        })
      }
    }

    // --- 5. Vocal notes with no lyrics (except percussion) ---
    const vocalNotesWithoutLyric = vocalNotes.filter((n) => !n.isPercussion && !n.lyric)
    if (vocalNotesWithoutLyric.length > 5) {
      issues.push({
        severity: 'warning',
        message: `${vocalNotesWithoutLyric.length} vocal notes have no lyric text.`,
        instrument: 'vocals'
      })
    }

    // --- 6. Drum physical check ---
    if (config.validationEnableDrumImpossibilityCheck) {
      const drumNotes = notes.filter((n) => n.instrument === 'drums')
      const difficulties: Difficulty[] = ['expert', 'hard', 'medium', 'easy']

      for (const diff of difficulties) {
        const diffDrumNotes = drumNotes.filter((n) => n.difficulty === diff)
        if (diffDrumNotes.length === 0) continue

        // Chords (3+ hands) check
        const hitsByTick = new Map<number, Note[]>()
        for (const note of diffDrumNotes) {
          if (!isHandHit(note)) continue
          let arr = hitsByTick.get(note.tick)
          if (!arr) {
            arr = []
            hitsByTick.set(note.tick, arr)
          }
          arr.push(note)
        }

        for (const [tick, hits] of hitsByTick.entries()) {
          if (hits.length >= 3) {
            issues.push({
              severity: 'error',
              message: `Three or more simultaneous hand hits (${hits.length}) is physically impossible on drums at tick ${tick} (${diff})`,
              tick,
              instrument: 'drums',
              difficulty: diff
            })
          }
        }

        // Hand path speed limits and crossover checks
        const handNotesOnly = diffDrumNotes.filter(isHandHit).sort((a, b) => a.tick - b.tick)
        const assignments = getDrumHandAssignments(handNotesOnly, tempoEvents)

        const lhNotes = handNotesOnly.filter((n) => assignments.get(n.id) === 'LH')
        const rhNotes = handNotesOnly.filter((n) => assignments.get(n.id) === 'RH')

        const checkHandPath = (handNotes: Note[]): void => {
          for (let i = 1; i < handNotes.length; i++) {
            const n1 = handNotes[i - 1]
            const n2 = handNotes[i]

            const dt = tickToMs(n2.tick, tempoEvents) - tickToMs(n1.tick, tempoEvents)
            if (dt >= 200) continue

            const l1 = getDrumLaneIndex(n1)
            const l2 = getDrumLaneIndex(n2)
            if (l1 === -1 || l2 === -1 || l1 === l2) continue

            const distance = Math.abs(l1 - l2)
            const hasCymbal = isCymbal(n1) || isCymbal(n2)

            if (distance === 3) {
              // Crossover check (Snare to Green or Green to Snare)
              // Cymbals have increased crossover limit (1.5x)
              const threshold = hasCymbal
                ? config.validationDrumCrossoverThresholdMs * 1.5
                : config.validationDrumCrossoverThresholdMs

              // Apply 1ms tolerance to avoid floating-point rounding issues on exact limits
              if (dt < threshold - 1) {
                issues.push({
                  severity: 'warning',
                  message: `Impossible crossover transition (${n1.lane} to ${n2.lane}, dt: ${Math.round(dt)}ms, limit: ${Math.round(threshold)}ms) at tick ${n2.tick} (${diff})`,
                  tick: n2.tick,
                  instrument: 'drums',
                  difficulty: diff
                })
              }
            } else {
              // Standard transition (distance 1 or 2)
              // Cymbals have increased transition limit (1.25x)
              const threshold = hasCymbal
                ? config.validationDrumTimeThresholdMs * 1.25
                : config.validationDrumTimeThresholdMs

              // Apply 1ms tolerance to avoid floating-point rounding issues on exact limits
              if (dt < threshold - 1) {
                issues.push({
                  severity: 'error',
                  message: `Physically impossible transition between pads (${n1.lane} to ${n2.lane}, dt: ${Math.round(dt)}ms, limit: ${Math.round(threshold)}ms) at tick ${n2.tick} (${diff})`,
                  tick: n2.tick,
                  instrument: 'drums',
                  difficulty: diff
                })
              }
            }
          }
        }

        checkHandPath(lhNotes)
        checkHandPath(rhNotes)
      }
    }
  } catch (error) {
    console.error('[Chart Validation Error]', error)
    const errMsg = error instanceof Error ? error.message : String(error)
    issues.push({
      severity: 'error',
      message: `Validation engine error: ${errMsg}`
    })
  }

  return issues
}

let activeWorker: Worker | null = null

export function validateChartAsync(
  song: SongData,
  settings?: Partial<AppSettings>
): Promise<ValidationIssue[]> {
  return new Promise((resolve, reject) => {
    try {
      if (!activeWorker) {
        activeWorker = new Worker(new URL('./chartValidation.worker.ts', import.meta.url), {
          type: 'module'
        })
      }

      const handler = (event: MessageEvent): void => {
        activeWorker?.removeEventListener('message', handler)
        activeWorker?.removeEventListener('error', errorHandler)
        if (event.data.type === 'success') {
          resolve(event.data.issues)
        } else {
          reject(new Error(event.data.error))
        }
      }

      const errorHandler = (err: ErrorEvent): void => {
        activeWorker?.removeEventListener('message', handler)
        activeWorker?.removeEventListener('error', errorHandler)
        activeWorker?.terminate()
        activeWorker = null
        reject(err.error || new Error('Worker execution error'))
      }

      activeWorker.addEventListener('message', handler)
      activeWorker.addEventListener('error', errorHandler)
      activeWorker.postMessage({ song, settings })
    } catch (workerErr) {
      console.warn(
        'Failed to start web worker for validation, falling back to sync validation:',
        workerErr
      )
      try {
        const issues = validateChart(song, settings)
        resolve(issues)
      } catch (err) {
        reject(err)
      }
    }
  })
}
