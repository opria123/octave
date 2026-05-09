# Stems Mixer

A DAW-style mixer for the loaded song's audio stems. Open it from the toolbar (mixer icon).

## What's a stem?

OCTAVE auto-loads every audio file it finds in the song folder as a separate stem. Common conventions:

| Filename | Stem |
|----------|------|
| `song.ogg` / `song.opus` | Backing track (everything not in another stem) |
| `drums.ogg`, `drums_1.ogg`, `drums_2.ogg`, `drums_3.ogg`, `drums_4.ogg` | Drum stems (split kit or single mix) |
| `bass.ogg` | Bass guitar |
| `guitar.ogg` | Lead / rhythm guitar |
| `keys.ogg` | Keys / piano |
| `vocals.ogg`, `vocals_1.ogg`, `vocals_2.ogg` | Lead vocals + harmonies |
| `crowd.ogg` | Crowd noise |

Both `.ogg`, `.opus`, and `.mp3` are supported.

## Controls

For each stem the mixer shows:

- **Mute** button — toggles silence
- **Solo** button — DAW-style: enabling solo on any stem mutes all non-solo stems
- **Volume slider** — per-stem gain (0–200%)
- **Level meter** — real-time peak meter

A **master volume** at the top sets the post-mix output level (also bound to the toolbar volume slider).

## Solo behavior

Holding `Alt` while clicking solo enables **exclusive solo** — turns off solo on any other stem in one click. Useful for quickly auditioning a single track.

## Persistence

Mute / solo / volume state is **session-only** — it doesn't get written to disk. This way you can audition a chart without permanently muting the kick.
