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
# Hard wall-clock ceiling for stem separation. Slow (often older) CPUs can
# legitimately take >15 min per song with the Python demucs fallback, which is
# exactly the hardware that needs the fallback in the first place (GitHub
# issue #9) — so the cap is generous and separation is instead supervised by
# an idle watchdog (below) that only kills the process when it stops making
# progress entirely.
AUDIO_SEPARATION_TIMEOUT_SEC = int(os.environ.get("OCTAVE_STRUM_SEPARATION_TIMEOUT_SEC", "3600"))
# Stall watchdog: kill separation only if the subprocess produces no output at
# all for this long. demucs (tqdm) and demucs.cpp both emit progress
# continuously while working, so silence this long means a genuine hang.
AUDIO_SEPARATION_IDLE_TIMEOUT_SEC = int(os.environ.get("OCTAVE_STRUM_SEPARATION_IDLE_TIMEOUT_SEC", "300"))
# Fast analysis bypasses real tempo/key detection and forces 120 BPM. The
# STRUM benchmark used real detected tempo (feeds STRUM_PHASE_ALIGN beat-grid
# alignment + tempo-relative drum heuristics), so default to OFF for chart
# quality. Set OCTAVE_STRUM_FAST_ANALYSIS=1 only for quick previews.
FAST_AUDIO_ANALYSIS = os.environ.get("OCTAVE_STRUM_FAST_ANALYSIS", "0") != "0"
FAST_AUDIO_METADATA_LOOKUP = os.environ.get("OCTAVE_STRUM_FAST_METADATA_LOOKUP", "1") != "0"
# When OCTAVE_STRUM_DISABLE_ONLINE_LOOKUP=1, all online metadata/album-art/lyric
# lookups are suppressed. Used by the UI's offline-mode toggle so custom uploads
# aren't misidentified against MusicBrainz / iTunes / etc.
DISABLE_ONLINE_LOOKUP = os.environ.get("OCTAVE_STRUM_DISABLE_ONLINE_LOOKUP", "0") == "1"
SKIP_HARMONIES = os.environ.get("OCTAVE_STRUM_SKIP_HARMONIES", "0") == "1"
# Maps a song-mix Path to a dict of stem-name → stem Path. Populated by
# collect_audio_sources() when the user provides a pre-split stems folder;
# consulted by OctaveBatchPipeline.separate_stems() to skip Demucs.
PRESPLIT_STEM_REGISTRY: dict[Path, dict[str, Path]] = {}
# Maps a lead-vocals Path to the audio file that should drive harmony
# (HARM2/HARM3) detection. Populated when the user provides backing-vocals
# stems via the per-instrument upload UI; consulted by the
# OctaveVocalsCharter.detect_harmonies override.
HARMONY_OVERRIDE_REGISTRY: dict[Path, Path] = {}
# Maps a song-mix Path to extra audio files (uncharted) that should be
# merged into other.ogg alongside the user-supplied "other" stem (if any)
# so all uncharted musical content plays back in-game. Populated by
# collect_audio_sources(); consumed by OctaveBatchPipeline.convert_to_ogg.
EXTRAS_REGISTRY: dict[Path, list[Path]] = {}
# Maps a song-mix Path to a user-supplied crowd audio file. Exported
# directly as crowd.ogg (CH/YARG play this as ambient crowd noise).
CROWD_REGISTRY: dict[Path, Path] = {}
# Maps a song-mix Path to backing-vocals stems that should be exported as
# vocals_1.ogg / vocals_2.ogg for in-game playback alongside the main mix.
BACKING_VOCALS_REGISTRY: dict[Path, dict[str, Path]] = {}
# Maps a downloaded audio Path back to the original URL it came from. Used
# to surface URL→song-folder pairings in the completion event so the host
# can optionally pull the source video into the same song folder.
URL_SOURCE_REGISTRY: dict[Path, str] = {}
# When True, stems produced by Demucs separation are exported as per-instrument
# oggs (drums.ogg, bass.ogg, …) in the song folder instead of being discarded
# after charting. Set from the payload's "keepStems" flag in run_pipeline().
KEEP_STEMS = False
# Maps a song-mix Path to the stem-name → stem Path dict produced by Demucs.
# Populated by OctaveBatchPipeline.separate_stems() when KEEP_STEMS is on and
# consumed by convert_to_ogg() to write the per-instrument oggs.
SEPARATED_STEM_REGISTRY: dict[Path, dict[str, Path]] = {}
# User-supplied tempo map (sorted by timeSec). When non-empty, the first
# entry's BPM overrides STRUM's auto-detected initial tempo and the full list
# is written to each song's notes.mid (note ticks are retimed so real-world
# note positions stay aligned with the audio). See _retime_midi_to_tempo_map.
USER_TEMPO_MAP: list[tuple[float, float]] = []
# When False, strip PART REAL_KEYS_X tracks from notes.mid so users can
# disable Pro Keys output even though upstream STRUM always generates them
# alongside the standard 5-lane keys track.
INCLUDE_PRO_KEYS: bool = True
# Optional drum grid-snap. When SNAP_DRUMS is True, each drum note in
# notes.mid is nudged to the nearest 1/SNAP_DRUMS_DIVISION grid line, but ONLY
# when it already lies within SNAP_DRUMS_WINDOW_MS of that line. Onsets that
# are further off (genuine syncopation / fills) are left untouched. This kills
# the "off by a 32nd note" jitter caused by onset-detector timing error
# without quantizing away intentionally-loose playing. Off by default.
SNAP_DRUMS: bool = False
SNAP_DRUMS_DIVISION: int = 32  # grid resolution: 32 = thirty-second notes
SNAP_DRUMS_WINDOW_MS: float = 40.0  # only snap onsets already within this window
# Automatic tempo refinement (the "notes drift off the beat lines" fix). When
# AUTO_TEMPO is True (default), after STRUM writes notes.mid the worker re-fits
# the tempo grid to the detected note onsets instead of trusting STRUM's single
# global BPM. It corrects a slightly-wrong global tempo (e.g. 120.0 vs 119.7,
# which otherwise drifts notes a little further off the grid every bar) and
# clear octave errors. When AUTO_TEMPO_DRIFT is on it also builds a piecewise
# tempo map for songs whose tempo genuinely changes (live recordings, no click).
# Real-world note times are preserved — only the tempo and each note's tick move
# — so audio stays in sync while notes land on the grid. AUTO_TEMPO_SNAP then
# nudges any residual onset-detector jitter (within a tight window) onto the
# grid across every instrument track. The whole pass is skipped when the user
# supplies an explicit USER_TEMPO_MAP (their override wins).
AUTO_TEMPO: bool = True
AUTO_TEMPO_DRIFT: bool = True
AUTO_TEMPO_SNAP: bool = True
AUTO_TEMPO_SNAP_DIVISION: int = 32  # grid resolution for residual jitter snap
AUTO_TEMPO_SNAP_WINDOW_MS: float = 30.0  # only snap onsets already this close
# Optional single-BPM hint. Unlike USER_TEMPO_MAP (a full explicit override that
# disables auto-refinement), the hint is the user's authoritative "Manual BPM":
# it seeds the audio beat tracker so it locks onto the correct tempo octave and,
# when drift is disabled, is applied verbatim. Empty = detect from the audio.
TEMPO_HINT_BPM: "float | None" = None
# One-shot flag so we only emit the basic_pitch troubleshooting hint once
# per worker run (the same error fires for guitar+bass+keys).
_BASIC_PITCH_HINT_EMITTED = False


def _diagnose_basic_pitch_failure(exc: BaseException) -> None:
    """If `exc` looks like a basic_pitch SavedModel load failure, print a
    targeted, actionable hint to stderr (once per worker run). The most
    common cause we've seen is cross-version site-packages contamination
    (e.g. a 3.11 interpreter loading wheels installed for 3.10)."""
    global _BASIC_PITCH_HINT_EMITTED
    if _BASIC_PITCH_HINT_EMITTED:
        return
    msg = str(exc)
    if "basic_pitch" not in msg and "icassp_2022" not in msg:
        return
    _BASIC_PITCH_HINT_EMITTED = True
    import sys as _sys
    site_paths = [p for p in _sys.path if "site-packages" in p]
    print(
        "[OCTAVE] !!! basic_pitch model failed to load. This usually means the\n"
        "         basic_pitch install is incomplete OR the running Python is\n"
        "         loading wheels built for a different Python version (check\n"
        "         %APPDATA%\\Python\\PythonXY\\site-packages on Windows and the\n"
        "         PYTHONPATH env var). Detected interpreter: "
        f"{_sys.version.split()[0]} at {_sys.executable}\n"
        f"         site-packages on path: {site_paths}\n"
        "         Fix: pip install --force-reinstall basic-pitch tensorflow\n"
        "         under the SAME interpreter Octave launches (or set\n"
        "         OCTAVE_STRUM_PYTHON to a venv that has them).",
        file=_sys.stderr, flush=True,
    )


def _sanitize_string_to_latin1(s: str) -> str:
    if not s:
        return s
    _SMART_MAP = {
        "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'",
        "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u201f": '"',
        "\u2013": "-", "\u2014": "-", "\u2026": "...",
        "\u266a": "", "\u266b": "", "\u266c": "", "\u2669": "",
        "\xa0": " ",
    }
    for k, v in _SMART_MAP.items():
        if k in s:
            s = s.replace(k, v)
    try:
        return s.encode("latin-1", errors="ignore").decode("latin-1")
    except Exception:
        return s


def _run_separation_subprocess(cmd: "list[str]", label: str) -> "tuple[int, int]":
    """Run a stem-separation subprocess supervised by a stall watchdog.

    The old fixed 900s wall-clock timeout killed perfectly healthy runs on
    slow CPUs — exactly the older hardware that falls back to the Python
    demucs engine after a demucs.cpp SIMD crash (GitHub issue #9). Instead of
    judging by elapsed time, watch the process's combined stdout/stderr:
    demucs (tqdm progress bars) and demucs.cpp both print continuously while
    working, so we only kill the process when it has been completely silent
    for AUDIO_SEPARATION_IDLE_TIMEOUT_SEC (a genuine hang), or exceeds the
    much more generous AUDIO_SEPARATION_TIMEOUT_SEC hard ceiling.

    Output is forwarded to this worker's stderr so the host app's progress
    parsing keeps working. Returns ``(returncode, elapsed_seconds)``.
    """
    import threading

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    last_activity = time.time()
    completed_progress = False

    def _pump() -> None:
        nonlocal last_activity, completed_progress
        stream = proc.stdout
        if stream is None:
            return
        try:
            while True:
                # read1 returns as soon as any data is available (tqdm emits
                # \r-terminated updates, so line-based reads would block).
                chunk = stream.read1(65536)  # type: ignore[attr-defined]
                if not chunk:
                    break
                last_activity = time.time()
                try:
                    # Detect progress bar completion to bypass idle timeout during post-completion write.
                    text = chunk.decode("utf-8", errors="ignore")
                    if "100%" in text:
                        completed_progress = True
                except Exception:
                    pass
                try:
                    sys.stderr.buffer.write(chunk)
                    sys.stderr.flush()
                except Exception:
                    pass
        except Exception:
            pass

    pump_thread = threading.Thread(target=_pump, daemon=True)
    pump_thread.start()

    started_at = time.time()
    while True:
        returncode = proc.poll()
        if returncode is not None:
            pump_thread.join(timeout=5)
            return returncode, int(time.time() - started_at)
        now = time.time()
        if now - started_at > AUDIO_SEPARATION_TIMEOUT_SEC:
            proc.kill()
            raise RuntimeError(
                f"{label} exceeded the {AUDIO_SEPARATION_TIMEOUT_SEC}s hard limit. "
                "Set OCTAVE_STRUM_SEPARATION_TIMEOUT_SEC to raise it."
            )
        if not completed_progress and now - last_activity > AUDIO_SEPARATION_IDLE_TIMEOUT_SEC:
            proc.kill()
            raise RuntimeError(
                f"{label} stalled (no output for {AUDIO_SEPARATION_IDLE_TIMEOUT_SEC}s) "
                f"and was stopped after {int(now - started_at)}s."
            )
        time.sleep(1.0)


if DISABLE_ONLINE_LOOKUP:
    FAST_AUDIO_METADATA_LOOKUP = False
AUDIO_EXTENSIONS = {".wav", ".mp3", ".ogg", ".opus", ".flac"}
DIRECT_AUDIO_URL_EXTENSIONS = AUDIO_EXTENSIONS | {".m4a"}
REQUIRED_MODULES = {
    "torch": "torch",
    "torchaudio": "torchaudio",
    "librosa": "librosa",
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
    # Force-reset root logger so any later `logging.basicConfig()` (e.g.
    # batch_pipeline.py at import time) cannot replace our handler. Also
    # mirror records to stderr so per-instrument log lines survive even if
    # the bridge gets unexpectedly detached.
    root_logger = logging.getLogger()
    for existing in list(root_logger.handlers):
        root_logger.removeHandler(existing)
    handler = ForwardToOctaveHandler(run_id)
    handler.setLevel(logging.INFO)
    handler.setFormatter(logging.Formatter("%(message)s"))
    stderr_handler = logging.StreamHandler(sys.stderr)
    stderr_handler.setLevel(logging.INFO)
    stderr_handler.setFormatter(logging.Formatter("%(name)s: %(message)s"))
    root_logger.addHandler(handler)
    root_logger.addHandler(stderr_handler)
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

    def wrapped(device: str | None = None):
        return original(device=device or wrapped.__octave_default_device__)
    wrapped.__octave_default_device__ = device  # type: ignore[attr-defined]

    setattr(wrapped, "__octave_patched__", True)
    guitar_hybrid_v2._get_hybrid_charter = wrapped


def _install_offline_lookup_stubs(batch_pipeline_cls) -> None:
    """Replace STRUM source's online metadata/album-art/lyric methods with no-ops.

    Called when OCTAVE_STRUM_DISABLE_ONLINE_LOOKUP=1. Keeps the pipeline running
    with whatever metadata is already embedded in the audio file's tags, and
    prevents custom uploads from being misidentified against MusicBrainz.
    """
    logger = logging.getLogger(__name__)
    logger.info("Offline mode enabled: stubbing STRUM online lookups.")

    def _stub_bool(self, *_args, **_kwargs):
        return False

    def _stub_dict(self, *_args, **_kwargs):
        return {}

    # STRUM's batch_pipeline accesses mb_metadata['album'/'year'/'genre'] directly
    # (no .get), so the offline stub must return all three keys to avoid KeyError.
    def _stub_metadata_dict(self, *_args, **_kwargs):
        return {"album": "", "year": "", "genre": ""}

    for name in ("_quick_musicbrainz_check",):
        if hasattr(batch_pipeline_cls, name):
            setattr(batch_pipeline_cls, name, _stub_bool)
    for name in ("_fetch_musicbrainz_metadata",):
        if hasattr(batch_pipeline_cls, name):
            setattr(batch_pipeline_cls, name, _stub_metadata_dict)
    for name in ("fetch_album_art", "_fetch_itunes_art", "fetch_music_video"):
        if hasattr(batch_pipeline_cls, name):
            setattr(batch_pipeline_cls, name, _stub_bool)

    try:
        unified_module = importlib.import_module("src.inference.unified")
        unified_cls = getattr(unified_module, "UnifiedAutoCharter", None)
        if unified_cls is not None and hasattr(unified_cls, "fetch_song_metadata"):
            unified_cls.fetch_song_metadata = _stub_dict  # type: ignore[assignment]
    except Exception:
        pass

    try:
        lyrics_fetcher = importlib.import_module("src.lyrics.fetcher")
        for name in ("fetch_from_lrclib", "fetch_from_lyrics_ovh", "fetch_lyrics"):
            if hasattr(lyrics_fetcher, name):
                setattr(lyrics_fetcher, name, lambda *_a, **_k: None)
    except Exception:
        pass

    # Defense-in-depth: block outbound HTTP at the network layer so any
    # fetcher we missed (or future upstream additions) cannot leak art /
    # lyrics / metadata. Existing try/except blocks in STRUM swallow these.
    _BLOCKED_HOST_HINTS = (
        "musicbrainz", "coverartarchive", "itunes.apple", "lrclib",
        "lyrics.ovh", "genius.com", "deezer", "spotify", "last.fm",
        "discogs", "audiodb",
    )
    def _is_blocked_url(url: str) -> bool:
        u = (url or "").lower()
        return any(h in u for h in _BLOCKED_HOST_HINTS)
    try:
        import requests as _requests
        _orig_request = _requests.api.request
        def _guarded_request(method, url, *a, **kw):
            if _is_blocked_url(url):
                raise _requests.exceptions.ConnectionError(
                    f"[OCTAVE offline mode] blocked {method} {url}"
                )
            return _orig_request(method, url, *a, **kw)
        _requests.api.request = _guarded_request
        _requests.get = lambda url, **kw: _guarded_request("GET", url, **kw)
        _requests.post = lambda url, data=None, json=None, **kw: _guarded_request("POST", url, data=data, json=json, **kw)
    except Exception:
        pass
    try:
        import urllib.request as _urlreq
        _orig_urlopen = _urlreq.urlopen
        def _guarded_urlopen(url, *a, **kw):
            target = url.full_url if hasattr(url, "full_url") else str(url)
            if _is_blocked_url(target):
                raise OSError(f"[OCTAVE offline mode] blocked urlopen {target}")
            return _orig_urlopen(url, *a, **kw)
        _urlreq.urlopen = _guarded_urlopen
    except Exception:
        pass


def build_pipeline(
    source_root: Path,
    output_dir: Path,
    device: str,
    include_keys: bool,
    enabled_tracks: dict[str, bool] | None = None,
):
    add_source_paths(source_root)
    batch_pipeline_module = importlib.import_module("batch_pipeline")
    vocals_module = importlib.import_module("vocals_charter")
    patch_hybrid_device(device)
    batch_pipeline_cls = getattr(batch_pipeline_module, "BatchPipeline")
    vocals_charter_cls = getattr(vocals_module, "VocalsCharter")

    if DISABLE_ONLINE_LOOKUP:
        _install_offline_lookup_stubs(batch_pipeline_cls)

    if SKIP_HARMONIES:
        # Skip harmony detection entirely (saves a full whisper pass on the
        # backing-vocals stem). Returning [] is the no-harmonies contract
        # upstream batch_pipeline already handles for songs without backing
        # vocals.
        def _no_harmonies(self, *_a, **_kw):
            return []
        if hasattr(vocals_charter_cls, "detect_harmonies"):
            vocals_charter_cls.detect_harmonies = _no_harmonies
        logging.getLogger(__name__).info("Skip-harmonies enabled: harmony detection disabled.")

    class OctaveVocalsCharter(vocals_charter_cls):
        """VocalsCharter that prefers a native whisper.cpp binary when the
        main process has provisioned one (OCTAVE_WHISPER_CPP_BIN +
        OCTAVE_WHISPER_CPP_MODEL env vars). Falls back to the Python
        `whisper` package otherwise.
        """

        def detect_harmonies(self, audio_path, lead_phrases):
            # When the user supplied dedicated backing-vocals stems for this
            # song, run harmony detection against those instead of re-using
            # the lead vocals stem. Lead vocals stay strictly lead.
            try:
                override = HARMONY_OVERRIDE_REGISTRY.get(Path(audio_path).resolve())
            except Exception:
                override = None
            if override is not None:
                logging.getLogger(__name__).info(
                    f"  Routing harmony detection to user-supplied backing vocals: {override.name}"
                )
                audio_path = str(override)
            return super().detect_harmonies(audio_path, lead_phrases)

        def transcribe_vocals(self, vocals_stem: Path, artist: str, title: str):
            print(f"[OCTAVE] >>> transcribe_vocals(stem={vocals_stem.name})", file=sys.stderr, flush=True)
            artist = _sanitize_string_to_latin1(artist)
            title = _sanitize_string_to_latin1(title)
            try:
                result = super().transcribe_vocals(vocals_stem, artist, title)
                if not result:
                    return result
                
                lead = result[0] if isinstance(result, tuple) and len(result) > 0 else None
                harm = result[1] if isinstance(result, tuple) and len(result) > 1 else None

                # Sanitize all lyrics in lead/harmony phrases to prevent latin-1 crashes in MetaMessage/mido.
                if lead:
                    for phrase in lead:
                        if hasattr(phrase, 'notes') and phrase.notes:
                            for note in phrase.notes:
                                if hasattr(note, 'lyric') and note.lyric:
                                    note.lyric = _sanitize_string_to_latin1(note.lyric)
                if harm:
                    for phrase in harm:
                        if hasattr(phrase, 'notes') and phrase.notes:
                            for note in phrase.notes:
                                if hasattr(note, 'lyric') and note.lyric:
                                    note.lyric = _sanitize_string_to_latin1(note.lyric)

                n = len(lead) if lead else 0
                print(f"[OCTAVE] <<< transcribe_vocals produced {n} lead phrases", file=sys.stderr, flush=True)
                return result
            except Exception as exc:
                import traceback as _tb
                print(f"[OCTAVE] !!! transcribe_vocals EXCEPTION: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
                _tb.print_exc(file=sys.stderr)
                sys.stderr.flush()
                return None, None

        def transcribe_lyrics(self, audio_path):
            cpp_bin = os.environ.get("OCTAVE_WHISPER_CPP_BIN", "").strip()
            cpp_model = os.environ.get("OCTAVE_WHISPER_CPP_MODEL", "").strip()
            bin_ok = bool(cpp_bin) and Path(cpp_bin).exists()
            model_ok = bool(cpp_model) and Path(cpp_model).exists()
            print(
                f"[OCTAVE] transcribe_lyrics: cpp_bin={'set' if cpp_bin else 'unset'}({'exists' if bin_ok else 'missing'}) "
                f"cpp_model={'set' if cpp_model else 'unset'}({'exists' if model_ok else 'missing'})",
                file=sys.stderr, flush=True,
            )
            if bin_ok and model_ok:
                try:
                    return self._transcribe_lyrics_cpp(str(audio_path), cpp_bin, cpp_model)
                except Exception as exc:
                    import traceback as _tb
                    print(f"[OCTAVE] !!! _transcribe_lyrics_cpp EXCEPTION: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
                    _tb.print_exc(file=sys.stderr)
                    sys.stderr.flush()
                    raise
            print("[OCTAVE] transcribe_lyrics: falling back to Python whisper", file=sys.stderr, flush=True)
            return super().transcribe_lyrics(audio_path)

        def _transcribe_lyrics_cpp(self, audio_path: str, cpp_bin: str, cpp_model: str):
            """Drive whisper.cpp's `whisper-cli` and reshape its output into
            the same `[{word, start, end}, ...]` contract VocalsCharter's
            downstream alignment code expects.

            Honours user constraints:
              * model is whatever the bootstrap downloaded (large-v3-q5_0)
              * --no-context disables condition_on_previous_text, the source
                of cross-phrase lyric hallucination
              * -ml 1 + token-level offsets give us word-level timings
                without the experimental DTW path
            """
            logger = logging.getLogger(__name__)
            logger.info(f"Transcribing lyrics via whisper.cpp ({Path(cpp_bin).name})...")

            # whisper.cpp's bundled audio loader is finicky (no ffmpeg in
            # our packaged Python env) so resample to 16 kHz mono PCM
            # ourselves and hand it a plain WAV.
            import tempfile
            import json
            import librosa
            import soundfile as sf

            with tempfile.TemporaryDirectory(prefix="octave_whisper_") as tmpdir:
                tmp = Path(tmpdir)
                wav_path = tmp / "input.wav"
                audio, _ = librosa.load(audio_path, sr=16000, mono=True)
                sf.write(str(wav_path), audio, 16000, subtype="PCM_16")

                out_prefix = tmp / "out"
                cmd = [
                    cpp_bin,
                    "-m", cpp_model,
                    "-f", str(wav_path),
                    "-l", "en",
                    "-ojf",                       # output-json-full (token-level)
                    "-of", str(out_prefix),
                    "-mc", "0",                   # max-context=0 → no prior-text conditioning (was --no-context in older builds)
                    "-ml", "1",                   # max-segment-len 1 → word-level segments
                    "-nfa",                       # disable flash-attn: incompatible with q5_0 on some cuBLAS builds (silent no-op exit)
                    "-t", str(max(1, (os.cpu_count() or 4) - 1)),
                ]

                print(f"[OCTAVE] whisper.cpp invoking: {cpp_bin}", file=sys.stderr, flush=True)
                # Quote each arg for log so the exact command can be replayed.
                _printable_cmd = " ".join(
                    f'"{a}"' if (" " in a or "\\" in a) else a for a in cmd
                )
                print(f"[OCTAVE] whisper.cpp cmd: {_printable_cmd}", file=sys.stderr, flush=True)
                try:
                    result = subprocess.run(cmd, capture_output=True, timeout=AUDIO_SEPARATION_TIMEOUT_SEC)
                except subprocess.TimeoutExpired as exc:
                    raise RuntimeError(
                        f"whisper.cpp timed out after {AUDIO_SEPARATION_TIMEOUT_SEC}s."
                    ) from exc
                stderr_text = (result.stderr or b"").decode("utf-8", errors="replace")
                stdout_text = (result.stdout or b"").decode("utf-8", errors="replace")
                print(
                    f"[OCTAVE] whisper.cpp rc={result.returncode} stdout_len={len(stdout_text)} stderr_len={len(stderr_text)}",
                    file=sys.stderr, flush=True,
                )
                # The interesting diagnostic (model load, CUDA init, arg
                # rejection) lives at the START of stderr; whisper-cli's
                # help dump (when args fail) sits at the bottom and would
                # otherwise crowd out the real error in a tail-only log.
                print(f"[OCTAVE] whisper.cpp stderr head: {stderr_text[:2500]}", file=sys.stderr, flush=True)
                print(f"[OCTAVE] whisper.cpp stderr tail: {stderr_text[-1500:]}", file=sys.stderr, flush=True)
                if stdout_text:
                    print(f"[OCTAVE] whisper.cpp stdout head: {stdout_text[:1500]}", file=sys.stderr, flush=True)
                if result.returncode != 0:
                    raise RuntimeError(
                        f"whisper.cpp failed (rc={result.returncode}): {stderr_text[-2000:]}"
                    )

                json_path = Path(str(out_prefix) + ".json")
                print(f"[OCTAVE] whisper.cpp json_path={json_path} exists={json_path.exists()}", file=sys.stderr, flush=True)
                if not json_path.exists():
                    # Surface what files whisper actually wrote.
                    try:
                        listing = sorted(p.name for p in tmp.iterdir())
                    except Exception:
                        listing = []
                    # whisper-cli exits 0 and dumps `usage:` to stderr when an
                    # arg is unknown; surface the head of stderr so the caller
                    # sees the actual `error: unknown argument: ...` line.
                    err_excerpt = stderr_text[:1500] if stderr_text else "(no stderr captured)"
                    raise RuntimeError(
                        f"whisper.cpp produced no JSON output at {json_path}; "
                        f"tmpdir contents={listing}; stderr head:\n{err_excerpt}"
                    )
                try:
                    payload = json.loads(json_path.read_text(encoding="utf-8"))
                except Exception as exc:
                    raise RuntimeError(f"whisper.cpp JSON parse failed: {exc}") from exc

            # whisper.cpp -ojf JSON shape (current upstream):
            #   { "transcription": [
            #       { "offsets": {"from": ms, "to": ms},
            #         "text": " word",
            #         "tokens": [
            #           { "text": " word", "offsets": {"from": ms, "to": ms}, ... },
            #           ...
            #         ]
            #       }, ... ]
            #   }
            # We iterate tokens (per user constraint) and skip whisper's
            # special tokens (those whose text starts with "[" — e.g.
            # [_BEG_], [_TT_123]).
            # Upstream STRUM's chart writer (mido MetaMessage('lyrics'))
            # encodes lyric text as latin-1 and crashes on chars outside
            # that range. Whisper happily emits ♪ (U+266A) for musical
            # interludes plus smart quotes / em-dashes. Sanitize here so
            # the chart-creation step downstream never sees them.
            _SMART_MAP = {
                "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'",
                "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u201f": '"',
                "\u2013": "-", "\u2014": "-", "\u2026": "...",
                "\u266a": "", "\u266b": "", "\u266c": "", "\u2669": "",
                "\xa0": " ",
            }
            def _sanitize_lyric(s: str) -> str:
                return _sanitize_string_to_latin1(s)

            words = []
            for entry in payload.get("transcription", []):
                for tok in entry.get("tokens", []):
                    text = _sanitize_lyric((tok.get("text") or "").strip())
                    if not text or text.startswith("["):
                        continue
                    offsets = tok.get("offsets") or {}
                    start_ms = offsets.get("from")
                    end_ms = offsets.get("to")
                    if start_ms is None or end_ms is None:
                        # Some token entries omit offsets; fall back to the
                        # parent transcription entry's offsets.
                        parent = entry.get("offsets") or {}
                        start_ms = parent.get("from", 0)
                        end_ms = parent.get("to", start_ms + 10)
                    start = max(0.0, start_ms / 1000.0 + self.timing_offset)
                    end = max(start + 0.01, end_ms / 1000.0 + self.timing_offset)
                    words.append({"word": text, "start": start, "end": end})

            print(
                f"[OCTAVE] whisper.cpp transcribed {len(words)} words "
                f"(timing offset: {self.timing_offset:+.3f}s)",
                file=sys.stderr, flush=True,
            )
            if len(words) == 0:
                # Surface whisper's own output so we can diagnose silent runs.
                tail_err = stderr_text[-1500:] if stderr_text else ""
                tail_out = stdout_text[-500:] if stdout_text else ""
                print(f"[OCTAVE] whisper.cpp stderr tail: {tail_err}", file=sys.stderr, flush=True)
                print(f"[OCTAVE] whisper.cpp stdout tail: {tail_out}", file=sys.stderr, flush=True)

            # Re-use the parent class's harmony-duplicate filter so the
            # downstream alignment behaves identically to the Python path.
            try:
                words = self._filter_harmony_duplicates(words)
            except AttributeError:
                pass
            return words

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
                    return _sanitize_string_to_latin1(artist.strip()), _sanitize_string_to_latin1(title)

            res = super().parse_filename(path)
            if isinstance(res, tuple) and len(res) == 2:
                return _sanitize_string_to_latin1(res[0]), _sanitize_string_to_latin1(res[1])
            return res

        @property
        def vocals_charter(self):
            if self._vocals_charter is None and self.include_vocals:
                logging.getLogger(__name__).info("Loading vocals charter (Whisper)...")
                # OctaveVocalsCharter prefers the native whisper.cpp binary
                # provisioned by the main process; falls back to the Python
                # `whisper` package if the env vars aren't set.
                whisper_kwargs = {}
                whisper_override = os.environ.get("OCTAVE_WHISPER_MODEL", "").strip()
                if whisper_override:
                    whisper_kwargs["whisper_model"] = whisper_override
                self._vocals_charter = OctaveVocalsCharter(device=device, **whisper_kwargs)
            return self._vocals_charter

        def convert_to_ogg(self, input_path: Path, output_path: Path, *args, **kwargs):
            input_resolved = Path(input_path).resolve()
            logger = logging.getLogger(__name__)
            song_folder = output_path.parent
            # STRUM passes trim_start_ms when phase-aligning song.ogg with
            # the chart's bar-0 downbeat. Every other ogg we export from this
            # same input has to receive the same trim or it will play back
            # offset by phase_offset_ms relative to song.ogg (the symptom
            # users report as "all stems are half a beat off").
            export_kwargs = dict(kwargs)
            # CH/YARG mix song.ogg + every per-instrument stem together at
            # playback. When we have pre-split stems, writing a full mix to
            # song.ogg would double every instrument in-game. Replace
            # song.ogg with a silent track of matching duration so the games
            # still find the file (some menu / preview paths require it) but
            # don't double the audio. The per-stem oggs carry the real audio.
            preset = PRESPLIT_STEM_REGISTRY.get(input_resolved) or {}
            extras = EXTRAS_REGISTRY.get(input_resolved) or []
            backing = BACKING_VOCALS_REGISTRY.get(input_resolved) or {}
            # Keep-stems: when the user asked to retain the Demucs-separated
            # stems, treat them like pre-split stems so each one is exported as
            # a per-instrument ogg and song.ogg is written silent (avoids
            # CH/YARG doubling song.ogg + every stem).
            if not preset and KEEP_STEMS:
                preset = SEPARATED_STEM_REGISTRY.get(input_resolved) or {}
            has_full_coverage = bool(preset) or bool(extras) or bool(backing)
            if has_full_coverage:
                try:
                    self._octave_write_silent_ogg(input_path, output_path, **export_kwargs)
                    logger.info("  Wrote silent song.ogg (per-stem oggs carry the audio)")
                except Exception as exc:
                    logger.warning(f"  ⚠ Failed to write silent song.ogg, falling back to full mix: {exc}")
                    super().convert_to_ogg(input_path, output_path, *args, **kwargs)
            else:
                # No pre-split stems — write the real full mix so playback
                # works (the "single audio file" / Demucs path).
                super().convert_to_ogg(input_path, output_path, *args, **kwargs)

            # Backing-vocals stems → vocals_1.ogg / vocals_2.ogg (CH/YARG
            # play these alongside vocals.ogg for harmony playback).
            for slot, dest_name in (("vocalsHarm2", "vocals_1.ogg"), ("vocalsHarm3", "vocals_2.ogg")):
                src = backing.get(slot)
                if src is None:
                    continue
                dest = song_folder / dest_name
                try:
                    super().convert_to_ogg(src, dest, **export_kwargs)
                    logger.info(f"  Exported backing vocals: {dest.name}")
                except Exception as exc:
                    logger.warning(f"  ⚠ Failed to export {dest_name}: {exc}")

            # Crowd slot → crowd.ogg (single file, no summing needed).
            crowd_src = CROWD_REGISTRY.get(input_resolved)
            if crowd_src is not None:
                try:
                    super().convert_to_ogg(crowd_src, song_folder / "crowd.ogg", **export_kwargs)
                    logger.info("  Exported crowd: crowd.ogg")
                except Exception as exc:
                    logger.warning(f"  ⚠ Failed to export crowd.ogg: {exc}")

            # When the user supplied pre-split stems for this mix, also export
            # each stem as `{stem}.ogg` alongside song.ogg so Clone Hero / YARG
            # can mute the corresponding instrument when notes are missed.
            # Extras (uncharted audio) get merged into other.ogg since "other"
            # is the catch-all uncharted bucket in CH/YARG.
            # Map our internal stem names to the filenames recognised by
            # Clone Hero / YARG.
            stem_filenames = {
                "drums": "drums.ogg",
                "bass": "bass.ogg",
                "vocals": "vocals.ogg",
                "other": "other.ogg",
                "guitar": "guitar.ogg",
                "piano": "keys.ogg",
            }
            for stem_name, src_path in preset.items():
                dest_name = stem_filenames.get(stem_name)
                if not dest_name:
                    continue
                dest = song_folder / dest_name
                try:
                    if stem_name == "other" and extras:
                        # Merge user's other stem with extras into other.ogg.
                        self._octave_export_combined_ogg([src_path, *extras], dest, **export_kwargs)
                        logger.info(f"  Exported stem (with extras): {dest.name}")
                    else:
                        super().convert_to_ogg(src_path, dest, **export_kwargs)
                        logger.info(f"  Exported stem: {dest.name}")
                except Exception as exc:
                    logger.warning(f"  ⚠ Failed to export stem {dest_name}: {exc}")

            # No "other" stem but extras present → export extras as other.ogg.
            if "other" not in preset and extras:
                try:
                    self._octave_export_combined_ogg(extras, song_folder / "other.ogg", **export_kwargs)
                    logger.info("  Exported extras as: other.ogg")
                except Exception as exc:
                    logger.warning(f"  ⚠ Failed to export other.ogg: {exc}")

        def _octave_write_silent_ogg(self, ref_path: Path, dest: Path, **convert_kwargs) -> None:
            """Write a silent ogg matching the reference audio's duration.

            Used for song.ogg when per-stem oggs already cover the full mix —
            CH/YARG would otherwise sum song.ogg + each stem and double the
            audio. We honour the same trim_start_ms STRUM passes for the real
            song.ogg so the silent file's length matches what the games expect.
            """
            import numpy as _np
            import soundfile as _sf
            import tempfile
            info = _sf.info(str(ref_path))
            trim_start_ms = float(convert_kwargs.get("trim_start_ms", 0.0) or 0.0)
            duration_s = max(0.0, float(info.duration) - (trim_start_ms / 1000.0))
            sr = int(info.samplerate)
            channels = max(1, int(info.channels))
            samples = max(1, int(round(duration_s * sr)))
            silent = _np.zeros((samples, channels), dtype=_np.float32)
            with tempfile.TemporaryDirectory(prefix="octave_silent_") as tmpdir:
                wav_path = Path(tmpdir) / "silent.wav"
                _sf.write(str(wav_path), silent, sr, subtype="PCM_16")
                # Pass trim_start_ms=0 since we've already accounted for the
                # trim by shortening the silent buffer.
                forwarded = {k: v for k, v in convert_kwargs.items() if k != "trim_start_ms"}
                super().convert_to_ogg(wav_path, dest, **forwarded)

        def _octave_export_combined_ogg(self, src_files: list[Path], dest: Path, **convert_kwargs) -> None:
            """Sum a list of audio files and write the result as ogg.

            Re-uses the same lightweight resample-and-sum logic used for the
            stem-song auto-mix path. Output is a 16-bit WAV first, then
            converted to ogg via the parent class so the codec settings stay
            consistent with song.ogg.
            """
            import numpy as _np
            import soundfile as _sf
            import tempfile
            loaded: list[tuple[_np.ndarray, int]] = []
            for src in src_files:
                data, sr = _sf.read(str(src), always_2d=True)
                loaded.append((data.astype(_np.float32, copy=False), sr))
            if not loaded:
                return
            target_sr = max(sr for _, sr in loaded)
            target_channels = max(d.shape[1] for d, _ in loaded)
            max_len = 0
            resampled: list[_np.ndarray] = []
            for data, sr in loaded:
                if sr != target_sr:
                    ratio = target_sr / sr
                    new_len = int(round(data.shape[0] * ratio))
                    old_idx = _np.linspace(0.0, data.shape[0] - 1, data.shape[0])
                    new_idx = _np.linspace(0.0, data.shape[0] - 1, new_len)
                    chs = []
                    for ch in range(data.shape[1]):
                        chs.append(_np.interp(new_idx, old_idx, data[:, ch]).astype(_np.float32))
                    data = _np.stack(chs, axis=1)
                if data.shape[1] < target_channels:
                    data = _np.tile(data, (1, target_channels // data.shape[1]))
                elif data.shape[1] > target_channels:
                    data = data[:, :target_channels]
                resampled.append(data)
                max_len = max(max_len, data.shape[0])
            summed = _np.zeros((max_len, target_channels), dtype=_np.float32)
            for data in resampled:
                summed[: data.shape[0]] += data
            peak = float(_np.max(_np.abs(summed))) or 1.0
            if peak > 0.999:
                summed = summed * (0.999 / peak)
            with tempfile.TemporaryDirectory(prefix="octave_combined_") as tmpdir:
                wav_path = Path(tmpdir) / "combined.wav"
                _sf.write(str(wav_path), summed, target_sr, subtype="PCM_16")
                super().convert_to_ogg(wav_path, dest, **convert_kwargs)

        def separate_stems(self, audio_path: Path, work_dir: Path):
            logger = logging.getLogger(__name__)

            # Pre-split stems supplied by the user — skip Demucs entirely.
            preset = PRESPLIT_STEM_REGISTRY.get(Path(audio_path).resolve())
            if preset:
                logger.info(
                    f"  Using pre-split stems for {audio_path.name}: {sorted(preset.keys())}"
                )
                return dict(preset)

            # Native demucs.cpp path (preferred): the main process provisions
            # a binary + ggml weights into userData and exports the paths via
            # env vars. ~10× smaller install footprint than the Python demucs
            # package and ~2× faster on CPU. Falls back to `python -m demucs`
            # below if env vars are not set (dev environments without the
            # binary, or platforms where CI hasn't published one yet).
            cpp_bin = os.environ.get("OCTAVE_DEMUCS_CPP_BIN", "").strip()
            cpp_weights = os.environ.get("OCTAVE_DEMUCS_CPP_WEIGHTS", "").strip()
            if cpp_bin and cpp_weights and Path(cpp_bin).exists() and Path(cpp_weights).exists():
                try:
                    cpp_stems = self._separate_stems_cpp(audio_path, work_dir, cpp_bin, cpp_weights)
                    if cpp_stems:
                        # Always register (not just for keep-stems): the tempo
                        # refiner prefers beat-tracking the drums stem (issue #8).
                        SEPARATED_STEM_REGISTRY[Path(audio_path).resolve()] = dict(cpp_stems)
                    return cpp_stems
                except Exception as exc:
                    # The native demucs.cpp binary crashed (or produced no
                    # usable stems). On older CPUs it commonly aborts with an
                    # illegal-instruction / stack-overrun fault because it was
                    # built with SIMD extensions (AVX/AVX2) the host lacks —
                    # Windows surfaces this as exit code 3221225501 (0xC0000409),
                    # which is exactly what users on Win10 22H2 hardware hit.
                    # Rather than failing the whole auto-chart run, fall back to
                    # the pure-Python `demucs` package: slower, but it runs
                    # anywhere torch does. (See GitHub issue #9.)
                    logger.warning(
                        f"  demucs.cpp separation failed ({exc}). Falling back to the "
                        "Python demucs engine — this is slower but works on CPUs the "
                        "native binary can't run on."
                    )

            logger.info(f"  Separating stems with Demucs (Python) on device={device}...")

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

            returncode, elapsed = _run_separation_subprocess(cmd, "Demucs separation")
            if returncode != 0:
                raise RuntimeError(f"Demucs failed with return code {returncode} after {elapsed}s")

            logger.info(f"    Demucs separation complete in {elapsed}s")

            stem_dir = demucs_out / self.demucs_model / audio_path.stem
            stems = {}
            for stem in ["drums", "bass", "other", "vocals", "guitar", "piano"]:
                stem_path = stem_dir / f"{stem}.wav"
                if stem_path.exists():
                    stems[stem] = stem_path

            logger.info(f"    Separated stems: {list(stems.keys())}")
            if stems:
                # Always register (not just for keep-stems): the tempo refiner
                # prefers beat-tracking the drums stem (issue #8).
                SEPARATED_STEM_REGISTRY[Path(audio_path).resolve()] = dict(stems)
            return stems

        def _ensure_demucs_cpp_input(self, audio_path: Path, work_dir: Path) -> Path:
            """demucs.cpp only accepts 44.1 kHz WAV. If the source is already
            a 44100 Hz WAV we use it as-is; otherwise decode + resample with
            librosa and write a stereo float32 WAV next to the demucs output.
            """
            try:
                import soundfile as sf
                if audio_path.suffix.lower() == ".wav":
                    info = sf.info(str(audio_path))
                    if int(info.samplerate) == 44100:
                        return audio_path
            except Exception:
                pass

            import librosa
            import soundfile as sf
            import numpy as np

            y, _sr = librosa.load(str(audio_path), sr=44100, mono=False)
            if y.ndim == 1:
                y = np.stack([y, y], axis=0)
            elif y.shape[0] == 1:
                y = np.repeat(y, 2, axis=0)
            elif y.shape[0] > 2:
                y = y[:2]

            resampled = work_dir / f"{audio_path.stem}_44k.wav"
            sf.write(str(resampled), y.T, 44100, subtype="PCM_16")
            return resampled

        def _separate_stems_cpp(
            self,
            audio_path: Path,
            work_dir: Path,
            cpp_bin: str,
            cpp_weights: str,
        ):
            """Run demucs.cpp's multi-threaded CLI with the htdemucs_6s ggml
            weights and remap target_N_*.wav outputs to STRUM's stem names.
            """
            logger = logging.getLogger(__name__)
            logger.info(f"  Separating stems with demucs.cpp ({Path(cpp_bin).name})...")

            demucs_out = work_dir / "demucs_cpp_temp"
            if demucs_out.exists():
                shutil.rmtree(demucs_out, ignore_errors=True)
            demucs_out.mkdir(parents=True, exist_ok=True)

            # demucs.cpp only accepts 44100 Hz input. Resample to a temp
            # 44.1kHz stereo WAV so mp3 / 48k / mono sources all work.
            input_for_demucs = self._ensure_demucs_cpp_input(audio_path, demucs_out)

            # demucs_mt.cpp.main signature: <model.bin> <input.wav> <output_dir> <num_threads>
            num_threads = max(1, (os.cpu_count() or 4) - 1)
            cmd = [cpp_bin, cpp_weights, str(input_for_demucs), str(demucs_out), str(num_threads)]

            returncode, elapsed = _run_separation_subprocess(cmd, "demucs.cpp separation")
            if returncode != 0:
                raise RuntimeError(
                    f"demucs.cpp failed with return code {returncode} after {elapsed}s"
                )

            logger.info(f"    demucs.cpp separation complete in {elapsed}s")

            # Per upstream README, the 6s output target indices are:
            #   0=drums, 1=bass, 2=other, 3=vocals, 4=guitar, 5=piano
            stem_order = ["drums", "bass", "other", "vocals", "guitar", "piano"]
            stems: dict[str, Path] = {}
            for idx, name in enumerate(stem_order):
                src = demucs_out / f"target_{idx}_{name}.wav"
                if not src.exists():
                    continue
                # Rename to the same layout the Python-demucs path produces so
                # downstream stages are agnostic to the backend.
                dest = demucs_out / f"{name}.wav"
                src.rename(dest)
                stems[name] = dest

            if not stems:
                # Surface diagnostic info so a missing tarball / wrong weights
                # is obvious in logs.
                produced = sorted(p.name for p in demucs_out.iterdir())
                raise RuntimeError(
                    "demucs.cpp produced no recognisable stems. "
                    f"Output dir contained: {produced}"
                )

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

        def transcribe_guitar(self, other_stem: Path, tempo_bpm: float, *args, **kwargs):
            if not self.include_guitar:
                print("[OCTAVE] >>> transcribe_guitar skipped (include_guitar=False)", file=sys.stderr, flush=True)
                return None
            # TF is now bundled, so Basic Pitch uses its default TF model path
            # (matches the STRUM benchmark). CREPE capacity is left at its
            # default unless OCTAVE_CREPE_MODEL is set. Forward *args/**kwargs
            # so newer upstream signatures (e.g. full_mix=...) keep working.
            print(f"[OCTAVE] >>> transcribe_guitar(stem={other_stem}, tempo={tempo_bpm}, args={args}, kwargs={list(kwargs.keys())})", file=sys.stderr, flush=True)
            try:
                from src.inference.guitar_hybrid_v2 import transcribe_guitar_hybrid
                # Bypass upstream wrapper to expose any exception directly.
                chart = transcribe_guitar_hybrid(other_stem, tempo_bpm=tempo_bpm)
                n_notes = len(getattr(chart, "notes", []) or [])
                n_chords = len(getattr(chart, "chords", []) or [])
                print(f"[OCTAVE] <<< transcribe_guitar produced {n_notes} notes / {n_chords} chords (chart={type(chart).__name__})", file=sys.stderr, flush=True)
                return chart
            except Exception as exc:
                import traceback as _tb
                _diagnose_basic_pitch_failure(exc)
                print(f"[OCTAVE] !!! transcribe_guitar EXCEPTION: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
                _tb.print_exc(file=sys.stderr)
                sys.stderr.flush()
                return None

        def transcribe_bass(self, bass_stem: Path, tempo_bpm: float, *args, **kwargs):
            if not self.include_bass:
                print("[OCTAVE] >>> transcribe_bass skipped (include_bass=False)", file=sys.stderr, flush=True)
                return None
            print(f"[OCTAVE] >>> transcribe_bass(stem={bass_stem}, tempo={tempo_bpm})", file=sys.stderr, flush=True)
            try:
                from src.inference.guitar_hybrid_v2 import transcribe_guitar_hybrid
                prev_min = os.environ.get("STRUM_BP_MIN_PITCH")
                prev_max = os.environ.get("STRUM_BP_MAX_PITCH")
                prev_thr = os.environ.get("STRUM_GUITAR_PEAK_THR")
                os.environ["STRUM_BP_MIN_PITCH"] = "24"
                os.environ["STRUM_BP_MAX_PITCH"] = "67"
                os.environ["STRUM_GUITAR_PEAK_THR"] = os.environ.get("STRUM_BASS_PEAK_THR", "0.15")
                try:
                    chart = transcribe_guitar_hybrid(bass_stem, tempo_bpm=tempo_bpm, is_bass=True)
                finally:
                    for k, v in (("STRUM_BP_MIN_PITCH", prev_min), ("STRUM_BP_MAX_PITCH", prev_max), ("STRUM_GUITAR_PEAK_THR", prev_thr)):
                        if v is None:
                            os.environ.pop(k, None)
                        else:
                            os.environ[k] = v
                n_notes = len(getattr(chart, "notes", []) or [])
                print(f"[OCTAVE] <<< transcribe_bass produced {n_notes} notes", file=sys.stderr, flush=True)
                return chart
            except Exception as exc:
                import traceback as _tb
                _diagnose_basic_pitch_failure(exc)
                print(f"[OCTAVE] !!! transcribe_bass EXCEPTION: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
                _tb.print_exc(file=sys.stderr)
                sys.stderr.flush()
                return None

        def transcribe_vocals(self, vocals_stem: Path, artist: str, title: str):
            print(f"[OCTAVE] >>> transcribe_vocals(stem={vocals_stem.name})", file=sys.stderr, flush=True)
            try:
                result = super().transcribe_vocals(vocals_stem, artist, title)
                lead = result[0] if isinstance(result, tuple) and len(result) > 0 else None
                n = len(lead) if lead else 0
                print(f"[OCTAVE] <<< transcribe_vocals produced {n} lead phrases", file=sys.stderr, flush=True)
                return result
            except Exception as exc:
                import traceback as _tb
                print(f"[OCTAVE] !!! transcribe_vocals EXCEPTION: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
                _tb.print_exc(file=sys.stderr)
                sys.stderr.flush()
                return None, None

        def transcribe_keys(self, other_stem: Path, guitar_stem: Path | None = None):
            if not self.include_keys:
                print("[OCTAVE] >>> transcribe_keys skipped (include_keys=False)", file=sys.stderr, flush=True)
                return None
            if self.keys_charter is None:
                print("[OCTAVE] >>> transcribe_keys skipped (keys_charter unavailable)", file=sys.stderr, flush=True)
                return None
            print(f"[OCTAVE] >>> transcribe_keys(stem={other_stem}, guitar_stem={guitar_stem})", file=sys.stderr, flush=True)
            try:
                # Bypass upstream wrapper's exception swallowing.
                notes, details = self.keys_charter.transcribe(
                    str(other_stem), force=False,
                    guitar_stem=str(guitar_stem) if guitar_stem else None,
                )
                n = len(notes) if notes else 0
                print(f"[OCTAVE] <<< transcribe_keys produced {n} notes (details={details!r})", file=sys.stderr, flush=True)
                return notes
            except Exception as exc:
                import traceback as _tb
                print(f"[OCTAVE] !!! transcribe_keys EXCEPTION: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
                _tb.print_exc(file=sys.stderr)
                sys.stderr.flush()
                return None

        def analyze_audio(self, audio_path: Path, artist: str = '', title: str = ''):
            if not FAST_AUDIO_ANALYSIS:
                result = super().analyze_audio(audio_path, artist, title)
                if USER_TEMPO_MAP and isinstance(result, dict):
                    result["tempo_bpm"] = round(USER_TEMPO_MAP[0][1], 3)
                if isinstance(result, dict):
                    for k in ("album", "year", "genre"):
                        if k in result:
                            result[k] = _sanitize_string_to_latin1(result[k])
                return result

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

            tempo_bpm = round(USER_TEMPO_MAP[0][1], 3) if USER_TEMPO_MAP else 120

            return {
                "tempo_bpm": tempo_bpm,
                "duration_ms": int(duration_sec * 1000),
                "duration_sec": duration_sec,
                "preview_start_ms": int(preview_sec * 1000),
                "album": _sanitize_string_to_latin1(metadata.get("album", "")),
                "year": _sanitize_string_to_latin1(metadata.get("year", "")),
                "genre": _sanitize_string_to_latin1(metadata.get("genre", "")),
            }

    tracks = enabled_tracks or {}
    return OctaveBatchPipeline(
        output_dir=output_dir,
        include_drums=tracks.get('drums', True),
        include_guitar=tracks.get('guitar', True),
        include_bass=tracks.get('bass', True),
        include_vocals=tracks.get('vocals', True),
        include_keys=include_keys and tracks.get('keys', True),
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

    # Pre-split stem folders. Each folder must contain drums/bass/vocals/other
    # plus a song mix (song.wav/ogg/opus/mp3). The mix is used as the audio
    # source; the stems are recorded so OctaveBatchPipeline.separate_stems
    # can return them directly instead of running Demucs.
    for raw_stem_folder in payload.get("stemFolders", []):
        folder = Path(raw_stem_folder).expanduser().resolve()
        if not folder.exists() or not folder.is_dir():
            raise IntegrationError(f"Stem folder does not exist: {folder}")
        stem_map: dict[str, Path] = {}
        for stem_name in ("drums", "bass", "vocals", "other", "guitar", "piano"):
            for ext in (".wav", ".flac", ".ogg", ".mp3"):
                candidate = folder / f"{stem_name}{ext}"
                if candidate.exists():
                    stem_map[stem_name] = candidate.resolve()
                    break
        required = {"drums", "bass", "vocals", "other"}
        missing = required - stem_map.keys()
        if missing:
            raise IntegrationError(
                f"Stem folder {folder} is missing required stems: {sorted(missing)}. "
                f"Need at least drums, bass, vocals, other (.wav/.flac/.ogg/.mp3)."
            )
        # Locate the song mix.
        mix: Path | None = None
        for ext in (".wav", ".flac", ".ogg", ".opus", ".mp3"):
            candidate = folder / f"song{ext}"
            if candidate.exists():
                mix = candidate.resolve()
                break
        if mix is None:
            raise IntegrationError(
                f"Stem folder {folder} must contain a song mix (song.wav/ogg/opus/mp3 or song.flac)."
            )
        PRESPLIT_STEM_REGISTRY[mix] = stem_map
        sources.append(mix)

    # Per-instrument stem songs. Each entry maps instrument name → file path
    # or URL. Empty/missing slots are skipped (that instrument is not
    # charted). The full mix is always synthesised by summing the supplied
    # stems + extras so the rest of the pipeline (tempo / beat / metadata)
    # has audio to analyse. Demucs separation is skipped for these songs.
    #
    # Vocal slots:
    #   - "vocals" → strictly lead vocals (PART VOCALS / HARM1)
    #   - "vocalsHarm2" → backing vocals 1; drives HARM2 + vocals_1.ogg
    #   - "vocalsHarm3" → backing vocals 2; drives HARM3 + vocals_2.ogg
    # Backing-vocal stems are NOT charted as PART VOCALS — they're routed
    # through OctaveVocalsCharter.detect_harmonies via HARMONY_OVERRIDE_REGISTRY
    # and exported as vocals_1.ogg / vocals_2.ogg via BACKING_VOCALS_REGISTRY.
    #
    # "extras" is a list of additional uncharted audio files/URLs. They are
    # summed into the auto-mix and exported as crowd.ogg for in-game playback.
    stem_songs = payload.get("stemSongs") or []
    if stem_songs:
        import numpy as _np
        import soundfile as _sf
        stems_root = cache_dir / "stem-songs" / payload["runId"]
        stems_root.mkdir(parents=True, exist_ok=True)
        url_dl_dir = cache_dir / "downloaded-inputs" / payload["runId"]
        for ss_idx, entry in enumerate(stem_songs):
            if not isinstance(entry, dict):
                continue
            stem_inputs = entry.get("stems") or {}
            extras_inputs = entry.get("extras") or []
            if not isinstance(stem_inputs, dict):
                stem_inputs = {}
            if not isinstance(extras_inputs, list):
                extras_inputs = []
            if not stem_inputs and not extras_inputs:
                continue
            raw_name = str(entry.get("name") or "").strip()
            song_name = sanitize_filename(raw_name, f"stem-song-{ss_idx + 1}")
            song_dir = stems_root / song_name
            song_dir.mkdir(parents=True, exist_ok=True)

            def _resolve_stem(value: str, label: str) -> Path:
                value = str(value).strip()
                if not value:
                    raise IntegrationError(f"Empty stem value for {label}")
                parsed = urllib.parse.urlparse(value)
                if parsed.scheme in {"http", "https"}:
                    url_dl_dir.mkdir(parents=True, exist_ok=True)
                    if is_direct_audio_url(value):
                        return download_direct_audio(value, url_dl_dir, run_id)
                    return download_youtube_audio(value, url_dl_dir, run_id)
                p = Path(value).expanduser().resolve()
                if not p.exists() or not p.is_file():
                    raise IntegrationError(f"Stem file does not exist for {label}: {p}")
                if p.suffix.lower() not in AUDIO_EXTENSIONS:
                    raise IntegrationError(f"Unsupported stem audio file for {label}: {p.name}")
                return p

            # Charted stems passed to STRUM's separator-replacement registry.
            stem_map: dict[str, Path] = {}
            # Backing vocals are NOT charted; they're routed to harmony
            # detection + playback exports separately.
            backing_map: dict[str, Path] = {}
            for key in ("drums", "bass", "vocals", "other", "guitar", "piano"):
                raw_val = stem_inputs.get(key)
                if not raw_val:
                    continue
                stem_map[key] = _resolve_stem(raw_val, f"{song_name}/{key}")
            for key in ("vocalsHarm2", "vocalsHarm3"):
                raw_val = stem_inputs.get(key)
                if not raw_val:
                    continue
                backing_map[key] = _resolve_stem(raw_val, f"{song_name}/{key}")

            # Crowd slot: optional, single file. Exported directly as crowd.ogg
            # without re-encoding via auto-mix. Not included in the analysis
            # mix — crowd noise would muddy tempo/beat detection.
            crowd_path: Path | None = None
            crowd_raw = stem_inputs.get("crowd")
            if crowd_raw:
                crowd_path = _resolve_stem(crowd_raw, f"{song_name}/crowd")

            # Extras: uncharted audio summed into the auto-mix and merged
            # into other.ogg for in-game playback.
            extras_paths: list[Path] = []
            for ex_idx, raw_val in enumerate(extras_inputs):
                if not raw_val or not str(raw_val).strip():
                    continue
                extras_paths.append(_resolve_stem(str(raw_val), f"{song_name}/extra-{ex_idx + 1}"))

            if not stem_map and not backing_map and not extras_paths:
                raise IntegrationError(
                    f"Stem song '{song_name}' needs at least one stem, backing-vocals "
                    f"or extra audio file (crowd audio alone isn't enough to build a chart)."
                )

            # Auto-mix everything (charted stems + backing vocals + extras).
            # Load each at its native rate, resample any odd ones to the
            # highest-rate stem, sum, peak-normalise. Output as 16-bit WAV.
            emit_progress(run_id, "bootstrap", f"Auto-mixing stems for {song_name}", current_item=song_name)
            mix_inputs = list(stem_map.values()) + list(backing_map.values()) + extras_paths
            loaded: list[tuple[_np.ndarray, int]] = []
            for stem_file in mix_inputs:
                data, sr = _sf.read(str(stem_file), always_2d=True)
                loaded.append((data.astype(_np.float32, copy=False), sr))
            target_sr = max(sr for _, sr in loaded)
            target_channels = max(d.shape[1] for d, _ in loaded)
            max_len = 0
            resampled: list[_np.ndarray] = []
            for data, sr in loaded:
                if sr != target_sr:
                    ratio = target_sr / sr
                    new_len = int(round(data.shape[0] * ratio))
                    # Cheap linear resample via numpy interp (we only
                    # need an analysis-grade mix, not mastering).
                    old_idx = _np.linspace(0.0, data.shape[0] - 1, data.shape[0])
                    new_idx = _np.linspace(0.0, data.shape[0] - 1, new_len)
                    channels = []
                    for ch in range(data.shape[1]):
                        channels.append(_np.interp(new_idx, old_idx, data[:, ch]).astype(_np.float32))
                    data = _np.stack(channels, axis=1)
                if data.shape[1] < target_channels:
                    # mono → stereo by duplication
                    data = _np.tile(data, (1, target_channels // data.shape[1]))
                elif data.shape[1] > target_channels:
                    data = data[:, :target_channels]
                resampled.append(data)
                max_len = max(max_len, data.shape[0])
            summed = _np.zeros((max_len, target_channels), dtype=_np.float32)
            for data in resampled:
                summed[: data.shape[0]] += data
            peak = float(_np.max(_np.abs(summed))) or 1.0
            if peak > 0.999:
                summed = summed * (0.999 / peak)
            mix_path = song_dir / f"{song_name}.wav"
            _sf.write(str(mix_path), summed, target_sr, subtype="PCM_16")

            PRESPLIT_STEM_REGISTRY[mix_path] = stem_map
            if extras_paths:
                EXTRAS_REGISTRY[mix_path] = extras_paths
            if crowd_path is not None:
                CROWD_REGISTRY[mix_path] = crowd_path
            if backing_map:
                BACKING_VOCALS_REGISTRY[mix_path] = backing_map
                # If the user provided a lead-vocals stem, route harmony
                # detection from the lead path to a summed backing-vocals
                # mix. Without a lead stem there's nothing to override —
                # STRUM's harmony pass will fall back to its default path.
                lead_path = stem_map.get("vocals")
                if lead_path is not None:
                    backing_files = list(backing_map.values())
                    if len(backing_files) == 1:
                        HARMONY_OVERRIDE_REGISTRY[lead_path] = backing_files[0]
                    else:
                        # Sum HARM2 + HARM3 into a single audio file so
                        # detect_harmonies sees both backing parts at once.
                        merged = song_dir / f"{song_name}_backing_vocals.wav"
                        _b_loaded = [(_sf.read(str(p), always_2d=True)) for p in backing_files]
                        _b_data = [(d.astype(_np.float32, copy=False), s) for d, s in _b_loaded]
                        _b_sr = max(s for _, s in _b_data)
                        _b_ch = max(d.shape[1] for d, _ in _b_data)
                        _b_max = 0
                        _b_resampled: list[_np.ndarray] = []
                        for d, s in _b_data:
                            if s != _b_sr:
                                ratio = _b_sr / s
                                new_len = int(round(d.shape[0] * ratio))
                                old_idx = _np.linspace(0.0, d.shape[0] - 1, d.shape[0])
                                new_idx = _np.linspace(0.0, d.shape[0] - 1, new_len)
                                chs = []
                                for ch in range(d.shape[1]):
                                    chs.append(_np.interp(new_idx, old_idx, d[:, ch]).astype(_np.float32))
                                d = _np.stack(chs, axis=1)
                            if d.shape[1] < _b_ch:
                                d = _np.tile(d, (1, _b_ch // d.shape[1]))
                            elif d.shape[1] > _b_ch:
                                d = d[:, :_b_ch]
                            _b_resampled.append(d)
                            _b_max = max(_b_max, d.shape[0])
                        _b_sum = _np.zeros((_b_max, _b_ch), dtype=_np.float32)
                        for d in _b_resampled:
                            _b_sum[: d.shape[0]] += d
                        _b_peak = float(_np.max(_np.abs(_b_sum))) or 1.0
                        if _b_peak > 0.999:
                            _b_sum = _b_sum * (0.999 / _b_peak)
                        _sf.write(str(merged), _b_sum, _b_sr, subtype="PCM_16")
                        HARMONY_OVERRIDE_REGISTRY[lead_path] = merged

            sources.append(mix_path)

    url_inputs = [url.strip() for url in payload.get("urls", []) if str(url).strip()]
    if url_inputs:
        download_dir = cache_dir / "downloaded-inputs" / payload["runId"]
        download_dir.mkdir(parents=True, exist_ok=True)
        for url in url_inputs:
            parsed = urllib.parse.urlparse(url)
            if parsed.scheme not in {"http", "https"}:
                raise IntegrationError(f"Only HTTP and HTTPS URLs are supported: {url}")
            if is_direct_audio_url(url):
                downloaded = download_direct_audio(url, download_dir, run_id)
            else:
                downloaded = download_youtube_audio(url, download_dir, run_id)
            URL_SOURCE_REGISTRY[downloaded.resolve()] = url
            sources.append(downloaded)

    unique_sources: list[Path] = []
    seen = set()
    for source in sources:
        key = str(source)
        if key not in seen:
            seen.add(key)
            unique_sources.append(source)
    return unique_sources


def _strip_pro_keys_tracks(midi_path: Path) -> int:
    """Remove every track named 'PART REAL_KEYS_*' from notes.mid in place.
    Upstream STRUM always emits Pro Keys tracks alongside PART KEYS; this
    honors the user's `enabledTracks.proKeys=false` toggle. Returns the
    number of tracks removed."""
    try:
        import mido
    except Exception:
        return 0
    mid = mido.MidiFile(str(midi_path))
    kept = []
    removed = 0
    for track in mid.tracks:
        name = ""
        for msg in track:
            if msg.is_meta and msg.type == 'track_name':
                name = str(getattr(msg, 'name', ''))
                break
        if name.startswith("PART REAL_KEYS_"):
            removed += 1
            continue
        kept.append(track)
    if removed > 0:
        mid.tracks = kept
        mid.save(str(midi_path))
    return removed


def _retime_midi_to_tempo_map(midi_path: Path, init_bpm: float, tempo_map: list[tuple[float, float]]) -> None:
    """Rewrite a STRUM-generated notes.mid (written with constant `init_bpm`)
    so it uses `tempo_map` while preserving each event's real-world time.
    `tempo_map` must already be normalized: sorted by time, deduped, and
    starting at timeSec=0.
    """
    if not tempo_map or init_bpm <= 0:
        return
    try:
        import mido
    except Exception as exc:  # pragma: no cover - mido is bundled
        logging.getLogger(__name__).warning(
            "Skipping tempo-map retime: mido import failed (%s)", exc
        )
        return

    mid = mido.MidiFile(str(midi_path))
    tpb = mid.ticks_per_beat
    sec_per_tick_old = 60.0 / (init_bpm * tpb)

    def realtime_to_tick(t_sec: float) -> int:
        if t_sec <= 0:
            return 0
        ticks = 0.0
        for i, (t_i, bpm_i) in enumerate(tempo_map):
            t_next = tempo_map[i + 1][0] if i + 1 < len(tempo_map) else float('inf')
            if t_sec < t_next:
                ticks += (t_sec - t_i) * bpm_i * tpb / 60.0
                return int(round(ticks))
            ticks += (t_next - t_i) * bpm_i * tpb / 60.0
        return int(round(ticks))

    new_tracks = []
    for track_idx, track in enumerate(mid.tracks):
        abs_tick = 0
        timed_msgs: list[tuple[float, int, Any]] = []
        for msg in track:
            abs_tick += msg.time
            if msg.is_meta and msg.type == 'set_tempo':
                # Drop existing tempo events; the user's map replaces them.
                continue
            real_time = abs_tick * sec_per_tick_old
            timed_msgs.append((real_time, 1, msg))

        # Inject the user's tempo events on the first track (STRUM's tempo track).
        if track_idx == 0:
            for t_i, bpm_i in tempo_map:
                tempo_msg = mido.MetaMessage('set_tempo', tempo=mido.bpm2tempo(bpm_i), time=0)
                timed_msgs.append((t_i, 0, tempo_msg))

        # Sort by real_time, then by priority (0=tempo, 1=note, 2=end_of_track).
        def _prio(msg) -> int:
            if msg.is_meta and msg.type == 'end_of_track':
                return 2
            return 1
        timed_msgs.sort(key=lambda item: (item[0], item[1] if item[1] == 0 else _prio(item[2])))

        new_track = mido.MidiTrack()
        prev_tick = 0
        for t_real, _prio_set, msg in timed_msgs:
            new_abs_tick = realtime_to_tick(t_real)
            delta = max(0, new_abs_tick - prev_tick)
            new_track.append(msg.copy(time=delta))
            prev_tick = new_abs_tick
        new_tracks.append(new_track)

    mid.tracks = new_tracks
    mid.save(str(midi_path))


def _quantize_drum_track(
    midi_path: Path,
    division: int = 32,
    window_ms: float = 40.0,
) -> int:
    """Snap drum onsets in notes.mid to the nearest 1/``division`` grid line,
    but only when an onset already lies within ``window_ms`` of that line.

    STRUM places drum notes at the raw onset time reported by its detector,
    with no musical quantization. Small onset-timing errors (a handful of ms)
    then render as notes sitting on a 32nd-note subdivision between gridlines
    in-game — the "drums off by a 32nd note" complaint. This pass removes that
    jitter while leaving genuinely off-grid hits (fills, syncopation, anything
    further than ``window_ms`` from a gridline) exactly where STRUM put them.

    Operates only on the ``PART DRUMS`` track. note_off events are shifted by
    the same delta as their matching note_on so note durations are preserved.
    Returns the number of onsets snapped.
    """
    if division <= 0 or window_ms <= 0:
        return 0
    try:
        import mido
    except Exception as exc:  # pragma: no cover - mido is bundled
        logging.getLogger(__name__).warning(
            "Skipping drum quantize: mido import failed (%s)", exc
        )
        return 0

    mid = mido.MidiFile(str(midi_path))
    tpb = mid.ticks_per_beat
    # Ticks between adjacent 1/division grid lines. division is in note values
    # (32 = 32nd note), and there are division/4 of them per quarter-note beat.
    grid_ticks = (tpb * 4.0) / division
    if grid_ticks <= 0:
        return 0

    # Build an absolute-tick tempo map (default 120 BPM if none present) so the
    # ms-window can be converted to ticks at each note's local tempo.
    DEFAULT_TEMPO = 500000  # microseconds per beat == 120 BPM
    tempo_changes: list[tuple[int, int]] = []
    for track in mid.tracks:
        abs_tick = 0
        for msg in track:
            abs_tick += msg.time
            if msg.is_meta and msg.type == 'set_tempo':
                tempo_changes.append((abs_tick, msg.tempo))
    tempo_changes.sort(key=lambda x: x[0])

    def tempo_at(tick: int) -> int:
        active = DEFAULT_TEMPO
        for t_tick, tempo in tempo_changes:
            if t_tick <= tick:
                active = tempo
            else:
                break
        return active

    def window_ticks_at(tick: int) -> float:
        tempo = tempo_at(tick)  # microseconds per beat
        sec_per_tick = (tempo / 1_000_000.0) / tpb
        if sec_per_tick <= 0:
            return 0.0
        return (window_ms / 1000.0) / sec_per_tick

    snapped = 0
    new_tracks = []
    for track in mid.tracks:
        # Identify the drums track by its track_name meta event.
        name = ""
        for msg in track:
            if msg.is_meta and msg.type == 'track_name':
                name = str(getattr(msg, 'name', ''))
                break
        if name != "PART DRUMS":
            new_tracks.append(track)
            continue

        # Expand to absolute-tick events, then compute a per-onset snap delta.
        events: list[list[Any]] = []  # [abs_tick, msg]
        abs_tick = 0
        for msg in track:
            abs_tick += msg.time
            events.append([abs_tick, msg])

        # Map each note_on to the delta we will apply, then apply the SAME
        # delta to the matching note_off so durations are preserved. Match
        # by (note, channel) using a stack to handle repeated notes.
        open_notes: dict[tuple[int, int], list[int]] = {}
        for ev in events:
            tick, msg = ev[0], ev[1]
            if msg.type == 'note_on' and getattr(msg, 'velocity', 0) > 0:
                nearest = round(tick / grid_ticks) * grid_ticks
                delta = nearest - tick
                if 0 < abs(delta) <= window_ticks_at(tick):
                    new_tick = int(round(tick + delta))
                    applied = new_tick - tick
                    ev[0] = new_tick
                    if applied != 0:
                        snapped += 1
                    key = (msg.note, getattr(msg, 'channel', 0))
                    open_notes.setdefault(key, []).append(applied)
            elif msg.type == 'note_off' or (msg.type == 'note_on' and getattr(msg, 'velocity', 0) == 0):
                key = (msg.note, getattr(msg, 'channel', 0))
                stack = open_notes.get(key)
                if stack:
                    applied = stack.pop(0)
                    ev[0] = max(0, ev[0] + applied)

        # Re-sort by absolute tick (stable) and rebuild delta times.
        events.sort(key=lambda e: e[0])
        new_track = mido.MidiTrack()
        prev = 0
        for tick, msg in events:
            delta = max(0, tick - prev)
            new_track.append(msg.copy(time=delta))
            prev = tick
        new_tracks.append(new_track)

    if snapped > 0:
        mid.tracks = new_tracks
        mid.save(str(midi_path))
    return snapped


def _quantize_onsets(
    midi_path: Path,
    division: int,
    window_ms: float,
    track_predicate,
) -> int:
    """Generalised onset snap: nudge note onsets to the nearest 1/``division``
    grid line, but only when an onset already lies within ``window_ms`` of that
    line. ``track_predicate`` is a callable taking a track name and returning
    True for the tracks to process (e.g. all ``PART *`` tracks). This is the
    residual-jitter cleanup applied after tempo refinement — at that point the
    grid already matches the music, so this only mops up the few-ms error left
    by the onset detector and leaves genuinely off-grid hits alone. note_off
    events are shifted by the same delta as their matching note_on so durations
    are preserved. Returns the number of onsets snapped.
    """
    if division <= 0 or window_ms <= 0:
        return 0
    try:
        import mido
    except Exception as exc:  # pragma: no cover - mido is bundled
        logging.getLogger(__name__).warning(
            "Skipping onset quantize: mido import failed (%s)", exc
        )
        return 0

    mid = mido.MidiFile(str(midi_path))
    tpb = mid.ticks_per_beat
    grid_ticks = (tpb * 4.0) / division
    if grid_ticks <= 0:
        return 0

    DEFAULT_TEMPO = 500000  # microseconds per beat == 120 BPM
    tempo_changes: list[tuple[int, int]] = []
    for track in mid.tracks:
        abs_tick = 0
        for msg in track:
            abs_tick += msg.time
            if msg.is_meta and msg.type == 'set_tempo':
                tempo_changes.append((abs_tick, msg.tempo))
    tempo_changes.sort(key=lambda x: x[0])

    def tempo_at(tick: int) -> int:
        active = DEFAULT_TEMPO
        for t_tick, tempo in tempo_changes:
            if t_tick <= tick:
                active = tempo
            else:
                break
        return active

    def window_ticks_at(tick: int) -> float:
        tempo = tempo_at(tick)
        sec_per_tick = (tempo / 1_000_000.0) / tpb
        if sec_per_tick <= 0:
            return 0.0
        return (window_ms / 1000.0) / sec_per_tick

    snapped = 0
    new_tracks = []
    for track in mid.tracks:
        name = ""
        for msg in track:
            if msg.is_meta and msg.type == 'track_name':
                name = str(getattr(msg, 'name', ''))
                break
        if not track_predicate(name):
            new_tracks.append(track)
            continue

        events: list[list[Any]] = []  # [abs_tick, msg]
        abs_tick = 0
        for msg in track:
            abs_tick += msg.time
            events.append([abs_tick, msg])

        open_notes: dict[tuple[int, int], list[int]] = {}
        for ev in events:
            tick, msg = ev[0], ev[1]
            if msg.type == 'note_on' and getattr(msg, 'velocity', 0) > 0:
                nearest = round(tick / grid_ticks) * grid_ticks
                delta = nearest - tick
                if 0 < abs(delta) <= window_ticks_at(tick):
                    new_tick = int(round(tick + delta))
                    applied = new_tick - tick
                    ev[0] = new_tick
                    if applied != 0:
                        snapped += 1
                    key = (msg.note, getattr(msg, 'channel', 0))
                    open_notes.setdefault(key, []).append(applied)
            elif msg.type == 'note_off' or (msg.type == 'note_on' and getattr(msg, 'velocity', 0) == 0):
                key = (msg.note, getattr(msg, 'channel', 0))
                stack = open_notes.get(key)
                if stack:
                    applied = stack.pop(0)
                    ev[0] = max(0, ev[0] + applied)

        events.sort(key=lambda e: e[0])
        new_track = mido.MidiTrack()
        prev = 0
        for tick, msg in events:
            delta = max(0, tick - prev)
            new_track.append(msg.copy(time=delta))
            prev = tick
        new_tracks.append(new_track)

    if snapped > 0:
        mid.tracks = new_tracks
        mid.save(str(midi_path))
    return snapped


def _recover_note_onsets(midi_path: Path) -> tuple[int, float, list[float]]:
    """Read notes.mid and return ``(ticks_per_beat, init_bpm, onset_times_sec)``.

    Onset times are recovered in real-world seconds using whatever tempo map the
    file currently carries (STRUM writes a single constant tempo at this stage).
    Onsets come from the rhythmic instrument tracks (drums/bass/guitar/keys when
    available), are deduped to a 25 ms minimum spacing so dense chords don't
    dominate the fit, and are returned sorted. These onsets are the ground truth
    the tempo grid is fitted to — they sit where the actual hits are in the audio.
    """
    try:
        import mido
    except Exception:  # pragma: no cover - mido is bundled
        return (480, 120.0, [])

    mid = mido.MidiFile(str(midi_path))
    tpb = mid.ticks_per_beat or 480

    DEFAULT_TEMPO = 500000  # microseconds per beat == 120 BPM
    tempo_changes: list[tuple[int, int]] = []
    for track in mid.tracks:
        at = 0
        for msg in track:
            at += msg.time
            if msg.is_meta and msg.type == 'set_tempo':
                tempo_changes.append((at, msg.tempo))
    tempo_changes.sort(key=lambda x: x[0])

    # Build (tick, seconds_at_tick, tempo) boundaries so tick->seconds is exact
    # for either a constant tempo or a variable map.
    tc = tempo_changes[:]
    if not tc or tc[0][0] != 0:
        tc = [(0, DEFAULT_TEMPO)] + tc
    boundaries: list[tuple[int, float, int]] = []
    cum_sec = 0.0
    prev_tick = 0
    cur_tempo = tc[0][1]
    for i, (tk, tp) in enumerate(tc):
        if i == 0:
            boundaries.append((tk, 0.0, tp))
            prev_tick, cur_tempo = tk, tp
            continue
        cum_sec += (tk - prev_tick) * (cur_tempo / 1_000_000.0) / tpb
        boundaries.append((tk, cum_sec, tp))
        prev_tick, cur_tempo = tk, tp

    init_bpm = 60_000_000.0 / boundaries[0][2]

    def tick_to_sec(tick: int) -> float:
        base_tick, base_sec, tempo = boundaries[0]
        for b_tick, b_sec, b_tempo in boundaries:
            if b_tick <= tick:
                base_tick, base_sec, tempo = b_tick, b_sec, b_tempo
            else:
                break
        return base_sec + (tick - base_tick) * (tempo / 1_000_000.0) / tpb

    PREFERRED = {"PART DRUMS", "PART BASS", "PART GUITAR", "PART KEYS"}
    preferred_onsets: list[float] = []
    fallback_onsets: list[float] = []
    for track in mid.tracks:
        name = ""
        for msg in track:
            if msg.is_meta and msg.type == 'track_name':
                name = str(getattr(msg, 'name', ''))
                break
        if not name.startswith("PART ") or "VOCAL" in name:
            continue
        target = preferred_onsets if name in PREFERRED else fallback_onsets
        at = 0
        for msg in track:
            at += msg.time
            if msg.type == 'note_on' and getattr(msg, 'velocity', 0) > 0:
                target.append(tick_to_sec(at))

    onsets = preferred_onsets if len(preferred_onsets) >= 16 else (preferred_onsets + fallback_onsets)
    onsets.sort()
    deduped: list[float] = []
    for t in onsets:
        if not deduped or t - deduped[-1] >= 0.025:
            deduped.append(t)
    return (tpb, init_bpm, deduped)


def _grid_fit_error(onsets: list[float], bpm: float, subdivisions: int = 4) -> float:
    """Mean distance (seconds) from each onset to the nearest grid line of a
    1/(``subdivisions``-per-beat) grid at ``bpm``, after removing the best
    constant phase. Lower means the grid explains the onsets better. A slightly
    wrong BPM makes the phase drift across the song, which inflates this error —
    so minimising it recovers the true tempo. The 16th-note grid (subdivisions=4)
    lets legitimate off-beat playing count as on-grid.
    """
    import math
    if bpm <= 0 or len(onsets) < 2:
        return float('inf')
    step = (60.0 / bpm) / subdivisions
    if step <= 0:
        return float('inf')
    sin_s = 0.0
    cos_s = 0.0
    for t in onsets:
        ang = 2.0 * math.pi * ((t / step) % 1.0)
        sin_s += math.sin(ang)
        cos_s += math.cos(ang)
    mean_phase = math.atan2(sin_s, cos_s) / (2.0 * math.pi)  # in units of `step`
    total = 0.0
    for t in onsets:
        u = t / step - mean_phase
        total += abs(u - round(u))
    return (total / len(onsets)) * step


def _refine_bpm(onsets: list[float], center: float, span: float = 3.0) -> tuple[float, float]:
    """Fine grid-search BPM in ``[center-span, center+span]`` (0.02 BPM steps) to
    minimise :func:`_grid_fit_error`. Returns ``(best_bpm, best_error_seconds)``.
    """
    best_bpm = center
    best_err = _grid_fit_error(onsets, center)
    lo = max(30.0, center - span)
    hi = center + span
    steps = int(round((hi - lo) / 0.02))
    for i in range(steps + 1):
        bpm = lo + i * 0.02
        err = _grid_fit_error(onsets, bpm)
        if err < best_err:
            best_err, best_bpm = err, bpm
    return best_bpm, best_err


def _estimate_global_tempo(onsets: list[float], init_bpm: float) -> tuple[float, float]:
    """Level A: best single tempo for the whole song. Fine-refines around the
    detected BPM and, conservatively, checks the half/double-time octaves —
    only switching octave when the fit is dramatically better, so we never make
    a correct tempo worse. Returns ``(best_bpm, best_error_seconds)``.
    """
    best_bpm, best_err = _refine_bpm(onsets, init_bpm)
    for factor in (0.5, 2.0):
        center = init_bpm * factor
        if center < 40.0 or center > 280.0:
            continue
        cand_bpm, cand_err = _refine_bpm(onsets, center)
        # Only switch octave when the alternate grid is both dramatically better
        # *and* genuinely tight (small absolute error). A truly octave-wrong song
        # snaps onto the correct grid within a few ms; a merely drifting song can
        # also look "relatively" better on a denser 2x grid but leaves a large
        # residual — the absolute gate keeps drift from masquerading as an octave
        # error and pushing the whole chart to double time.
        if cand_err < best_err * 0.6 and cand_err < 0.012:
            best_bpm, best_err = cand_bpm, cand_err
    return best_bpm, best_err


def _estimate_tempo_map(onsets: list[float], global_bpm: float) -> "list[tuple[float, float]] | None":
    """Level B: detect tempo drift and, when present, build a piecewise tempo
    map (list of ``(timeSec, bpm)``). Returns None when the song is steady enough
    that the single global tempo is best, so steady songs never get a cluttered
    map. Per-window tempos are clamped to a sane drift band and smoothed.
    """
    if len(onsets) < 32:
        return None
    duration = onsets[-1] - onsets[0]
    if duration < 30.0:
        return None
    window = 12.0  # seconds
    n_windows = int(duration // window) + 1
    if n_windows < 3:
        return None

    start = onsets[0]
    span = global_bpm * 0.06
    local: list[tuple[float, float]] = []  # (window_start_time, bpm)
    for w in range(n_windows):
        w0 = start + w * window
        seg = [t for t in onsets if w0 <= t < w0 + window]
        if len(seg) < 8:
            local.append((w0, local[-1][1] if local else global_bpm))
            continue
        bpm, _ = _refine_bpm(seg, global_bpm, span=span)
        bpm = max(global_bpm * 0.85, min(global_bpm * 1.15, bpm))
        local.append((w0, bpm))

    bpms = [b for _, b in local]
    if max(bpms) - min(bpms) < 1.0:
        return None  # steady — global tempo wins

    # 3-point moving average to damp window-to-window jitter.
    smoothed: list[tuple[float, float]] = []
    for i, (t, _b) in enumerate(local):
        lo = max(0, i - 1)
        hi = min(len(local), i + 2)
        avg = sum(b for _, b in local[lo:hi]) / (hi - lo)
        smoothed.append((t, avg))
    smoothed[0] = (0.0, smoothed[0][1])  # first event must anchor at t=0

    tempo_map: list[tuple[float, float]] = []
    for t, b in smoothed:
        if tempo_map and abs(tempo_map[-1][1] - b) < 0.3:
            continue  # collapse near-equal consecutive tempos
        tempo_map.append((round(t, 3), round(b, 3)))
    if len(tempo_map) < 2:
        return None
    return tempo_map


def _beat_track_tempo_map(
    audio_path: Path,
    hint_bpm: "float | None" = None,
    allow_drift: bool = True,
) -> "tuple[list[tuple[float, float]] | None, float | None]":
    """Beat-track the *audio* (the approach ConvertHero uses) to align the
    chart's beat grid to the real performance.

    Instead of fitting one global BPM to STRUM's already-quantized MIDI onsets,
    this runs an onset-strength envelope + a dynamic-programming beat tracker
    over the rendered audio to find the time of (essentially) every quarter-note
    beat, then turns consecutive beat intervals into a dense tempo map. Because a
    tempo event is emitted per beat, the measure/beat lines land on the real
    beats even when the song speeds up or slows down — which a single global BPM
    can never do (the core of issue #8).

    ``hint_bpm`` (the user's Manual BPM, treated as the truth) seeds the tracker
    so it locks onto the correct tempo octave. With ``allow_drift`` False the map
    is collapsed to a single constant tempo. Returns ``(tempo_map, base_bpm)`` or
    ``(None, None)`` when audio analysis isn't possible so the caller can fall
    back to the onset method.
    """
    try:
        import librosa
        import numpy as np
    except Exception:
        return (None, None)
    try:
        y, sr = librosa.load(str(audio_path), mono=True)
    except Exception:
        return (None, None)
    if y is None or len(y) < sr:  # need at least ~1s of audio
        return (None, None)
    # Near-silent input (e.g. a drums stem from a drumless track) carries no
    # rhythmic information — bail so the caller can try the next candidate.
    if float(np.sqrt(np.mean(np.square(y)))) < 0.004:
        return (None, None)

    # 256-sample hop (~11.6ms at 22.05kHz) instead of librosa's default 512:
    # tempo-map accuracy is bounded by onset-envelope resolution, and halving
    # the hop noticeably tightens beat placement (closer to ConvertHero).
    hop = 256
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    kwargs: dict[str, Any] = {"onset_envelope": onset_env, "sr": sr, "hop_length": hop, "trim": False}
    if hint_bpm and hint_bpm > 0:
        # Seed the tracker with the user-asserted tempo and keep the prior tight
        # so it doesn't wander to a half/double-time octave.
        kwargs["start_bpm"] = float(hint_bpm)
        kwargs["std_bpm"] = 0.5
    try:
        _tempo, beat_frames = librosa.beat.beat_track(**kwargs)
    except Exception:
        return (None, None)

    # The DP beat tracker optimises global smoothness, so individual beats can
    # sit a frame or two off the true percussive attack. Snap each beat to the
    # strongest onset-envelope peak within ±70ms (ConvertHero-style onset
    # alignment), then refine to sub-frame precision with parabolic
    # interpolation around that peak (a frame at hop 256 is ~11.6ms — too
    # coarse on its own for a grid that must stay locked for 4+ minutes).
    frames = [int(f) for f in np.asarray(beat_frames).ravel()]
    snap_radius = max(1, int(round(0.07 * sr / hop)))
    snapped: list[float] = []
    for f in frames:
        lo = max(0, f - snap_radius)
        hi = min(len(onset_env), f + snap_radius + 1)
        if hi > lo:
            f = lo + int(np.argmax(onset_env[lo:hi]))
        sub = float(f)
        if 0 < f < len(onset_env) - 1:
            a = float(onset_env[f - 1])
            b = float(onset_env[f])
            c = float(onset_env[f + 1])
            denom = a - 2.0 * b + c
            if abs(denom) > 1e-9:
                delta = 0.5 * (a - c) / denom
                if -0.5 <= delta <= 0.5:
                    sub = f + delta
        if snapped and sub <= snapped[-1]:
            continue
        snapped.append(sub)

    beat_times = [s * hop / sr for s in snapped if s >= 0]
    if len(beat_times) < 8:
        return (None, None)

    # Constant-lag correction (issue #8, round 3). The spectral-flux onset
    # envelope peaks slightly AFTER the physical attack transient — the
    # analysis window has to integrate the attack before flux peaks — so every
    # beat mark inherits the same few-ms delay. Per-beat anchoring removed the
    # cumulative drift, but testers report the whole grid sitting a small,
    # consistent amount off the waveform (visible against Moonscraper's
    # waveform view). Measure the lag directly on the raw signal: for each
    # beat, find the steepest amplitude rise nearby at ~3ms resolution, then
    # shift the entire grid by the median displacement.
    try:
        fine_hop = 64
        rms = librosa.feature.rms(y=y, frame_length=256, hop_length=fine_hop)[0]
        rise = np.maximum(0.0, np.diff(rms))
        radius = max(1, int(round(0.05 * sr / fine_hop)))
        lag_samples: list[tuple[float, float]] = []  # (rise strength, offset sec)
        for t in beat_times:
            c = int(round(t * sr / fine_hop))
            lo = max(0, c - radius)
            hi = min(len(rise), c + radius + 1)
            if hi - lo < 3:
                continue
            k = lo + int(np.argmax(rise[lo:hi]))
            lag_samples.append((float(rise[k]), (k - c) * fine_hop / sr))
        if len(lag_samples) >= 8:
            # Only trust beats with a clear attack: keep the stronger half.
            floor = sorted(s for s, _ in lag_samples)[len(lag_samples) // 2]
            offsets = [o for s, o in lag_samples if s >= floor]
            lag = float(np.median(offsets))
            lag = max(-0.06, min(0.06, lag))
            if abs(lag) >= 0.003:
                beat_times = [t + lag for t in beat_times if t + lag >= 0.0]
    except Exception:
        pass
    if len(beat_times) < 8:
        return (None, None)

    # Instantaneous BPM across each beat interval (used for the octave guard).
    interval_bpms: list[float] = []
    for i in range(len(beat_times) - 1):
        dt = beat_times[i + 1] - beat_times[i]
        if dt <= 1e-3:
            continue
        bpm = 60.0 / dt
        if 30.0 <= bpm <= 300.0:
            interval_bpms.append(bpm)
    if len(interval_bpms) < 4:
        return (None, None)

    median_bpm = float(np.median(interval_bpms))

    # Truth guard: if the user gave a Manual BPM but the tracker locked onto a
    # clearly different octave (~half/double), don't silently fight them — bail
    # so the caller falls back to the hint-seeded onset method.
    if hint_bpm and hint_bpm > 0:
        ratio = median_bpm / hint_bpm
        if ratio > 1.4 or ratio < 0.72:
            return (None, None)

    if not allow_drift:
        base = float(hint_bpm) if (hint_bpm and hint_bpm > 0) else round(median_bpm, 3)
        return ([(0.0, base)], base)

    # Emit a tempo event on every detected beat, with the BPM computed exactly
    # from that beat's interval (60 / dt) and NO smoothing. This is what
    # ConvertHero does (GenerateChartFile: one SyncEvent per tick, collapsed
    # only when |ΔBPM| < 0.01): because each segment spans exactly one beat,
    # the grid re-anchors to the measured beat time at every beat and phase
    # error can never accumulate toward the end of the song. Our previous
    # 5-wide moving average + 0.25 BPM collapse traded that anchoring away
    # for a sparser map, which is precisely what caused the end-of-song drift.
    #
    # Drop a "beat" detected almost immediately at t=0 (inside the first
    # half-period): keeping it would force an absurd lead-in tempo below.
    # ConvertHero does the same head cleanup in PostProcessTicks.
    period = 60.0 / median_bpm
    while len(beat_times) > 8 and beat_times[0] < period / 2:
        beat_times.pop(0)

    tempo_map: list[tuple[float, float]] = []
    for i in range(len(beat_times) - 1):
        dt = beat_times[i + 1] - beat_times[i]
        if dt <= 1e-3:
            continue
        b = round(60.0 / dt, 3)
        if tempo_map and abs(tempo_map[-1][1] - b) < 0.01:
            continue
        tempo_map.append((round(beat_times[i], 6), b))
    if not tempo_map:
        return (None, None)

    # Lead-in segment: land the FIRST detected beat exactly ON a beat boundary
    # (tick = n*480). The per-beat events above keep beat SPACING exactly 480
    # ticks, but the integration from t=0 otherwise puts beat 0 at an arbitrary
    # fractional tick — so the entire grid sits a constant fraction of a beat
    # off the measure lines for the whole song (the uniform offset testers see
    # against the waveform in Moonscraper; shifting beat times can never fix
    # it). ConvertHero avoids this by constructing beat i at tick 192*i and
    # deriving the lead-in tempo to make it true; we do the same, choosing n
    # so the lead-in tempo stays close to the song tempo.
    first_t = tempo_map[0][0]
    if first_t > 1e-3:
        n_beats = max(1, int(round(first_t / period)))
        lead_bpm = round(60.0 * n_beats / first_t, 3)
        tempo_map.insert(0, (0.0, lead_bpm))
    return (tempo_map, round(median_bpm, 3))


def _refine_tempo(
    midi_path: Path,
    allow_drift: bool,
    hint_bpm: "float | None" = None,
    audio_path: "Path | None" = None,
    drum_audio_path: "Path | None" = None,
) -> str:
    """Align notes.mid's tempo grid to the song.

    Primary method (ConvertHero-style): beat-track the *audio* to place a tempo
    event on every real beat, so beat/measure lines follow the actual
    performance even when it drifts. Falls back to fitting a tempo to STRUM's
    MIDI onsets when audio beat-tracking isn't available. Real-world note times
    are always preserved — only tempo and tick positions move — so playback
    stays in sync while notes land on the grid.

    ``hint_bpm`` is the user's Manual BPM and is treated as the truth: it seeds
    the tracker (correcting tempo-octave errors) and, when drift is disabled, is
    applied verbatim. Returns a short human-readable status.
    """
    _tpb, init_bpm, onsets = _recover_note_onsets(midi_path)

    # 1) Preferred: beat-track the rendered audio. The isolated drum stem (when
    # Demucs produced one) is tried first — percussive onsets without vocals /
    # sustained instruments smearing the envelope give a noticeably tighter
    # tempo map (testers got their best maps running ConvertHero on drums.ogg;
    # see GitHub issue #8). The full mix is the fallback.
    candidates: list[tuple[Path, str]] = []
    if drum_audio_path is not None and Path(drum_audio_path).exists():
        candidates.append((Path(drum_audio_path), "drum-stem beat-track"))
    if audio_path is not None and Path(audio_path).exists():
        candidates.append((Path(audio_path), "audio beat-track"))
    for cand_path, cand_label in candidates:
        tempo_map, base = _beat_track_tempo_map(cand_path, hint_bpm, allow_drift)
        if tempo_map and base and init_bpm > 0:
            _retime_midi_to_tempo_map(midi_path, init_bpm, tempo_map)
            if len(tempo_map) > 1:
                return f"{cand_label} ({len(tempo_map)} tempo events, {base:.2f} BPM base)"
            return f"{cand_label} (constant {base:.2f} BPM)"

    # 2) Fallback: fit a tempo to STRUM's MIDI note onsets (legacy method).
    if len(onsets) < 16:
        if hint_bpm and hint_bpm > 0 and init_bpm > 0:
            _retime_midi_to_tempo_map(midi_path, init_bpm, [(0.0, float(hint_bpm))])
            return f"applied manual {hint_bpm:.2f} BPM"
        return "skipped (too few onsets to analyse)"
    center_bpm = hint_bpm if (hint_bpm and hint_bpm > 0) else init_bpm
    global_bpm, _err = _estimate_global_tempo(onsets, center_bpm)
    tempo_map = [(0.0, global_bpm)]
    drift = _estimate_tempo_map(onsets, global_bpm) if allow_drift else None
    if drift:
        tempo_map = drift
    # Nothing meaningfully changed for a steady song already on the right tempo
    # (unless the user pinned a Manual BPM we still want to honour).
    if not drift and abs(global_bpm - init_bpm) < 0.05 and not (hint_bpm and hint_bpm > 0):
        return f"already aligned ({init_bpm:.2f} BPM)"
    _retime_midi_to_tempo_map(midi_path, init_bpm, tempo_map)
    if drift:
        return f"onset tempo map ({len(tempo_map)} events, {global_bpm:.2f} BPM base)"
    return f"refined {init_bpm:.2f} -> {global_bpm:.2f} BPM"


def _tag_song_as_ai_generated(song_folder: Path) -> None:
    """Mark a generated song's ``song.ini`` as AI auto-charted.

    Charters in the community have asked that auto-generated charts be clearly
    identifiable in metadata so they are not mistaken for hand-charted work.
    We add explicit, non-destructive markers to the ``[song]`` section without
    clobbering any existing charter/author fields.
    """
    ini_path = song_folder / "song.ini"
    if not ini_path.exists():
        return
    try:
        text = ini_path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return

    lines = text.splitlines()
    lowered = {ln.split("=", 1)[0].strip().lower() for ln in lines if "=" in ln}

    # Locate the [song] section header (case-insensitive); fall back to top.
    insert_at = None
    for i, ln in enumerate(lines):
        if ln.strip().lower() in ("[song]", "[game]"):
            insert_at = i + 1
            break

    additions: list[str] = []
    if "auto_chart" not in lowered:
        additions.append("auto_chart = True")
    if "auto_chart_tool" not in lowered:
        additions.append("auto_chart_tool = STRUM (OCTAVE AI auto-charter)")
    if "charter" not in lowered:
        additions.append("charter = STRUM (AI auto-charted)")
    if not additions:
        return

    if insert_at is None:
        lines = ["[song]", *additions, *lines]
    else:
        lines[insert_at:insert_at] = additions

    try:
        ini_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except Exception:
        return


def run_pipeline(payload: dict[str, Any]) -> int:
    run_id = str(payload["runId"])
    cache_dir = Path(payload["cacheDir"]).expanduser().resolve()
    output_dir = Path(payload["outputDir"]).expanduser().resolve()
    include_keys = bool(payload.get("includeKeys", True))
    enabled_tracks_raw = payload.get("enabledTracks") or {}
    enabled_tracks = {k: bool(v) for k, v in enabled_tracks_raw.items()} if isinstance(enabled_tracks_raw, dict) else None

    global INCLUDE_PRO_KEYS
    INCLUDE_PRO_KEYS = bool((enabled_tracks or {}).get('proKeys', True))

    # Keep Demucs-separated stems as per-instrument oggs instead of discarding
    # them (community-requested). Off by default to preserve prior behaviour.
    global KEEP_STEMS
    KEEP_STEMS = bool(payload.get("keepStems", False))
    SEPARATED_STEM_REGISTRY.clear()

    # Optional drum grid-snap (community-requested fix for "drums off by a
    # 32nd note"). Off by default; when on, drum onsets already close to a
    # grid line are nudged onto it. See _quantize_drum_track.
    global SNAP_DRUMS, SNAP_DRUMS_DIVISION, SNAP_DRUMS_WINDOW_MS
    SNAP_DRUMS = bool(payload.get("snapDrums", False))
    try:
        SNAP_DRUMS_DIVISION = int(payload.get("snapDrumsDivision", 32) or 32)
    except (TypeError, ValueError):
        SNAP_DRUMS_DIVISION = 32
    try:
        SNAP_DRUMS_WINDOW_MS = float(payload.get("snapDrumsWindowMs", 40.0) or 40.0)
    except (TypeError, ValueError):
        SNAP_DRUMS_WINDOW_MS = 40.0

    # Automatic tempo refinement (default on). Re-fits the tempo grid to the
    # detected note onsets so notes stop drifting off the beat lines. See
    # AUTO_TEMPO comment block and _refine_tempo().
    global AUTO_TEMPO, AUTO_TEMPO_DRIFT, AUTO_TEMPO_SNAP
    global AUTO_TEMPO_SNAP_DIVISION, AUTO_TEMPO_SNAP_WINDOW_MS
    AUTO_TEMPO = bool(payload.get("autoTempo", True))
    AUTO_TEMPO_DRIFT = bool(payload.get("autoTempoDrift", True))
    AUTO_TEMPO_SNAP = bool(payload.get("autoTempoSnap", True))
    try:
        AUTO_TEMPO_SNAP_DIVISION = int(payload.get("autoTempoSnapDivision", 32) or 32)
    except (TypeError, ValueError):
        AUTO_TEMPO_SNAP_DIVISION = 32
    try:
        AUTO_TEMPO_SNAP_WINDOW_MS = float(payload.get("autoTempoSnapWindowMs", 30.0) or 30.0)
    except (TypeError, ValueError):
        AUTO_TEMPO_SNAP_WINDOW_MS = 30.0

    # Optional user-supplied tempo map. Each entry: {"timeSec": float, "bpm": float}.
    # If the first event has timeSec > 0, an implicit (0, first.bpm) is prepended.
    global USER_TEMPO_MAP
    USER_TEMPO_MAP = []
    raw_tempo_map = payload.get("tempoMap") or []
    if isinstance(raw_tempo_map, list):
        cleaned: list[tuple[float, float]] = []
        for entry in raw_tempo_map:
            if not isinstance(entry, dict):
                continue
            try:
                t = float(entry.get("timeSec", 0))
                b = float(entry.get("bpm", 0))
            except (TypeError, ValueError):
                continue
            if b <= 0 or t < 0:
                continue
            cleaned.append((t, b))
        cleaned.sort(key=lambda x: x[0])
        # Dedupe identical timestamps (keep last).
        deduped: list[tuple[float, float]] = []
        for t, b in cleaned:
            if deduped and abs(deduped[-1][0] - t) < 1e-9:
                deduped[-1] = (t, b)
            else:
                deduped.append((t, b))
        if deduped and deduped[0][0] > 0:
            deduped.insert(0, (0.0, deduped[0][1]))
        USER_TEMPO_MAP = deduped

    # Optional single-BPM hint (the user's authoritative "Manual BPM"). Seeds
    # the audio beat tracker so it locks onto the right tempo octave; see
    # _beat_track_tempo_map / _refine_tempo.
    global TEMPO_HINT_BPM
    TEMPO_HINT_BPM = None
    raw_manual_bpm = payload.get("manualBpm")
    if raw_manual_bpm not in (None, ""):
        try:
            manual_bpm = float(raw_manual_bpm)
            if manual_bpm > 0:
                TEMPO_HINT_BPM = manual_bpm
        except (TypeError, ValueError):
            TEMPO_HINT_BPM = None

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
    pipeline = build_pipeline(source_root, output_dir, device, include_keys, enabled_tracks)
    sources = collect_audio_sources(payload, cache_dir, run_id)
    if not sources:
        raise IntegrationError("No input audio sources were provided.")

    output_dir.mkdir(parents=True, exist_ok=True)
    song_folders: list[str] = []
    url_song_folders: list[dict[str, str]] = []
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
            try:
                _tag_song_as_ai_generated(Path(result.output_path))
            except Exception as exc:
                errors.append(f"{source.name}: AI watermark tag failed: {exc}")
            source_url = URL_SOURCE_REGISTRY.get(source.resolve())
            if source_url:
                url_song_folders.append({"url": source_url, "songFolder": result.output_path})
            notes_mid = Path(result.output_path) / "notes.mid"
            if not INCLUDE_PRO_KEYS and notes_mid.exists():
                try:
                    removed = _strip_pro_keys_tracks(notes_mid)
                    if removed:
                        emit_progress(
                            run_id,
                            "merge",
                            f"Stripped {removed} Pro Keys track(s) from {notes_mid.name}",
                            percent=min(96, source_start_percent + 65),
                            current_item=source.name,
                        )
                except Exception as exc:
                    errors.append(f"{source.name}: pro-keys strip failed: {exc}")
            if USER_TEMPO_MAP:
                try:
                    if notes_mid.exists():
                        _retime_midi_to_tempo_map(notes_mid, USER_TEMPO_MAP[0][1], USER_TEMPO_MAP)
                        emit_progress(
                            run_id,
                            "merge",
                            f"Applied user tempo map ({len(USER_TEMPO_MAP)} event(s)) to {notes_mid.name}",
                            percent=min(96, source_start_percent + 65),
                            current_item=source.name,
                        )
                except Exception as exc:
                    errors.append(f"{source.name}: tempo-map post-process failed: {exc}")
            elif notes_mid.exists():
                # The user's Manual BPM (if any) is authoritative; otherwise the
                # tempo is detected by beat-tracking the audio inside
                # _refine_tempo (our ConvertHero-style replacement for the old
                # online BPM lookup).
                hint_bpm = TEMPO_HINT_BPM

                if AUTO_TEMPO:
                    try:
                        # Best drum-stem candidate for beat tracking: the raw
                        # Demucs drums stem if its temp file still exists,
                        # otherwise drums.ogg exported into the song folder
                        # (only present when keep-stems is on). _refine_tempo
                        # skips candidates that don't exist.
                        drum_stem = SEPARATED_STEM_REGISTRY.get(source.resolve(), {}).get("drums")
                        if not (drum_stem and Path(drum_stem).exists()):
                            drum_stem = Path(result.output_path) / "drums.ogg"
                        status = _refine_tempo(
                            notes_mid,
                            AUTO_TEMPO_DRIFT,
                            hint_bpm=hint_bpm,
                            audio_path=source,
                            drum_audio_path=drum_stem,
                        )
                        emit_progress(
                            run_id,
                            "merge",
                            f"Tempo refine ({status}) on {notes_mid.name}",
                            percent=min(96, source_start_percent + 65),
                            current_item=source.name,
                        )
                        if AUTO_TEMPO_SNAP:
                            cleaned = _quantize_onsets(
                                notes_mid,
                                division=AUTO_TEMPO_SNAP_DIVISION,
                                window_ms=AUTO_TEMPO_SNAP_WINDOW_MS,
                                track_predicate=lambda n: n.startswith("PART ") and "VOCAL" not in n,
                            )
                            if cleaned:
                                emit_progress(
                                    run_id,
                                    "merge",
                                    f"Snapped {cleaned} residual onset(s) to grid in {notes_mid.name}",
                                    percent=min(96, source_start_percent + 65),
                                    current_item=source.name,
                                )
                    except Exception as exc:
                        errors.append(f"{source.name}: tempo refine failed: {exc}")
                elif hint_bpm:
                    # Auto-tempo is off but the user pinned a Manual BPM: apply it
                    # exactly as a single constant tempo (their truth wins).
                    try:
                        _retime_midi_to_tempo_map(notes_mid, hint_bpm, [(0.0, hint_bpm)])
                        emit_progress(
                            run_id,
                            "merge",
                            f"Applied {hint_bpm:.2f} BPM tempo to {notes_mid.name}",
                            percent=min(96, source_start_percent + 65),
                            current_item=source.name,
                        )
                    except Exception as exc:
                        errors.append(f"{source.name}: manual BPM apply failed: {exc}")
            if SNAP_DRUMS and notes_mid.exists():
                try:
                    snapped = _quantize_drum_track(
                        notes_mid,
                        division=SNAP_DRUMS_DIVISION,
                        window_ms=SNAP_DRUMS_WINDOW_MS,
                    )
                    if snapped:
                        emit_progress(
                            run_id,
                            "merge",
                            f"Snapped {snapped} drum onset(s) to grid in {notes_mid.name}",
                            percent=min(96, source_start_percent + 65),
                            current_item=source.name,
                        )
                except Exception as exc:
                    errors.append(f"{source.name}: drum quantize failed: {exc}")
        if result.error:
            errors.append(f"{source.name}: {result.error}")

    success = len(song_folders) > 0
    emit_complete(
        run_id,
        success=success,
        outputDir=str(output_dir),
        songFolders=song_folders,
        urlSongFolders=url_song_folders,
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