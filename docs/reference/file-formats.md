# File Formats

OCTAVE reads and writes the standard Clone Hero / YARG song-folder layout.

## Song folder structure

```text
My Song - Some Artist/
├── notes.mid          # Required — multi-track MIDI chart
│   └── (or notes.chart for legacy Clone Hero charts)
├── song.ini           # Required — metadata
├── album.png          # Optional — album art (jpg also accepted)
├── song.ogg           # Backing track (everything not in another stem)
├── drums.ogg          # Optional drum stem (or drums_1..4.ogg)
├── bass.ogg           # Optional
├── guitar.ogg         # Optional
├── keys.ogg           # Optional
├── vocals.ogg         # Optional (or vocals_1..3.ogg)
├── crowd.ogg          # Optional
└── video.mp4          # Optional chart video
```

Audio can be `.ogg` (Vorbis), `.opus`, or `.mp3`. OCTAVE never re-encodes existing audio on save.

## `notes.mid`

Standard format-1 MIDI with one track per instrument:

| Track name | Instrument |
|-----------|-----------|
| `PART DRUMS` | Drums (5-lane / Pro) |
| `PART GUITAR` | Lead guitar (5-fret) |
| `PART BASS` | Bass guitar (5-fret) |
| `PART KEYS` | Keys (5-fret) |
| `PART REAL_KEYS_X` | Pro Keys (Expert / Hard / Medium / Easy) |
| `PART REAL_GUITAR` | Pro Guitar (6-string × 22 frets) |
| `PART REAL_BASS` | Pro Bass |
| `PART VOCALS` | Lead vocals + lyrics |
| `HARM2` / `HARM3` | Vocal harmonies |
| `EVENTS` | Practice sections, lighting cues |
| `BEAT` | Beat track for strikeline timing |
| `VENUE` | Venue lighting and camera cuts |

OCTAVE preserves any track it doesn't understand, so round-tripping a chart is safe.

## `notes.chart`

Plain-text Clone Hero format. OCTAVE converts to/from MIDI internally — saving a `.chart` source song writes back as `.chart`; saving a `.mid` source writes `.mid`.

## `song.ini`

Standard Clone Hero `[song]` section. OCTAVE writes:

```ini
[song]
name = My Song
artist = Some Artist
album = An Album
genre = Rock
year = 2024
charter = OCTAVE
song_length = 215000
preview_start_time = 30000
delay = 0
diff_band = 4
diff_drums = 5
diff_guitar = 4
diff_bass = 3
diff_keys = 3
diff_vocals = 4
```

Any extra fields present in the original file are preserved.
