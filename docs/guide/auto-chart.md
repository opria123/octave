# Auto-Chart <Badge type="warning" text="experimental" />

OCTAVE can run a **validated STRUM chart profile** locally, then open the output for editing. The selected profile determines its instruments, input requirements, and difficulty policy. It does not automatically provide every instrument or all four difficulties.

::: warning Experimental
Generated charts need review. A completed training run is a candidate, not a deployable model; packaging and profile validation must pass before you can select it as a default. A passing synthetic test demonstrates software execution, not musical quality.
:::

## Choose the right workflow

| Goal                                              | Workflow                                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Generate a chart from audio                       | Select a compatible validated audio-to-chart profile in **Training → Deploy**, then use **Auto-Chart**.                                                |
| Apply a learned lower-difficulty transform        | Select a validated learned transform in **Training → Deploy**, then use **Transform MIDI** with an Expert source chart and any required aligned audio. |
| Train or fine-tune using approved library charts  | Follow the [STRUM training tutorial](/guide/strum-training). Training and deployment are separate decisions.                                           |
| Derive lower difficulties with local editor rules | Use [Generate from Expert](/guide/midi-editor#generate-from-expert). This editing tool does not train or invoke a learned profile.                     |

STRUM is developed in its own [repository](https://github.com/opria123/strum). OCTAVE's training integration invokes its versioned `strum-worker` interface. The older `resources/strum/strum_worker.py` is a transitional inference adapter, not the standalone training interface or a promise of universal chart coverage.

## Run a validated audio profile

![Auto-Chart modal](/screenshots/auto-chart-modal.png)

1. Configure a compatible local STRUM runtime and discover a model bundle in **Training → Deploy**. See the [training tutorial](/guide/strum-training) for setup and profile selection.
2. Inspect the profile's executable capability and difficulty policy, then explicitly select it as the default.
3. Open **Auto-Chart** and provide **one local audio file** or a supported **HTTPS URL**. URL audio is acquired privately through `yt-dlp` before the typed chart run.
4. Choose an output location and start the run. OCTAVE preflights the selected profile and verifies the returned chart artifacts.
5. Open the output and review it in the [MIDI Editor](/guide/midi-editor). Add any audio and song metadata needed for your distribution format.

Typed audio profiles do not currently accept batches, folders, or stem-folder inputs through this host path. A learned difficulty transform requires source MIDI and must use **Transform MIDI** in Deploy; an audio file alone cannot replace that input.

The profile's declared difficulty policy remains authoritative. Expert profiles produce Expert output unless an explicitly validated alternative is available. OCTAVE does not silently fill missing difficulties or swap in another model.

## Output and availability

A typed run produces `notes.mid` and `run.json`; OCTAVE preserves generated provenance in `song.ini`. This is not a guarantee of a complete song package with separated audio, lyrics, harmonies, and every instrument. Consult the [advanced guide](/guide/auto-chart-advanced) for the distinction from older inference output.

Packaged OCTAVE builds fail closed when no verified profile is selected. They do not fall back to downloading a mutable STRUM checkout. The current installer does not provide a verified universal training runtime or production model for every instrument. Use an explicitly selected compatible installed worker, or a developer checkout when running a development build; see [runtime setup in the tutorial](/guide/strum-training).

## Transitional inference controls

Development builds retain the older inference adapter. Its folder/stem input modes, separation stages, track toggles, tempo overrides, and song-folder assembly belong to that compatibility path. Their presence in the Auto-Chart dialog does not expand a validated profile's capabilities, and the legacy fallback is unavailable in packaged builds.

Processing runs locally. Remote inputs, dependency/model acquisition in the legacy path, and optional online lookups can still require network access. The dialog's lookup toggle is not a guarantee of zero network activity.

## Next

- [Train and use a STRUM profile →](/guide/strum-training)
- [Advanced options and compatibility behavior →](/guide/auto-chart-advanced)
- [Auto-Chart troubleshooting →](/troubleshooting/auto-chart-issues)
- [STRUM on GitHub ↗](https://github.com/opria123/strum)
