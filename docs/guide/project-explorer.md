# Project Explorer

The left-hand panel listing all songs in the currently-open project folder.

## Opening a project

- **File → Open Folder** (`Ctrl/Cmd+O`) — pick any directory containing one or more song subfolders.
- **Drag a folder** onto the OCTAVE window.

A "song folder" is any directory with a `notes.mid` or `notes.chart` plus audio. OCTAVE scans recursively and indexes everything it finds.

## Song entries

Each entry shows:
- **Album art thumbnail** (from `album.png` / `album.jpg` in the folder, falling back to a placeholder)
- **Title** and **artist** (from `song.ini` or chart metadata)
- **Charter** initials (small badge)
- **Dirty-state dot** — a small accent-colored dot to the left of the title indicates unsaved changes

Click a song to load it. If the previously-loaded song has unsaved changes, you'll be prompted to save or discard.

## Right-click actions

- **Reveal in folder** — opens the song's folder in your OS file manager
- **Rename** — renames the folder (and updates `song.ini` if present)
- **Duplicate** — copies the song to a new folder for safe experimentation
- **Remove from project** — removes from the list (does **not** delete files)

## Multi-project workflow

OCTAVE remembers the last opened folder. To switch:
- *File → Open Recent* lists your recent project folders
- *File → Open Folder* picks a new one (replaces the current view)

> Tip: Keep your in-progress charts in a single "WIP" folder so the Project Explorer becomes your daily song browser.

## Autosave

If *Settings → Autosave* is enabled (default: on), OCTAVE writes changes automatically:
- After 10 seconds of editor inactivity
- Before switching songs
- Before closing the app

Autosave only writes the active song — it never touches other songs in the project.
