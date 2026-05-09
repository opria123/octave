---
layout: home

hero:
  name: OCTAVE
  text: Chart editor for rhythm games.
  tagline: Author, edit, and auto-generate Clone Hero / YARG charts on the desktop. Built with Electron, React, and Three.js.
  image:
    src: /screenshots/editor-overview.png
    alt: OCTAVE editor showing the piano roll and 3D highway preview
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/opria123/octave

features:
  - icon: 🎼
    title: Multi-format authoring
    details: Read & write .mid (MIDI) and .chart (Clone Hero), with full round-trip preservation of metadata, tempo maps, and instrument data.
  - icon: 🎮
    title: 8 instruments
    details: Drums (Pro), Guitar / Bass / Keys (5-fret), Pro Keys (25-key MIDI), Pro Guitar / Bass (6-string), and pitched Vocals with HARM2 / HARM3 harmonies.
  - icon: 🛣️
    title: 3D highway preview
    details: YARG-compatible Three.js highway with animated playback, hit effects, and real venue support — exactly what your chart looks like in-game.
  - icon: 🤖
    title: Auto-Chart from audio
    details: Bundled STRUM pipeline turns any MP3 / YouTube URL / pre-split stems into a full chart package — drums, guitar, bass, keys, vocals & harmonies. Optional manual BPM override.
  - icon: 🎚️
    title: Stem mixer
    details: Per-stem mute, solo, and volume controls during playback. DAW-style exclusivity. Loads every stem in a song folder automatically.
  - icon: ⚡
    title: Fast feedback loop
    details: Per-song undo / redo, autosave with dirty-state tracking, multi-difficulty editing, and a configurable hotkey scheme.
---

<div style="display: flex; justify-content: center; margin-top: 32px;">
  <DownloadButton />
</div>

## What is OCTAVE?

**O**rchestrated **C**hart & **T**rack **A**uthoring **V**isual **E**ditor.

A desktop chart editor for rhythm games like [YARG](https://yarg.in) and Clone Hero — built for chart authors who want a fast 2D piano roll, an accurate 3D in-game preview, and an optional AI auto-charter that takes audio in and produces a full Clone Hero / YARG chart package out.

OCTAVE runs locally — your audio, your stems, and your charts never leave your machine.

## At a glance

![OCTAVE editor layout](/screenshots/editor-layout.png)

## Where to next?

- **New here?** Start with the [Getting Started guide](/guide/getting-started).
- **Want to auto-chart a song?** Jump to the [Auto-Chart guide](/guide/auto-chart).
- **Looking for a hotkey?** Check the [Keyboard Shortcuts reference](/reference/keyboard-shortcuts).
- **Something broken?** See [Troubleshooting](/troubleshooting/auto-chart-issues).
