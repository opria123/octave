#!/usr/bin/env python3
"""Real worker-process acceptance; synthetic execution evidence, never quality evidence."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import signal
import subprocess
import sys
from pathlib import Path

PIPELINE = "chart_transform.five_lane/v1"


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def synthetic_catalog(root: Path, identity: bool = False) -> Path:
    import mido

    root.mkdir()
    records = []
    for index in range(48):
        midi = mido.MidiFile()
        track = mido.MidiTrack()
        midi.tracks.append(track)
        track.append(mido.MetaMessage("track_name", name="PART GUITAR"))
        track.append(
            mido.MetaMessage("text", text=f"Owned synthetic acceptance source {index}")
        )
        for event in range(16):
            lane = (index + event) % 5
            target_lane = lane if identity else (index * 3 + event * 2) % 5
            for note in (96 + lane, 84 + target_lane):
                track.append(mido.Message("note_on", note=note, velocity=100, time=0))
            track.append(mido.Message("note_off", note=96 + lane, time=120))
            track.append(mido.Message("note_off", note=84 + target_lane, time=120))
        stream = io.BytesIO()
        midi.save(file=stream)
        data = stream.getvalue()
        digest = hashlib.sha256(data).hexdigest()
        asset = root / "assets" / "sha256" / digest / "notes.mid"
        asset.parent.mkdir(parents=True)
        asset.write_bytes(data)
        records.append(
            {
                "source_id": f"octave-src-{index:08x}",
                "import": {
                    "kind": "song_folder",
                    "adapter_version": "acceptance/1",
                    "warnings": [],
                },
                "rights": {
                    "training_use": "allowed",
                    "provenance": "Owned synthetic fixture",
                    "license": "test-only",
                },
                "metadata": {"name": f"Synthetic {index}"},
                "chart": {
                    "notes_midi": {
                        "asset_id": f"sha256:{digest}",
                        "sha256": digest,
                        "relative_path": asset.relative_to(root).as_posix(),
                        "byte_length": len(data),
                        "media_type": "audio/midi",
                    },
                    "instruments": {
                        "guitar": {
                            "status": "present",
                            "difficulties": ["expert", "hard"],
                            "track_names": ["PART GUITAR"],
                        }
                    },
                },
                "audio": {},
            }
        )
    (root / "records.jsonl").write_text(
        "".join(json.dumps(record) + "\n" for record in records)
    )
    write_json(
        root / "catalog.json",
        {
            "schema_version": 1,
            "format": "octave-song-source-catalog/v1",
            "catalog_id": "owned-synthetic-acceptance",
            "records": "records.jsonl",
        },
    )
    return root


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strum-root", type=Path, required=True)
    parser.add_argument(
        "--output", type=Path, required=True, help="New private artifact directory"
    )
    parser.add_argument(
        "--catalog-root", type=Path, help="Existing approved catalog; never mutated"
    )
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument(
        "--synthetic-identity",
        action="store_true",
        help="Learnable identity task for positive plumbing only",
    )
    args = parser.parse_args()
    if not 1 <= args.epochs <= 100:
        parser.error("epochs must be between 1 and 100")
    if args.catalog_root and args.synthetic_identity:
        parser.error("synthetic identity cannot modify a real catalog")
    args.strum_root = args.strum_root.resolve(strict=True)
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=False)
    os.chmod(args.output, 0o700)
    report = {
        "format": "octave-strum-acceptance/v1",
        "evidence": "real-catalog-execution"
        if args.catalog_root
        else "synthetic-execution-only",
        "quality_claim": False,
        "stages": [],
    }
    private = [
        str(args.output),
        str(args.strum_root),
        str(Path(sys.executable).resolve()),
        sys.executable,
    ]
    if args.catalog_root:
        private.append(str(args.catalog_root.resolve()))

    def worker(
        name: str,
        command: list[str],
        request: dict | None = None,
        events: bool = False,
        failure: bool = False,
    ) -> dict:
        if request is not None:
            path = args.output / f"{name}.request.json"
            write_json(path, request)
            command += ["--request", str(path)]
        command += ["--json-events" if events else "--json"]
        env = {
            **os.environ,
            "WANDB_MODE": "disabled",
            "OMP_NUM_THREADS": "1",
            "MKL_NUM_THREADS": "1",
        }
        process = subprocess.Popen(
            [sys.executable, "-m", "src.worker", *command],
            cwd=args.strum_root,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=args.timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
            raise RuntimeError(f"{name}: worker timeout") from None
        # Diagnostic stderr stays private; public report contains only structured status.
        (args.output / f"{name}.stderr.txt").write_text(stderr)
        if any(value in stdout for value in private):
            raise RuntimeError(f"{name}: private location leaked to protocol")
        payloads = [json.loads(line) for line in stdout.splitlines() if line.strip()]
        if events:
            assert len(payloads) >= 2, f"{name}: missing lifecycle"
            assert [item["sequence"] for item in payloads] == sorted(
                {item["sequence"] for item in payloads}
            )
            assert len({item["job_id"] for item in payloads}) == 1
            assert payloads[-1]["state"] == ("failed" if failure else "succeeded"), (
                f"{name}: terminal mismatch"
            )
            assert (
                sum(item["state"] in ("failed", "succeeded") for item in payloads) == 1
            )
        assert bool(process.returncode) == failure, (
            f"{name}: unexpected exit {process.returncode}"
        )
        write_json(args.output / f"{name}.response.json", payloads)
        report["stages"].append(
            {"name": name, "status": "rejected-as-required" if failure else "passed"}
        )
        write_json(args.output / "report.json", report)
        print(f"{name}: {report['stages'][-1]['status']}", flush=True)
        return payloads[-1]

    try:
        catalog = (
            args.catalog_root.resolve(strict=True)
            if args.catalog_root
            else synthetic_catalog(args.output / "catalog", args.synthetic_identity)
        )
        probe = worker("probe", ["probe"])
        report["runtime"] = {
            key: probe.get("runtime", {}).get(key)
            for key in ("id", "version", "source_revision", "source_dirty", "python")
        }
        report["protocol_version"] = probe["protocol_version"]
        worker("pipelines", ["pipeline", "list"])
        worker(
            "inspect-catalog",
            [
                "catalog",
                "inspect",
                "--catalog-root",
                str(catalog),
                "--pipeline",
                PIPELINE,
                "--options",
                json.dumps({"instrument": "guitar", "target_difficulty": "Hard"}),
            ],
        )
        prepared = args.output / "prepared"
        worker(
            "prepare",
            ["dataset", "prepare"],
            {
                "catalog_root": str(catalog),
                "pipeline_id": PIPELINE,
                "output": str(prepared),
                "options": {
                    "instrument": "guitar",
                    "target_difficulty": "Hard",
                    "dataset_id": "acceptance-transform",
                    "split_seed": 20260814,
                },
            },
            True,
        )
        dataset = prepared / "dataset-manifest.json"
        candidate = args.output / "candidate"
        worker(
            "train",
            ["train", "start"],
            {
                "pipeline_id": PIPELINE,
                "task_view": str(dataset),
                "output": str(candidate),
                "options": {
                    "model_id": "acceptance-transform",
                    "checkpoint_mode": "fresh",
                    "epochs": args.epochs,
                    "hidden_dim": 32 if args.synthetic_identity else 8,
                    "learning_rate": 0.02 if args.synthetic_identity else 0.001,
                    "device": "cpu",
                },
            },
            True,
        )
        inspection = worker(
            "inspect-candidate",
            ["checkpoint", "inspect", "--model-root", str(candidate)],
        )
        assert (
            inspection["deployment_status"] == "not_deployable"
            and inspection["profiles"] == []
        )
        worker(
            "discover-candidate",
            ["checkpoint", "discover", "--model-root", str(candidate)],
        )
        evaluation = args.output / "evaluation.json"
        worker(
            "evaluate",
            ["promotion", "start"],
            {
                "pipeline_id": PIPELINE,
                "job_id": "chart-transform.profile-evaluate/v1",
                "bundle_root": str(candidate),
                "catalog_root": str(catalog),
                "dataset_manifest": str(dataset),
                "output": str(evaluation),
                "options": {"device": "cpu"},
            },
            True,
        )
        passed = (
            json.loads(evaluation.read_text())["quality_gate"]["status"] == "passed"
        )
        report["canonical_quality_gate"] = (
            "passed-on-fixture-only"
            if passed and not args.catalog_root
            else "passed"
            if passed
            else "failed"
        )
        package = args.output / "package"
        worker(
            "package",
            ["promotion", "start"],
            {
                "pipeline_id": PIPELINE,
                "job_id": "chart-transform.profile-package/v1",
                "experiment": str(candidate),
                "evaluation": str(evaluation),
                "catalog_root": str(catalog),
                "dataset_manifest": str(dataset),
                "output": str(package),
                "options": {"profile_id": "acceptance-transform", "device": "cpu"},
            },
            True,
            not passed,
        )
        if passed:
            packaged = worker(
                "inspect-package",
                ["checkpoint", "inspect", "--model-root", str(package)],
            )
            assert packaged["profiles"], "package has no profile"
            worker(
                "discover-package",
                ["checkpoint", "discover", "--model-root", str(package)],
            )
        model = package if passed else candidate
        policy = "learned:chart_transform.guitar.expert_to_hard"
        worker(
            "profile-validate",
            [
                "inference",
                "profile",
                "validate",
                "--model-root",
                str(model),
                "--profile",
                "acceptance-transform",
                "--difficulty-policy",
                policy,
            ],
            failure=not passed,
        )
        preflight = {
            "model_root": str(model),
            "profile_id": "acceptance-transform",
            "difficulty_policy": policy,
            "instruments": ["guitar"],
            "device": "cpu",
        }
        worker("chart-preflight", ["chart", "preflight"], preflight, failure=not passed)
        first_pair = json.loads((prepared / "pairs.jsonl").read_text().splitlines()[0])
        source = (
            catalog
            / "assets"
            / "sha256"
            / first_pair["notes_midi_sha256"]
            / "notes.mid"
        )
        assert source.is_file(), "prepared source MIDI missing"
        worker(
            "chart-run",
            ["chart", "run"],
            {
                "preflight_request": str(args.output / "chart-preflight.request.json"),
                "source_midi_path": str(source),
                "song_path": None,
                "output_dir": str(args.output / "chart"),
            },
            failure=not passed,
        )
        if passed:
            assert (args.output / "chart" / "notes.mid").is_file(), "missing chart MIDI"
        for artifact_root in (prepared, candidate, package):
            for artifact in artifact_root.rglob("*.json*"):
                contents = artifact.read_text(encoding="utf-8")
                if any(value in contents for value in private):
                    raise RuntimeError("Private location leaked to training artifact")
        report["artifact_path_audit"] = "passed"
        report["positive_chart_execution"] = (
            "passed" if passed else "not-reached-quality-gate-failed"
        )
        report["status"] = "passed"
    except Exception as error:
        report["status"] = "failed"
        report["failure_type"] = type(error).__name__
        raise
    finally:
        write_json(args.output / "report.json", report)


if __name__ == "__main__":
    main()
