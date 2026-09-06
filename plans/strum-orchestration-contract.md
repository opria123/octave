# OCTAVE ↔ STRUM orchestration contract

## Purpose

OCTAVE is the local curation, catalog, job-control, and deployment surface. STRUM is the versioned ML runtime that owns task definitions, dataset views, preprocessing, training, evaluation, checkpoints, and inference execution.

The boundary supports STRUM as a family of models rather than one model. A user can select Guitar audio-to-chart, Drums, learned chart-to-chart difficulty transforms, or future Vocal/Pro-instrument pipelines from one approved OCTAVE catalog.

The initial proof is complete: OCTAVE created a 58-record allowed catalog; STRUM selected 31 Guitar, 52 Drums, 29 Bass, 18 Keys, and 3 Vocal-eligible records for dedicated workers. That is historical smoke evidence, not the current catalog state. The current locally approved SMB catalog has 212 allowed records and the current readiness counts are recorded below. Catalog-aware smoke preprocessing and bounded CUDA training completed for Guitar, Drums, Bass, Keys, Vocal activity/pitch, observed Vocal lyric alignment, and Talky activity. Exact Pro target decoding and Vocal phrase task preparation also complete against that catalog. These artifacts validate the handoff and worker contracts only; they are not deployable quality models.

## Current review evidence — 2026-09-05

The integrated implementation is documented in the [local training runbook](../docs/reference/strum-training.md), with reproducible worker and Electron checks in [acceptance](../scripts/acceptance/README.md). Earlier dated results below are historical execution evidence. The current companion runtime is pinned in CI to STRUM `b32fa0a0943a75184999edfe87c4ce38225d833f`.

Current hardening covers prepared manifest and sidecar integrity, direct and nested worker bundle layouts, verified fine-tune parents, catalog bindings that preserve candidate modality, typed chart capability gates, exit-confirmed job completion, process-tree cancellation, durable history, and generated-output provenance. OCTAVE owns these orchestration and storage checks; STRUM continues to own labels, task lineage, evaluation and promotion policy.

The approved-catalog one-epoch transform candidate fails the unchanged quality policy (F1 0.4380, precision 0.2993, recall 0.8163) and remains non-deployable. A separately trained synthetic identity fixture passes through packaging and actual OCTAVE MIDI generation; it proves execution only. No production-quality personalized model is promoted. Planned capability composition, optimizer-state resume, generated-chart revision tracking, and a verified official training-runtime release remain explicitly outside the implemented deployment path.

## Ownership boundary

| Concern                    | OCTAVE owns                                                                     | STRUM owns                                                    |
| -------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Source packages and rights | Safe import, consent/review, catalog materialization                            | Never parses source packages or infers rights                 |
| Source catalog             | Writes path-free `octave-song-source-catalog/v1`; emitted records are `allowed` | Strict validation and consumption                             |
| Task views                 | Pipeline selection and eligibility presentation                                 | Requirements, split assignment, view building and validation  |
| Training                   | User intent, local job lifecycle, progress, cancellation, storage               | Preprocess, train, evaluate, experiment/checkpoint metadata   |
| Deployment                 | Selects a compatible local auto-chart profile/default                           | Declares checkpoint capabilities and loads bundles            |
| Model behavior             | Never implements labels/tokens or deterministic difficulty reduction            | Architecture, labels, learned transforms, inference semantics |

OCTAVE must not reopen original package/folder sources after catalog materialization. STRUM must never receive original locations through catalogs, task views, renderer state, logs, or errors.

## Stable STRUM runtime interface

OCTAVE must invoke a versioned, machine-consumable STRUM worker/CLI. It must not call source-tree `scripts/*.py`, import STRUM internals, or infer support from a checkout layout.

Initial interface:

```text
strum-worker probe --json
strum-worker pipeline list --json
strum-worker catalog inspect --catalog-root <catalog-root> --pipeline <id> --json
strum-worker dataset prepare --request <owned-json> --json-events
strum-worker train start --request <owned-json> --json-events
strum-worker checkpoint discover --model-root <private-folder> --json
strum-worker checkpoint inspect --model-root <path> --json
strum-worker inference profile validate --model-root <path> --profile <id> --difficulty-policy <policy> --json
strum-worker chart preflight --request <owned-json> --json
strum-worker chart run --request <owned-json> --json
```

`dataset prepare --json-events` and `train start --json-events` emit line-delimited JSON events with a job ID, monotonic sequence number, stage, progress, safe message/code, and terminal state (`succeeded` or `failed`). Human stdout/stderr is diagnostic only. OCTAVE's main process owns spawning, cancellation, and private paths; it cancels the worker process group rather than asking a separate STRUM daemon to retain a private-path job ID. Its renderer receives only safe IDs, names, capabilities, progress, and errors.

`probe` must report a protocol version, STRUM release and source revision, dirty state, Python/platform requirements, advertised capabilities, pipeline IDs, device support, and supported model/checkpoint manifest schema versions. OCTAVE rejects an unknown major protocol, unsupported pipeline, missing command, or incompatible schema before work begins.

The current `resources/strum/strum_worker.py` is an OCTAVE-specific temporary adapter. Its direct imports and source-tree discovery are not the long-term boundary. Keep it only behind a compatibility mode while STRUM gains the worker interface.

## Runtime kinds and trust

| Runtime kind         | Intended user       | Source of truth                                                | Training support                               |
| -------------------- | ------------------- | -------------------------------------------------------------- | ---------------------------------------------- |
| `bundled_inference`  | Release user        | App-packaged, pinned worker/runtime                            | Only explicitly shipped inference capabilities |
| `managed_checkout`   | Local-training user | OCTAVE-managed pinned STRUM revision plus isolated environment | Advertised capabilities only                   |
| `developer_override` | Contributor         | Explicit local checkout/worker and interpreter                 | Advertised capabilities after acknowledgement  |
| `installed_runtime`  | Advanced user       | Explicit compatible installed `strum-worker` executable        | Advertised capabilities only                   |

Release OCTAVE must not clone arbitrary GitHub branches to auto-chart. It continues to use its shipped inference runtime. The installer resolves a signed self-contained `resources/strum/strum-worker` before the temporary Python adapter, so adding an official pinned worker to the installer enables the full protocol without a renderer or runtime-path change. "Install STRUM training runtime" is an explicit setup action: choose an official release/tag/immutable commit, verify published hash/signature, stage atomically, provision an isolated environment, probe it, and write a lock manifest. Never fetch `main`/`master`, run `git pull`, or automatically download a runtime because an override was absent.

The developer setting is a **STRUM runtime**, not only a Python path. It contains a canonical main-process-only source root or executable, interpreter/environment where needed, resolved runtime ID, protocol/capability snapshot, revision/dirty state, and validation timestamp. OCTAVE prompts for the checkout explicitly and accepts only a versioned `src.worker`; it never implicitly executes a sibling source tree. The renderer stores an opaque runtime ID/display name, never an absolute path.

Existing `OCTAVE_STRUM_SOURCE_DIR` and `OCTAVE_STRUM_PYTHON` remain development bootstrap inputs, but must feed the same validator. A bare interpreter override is insufficient. Current development Python selection also needs to align with STRUM's declared Python minimum before the interface is enabled.

## Pipeline descriptors

`pipeline list` is STRUM-owned and is the only source of controls displayed in OCTAVE Prepare and Train.

```json
{
  "id": "guitar.onset-fret/v1",
  "display_name": "Guitar onset + fret",
  "kind": "audio_to_chart",
  "catalog_requirements": {
    "instrument": "guitar",
    "difficulties": ["expert"],
    "audio_roles": ["guitar", "mix"],
    "audio_policy": "prefer:guitar,fallback:mix"
  },
  "prepare_schema": { "type": "object" },
  "train_schema": { "type": "object" },
  "private_request_fields": ["catalog_root"],
  "training_requirements": ["profile_evaluation", "profile_packaging"],
  "catalog_inspection_option_keys": ["audio_role", "fallback_audio_role", "required_difficulty"],
  "checkpoint_outputs": ["guitar_onset", "guitar_fret"],
  "inference_capability": "guitar.audio_to_chart/v1"
}
```

`private_request_fields` names only host-main-process values such as `catalog_root` or a verified `parent_bundle`; it never contains a filesystem value. `catalog_inspection_option_keys` limits which schema controls OCTAVE may pass into a readiness inspection. `training_requirements` gives stable, path-free names for a runtime extra or missing STRUM-owned evaluation/profile stage; OCTAVE displays them rather than guessing from pipeline IDs or source files. Together these let OCTAVE discover the orchestration boundary from STRUM rather than carrying a pipeline-ID allowlist. Future descriptors follow the same shape: `drums.onset-velocity/v*`, `bass.onset-fret/v*`, `vocals.pitch-lyrics/v*`, Pro-instrument pipelines, and `difficulty.transform/v*`. The difficulty transform is a learned STRUM pipeline; OCTAVE may request it and display provenance/confidence but must not own the deterministic Expert-to-lower-difficulty strategy.

### Current training coverage

The catalog-aware Guitar, Drums, Bass, Keys, Vocal activity/pitch, phrase-boundary, lyric-alignment, and talky-activity, Guitar/Bass fret-mapper, Guitar/Bass section, and Pro target/audio-preprocessing paths revalidate `allowed` catalog assets and create path-free task views. The first OCTAVE catalog proved 31 Guitar-eligible, 52 Drums-eligible, 29 Bass-eligible, 18 Keys-eligible, 3 Vocal-eligible, 31/29 Guitar/Bass mapper-eligible, and 30/29 usable Guitar/Bass section-eligible records. Section preparation excludes malformed third-party MIDI before publishing a task view, so readiness counts match the labeler rather than failing mid-job. Guitar onset/fret, Drums onset-classifier, Bass onset/fret, Keys onset/fret, Vocal activity/pitch, phrase boundaries, observed lyric alignment, and lead-talky activity, Guitar/Bass fret-mapper, and Guitar/Bass section worker training are available for experiment artifacts. Bass and Keys are distinct exact-track `PART BASS` and `PART KEYS` five-lane tasks; the shared `five-lane-midi/v2` contract rejects suffixed alternate tracks, and the generic descriptors bridge only to their distinct V1 evaluation/package/runtime paths. The vocal workers are distinct exact-`PART VOCALS` frame, phrase, timestamped lyric/text CTC, and note-96 talky-span tasks. Task-view split assignment is seed-keyed in `sha256-source-id-seed-mod-100/v2`; legacy v1 views remain resolvable. The default Talky view puts all three eligible records in Train, while a declared 67/33 smoke split separates the two Talky-positive songs and completes CUDA training with `val_talky_activity_f1: 0.0`; two positive sources are not quality-grade evaluation evidence. `vocals.harmony-source-policy/v1` now defines the only valid future harmony input: an OCTAVE `vocal-harmony-sources.json` sidecar binds each exact `HARM1`/`HARM2`/`HARM3` track to an attested or hash-pinned separated `harm1`/`harm2`/`harm3` asset. It never falls back to shared `vocals` or `mix`; the reviewed OCTAVE handoff (`dc32825`, `6d7d41e`, `23d7acb`) safely materializes those explicit assets and sidecars with no-follow source admission plus serialized catalog mutation leases. The current catalog still has zero eligible Harmony records until a user supplies those inputs. The planned full Vocal contract is explicit and non-executable: it requires selected-Harmony per-track bindings, held-out source partitioning, canonical protocol/quality-policy evidence, a successful policy pass, a package writer, and a named handler. Its lead-only gate also refuses current self-reported coverage; the three-song/no-test catalog cannot be admitted without a future STRUM-owned source/task resolver. It publishes no pseudo checkpoint output and forbids fallback. Mapper training requires the STRUM `pitch` extra and otherwise fails closed before work begins; its catalog split and Basic Pitch provenance are now release-gated. New mapper artifacts use tensor-only weights and strict candidate validation, but there is still no deployable profile. Guitar, Bass, and Keys each have separate Expert-only neural profile packaging paths, but only after revalidated held-out evaluation passes explicit gates; no current smoke artifact is selected as a profile. A Drums V2 experiment can be packaged only as a hash-verified prepared-window evaluator, not as an auto-chart profile; direct V14 remains the executable Drums chart profile. Section now shares the legacy router’s exact librosa/Slaney/constant frontend, with float32 cache and matched audio-duration labels. Its promotion contract verifies one task-view lineage across candidate, experiment, report, and package; it recalculates held-out metric evidence and packages only `evaluation_only_not_auto_chart_runnable`. Router impact ablation and an instrument-specific composed profile remain required. Five-lane chart-pair difficulty transforms are catalog-backed and worker-trainable for Guitar, Bass, Keys, and Drums. Transform preparation can choose `audio_feature_mode: rms_onset_v1`; STRUM filters the immutable view to catalog audio that reaches the source Expert chart, records only source/asset hashes and roles, and fails closed rather than falling back to chart-only data. Raw fresh/fine-tuned transform bundles are profile-less and `not_deployable`. Promotion requires a candidate-bound, song-disjoint held-out evaluation report whose evidence is recomputed by STRUM, then copies an immutable hash-bound profile package. For audio-conditioned candidates, Evaluate and Package accept the private catalog root and rematerialize the same catalog-bound audio manifest worker-side; no audio paths persist. The prior one-epoch CUDA smoke (24 audio-aligned Guitar records of 30 chart-pair candidates) and its 125-event Expert→Hard run are execution-contract evidence only, never promotion evidence. Pro Guitar/Bass and Pro Keys now derive exact Expert REAL-track targets (including standard-vs-`_22` variants, technique/fret, or pitch/range semantics) into `strum-pro-target-task-manifest/v1` and can materialize catalog-revalidated `pro-logmel-event-windows/v1` caches. They train both raw known-reference-event attributes and an experimental audio-only free-running event-proposal candidate with deterministic geometry-safe negatives. The proposal scores only event centers; it cannot decode sequences, write MIDI, package a profile, or execute charts. A clean CUDA Pro Guitar proposal smoke produced F1 0.0 and a profileless `not_deployable` bundle. Pro experiments retain a safe source revision plus `strum_source_dirty` (`true`, `false`, or unknown); invalid runtime revision attestation fails closed for revision-pinned bundles. Sequence decoding, chart evaluation, packaging, and execution remain required stages.

Each new adapter must select only `allowed` records, revalidate catalog hashes at use time, derive labels within STRUM, assign and persist song-disjoint splits, and write catalog ID, task-view hash, source IDs, input hashes, and audio/MIDI alignment provenance into its cache, experiment, and checkpoint manifests. Audio-to-chart descriptors must state whether OCTAVE materializes timeline-aligned audio or STRUM derives and records an alignment offset.

Multi-mode workers additionally publish `strum-candidate-checkpoint-output-contracts/v1`. Unlike a static `checkpoint_outputs` list, this path-free map binds the selected train option (for example Pro `candidate_kind`) to exactly one raw component, its preprocessing and output semantics, and its explicitly non-deployable scope. STRUM revalidates the emitted bundle against that selected contract: no extra components, profiles, companions, noncanonical numeric options, or unknown config fields are accepted. OCTAVE normalizes this optional descriptor field in the main process and shows the selected mode as experiment-only; it never infers a profile or chart capability from the component name.

## Immutable handoff artifacts

### Catalog

OCTAVE writes `octave-song-source-catalog/v1`. Curation exclusions happen before export; all produced records have `rights.training_use: "allowed"`. `review_required` is a UI decision state, not a record STRUM is expected to consume.

### Task view

STRUM writes a pipeline-specific, path-free view containing catalog ID and manifest hash; pipeline ID/version and runtime ID; selected source IDs and asset hashes; safe eligibility counts; split algorithm/version/seed; preprocessing configuration/hash; and a task-view content hash. An audio-conditioned transform view additionally freezes the selected mode and preferred/fallback roles, but never an audio path. Vocal lyric views preserve aligned timestamps and fixed vocabulary identity; Pro target views preserve exact source-track variant and decoded target identity, never the original package path. Non-shared future task views also declare their label-source schema and catalog-validated selected MIDI track names; this is input semantics, not a claim of a trainer or deployment profile. The current catalog manifests revalidate managed assets at use time. Before preparation, `catalog inspect --pipeline --options` returns a path-free eligibility summary: eligible count, stable exclusion counts, effective audio policy, and a bounded/capped storage estimate. OCTAVE supplies only pipeline-relevant preparation options (for example, transform instrument, target difficulty, and audio-conditioning mode).

### Experiment manifest

Before training, STRUM writes `experiment.json` with run ID; task-view hash; pipeline/runtime IDs; normalized configuration/hash; checkpoint mode; validated parent provenance where applicable; requested/resolved device, precision, workers, and seed; lifecycle/metric summary; and output checkpoint bundle hashes. This removes hidden assumptions in YAML paths and directory names. The current chart-transform worker supports `fresh` and verified-bundle `fine_tune`; it rejects resume until STRUM has a portable optimizer/scheduler-state contract. Experiment manifests retain parent identity/hashes, never source paths.

### Checkpoint manifest and discovery

Every checkpoint or inseparable bundle has a sidecar manifest with schema version/hash; producer runtime/pipeline; architecture, label, and preprocessing fingerprint; parent/fine-tune provenance; task-view/catalog identity; metrics/evaluation split; and inference capabilities/required companions. A raw training bundle is an experiment candidate, not a profile. Promotion-capable bundles must bind candidate, dataset/task view, held-out split, recomputed evaluation evidence, component/configuration hashes, and immutable copied output. Guitar deployment is a validated onset + fret bundle, never one arbitrary `.pt` file. `checkpoint discover` accepts one OCTAVE-main-process model root, walks it within STRUM's bounded limits, hash-verifies manifests, and returns opaque manifest-derived artifact IDs plus deployability state—never locations, filenames, or parser errors. OCTAVE maps an accepted artifact ID back to its private selected root before later validation or chart work.

## Auto-chart model-bundle contract

Auto-chart selection needs a STRUM-owned `model-bundle.json` at a validated model root. It is separate from the STRUM runtime selection: choosing a model folder must not select source code, and choosing a runtime must not silently choose arbitrary checkpoints.

The bundle manifest contains schema version; bundle ID; compatible STRUM runtime range; component IDs; relative file paths; SHA-256 and byte lengths; required/optional status; architecture and preprocessing fingerprints; thresholds; and dependent runtime versions such as Demucs, Basic Pitch, and Whisper. Component IDs cover the actual auto-chart graph: separation, drums/ensemble heads, Guitar/Bass onset and mapper, Vocals, Keys, sections, tempo/chart assembly, and any learned difficulty model. A profile may additionally declare `strum-profile-composition/v1`: an acyclic, typed, path-free graph of stages, dependency artifacts, required components/companions, and terminal instrument/difficulty chart outputs. STRUM rejects incomplete or handlerless graphs for execution; their preflight is explicitly `not_available`.

Before a chart run, STRUM performs:

```text
strum-worker chart preflight --request <owned-json> --json
strum-worker chart run --request <owned-json> --json-events
```

Preflight validates bundle schema, file hashes/sizes, model state/config/shape compatibility, device availability, requested instruments, required stems, companion models, and the selected difficulty policy. It returns an immutable `strum-chart-preflight/v1` resolved plan. Loading an arbitrary user-selected `.pt` with unsafe deserialization is never an OCTAVE feature; only a trusted, verified bundle is eligible.

The chart request names a model bundle/profile, requested instruments, typed backend choices, device/network policy, and an explicit `difficulty_policy`:

- `expert_only`: preserve only model-produced Expert output and defer lower difficulties;
- `deterministic-v1`: an explicitly requested transitional legacy behavior; or
- `learned:<component-id>`: a validated learned STRUM transform.

The result is a path-free `strum-chart-run/v1` manifest with per-instrument stage status, resolved model IDs/hashes, output identities, safe warnings/errors, and the chosen difficulty policy. Existing direct profiles use a typed `expert_chart` stage and explicitly mark omitted lower-difficulty work `not_requested`; learned transforms mark their supplied Expert chart `provided` and their transform stage `succeeded`. Profiles without a worker handler are `unavailable`, never silently delegated to legacy assembly. A partial result is never presented as a complete deployment result; OCTAVE can display it only when the user explicitly accepts the declared fallback policy.

This removes current gaps where auto-chart loaders use CWD-relative hard-coded checkpoint/config locations, individual models have divergent compatibility rules, optional components silently fall back, and full-pipeline output can report success despite per-instrument failures. It also gives OCTAVE the required checkpoint-folder support without reproducing STRUM internals.

## OCTAVE step plan

### Learn

Show the selected runtime kind/version, capabilities, accelerator support, estimated disk use, and the difference between catalog, task view, experiment, checkpoint, and deployed profile. Explain that a release inference runtime may not have training support. Offer explicit training-runtime setup only when required.

**STRUM calls:** `probe`, `pipeline list`.

### Curate

OCTAVE parses sources in the main process, applies rights and STRUM-charted-song inclusion policy, materializes safe assets, validates the catalog, and writes only allowed records. STRUM may provide a read-only compatibility preview but cannot alter rights or source selection.

**STRUM call:** optional `catalog inspect`.

### Prepare

OCTAVE lists only pipelines advertised by the selected runtime. It sends the catalog root only from the main process and displays eligible count, stable missing-requirement counts, audio-role policy, split seed, and estimated storage/time. STRUM creates and returns the immutable task view plus safe exclusions.

**STRUM calls:** `catalog inspect`, `dataset prepare`.

**Implemented initial pipelines:** `guitar.onset-fret/v1` (Expert Guitar, prefer `audio.guitar`, fall back to `audio.mix`), `drums.onset-classifier/v1`, `bass.onset-fret/v1` (Expert `PART BASS`, prefer `audio.bass`, fall back to `audio.mix`), `keys.onset-fret/v1` (Expert `PART KEYS`, prefer `audio.keys`, fall back to `audio.mix`), `vocals.note-activity/v1`, `vocals.phrase-boundaries/v1`, and `vocals.lyric-alignment/v1` (exact `PART VOCALS` activity/pitch, phrase, and timestamped lyric/text targets), `strum.fret-mapper/guitar/v1`, `strum.fret-mapper/bass/v1` (each requires the `pitch` extra), `chart_transform.five_lane/v1` (chart-only or the catalog-audio-conditioned `rms_onset_v1` task mode), plus exact Pro target preparation through the planned Pro descriptors. Prepare is a real catalog-backed job rather than a transition button.

### Train

OCTAVE renders only fields declared by a pipeline's `train_schema`: model and bounded training settings such as checkpoint mode, epochs/steps, batch size, device/precision, seed, and approved augmentation/evaluation choices. Renderer-visible schemas must never include filesystem locations. It uses the STRUM descriptor's `private_request_fields` to add a prepared catalog root or verified parent bundle only in the main-process request; it does not carry a hard-coded catalog-worker list. For chart-transform fine-tuning it presents an opaque compatible parent-artifact selector, resolves that to a verified bundle privately, and adds the private parent bundle only after preflight. It supervises the worker state machine `queued → validating → provisioning → running → cancelling → terminal`, relays JSON progress, and stores a safe job summary.

**STRUM calls:** `train start` (or synchronous `train run`) with newline-delimited JSON events.

The first templates are clearly labelled non-deployable Guitar, Drums, Bass, Keys, Vocal activity/pitch/phrase/lyric, mapper, Pro known-event, and Pro audio-proposal smoke runs, plus chart-transform fresh/fine-tune runs. OCTAVE may expose either Pro mode only as an experiment component: known-event attributes require reference events, while the proposal mode scores event centers but has no sequence decoder or MIDI writer. For a multi-mode descriptor it renders only the selected `checkpoint_output_contracts` entry, including its raw-only status. STRUM must reject incompatible parents. A trained checkpoint is not an auto-chart profile unless it has a validated `model-bundle.json`, explicit inference capability, and STRUM-recomputed, candidate-bound evaluation evidence. OCTAVE must surface Transform Evaluate/Package only as subsequent STRUM jobs; an audio-conditioned job supplies the selected catalog root privately and never an audio-manifest path.

Cancellation must signal the worker, wait for exit, then terminate its process group/job object after a grace period so child Demucs/yt-dlp processes cannot survive. Request/staging cleanup must be idempotent and occur only after terminal exit.

### Deploy

OCTAVE discovers manifests through STRUM, groups required companions, displays pipeline/runtime/dataset/metric provenance, and asks for confirmation before changing a local default. Its main process chooses the model folder, maps opaque artifact IDs to the exact private bundle roots, and returns a redacted DTO to the renderer. It clears previous discovery mappings when the folder changes; saving a default re-inspects and profile-validates the selected artifact, then persists its artifact ID and manifest hash. Every use re-inspects and requires the same deployable identity, clearing a stale/mutated default. It retains the shipped profile as fallback.

**STRUM calls:** `checkpoint discover`, `checkpoint inspect`, `inference profile validate`; developer-only profile evaluation/packaging is explicit and never an implicit deployment step.

An auto-chart request resolves a profile ID to a compatible bundle in the main process, records profile/runtime IDs in the result manifest, and fails closed to the shipped profile if validation fails.

## Auto-chart readiness requirements

The existing integration already launches the packaged worker, resolves CUDA/MPS/CPU, provisions Demucs/Whisper helpers, reports progress, and supports cancellation. Training orchestration must retain these behaviors while replacing brittle source discovery.

Before deployment, STRUM must state for each checkpoint: the inference stage it serves; expected audio/stem/sample-rate/alignment requirements; companion model fingerprints; supported auto-chart instrument toggles; fallback behavior; and evaluation evidence. Until that capability manifest exists, a training checkpoint remains an experiment artifact and is not an OCTAVE auto-chart option.

## Delivery order

1. **Complete:** STRUM versioned worker protocol, `probe`, pipeline descriptors, catalog inspection, and fixture worker.
2. **Complete for local development:** OCTAVE runtime resolver with `bundled_inference` and `developer_override`, explicit probe validation, opaque settings, and legacy-wrapper compatibility flag.
3. **Complete:** OCTAVE background job/process-group lifecycle and idempotent cleanup.
4. **Complete contract; execution remains profile-specific:** STRUM model-bundle manifest, inference preflight, typed chart request/result, explicit difficulty policy, no-silent-fallback reporting, and `strum-profile-composition/v1` graph validation are in place. A graph without an exact registered execution handler remains `not_available`.
5. **Complete for worker artifacts:** catalog `prepare`/`train`, manifests, and compatibility checks for Guitar, Drums, Bass, Keys, Vocal activity/pitch, phrase, lyric alignment, and talky activity, Guitar/Bass fret mappers, Guitar/Bass section classifiers, five-lane chart transforms, and Pro known-event attribute and audio-proposal candidates. Exact Pro Guitar/Bass/Keys targets and audio windows feed bounded experiment stages; the free-running proposal has geometry-safe negative windows but only scores event centers. `strum-candidate-checkpoint-output-contracts/v1` now binds each selected Pro mode to one exact raw component/configuration and rejects extra/path-bearing/noncanonical bundle metadata. The fresh CUDA proposal smoke is profileless, `not_deployable`, and scored F1 0.0; it is never a quality result. Chart transforms can make a catalog-audio-conditioned view and retain safe audio lineage; the first CUDA smoke is not a promoted quality result. Guitar, Bass, and Keys now have separate revalidated evaluation-gated Expert-profile packaging/runtime paths; current smoke artifacts have not passed promotion and are not packaged. The reviewed worker integration `a7568ab` exposes bounded post-training evaluation/package job descriptors with main-process-only artifact roots, NDJSON lifecycle, and an allowlisted path-free result DTO; its worker error/curation interop rules preserve the existing gates and catalog record-rights authority. The current shared-seed Lead-Vocal views contain all four label kinds but only 10 train / 4 validation / 4 test sources, so the STRUM-owned data gate correctly rejects them against the 40 / 10 / 10 source minimum and per-label counts. Vocal composition remains profile-gated by isolated Harmony materialization, canonical quality evidence, and a future package/runtime handler; its generic descriptor is intentionally output-free. Vocal and mapper bundles remain profile-gated; talky rejects inadequate positive splits, mappers declare the `pitch` runtime extra, release gates, and tensor-only candidate validation. Section now uses the exact legacy router frontend but remains profile-gated by loader/calibration/ablation/composition requirements. Drums V2 adds evaluation-only package support, while deployable onset-plus-classifier execution remains a distinct future contract.

   `340621d` adds the immutable `chart-transform-five-lane-held-out-v1` policy: song-disjoint held-out lane F1 must be at least 0.50, with precision and recall each at least 0.45. The first bounded CUDA Guitar Expert-to-Hard baseline scored F1 0.329681 / precision 0.291245 / recall 0.379804 on 25 held-out records and failed all three minima. Its raw bundle remains `not_deployable`; packaging, profile validation, and chart preflight all fail closed.

   `1c5412e` upgrades transform promotion to source-disjoint Train / Calibration / Test V2 views: a fixed per-lane decoder grid is selected and bound only on Calibration, then the immutable quality policy is evaluated only on Test. The first V2 CUDA run used 99 / 12 / 12 sources and calibrated thresholds `[0.35, 0.50, 0.40, 0.45, 0.50]`; its Test precision / recall / F1 were 0.233493 / 0.961795 / 0.375763, so it failed F1 and precision with no package or profile. `189b969` also binds raw transform CLI inference to its resolved checkpoint target, preventing a symlink retarget from bypassing promoted-profile threshold protection.

   `d8eb200` adds deterministic Calibration-only checkpoint selection with a complete hash-bound per-epoch trace (F1, then precision, recall, then earliest epoch); Test is never read during this choice. A 30-epoch chart-only V2 CUDA run selected epoch 26 and improved Test F1 to 0.420986, but precision / recall / F1 of 0.274937 / 0.898026 / 0.420986 still failed the policy. It remains a raw, `not_deployable` candidate.

   `8a24ded` freezes the Expert Guitar/Bass/Keys profile promotion boundary. A canonical, freshly decoded STRUM-owned policy pins quality minima and decoder thresholds/duration; evaluation evidence, package metadata, loaders, and preflight require the same policy identity and hash. Direct package CLI/API and post-training-job threshold/minimum/decoder overrides are removed. A profile with forged lower minima or altered decoder values fails closed. These paths still require quality-grade held-out evidence before a profile can be produced.

   `72ff57c` repairs two live contract paths: a fine-tuned five-lane transform can now be evaluated from its deliberately path-free stored candidate configuration after its parent provenance is revalidated, and Section preparation/training/evaluation share a case-exact five-lane track contract. Retired prefix-schema Section views fail with a re-prepare migration error rather than producing a self-incompatible task view. The repair has no deployment effect; raw candidates remain non-deployable.

   `ddf0382` binds every typed direct chart run to the immutable preflight plan's exact profile identity as well as its manifest digest. A changed preflight file cannot make a direct Guitar, Bass, Keys, or Drums loader execute a different valid profile from the same bundle while attesting the original selection. Run results and `run.json` carry only the stable manifest digest, never a private bundle path.

   `23fd7a5`, `b730c24`, and `d10c627` add a five-lane `profile_grade` preparation option for Guitar, Bass, and Keys. It is deliberately stricter than generic experiment readiness: it requires an exact dedicated instrument audio role with no Mix fallback, a full-stream decode, an exact Expert chart track, and source-disjoint 20 / 5 / 5 Train / Validation / Test evidence. Its path-free aggregate admission marker is revalidated at task use. Decoder work runs in a bounded isolated child process; crash, timeout, or malformed audio collapse to the existing aggregate unreadable reason. A timeout receives one retry only after the first child is definitively reaped, preventing both timing drift and child multiplication. Unsupported Drums, Vocal, and transform tasks reject this marker rather than claiming the contract.

   On the current approved catalog, the stable profile-grade result is Guitar 71 sources (58 / 5 / 8), while Bass 4 (2 / 2 / 0) and Keys 9 (6 / 2 / 1) fail the minimum because dedicated-role source coverage is insufficient. A fresh 30-epoch Guitar run on the 71-source view reached held-out onset F1 `0.789084` but fret F1 `0.401073`, below the canonical `0.50` minimum; no profile package was created. These facts are admission and quality evidence, not permission to lower the policy or promote a raw checkpoint.

   The same V2 contract supports catalog-audio conditioning. One bounded RTX 4090 run with `rms_onset_v1`, preferred Guitar audio and Mix fallback used 104 valid records (84 / 10 / 10 sources; 68 preferred / 36 fallback). Calibration selected epoch 30; its Test precision / recall / F1 were 0.313061 / 0.810742 / 0.451701, again failing F1 and precision. The audio subset differs from the chart-only subset, so its positive directional change is evidence of a working modality—not an apples-to-apples quality claim or a deployable profile.

6. **Complete in isolated OCTAVE handoff branches:** OCTAVE dynamic Prepare/Train screens consume worker descriptors, readiness summaries, private request fields, and verified fine-tune-parent selection. Deploy now consumes bounded `checkpoint discover` results, maps opaque artifact IDs to private main-process roots, redacts renderer DTOs, rejects non-deployable selections, and pins saved defaults to a re-inspected artifact/manifest identity. Its typed optional output-contract DTO lets Train display a selected raw candidate without turning it into a deploy control (`ea7d9e0`). The reviewed deploy handoff commits are `036f0ff`, `5d46f49`, and `a17a498`; the reviewed catalog/harmony chain is `dc32825`, `6d7d41e`, `23d7acb`, `eb27da1`, and `48e79b2` (the last bounds stalled SNG extraction without accepting partial packages). The reviewed bounded source-inventory chain is `3fd36df`, `310f1dd`, `b2dc4d8`, `698dbb1`, `1f0a3f1`, and `8999627`: it performs opaque, aggregate-only package inspection in a worker, admits a regular no-follow/non-blocking ≤256 MiB snapshot, bounds ZIP extraction, returns no raw chart buffers or source locations, and has a main-owned resumable cursor. The reviewed `a1f3454` bridge retains per-chart evidence only in the main process, exposes opaque review candidates, and materializes only explicitly approved chart entries from the revalidated package snapshot; it handles multi-song containers and root-level ZIP `notes.mid` without ordinal identities. `d7d971f`, `0b096409`, and `6de96b8` form the reviewed current-worker adapter and promotion UX handoff: OCTAVE passes only descriptor-allowed inspection options, registers trained candidates as opaque private-root bindings, starts STRUM-owned evaluation/package jobs in the main process, emits first-wins sanitized terminal results bound to the opaque candidate artifact, rejects descriptor-supplied policy/threshold overrides, and reinspects a package before it can become a profile-selection candidate. Inventory and review state are advisory and do not change catalog eligibility until an explicit selection is atomically materialized. OCTAVE's primary owner integrates these chains. Deployment remains gated on STRUM profile packaging/evaluation.

   `6836b16` and `5cb7bc1` complete the live runtime/candidate boundary handoff. Runtime activation serializes both developer and installed selections in the main process, retries a stale in-flight launch after a selection epoch changes, and emits only a strict path-free runtime DTO while accepting STRUM's numeric protocol version and exact `strum-X.Y.Z+git.<lowerhex>` fallback identity. A completed training run registers its declared nested raw bundle only after realpath containment; later inspect/promotion calls recheck that containment, including after a symlink swap. The renderer receives only an opaque raw candidate, and a raw `not_deployable` bundle remains unavailable as an Auto Chart default.

   **2026-08-25 live acceptance matrix:** Against the approved 212-record catalog, bounded CUDA runs completed for Drums onset classification and learned Expert-to-Hard transforms. Task counts were Drums 199 and Guitar/Drums/Bass/Keys transform 123/186/129/20. Test-only transform policy evidence was respectively Guitar F1/precision/recall `0.3731/0.2311/0.9675`, Drums `0.4545/0.3068/0.8761`, Bass `0.3755/0.2419/0.8389`, and Keys `0.2720/0.1574/1.0`; every bundle correctly failed the immutable F1 ≥ 0.50 and precision/recall ≥ 0.45 promotion policy, so no profile was packaged. The Drums smoke yielded test F1 `0.09010` and remains a raw checkpoint. OCTAVE's live Electron flow inspected the same approved Guitar catalog (145 eligible), prepared an immutable task view, submitted a real training job, and discovered a raw transform bundle as verified but `Not deployable` with zero profiles and no enabled default action. Screenshots are retained outside source control as acceptance evidence.

   `c67ba6a` extends the same boundary with clone-only, explicit audio-enrichment revisions for an already-cataloged MIDI chart. It revalidates the selected package snapshot and locator, changes only named audio assets, preserves record rights/chart identity, rejects case-colliding ZIP entries and ambiguous RB3CON MOGGs, and cannot publish a partial revision. It is not an approval mechanism: enrichment still requires an approved candidate and a new catalog revision.

7. **Pending external release authority:** opt-in managed pinned-release acquisition, verification, locking, update/rollback, and offline behavior. Implement only once STRUM publishes an immutable revision plus verification hash/signature; OCTAVE must not clone or update arbitrary source at runtime. Until then, a packaged build fails closed when no validated Deploy profile is active rather than downloading a mutable STRUM source fallback.
8. **Planned learned models:** quality-grade (not smoke-grade) held-out evaluation and promotion of the Guitar/Bass/Keys and chart-transform profile paths; OCTAVE materialization of the isolated Harmony sidecar/assets, then Vocal harmony composition, evaluation, and profile; mapper evaluation plus safe composed runtime; Section chart-impact ablation and composed runtime; and Pro-instrument evaluated free-running sequence models, packaging, and deployable profiles on the unchanged catalog boundary.

**Lead-Vocal correction:** `strum-owned-lead-catalog-task-admission-resolver/v1` is implemented. It revalidates all four task views and rejects the current catalog from actual source and label counts; catalog expansion needs approved data, not a future resolver.

**2026-08-24 approved-catalog correction:** The local-only user-approved SMB catalog
`octave-smb-approved-local-20260823` now contains 212 `allowed` records. STRUM's
Lead-Vocal preparation requires an exact mido-readable `PART VOCALS` track and a
complete libsndfile stream decode of its declared preferred/fallback audio before
publishing a task view; the current shared-seed activity view admits 18 records.
All four Lead-Vocal views now share that corpus and its source partition is 10
Train / 4 Validation / 4 Test, below the STRUM-owned 40 / 10 / 10 minimum for
lead-chart composition or promotion.
Catalog inspection reports three audio-policy/full-decode exclusions and three
MIDI exclusions as aggregate-only readiness reasons, never paths or source
identifiers. The task view separately records its additional decoder rejection
after initial role selection; both operations select the same 18 records. A
bounded CUDA activity smoke created the raw `vocals.frame_activity_pitch`
experiment bundle with no profile or deployment capability. Its one-epoch
metric is only an execution smoke, not quality or promotion evidence.

**Current descriptor-readiness snapshot:** On that catalog, STRUM resolves
Guitar 145, Bass 133, Keys 28, Drums 199, Vocal component/generic paths 18,
Pro Guitar 8, Pro Bass 8, Pro Keys 2, Guitar/Bass mapper 145/133, and
Guitar/Bass section 145/133 eligible records. All are catalog-ready task or
experiment paths; zero eligible `vocals.harmony-source-policy/v1` records is
expected until OCTAVE materializes explicitly approved isolated Harmony assets
and its sidecar. These counts are readiness evidence, not deployment-quality
claims.
For the learned Expert-to-Hard transform, the explicit Guitar/Bass/Keys/Drums
selections resolve 138 / 139 / 21 / 199 catalog chart pairs respectively.

**2026-08-24 bounded source-inventory sample:** A real five-minute,
read-only pass over the mounted 280-package SMB group settled 198 packages
(196 completed: 195 readable and one rejected; two timed out). Among the
readable completed packages it found 144 MIDI-backed charts, 49 chart-only
packages, and 95 with an exact canonical `PART VOCALS` track; no duplicate
MIDI/container identities were reported in that completed subset. This is a
lower bound only because the job returned `cancelled: true` at its deadline.
Chart-only packages are not Vocal-label candidates under the current
MIDI-first contract. The next catalog expansion pass must use only reviewed,
MIDI-backed sources and preserve the existing rights/consent boundary.

**2026-08-24 resumed source-inventory completion:** The same process followed
the inventory's opaque cursor to completion: all 280 packages settled, with
270 completed inspections (268 readable/header-valid, two rejected), 200
MIDI-backed charts, 66 chart-only packages, and 143 exact canonical
`PART VOCALS` sources. Ten bounded package decodes timed out and two failed;
there were no duplicate MIDI/container identities, unavailable identities, or
inventory-limit hits. This identifies a sufficient _review pool_ for a
consent-controlled, MIDI-only Vocal catalog expansion. It remains inventory
evidence—not automatic approval, materialization, training, or deployment.

**2026-08-24 approved Vocal expansion result:** After explicit approval through
the snapshot-bound per-chart bridge, all 143 canonical-Vocal candidates
deduplicated against the inherited catalog by exact `notes.mid` hash. The
atomically published `octave-smb-approved-vocal-expansion-20260824` revision
therefore remains at 212 allowed records and adds zero records; no source data
was overwritten. All four Vocal pipelines inspect and prepare successfully
with the same 18 eligible records and a 13 / 3 / 2 Train / Validation / Test
partition. Lead admission confirms that every per-label count minimum passes;
only the 40 / 10 / 10 source coverage gate fails. The current limitation is
therefore verified coverage and audio/difficulty quality—not catalog import
mechanics. New approved source material with enough Expert Vocal coverage is
required to reach the Lead-Vocal gate.

Every delivery needs shared protocol fixtures and a real-catalog smoke test. Integration tests must prove that no original source path crosses into a task view, experiment/checkpoint manifest, renderer payload, progress event, log, or user-visible error.
