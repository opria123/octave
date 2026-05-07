from __future__ import annotations

import argparse
import importlib
import json
import logging
import os
import re
import subprocess
import shutil
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

EVENT_PREFIX = "__OCTAVE_EVENT__"
GITHUB_REPO_URL = "https://github.com/opria123/strum"
GITHUB_ZIP_URL = "https://codeload.github.com/opria123/strum/zip/refs/heads/master"
HF_REPO_ID = "opria123/strum"
HF_REPO_URL = "https://huggingface.co/opria123/strum"
SOURCE_FOLDER_NAME = "strum-source"
# Bump this whenever strum's GitHub HEAD changes in a way the worker depends on
# (new pipeline params, new checkpoints, etc.). The cached source under
# <cache_dir>/strum-source/.octave-source-version is compared on every run and
# the cache is wiped + re-downloaded on mismatch.
STRUM_SOURCE_VERSION = "2026-05-06.1"
SOURCE_VERSION_FILE = ".octave-source-version"
SNAPSHOT_FOLDER_NAME = "strum-checkpoints-snapshot"
AUDIO_SEPARATION_TIMEOUT_SEC = int(os.environ.get("OCTAVE_STRUM_SEPARATION_TIMEOUT_SEC", "900"))
# Fast analysis bypasses real tempo/key detection and forces 120 BPM. The
# STRUM benchmark used real detected tempo (feeds STRUM_PHASE_ALIGN beat-grid
# alignment + tempo-relative drum heuristics), so default to OFF for chart
# quality. Set OCTAVE_STRUM_FAST_ANALYSIS=1 only for quick previews.
FAST_AUDIO_ANALYSIS = os.environ.get("OCTAVE_STRUM_FAST_ANALYSIS", "0") != "0"
FAST_AUDIO_METADATA_LOOKUP = os.environ.get("OCTAVE_STRUM_FAST_METADATA_LOOKUP", "1") != "0"
AUDIO_EXTENSIONS = {".wav", ".mp3", ".ogg", ".opus", ".flac"}
DIRECT_AUDIO_URL_EXTENSIONS = AUDIO_EXTENSIONS | {".m4a"}
REQUIRED_MODULES = {
    "torch": "torch",
    "torchaudio": "torchaudio",
    "demucs": "demucs",
    "librosa": "librosa",
    "whisper": "openai-whisper",
    "mido": "mido",
    "basic_pitch": "basic-pitch",
    "huggingface_hub": "huggingface_hub",
    "numpy": "numpy",
    "soundfile": "soundfile",
    "omegaconf": "omegaconf",
    "yaml": "PyYAML",
    "requests": "requests",
    "pyphen": "pyphen",
}
CHECKPOINT_MAP = {
    "drums/drums_v14/best.pt": "drums_v14/best.pt",
    "drums/drums_mc_onset/best.pt": "drums_mc_onset/best.pt",
    "drums/drums_phase3/best.pt": "drums_phase3/best.pt",
    "drums/drums_cymbal_onset/best_union_f1.pt": "drums_cymbal_onset/best_union_f1.pt",
    "drums/tom_refinement_demucs/best.pt": "tom_refinement_demucs/best.pt",
    "drums_classifier_ensemble/onset_classifier/best_f1.pt": "onset_classifier/best_f1.pt",
    "drums_classifier_ensemble/onset_classifier_v4/best_f1.pt": "onset_classifier_v4/best_f1.pt",
    "drums_classifier_ensemble/onset_classifier_v6/best_f1.pt": "onset_classifier_v6/best_f1.pt",
    "drums_classifier_ensemble/onset_classifier_v12_clean/best_f1.pt": "onset_classifier_v12_clean/best_f1.pt",
    "drums_classifier_ensemble/onset_classifier_v12c_community/best_f1.pt": "onset_classifier_v12c_community/best_f1.pt",
    "drums_classifier_ensemble/onset_classifier_v15/best_f1.pt": "onset_classifier_v15/best_f1.pt",
    "drums_classifier_ensemble/onset_classifier_v16/best_f1.pt": "onset_classifier_v16/best_f1.pt",
    "drums_classifier_ensemble/onset_classifier_v17/best_f1.pt": "onset_classifier_v17/best_f1.pt",
    "guitar/guitar_v2_onset/best.pt": "guitar_v2/guitar_v2_onset/best.pt",
    "guitar/fret_mapper_v4.pt": "fret_mapper_v4.pt",
    "section_classifier/best.pt": "section_classifier/best.pt",
}


class IntegrationError(RuntimeError):
    pass


def emit_event(kind: str, **payload: Any) -> None:
    record = {"kind": kind, **payload}
    print(f"{EVENT_PREFIX}{json.dumps(record, ensure_ascii=True)}", flush=True)


def emit_progress(
    run_id: str,
    stage: str,
    message: str,
    *,
    percent: int | None = None,
    current_item: str | None = None,
) -> None:
    emit_event(
        "progress",
        runId=run_id,
        stage=stage,
        message=message,
        percent=percent,
        currentItem=current_item,
    )


def emit_complete(run_id: str, **payload: Any) -> None:
    emit_event("complete", runId=run_id, **payload)


def emit_error(run_id: str, message: str, *, detail: str | None = None) -> None:
    emit_event("error", runId=run_id, message=message, detail=detail)


class ForwardToOctaveHandler(logging.Handler):
    def __init__(self, run_id: str):
        super().__init__()
        self.run_id = run_id

    def emit(self, record: logging.LogRecord) -> None:
        try:
            emit_progress(self.run_id, "bootstrap", self.format(record))
        except Exception:
            pass


def install_logging_bridge(run_id: str) -> None:
    handler = ForwardToOctaveHandler(run_id)
    handler.setFormatter(logging.Formatter("%(message)s"))
    root_logger = logging.getLogger()
    for existing in root_logger.handlers:
        if isinstance(existing, ForwardToOctaveHandler):
            return
    root_logger.addHandler(handler)
    root_logger.setLevel(logging.INFO)


def requirements_path() -> Path:
    return Path(__file__).resolve().with_name("requirements.txt")


def ffmpeg_hint() -> str:
    if sys.platform == "win32":
        return "Install FFmpeg and add it to PATH. Example: winget install Gyan.FFmpeg"
    if sys.platform == "darwin":
        return "Install FFmpeg with Homebrew: brew install ffmpeg"
    return "Install FFmpeg with your package manager, for example: sudo apt install ffmpeg"


def ensure_dependencies() -> dict[str, Any]:
    imported: dict[str, Any] = {}
    missing: list[str] = []
    for module_name, package_name in REQUIRED_MODULES.items():
        try:
            imported[module_name] = importlib.import_module(module_name)
        except ModuleNotFoundError:
            missing.append(package_name)
    if missing:
        deps = ", ".join(sorted(missing))
        if os.environ.get("OCTAVE_PACKAGED") == "1":
            raise IntegrationError(
                "This OCTAVE build is missing bundled STRUM Python dependencies: "
                f"{deps}. Reinstall or update the app so the bundled runtime matches the release."
            )
        raise IntegrationError(
            "Missing Python dependencies for STRUM integration: "
            f"{deps}. Install the packages from {requirements_path()}."
        )
    return imported


def resolve_device(torch_module: Any) -> str:
    try:
        if torch_module.cuda.is_available():
            return "cuda"
    except Exception:
        pass

    try:
        if torch_module.backends.mps.is_available():
            return "mps"
    except Exception:
        pass

    return "cpu"


def emit_device_diagnostics(run_id: str, torch_module: Any, selected_device: str) -> None:
    cuda_available = False
    cuda_device_name = "n/a"
    try:
        cuda_available = bool(torch_module.cuda.is_available())
        if cuda_available:
            cuda_device_name = str(torch_module.cuda.get_device_name(0))
    except Exception:
        pass

    mps_available = False
    try:
        mps_available = bool(torch_module.backends.mps.is_available())
    except Exception:
        pass

    emit_progress(
        run_id,
        "bootstrap",
        (
            f"Torch device diagnostics: selected={selected_device}, "
            f"cuda_available={cuda_available}, cuda_device={cuda_device_name}, mps_available={mps_available}"
        ),
        percent=5,
    )


def ensure_ffmpeg_available() -> None:
    if shutil.which("ffmpeg"):
        return
    raise IntegrationError(
        "FFmpeg was not found on PATH. Whisper needs FFmpeg to decode audio. "
        + ffmpeg_hint()
    )


def download_to_path(url: str, destination: Path, run_id: str, stage: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url) as response:
        total_header = response.headers.get("Content-Length")
        total_bytes = int(total_header) if total_header and total_header.isdigit() else 0
        bytes_read = 0
        with destination.open("wb") as handle:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                handle.write(chunk)
                bytes_read += len(chunk)
                if total_bytes > 0:
                    percent = min(99, int((bytes_read / total_bytes) * 100))
                    emit_progress(run_id, stage, f"Downloading {destination.name}", percent=percent)


def is_valid_source_root(source_root: Path) -> bool:
    return (source_root / "scripts" / "batch_pipeline.py").exists()


def copy_source_root(source_root: Path, destination_root: Path, run_id: str) -> None:
    if destination_root.exists():
        shutil.rmtree(destination_root)

    destination_root.parent.mkdir(parents=True, exist_ok=True)

    # Stage only runtime-critical STRUM source trees to avoid copying large local datasets.
    entries = [
        "scripts",
        "src",
        "configs",
        "pyproject.toml",
        "README.md",
    ]

    existing_entries: list[Path] = []
    for entry in entries:
        source_entry = source_root / entry
        if source_entry.exists():
            existing_entries.append(source_entry)

    if not existing_entries:
        raise IntegrationError(
            f"Local STRUM source at {source_root} is missing required folders."
        )

    total = len(existing_entries)
    for index, source_entry in enumerate(existing_entries, start=1):
        destination_entry = destination_root / source_entry.name
        emit_progress(
            run_id,
            "bootstrap",
            f"Staging local STRUM source: {source_entry.name}",
            percent=min(99, int((index / total) * 100)),
        )

        if source_entry.is_dir():
            shutil.copytree(
                source_entry,
                destination_entry,
                ignore=shutil.ignore_patterns(".git", "__pycache__", ".mypy_cache", ".pytest_cache"),
            )
        else:
            destination_entry.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_entry, destination_entry)


def resolve_local_source_override() -> Path | None:
    configured = os.environ.get("OCTAVE_STRUM_SOURCE_DIR", "").strip()
    if configured:
        configured_path = Path(configured).expanduser().resolve()
        if is_valid_source_root(configured_path):
            return configured_path

    worker_root = Path(__file__).resolve().parent
    candidates = [
        worker_root / "strum-source",
        Path.cwd() / "strum",
        Path.cwd().parent / "strum",
        Path.cwd() / "autocharter",
        Path.cwd().parent / "autocharter",
    ]

    for candidate in candidates:
        resolved = candidate.expanduser().resolve()
        if is_valid_source_root(resolved):
            return resolved

    return None


def bootstrap_source(cache_dir: Path, run_id: str) -> Path:
    # When an explicit source override is configured (e.g. dev/testing), use it directly
    # and skip the cache entirely so local changes take effect immediately.
    configured = os.environ.get("OCTAVE_STRUM_SOURCE_DIR", "").strip()
    if configured:
        configured_path = Path(configured).expanduser().resolve()
        if is_valid_source_root(configured_path):
            emit_progress(run_id, "bootstrap", f"Using local STRUM source override: {configured_path}", percent=100)
            return configured_path

    source_root = cache_dir / SOURCE_FOLDER_NAME
    if is_valid_source_root(source_root):
        version_marker = source_root / SOURCE_VERSION_FILE
        cached_version = version_marker.read_text(encoding="utf-8").strip() if version_marker.exists() else ""
        if cached_version == STRUM_SOURCE_VERSION:
            emit_progress(run_id, "bootstrap", "Using cached STRUM source.", percent=100)
            return source_root
        emit_progress(
            run_id,
            "bootstrap",
            f"Cached STRUM source is stale (have='{cached_version or 'none'}', want='{STRUM_SOURCE_VERSION}'). Refreshing...",
            percent=0,
        )
        try:
            shutil.rmtree(source_root)
        except Exception:
            pass

    local_source = resolve_local_source_override()
    if local_source is not None:
        emit_progress(run_id, "bootstrap", f"Using local STRUM source: {local_source}", percent=0)
        try:
            copy_source_root(local_source, source_root, run_id)
        except Exception as exc:
            raise IntegrationError(
                f"Failed to stage local STRUM source from {local_source}."
            ) from exc

        emit_progress(run_id, "bootstrap", "STRUM source ready from local checkout.", percent=100)
        try:
            (source_root / SOURCE_VERSION_FILE).write_text(STRUM_SOURCE_VERSION, encoding="utf-8")
        except Exception:
            pass
        return source_root

    emit_progress(run_id, "bootstrap", "Downloading STRUM source...", percent=0)
    with tempfile.TemporaryDirectory(prefix="octave-strum-src-") as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        zip_path = temp_dir / "strum-main.zip"
        try:
            download_to_path(GITHUB_ZIP_URL, zip_path, run_id, "bootstrap")
        except Exception as exc:
            raise IntegrationError(
                "Could not download STRUM source from GitHub. "
                f"Check your connection, set OCTAVE_STRUM_SOURCE_DIR to a local STRUM checkout, "
                f"or fetch it manually from {GITHUB_REPO_URL}."
            ) from exc

        try:
            with zipfile.ZipFile(zip_path) as archive:
                archive.extractall(temp_dir)
        except Exception as exc:
            raise IntegrationError("Downloaded STRUM source archive could not be extracted.") from exc

        extracted_roots = [child for child in temp_dir.iterdir() if child.is_dir() and child.name.startswith("strum-")]
        if not extracted_roots:
            raise IntegrationError("Downloaded STRUM source archive did not contain the expected folder layout.")

        extracted_root = extracted_roots[0]
        if source_root.exists():
            shutil.rmtree(source_root)
        source_root.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(extracted_root), str(source_root))

    try:
        (source_root / SOURCE_VERSION_FILE).write_text(STRUM_SOURCE_VERSION, encoding="utf-8")
    except Exception:
        pass

    emit_progress(run_id, "bootstrap", "STRUM source ready.", percent=100)
    return source_root


def mirror_checkpoint_layout(snapshot_root: Path, flat_root: Path, run_id: str) -> None:
    flat_root.mkdir(parents=True, exist_ok=True)
    total = len(CHECKPOINT_MAP)
    copied = 0
    for hub_relative, flat_relative in CHECKPOINT_MAP.items():
        source = snapshot_root / hub_relative
        if not source.exists():
            raise IntegrationError(
                "Checkpoint download completed but a required file is missing: "
                f"{hub_relative}. See {HF_REPO_URL}."
            )
        destination = flat_root / flat_relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if (not destination.exists()) or destination.stat().st_size != source.stat().st_size:
            shutil.copy2(source, destination)
        copied += 1
        percent = min(100, int((copied / total) * 100))
        emit_progress(run_id, "download", f"Preparing checkpoint {destination.name}", percent=percent)


def bootstrap_checkpoints(modules: dict[str, Any], cache_dir: Path, source_root: Path, run_id: str) -> Path:
    flat_root = source_root / "checkpoints"
    if all((flat_root / relative).exists() for relative in CHECKPOINT_MAP.values()):
        emit_progress(run_id, "download", "Using cached STRUM checkpoints.", percent=100)
        return flat_root

    snapshot_root = cache_dir / SNAPSHOT_FOLDER_NAME
    snapshot_root.mkdir(parents=True, exist_ok=True)
    emit_progress(run_id, "download", "Downloading STRUM checkpoints from Hugging Face...", percent=0)
    try:
        modules["huggingface_hub"].snapshot_download(
            repo_id=HF_REPO_ID,
            repo_type="model",
            local_dir=str(snapshot_root),
            local_dir_use_symlinks=False,
            resume_download=True,
        )
    except Exception as exc:
        if all((flat_root / relative).exists() for relative in CHECKPOINT_MAP.values()):
            emit_progress(run_id, "download", "Checkpoint refresh failed; continuing with cached checkpoints.", percent=100)
            return flat_root
        raise IntegrationError(
            "Could not download STRUM checkpoints. If you are offline, pre-populate the cache from "
            f"{HF_REPO_URL}."
        ) from exc

    mirror_checkpoint_layout(snapshot_root, flat_root, run_id)
    emit_progress(run_id, "download", "STRUM checkpoints ready.", percent=100)
    return flat_root


def add_source_paths(source_root: Path) -> None:
    candidates = [source_root, source_root / "scripts"]
    for candidate in candidates:
        candidate_str = str(candidate)
        if candidate_str not in sys.path:
            sys.path.insert(0, candidate_str)


def patch_hybrid_device(device: str) -> None:
    try:
        guitar_hybrid_v2 = importlib.import_module("src.inference.guitar_hybrid_v2")
    except Exception:
        return

    original = getattr(guitar_hybrid_v2, "_get_hybrid_charter", None)
    if original is None or getattr(original, "__octave_patched__", False):
        return

    def wrapped(device_arg: str | None = None):
        return original(device=device_arg or device)

    setattr(wrapped, "__octave_patched__", True)
    guitar_hybrid_v2._get_hybrid_charter = wrapped


def build_pipeline(source_root: Path, output_dir: Path, device: str, include_keys: bool):
    add_source_paths(source_root)
    batch_pipeline_module = importlib.import_module("batch_pipeline")
    vocals_module = importlib.import_module("vocals_charter")
    patch_hybrid_device(device)
    batch_pipeline_cls = getattr(batch_pipeline_module, "BatchPipeline")
    vocals_charter_cls = getattr(vocals_module, "VocalsCharter")

    class OctaveBatchPipeline(batch_pipeline_cls):
        def parse_filename(self, path: Path):
            """Prefer Artist-Title parsing for downloaded media and strip YouTube ID suffixes."""
            name = path.stem

            # ytdlp template uses "...-<video_id>"; strip trailing ID for cleaner parsing.
            name = re.sub(r"-[A-Za-z0-9_-]{11}$", "", name).strip()

            if " - " in name:
                artist, title = name.split(" - ", 1)
                # Remove common YouTube title noise to improve metadata matching.
                title = re.sub(
                    r"\s*\((official(\s+music)?\s+video|official\s+video|lyric\s+video)\)\s*",
                    "",
                    title,
                    flags=re.IGNORECASE,
                ).strip()
                if artist and title:
                    return artist.strip(), title

            return super().parse_filename(path)

        @property
        def vocals_charter(self):
            if self._vocals_charter is None and self.include_vocals:
                logging.getLogger(__name__).info("Loading vocals charter (Whisper)...")
                # Use VocalsCharter's default whisper model to match the STRUM
                # benchmark transcription quality. Override with
                # OCTAVE_WHISPER_MODEL if a smaller model is needed for speed.
                whisper_kwargs = {}
                whisper_override = os.environ.get("OCTAVE_WHISPER_MODEL", "").strip()
                if whisper_override:
                    whisper_kwargs["whisper_model"] = whisper_override
                self._vocals_charter = vocals_charter_cls(device=device, **whisper_kwargs)
            return self._vocals_charter

        def separate_stems(self, audio_path: Path, work_dir: Path):
            logger = logging.getLogger(__name__)
            logger.info(f"  Separating stems with Demucs on device={device}...")

            demucs_out = work_dir / "demucs_temp"
            demucs_out.mkdir(parents=True, exist_ok=True)

            cmd = [
                sys.executable,
                "-m",
                "demucs",
                "-n",
                self.demucs_model,
                "-d",
                device,
                "-o",
                str(demucs_out),
                str(audio_path),
            ]

            started_at = time.time()
            try:
                result = subprocess.run(cmd, timeout=AUDIO_SEPARATION_TIMEOUT_SEC)
            except subprocess.TimeoutExpired as exc:
                raise RuntimeError(
                    f"Demucs separation timed out after {AUDIO_SEPARATION_TIMEOUT_SEC}s."
                ) from exc

            elapsed = int(time.time() - started_at)
            if result.returncode != 0:
                raise RuntimeError(f"Demucs failed with return code {result.returncode} after {elapsed}s")

            logger.info(f"    Demucs separation complete in {elapsed}s")

            stem_dir = demucs_out / self.demucs_model / audio_path.stem
            stems = {}
            for stem in ["drums", "bass", "other", "vocals", "guitar", "piano"]:
                stem_path = stem_dir / f"{stem}.wav"
                if stem_path.exists():
                    stems[stem] = stem_path

            logger.info(f"    Separated stems: {list(stems.keys())}")
            return stems

        @property
        def drums_engine(self):
            """Override to handle DrumsInferenceEngine version mismatches.

            If the engine accepts use_v11, delegate entirely (new engine).

            If the engine is old (no use_v11 param), it cannot load V11 checkpoints
            because the state dict has v6.*-prefixed keys for the V11 wrapper class.
            Work-around:
              1. Init the engine with drums_v6.2 (works fine; sets up mel_transform,
                 is_8class=False, thresholds, etc.).
              2. Instantiate DrumsCRNN_V11 (imports the model class from source).
              3. Load drums_v11/best.pt state dict into it — all v6.* / correction_head.*
                 keys now map correctly to DrumsCRNN_V11's sub-modules.
              4. Swap engine.model for the V11 model.
            DrumsCRNN_V11.forward() in eval mode returns {onsets, cymbals, velocities,
            tom_correction}; transcribe() only reads the first three, so it works as-is.
            """
            if self._drums_engine is None and self.include_drums:
                from src.inference.drums_cli import DrumsInferenceEngine
                import inspect
                logger = logging.getLogger(__name__)
                sig = inspect.signature(DrumsInferenceEngine.__init__)
                if "use_v11" in sig.parameters:
                    logger.info("Loading drums model (V11, native engine)...")
                    self._drums_engine = DrumsInferenceEngine(
                        checkpoint_path=self.drums_checkpoint,
                        device=str(self.device),
                        use_v11=self.use_v11,
                    )
                else:
                    # Old engine: init with V6.2 to bootstrap all non-model state.
                    logger.info(
                        "DrumsInferenceEngine does not support use_v11; "
                        "bootstrapping with V6.2 then swapping in DrumsCRNN_V11..."
                    )
                    engine = DrumsInferenceEngine(
                        checkpoint_path="checkpoints/drums_v6.2/best.pt",
                        device=str(self.device),
                    )
                    if getattr(self, "use_v11", True):
                        import torch
                        from src.models.drums_v11 import DrumsCRNN_V11
                        logger.info(f"Loading DrumsCRNN_V11 from {self.drums_checkpoint}...")
                        v11_model = DrumsCRNN_V11().to(engine.device)
                        ckpt = torch.load(
                            self.drums_checkpoint,
                            map_location=engine.device,
                            weights_only=False,
                        )
                        v11_model.load_state_dict(ckpt["model_state_dict"])
                        v11_model.eval()
                        engine.model = v11_model
                        logger.info("DrumsCRNN_V11 swapped in successfully.")
                    self._drums_engine = engine
            return self._drums_engine

        def _with_fast_crepe(self, fn, *args, **kwargs):
            """Optionally override CREPE model capacity via OCTAVE_CREPE_MODEL.

            The STRUM benchmark used CREPE's default capacity ('full'), so we
            no longer force 'tiny'. Set OCTAVE_CREPE_MODEL=tiny|small|medium
            for faster (lower-quality) pitch detection.
            """
            cap = os.environ.get("OCTAVE_CREPE_MODEL", "").strip()
            if not cap:
                return fn(*args, **kwargs)
            import src.inference.guitar_bass as _gb
            orig = _gb.detect_pitches_crepe
            def _patched(*a, **kw):
                kw['model_capacity'] = cap
                return orig(*a, **kw)
            try:
                _gb.detect_pitches_crepe = _patched
                return fn(*args, **kwargs)
            finally:
                _gb.detect_pitches_crepe = orig

        def transcribe_guitar(self, other_stem: Path, tempo_bpm: float):
            # TF is now bundled, so Basic Pitch uses its default TF model path
            # (matches the STRUM benchmark). CREPE capacity is left at its
            # default unless OCTAVE_CREPE_MODEL is set.
            return self._with_fast_crepe(super().transcribe_guitar, other_stem, tempo_bpm)

        def transcribe_bass(self, bass_stem: Path, tempo_bpm: float):
            return self._with_fast_crepe(super().transcribe_bass, bass_stem, tempo_bpm)

        def analyze_audio(self, audio_path: Path, artist: str = '', title: str = ''):
            if not FAST_AUDIO_ANALYSIS:
                return super().analyze_audio(audio_path, artist, title)

            logger = logging.getLogger(__name__)
            logger.info("  Analyzing audio (fast mode)...")

            duration_sec = 0.0
            try:
                soundfile_module = importlib.import_module("soundfile")
                duration_sec = float(soundfile_module.info(str(audio_path)).duration)
            except Exception:
                try:
                    librosa_module = importlib.import_module("librosa")
                    duration_sec = float(librosa_module.get_duration(path=str(audio_path)))
                except Exception:
                    duration_sec = 0.0

            if duration_sec <= 0:
                duration_sec = 180.0

            preview_sec = min(30.0, max(5.0, duration_sec * 0.2))
            metadata = {"album": "", "year": "", "genre": ""}
            try:
                metadata = self._extract_metadata(audio_path)
            except Exception:
                pass

            # Fast mode still enriches metadata via MusicBrainz when tags are missing.
            if FAST_AUDIO_METADATA_LOOKUP and artist and title and (
                not metadata.get("album") or not metadata.get("year") or not metadata.get("genre")
            ):
                try:
                    mb_metadata = self._fetch_musicbrainz_metadata(artist, title)
                    if not metadata.get("album") and mb_metadata.get("album"):
                        metadata["album"] = mb_metadata["album"]
                    if not metadata.get("year") and mb_metadata.get("year"):
                        metadata["year"] = mb_metadata["year"]
                    if not metadata.get("genre") and mb_metadata.get("genre"):
                        metadata["genre"] = mb_metadata["genre"]
                except Exception:
                    pass

            logger.info(f"  Tempo (fast default): 120 BPM, Duration: {duration_sec:.1f}s")

            return {
                "tempo_bpm": 120,
                "duration_ms": int(duration_sec * 1000),
                "duration_sec": duration_sec,
                "preview_start_ms": int(preview_sec * 1000),
                "album": metadata.get("album", ""),
                "year": metadata.get("year", ""),
                "genre": metadata.get("genre", ""),
            }

    return OctaveBatchPipeline(
        output_dir=output_dir,
        include_drums=True,
        include_guitar=True,
        include_bass=True,
        include_vocals=True,
        include_keys=include_keys,
        include_video=False,
        device=device,
    )


def sanitize_filename(name: str, fallback: str) -> str:
    safe = "".join(char if char not in '<>:"/\\|?*' else "_" for char in name).strip()
    return safe or fallback


def is_direct_audio_url(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    suffix = Path(parsed.path).suffix.lower()
    return suffix in DIRECT_AUDIO_URL_EXTENSIONS


def download_direct_audio(url: str, target_dir: Path, run_id: str) -> Path:
    parsed = urllib.parse.urlparse(url)
    filename = Path(parsed.path).name or "downloaded-audio"
    filename = sanitize_filename(filename, "downloaded-audio")
    destination = target_dir / filename
    emit_progress(run_id, "download", f"Downloading audio URL: {url}", current_item=url)
    download_to_path(url, destination, run_id, "download")
    return destination


def download_youtube_audio(url: str, target_dir: Path, run_id: str) -> Path:
    try:
        yt_dlp = importlib.import_module("yt_dlp")
    except ModuleNotFoundError as exc:
        raise IntegrationError(
            "yt-dlp is required for YouTube and remote media URLs. Install the packages from "
            f"{requirements_path()}."
        ) from exc

    ensure_ffmpeg_available()
    target_dir.mkdir(parents=True, exist_ok=True)
    before = {entry.resolve() for entry in target_dir.iterdir()} if target_dir.exists() else set()

    def hook(progress_data: dict[str, Any]) -> None:
        if progress_data.get("status") == "downloading":
            total = progress_data.get("total_bytes") or progress_data.get("total_bytes_estimate") or 0
            downloaded = progress_data.get("downloaded_bytes") or 0
            percent = int((downloaded / total) * 100) if total else None
            emit_progress(run_id, "download", f"Downloading media URL: {url}", percent=percent, current_item=url)

    output_template = str(target_dir / "%(title).180B-%(id)s.%(ext)s")
    options = {
        "format": "bestaudio/best",
        "noplaylist": True,
        "outtmpl": output_template,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }],
    }
    with yt_dlp.YoutubeDL(options) as downloader:
        downloader.extract_info(url, download=True)

    after = [entry.resolve() for entry in target_dir.iterdir() if entry.resolve() not in before and entry.is_file()]
    for candidate in sorted(after, key=lambda path: path.stat().st_mtime, reverse=True):
        if candidate.suffix.lower() in AUDIO_EXTENSIONS or candidate.suffix.lower() == ".mp3":
            return candidate

    raise IntegrationError(f"Downloaded media from {url}, but no supported audio file was produced.")


def collect_audio_sources(payload: dict[str, Any], cache_dir: Path, run_id: str) -> list[Path]:
    sources: list[Path] = []

    for raw_file in payload.get("files", []):
        candidate = Path(raw_file).expanduser().resolve()
        if not candidate.exists() or not candidate.is_file():
            raise IntegrationError(f"Input audio file does not exist: {candidate}")
        if candidate.suffix.lower() not in AUDIO_EXTENSIONS:
            raise IntegrationError(f"Unsupported audio file type: {candidate.name}")
        sources.append(candidate)

    for raw_folder in payload.get("folders", []):
        folder = Path(raw_folder).expanduser().resolve()
        if not folder.exists() or not folder.is_dir():
            raise IntegrationError(f"Input folder does not exist: {folder}")
        folder_sources = sorted(
            entry.resolve()
            for entry in folder.iterdir()
            if entry.is_file() and entry.suffix.lower() in AUDIO_EXTENSIONS
        )
        if not folder_sources:
            raise IntegrationError(f"No supported audio files were found in {folder}")
        sources.extend(folder_sources)

    url_inputs = [url.strip() for url in payload.get("urls", []) if str(url).strip()]
    if url_inputs:
        download_dir = cache_dir / "downloaded-inputs" / payload["runId"]
        download_dir.mkdir(parents=True, exist_ok=True)
        for url in url_inputs:
            parsed = urllib.parse.urlparse(url)
            if parsed.scheme not in {"http", "https"}:
                raise IntegrationError(f"Only HTTP and HTTPS URLs are supported: {url}")
            if is_direct_audio_url(url):
                sources.append(download_direct_audio(url, download_dir, run_id))
            else:
                sources.append(download_youtube_audio(url, download_dir, run_id))

    unique_sources: list[Path] = []
    seen = set()
    for source in sources:
        key = str(source)
        if key not in seen:
            seen.add(key)
            unique_sources.append(source)
    return unique_sources


def run_pipeline(payload: dict[str, Any]) -> int:
    run_id = str(payload["runId"])
    cache_dir = Path(payload["cacheDir"]).expanduser().resolve()
    output_dir = Path(payload["outputDir"]).expanduser().resolve()
    include_keys = bool(payload.get("includeKeys", True))

    modules = ensure_dependencies()
    torch_module = modules["torch"]
    device = resolve_device(torch_module)
    install_logging_bridge(run_id)
    emit_progress(run_id, "bootstrap", f"Selected STRUM device: {device}", percent=0)
    emit_device_diagnostics(run_id, torch_module, device)
    print(f"Selected STRUM device: {device}", flush=True)

    ensure_ffmpeg_available()
    source_root = bootstrap_source(cache_dir, run_id)
    bootstrap_checkpoints(modules, cache_dir, source_root, run_id)
    # STRUM uses relative paths (e.g. checkpoints/drums_v11/best.pt), so CWD must be source root.
    os.chdir(source_root)
    pipeline = build_pipeline(source_root, output_dir, device, include_keys)
    sources = collect_audio_sources(payload, cache_dir, run_id)
    if not sources:
        raise IntegrationError("No input audio sources were provided.")

    output_dir.mkdir(parents=True, exist_ok=True)
    song_folders: list[str] = []
    errors: list[str] = []

    for index, source in enumerate(sources, start=1):
        # Reserve 25-95% for per-song processing so long model steps do not appear frozen at 0%.
        source_start_percent = 25 + int(((index - 1) / max(1, len(sources))) * 70)
        emit_progress(
            run_id,
            "separation",
            f"Processing {index}/{len(sources)}: {source.name}",
            percent=source_start_percent,
            current_item=source.name,
        )
        song_started_at = time.time()
        result = pipeline.process_song(source)
        elapsed = int(time.time() - song_started_at)
        emit_progress(
            run_id,
            "merge",
            f"Finished processing {source.name} in {elapsed}s",
            percent=min(95, source_start_percent + 60),
            current_item=source.name,
        )
        if result.success:
            song_folders.append(result.output_path)
        if result.error:
            errors.append(f"{source.name}: {result.error}")

    success = len(song_folders) > 0
    emit_complete(
        run_id,
        success=success,
        outputDir=str(output_dir),
        songFolders=song_folders,
        errors=errors,
    )
    return 0 if success else 1


def load_payload(payload_file: Path) -> dict[str, Any]:
    try:
        return json.loads(payload_file.read_text(encoding="utf-8"))
    except Exception as exc:
        raise IntegrationError(f"Could not read payload file: {payload_file}") from exc


def main() -> int:
    parser = argparse.ArgumentParser(description="Run STRUM auto-charting for OCTAVE.")
    parser.add_argument("--payload-file", required=True, type=Path)
    args = parser.parse_args()

    payload = load_payload(args.payload_file)
    try:
        return run_pipeline(payload)
    except IntegrationError as exc:
        emit_error(str(payload.get("runId", "unknown")), str(exc))
        print(str(exc), file=sys.stderr, flush=True)
        return 1
    except KeyboardInterrupt:
        emit_error(str(payload.get("runId", "unknown")), "Auto-chart run was cancelled.")
        return 130
    except Exception as exc:
        emit_error(str(payload.get("runId", "unknown")), f"Unhandled STRUM worker error: {exc}")
        print(f"Unhandled STRUM worker error: {exc}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())