# MIDI Editor

OCTAVE's central piano-roll surface. The editor is canvas-based for fluid scroll/zoom, and supports per-instrument lane layouts.

## Tools

| Hotkey | Tool       | Behavior                                                                                          |
| ------ | ---------- | ------------------------------------------------------------------------------------------------- |
| `1`    | **Select** | Click to select notes; drag to box-select; drag a selected note's right edge to extend a sustain. |
| `2`    | **Place**  | Click empty space to drop a new note at the snap position.                                        |
| `3`    | **Erase**  | Click a note (or drag through several) to delete.                                                 |

You can switch tools at any time. Holding `Shift` while clicking with the Select tool adds to the current selection; holding `Ctrl`/`Cmd` toggles individual notes.

## Snap

The toolbar dropdown sets the snap division — `1/4` through `1/64` of a beat. Snap affects:

- Where the Place tool drops new notes
- Where dragged notes land
- The grid overlay density

## Modifiers

Modifier toggles appear in the toolbar; clicking applies to **all selected notes**. Hotkeys for toggles:

| Hotkey | Modifier           | Notes                                              |
| ------ | ------------------ | -------------------------------------------------- |
| `S`    | Star Power phrase  | Adds the selection to a star power phrase          |
| `G`    | Solo phrase        | Marks a solo section                               |
| `F`    | Force HOPO / Strum | Toggles between HOPO and strum on guitar/bass/keys |
| `O`    | Open / Kick        | 5-fret guitar open notes; drums kick               |
| `P`    | Tap                | 5-fret tap modifier                                |
| `L`    | Sustain release    | Removes the sustain                                |
| `T`    | Tom (drums)        | Toggles cymbal vs. tom on yellow / blue / green    |

See the [Keyboard Shortcuts reference](/reference/keyboard-shortcuts) for the full list.

## Multi-difficulty editing

The difficulty tabs above the lanes let you author Expert / Hard / Medium / Easy independently. The active difficulty is what's edited and displayed in the [Chart Preview](/guide/chart-preview).

Generated charts contain only the difficulties provided by the selected [Auto-Chart](/guide/auto-chart) profile. Expert-only profiles do not fill all four tabs. You can author missing difficulties manually, use **Generate from Expert** for local rule-based reduction, or run a validated learned transform through the [STRUM training workflow](/guide/strum-training).

> **Note:** Copy / paste keeps each note on the difficulty it was copied from. Pasting Expert notes while a lower difficulty tab is active adds them back to Expert, not to the tab you're viewing.

### Generate from Expert

The **Generate from Expert** button in the piano-roll toolbar derives Hard / Medium / Easy from your Expert chart using local deterministic editing rules. Tick the instruments and difficulties you want, then hit Generate. This works without a STRUM runtime and does not invoke a trained profile, perform fine-tuning, or substitute for a learned transform's quality gate.

It covers drums, guitar, bass, keys, Pro Keys and Pro Guitar / Bass. Vocals are absent because CH / RB have no per-difficulty vocal charts. An instrument with no Expert notes is skipped rather than blanked.

What the rules do, broadly:

| Instrument        | Hard                                                       | Medium                                                                      | Easy                                                     |
| ----------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| Drums             | Drops ghost notes and very fast repeats, thins busy hi-hat | Kick to a basic pulse (no double kick), hi-hat halved, toms only on accents | Kick and snare only, very sparse                         |
| Guitar / Bass     | Thins dense runs, caps frets at blue, no taps              | No 3-note chords, thins harder, strum-only                                  | Single notes, capped at yellow, sparsest                 |
| Keys / Pro Keys   | Drops every 4th note                                       | Every other note, voicings cut to two                                       | Every 3rd note, one voice per onset                      |
| Pro Guitar / Bass | Voicings capped at four strings                            | Capped at two strings                                                       | Single low string per onset — frets are never transposed |

Two things worth knowing before you run it:

- **It replaces, it doesn't merge.** Any hand-authored work on the difficulties you tick is discarded for the instruments you tick. The popover tells you how many notes that is before you commit, and `Ctrl/Cmd+Z` puts them back in one step.
- **Reduction is gap-based, so slow songs reduce less.** The thresholds are in milliseconds, not beats. On a sparse or slow chart, Hard can come out identical to Expert simply because no passage is dense enough to thin. Treat the output as a starting point to tweak, not a finished chart.

## Copy / paste & undo

- `Ctrl/Cmd+C` / `Ctrl/Cmd+V` — copy / paste preserves relative timing
- `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` — undo / redo (per-song history)
- `Delete` — remove selection

## Per-instrument lanes

| Instrument           | Lanes                                                |
| -------------------- | ---------------------------------------------------- |
| Drums                | Kick, Red, Yellow (cymbal/tom), Blue, Green, 2x kick |
| Guitar / Bass / Keys | Open, Green, Red, Yellow, Blue, Orange               |
| Pro Keys             | Full 25-key MIDI range                               |
| Pro Guitar / Bass    | 6 strings × frets, plus chord modifier               |
| Vocals               | Pitched melody + HARM2 / HARM3 harmonies             |

## Lane swap

The **Swap Lanes** button in the piano-roll toolbar opens a popover where you pick an instrument and two of its lanes, then swap every note between them. It covers guitar / bass / keys (open, green, red, yellow, blue, orange), drums (kick, snare, and the tom / cymbal variants) and Pro Guitar / Pro Bass strings 1–6; Pro Keys and vocals aren't supported.

The **All difficulties** checkbox is ticked by default, so the swap applies to every difficulty. Untick it to limit the swap to the difficulty you're currently editing.

## Editing and training inclusion

Editing a chart does not automatically opt it into training. Reviewed human-authored library charts can be explicitly included through the [STRUM training tutorial](/guide/strum-training). Recognized STRUM-generated charts remain excluded even after ordinary edits or an opt-in metadata change: OCTAVE does not yet verify a meaningful correction against a preserved generated baseline. See the [generated chart admission contract](/reference/song-source-catalog#generated-chart-admission).
