# Timeline & Venue Editor

OCTAVE's bottom panel has two views: the **MIDI Editor** (notes per instrument) and the **Timeline Editor** — a tick-accurate timeline for everything that *isn't* a note: background video, secondary audio, and the full YARG / RB3 venue track.

Switch with the tab toggle in the bottom panel header, or with the keyboard shortcut for the Timeline view (see [Keyboard Shortcuts](/reference/keyboard-shortcuts)).

## What the timeline holds

| Track | What it controls |
|-------|------------------|
| **Background video** | One or more video clips that play behind the highway during preview, with per-clip offset and trim. |
| **Secondary audio** | Extra audio clips layered on top of the song stems (commentary, alternate masters, etc.). |
| **Venue → Lighting** | Keyframed and automatic lighting cues — `verse`, `chorus`, `strobe_fast`, `searchlights`, `blackout_fast`, etc. |
| **Venue → Post-processing** | Per-section camera filters — `bloom.pp`, `film_b+w.pp`, `video_trails.pp`, `photo_negative.pp`, etc. |
| **Venue → Camera cuts** | Directed and co-op camera shots — guitarist close, bassist focus, drummer wide, crowd, etc. |
| **Venue → Stage** | Stage effects like `FogOn` / `FogOff` and bonus FX. |
| **Venue → Performer** | Per-character animation states (sing, play solo, intense, mellow, etc.). |

All five venue sub-tracks are written into the same `VENUE` MIDI track that YARG and Clone Hero already read. No proprietary format.

## Editing venue events

- **Add an event:** click the empty area on a venue lane at the desired tick.
- **Pick a preset:** the inline dropdown shows the full RB3 / YARG cue list for that lane (lighting cues, post-processing effects, camera shots, stage / performer events).
- **Move an event:** drag horizontally. Snaps to the active grid division.
- **Delete:** select and press `Delete` / `Backspace`.
- **Multi-select:** `Shift+click` or drag a selection box across lanes.

The 3D [Chart Preview](/guide/chart-preview) reflects every venue event live — scrub the timeline and you'll see the lighting cue or camera cut land at exactly that tick. The highway camera itself is fixed; venue camera cuts only re-light the scene and re-frame the venue, never the lanes.

## Background video

Drop a video file onto the **Video** track, then trim and offset it.

- **Per-clip offset (ms)** — shift this clip's playback relative to the song.
- **Project-wide offset** — global delay applied to all video clips.
- **Trim in / out** — the visible portion of the clip.

The video plays behind the 3D highway in the preview, exactly the way YARG renders venue background video.

## Secondary audio

The Audio track behaves like the Video track but for audio. Useful for layering instructional voiceover, demo clicks, or alternate tempo / pitch reference tracks during charting. Secondary audio is **not** baked into the exported chart — only the main song stems are.

## Venue track export

When you save, OCTAVE writes the venue track back into `notes.mid` using the YARG-compatible event encoding. Open the same chart in YARG or Clone Hero and the venue plays exactly as you authored it.

If you don't want to author venue events, leave the lanes empty — the export will just omit the `VENUE` track and the games fall back to their default lighting.
