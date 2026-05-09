# Auto-Chart <Badge type="warning" text="experimental" />

Generate a complete Clone Hero / YARG chart from an audio source — drums, guitar, bass, keys, vocals, and harmonies — using OCTAVE's bundled **STRUM** pipeline.

::: warning Experimental
The auto-charter is bundled but still evolving. Output quality varies by genre, and you'll usually want to clean the result up in the [MIDI Editor](/guide/midi-editor) before shipping. We mark it experimental so it's clear: this is a starting point, not a finished chart.
:::

## STRUM

**STRUM** (Stem-aware Transcription, Rhythm & Universal Mapping) is the open-source audio-to-chart engine that powers Auto-Chart. It lives in its own repository at [github.com/opria123/strum](https://github.com/opria123/strum) and is bundled with OCTAVE under [`resources/strum/`](https://github.com/opria123/octave/tree/master/resources/strum). It runs locally — no cloud, no upload.

What STRUM does, in order:

1. **Stem split** with [Demucs](https://github.com/adefossez/demucs) — drums, bass, vocals, other (skipped if you provide pre-split stems).
2. **Drum onset detection + classification** — kick, snare, toms, hi-hat, crash, ride mapped to General-MIDI.
3. **Polyphonic transcription** of guitar / bass / keys via [basic-pitch](https://github.com/spotify/basic-pitch).
4. **Vocal melody + lyric alignment** — pitched lead with optional HARM2 / HARM3 harmonies.
5. **Tempo & downbeat detection** (or use a manual tempo map you provide).
6. **Assembly** into a complete song folder: `notes.mid`, per-stem `.ogg` files, and a `song.ini`.

You can run STRUM standalone from the command line using the same `strum_worker.py` OCTAVE invokes — see the [advanced flags](/guide/auto-chart-advanced) for the env vars and overrides.

## Quick start

![Auto-Chart modal](/screenshots/auto-chart-modal.png)

1. Click the **Auto-Chart** button in the toolbar.
2. **Add files**, point at folders, or paste a URL — the modal has tabs for each.
3. Click **Start Auto-Chart**.
4. Wait. Progress shows per-stage (bootstrap → split → drums → pitched → vocals → assembly).
5. The new song folder appears in your [Project Explorer](/guide/project-explorer).

That's it for the basic flow. The advanced section covers everything else.

## Input modes

| Mode | What to provide |
|------|----------------|
| **Single file** | Any audio file. Demucs will split it into stems. |
| **Pre-split stems folder** | A folder with `drums.wav`, `bass.wav`, `vocals.wav`, `other.wav`. Skips Demucs (much faster). |
| **YouTube URL** | The audio is downloaded with `yt-dlp` and processed as a single file. |

## Bundled Python runtime

OCTAVE ships with its own Python 3.11 runtime in packaged builds — you don't need to install Python yourself. The runtime is downloaded the first time you click **Auto-Chart** (about 250 MB) and cached in:

- **Windows**: `%APPDATA%/octave/python-runtime/`
- **macOS**: `~/Library/Application Support/octave/python-runtime/`
- **Linux**: `~/.config/octave/python-runtime/`

In dev builds, OCTAVE prefers a project-local `.venv\Scripts\python.exe` if it exists. See [Python Runtime Setup](/troubleshooting/runtime-setup) for details.

## Next

- [Advanced options →](/guide/auto-chart-advanced) — track gating, manual BPM, tempo maps, harmonies, offline mode
- [Auto-Chart troubleshooting →](/troubleshooting/auto-chart-issues)
- [STRUM on GitHub ↗](https://github.com/opria123/strum) — source, issues, and standalone CLI usage
