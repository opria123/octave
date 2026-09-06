# Train a STRUM difficulty transform

This tutorial takes an approved local library through **Prepare → Train → Evaluate → Package → Deploy**, then shows how to start a new fine-tuning run. The example is a **Guitar Expert-to-Hard MIDI transform**: it needs an existing Expert chart and learns from human-authored Hard charts. It is not an audio-only transcription tutorial.

A successful training process produces an experiment candidate. You can generate charts with it only after STRUM's evaluation and packaging gates pass and you explicitly activate its profile. A short first run can verify your setup while still failing the quality gate.

## Before you start

You need:

- An OCTAVE build containing the Training window and versioned STRUM integration. This tutorial accompanies [OCTAVE PR #70](https://github.com/opria123/octave/pull/70); it is not a claim that an older packaged release contains these features.
- A compatible STRUM training runtime. The companion implementation is [STRUM PR #7](https://github.com/opria123/strum/pull/7). Installing an inference runtime alone does not provide training support.
- Human-authored MIDI charts you are permitted to use for training, with both **Expert** and **Hard** data for Guitar. A folder of audio files alone does not supply these paired labels.
- Disk space for copied catalog assets, prepared datasets, candidates, and packaged profiles. Keep original sources separate from generated output.

Start with **chart-only** preparation (`Audio Feature Mode: none`) and CPU execution to reduce setup dependencies. Use enough distinct songs to support source-disjoint training and evaluation. A handful of charts can be useful for diagnostics but does not establish musical quality.

## 1. Install and select the training runtime

For a reproducible developer setup before the companion PR is merged, use the reviewed fork revision below. Run these commands in a new working directory; they do not install an official managed runtime release.

```sh
git clone https://github.com/AshMartian/strum.git strum-training
cd strum-training
git checkout b32fa0a0943a75184999edfe87c4ce38225d833f
python3.12 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
.venv/bin/python -m pip install '.[dev]'
.venv/bin/python -m src.worker probe --json
.venv/bin/python -m src.worker pipeline list --json
```

The probe must complete successfully, and the pipeline list must include `chart_transform.five_lane/v1`. The explicit CPU wheels above are suitable for this first-run example. For GPU training, use a PyTorch installation compatible with your hardware; a GPU selection cannot add CUDA support to a CPU-only installation.

On Windows, create the environment with `py -3.12 -m venv .venv` and replace `.venv/bin/python` with `.\.venv\Scripts\python.exe` in PowerShell. The recorded full UI acceptance was on Linux; Windows and macOS release behavior needs its own validation. Keep the checkout’s `.venv` directory for this setup. An explicit `OCTAVE_STRUM_PYTHON` environment variable takes precedence over that environment, so remove a stale override or point it at the intended compatible interpreter before launching OCTAVE.

Run OCTAVE as a development build for checkout selection; packaged builds require an installed worker and do not expose **Choose STRUM checkout**. Open OCTAVE, click **Train** in the toolbar, then open **Prepare**. Click **Choose STRUM checkout** and select the `strum-training` repository directory, not its `src` directory or its Python executable. Wait for runtime verification. Alternatively, **Select STRUM runtime** selects an installed worker executable.

If a compatible runtime is already selected, setup buttons may not be shown. See the [runtime and capability reference](/reference/strum-training) for the supported runtime types. Training setup does not silently select a model or change your Auto-Chart default.

## 2. Create or select an approved catalog

In **Curate**, use **Catalog parent → Choose** to select the folder that will contain catalog directories.

For an existing approved catalog, choose its row under that parent. Select the parent directory first, not the catalog's asset subdirectory.

For a new catalog:

1. Open your song library in OCTAVE's editor so its human-authored songs appear in **Octave library**.
2. Choose **New catalog**, then enter a **Catalog ID**, **Catalog name**, **License / permission basis**, and **Provenance** describing your inclusion decision.
3. Select the reviewed songs you intend to include. For package sources, inspect and inventory the source group, review the individual chart candidates, and explicitly select those to materialize. Inventory alone does not approve or import training records.
4. Click **Create catalog** and wait for completion. Choose the resulting catalog row.

Use **Clone as revision** when creating a new reviewed version of an existing catalog. Prepared tasks retain their existing snapshot; editing a catalog does not update an already prepared training task.

Recognized STRUM-generated charts are currently excluded from supervised training. Manual edits, a renamed song, or an opt-in checkbox do not unlock them: preserved-baseline and approved-revision verification is still unimplemented. Human-authored training examples and generated charts you edit for play remain distinct workflows. See [catalog admission](/reference/song-source-catalog#generated-chart-admission).

![Curate an existing approved catalog, including its permission basis and provenance](/screenshots/strum-training/curate-approved-catalog.png)

This capture inspects the existing 212-record approved catalog; it does not create a new catalog. The bottom zero counts refer to new selections in this editor session, while existing package-backed records are retained. Harmony-source validation is still in progress in this capture.

## 3. Prepare Expert/Hard pairs

Return to **Prepare** and select:

| Control            | First-run choice                       | Why                                                                            |
| ------------------ | -------------------------------------- | ------------------------------------------------------------------------------ |
| Pipeline           | Learned five-lane difficulty transform | Uses paired chart labels rather than an audio-to-chart task.                   |
| Instrument         | `guitar`                               | Matches the instrument in your examples.                                       |
| Target Difficulty  | `Hard`                                 | Requires usable Expert and Hard chart data.                                    |
| Audio Feature Mode | `none`                                 | Prepares a chart-only task.                                                    |
| Split Seed         | Keep and record the displayed value    | STRUM assigns source-disjoint partitions reproducibly.                         |
| Other controls     | Keep the descriptor defaults           | Do not change split settings merely to force a small corpus through promotion. |

Wait for **Eligible guitar songs** to finish checking. If it is zero, inspect the source labels and exclusion information before continuing. The count can be smaller than the catalog because not every song has the required instrument, difficulty, or verified assets.

Click **Prepare Learned five-lane difficulty transform Dataset**, wait for terminal completion, and select the resulting entry in **Prepared task views**. A later usable-record count can differ from initial eligibility: the accepted example reported 138 eligible sources and prepared 123 usable pairs. Those are example results, not minimum requirements or counts your library should reproduce.

![Prepare an approved catalog and inspect STRUM eligibility](/screenshots/strum-training/prepare-approved-library.png)

For an audio-conditioned transform, choose the advertised audio mode and roles during preparation. It needs appropriately aligned approved audio. Adding audio or a catalog location after training cannot change a chart-only candidate into an audio-conditioned model.

## 4. Run a small first training experiment

Open **Train** and choose your **Prepared task view**. For a bounded CPU setup check, use:

| Control         | Example value                                                 |
| --------------- | ------------------------------------------------------------- |
| Model Id        | `my-library-hard-check`                                       |
| Checkpoint Mode | `fresh`                                                       |
| Device          | `cpu`                                                         |
| Epochs          | `1`                                                           |
| Hidden Dim      | `8`                                                           |
| Lane Count      | Keep the pipeline's five-lane default                         |
| Other controls  | Keep the displayed defaults; record them for later comparison |

Click **Start local Learned five-lane difficulty transform run**. Wait for a completed result and an entry under **Recent runs**. Merely submitting the job does not prove success: OCTAVE waits for the worker to exit successfully and verifies the returned bundle before registering it.

You may close the Training window while OCTAVE remains running; the main process owns the job. **Cancel job** terminates the worker process tree and retains cancelled history. Quitting the application is not optimizer-state resume: interrupted work must be retried or replaced with a supported new fine-tuning run.

The result should still be marked **experiment only**. One epoch and a small hidden dimension are diagnostic choices, not recommended settings for a quality model. Choose subsequent training settings using training and Calibration evidence, while preserving Test for held-out evaluation.

## 5. Evaluate and understand the result

Under **Evaluate and package a candidate**, choose the completed **Trained candidate**, set the advertised evaluation device, and click **Evaluate candidate**. Wait for the result.

For the pinned transform runtime, the canonical gate requires held-out lane F1 of at least **0.50**, precision of at least **0.45**, and recall of at least **0.45**, together with valid source partitions, candidate/task lineage, and recomputable evidence. Other pipelines have their own admission and quality contracts. Changing thresholds is not an OCTAVE training option.

The UI currently exposes the gate status and evidence identities in a dense result panel; it does not provide a complete model-comparison dashboard. The accepted real-catalog one-epoch run achieved F1 **0.4380**, precision **0.2993**, and recall **0.8163**, so packaging was correctly rejected.

![Inspect the real candidate's evaluation and packaging controls](/screenshots/strum-training/evaluate-candidate.png)

If your gate fails, keep the candidate for diagnosis or compatible fine-tuning. Improve coverage, consistency, or training based on appropriate evaluation data, then evaluate a new candidate. Do not activate the raw candidate, relabel evidence, or treat successful training as proof of playability. Repeatedly tuning against Test also makes it unsuitable as an unbiased final evaluation set.

## 6. Package a passing candidate and activate it

Continue only after the candidate meets STRUM's promotion requirements:

1. In the package action, enter a distinct lowercase **Profile Id**, using letters, digits, dots, or hyphens, such as `my-library-hard-v1`.
2. Click **Package profile** and wait. STRUM rechecks the candidate and evidence and writes a separate immutable profile package; this can take additional computation.
3. A successfully registered package can take you to **Deploy** with its candidate selected. If selecting an existing package instead, click **Choose model-bundle folder**, choose the packaged bundle, then click its **Inspect** row. Discovery alone is not profile selection.
4. Verify the **STRUM profile** and **Difficulty policy**. A Guitar Expert-to-Hard transform uses `learned:chart_transform.guitar.expert_to_hard`.
5. Click **Validate & save as Auto Chart default**. This is the explicit activation step; training and packaging do not activate a default automatically.

Do not choose an arbitrary `.pt` file or a raw experiment folder. OCTAVE saves and rechecks the exact verified profile and manifest identity. If the bundle changes or its runtime loses required typed chart capabilities, that default is no longer accepted.

## 7. Generate a chart and review it

In **Deploy**, a selected learned-transform default exposes **Use the learned transform**:

1. Leave **Provide aligned audio for an audio-conditioned profile** off for this chart-only example. Enable it only when the selected profile requires aligned audio.
2. Click **Transform MIDI** and select the source Expert MIDI. If enabled, select its aligned audio in the next dialog.
3. Select the output parent folder. OCTAVE creates a new `strum-transform-…` child directory.
4. Wait for the message confirming `notes.mid` and `run.json`. The output also carries generated-source markers in `song.ini`.
5. Open the output song folder in OCTAVE, inspect the generated target difficulty, and playtest it. Check musical intent and playability as well as the automated metrics.

![Validated synthetic profile and successful MIDI transform in OCTAVE](/screenshots/strum-training/deploy-transform-result.png)

This screenshot uses a deliberately learnable synthetic identity fixture. It proves that packaging, profile activation, MIDI execution, and restart persistence work. It does not demonstrate a useful Hard reduction or a personalized musical style. The rejected real-data candidate in the preceding screenshot was not promoted.

## 8. Fine-tune toward your library's style

Use reviewed human-authored Expert/Hard pairs whose Hard-chart decisions reflect the style you want. Consistency of examples matters: unrelated instruments or difficulties do not become labels just because they are present in the same library.

1. Prepare the approved examples as a new task when the data or preparation options change.
2. In **Train**, choose that task and set **Checkpoint Mode** to `fine_tune`.
3. Select a completed **Parent candidate** from the same supported pipeline. A candidate need not already be a deployable profile to be an eligible parent.
4. Match the parent's instrument, source and target difficulties, architecture, and audio settings. For the earlier example, keep Guitar Expert-to-Hard, **Hidden Dim = 8**, the same lane count, chart-only preparation, and the same audio sample-rate/window/duration defaults. STRUM checks these configuration values even for a chart-only parent; choosing the parent does not automatically fill every form control.
5. Give the new experiment a distinct **Model Id**, choose suitable training settings, and start it. It initializes a new run from verified parent weights; it does not overwrite the parent or resume its optimizer state.
6. Evaluate, package, inspect, and explicitly activate the new profile through the same gates. Keep a reserved final set of unseen songs and compare the result through charter review and playtesting.

![Configure a new fine-tuning experiment using a completed compatible parent](/screenshots/strum-training/fine-tune-parent.png)

The screenshot shows configuration only; no style-trained result is claimed. A name such as `my-library-hard-style-v1` labels an experiment, rather than instructing the model how to chart. The current transform predicts lane activity at source-chart event times. It can be trained toward supported choices such as retained events, lanes, chords, and density, but it is not an unrestricted timing, sustain, articulation, or arrangement model.

A future loop that safely learns from your edits to generated charts needs preserved baselines, meaningful semantic-change evidence, revision-bound approval, and split grouping that prevents related revisions from leaking across evaluation partitions. Those admission features are not yet available. Ordinary editor corrections remain useful for charting and playtesting today.

## Troubleshooting

| What you see                                         | What to check                                                                                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No training pipeline or an inference-only runtime    | Run the probe and pipeline-list commands with the checkout's own `.venv`; select the checkout containing that worker. The bundled inference adapter is not this training runtime. |
| No eligible songs                                    | Confirm human-authored Guitar Expert and Hard labels, explicit catalog inclusion, and valid managed assets. Audio files alone are insufficient for this task.                     |
| Prepared task changed or predates verification       | Prepare a new task from the approved catalog. Do not edit its manifest or `pairs.jsonl` in place.                                                                                 |
| Fine-tune rejected                                   | Check parent pipeline, hidden dimension, lane count, and audio modality against the new run. Use a registered compatible candidate.                                               |
| Training failed or was interrupted                   | Inspect retained job history; check device support, runtime dependencies and disk availability. Retry deliberately; restart does not resume optimizer state.                      |
| Package failed after evaluation                      | Check the quality-gate result and candidate/task binding. A generic request error can also indicate invalid declared options; it does not always mean a quality failure.          |
| Validate button unavailable                          | Choose a verified packaged bundle and click **Inspect**, then select an executable profile and one of its supported difficulty policies.                                          |
| Auto-Chart cannot use the transform with audio alone | Use **Transform MIDI** in Deploy and provide the source Expert MIDI; audio-only transcription is a separate capability.                                                           |
| Edited generated song remains excluded               | Expected until generated baseline/revision admission exists. Do not clear provenance or change metadata to bypass it.                                                             |

See the [training reference](/reference/strum-training) for supported capability boundaries and the [song source catalog contract](/reference/song-source-catalog) for source ownership and admission rules.
