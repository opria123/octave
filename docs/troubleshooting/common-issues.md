# Common Issues

## App won't launch

- **Windows**: SmartScreen blocked it. Click *More info → Run anyway*. (We're working on signing.)
- **macOS**: Right-click the app and choose *Open* the first time, then click *Open* in the Gatekeeper prompt.
- **Linux**: AppImage isn't executable. Run `chmod +x octave-*.AppImage`.

## Audio doesn't play

- Check the [Stems Mixer](/guide/stems-mixer) — is master volume up? Are all stems muted?
- Check *Settings → Audio → Output device* — pick the right OS device.
- Some `.opus` files with unusual containers fail to decode — re-encode to `.ogg` Vorbis as a workaround.

## Chart Preview is black / stuttery

- Try *Settings → Chart Preview → Static venue* (disables animated background).
- Lower *Gem quality* to **Low**.
- Update your GPU drivers — OCTAVE uses WebGL 2 via Three.js.

## Settings or hotkeys won't save

OCTAVE writes to its user-data folder; if that folder is read-only or full, saves fail silently. Check:

- Disk space
- Folder permissions on the [Settings file path](/reference/settings#settings-file-location)

## Can't see my song in the Project Explorer

The folder must contain `notes.mid` **or** `notes.chart`. Folders without either are skipped during the scan.

## Performance feels slow

- Close other Electron / Chromium-based apps (they share GPU memory).
- Lower the [Chart Preview](/guide/chart-preview) panel size by dragging the divider.
- In *Settings → Audio*, try increasing the buffer size if you hear crackling.

## Reporting a bug

- Open a [bug report](https://github.com/opria123/octave/issues/new?template=bug_report.md).
- Include: OS + version, OCTAVE version, steps to reproduce, and (if relevant) the most recent log file from `<user-data>/logs/`.
