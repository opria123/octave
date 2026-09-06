# Auto-Chart — Advanced Options

The Auto-Chart dialog contains controls from OCTAVE's transitional inference adapter. **Validated STRUM profiles use their own declared input, instrument, and difficulty contracts.** The advanced controls do not override those contracts.

For setup, approved-library training, supported fine-tuning, and profile promotion, follow the [STRUM training tutorial](/guide/strum-training).

![Auto-Chart Advanced section — compatibility controls](/screenshots/auto-chart-advanced.png)

## Validated profiles

A selected profile is preflighted and executed through STRUM's typed worker commands. OCTAVE verifies the profile and bundle identity, the declared difficulty policy, and the resulting artifact hashes.

- Audio profiles accept one local audio file or one supported HTTPS URL through the current host interface.
- Learned transforms use **Training → Deploy → Transform MIDI** with an Expert source MIDI chart. Supply aligned audio when the profile requires it.
- Track toggles, manual BPM, tempo-map controls, and legacy metadata options are not passed as arbitrary overrides to this typed execution path.
- Cancellation terminates the worker process tree. During Transform MIDI input selection, cancellation stops subsequent dialogs when the active dialog returns.

A raw training checkpoint cannot become executable simply by choosing more tracks or changing a difficulty option. Its STRUM evaluation and packaging gates must pass first.

## Legacy track selection

In development builds using the older inference adapter, track controls can request drums, guitar, bass, keys, vocals, and optional harmonies. Actual stages depend on that adapter's installed dependencies and models. These controls do not establish that every track has a trained, evaluated, deployable profile.

Folder and pre-split-stem inputs also belong to this legacy path. A packaged build without a validated default profile does not enter the legacy fallback.

## Legacy BPM and tempo-map controls

The older adapter can accept a manual BPM or tempo-map override. Use these when working through that compatibility path and inspect the result against the audio. They do not modify the timing or decoder policy of a validated trained profile.

For an existing chart, tempo editing remains available in the editor independently of STRUM training or inference.

## Online lookup toggle

**Offline mode (disable online lookups)** disables the older adapter's MusicBrainz, album-art, and lyric searches. It is useful when those searches would misidentify a source.

It does **not** disable all network activity: URL inputs still need acquisition, and the legacy runtime or models may need downloading. For local operation without downloads, use local inputs and provision a compatible runtime, profile, and required companions beforehand. Do not treat the lookup checkbox as a network-isolation control.

## Output structure

Typed profile runs produce chart artifacts, with generated provenance retained by OCTAVE:

```text
selected-output/
├── notes.mid
├── run.json          # Profile identity and artifact evidence
└── song.ini          # Generated provenance; not automatic training opt-in
```

**Transform MIDI** creates a new `strum-transform-<run ID>` directory inside the output folder you select. Review the MIDI and provide the audio and metadata required by your game/library workflow before distribution.

The legacy adapter can assemble a fuller song directory, including audio stems and metadata. That historical output format should not be used to infer what a current typed profile will generate. Neither path guarantees release-quality charts without review.

## Performance and diagnostics

Use a device supported by the selected STRUM runtime and profile. GPU availability depends on the installed PyTorch build and hardware; there is no universal acceleration guarantee across platforms. The training UI exposes only options advertised by the worker.

Legacy inference writes run logs beneath OCTAVE's application-data directory at `logs/strum/<timestamp>_<run ID>.log`. Use the app's log-folder action to find the actual location. These diagnostic logs can include local locations or remote input details; inspect them before sharing. Training retains job history and sanitized UI errors. Typed profile runs also return sanitized errors; they do not promise the same legacy log layout.

## Next

- [STRUM training tutorial](/guide/strum-training)
- [Auto-Chart workflow](/guide/auto-chart)
- [MIDI editing and local difficulty reduction](/guide/midi-editor)
