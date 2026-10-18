"""Bounded parent-process boundary for native Word preview (never printing)."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
from typing import Any, Sequence

MAX_RESPONSE_BYTES = 64 * 1024 * 1024
DEFAULT_TIMEOUT_SECONDS = 45
MAX_TIMEOUT_SECONDS = 120


def _held(code: str) -> dict[str, Any]:
    return {"schema": "ai3.word_native_preview.v1", "status": "NEEDS_HUMAN",
            "reason_code": code, "native_word_verified": False,
            "physical_print_verified": False, "allowed_to_print": False,
            "source_format": "DOCX", "print_source_format": "DOCX"}


def _kill_process_tree(proc: subprocess.Popen[bytes]) -> None:
    """Best-effort hard termination of the private worker and its descendants."""
    if os.name == "nt":
        # taskkill /T includes descendants such as helper processes started by
        # Word. It is bounded independently; always fall back to killing the
        # worker itself if taskkill is unavailable or does not finish.
        try:
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            killer = subprocess.Popen(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, creationflags=flags, close_fds=True)
            try:
                killer.wait(timeout=5)
            except subprocess.TimeoutExpired:
                killer.kill()
                killer.wait(timeout=2)
        except (OSError, subprocess.SubprocessError):
            pass
        if proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass
    else:
        # The worker starts a new session, so this also kills any child process
        # it created. A dead leader can still have live descendants in its group.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            if proc.poll() is None:
                try:
                    proc.kill()
                except OSError:
                    pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
        except OSError:
            pass
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _decode_response(raw: bytes, expected_sha256: str) -> dict[str, Any] | None:
    if not raw or len(raw) > MAX_RESPONSE_BYTES:
        return None
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                           parse_constant=lambda _x: (_ for _ in ()).throw(ValueError()))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError):
        return None
    if type(value) is not dict or value.get("schema") != "ai3.word_native_preview.v1":
        return None
    if value.get("source_format") != "DOCX" or value.get("print_source_format") != "DOCX":
        return None
    if value.get("physical_print_verified") is not False:
        return None
    if value.get("status") == "NEEDS_HUMAN":
        if type(value.get("reason_code")) is not str or not value["reason_code"]:
            return None
        if value.get("native_word_verified") is not False:
            return None
        if "allowed_to_print" in value and value["allowed_to_print"] is not False:
            return None
        return _held(value["reason_code"])
    if value.get("status") != "REVIEW_REQUIRED" or value.get("reason_code") != "WORD_FONT_AND_LAYOUT_STAFF_REVIEW_REQUIRED":
        return None
    if value.get("allowed_to_print") is not False:
        return None
    if type(value.get("native_word_verified")) is not bool or value.get("source_sha256") != expected_sha256:
        return None
    pages = value.get("document_pages")
    identity = value.get("renderer_identity")
    previews = value.get("preview_png")
    hashes = value.get("preview_sha256")
    warnings = value.get("warning_codes")
    if type(pages) is not int or not 1 <= pages <= 500:
        return None
    if type(identity) is not dict or not all(type(identity.get(k)) is str and identity[k] for k in ("engine", "version")):
        return None
    if type(previews) is not list or not 1 <= len(previews) <= 3 or type(hashes) is not list or len(hashes) != len(previews):
        return None
    decoded = []
    for encoded, digest in zip(previews, hashes):
        if type(encoded) is not str or type(digest) is not str:
            return None
        try:
            blob = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError):
            return None
        if not blob.startswith(b"\x89PNG\r\n\x1a\n") or hashlib.sha256(blob).hexdigest() != digest:
            return None
        decoded.append(blob)
    if type(warnings) is not list or any(type(code) is not str for code in warnings):
        return None
    if type(value.get("page_sizes")) is not list:
        return None
    value["preview_png"] = tuple(decoded)
    value["preview_sha256"] = tuple(hashes)
    value["warning_codes"] = tuple(warnings)
    return value


def preview_word_native_isolated(source_bytes: bytes, *, expected_sha256: str,
                                 allow_word_launch: bool = False,
                                 timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
                                 worker_command: Sequence[str] | None = None) -> dict[str, Any]:
    """Run Word COM in a bounded child; all failures remain staff-held.

    ``worker_command`` is an internal test seam for fake child processes. The
    production path uses this package's worker CLI and never accepts arbitrary
    paths from the caller. No API in this module can authorize a print.
    """
    if type(source_bytes) is not bytes:
        return _held("DOCX_UNSAFE_OR_CORRUPT")
    if type(expected_sha256) is not str or len(expected_sha256) != 64 or any(c not in "0123456789abcdef" for c in expected_sha256):
        return _held("SOURCE_HASH_MISMATCH")
    if hashlib.sha256(source_bytes).hexdigest() != expected_sha256:
        return _held("SOURCE_HASH_MISMATCH")
    from agents.windows.native_word_document import _validate_docx
    if not _validate_docx(source_bytes):
        return _held("DOCX_UNSAFE_OR_CORRUPT")
    if not allow_word_launch:
        return _held("WORD_LAUNCH_NOT_AUTHORIZED")
    if type(timeout_seconds) is not int or not 1 <= timeout_seconds <= MAX_TIMEOUT_SECONDS:
        return _held("WORD_WORKER_TIMEOUT_INVALID")
    if worker_command is None and sys.platform != "win32":
        return _held("WORD_WINDOWS_NOT_AVAILABLE")

    try:
        with tempfile.TemporaryDirectory(prefix="autoin-word-watchdog-") as scratch:
            root = Path(scratch)
            source_path = root / "source.docx"
            response_path = root / "response.json"
            with source_path.open("xb") as output:
                output.write(source_bytes)
                output.flush()
                os.fsync(output.fileno())
            if os.name != "nt":
                os.chmod(root, 0o700)
                os.chmod(source_path, 0o600)
            command = list(worker_command or (
                sys.executable, "-m", "agents.windows.native_word_worker"))
            command.extend(("--source", str(source_path), "--response", str(response_path),
                            "--expected-sha256", expected_sha256))
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
            proc = subprocess.Popen(
                command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, cwd=str(Path(__file__).resolve().parents[2]),
                close_fds=True, start_new_session=(os.name != "nt"), creationflags=flags)
            try:
                proc.wait(timeout=timeout_seconds)
            except subprocess.TimeoutExpired:
                _kill_process_tree(proc)
                return _held("PROCESSING_TIMEOUT")
            if proc.returncode != 0:
                _kill_process_tree(proc)
                return _held("WORD_WORKER_FAILED")
            try:
                if response_path.is_symlink() or not response_path.is_file():
                    return _held("WORD_WORKER_RESPONSE_INVALID")
                if response_path.stat().st_size > MAX_RESPONSE_BYTES:
                    return _held("WORD_WORKER_RESPONSE_INVALID")
                parsed = _decode_response(response_path.read_bytes(), expected_sha256)
            except OSError:
                parsed = None
            if parsed is None:
                _kill_process_tree(proc)
                return _held("WORD_WORKER_RESPONSE_INVALID")
            return parsed
    except Exception:
        return _held("WORD_WORKER_UNAVAILABLE")
