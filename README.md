# OCTAVE

**Orchestrated Chart & Track Authoring Visual Editor**

A desktop chart editor for rhythm games like [YARG](https://yarg.in) and Clone Hero. Built with Electron, React, Three.js, and Zustand.

## Features

### Multi-Format Support
- Import & export `.mid` (MIDI) and `.chart` (Clone Hero) files
- YARG-compliant sustain threshold handling (format-aware)
- Reads `song.ini` metadata

### 8 Instruments
- **Drums** — Pro Drums with cymbal/tom distinction
- **Guitar / Bass / Keys** — 5-fret charting
- **Vocals** — Pitched lyrics with 3 harmony parts, percussion, slides
- **Pro Keys** — Full MIDI range (C3–C5, 25 keys)
- **Pro Guitar / Pro Bass** — 6-string, frets 0–22

### Dual Editor Views
- **2D Piano Roll** — Canvas-based multi-lane MIDI editor with per-instrument tracks, beat grid, and snap quantization
- **3D Highway Preview** — Real-time Three.js highway with YARG-compatible note models, animated playback, hit effects, and strikeline visualization

### Editing Tools
- Select, Place, Erase tools (keyboard shortcuts `1` / `2` / `3`)
- Note modifiers: Cymbal/Tap, Ghost/HOPO, Accent, Open, Kick
- Star Power and Solo section authoring
- Sustain drag-to-resize handles
- Copy / Paste / Cut (`Ctrl+C` / `Ctrl+V`)
- Undo / Redo (`Ctrl+Z` / `Ctrl+Shift+Z`) — per-song scoped history
- Adjustable snap division (1/4 through 1/64 notes)
- Multi-difficulty editing (Expert, Hard, Medium, Easy)

### Audio & Playback
- Multi-stem audio mixing (loads all stems in a song folder)
- Variable playback speed
- Tempo-aware tick/time conversion with full tempo map support

### Project Management
- Multi-song project browser with album art thumbnails
- Autosave with configurable interval
- Dirty-state tracking
- Song metadata and tempo/time signature editing

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- npm

### Install

```bash
npm install
```

### Development

```bash
npm run dev
```

### Build

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Shell | Electron |
| Build Tool | electron-vite |
| UI Framework | React 19 + TypeScript |
| State Management | Zustand + Zundo (undo/redo) |
| 3D Rendering | Three.js via React Three Fiber |
| Audio | Web Audio API |
| MIDI Parsing | @tonejs/midi |
| Audio Processing | FFmpeg (via fluent-ffmpeg) |

## Project Structure

```
src/
├── main/           # Electron main process
├── preload/        # Preload scripts (IPC bridge)
└── renderer/
    └── src/
        ├── components/          # React components
        │   ├── MidiEditor.tsx   # 2D piano roll editor
        │   ├── ChartPreview.tsx # 3D highway preview
        │   └── chartPreviewModules/  # 3D scene modules
        ├── stores/              # Zustand state stores
        ├── services/            # Audio service
        ├── utils/               # Parsers, helpers
        └── types/               # TypeScript types & constants
```

## License

MIT
