# Saving & Exporting

OCTAVE always edits in-place — there's no separate "import / export" step for the standard chart formats.

## Save (`Ctrl/Cmd+S`)

Writes the current song to disk:

- `notes.mid` — full multi-instrument MIDI
- `notes.chart` — Clone Hero `.chart` (if the song was originally a `.chart`)
- `song.ini` — metadata
- Your audio stems are **not** rewritten by save — they were never modified.

If [Autosave](/guide/project-explorer#autosave) is enabled, manual save is rarely needed.

## Save As

*File → Save As…* writes the song to a new folder, leaving the original untouched. Useful for branching ideas without risking your main version.

## Export

*File → Export* packages the current song for a target game:

| Format | What you get |
|--------|--------------|
| **Clone Hero (.sng)** | A single encrypted `.sng` archive with the chart, audio stems, art and metadata |
| **Clone Hero (.chart folder)** | A song folder with a plain-text `notes.chart`, `song.ini`, audio stems and art — works in Clone Hero, YARG and Moonscraper. MIDI-sourced songs are converted on the fly |
| **Rock Band 3 (RB3con)** | An Xbox 360 STFS CON package with MIDI chart, MOGG stems and catalog metadata |

Exports never modify the source song folder. Tick *Save song edits before exporting* to flush unsaved changes first.

## What gets written

Saving always writes a YARG/Clone Hero–compatible folder structure:

```text
My Song - Artist/
├── notes.mid
├── song.ini
├── album.png       # if you set album art in the Property Panel
├── drums.ogg       # original stems, untouched
├── bass.ogg
├── vocals.ogg
└── song.ogg
```

> Your audio stems are never re-encoded by save — only the chart and metadata change.
