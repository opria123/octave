# Property Panel

The context-aware inspector on the right side of the editor.

## With nothing selected — Song metadata

Edit fields written to `song.ini` (and the chart header):

- Title, Artist, Album, Genre, Year
- Charter, Difficulty, Length
- Preview start time, Delay (audio offset)
- Album art picker

Below the metadata block is the **tempo events list** — every BPM and time-signature change in the song. Click any event to scrub the playhead to it; double-click to edit its value or position.

## With a single note selected

- **Pitch** (or lane index for 5-fret instruments)
- **Velocity** (drums, pro keys)
- **Length** in ticks (drag the right edge in the editor for visual editing)
- **Modifiers** — checkboxes for HOPO, Tap, Cymbal/Tom, Open/Kick, etc.
- **Phrase membership** — Star Power, Solo, drum fill

## With multiple notes selected

A reduced "common modifiers" form: only the modifiers that all selected notes share are shown as checked; mixed values display as indeterminate. Toggling applies to the whole selection.

## Vocals & lyrics

When the Vocals instrument is active, the Property Panel doubles as the lyric editor for the selected phrase. Use `Tab` to advance to the next syllable.
