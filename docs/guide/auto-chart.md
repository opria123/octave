# Auto-Chart <Badge type="warning" text="experimental" />

Generate a complete Clone Hero / YARG chart from an audio source — drums, guitar, bass, keys, vocals, and harmonies — using OCTAVE's bundled STRUM pipeline.

::: warning Experimental
The auto-charter is bundled but still evolving. Output quality varies by genre, and you'll usually want to clean the result up in the [MIDI Editor](/guide/midi-editor) before shipping. We mark it experimental so it's clear: this is a starting point, not a finished chart.
:::

## What it does

The Auto-Chart pipeline:
1. Splits your audio into stems (drums, bass, vocals, other) using [Demucs](https://github.com/adefossez/demucs).
2. Detects drum hits & maps them to the General-MIDI drum kit.
3. Estimates pitched notes for guitar/bass/keys using [basic-pitch](https://github.com/spotify/basic-pitch).
4. Transcribes vocal melody (and HARM2 / HARM3 harmonies if requested).
5. Detects tempo and downbeats — **or** uses a manual tempo map you provide.
6. Writes a complete song folder: `notes.mid`, per-stem `.ogg` files, and a `song.ini`.

## Quick start

1. Click the **Auto-Chart** button in the toolbar.
2. **Drop a file** (`.mp3` / `.wav` / `.flac` / `.ogg` / `.opus`) onto the modal — or paste a YouTube URL.
3. Click **Generate**.
4. Wait. Progress shows per-stage (split → drums → pitched → vocals → assembly).
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
