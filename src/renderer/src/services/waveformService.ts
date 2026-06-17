import type { TempoEvent } from '../types'
import { getAudioBufferForPath, getAudioBuffers, tickToSeconds } from './audioService'

const TICKS_PER_BEAT = 480

function secondsToTick(seconds: number, tempoEvents: TempoEvent[]): number {
  let accSeconds = 0
  let prevTick = 0
  let bpm = tempoEvents[0]?.bpm ?? 120

  for (const event of tempoEvents) {
    const segmentSeconds = (event.tick - prevTick) / ((TICKS_PER_BEAT * bpm) / 60)
    if (accSeconds + segmentSeconds >= seconds) break
    accSeconds += segmentSeconds
    prevTick = event.tick
    bpm = event.bpm
  }

  return Math.round(prevTick + (seconds - accSeconds) * ((TICKS_PER_BEAT * bpm) / 60))
}

function resolveWaveformBuffers(songId: string, sourcePath?: string): AudioBuffer[] {
  if (sourcePath) {
    const single = getAudioBufferForPath(songId, sourcePath)
    if (single) return [single]
  }
  return getAudioBuffers(songId)
}

export interface TickAlignedWaveform {
  peaks: Float32Array
  totalTicks: number
}

export function buildTickAlignedWaveformPeaks({
  songId,
  tempoEvents,
  rows,
  sourcePath,
  maxSamplesPerRow = 256
}: {
  songId: string
  tempoEvents: TempoEvent[]
  rows: number
  sourcePath?: string
  maxSamplesPerRow?: number
}): TickAlignedWaveform | null {
  const buffers = resolveWaveformBuffers(songId, sourcePath)
  if (buffers.length === 0) return null

  const duration = Math.max(...buffers.map((b) => b.duration))
  if (!(duration > 0) || !(rows > 0)) return null

  const totalTicks = Math.max(1, secondsToTick(duration, tempoEvents))
  const channels = buffers.map((b) => ({ data: b.getChannelData(0), rate: b.sampleRate }))
  const peaks = new Float32Array(rows)

  let globalPeak = 0
  let tPrev = 0
  for (let row = 0; row < rows; row++) {
    const tNext = tickToSeconds(((row + 1) / rows) * totalTicks, tempoEvents)
    let peak = 0

    for (const chan of channels) {
      const s0 = Math.floor(tPrev * chan.rate)
      const s1 = Math.min(chan.data.length, Math.ceil(tNext * chan.rate))
      if (s1 <= s0) continue
      const step = Math.max(1, Math.floor((s1 - s0) / maxSamplesPerRow))
      for (let s = s0; s < s1; s += step) {
        const v = Math.abs(chan.data[s])
        if (v > peak) peak = v
      }
    }

    peaks[row] = peak
    if (peak > globalPeak) globalPeak = peak
    tPrev = tNext
  }

  if (globalPeak <= 0) return null

  for (let i = 0; i < peaks.length; i++) {
    peaks[i] = peaks[i] / globalPeak
  }

  return { peaks, totalTicks }
}