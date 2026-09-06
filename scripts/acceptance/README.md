# STRUM worker acceptance

Run this harness with the Python interpreter belonging to the explicitly selected STRUM runtime. It imports no STRUM implementation or test helpers: every operation executes a new `python -m src.worker` process in the supplied checkout.

```bash
"$STRUM_PYTHON" scripts/acceptance/strum_pipeline.py \
  --strum-root "$STRUM_ROOT" \
  --output "$NEW_PRIVATE_ACCEPTANCE_DIRECTORY"
```

The output directory must not exist. The default creates 48 owned synthetic MIDI sources and exercises the learned Guitar Expert-to-Hard transform. To use an existing approved catalog without changing it, add `--catalog-root "$APPROVED_CATALOG_ROOT"`. The interpreter needs STRUM dependencies, including mido for synthetic fixture creation. CPU training is one epoch, with one compute thread; every subprocess has a 180-second timeout (override with `--timeout`). Timeout kills and reaps its process group.

The harness checks probe, pipeline discovery, catalog inspection, preparation, training, checkpoint inspection/discovery, held-out evaluation, packaging, profile validation, chart preflight, and chart execution. NDJSON checks require a single job identity, increasing sequence numbers, and one terminal event. Raw candidates must have no profile and remain non-deployable. It checks protocol responses and task/experiment JSON for the private runtime/catalog/output roots.

Evaluation uses the unchanged canonical STRUM quality policy. If the trained candidate fails that policy, acceptance requires package, profile validation, preflight, and execution to reject it. If it passes, those steps must execute successfully. The report explicitly distinguishes successful chart execution from rejection; a successful harness run alone does not prove a deployable model. Synthetic metrics are never quality evidence, even when a synthetic candidate passes the numerical gate.

`report.json` contains path-free stage results. Request files contain private operational paths and diagnostic stderr may contain runtime paths; keep the entire output directory private and publish only the reviewed report. Do not commit catalogs, checkpoints, private request files, or original source locations.

This is worker-process integration acceptance. It does not replace Electron UI acceptance, audio-model validation, broader cancellation/restart fault injection, cross-platform release testing, or a quality-grade independently held-out production model. The current synthetic fixture tests MIDI transforms; dedicated audio, Vocal, Harmony, and Pro tasks require their distinct admission and quality contracts.

For Electron acceptance, build OCTAVE and launch its `out/main/index.js` with Playwright's `_electron` API and a new `--user-data-dir`. Existing `scripts/screenshots/lib/setup.mjs` supplies isolation helpers. Exercise the actual Prepare → Train → evaluation/package UI, wait for terminal job state (not merely submission), verify opaque candidate registration and rejected default selection, and retain sanitized screenshots. Never reuse the user's active application data directory.

For positive wiring coverage, add `--synthetic-identity --epochs 100`. This explicitly artificial fixture uses identical Expert/Hard lanes and a small model with a faster learning rate; the actual trainer must learn the mapping, independently evaluate it and pass the unchanged canonical gate. A successful run then verifies a packaged profile and writes a real chart MIDI. This does not demonstrate useful difficulty reduction or real-music quality. Keep the default one-epoch run as the complementary rejection path; use an approved real catalog for independent execution evidence.

Run the UI harness after `npm run build`:

```bash
STRUM_ROOT="$STRUM_ROOT" STRUM_PYTHON="$STRUM_PYTHON" \
ACCEPTANCE_CATALOG_ROOT="$APPROVED_CATALOG_ROOT" \
ACCEPTANCE_OUTPUT="$NEW_PRIVATE_UI_DIRECTORY" \
node scripts/acceptance/strum_ui.mjs
```

It substitutes only native folder-picker results, then uses actual rendered controls for runtime selection, preparation, training, evaluation, and packaging. Progress assertions observe the real preload event stream. It requires the one-epoch real-catalog candidate to fail packaging, retain an opaque artifact, and remain unavailable for deployment. Do not use the synthetic identity catalog for this negative UI scenario. Screenshots and failure diagnostics stay private; review before sharing.

## Verified worker evidence — 2026-09-05

Against clean STRUM `b32fa0a` (including optional catalog context on both evaluation and packaging requests), the positive synthetic identity run completed all 14 stages, including immutable packaging, packaged discovery/inspection, profile validation, and writing a chart MIDI. Its 100-epoch toy metrics were precision/recall/F1 1.0; this is execution evidence only. The independently executed approved-catalog run inspected 212 allowed records, found 138 Guitar Expert/Hard candidates, and prepared 123 usable chart-pair records. Its one-epoch held-out precision/recall/F1 were 0.299336/0.816273/0.438039. The unchanged canonical policy rejected F1 and precision, and packaging, profile validation, preflight, and chart execution all refused the raw candidate. These runs did not promote or modify any production default.

Set `ACCEPTANCE_POSITIVE_ROOT` to a successful `--synthetic-identity --epochs 100` worker-harness output to extend the same UI run with positive profile discovery, explicit default selection in the isolated app, and the Deploy screen's Transform MIDI action. The harness selects that fixture's Expert MIDI through the main-process dialog and verifies that OCTAVE writes `notes.mid` and `run.json`. This changes only the isolated acceptance application's default, never the user's active OCTAVE settings.

The UI pass also starts a second real training process, cancels it through the rendered control after its running event, and requires a cancelled terminal without an additional candidate. It closes and relaunches Electron with the same isolated user data, then verifies completed-run count, failed/cancelled history, and the selected profile default persist. Abrupt machine shutdown, storage failure, and cross-platform process-tree behavior still require separate validation.

## Verified Electron evidence — 2026-09-05

The fresh isolated Electron run passed all 10 stages against OCTAVE `81f0f6c` and clean STRUM `b32fa0a`. It completed approved-catalog preparation and training through candidate registration, cancelled a second actual training process without registering a candidate, observed the actual failed canonical evaluation, and verified package rejection and durable failure history. It then inspected the independently trained synthetic package, selected its validated profile as the isolated default, and generated a real MIDI through the Deploy screen. Output `song.ini` retained `strum_generated = true` and `dataset_opt_in = false`. Closing and relaunching Electron preserved completed/failed/cancelled history and the validated default. This verifies the software lifecycle; the real candidate remains rejected and the artificial positive model makes no musical-quality claim.

Reviewed path-free reports are committed for reproducibility:

- [Positive worker execution](evidence/2026-09-05-worker-positive.json): 14 passed stages; numerical quality gate passed only on the artificial fixture.
- [Approved-catalog worker execution](evidence/2026-09-05-worker-real.json): 12 passed stages; real candidate rejected by the canonical quality policy.
- [Electron lifecycle and deployment](evidence/2026-09-05-ui.json): 10 passed stages, including cancellation, explicit failed evaluation, positive MIDI generation, and restart persistence.

Both worker reports attest the exact clean STRUM source revision and declare `quality_claim: false`; the UI report also declares no quality claim. Private catalogs, checkpoints, requests, diagnostics and screenshots are excluded from this evidence directory. The accompanying source verification was 273 OCTAVE tests and 382 STRUM tests; broader model-quality and platform-release acceptance remains separate.

See the [visual walkthrough, ownership diagrams, and charter scaling roadmap](../../plans/strum-charter-workflow.md) for reviewed UI screenshots and the distinction between current fine-tuning and planned correction feedback.
