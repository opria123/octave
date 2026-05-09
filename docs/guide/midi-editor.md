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

> **Tip:** Use *Generate from Expert* in the toolbar overflow to bootstrap lower difficulties from your Expert chart, then tweak.

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

For 5-fret instruments, the **Swap Lanes** popover (toolbar overflow) mirrors the chart left-to-right — useful when adapting a chart to a southpaw layout.
