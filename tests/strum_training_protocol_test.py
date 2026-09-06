"""Focused contract tests for OCTAVE's temporary STRUM worker adapter."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "resources" / "strum" / "training_protocol.py"
SPEC = importlib.util.spec_from_file_location("octave_training_protocol", MODULE_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - fixture integrity
    raise RuntimeError("Could not load the STRUM training protocol.")
training_protocol = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = training_protocol
SPEC.loader.exec_module(training_protocol)


class CheckpointManifestTests(unittest.TestCase):
    def write_bundle(self, root: Path) -> Path:
        component = root / "checkpoints" / "guitar.pt"
        component.parent.mkdir()
        component.write_bytes(b"verified checkpoint")
        manifest = {
            "schema_version": "strum-checkpoint-manifest/v1",
            "run_id": "run-test",
            "pipeline_id": "guitar.onset-fret/v1",
            "runtime_id": "strum-test",
            "task_view_id": "task-test",
            "task_view_hash": "a" * 64,
            "checkpoint_mode": "fresh",
            "components": [
                {
                    "id": "guitar_onset",
                    "relative_path": "checkpoints/guitar.pt",
                    "sha256": hashlib.sha256(component.read_bytes()).hexdigest(),
                    "byte_length": component.stat().st_size,
                }
            ],
            "inference_capabilities": [],
            "deployable": False,
        }
        manifest["manifest_hash"] = training_protocol.sha256_json(manifest)
        (root / "checkpoint-manifest.json").write_text(
            json.dumps(manifest), encoding="utf-8"
        )
        return component

    def test_checkpoint_inspection_requires_manifest_and_component_hashes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            component = self.write_bundle(root)
            manifest = training_protocol.load_checkpoint_manifest(root)
            self.assertEqual(manifest["run_id"], "run-test")

            component.write_bytes(b"tampered checkpoint")
            with self.assertRaises(training_protocol.ProtocolError) as context:
                training_protocol.load_checkpoint_manifest(root)
            self.assertEqual(context.exception.code, "checkpoint_invalid")


if __name__ == "__main__":
    unittest.main()
