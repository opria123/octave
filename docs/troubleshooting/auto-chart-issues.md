# Auto-Chart Issues

Common problems with the [Auto-Chart](/guide/auto-chart) pipeline and how to fix them.

## "Failed to load basic-pitch SavedModel"

Symptom — the run fails during the *pitched* (guitar / bass / keys) stage with a TensorFlow / SavedModel load error.

**Root cause:** stale `site-packages` from a different Python version (typically a Python 3.10 install left over from an old build) is shadowing the bundled 3.11 runtime.

**Fix in dev builds:**
1. Delete the project-local `.venv` (if present) and let OCTAVE recreate it on next run, or
2. Set `OCTAVE_STRUM_PYTHON` to the absolute path of a clean Python 3.11 with `basic-pitch` installed.

**Fix in packaged builds:**
1. Delete the cached runtime: see [Python Runtime Setup](/troubleshooting/runtime-setup) for paths.
2. Re-launch OCTAVE and run Auto-Chart — the runtime is re-downloaded fresh.

The diagnostic line `[strum] basic_pitch failed to load: <details>` appears in the log to make this easier to identify.

## `convert_to_ogg() got an unexpected keyword argument …`

This was a known issue fixed in `v0.0.101`. Update to the latest release; the override now forwards `*args, **kwargs` so it tracks upstream.

## Demucs runs out of memory

Demucs needs ~4 GB of free RAM for stem separation. If your machine doesn't have it:
- Tick **Force CPU** in Settings — uses less GPU memory but takes longer.
- Provide pre-split stems instead and let OCTAVE skip Demucs entirely.

## YouTube URL fails

`yt-dlp` rejects the URL. Common causes:
- Age-restricted or region-locked video — try downloading the audio yourself and passing the file in.
- `yt-dlp` cache out of date — delete `<user-data>/python-runtime/yt-dlp-cache/`.
- No internet (offline mode is on but you didn't pre-download the audio).

## "All tracks were skipped"

You unchecked every instrument in the Advanced section. Check at least one and try again.

## My drums chart is empty

If the **Drums** instrument is checked but no drum notes appear:
- Confirm the source audio actually has drums (a cappella tracks, instrumentals without a drum kit, etc. won't produce output).
- Check the log for `[strum] drum onset count: 0`.
- Try a song with louder, sharper transients to confirm the pipeline works on your machine.

## Where to find logs

| Platform | Path |
|----------|------|
| Windows | `%APPDATA%\octave\logs\strum-*.log` |
| macOS | `~/Library/Logs/octave/strum-*.log` |
| Linux | `~/.config/octave/logs/strum-*.log` |

Attach the most recent log to any [bug report](https://github.com/opria123/octave/issues/new?template=bug_report.md).
