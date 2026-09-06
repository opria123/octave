# Song Source Catalog

`octave-song-source-catalog/v1` is OCTAVE's canonical, local-first intake
format for chart sources. It is the boundary between package import and model
training: import adapters understand `.sng`, `.con`/`.rb3con`, ZIP archives,
and song folders; STRUM consumes normalized catalog records and never parses
those containers directly.

The normative schema is [song-source-catalog.schema.json](./song-source-catalog.schema.json).

## Layout

```text
my-catalog/
├── catalog.json             # `octave-song-source-catalog/v1` manifest
├── records.jsonl            # one validated source record per song
├── vocal-harmony-sources.json # optional HARM1/2/3 source-policy sidecar
└── assets/
    └── sha256/<hash>/...    # OCTAVE-managed materialized MIDI/audio assets
```

`catalog.json.records` is a relative JSONL path. `catalog.json.curation` records
the catalog-wide provenance and license/permission basis selected in OCTAVE, so
the catalog editor can restore them without inferring state from a song record.
A catalog record contains a
stable `source_id`, content hashes, normalized metadata, chart coverage, a
rights decision, and references only to materialized assets under `assets/`.
It never contains the original package path, SMB path, URL, user home path, or
raw parser error.

```json
{
  "source_id": "octave-src-4fa0a8d2",
  "import": {
    "kind": "sng",
    "adapter_version": "octave-sng/1",
    "container_sha256": "…",
    "warnings": [{ "code": "missing_optional_artwork" }]
  },
  "rights": {
    "training_use": "allowed",
    "provenance": "Reviewed local collection",
    "license": "Permission recorded by catalog owner"
  },
  "chart": {
    "notes_midi": {
      "asset_id": "sha256:…",
      "sha256": "…",
      "relative_path": "assets/sha256/…/notes.mid",
      "byte_length": 12345,
      "media_type": "audio/midi"
    },
    "instruments": {
      "guitar": {
        "status": "present",
        "difficulties": ["easy", "medium", "hard", "expert"],
        "track_names": ["PART GUITAR"]
      }
    }
  }
}
```

## Ownership boundary

### OCTAVE owns

- Adapter selection, archive parsing, safe extraction, and import warnings.
- Metadata normalization, MIDI validation, instrument/difficulty discovery,
  hashing, duplicate handling, and catalog materialization.
- The user-facing curation gate. A source may be unselected or need explicit
  consent in the UI, but every record that reaches a catalog has already been
  approved and is written as `training_use: allowed`.
- Private original-location bookkeeping, if needed for refresh or reveal in
  the file browser. That resolver is a local OCTAVE sidecar and is neither a
  catalog asset nor a training artifact.

### STRUM owns

- Reading allowed catalog records and creating task-specific views.
- Converting catalog chart/audio assets into model examples, windows, tokens,
  targets, splits, and evaluation manifests.
- Recording catalog `source_id`s and input hashes in experiment metadata.
- Rejecting records with missing assets, hash mismatches, or a training right
  other than `allowed`.

STRUM must not infer rights, persist source locations, or add SNG/RB3CON/ZIP
parsers. OCTAVE must not encode STRUM model tokens or prescribe a model
architecture.

## Task views, not new source formats

One catalog can produce many STRUM datasets without duplicating source
metadata:

| STRUM task           | Catalog inputs                      | Derived view                           |
| -------------------- | ----------------------------------- | -------------------------------------- |
| Audio to chart       | `audio` + `chart.notes_midi`        | instrument-specific onset/lane targets |
| Difficulty transform | `chart.notes_midi`                  | source/target difficulty event pairs   |
| Vocal model          | `chart.notes_midi` + `audio.vocals` | phrase, lyric, and pitch targets       |
| Pro instrument model | `chart.notes_midi` + stem/mix       | string/fret or chromatic-key targets   |

Views contain `source_id`, selected asset hashes, view-builder version, and
their own split assignment. They do not copy rights text or absolute paths.

## Mandatory safety validation

Schema validation is necessary but not sufficient. The catalog service must
perform these semantic checks before writing a record or returning a UI result:

- Run `redactLocationText` on every metadata, provenance, license, warning,
  log, and error value that crosses an import boundary. It replaces filesystem
  locations and URLs with `[redacted]`, removes control characters, normalizes
  Unicode, and applies the schema's safe-text limits. Never persist raw parser
  exceptions; `import.warnings` contains stable safe codes only.
- Require `asset_id` to equal `sha256:` plus the asset's declared SHA-256, then
  hash the materialized file and compare it to both values. Require the
  `assets/sha256/<hash>/` directory component to equal that same declared
  SHA-256; a correct file under a different hash directory is invalid.
- Accept only `assets/sha256/<64-lowercase-hex>/<safe-filename>` paths. Before
  every write or read, resolve/realpath the asset and prove it remains under
  the real catalog root. Reject absolute paths, drive-qualified paths,
  backslashes, symlinks escaping the root, and every traversal attempt.
- Treat `audio` as a keyed role map. A record has at most one asset for each
  role, so STRUM can deterministically choose `audio.guitar`, `audio.vocals`,
  or `audio.mix`.
- `audio.harm1`, `audio.harm2`, and `audio.harm3` are optional, explicitly
  materialized isolated-source roles. They are never inferred from a file
  name, `audio.vocals`, or `audio.mix`.
- Require coverage consistency: `present` has non-empty difficulties and track
  names; `absent` and `unsupported` have neither. Display violations to the
  curator as a safe validation code, never as a raw source path.

These checks must have fixture tests for POSIX paths, Windows drive/UNC paths,
URLs, path-bearing parser exceptions, mismatched asset IDs/hashes, duplicate
audio roles, and partial catalog directories.

## UI handoff: Dataset Curation

The Dataset Curation UI is a review and selection surface, not a second
importer or tokenization layer.

1. Let the user select packages/folders through the existing trusted file
   dialogs, or select songs from the open OCTAVE library.
2. Show the normalized candidate summary supplied by the catalog service:
   source kind, sanitized metadata, MIDI validity, instrument coverage,
   duplicate status, import warnings, and rights status.
3. Require an explicit provenance and license/permission basis before a source
   can be included. Recognized STRUM-generated charts are currently blocked,
   including explicitly opted-in library songs and selected package entries.
   The catalog service returns `generated_revision_unverified` because OCTAVE
   does not yet preserve a canonical generated baseline and a semantically
   modified, explicitly approved revision. Metadata changes, byte differences,
   and self-reported approval fields cannot satisfy that boundary. OCTAVE then materializes only those approved sources,
   with `training_use: allowed`; unresolved review states are never exported.
4. Ask the user for a parent directory and a new catalog name. The final
   `<parent>/<name>` destination must not already exist; an existing empty
   directory is not an atomic destination. Materialize approved assets through
   a sibling `<parent>/.<name>.staging-<random>` directory on the same volume.
   Hash and validate every staged asset, write and validate `records.jsonl` and
   `catalog.json`, then atomically rename the staging directory to the new
   destination. On failure, remove the staging directory and leave no catalog
   marker at the destination.
5. Hand STRUM the catalog directory. Do not hand it the original package paths
   or put those paths in renderer state, exported manifests, logs, or errors.

### Vocal Harmony source policy

Harmony is deliberately a separate curation operation on an existing allowed
catalog record. The editor first decodes the managed `notes.mid` and offers
only exact `HARM1`, `HARM2`, or `HARM3` tracks. The user selects an audio file
through a trusted main-process dialog; the renderer receives only an opaque
selection ID and a safe display name. OCTAVE materializes it as the matching
`harm1`, `harm2`, or `harm3` asset and atomically writes
`vocal-harmony-sources.json`.

The sidecar is `octave-vocal-harmony-source-policy/v1`, path-free, and binds
each `(source_id, HARM track)` to its matching asset identity. It requires one
of two truthful provenance forms:

- `isolated_source_stem/v1`: a same-master-timeline original-stem attestation
  ID supplied by the curator.
- `isolated_separation_output/v1`: the catalog's exact `audio.mix` asset ID
  and hash plus separator ID, version, model SHA-256, and configuration
  SHA-256.

The sidecar includes the SHA-256 of canonical `catalog.json` plus the exact
`records.jsonl` text. Any subsequent catalog change therefore invalidates a
stale sidecar until OCTAVE rebuilds it. Existing rows are retained only after
their assets, roles, provenance, source IDs, and current control hash validate
again. OCTAVE rejects a selected Harmony file whose content hash equals the
record's `mix` or shared `vocals` asset; it never performs separation, labels
an unproven source as isolated, or falls back to shared vocals/mix.
### Audio-enrichment revisions

Audio enrichment is a separate, clone-only curation action for a reviewed
package chart whose `notes.mid` already exists in a selected catalog. It is not
an ordinary catalog update and cannot add a second record for the duplicate
MIDI. The renderer submits one opaque reviewed candidate ID; OCTAVE's main
process reopens a capped, no-follow package snapshot and verifies its container
hash, selected entry locator, entry ID, and MIDI hash before any catalog work.

OCTAVE then clones the selected catalog to a new destination on the same
volume, finds exactly one record with that MIDI asset hash, and changes only
the audio roles supplied by the reviewed candidate. The existing chart asset,
source ID, import data, metadata, and record-level rights/provenance/license
are preserved as values; only the matching record's audio role map is changed.
The new manifest identifies itself as an `Audio enrichment revision in OCTAVE`
while retaining the existing catalog license basis.

Every alternate audio asset must have a supported extension and container
signature, is materialized by content hash, and is revalidated before publish.
Duplicate role filenames, an already-present same-role asset, an absent or
invalid alternate asset, an ambiguous MIDI match, source replacement, and a
mix/vocal pair that refers to the same bytes all fail the whole operation.
Failures remove the staging revision and leave both the original catalog and
the requested destination unchanged. STRUM still receives only the published
catalog revision; it does not receive a package location or an enrichment API.

### Preparation inventory

Before selecting package-backed songs, Dataset Curation can run a bounded,
main-process-only package inventory for the opaque folder selection. This is a
preparation aid, not a converter or a curation decision. It returns aggregate
counts only: readable package/header containers, valid and invalid/missing
`notes.mid`, `notes.chart`-only inputs, exact canonical Expert Vocal lead
availability, duplicate MIDI/container identities when a bounded hash was
available, and timeout/failure totals. It never returns source locations,
package entry names, metadata, hashes, parser errors, or candidate IDs.

The inventory accepts only the package group selected through OCTAVE's trusted
dialog. Folder discovery is an incremental, cancellable directory walk with
package and directory limits; it does not open package contents. Each selected
SNG, ZIP, or RB3CON is then inspected in a dedicated worker with a hard timeout.
The worker itself opens one descriptor with no-follow and non-blocking guards,
fstats it as a regular file, validates a 256 MiB cap, reads a stable bounded
snapshot, hashes that snapshot, and parses only those bytes. Stable identity
starts at worker open: a path may change after discovery but final symlinks,
devices, and oversized containers fail closed, and later replacement cannot
change the opened snapshot. ZIP and RB3CON inspection reads chart metadata
only; it does not decrypt audio, transcode charts, materialize a catalog, or
change rights, consent, selection, or catalog eligibility.

ZIP inspection also caps both chart candidates and their aggregate decompressed
`notes.mid` bytes. The worker parses that bounded data and returns only
normalized chart validity, Vocal availability, and internal content-dedup
signals to the main process; raw MIDI buffers never cross the worker boundary.

Inventory counts are completed-result counts. `inspected`, `readable`, chart,
identity, and duplicate totals advance only after a worker result; a completed
safe refusal is reported as unreadable/failed. A cancellation or timeout is
reported separately and does not inflate the completed package totals. “Exact
Expert Vocals” means one literal `PART VOCALS` track with observed Vocal note
labels; Vocal tracks do not use the five-lane difficulty bands, but catalog
coverage records a present Vocal part as Expert.

STRUM rejects a catalog without both root files, with a staging marker, or with
any asset/hash validation failure. It never tries to repair an incomplete
catalog.

The current MIDI-only export is a transitional projection. It should become a
catalog projection: the UI calls one catalog build operation, and the existing
MIDI exporter reads allowed catalog records rather than re-parsing source
packages.

## Validation and evolution

- Validate `catalog.json` against the schema and each JSONL record against
  `#/$defs/record` before STRUM sees the catalog.
- Resolve every asset path relative to the catalog root, reject traversal, and
  verify the declared SHA-256 before use.
- Deduplicate by canonical materialized asset hashes, not display metadata.
- Add fields only in a backward-compatible minor revision; publish a new
  `.../v2` format for breaking changes. Consumers reject unknown major formats.

### Generated chart admission

The current release accepts human-authored reviewed sources. It fails closed
for recognized STRUM-generated charts in catalog materialization, reviewed
package audio enrichment, and legacy MIDI export. The UI explains this blocked
workflow; ordinary editing and chart generation remain available.

Enabling generated corrections later requires a preserved canonical chart
baseline, instrument-aware semantic change evidence, and explicit approval
bound to the exact accepted revision. Later edits must invalidate that approval.
A `dataset_opt_in` flag or a metadata-only edit cannot provide this evidence.
Existing catalogs made by older versions are not retroactively certified by
this change; recreate any catalog that included generated charts. Sources
whose generated provenance has been removed cannot be identified from the
current metadata-only history and must not be represented as verified human
corrections.
