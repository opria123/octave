import { describe, it, expect } from 'vitest'
import { parseMidi, writeMidi } from 'midi-file'
import type { MidiData } from 'midi-file'
import { parseMidiBase64, serializeMidiBase64, parseChartFile, serializeChartFile } from './midiParser'
import type { LaneMarker, Note, SongSection, VenueTrackData } from '../types'

// Issue #12: open frets and tap notes reverted to green/strums after a
// save → reopen round-trip because serializeMidiBase64 dropped them.
describe('open fret / tap note MIDI round-trip', () => {
  const mkNote = (over: Partial<Note>): Note => ({
    id: 'x',
    tick: 0,
    duration: 120,
    instrument: 'guitar',
    difficulty: 'expert',
    lane: 'green',
    velocity: 100,
    ...over
  })

  it('preserves open frets and taps across serialize → parse', () => {
    const notes: Note[] = [
      mkNote({ tick: 0, lane: 'open' }),
      mkNote({ tick: 480, lane: 'red', flags: { isTap: true } }),
      mkNote({ tick: 960, lane: 'orange' }),
      mkNote({ tick: 1440, lane: 'open', flags: { isTap: true } }),
      mkNote({ tick: 1920, lane: 'open', difficulty: 'hard', instrument: 'bass' }),
      mkNote({ tick: 1920, lane: 'green', difficulty: 'expert', instrument: 'bass' })
    ]
    const b64 = serializeMidiBase64(notes, [{ tick: 0, bpm: 120 }], [{ tick: 0, numerator: 4, denominator: 4 }])
    const parsed = parseMidiBase64(b64)

    const find = (tick: number, instrument: string, difficulty: string): Note | undefined =>
      parsed.notes.find((n) => n.tick === tick && n.instrument === instrument && n.difficulty === difficulty)

    expect(find(0, 'guitar', 'expert')?.lane).toBe('open')
    expect(find(0, 'guitar', 'expert')?.flags?.isTap).toBeFalsy()
    expect(find(480, 'guitar', 'expert')?.lane).toBe('red')
    expect(find(480, 'guitar', 'expert')?.flags?.isTap).toBe(true)
    expect(find(960, 'guitar', 'expert')?.lane).toBe('orange')
    expect(find(960, 'guitar', 'expert')?.flags?.isTap).toBeFalsy()
    expect(find(1440, 'guitar', 'expert')?.lane).toBe('open')
    expect(find(1440, 'guitar', 'expert')?.flags?.isTap).toBe(true)
    // PS phrases are per-difficulty: hard bass open must not affect the
    // expert bass green note at the same tick.
    expect(find(1920, 'bass', 'hard')?.lane).toBe('open')
    expect(find(1920, 'bass', 'expert')?.lane).toBe('green')
  })

  it('survives a double round-trip', () => {
    const notes: Note[] = [
      mkNote({ tick: 0, lane: 'open' }),
      mkNote({ tick: 480, lane: 'yellow', flags: { isTap: true } })
    ]
    const once = parseMidiBase64(
      serializeMidiBase64(notes, [{ tick: 0, bpm: 120 }], [{ tick: 0, numerator: 4, denominator: 4 }])
    )
    const twice = parseMidiBase64(
      serializeMidiBase64(once.notes, once.tempoEvents, once.timeSignatures)
    )
    expect(twice.notes.find((n) => n.tick === 0)?.lane).toBe('open')
    expect(twice.notes.find((n) => n.tick === 480)?.flags?.isTap).toBe(true)
  })
})

// Issue #37: BRE sections and drum rolls disappeared after a save → reopen
// round-trip because both serializers dropped lane markers entirely.
describe('lane marker round-trip', () => {
  const tempo = [{ tick: 0, bpm: 120 }]
  const timeSig = [{ tick: 0, numerator: 4, denominator: 4 }]
  const mkNote = (over: Partial<Note>): Note => ({
    id: 'x',
    tick: 0,
    duration: 120,
    instrument: 'guitar',
    difficulty: 'expert',
    lane: 'green',
    velocity: 100,
    ...over
  })
  const mkMarker = (over: Partial<LaneMarker>): LaneMarker => ({
    id: 'm',
    tick: 960,
    duration: 480,
    instrument: 'drums',
    type: 'drumRoll',
    ...over
  })
  // The serializers only emit tracks that contain notes, so seed one per instrument.
  const notes: Note[] = [
    mkNote({ instrument: 'drums', lane: 'kick' }),
    mkNote({ instrument: 'guitar', lane: 'green' })
  ]

  const findMarker = (
    markers: LaneMarker[],
    instrument: string,
    type: string
  ): LaneMarker | undefined =>
    markers.find((m) => m.instrument === instrument && m.type === type)

  it('preserves BRE and drum roll markers across MIDI serialize → parse', () => {
    const markers: LaneMarker[] = [
      mkMarker({ tick: 960, type: 'drumRoll' }),
      mkMarker({ tick: 1920, type: 'bre' }),
      mkMarker({ tick: 960, instrument: 'guitar', type: 'tremolo' }),
      mkMarker({ tick: 1920, instrument: 'guitar', type: 'trill' }),
      mkMarker({ tick: 2880, instrument: 'guitar', type: 'bre' })
    ]
    const parsed = parseMidiBase64(
      serializeMidiBase64(notes, tempo, timeSig, 480, [], [], [], [], [], markers)
    )

    expect(findMarker(parsed.laneMarkers, 'drums', 'drumRoll')).toMatchObject({ tick: 960, duration: 480 })
    expect(findMarker(parsed.laneMarkers, 'drums', 'bre')).toMatchObject({ tick: 1920, duration: 480 })
    expect(findMarker(parsed.laneMarkers, 'guitar', 'tremolo')).toMatchObject({ tick: 960 })
    expect(findMarker(parsed.laneMarkers, 'guitar', 'trill')).toMatchObject({ tick: 1920 })
    expect(findMarker(parsed.laneMarkers, 'guitar', 'bre')).toMatchObject({ tick: 2880 })
    // The BRE companion notes (121-124) must not leak into playable notes.
    expect(parsed.notes).toHaveLength(notes.length)
  })

  it('preserves drum fill/roll markers across .chart serialize → parse', () => {
    const markers: LaneMarker[] = [
      mkMarker({ tick: 960, type: 'drumRoll' }),
      mkMarker({ tick: 1920, type: 'bre' })
    ]
    const parsed = parseChartFile(
      serializeChartFile(notes, tempo, timeSig, [], [], [], [], [], {}, 192, markers)
    )

    expect(findMarker(parsed.laneMarkers, 'drums', 'drumRoll')).toMatchObject({ tick: 960, duration: 480 })
    expect(findMarker(parsed.laneMarkers, 'drums', 'bre')).toMatchObject({ tick: 1920, duration: 480 })
  })
})

// Issue #55: RB3's EVENTS and VENUE commands were read correctly, but save /
// export wrote them as marker events (0x06). RB3 tooling, including Onyx,
// expects the text-event form (0x01) and reports marker events as unrecognized.
describe('RB3 EVENTS and VENUE MIDI event encoding', () => {
  const tempo = [{ tick: 0, bpm: 120 }]
  const timeSig = [{ tick: 0, numerator: 4, denominator: 4 }]
  const sections: SongSection[] = [{ id: 'verse', tick: 480, name: 'verse 1' }]
  const venue: VenueTrackData = {
    autoGenerated: false,
    lighting: [{ id: 'lighting', tick: 960, type: 'verse' }],
    postProcessing: [{ id: 'post', tick: 1440, type: 'video_a.pp' }],
    stage: [],
    performer: [],
    cameraCuts: [{ id: 'camera', tick: 1920, subject: 'coop_all_near' }]
  }

  it('writes RB3 section and venue commands as text events', () => {
    const midiBase64 = serializeMidiBase64([], tempo, timeSig, 480, [], [], [], [], sections, [], venue)
    const tracks = parseMidi(Buffer.from(midiBase64, 'base64')).tracks
    const findTrack = (name: string) => tracks.find((track) =>
      track.some((event) => event.type === 'trackName' && event.text === name)
    )

    const eventTrack = findTrack('EVENTS')
    const venueTrack = findTrack('VENUE')

    expect(eventTrack).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: '[section verse 1]' })
    ]))
    expect(venueTrack).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: '[lighting (verse)]' }),
      expect.objectContaining({ type: 'text', text: '[video_a.pp]' }),
      expect.objectContaining({ type: 'text', text: '[coop_all_near]' })
    ]))
    expect(eventTrack?.some((event) => event.type === 'marker')).toBe(false)
    expect(venueTrack?.some((event) => event.type === 'marker')).toBe(false)

    const parsed = parseMidiBase64(midiBase64)
    expect(parsed.songSections).toMatchObject([{ tick: 480, name: 'verse 1' }])
    expect(parsed.venueTrack.lighting).toMatchObject([{ tick: 960, type: 'verse' }])
    expect(parsed.venueTrack.postProcessing).toMatchObject([{ tick: 1440, type: 'video_a.pp' }])
    expect(parsed.venueTrack.cameraCuts).toMatchObject([{ tick: 1920, subject: 'coop_all_near' }])
  })

  it('retains valid RB3 commands that OCTAVE does not yet model', () => {
    const source: MidiData = {
      header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
      tracks: [
        [
          { type: 'trackName', text: 'EVENTS', deltaTime: 0 },
          { type: 'text', text: '[music_start]', deltaTime: 480 },
          { type: 'text', text: '[prc_verse_1]', deltaTime: 480 },
          { type: 'endOfTrack', deltaTime: 0 }
        ],
        [
          { type: 'trackName', text: 'VENUE', deltaTime: 0 },
          { type: 'text', text: '[do_directed_cut directed_guitar]', deltaTime: 480 },
          { type: 'endOfTrack', deltaTime: 0 }
        ]
      ]
    }
    const imported = parseMidiBase64(Buffer.from(writeMidi(source)).toString('base64'))

    expect(imported.venueTrack.preservedTextEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ tick: 480, track: 'EVENTS', text: '[music_start]' }),
      expect.objectContaining({ tick: 960, track: 'EVENTS', text: '[prc_verse_1]' }),
      expect.objectContaining({ tick: 480, track: 'VENUE', text: '[do_directed_cut directed_guitar]' })
    ]))

    const exported = parseMidi(
      Buffer.from(
        serializeMidiBase64(
          [], imported.tempoEvents, imported.timeSignatures, 480, [], [], [], [],
          imported.songSections, [], imported.venueTrack
        ),
        'base64'
      )
    ).tracks
    const textEvents = exported.flatMap((track) => track.filter((event) => event.type === 'text'))

    expect(textEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '[music_start]' }),
      expect.objectContaining({ text: '[prc_verse_1]' }),
      expect.objectContaining({ text: '[do_directed_cut directed_guitar]' })
    ]))
    expect(exported.flatMap((track) => track).some((event) => event.type === 'marker')).toBe(false)
  })
})
