# STRUM training: charter workflow, contracts, and scaling roadmap

This document explains the training workflow implemented for OCTAVE and the work needed to turn it into a reliable personal-charting system. It complements the [orchestration contract](strum-orchestration-contract.md), [illustrated training tutorial](../docs/guide/strum-training.md), and [catalog contract](../docs/reference/song-source-catalog.md).

**Current scope:** OCTAVE can curate approved local sources, prepare STRUM datasets, supervise training and supported fine-tuning, evaluate candidates, package qualifying profiles, and explicitly select and execute a learned MIDI difficulty transform. These are working software paths. They do not establish that a trained model has learned a charter's style or produces release-quality charts.

**Current evidence:** the [approved-catalog worker report](../scripts/acceptance/evidence/2026-09-05-worker-real.json) records a failed quality gate and correctly rejected deployment. The [synthetic positive report](../scripts/acceptance/evidence/2026-09-05-worker-positive.json) and [Electron UI report](../scripts/acceptance/evidence/2026-09-05-ui.json) demonstrate the passing software path, including actual MIDI output and retained history after restart. The synthetic result is an execution fixture, not a musical-quality benchmark. Screenshots in the accompanying pull request show these states; the reports and [acceptance instructions](../scripts/acceptance/README.md) provide their reproducible context.

## Visual evidence from OCTAVE

These are actual Electron screenshots, captured without changing the application's rendered text or results. Preparation, evaluation and deployment come from the successful 10-stage isolated acceptance run against OCTAVE `81f0f6c` and STRUM `b32fa0a`. The Curate screenshot was captured later from the same isolated history, with the consent explanation corrected to match generated-source exclusion. The fine-tune screenshot is a newly captured configuration state using the same isolated acceptance history. No additional fine-tuning run was started for that image, and the user's active OCTAVE settings were not used.

### Curate an approved catalog

The selected approved catalog contains 212 package-backed records. The screen exposes catalog selection, revision controls, permission basis, provenance, and the boundary between existing records and newly selected library/package inputs. The bottom zero counts describe this editor session's new selections, not the selected catalog's 212 retained records. This is a catalog inspection capture, not a new publication run; Harmony-source validation is still in progress in the image.

![OCTAVE Curate screen showing the selected approved catalog, permission basis, provenance, and revision controls](../docs/public/screenshots/strum-training/curate-approved-catalog.png)

<details>
<summary>1. Prepare an approved local library</summary>

STRUM reports 138 eligible Guitar Expert/Hard sources from the approved catalog; preparation produces 123 usable paired records. Readiness and prepared-record counts describe different stages. The screen exposes the target difficulty, source-disjoint split seed, and audio requirements.

![OCTAVE Prepare screen showing the approved catalog, 138 eligible sources, Hard target difficulty, and song-disjoint split](../docs/public/screenshots/strum-training/prepare-approved-library.png)

</details>

<details>
<summary>2. Configure a new fine-tuning run from a verified parent</summary>

The Train screen selects a prepared task, `fine_tune` mode, and a completed parent candidate. The displayed model name is an example chosen for this capture; it does not represent a trained or quality-approved style model. STRUM checks compatibility, and fine-tuning creates a new candidate rather than overwriting the parent or resuming optimizer state.

![OCTAVE Train screen showing fine_tune mode, prepared task, compatible hidden dimension, and selected parent candidate](../docs/public/screenshots/strum-training/fine-tune-parent.png)

</details>

<details>
<summary>3. Review evaluation evidence before promotion</summary>

The real one-epoch candidate remains experiment-only. STRUM's held-out result records the failed quality gate; the acceptance run verifies that packaging and deployment reject it. This screen is evidence of the current UI, including its dense metadata presentation; it is not a polished mockup.

![OCTAVE evaluation and packaging controls with candidate identity and failed quality policy evidence](../docs/public/screenshots/strum-training/evaluate-candidate.png)

</details>

<details>
<summary>4. Explicitly activate a validated profile and generate MIDI</summary>

The independently trained synthetic identity fixture passes the unchanged gate, is inspected and explicitly saved as the isolated app's default, and produces `notes.mid` plus `run.json` through **Transform MIDI**. The harness also verifies generated-source markers in `song.ini` and persistence after restart. Synthetic success demonstrates execution, not musical quality or stylistic personalization.

![OCTAVE Deploy screen showing a validated learned-transform default and successful notes.mid and run.json generation](../docs/public/screenshots/strum-training/deploy-transform-result.png)

</details>

## 1. Who owns the data and decisions?

OCTAVE owns user choices, source approval, local storage, process supervision, and profile selection. STRUM owns interpretation of the approved catalog: task requirements, labels, features, splits, model behavior, evaluation, promotion policy, and output charts. The renderer never receives the private locations used to execute a job.

```mermaid
flowchart TB
  subgraph Sources["User-controlled local sources"]
    Library["Human-authored library charts<br/>MIDI and available audio"]
    Packages["Source packages<br/>bounded inspection and review"]
    Consent["Explicit inclusion decision<br/>not inferred from possession"]
    Output["Generated chart output<br/>review and edit in OCTAVE<br/>excluded from automatic training admission"]
    Library --> Consent
    Packages --> Consent
  end

  subgraph Host["OCTAVE main process: ownership and orchestration"]
    Materialize["Materialize approved assets<br/>deduplicate and verify hashes"]
    Catalog["Catalog revision<br/>octave-song-source-catalog/v1<br/>allowed records and relative asset references"]
    Binding["Private bindings<br/>catalog root, task root, run root<br/>opaque IDs and pinned identities"]
    Integrity["Prepared artifact verification<br/>manifest and directory sidecars<br/>streamed hashes and contained regular files"]
    Registry["Durable task, run, and promotion history<br/>candidate and profile identities"]
    Select["User explicitly selects a<br/>validated default profile"]
    Materialize --> Catalog
    Catalog --> Binding
    Integrity --> Registry
    Registry --> Select
  end

  subgraph Runtime["STRUM worker: model and task authority"]
    Inspect["Descriptor and eligibility inspection<br/>pipeline-specific requirements"]
    Prepare["Prepare task view<br/>source partitions, labels, features<br/>catalog and preprocessing lineage"]
    Train["Train or supported fine-tune<br/>new experiment and candidate bundle"]
    Evaluate["Held-out evaluation<br/>immutable STRUM quality policy"]
    Gate{"Quality and lineage<br/>gates pass?"}
    Candidate["Raw candidate retained<br/>not deployable"]
    Package["Recompute required evidence<br/>write a separate profile bundle"]
    Execute["Typed preflight and chart run<br/>exact profile, policy, and manifest"]
    Inspect --> Prepare
    Train --> Evaluate
    Evaluate --> Gate
    Gate -->|No| Candidate
    Gate -->|Yes| Package
  end

  subgraph UI["OCTAVE renderer: safe user interface"]
    Controls["Curate / Prepare / Train / Deploy<br/>descriptor-declared controls"]
    Status["Opaque IDs, counts, metrics<br/>sanitized progress and errors"]
  end

  Consent --> Materialize
  Catalog -->|Managed assets only| Inspect
  Controls -->|User intent and safe IDs| Binding
  Binding -->|Private worker request| Prepare
  Prepare -->|Owned output location| Integrity
  Integrity -->|Revalidate before use| Train
  Train -->|Re-inspected bundle identity| Registry
  Candidate --> Registry
  Package -->|Discover and validate| Registry
  Select --> Execute
  Execute -->|New notes.mid and run.json<br/>generated provenance preserved| Output
  Registry --> Status
  Runtime -->|Path-free protocol results| Binding
  Binding -->|Sanitized DTOs| Status
```

Generated output follows a separate chart-authoring path. Recognized generated output remains excluded from training, even when it is imported into the library or its opt-in metadata is changed. The future correction workflow is described below.

### Artifact boundaries

| Artifact                       | Producer and responsibility                                                                                                                                              | What OCTAVE binds or exposes                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approved catalog revision      | OCTAVE materializes reviewed assets and records their identities. STRUM validates catalog records and asset hashes.                                                      | Private root stays in main; renderer uses catalog ID, display name, and aggregate eligibility.                                                           |
| Prepared task                  | STRUM declares labels, preprocessing, source splits, and task lineage. A task can be one manifest or a directory with paired data.                                       | Main verifies the manifest and accompanying directory tree before training. Changing a sidecar such as `pairs.jsonl` invalidates the prepared task.      |
| Candidate experiment           | STRUM writes model/configuration hashes, task provenance, metrics, and parent lineage where supported. Bundle layout can be the run root or a declared nested directory. | Main resolves only contained bundle locations and re-inspects the returned identity before registering a candidate.                                      |
| Evaluation and profile package | STRUM applies its fixed quality gate and recomputes required evidence during packaging.                                                                                  | Main supplies registered private task/catalog locations; renderer cannot lower a gate or select an arbitrary evidence path.                              |
| Default profile                | User selection, followed by STRUM validation of an executable capability and difficulty policy.                                                                          | Stored artifact/manifest identity is checked again before use. Training completion does not change the default.                                          |
| Generated chart                | STRUM executes a preflight-bound profile and writes typed output artifacts.                                                                                              | OCTAVE verifies output hashes and preserves generated provenance; a transform selection returns safe artifact names rather than private input locations. |

Directory integrity verification is bounded to 10,000 entries and 64 GiB of aggregate prepared content. Hashes are streamed rather than loading the tree into memory. These are current local artifact limits, not promises of distributed training capacity.

## 2. What makes a job complete?

The UI is not the training process. OCTAVE's main process writes a private request, launches the selected versioned worker, interprets its protocol, and owns cancellation and durable history. A terminal success event alone is insufficient: the process must exit successfully and OCTAVE must verify the resulting artifacts.

```mermaid
sequenceDiagram
  autonumber
  actor Charter
  participant UI as OCTAVE renderer
  participant Main as OCTAVE main
  participant Store as Private registry and artifacts
  participant Worker as STRUM worker process

  Charter->>UI: Select runtime, catalog, pipeline, and options
  UI->>Main: Safe IDs and descriptor-declared values
  Main->>Worker: probe / pipeline list / catalog inspect
  Worker-->>Main: Versioned capabilities, schemas, eligibility
  Main-->>UI: Safe runtime and readiness information

  Charter->>UI: Prepare or Train
  UI->>Main: Start request with opaque task or catalog ID
  Main->>Store: Resolve catalog or task IDs to private bindings
  opt Train request uses an existing prepared task
    Main->>Store: Revalidate prepared manifest and sidecar content
  end
  opt Fine-tune supported by descriptor
    Main->>Store: Re-inspect registered parent identity
    Note over Main,Worker: Parent root stays private, STRUM checks compatibility
  end
  Main->>Store: Write private request, retain job identity
  Main->>Worker: dataset prepare / train start with JSON events
  Worker-->>Main: Sequenced lifecycle and progress events
  Main-->>UI: Sanitized status, metrics, and job ID

  alt User cancels
    Charter->>UI: Cancel
    UI->>Main: Cancel job ID
    Main->>Worker: Signal process tree, escalate if needed
    Worker-->>Main: Process closes
    Main->>Store: Retain cancelled history, clean owned request files
    Main-->>UI: Cancelled, no successful candidate registration
  else Worker emits success
    Worker-->>Main: Terminal succeeded result
    Note over Main,Store: Success is still provisional
    Worker-->>Main: Successful process exit
    Main->>Store: Resolve contained output and verify task artifacts
    opt Completed training result
      Main->>Worker: checkpoint inspect for the contained bundle
      Worker-->>Main: Verified artifact and manifest identities
    end
    alt Artifact verification passes
      Main->>Store: Register prepared task or raw candidate
      Main-->>UI: Completed result with opaque identity
    else Missing, mismatched, or escaped artifact
      Main->>Store: Retain failure history
      Main-->>UI: Sanitized failure, no accepted candidate
    end
  else Worker fails or exits unexpectedly
    Worker-->>Main: Failed event or nonzero exit
    Main->>Store: Retain failure history
    Main-->>UI: Sanitized failure
  end

  Charter->>UI: Evaluate candidate, then request Package
  UI->>Main: Candidate ID and advertised promotion job
  Main->>Store: Resolve candidate, task, catalog, and evidence bindings
  Main->>Worker: promotion start with JSON events
  Worker->>Worker: Evaluate or recompute evidence and apply fixed gate
  Worker-->>Main: Result and process exit
  Main->>Store: Retain evidence, re-inspect any packaged profile
  Main-->>UI: Quality outcome and available profile actions
  Charter->>UI: Explicitly select validated default
  UI->>Main: Save selected profile identity and difficulty policy
  Main->>Worker: inference profile validate
  Main->>Store: Persist exact default identity
```

A failed quality gate is a legitimate result of evaluation. It prevents packaging; it does not mean the training process crashed. A raw candidate remains available for inspection or a supported new fine-tune run, but cannot bypass promotion by being selected as a default.

For **Transform MIDI**, native dialogs choose the Expert source MIDI, optional aligned audio, and an output folder. Main passes `source_midi_path` and `song_path` privately. STRUM's capability set must include `chart_preflight`, `chart_run`, and `typed_chart_results`; the legacy `chart` label alone does not establish this contract. Cancellation during native selection stops the remaining dialog flow when the active dialog returns.

## 3. How can a charter train toward their own style today?

The current personal-training path is strongest for **learned difficulty transforms**. A charter can curate reviewed, human-authored songs containing Expert and target-difficulty charts, prepare the instrument/difficulty task, and train on those examples. Fine-tuning is supported only where the selected descriptor advertises it; it is not a universal option for every STRUM component.

1. **Choose consistent examples.** Build an approved catalog from charts whose target-difficulty decisions reflect the desired style. For a Guitar Expert-to-Hard transform, the training evidence is the paired Expert and Hard chart data selected by STRUM. Unrelated library tracks do not become training labels merely by being present in a folder.
2. **Prepare a new immutable task.** Select the instrument and target difficulty. Optional audio conditioning must be selected during preparation and remains bound to the resulting task and candidate; adding a catalog location later does not change the model's modality.
3. **Choose Fresh or an eligible Fine-tune parent.** For fine-tuning, select a registered compatible candidate through its opaque artifact ID. OCTAVE verifies its bundle identity; STRUM checks the architecture, task/configuration compatibility, and checkpoint provenance. This initializes a **new run** from the parent weights. It does not resume the parent's optimizer/scheduler session or rewrite that parent.
4. **Evaluate on unseen sources.** Transform checkpoint and decoder selection use Calibration; promotion evidence is measured on Test. Do not repeatedly choose training settings against Test and then call it unseen evidence. Preserve a separate final charter-review set when comparing many personal experiments.
5. **Promote only after the existing gate passes.** STRUM owns the thresholds and evidence checks. Explicitly select a validated packaged profile; retain prior profiles for manual switching back.
6. **Generate and inspect charts.** Transform a source Expert MIDI using the selected profile, then review the result in the editor and in play. Musical quality and playability require judgment beyond aggregate lane metrics.

A model ID or profile name labels an experiment; it is not a style instruction. There is no natural-language “chart like me” control. Style can only be reflected through the supported training data, task representation, and model capacity. The current transform predicts lane activity at the source chart's event times using lane/context features and optional audio features. It does not constitute an unrestricted arrangement, timing, sustain, or articulation model, and it cannot be assumed to learn every preference expressed by a charter's edits.

The opportunity for charters is to define their preferred reduction through examples: which source events survive into Hard, which lanes or chords are retained, and how dense that result should feel. A consistently authored library can supply those targets, and a compatible parent can provide a starting point for a new experiment. Keep contrasting styles in separately reviewed datasets and named profiles so a charter can evaluate and select each deliberately. Whether those preferences generalize must be demonstrated on unseen songs and through playtesting; the present acceptance fixture does not establish it.

### Current authoring loop and planned correction loop

Solid paths below are available today. Dashed paths describe unimplemented generated-chart revision admission. They must not be presented as enabled features.

```mermaid
flowchart TD
  Human["Reviewed human-authored charts<br/>with usable Expert and target labels"]
  Approve["Explicit source inclusion<br/>publish catalog revision"]
  Task["STRUM Prepare<br/>immutable labels, source partitions,<br/>and optional audio modality"]
  Mode{"Descriptor supports<br/>requested training mode?"}
  Fresh["Fresh candidate run"]
  Parent["Registered parent candidate<br/>OCTAVE checks artifact identity<br/>STRUM checks compatibility"]
  FineTune["Fine-tune into a new run<br/>parent weights plus new approved task<br/>no optimizer-state resume"]
  Test["STRUM Calibration / Test evaluation<br/>fixed promotion gate"]
  Pass{"Gate passes?"}
  Retain["Keep raw candidate and metrics<br/>not deployable"]
  Deploy["Package, validate, then<br/>explicit default selection"]
  Generate["Transform source MIDI<br/>generated provenance retained"]
  Edit["Charter reviews and edits output<br/>ordinary editor workflow"]
  Block["CURRENT: recognized generated charts<br/>remain excluded from training"]

  Human --> Approve --> Task --> Mode
  Mode -->|Fresh available| Fresh
  Mode -->|Fine-tune available| Parent --> FineTune
  Fresh --> Test
  FineTune --> Test
  Test --> Pass
  Pass -->|No| Retain
  Pass -->|Yes| Deploy --> Generate --> Edit
  Generate --> Block
  Edit --> Block
  Retain -->|Choose compatible parent for another run| Parent

  Baseline["PLANNED: preserve canonical generated baseline<br/>model and source-input provenance"]
  Revision["PLANNED: immutable edited revision<br/>instrument-aware semantic change evidence"]
  Review["PLANNED: explicit approval bound to revision<br/>later edits invalidate approval"]
  Admission["PLANNED: revision-aware catalog admission<br/>related versions grouped to prevent leakage"]
  Generate -.-> Baseline
  Baseline -.-> Revision
  Edit -.-> Revision
  Revision -.-> Review -.-> Admission -.-> Approve

  classDef planned fill:#fff7ed,stroke:#c2410c,stroke-dasharray:5 5,color:#431407
  classDef blocked fill:#fef2f2,stroke:#b91c1c,color:#450a0a
  class Baseline,Revision,Review,Admission planned
  class Block blocked
```

The planned loop needs more than an opt-in checkbox. OCTAVE must preserve a baseline, prove a meaningful chart-level change, and bind consent to that exact accepted revision. Deleting generated provenance, renaming a song, changing `dataset_opt_in`, or editing metadata cannot substitute for those missing guarantees. Older catalogs are not retroactively certified by the new exclusion checks; consult the [generated admission rules](../docs/reference/song-source-catalog.md#generated-chart-admission).

## 4. Scaling roadmap and release gates

These are ordered engineering phases, not committed delivery dates. The existing implementation is a local pipeline; a larger catalog, more GPU memory, or more epochs does not by itself establish better style learning or safe promotion.

| Phase                                                     | Current foundation                                                                                                                                                   | Additional implementation or evidence                                                                                                                                                                                                               | Exit criterion                                                                                                                                                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 — Reproducible local execution**                      | Explicit compatible runtime selection, versioned worker protocol, catalog preparation, protected artifacts, job lifecycle, promotion, and typed transform execution. | Keep the accepted companion revision and environment documented; rerun process and UI acceptance when a boundary changes.                                                                                                                           | Clean builds/tests plus both a rejected real-catalog candidate and a separately labeled positive execution fixture. This does not certify model quality.                                                       |
| **1 — Useful personal transform quality**                 | Approved paired charts, fresh/fine-tune runs, source-disjoint evaluation, fixed promotion policy.                                                                    | Assemble sufficient consistent human-authored examples; document genre/instrument/difficulty coverage; compare candidates with a reserved final evaluation set and charter playtests.                                                               | Candidate passes the unchanged STRUM policy and documented human review on genuinely unseen songs. No automatic default change.                                                                                |
| **2 — Larger local catalogs and runs**                    | Bounded/resumable source inventory, catalog revisions, streamed integrity checks, private artifacts, durable history.                                                | Measure preparation/training/storage bottlenecks; design content-addressed reusable caches, storage estimates, retention controls, and sharded dataset readers where needed. Preserve lineage across caching/sharding.                              | A declared larger workload completes within measured resource budgets, without weakening source approval, artifact integrity, or cancellation. Current tree limits remain explicit until deliberately revised. |
| **3 — Verified correction admission**                     | Generated provenance and a fail-closed exclusion boundary.                                                                                                           | Baseline/revision storage, instrument-aware semantic diffs, revision-bound approval, deduplication and grouping of related revisions across splits, auditable retraction.                                                                           | An edited generated chart can enter a new catalog only with verifiable baseline/change/approval evidence; unchanged or metadata-only revisions remain rejected.                                                |
| **4 — Broader model composition**                         | Descriptor-advertised Vocal/Pro/mapper/section experiments and existing instrument-specific gates.                                                                   | Implement and evaluate missing composed models, checkpoint contracts, companion/runtime handlers, and chart-level quality tests. Keep experiment-only capabilities explicit.                                                                        | Each claimed chart capability has its own end-to-end held-out evidence and registered execution handler. Component accuracy alone is insufficient.                                                             |
| **5 — Managed releases and additional execution targets** | Developer checkout and installed-worker selection; local process lifecycle.                                                                                          | Publish immutable verified runtime releases; then implement opt-in acquisition, locking, update/rollback and offline behavior. Design remote/multi-GPU scheduling only with explicit data-location, cancellation, and artifact-ownership contracts. | Reproducible verified installation and supported-platform acceptance. No mutable-branch downloads or implicit transfer of private catalogs.                                                                    |

### Limitations reviewers should keep visible

- **Quality:** the current approved-catalog transform result remains below its immutable promotion gate. The synthetic identity profile proves that the software can complete the positive path; it is not a production personal model.
- **Training modes:** chart-transform fine-tuning starts a new experiment from a verified compatible parent. Portable optimizer-state resume remains unsupported.
- **Input modality:** a learned difficulty transform requires source MIDI. Audio-conditioned profiles additionally require compatible aligned audio; audio-only Auto-Chart is a different inference contract.
- **Instrument capabilities:** Guitar/Bass/Keys Expert profiles require their profile-grade admission and Test gates. A trained Drums onset evaluator is distinct from the existing V14 audio-to-chart profile. Vocal, Pro, mapper, and section components do not imply completed composed chart profiles.
- **Feedback:** recognized generated-chart corrections cannot yet be admitted as training sources, because baseline/revision verification is not implemented. Ordinary chart editing remains available.
- **Deployment:** source approval, packaging, and default selection are separate user-controlled decisions. No background training loop silently opts songs in or activates a candidate.
- **Scale and portability:** current evidence covers the recorded local environment and bounded runs. Distributed training, every operating system, a signed runtime distribution, and large-library performance are not established by the present acceptance reports.

## Review map

- [User workflow and setup](../docs/reference/strum-training.md)
- [Catalog ownership and generated-source admission](../docs/reference/song-source-catalog.md)
- [Detailed OCTAVE–STRUM contract and historical evidence](strum-orchestration-contract.md)
- [Acceptance commands and evidence interpretation](../scripts/acceptance/README.md)
- [Worker and UI evidence files](../scripts/acceptance/evidence/)

The diagrams document the existing ownership boundary and the proposed next steps. Only the paths explicitly marked current should be used to describe shipped behavior in the pull request.
