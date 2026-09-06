"""Versioned, JSON-only training protocol for OCTAVE's temporary STRUM adapter.

This module intentionally keeps the OCTAVE renderer out of every filesystem
handoff.  It is a compatibility bridge for a validated developer checkout
until STRUM ships ``strum-worker`` itself.  The public commands mirror the
OCTAVE ↔ STRUM contract; their stdout consists exclusively of safe JSON.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


PROTOCOL_VERSION = "1.0"
PIPELINE_ID = "guitar.onset-fret/v1"
SAFE_CODE = re.compile(r"^[a-z0-9_.-]{1,80}$")
SAFE_COMPONENT_PATH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$")

PIPELINE = {
    "id": PIPELINE_ID,
    "display_name": "Guitar onset + fret",
    "kind": "audio_to_chart",
    "catalog_requirements": {
        "instrument": "guitar",
        "difficulties": ["expert"],
        "audio_roles": ["guitar", "mix"],
        "audio_policy": "prefer:guitar,fallback:mix",
    },
    "prepare_schema": {
        "type": "object",
        "properties": {
            "split_seed": {"type": "integer", "default": 20260814},
        },
    },
    "train_schema": {
        "type": "object",
        "properties": {
            "mode": {"enum": ["fresh"], "default": "fresh"},
            "epochs": {"type": "integer", "minimum": 1, "maximum": 500, "default": 20},
            "batch_size": {"type": "integer", "minimum": 1, "maximum": 256, "default": 16},
            "device": {"enum": ["auto", "cuda", "mps", "cpu"], "default": "auto"},
            "seed": {"type": "integer", "default": 20260814},
        },
    },
    "checkpoint_outputs": ["guitar_onset", "guitar_fret"],
    # The legacy checkout's training checkpoints are experiment artifacts,
    # not compatible with OCTAVE's current shipped auto-chart graph.
    "inference_capability": None,
}


class ProtocolError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code if SAFE_CODE.match(code) else "protocol_error"
        self.message = message


@dataclass
class Events:
    job_id: str
    sequence: int = 0

    def emit(self, event: str, **payload: Any) -> None:
        self.sequence += 1
        print(
            json.dumps(
                {
                    "event": event,
                    "job_id": self.job_id,
                    "sequence": self.sequence,
                    **payload,
                },
                separators=(",", ":"),
            ),
            flush=True,
        )

    def progress(self, stage: str, progress: float, code: str, message: str) -> None:
        self.emit(
            "progress",
            stage=stage,
            progress=max(0.0, min(1.0, progress)),
            code=code,
            message=message,
        )

    def terminal(self, state: str, **payload: Any) -> None:
        self.emit("terminal", state=state, **payload)


def emit_json(value: dict[str, Any]) -> None:
    print(json.dumps(value, separators=(",", ":")), flush=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_json(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def load_request(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ProtocolError("request_unreadable", "The training request could not be read.") from exc
    if not isinstance(value, dict):
        raise ProtocolError("request_invalid", "The training request is invalid.")
    return value


def safe_relative_asset(root: Path, relative_path: Any) -> Path:
    if not isinstance(relative_path, str) or not re.fullmatch(r"assets/sha256/[a-f0-9]{64}/[A-Za-z0-9._-]+", relative_path):
        raise ProtocolError("catalog_invalid", "The catalog contains an invalid managed asset reference.")
    candidate = (root / relative_path).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise ProtocolError("catalog_invalid", "The catalog contains an invalid managed asset reference.") from exc
    return candidate


def load_checkpoint_manifest(checkpoint_root: Path) -> dict[str, Any]:
    """Read and hash-validate one immutable checkpoint bundle.

    The manifest is the only authority OCTAVE may inspect.  All component
    paths are constrained to its bundle root and every declared byte length
    and digest must match before a run can be shown as deployable.
    """
    try:
        root = checkpoint_root.resolve(strict=True)
        manifest_path = root / "checkpoint-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ProtocolError("checkpoint_invalid", "The selected checkpoint bundle is invalid.") from exc
    if not isinstance(manifest, dict) or manifest.get("schema_version") != "strum-checkpoint-manifest/v1":
        raise ProtocolError("checkpoint_invalid", "The selected checkpoint bundle is invalid.")
    expected_hash = manifest.get("manifest_hash")
    unsigned_manifest = {key: value for key, value in manifest.items() if key != "manifest_hash"}
    if not isinstance(expected_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_hash) or sha256_json(unsigned_manifest) != expected_hash:
        raise ProtocolError("checkpoint_invalid", "The selected checkpoint bundle is invalid.")
    for field in ("run_id", "pipeline_id", "runtime_id", "task_view_id", "task_view_hash"):
        if not isinstance(manifest.get(field), str) or not manifest[field]:
            raise ProtocolError("checkpoint_invalid", "The selected checkpoint bundle is invalid.")
    components = manifest.get("components")
    if not isinstance(components, list) or not components:
        raise ProtocolError("checkpoint_invalid", "The selected checkpoint bundle is invalid.")
    component_ids: set[str] = set()
    for component in components:
        if not isinstance(component, dict):
            raise ProtocolError("checkpoint_invalid", "The selected checkpoint bundle is invalid.")
        component_id = component.get("id")
        relative_path = component.get("relative_path")
        digest = component.get("sha256")
        byte_length = component.get("byte_length")
        if (
            not isinstance(component_id, str)
            or not SAFE_CODE.fullmatch(component_id)
            or component_id in component_ids
            or not isinstance(relative_path, str)
            or not SAFE_COMPONENT_PATH.fullmatch(relative_path)
            or ".." in Path(relative_path).parts
            or not isinstance(digest, str)
            or not re.fullmatch(r"[a-f0-9]{64}", digest)
            or not isinstance(byte_length, int)
            or byte_length < 0
        ):
            raise ProtocolError("checkpoint_invalid", "The selected checkpoint bundle is invalid.")
        component_ids.add(component_id)
        component_path = (root / relative_path).resolve()
        try:
            component_path.relative_to(root)
        except ValueError as exc:
            raise ProtocolError("checkpoint_invalid", "The selected checkpoint bundle is invalid.") from exc
        if (
            not component_path.is_file()
            or component_path.stat().st_size != byte_length
            or sha256_file(component_path) != digest
        ):
            raise ProtocolError("checkpoint_invalid", "The selected checkpoint bundle is invalid.")
    return manifest


def load_catalog(catalog_root: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    try:
        catalog = json.loads((catalog_root / "catalog.json").read_text(encoding="utf-8"))
        if catalog.get("format") != "octave-song-source-catalog/v1":
            raise ValueError("format")
        records_name = catalog.get("records")
        if records_name != "records.jsonl":
            raise ValueError("records")
        records = [
            json.loads(line)
            for line in (catalog_root / records_name).read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    except Exception as exc:
        raise ProtocolError("catalog_invalid", "The selected catalog is not a valid OCTAVE catalog.") from exc
    if not isinstance(catalog.get("catalog_id"), str) or not all(isinstance(record, dict) for record in records):
        raise ProtocolError("catalog_invalid", "The selected catalog is not a valid OCTAVE catalog.")
    return catalog, records


def guitar_candidates(catalog_root: Path, records: Iterable[dict[str, Any]], split_seed: int = 20260814) -> tuple[list[dict[str, Any]], dict[str, int]]:
    eligible: list[dict[str, Any]] = []
    skipped = {"rights": 0, "guitar_chart": 0, "audio": 0, "asset": 0}
    for record in records:
        rights = record.get("rights")
        if not isinstance(rights, dict) or rights.get("training_use") != "allowed":
            skipped["rights"] += 1
            continue
        chart = record.get("chart")
        instruments = chart.get("instruments") if isinstance(chart, dict) else None
        guitar = instruments.get("guitar") if isinstance(instruments, dict) else None
        difficulties = guitar.get("difficulties") if isinstance(guitar, dict) else []
        if not isinstance(difficulties, list) or "expert" not in [str(value).lower() for value in difficulties]:
            skipped["guitar_chart"] += 1
            continue
        audio = record.get("audio")
        selected_role = "guitar" if isinstance(audio, dict) and isinstance(audio.get("guitar"), dict) else "mix"
        selected_audio = audio.get(selected_role) if isinstance(audio, dict) else None
        notes = chart.get("notes_midi") if isinstance(chart, dict) else None
        if not isinstance(selected_audio, dict) or not isinstance(notes, dict):
            skipped["audio"] += 1
            continue
        try:
            notes_path = safe_relative_asset(catalog_root, notes.get("relative_path"))
            audio_path = safe_relative_asset(catalog_root, selected_audio.get("relative_path"))
            if not notes_path.is_file() or not audio_path.is_file():
                raise ValueError("missing")
            if sha256_file(notes_path) != notes.get("sha256") or sha256_file(audio_path) != selected_audio.get("sha256"):
                raise ValueError("hash")
        except Exception:
            skipped["asset"] += 1
            continue
        source_id = record.get("source_id")
        if not isinstance(source_id, str):
            skipped["asset"] += 1
            continue
        split_bucket = int(hashlib.sha256(f"{split_seed}:{source_id}".encode()).hexdigest()[:8], 16) % 1000
        split = "train" if split_bucket < 850 else "val" if split_bucket < 925 else "test"
        eligible.append(
            {
                "source_id": source_id,
                "notes_sha256": notes.get("sha256"),
                "audio_sha256": selected_audio.get("sha256"),
                "audio_role": selected_role,
                "split": split,
                "notes_path": str(notes_path),
                "audio_path": str(audio_path),
            }
        )
    return eligible, skipped


def source_root() -> Path | None:
    configured = os.environ.get("OCTAVE_STRUM_SOURCE_DIR", "").strip()
    if not configured:
        return None
    candidate = Path(configured)
    if (
        (candidate / "scripts" / "preprocess_guitar_windows.py").is_file()
        and (candidate / "scripts" / "train_guitar_v1.py").is_file()
    ):
        return candidate.resolve()
    return None


def source_revision(root: Path | None) -> tuple[str | None, bool]:
    if not root:
        return None, False
    try:
        revision = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL).strip()
        dirty = bool(subprocess.check_output(["git", "-C", str(root), "status", "--porcelain"], text=True, stderr=subprocess.DEVNULL).strip())
        return revision[:16], dirty
    except Exception:
        return "legacy-checkout", True


def runtime_info() -> dict[str, Any]:
    root = source_root()
    revision, dirty = source_revision(root)
    training_ready = root is not None and os.environ.get("OCTAVE_STRUM_LEGACY_TRAINING_ADAPTER") == "1"
    return {
        "protocol_version": PROTOCOL_VERSION,
        "runtime_kind": "developer_override" if root else "bundled_inference",
        "runtime_id": f"octave-legacy-{revision or 'inference'}",
        "display_name": "Developer STRUM compatibility adapter" if root else "OCTAVE bundled inference runtime",
        "strum_release": "legacy-adapter",
        "source_revision": revision,
        "dirty": dirty,
        "python": {"version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}", "minimum": "3.11"},
        "platform": sys.platform,
        "device_support": ["cpu", "cuda", "mps"],
        "capabilities": ["inference"] + (["training"] if training_ready else []),
        "pipeline_ids": [PIPELINE_ID] if training_ready else [],
        "checkpoint_manifest_schemas": ["strum-checkpoint-manifest/v1"],
        "model_bundle_schemas": ["strum-model-bundle/v1"],
        "legacy_wrapper": True,
        "training_setup_required": not training_ready,
    }


def command_probe(_: argparse.Namespace) -> int:
    emit_json(runtime_info())
    return 0


def command_pipeline_list(_: argparse.Namespace) -> int:
    info = runtime_info()
    emit_json({"protocol_version": PROTOCOL_VERSION, "pipelines": [PIPELINE] if "training" in info["capabilities"] else []})
    return 0


def command_catalog_inspect(args: argparse.Namespace) -> int:
    if args.pipeline != PIPELINE_ID:
        raise ProtocolError("pipeline_unsupported", "That training pipeline is not available in this runtime.")
    _, records = load_catalog(args.catalog.resolve())
    eligible, skipped = guitar_candidates(args.catalog.resolve(), records)
    emit_json({
        "protocol_version": PROTOCOL_VERSION,
        "pipeline_id": PIPELINE_ID,
        "eligible_count": len(eligible),
        "record_count": len(records),
        "excluded": skipped,
        "audio_policy": "prefer:guitar,fallback:mix",
        "estimated_storage_bytes": 0,
    })
    return 0


def command_dataset_prepare(args: argparse.Namespace) -> int:
    request = load_request(args.request)
    events = Events(str(request.get("job_id", "prepare")))
    try:
        if request.get("pipeline_id") != PIPELINE_ID:
            raise ProtocolError("pipeline_unsupported", "That training pipeline is not available in this runtime.")
        catalog_root = Path(str(request.get("catalog_root", ""))).resolve()
        task_root = Path(str(request.get("task_root", ""))).resolve()
        task_id = str(request.get("task_id", ""))
        if not task_id or not catalog_root.is_dir() or not task_root.parent.is_dir():
            raise ProtocolError("request_invalid", "The training request is incomplete.")
        events.progress("validating", 0.05, "catalog_validating", "Validating approved catalog assets.")
        split_seed = int((request.get("prepare") or {}).get("split_seed", 20260814))
        catalog, records = load_catalog(catalog_root)
        eligible, skipped = guitar_candidates(catalog_root, records, split_seed)
        if not eligible:
            raise ProtocolError("no_eligible_records", "No Expert Guitar records with approved audio are available.")
        split_counts = {split: sum(source["split"] == split for source in eligible) for split in ("train", "val", "test")}
        if not split_counts["train"] or not split_counts["val"]:
            raise ProtocolError("insufficient_split_coverage", "The catalog needs both training and validation Guitar songs.")
        events.progress("preparing", 0.45, "task_view_building", "Building the Guitar task view.")
        task_root.mkdir(parents=True, exist_ok=False)
        safe_sources = [{key: value for key, value in source.items() if not key.endswith("_path")} for source in eligible]
        task_view = {
            "schema_version": "strum-task-view/v1",
            "task_view_id": task_id,
            "catalog_id": catalog["catalog_id"],
            "pipeline_id": PIPELINE_ID,
            "runtime_id": runtime_info()["runtime_id"],
            "audio_policy": "prefer:guitar,fallback:mix",
            "split_algorithm": {"id": "sha256-seeded-mod-1000/v1", "seed": split_seed},
            "sources": safe_sources,
            "split_counts": split_counts,
            "exclusions": skipped,
        }
        task_view["content_hash"] = sha256_json(task_view)
        (task_root / "task-view.json").write_text(json.dumps(task_view, indent=2) + "\n", encoding="utf-8")
        events.progress("preparing", 0.9, "task_view_written", "Task view is ready for training.")
        events.terminal("succeeded", result={"task_view_id": task_id, "eligible_count": len(eligible), "split_counts": split_counts, "excluded": skipped, "content_hash": task_view["content_hash"]})
        return 0
    except ProtocolError as exc:
        events.terminal("failed", code=exc.code, message=exc.message)
        return 2
    except Exception:
        events.terminal("failed", code="prepare_failed", message="The task view could not be prepared.")
        return 1


def child_environment(root: Path, seed: int) -> dict[str, str]:
    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["PYTHONPATH"] = str(root) + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONHASHSEED"] = str(seed)
    env["WANDB_MODE"] = "offline"
    return env


def run_child(command: list[str], root: Path, events: Events, stage: str, start: float, end: float, seed: int) -> None:
    kwargs: dict[str, Any] = {"cwd": str(root), "env": child_environment(root, seed), "stdout": subprocess.PIPE, "stderr": subprocess.STDOUT, "text": True}
    if os.name != "nt":
        kwargs["start_new_session"] = True
    process = subprocess.Popen(command, **kwargs)
    last_update = time.monotonic()
    try:
        assert process.stdout is not None
        for _line in process.stdout:
            now = time.monotonic()
            if now - last_update >= 8:
                events.progress(stage, (start + end) / 2, "worker_running", "STRUM is processing local training data.")
                last_update = now
        if process.wait() != 0:
            raise ProtocolError("worker_failed", "STRUM could not complete this training stage.")
    except KeyboardInterrupt:
        if os.name != "nt":
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
        raise


def command_train_start(args: argparse.Namespace) -> int:
    request = load_request(args.request)
    events = Events(str(request.get("job_id", "train")))
    control_path: Path | None = None
    previous_sigterm_handler: Any = None
    try:
        root = source_root()
        if not root or os.environ.get("OCTAVE_STRUM_LEGACY_TRAINING_ADAPTER") != "1":
            raise ProtocolError("training_runtime_unavailable", "Install or select a validated STRUM training runtime first.")
        task_root = Path(str(request.get("task_root", ""))).resolve()
        catalog_root = Path(str(request.get("catalog_root", ""))).resolve()
        output_root = Path(str(request.get("output_root", ""))).resolve()
        run_id = str(request.get("run_id", ""))
        if not run_id or not catalog_root.is_dir() or not (task_root / "task-view.json").is_file():
            raise ProtocolError("task_view_missing", "The selected task view is no longer available.")
        control_root = os.environ.get("OCTAVE_STRUM_TRAINING_CONTROL_ROOT", "").strip()
        if control_root:
            control_path = Path(control_root) / f"{run_id}.json"
            control_path.parent.mkdir(parents=True, exist_ok=True)
            control_path.write_text(
                json.dumps({"pid": os.getpid(), "process_group": os.getpgrp()}), encoding="utf-8"
            )
        def cancel_signal(_signum: int, _frame: Any) -> None:
            raise KeyboardInterrupt
        previous_sigterm_handler = signal.signal(signal.SIGTERM, cancel_signal)
        config = request.get("train") if isinstance(request.get("train"), dict) else {}
        seed = int(config.get("seed", 20260814))
        epochs = max(1, min(500, int(config.get("epochs", 20))))
        batch_size = max(1, min(256, int(config.get("batch_size", 16))))
        requested_device = str(config.get("device", "auto"))
        if requested_device == "auto":
            try:
                import torch  # type: ignore
                device = "cuda" if torch.cuda.is_available() else "mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu"
            except Exception:
                device = "cpu"
        else:
            device = requested_device
        if device not in {"cuda", "mps", "cpu"}:
            raise ProtocolError("config_invalid", "Choose a supported local training device.")
        output_root.mkdir(parents=True, exist_ok=False)
        events.progress("validating", 0.04, "task_view_validating", "Validating the immutable task view.")
        task_view = json.loads((task_root / "task-view.json").read_text(encoding="utf-8"))
        task_hash = task_view.pop("content_hash", None)
        if not isinstance(task_hash, str) or sha256_json(task_view) != task_hash or task_view.get("pipeline_id") != request.get("pipeline_id") or request.get("pipeline_id") != PIPELINE_ID:
            raise ProtocolError("task_view_invalid", "The selected task view is incompatible with this pipeline.")
        _, catalog_records = load_catalog(catalog_root)
        split_seed = int((task_view.get("split_algorithm") or {}).get("seed", 20260814))
        source_rows, _skipped = guitar_candidates(catalog_root, catalog_records, split_seed)
        trusted_sources = [{key: value for key, value in source.items() if not key.endswith("_path")} for source in source_rows]
        if trusted_sources != task_view.get("sources"):
            raise ProtocolError("task_view_stale", "Catalog assets changed after this task view was prepared. Prepare it again before training.")
        task_view["content_hash"] = task_hash
        if not source_rows:
            raise ProtocolError("task_view_invalid", "The task view has no trainable Guitar records.")
        legacy_manifest = {
            "songs": [
                {"id": row["source_id"], "audio_path": row["audio_path"], "midi_path": row["notes_path"], "audio_kind": "isolated_guitar" if row["audio_role"] == "guitar" else "full_mix", "split": row["split"], "alignment_offset_sec": 0.0}
                for row in source_rows
            ],
            "summary": {"source": "octave-song-source-catalog/v1", "count": len(source_rows)},
        }
        private_manifest = output_root / "guitar-manifest.private.json"
        private_manifest.write_text(json.dumps(legacy_manifest, indent=2) + "\n", encoding="utf-8")
        cache_dir = output_root / "cache"
        checkpoint_dir = output_root / "checkpoints"
        events.progress("preprocessing", 0.1, "guitar_preprocessing", "Preparing Guitar features from catalog assets.")
        run_child([sys.executable, str(root / "scripts" / "preprocess_guitar_windows.py"), "--manifest", str(private_manifest), "--cache-dir", str(cache_dir)], root, events, "preprocessing", 0.1, 0.5, seed)
        config_path = root / "configs" / "guitar_v1.yaml"
        try:
            import yaml  # type: ignore
            train_config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
            train_config["paths"]["cache_dir"] = str(cache_dir)
            train_config["paths"]["checkpoint_dir"] = str(checkpoint_dir)
            generated_config = output_root / "guitar-training.private.yaml"
            generated_config.write_text(yaml.safe_dump(train_config, sort_keys=False), encoding="utf-8")
        except Exception as exc:
            raise ProtocolError("training_config_unavailable", "The selected STRUM runtime has no compatible Guitar training configuration.") from exc
        events.progress("training", 0.55, "guitar_training", "Training Guitar onset and fret models.")
        run_child([sys.executable, str(root / "scripts" / "train_guitar_v1.py"), "both", "--config", str(generated_config), "--device", device, "--epochs", str(epochs), "--batch-size", str(batch_size)], root, events, "training", 0.55, 0.94, seed)
        components: list[dict[str, Any]] = []
        for component_id, relative in [("guitar_onset", "guitar_v1_onset/best.pt"), ("guitar_fret", "guitar_v1_fret/best.pt")]:
            checkpoint = checkpoint_dir / relative
            if not checkpoint.is_file():
                raise ProtocolError("checkpoint_missing", "STRUM completed without the required Guitar checkpoint bundle.")
            components.append({"id": component_id, "relative_path": relative, "sha256": sha256_file(checkpoint), "byte_length": checkpoint.stat().st_size})
        manifest = {
            "schema_version": "strum-checkpoint-manifest/v1",
            "run_id": run_id,
            "pipeline_id": PIPELINE_ID,
            "runtime_id": runtime_info()["runtime_id"],
            "task_view_id": task_view.get("task_view_id"),
            "task_view_hash": task_view.get("content_hash"),
            "checkpoint_mode": "fresh",
            "components": components,
            "inference_capabilities": [],
            "deployable": False,
            "deployment_reason": "This legacy Guitar training bundle is not compatible with OCTAVE's shipped auto-chart inference profile.",
        }
        manifest["manifest_hash"] = sha256_json(manifest)
        (output_root / "checkpoint-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        (output_root / "experiment.json").write_text(json.dumps({"schema_version": "strum-experiment/v1", "run_id": run_id, "pipeline_id": PIPELINE_ID, "task_view_hash": task_view.get("content_hash"), "config": {"epochs": epochs, "batch_size": batch_size, "device": device, "seed": seed}, "checkpoint_manifest_hash": manifest["manifest_hash"]}, indent=2) + "\n", encoding="utf-8")
        events.progress("finalizing", 0.98, "manifests_written", "Writing the experiment and checkpoint manifests.")
        events.terminal("succeeded", result={"run_id": run_id, "pipeline_id": PIPELINE_ID, "checkpoint_count": len(components), "deployable": False, "checkpoint_manifest_hash": manifest["manifest_hash"]})
        return 0
    except ProtocolError as exc:
        events.terminal("failed", code=exc.code, message=exc.message)
        return 2
    except KeyboardInterrupt:
        events.terminal("cancelled", code="cancelled", message="The STRUM training job was cancelled.")
        return 130
    except Exception:
        events.terminal("failed", code="training_failed", message="STRUM could not complete the training job.")
        return 1
    finally:
        if previous_sigterm_handler is not None:
            signal.signal(signal.SIGTERM, previous_sigterm_handler)
        if control_path:
            try:
                control_path.unlink(missing_ok=True)
            except Exception:
                pass


def command_train_cancel(args: argparse.Namespace) -> int:
    control_root = os.environ.get("OCTAVE_STRUM_TRAINING_CONTROL_ROOT", "").strip()
    if not control_root:
        emit_json({"cancelled": False, "code": "run_not_found"})
        return 0
    try:
        control = json.loads((Path(control_root) / f"{args.run}.json").read_text(encoding="utf-8"))
        if os.name != "nt" and isinstance(control.get("process_group"), int):
            os.killpg(control["process_group"], signal.SIGTERM)
        elif isinstance(control.get("pid"), int):
            os.kill(control["pid"], signal.SIGTERM)
        else:
            raise ValueError("pid")
        emit_json({"cancelled": True})
    except Exception:
        emit_json({"cancelled": False, "code": "run_not_found"})
    return 0


def command_checkpoint_inspect(args: argparse.Namespace) -> int:
    manifest = load_checkpoint_manifest(args.checkpoint)
    emit_json({key: manifest.get(key) for key in ["schema_version", "run_id", "pipeline_id", "runtime_id", "task_view_id", "task_view_hash", "components", "inference_capabilities", "deployable", "deployment_reason", "manifest_hash"]})
    return 0


def command_profile_validate(args: argparse.Namespace) -> int:
    request = load_request(args.request)
    checkpoint_root = Path(str(request.get("checkpoint_root", ""))).resolve()
    try:
        manifest = load_checkpoint_manifest(checkpoint_root)
    except ProtocolError:
        emit_json({"valid": False, "code": "checkpoint_invalid", "message": "The selected checkpoint bundle is invalid."})
        return 0
    if not manifest.get("deployable"):
        emit_json({"valid": False, "code": "inference_capability_missing", "message": "This checkpoint is a training experiment and cannot be used by OCTAVE Auto Chart yet."})
        return 0
    emit_json({"valid": True, "profile": {"profile_id": str(request.get("profile_id", "")), "pipeline_id": manifest.get("pipeline_id"), "runtime_id": manifest.get("runtime_id")}})
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OCTAVE STRUM training protocol compatibility adapter")
    sub = parser.add_subparsers(dest="command", required=True)
    probe = sub.add_parser("probe"); probe.add_argument("--json", action="store_true"); probe.set_defaults(handler=command_probe)
    pipelines = sub.add_parser("pipeline"); pipeline_sub = pipelines.add_subparsers(dest="pipeline_command", required=True); pipeline_list = pipeline_sub.add_parser("list"); pipeline_list.add_argument("--json", action="store_true"); pipeline_list.set_defaults(handler=command_pipeline_list)
    catalog = sub.add_parser("catalog"); catalog_sub = catalog.add_subparsers(dest="catalog_command", required=True); inspect = catalog_sub.add_parser("inspect"); inspect.add_argument("--catalog", required=True, type=Path); inspect.add_argument("--pipeline", required=True); inspect.add_argument("--json", action="store_true"); inspect.set_defaults(handler=command_catalog_inspect)
    dataset = sub.add_parser("dataset"); dataset_sub = dataset.add_subparsers(dest="dataset_command", required=True); prepare = dataset_sub.add_parser("prepare"); prepare.add_argument("--request", required=True, type=Path); prepare.add_argument("--json-events", action="store_true"); prepare.set_defaults(handler=command_dataset_prepare)
    train = sub.add_parser("train"); train_sub = train.add_subparsers(dest="train_command", required=True); start = train_sub.add_parser("start"); start.add_argument("--request", required=True, type=Path); start.add_argument("--json-events", action="store_true"); start.set_defaults(handler=command_train_start); cancel = train_sub.add_parser("cancel"); cancel.add_argument("--run", required=True); cancel.set_defaults(handler=command_train_cancel)
    checkpoint = sub.add_parser("checkpoint"); checkpoint_sub = checkpoint.add_subparsers(dest="checkpoint_command", required=True); checkpoint_inspect = checkpoint_sub.add_parser("inspect"); checkpoint_inspect.add_argument("--checkpoint", required=True, type=Path); checkpoint_inspect.add_argument("--json", action="store_true"); checkpoint_inspect.set_defaults(handler=command_checkpoint_inspect)
    inference = sub.add_parser("inference"); inference_sub = inference.add_subparsers(dest="inference_command", required=True); profile = inference_sub.add_parser("profile"); profile_sub = profile.add_subparsers(dest="profile_command", required=True); validate = profile_sub.add_parser("validate"); validate.add_argument("--request", required=True, type=Path); validate.add_argument("--json", action="store_true"); validate.set_defaults(handler=command_profile_validate)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.handler(args))
    except ProtocolError as exc:
        emit_json({"error": {"code": exc.code, "message": exc.message}})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
