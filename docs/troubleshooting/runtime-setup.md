# Python Runtime Setup

The [Auto-Chart](/guide/auto-chart) feature requires Python. Editing charts does not — if you only edit, you can ignore this page.

## Managed runtime (packaged and fallback development builds)

OCTAVE provisions an isolated Python 3.12 runtime. The first time you click **Auto-Chart**, OCTAVE downloads:

- A standalone Python 3.12 build (~30 MB)
- The required ML model weights (~250 MB total: Demucs + basic-pitch + whisper)

These are cached locally and never re-downloaded:

| Platform | Cache path                                             |
| -------- | ------------------------------------------------------ |
| Windows  | `%APPDATA%\octave\python-runtime\`                     |
| macOS    | `~/Library/Application Support/octave/python-runtime\` |
| Linux    | `~/.config/octave/python-runtime\`                     |

**To wipe the runtime** (e.g. corrupted download): delete that folder. OCTAVE re-downloads on next run.

## Dev builds (running from source)

When you run `npm run dev`, OCTAVE first looks for an interpreter that already has STRUM's required packages:

1. `OCTAVE_STRUM_PYTHON` environment variable (absolute path to a `python.exe`)
2. Project-local `.venv\Scripts\python.exe` (Windows) / `.venv/bin/python` (Unix)
3. System `python3` / `python`
4. OCTAVE's isolated managed runtime

If none of the local candidates have the required packages, OCTAVE provisions
the same isolated runtime used by packaged builds. You do not need to install
STRUM packages into your system Python.

The recommended dev setup is a project-local virtualenv:

```bash
# from repo root
python3.11 -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS / Linux
pip install -r resources/strum/requirements.txt
```

Then just run `npm run dev` — OCTAVE picks up `.venv` automatically.

## Custom Python interpreter

In _Settings → Auto-Chart → Custom Python interpreter_, point to any Python binary that has `resources/strum/requirements.txt` installed. This sets `OCTAVE_STRUM_PYTHON` for you. If it is missing the STRUM packages, OCTAVE safely falls back to its isolated runtime instead of modifying that interpreter.

## GPU acceleration

The bundled runtime detects:

- **CUDA** on Windows / Linux (NVIDIA only) — set automatically if `nvidia-smi` is on `PATH`.
- **Metal** on macOS — used automatically.
- **CPU fallback** — always available; slower but works on every machine.

To force CPU even when a GPU is available, tick _Settings → Auto-Chart → Force CPU_.
