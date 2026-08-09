# MIDI Editor

OCTAVE's central piano-roll surface. The editor is canvas-based for fluid scroll/zoom, and supports per-instrument lane layouts.

## Tools

| Hotkey | Tool | Behavior |
|--------|------|----------|
| `1` | **Select** | Click to select notes; drag to box-select; drag a selected note's right edge to extend a sustain. |
| `2` | **Place** | Click empty space to drop a new note at the snap position. |
| `3` | **Erase** | Click a note (or drag through several) to delete. |

You can switch tools at any time. Holding `Shift` while clicking with the Select tool adds to the current selection; holding `Ctrl`/`Cmd` toggles individual notes.

## Snap

The toolbar dropdown sets the snap division — `1/4` through `1/64` of a beat. Snap affects:
- Where the Place tool drops new notes
- Where dragged notes land
- The grid overlay density

## Modifiers

Modifier toggles appear in the toolbar; clicking applies to **all selected notes**. Hotkeys for toggles:

| Hotkey | Modifier | Notes |
|--------|----------|-------|
| `S` | Star Power phrase | Adds the selection to a star power phrase |
| `G` | Solo phrase | Marks a solo section |
| `F` | Force HOPO / Strum | Toggles between HOPO and strum on guitar/bass/keys |
| `O` | Open / Kick | 5-fret guitar open notes; drums kick |
| `P` | Tap | 5-fret tap modifier |
| `L` | Sustain release | Removes the sustain |
| `T` | Tom (drums) | Toggles cymbal vs. tom on yellow / blue / green |

See the [Keyboard Shortcuts reference](/reference/keyboard-shortcuts) for the full list.

## Multi-difficulty editing

The difficulty tabs above the lanes let you author Expert / Hard / Medium / Easy independently. The active difficulty is what's edited and displayed in the [Chart Preview](/guide/chart-preview).

Each difficulty is charted by hand — OCTAVE has no automatic difficulty reduction, so there is no one-click way to derive Hard / Medium / Easy from your Expert chart.

> **Note:** Copy / paste keeps each note on the difficulty it was copied from. Pasting Expert notes while a lower difficulty tab is active adds them back to Expert, not to the tab you're viewing.

## Copy / paste & undo

- `Ctrl/Cmd+C` / `Ctrl/Cmd+V` — copy / paste preserves relative timing
- `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` — undo / redo (per-song history)
- `Delete` — remove selection

## Per-instrument lanes

| Instrument | Lanes |
|------------|-------|
| Drums | Kick, Red, Yellow (cymbal/tom), Blue, Green, 2x kick |
| Guitar / Bass / Keys | Open, Green, Red, Yellow, Blue, Orange |
| Pro Keys | Full 25-key MIDI range |
| Pro Guitar / Bass | 6 strings × frets, plus chord modifier |
| Vocals | Pitched melody + HARM2 / HARM3 harmonies |

## Lane swap

The **Swap Lanes** button in the editor toolbar opens a popover where you pick an instrument and two of its lanes, then swap every note between them. It covers guitar / bass / keys (open, green, red, yellow, blue, orange), drums (kick, snare, and the tom / cymbal variants) and Pro Guitar / Pro Bass strings 1–6; Pro Keys and vocals aren't supported.

The **All difficulties** checkbox is ticked by default, so the swap applies to every difficulty. Untick it to limit the swap to the difficulty you're currently editing.
