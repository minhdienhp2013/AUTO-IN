"""Windows native DOCX/PDF pilot adapter for the locked AI0 pilot wire.

The standalone AI3 module targets the distinct pilot Core endpoints introduced
after F7; the base commit itself has no such routes. The native path always uses
the original DOCX or PDF bytes. A spooler acceptance is SENT_UNVERIFIED, never
proof that paper came out.
"""
from __future__ import annotations

from contextlib import AbstractContextManager
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import sys
import tempfile
import uuid
from typing import Any, Protocol

from workers.documents.pilot_source_ticket import (
    PilotTicketInvalid, VerifiedPilotSource, verify_pilot_source_ticket,
)

HEX = re.compile(r"^[a-f0-9]{64}$")
MAX_PHYSICAL_SHEETS = 150
PRINT_TIMEOUT_SECONDS = 60
MAX_WORD_RESPONSE_BYTES = 4096


class PilotPrintBlocked(RuntimeError):
    pass


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical(value: Any) -> str:
    from workers.documents.bridge import _canonical as canonical
    return canonical(value)


def _kill_process_tree(proc: subprocess.Popen) -> None:
    """Bounded best-effort termination for an ambiguous native worker timeout."""
    if os.name == "nt":
        try:
            killer = subprocess.Popen(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                close_fds=True)
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


def _wait_native_process(command: list[str], timeout_seconds: int, *,
                         cwd: str | Path | None = None) -> int:
    """Run a private native-app process without a shell and with a hard deadline."""
    try:
        proc = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, shell=False, close_fds=True,
            cwd=str(cwd) if cwd is not None else None,
            start_new_session=(os.name != "nt"),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
            if os.name == "nt" else 0)
    except Exception as exc:
        raise PilotPrintBlocked("NATIVE_APP_START_FAILED") from exc
    try:
        return proc.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        _kill_process_tree(proc)
        raise PilotPrintBlocked("NATIVE_APP_TIMEOUT") from exc


def _run_word_worker(*, source_path: Path, source_sha256: str, mode: str,
                     timeout_seconds: int, printer_name: str | None = None,
                     copies: int = 1,
                     expected_page_count: int | None = None) -> dict[str, Any]:
    """Isolate Word COM; a timed-out print is ambiguous and must never be retried."""
    response_path = source_path.with_name(
        source_path.name + "." + uuid.uuid4().hex + ".response.json")
    command = [sys.executable, "-m", "agents.windows.pilot_word_print_worker",
               "--source", str(source_path), "--response", str(response_path),
               "--expected-sha256", source_sha256, "--mode", mode]
    if mode == "print":
        if printer_name is None or expected_page_count is None:
            raise PilotPrintBlocked("WORD_PRINT_REQUEST_INVALID")
        command.extend(("--printer", printer_name, "--copies", str(copies),
                        "--expected-pages", str(expected_page_count)))
    try:
        project_root = Path(__file__).resolve().parents[2]
        return_code = _wait_native_process(command, timeout_seconds, cwd=project_root)
        if return_code != 0 or response_path.is_symlink() or not response_path.is_file():
            raise PilotPrintBlocked("WORD_WORKER_RESPONSE_INVALID")
        _assert_private_windows_acl(response_path)
        if response_path.stat().st_size > MAX_WORD_RESPONSE_BYTES:
            raise PilotPrintBlocked("WORD_WORKER_RESPONSE_INVALID")

        def unique_object(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError("duplicate response key")
                result[key] = value
            return result

        try:
            value = json.loads(response_path.read_text(encoding="utf-8"),
                               object_pairs_hook=unique_object,
                               parse_constant=lambda _x: (_ for _ in ()).throw(ValueError()))
        except Exception as exc:
            raise PilotPrintBlocked("WORD_WORKER_RESPONSE_INVALID") from exc
        if (type(value) is not dict or set(value) != {"status", "source_sha256", "page_count"} or
                value.get("source_sha256") != source_sha256 or
                type(value.get("page_count")) is not int or
                not 1 <= value["page_count"] <= 10000 or
                value.get("status") != ("INSPECTED" if mode == "inspect" else "SUBMITTED")):
            raise PilotPrintBlocked("WORD_WORKER_RESPONSE_INVALID")
        return value
    finally:
        try:
            response_path.unlink(missing_ok=True)
        except OSError:
            pass


def _assert_private_windows_acl(path: Path) -> None:
    """Fail closed unless ACL grants access only to service user/admin/system.

    The machine install must provision the directory first. Missing pywin32,
    a null DACL, or any other allowed principal blocks native I/O.
    """
    if os.name != "nt":
        return
    try:
        import win32api
        import win32con
        import win32security
        token = win32security.OpenProcessToken(
            win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
        current_sid = win32security.GetTokenInformation(
            token, win32security.TokenUser)[0]
        allowed_sids = [
            current_sid,
            win32security.CreateWellKnownSid(win32security.WinLocalSystemSid, None),
            win32security.CreateWellKnownSid(win32security.WinBuiltinAdministratorsSid, None),
        ]
        descriptor = win32security.GetNamedSecurityInfo(
            str(path), win32security.SE_FILE_OBJECT,
            win32security.DACL_SECURITY_INFORMATION)
        dacl = descriptor.GetSecurityDescriptorDacl()
        if dacl is None:
            raise PilotPrintBlocked("PRIVATE_PATH_NULL_DACL")
        for index in range(dacl.GetAceCount()):
            ace = dacl.GetAce(index)
            ace_type = ace[0][0]
            if ace_type == win32security.ACCESS_DENIED_ACE_TYPE:
                continue
            if ace_type != win32security.ACCESS_ALLOWED_ACE_TYPE:
                raise PilotPrintBlocked("PRIVATE_PATH_ACL_ACE_UNSUPPORTED")
            sid = ace[2]
            if not any(win32security.EqualSid(sid, allowed) for allowed in allowed_sids):
                raise PilotPrintBlocked("PRIVATE_PATH_ACL_TOO_BROAD")
    except PilotPrintBlocked:
        raise
    except Exception as exc:
        raise PilotPrintBlocked("PRIVATE_PATH_ACL_UNVERIFIED") from exc


class PilotJournal:
    """Durable per-job boundary. Stores hashes/IDs only; never raw code/bytes."""

    def __init__(self, filename: str | Path):
        self.filename = Path(filename)
        self.filename.parent.mkdir(parents=True, exist_ok=True)
        if self.filename.is_symlink() or self.filename.parent.is_symlink():
            raise PilotPrintBlocked("JOURNAL_REPARSE_PATH")
        if os.name == "nt":
            if not self.filename.is_absolute() or str(self.filename).startswith("\\\\"):
                raise PilotPrintBlocked("JOURNAL_MUST_BE_LOCAL_ABSOLUTE_PATH")
            _assert_private_windows_acl(self.filename.parent)
        elif self.filename.exists():
            if self.filename.stat().st_mode & 0o077:
                raise PilotPrintBlocked("JOURNAL_PERMISSIONS_TOO_BROAD")
        else:
            fd = os.open(self.filename, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
            os.close(fd)
        if self.filename.exists():
            _assert_private_windows_acl(self.filename)
        self.db = sqlite3.connect(str(self.filename), isolation_level=None, timeout=10)
        if os.name == "nt":
            _assert_private_windows_acl(self.filename)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS pilot_jobs ("
                        "job_id TEXT PRIMARY KEY, ticket_sha256 TEXT NOT NULL, "
                        "source_sha256 TEXT NOT NULL, settings_sha256 TEXT NOT NULL, "
                        "evidence_sha256 TEXT NOT NULL, printer_id TEXT NOT NULL, "
                        "revision INTEGER NOT NULL, state TEXT NOT NULL, evidence TEXT NOT NULL)")

    def get(self, job_id: str) -> dict[str, Any] | None:
        row = self.db.execute(
            "SELECT job_id,ticket_sha256,source_sha256,settings_sha256,evidence_sha256,"
            "printer_id,revision,state,evidence FROM pilot_jobs WHERE job_id=?",
            (job_id,)).fetchone()
        if row is None:
            return None
        return dict(zip(("job_id", "ticket_sha256", "source_sha256", "settings_sha256",
                         "evidence_sha256", "printer_id", "revision", "state", "evidence"), row))

    def begin(self, verified: VerifiedPilotSource) -> dict[str, Any] | None:
        """INSERT and fsync a unique send boundary; return any previous record."""
        self.db.execute("BEGIN IMMEDIATE")
        try:
            previous = self.get(verified.job_id)
            if previous:
                self.db.execute("COMMIT")
                return previous
            self.db.execute(
                "INSERT INTO pilot_jobs(job_id,ticket_sha256,source_sha256,settings_sha256,"
                "evidence_sha256,printer_id,revision,state,evidence) VALUES(?,?,?,?,?,?,?,?,?)",
                (verified.job_id, verified.ticket_sha256, verified.source_sha256,
                 verified.settings_sha256, verified.evidence_sha256, verified.printer_id,
                 verified.revision, "BOUNDARY", "{}"))
            self.db.execute("COMMIT")
            return None
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def state(self, job_id: str, value: str, evidence: dict[str, Any] | None = None) -> None:
        if self.get(job_id) is None:
            raise PilotPrintBlocked("JOURNAL_BOUNDARY_MISSING")
        self.db.execute("UPDATE pilot_jobs SET state=?,evidence=? WHERE job_id=?",
                        (value, json.dumps(evidence or {}, sort_keys=True), job_id))

    def unresolved(self) -> list[str]:
        rows = self.db.execute(
            "SELECT job_id FROM pilot_jobs WHERE state IN ('BOUNDARY','ARMED','DRIVER_CALLED')")
        return [row[0] for row in rows]

    def close(self) -> None:
        self.db.close()


@dataclass(frozen=True)
class PilotPrintWork:
    """Internal in-memory projection; never accept from OA/browser JSON."""

    job: dict[str, Any]
    candidate: dict[str, Any]
    authorization: dict[str, Any]
    source_bytes: bytes


class PilotBackendPort(Protocol):
    def claim(self) -> PilotPrintWork | None: ...
    def preflight(self, work: PilotPrintWork) -> dict[str, Any]: ...
    def mark_sending(self, work: PilotPrintWork) -> dict[str, Any]: ...
    def report(self, work: PilotPrintWork, state: str, evidence: dict[str, Any]) -> None: ...


class PreparedPrint(Protocol):
    page_count: int
    def close(self) -> None: ...


class NativePrinterPort(Protocol):
    def prepare(self, work: PilotPrintWork, verified: VerifiedPilotSource) -> PreparedPrint: ...
    def send(self, prepared: PreparedPrint, work: PilotPrintWork,
             verified: VerifiedPilotSource) -> dict[str, Any]: ...


def _close_prepared(prepared: PreparedPrint | None) -> None:
    if prepared is not None:
        try:
            prepared.close()
        except Exception:
            pass


def _server_binding_matches(value: object, verified: VerifiedPilotSource,
                            expected_state: str) -> bool:
    if not isinstance(value, dict):
        return False
    expected = {
        "state": expected_state,
        "job_id": verified.job_id,
        "order_id": verified.order_id,
        "revision": verified.revision,
        "request_hash": verified.request_hash,
        "source_sha256": verified.source_sha256,
        "settings_sha256": verified.settings_sha256,
        "evidence_sha256": verified.evidence_sha256,
        "printer_id": verified.printer_id,
    }
    return all(value.get(field) == expected_value for field, expected_value in expected.items())


class PilotPrintAgent:
    """Core-authorized pilot flow. DryRun is the safe default and never touches a printer."""

    def __init__(self, *, backend: PilotBackendPort, journal: PilotJournal,
                 printer: NativePrinterPort, configured_printer_id: str = "RMP7000",
                 dry_run: bool = True):
        self.backend = backend
        self.journal = journal
        self.printer = printer
        self.configured_printer_id = configured_printer_id
        if type(dry_run) is not bool:
            raise ValueError("PILOT_DRY_RUN_FLAG_INVALID")
        self.dry_run = dry_run

    def recover(self) -> list[str]:
        pending = self.journal.unresolved()
        for job_id in pending:
            self.journal.state(job_id, "UNKNOWN", {"reason": "restart_at_send_boundary"})
        return pending

    def run_once(self) -> dict[str, Any]:
        # A process restart must classify every unfinished side-effect boundary
        # before it asks Core for work again.
        self.recover()
        try:
            work = self.backend.claim()
        except Exception:
            return {"status": "UNKNOWN", "reason": "CLAIM_AMBIGUOUS"}
        if work is None:
            return {"status": "NO_JOB"}
        if not isinstance(work, PilotPrintWork):
            return {"status": "BLOCKED", "reason": "PILOT_TICKET_NOT_CORE_ADAPTER_OBJECT"}
        mode = work.job.get("mode")
        if (type(mode) is not str or
                mode not in {"simulation", "controlled_test", "production"}):
            return {"status": "BLOCKED", "job_id": work.job.get("job_id"),
                    "reason": "PILOT_MODE_UNVERIFIED"}
        if self.dry_run and mode != "simulation":
            return {"status": "BLOCKED", "job_id": work.job.get("job_id"),
                    "reason": "PILOT_DRY_RUN_REQUIRES_SIMULATION_JOB"}
        if not self.dry_run and mode == "simulation":
            return {"status": "BLOCKED", "job_id": work.job.get("job_id"),
                    "reason": "PILOT_SIMULATION_JOB_CANNOT_PRINT"}
        try:
            verified = verify_pilot_source_ticket(
                job=work.job, candidate=work.candidate,
                authorization=work.authorization, source_bytes=work.source_bytes,
                configured_printer_id=self.configured_printer_id)
        except PilotTicketInvalid as exc:
            return {"status": "BLOCKED", "job_id": work.job.get("job_id"),
                    "reason": str(exc)}
        except Exception:
            return {"status": "BLOCKED", "job_id": work.job.get("job_id"),
                    "reason": "PILOT_SOURCE_OR_JOB_UNVERIFIED"}

        previous = self.journal.get(verified.job_id)
        if previous is not None:
            if previous["ticket_sha256"] != verified.ticket_sha256:
                return {"status": "UNKNOWN", "job_id": verified.job_id,
                        "reason": "JOURNAL_TICKET_CHANGED_NO_RESEND"}
            state = previous["state"]
            try:
                self.backend.report(work, state, json.loads(previous["evidence"]))
            except Exception:
                return {"status": state, "job_id": verified.job_id, "report_pending": True}
            return {"status": state, "job_id": verified.job_id, "reconciled": True}

        if self.dry_run:
            return self._run_dry_run(work, verified)

        prepared: PreparedPrint | None = None
        try:
            # Native inspection is preflight only; the driver is reached later.
            prepared = self.printer.prepare(work, verified)
            if type(prepared.page_count) is not int or prepared.page_count < 1:
                _close_prepared(prepared)
                return {"status": "BLOCKED", "job_id": verified.job_id,
                        "reason": "DOCUMENT_PAGE_COUNT_UNVERIFIED"}
            sheets = ((prepared.page_count + 1) // 2 if verified.settings["duplex"]
                      else prepared.page_count) * verified.settings["copies"]
            if sheets > MAX_PHYSICAL_SHEETS:
                _close_prepared(prepared)
                return {"status": "BLOCKED", "job_id": verified.job_id,
                        "reason": "PILOT_PHYSICAL_SHEET_LIMIT"}
            preflight = self.backend.preflight(work)
            if not _server_binding_matches(preflight, verified, "AUTHORIZED"):
                _close_prepared(prepared)
                return {"status": "BLOCKED", "job_id": verified.job_id,
                        "reason": "CORE_PILOT_PREFLIGHT_DENIED"}
        except PilotPrintBlocked as exc:
            _close_prepared(prepared)
            return {"status": "BLOCKED", "job_id": verified.job_id,
                    "reason": str(exc)}
        except Exception:
            _close_prepared(prepared)
            return {"status": "UNKNOWN", "job_id": verified.job_id,
                    "reason": "PILOT_PREFLIGHT_AMBIGUOUS"}

        try:
            previous = self.journal.begin(verified)
        except Exception:
            _close_prepared(prepared)
            return {"status": "UNKNOWN", "job_id": verified.job_id,
                    "reason": "JOURNAL_BOUNDARY_AMBIGUOUS"}
        if previous is not None:
            _close_prepared(prepared)
            return {"status": "UNKNOWN", "job_id": verified.job_id,
                    "reason": "JOURNAL_ALREADY_CONTAINS_JOB_NO_RESEND"}
        try:
            marked = self.backend.mark_sending(work)
            if not _server_binding_matches(marked, verified, "SENDING"):
                raise PilotPrintBlocked("CORE_MARK_SENDING_NOT_CONFIRMED")
        except Exception:
            try:
                self.journal.state(verified.job_id, "UNKNOWN",
                                   {"reason": "CORE_SEND_ACK_AMBIGUOUS"})
            except Exception:
                pass
            _close_prepared(prepared)
            return {"status": "UNKNOWN", "job_id": verified.job_id,
                    "reason": "CORE_SEND_ACK_AMBIGUOUS"}

        try:
            self.journal.state(verified.job_id, "ARMED")
            self.journal.state(verified.job_id, "DRIVER_CALLED")
        except Exception:
            # A failed/ambiguous durable write must stop before native I/O.
            _close_prepared(prepared)
            try:
                self.journal.state(verified.job_id, "UNKNOWN",
                                   {"reason": "JOURNAL_DRIVER_BOUNDARY_AMBIGUOUS"})
            except Exception:
                pass
            return {"status": "UNKNOWN", "job_id": verified.job_id,
                    "reason": "JOURNAL_DRIVER_BOUNDARY_AMBIGUOUS"}
        try:
            result = self.printer.send(prepared, work, verified)
            expected_app = "WINWORD" if verified.source_format == "DOCX" else "SUMATRA_PDF"
            if (not isinstance(result, dict) or result.get("accepted") is not True or
                    result.get("native_app") != expected_app):
                raise PilotPrintBlocked("NATIVE_DRIVER_RESULT_UNCERTAIN")
            evidence = {
                "kind": "native_application_submission_unverified",
                "paper_verified": False,
                "native_app": result["native_app"],
            }
            if verified.source_format == "DOCX":
                if (type(result.get("word_worker_exit_code")) is not int or
                        result["word_worker_exit_code"] != 0):
                    raise PilotPrintBlocked("NATIVE_DRIVER_RESULT_UNCERTAIN")
                evidence["word_worker_exit_code"] = result["word_worker_exit_code"]
            else:
                if (type(result.get("native_app_exit_code")) is not int or
                        result["native_app_exit_code"] != 0):
                    raise PilotPrintBlocked("NATIVE_DRIVER_RESULT_UNCERTAIN")
                evidence["native_app_exit_code"] = result["native_app_exit_code"]
            state = "SENT_UNVERIFIED"
        except Exception:
            evidence = {"kind": "agent_uncertain", "reason": "NATIVE_SEND_AMBIGUOUS",
                        "paper_verified": False}
            state = "UNKNOWN"
        finally:
            try:
                prepared.close()
            except Exception:
                # Closing Word after PrintOut cannot prove the send did not happen.
                pass
        self.journal.state(verified.job_id, state, evidence)
        try:
            self.backend.report(work, state, evidence)
        except Exception:
            return {"status": state, "job_id": verified.job_id, "report_pending": True}
        return {"status": state, "job_id": verified.job_id, "evidence": evidence}

    def _run_dry_run(self, work: PilotPrintWork,
                     verified: VerifiedPilotSource) -> dict[str, Any]:
        """Exercise Core's pilot gates without preparing or calling a native printer."""
        try:
            preflight = self.backend.preflight(work)
            if not _server_binding_matches(preflight, verified, "AUTHORIZED"):
                return {"status": "BLOCKED", "job_id": verified.job_id,
                        "reason": "CORE_PILOT_PREFLIGHT_DENIED"}
        except PilotPrintBlocked as exc:
            return {"status": "BLOCKED", "job_id": verified.job_id,
                    "reason": str(exc)}
        except Exception:
            return {"status": "UNKNOWN", "job_id": verified.job_id,
                    "reason": "PILOT_PREFLIGHT_AMBIGUOUS"}

        try:
            previous = self.journal.begin(verified)
        except Exception:
            return {"status": "UNKNOWN", "job_id": verified.job_id,
                    "reason": "JOURNAL_BOUNDARY_AMBIGUOUS"}
        if previous is not None:
            return {"status": "UNKNOWN", "job_id": verified.job_id,
                    "reason": "JOURNAL_ALREADY_CONTAINS_JOB_NO_RESEND"}

        try:
            marked = self.backend.mark_sending(work)
            if not _server_binding_matches(marked, verified, "SENDING"):
                raise PilotPrintBlocked("CORE_MARK_SENDING_NOT_CONFIRMED")
        except Exception:
            try:
                self.journal.state(verified.job_id, "UNKNOWN",
                                   {"reason": "CORE_SEND_ACK_AMBIGUOUS"})
            except Exception:
                pass
            return {"status": "UNKNOWN", "job_id": verified.job_id,
                    "reason": "CORE_SEND_ACK_AMBIGUOUS"}

        evidence = {"driver_called": False, "spooler_ack": False,
                    "reason_code": "PILOT_DRY_RUN"}
        try:
            self.journal.state(verified.job_id, "SIMULATED_DONE", evidence)
        except Exception:
            try:
                self.journal.state(verified.job_id, "UNKNOWN",
                                   {"reason": "JOURNAL_SIMULATION_RESULT_AMBIGUOUS"})
            except Exception:
                pass
            return {"status": "UNKNOWN", "job_id": verified.job_id,
                    "reason": "JOURNAL_SIMULATION_RESULT_AMBIGUOUS"}
        try:
            self.backend.report(work, "SIMULATED_DONE", evidence)
        except Exception:
            return {"status": "SIMULATED_DONE", "job_id": verified.job_id,
                    "driver_called": False, "report_pending": True}
        return {"status": "SIMULATED_DONE", "job_id": verified.job_id,
                "driver_called": False, "evidence": evidence}


@dataclass(frozen=True)
class WindowsPrinterProfile:
    """Privileged local mapping for the Core printer_id; never sourced from job JSON."""

    printer_id: str
    queue_name: str
    driver_name: str
    port_name: str
    expected_model_fragment: str = "IM7000"


@dataclass
class _PreparedNativePrint:
    source_path: Path
    page_count: int

    def close(self) -> None:
        try:
            self.source_path.unlink(missing_ok=True)
        except Exception:
            pass


class WindowsNativePrinter:
    """Word COM for DOCX; pinned SumatraPDF for original PDF; no default queue."""

    def __init__(self, *, private_root: str | Path, profile: WindowsPrinterProfile,
                 sumatra_exe: str | Path, sumatra_sha256: str,
                 timeout_seconds: int = PRINT_TIMEOUT_SECONDS):
        self.private_root = Path(private_root)
        self.profile = profile
        self.sumatra_exe = Path(sumatra_exe)
        self.sumatra_sha256 = sumatra_sha256
        self.timeout_seconds = timeout_seconds
        if profile.printer_id != "RMP7000":
            # The pilot currently has one configured printer identity.
            raise PilotPrintBlocked("PILOT_PRINTER_ID_UNSUPPORTED")
        if not HEX.fullmatch(sumatra_sha256):
            raise PilotPrintBlocked("PDF_RENDERER_HASH_INVALID")
        if not 1 <= timeout_seconds <= 120:
            raise PilotPrintBlocked("NATIVE_PRINT_TIMEOUT_INVALID")

    def _assert_windows(self) -> None:
        if os.name != "nt":
            raise PilotPrintBlocked("WINDOWS_NATIVE_PRINT_NOT_AVAILABLE")
        if (not self.private_root.is_absolute() or
                str(self.private_root).startswith("\\\\") or
                not self.private_root.exists() or self.private_root.is_symlink()):
            raise PilotPrintBlocked("PRIVATE_SPOOL_ROOT_UNAVAILABLE")
        _assert_private_windows_acl(self.private_root)

    def _assert_printer(self, expected_printer_id: str) -> None:
        if expected_printer_id != self.profile.printer_id:
            raise PilotPrintBlocked("PILOT_PRINTER_ID_MISMATCH")
        try:
            import win32print
            handle = win32print.OpenPrinter(self.profile.queue_name)
            try:
                current = win32print.GetPrinter(handle, 2)
            finally:
                win32print.ClosePrinter(handle)
        except Exception as exc:
            raise PilotPrintBlocked("PILOT_PRINTER_INVENTORY_UNAVAILABLE") from exc
        if (current.get("pPrinterName") != self.profile.queue_name or
                current.get("pDriverName") != self.profile.driver_name or
                current.get("pPortName") != self.profile.port_name or
                self.profile.expected_model_fragment.casefold() not in
                " ".join(str(current.get(key) or "") for key in
                         ("pPrinterName", "pDriverName", "pComment")).casefold()):
            raise PilotPrintBlocked("PILOT_PRINTER_QUEUE_DRIVER_CHANGED")

    def prepare(self, work: PilotPrintWork,
                verified: VerifiedPilotSource) -> _PreparedNativePrint:
        self._assert_windows()
        self._assert_printer(verified.printer_id)
        if verified.source_format == "PDF":
            if (not self.sumatra_exe.is_absolute() or self.sumatra_exe.is_symlink() or
                    not self.sumatra_exe.is_file()):
                raise PilotPrintBlocked("PDF_NATIVE_RENDERER_UNAVAILABLE")
            if _sha(self.sumatra_exe.read_bytes()) != self.sumatra_sha256:
                raise PilotPrintBlocked("PDF_NATIVE_RENDERER_CHANGED")
            import fitz
            with fitz.open(stream=verified.source_bytes, filetype="pdf") as document:
                page_count = document.page_count
            extension = ".pdf"
        else:
            # Word opens only a private byte-for-byte snapshot in a bounded
            # child process. It never converts the DOCX to another format.
            page_count = 0
            extension = ".docx"
        fd, name = tempfile.mkstemp(prefix="autoin-pilot-", suffix=extension,
                                    dir=self.private_root)
        source_path = Path(name)
        try:
            with os.fdopen(fd, "wb") as output:
                output.write(verified.source_bytes)
                output.flush()
                os.fsync(output.fileno())
            _assert_private_windows_acl(source_path)
            if _sha(source_path.read_bytes()) != verified.source_sha256:
                raise PilotPrintBlocked("PRIVATE_SOURCE_SNAPSHOT_CHANGED")
            if verified.source_format == "PDF":
                return _PreparedNativePrint(source_path=source_path, page_count=page_count)
            result = _run_word_worker(
                source_path=source_path, source_sha256=verified.source_sha256,
                mode="inspect", timeout_seconds=self.timeout_seconds)
            return _PreparedNativePrint(source_path=source_path,
                                        page_count=result["page_count"])
        except Exception:
            source_path.unlink(missing_ok=True)
            raise

    def send(self, prepared: _PreparedNativePrint, work: PilotPrintWork,
             verified: VerifiedPilotSource) -> dict[str, Any]:
        self._assert_windows()
        self._assert_printer(verified.printer_id)
        if _sha(prepared.source_path.read_bytes()) != verified.source_sha256:
            raise PilotPrintBlocked("PRIVATE_SOURCE_SNAPSHOT_CHANGED")
        with _ExclusivePrinterLock(self.profile.printer_id):
            with _PerUserPrinterSettings(self.profile.queue_name, verified.settings):
                if verified.source_format == "DOCX":
                    # A fresh Word process reopens exactly the same DOCX bytes,
                    # checks page count against preflight, and calls PrintOut.
                    result = _run_word_worker(
                        source_path=prepared.source_path,
                        source_sha256=verified.source_sha256, mode="print",
                        timeout_seconds=self.timeout_seconds,
                        printer_name=self.profile.queue_name,
                        copies=verified.settings["copies"],
                        expected_page_count=prepared.page_count)
                    return {"accepted": True, "native_app": "WINWORD",
                            "word_worker_exit_code": 0,
                            "word_page_count": result["page_count"]}
                else:
                    settings = [f"{verified.settings['copies']}x", "paper=A4",
                                "monochrome", "shrink", "ignore-pdf-print-settings",
                                "duplexlong" if verified.settings["duplex"] else "simplex"]
                    command = [str(self.sumatra_exe), "-print-to", self.profile.queue_name,
                               "-print-settings", ",".join(settings), "-silent",
                               str(prepared.source_path)]
                    exit_code = _wait_native_process(command, self.timeout_seconds)
                    if exit_code != 0:
                        raise PilotPrintBlocked("PDF_NATIVE_SEND_UNCONFIRMED")
                    return {"accepted": True, "native_app": "SUMATRA_PDF",
                            "native_app_exit_code": exit_code}
        # Native-app return is not proof of spooler acceptance or paper output.
        return {"accepted": False}


class _PerUserPrinterSettings(AbstractContextManager):
    """Temporarily apply supported job settings to the dedicated agent queue."""

    def __init__(self, queue_name: str, settings: dict[str, Any]):
        self.queue_name = queue_name
        self.settings = settings
        self.handle = None
        self.original = None
        self.win32print = None

    def __enter__(self):
        if os.name != "nt":
            raise PilotPrintBlocked("WINDOWS_PRINTER_SETTINGS_UNAVAILABLE")
        try:
            import win32con
            import win32print
            self.win32print = win32print
            self.handle = win32print.OpenPrinter(self.queue_name)
            # PRINTER_INFO_9 is per-user. Level 8 changes global defaults and
            # could affect other users of this Windows print queue.
            self.original = deepcopy(win32print.GetPrinter(self.handle, 9))
            current = deepcopy(self.original)
            devmode = current.get("pDevMode")
            if devmode is None:
                raise PilotPrintBlocked("PRINTER_DEVMODE_UNAVAILABLE")
            devmode.Fields |= (win32con.DM_PAPERSIZE | win32con.DM_COLOR |
                               win32con.DM_DUPLEX)
            devmode.PaperSize = win32con.DMPAPER_A4
            devmode.Color = win32con.DMCOLOR_MONOCHROME
            # Pilot wire v0.1 has a boolean duplex field; long-edge is the
            # fixed A4 document policy until the shared contract adds a binding field.
            devmode.Duplex = (win32con.DMDUP_VERTICAL if self.settings["duplex"]
                              else win32con.DMDUP_SIMPLEX)
            win32print.SetPrinter(self.handle, 9, current, 0)
            applied = win32print.GetPrinter(self.handle, 9).get("pDevMode")
            expected_duplex = (win32con.DMDUP_VERTICAL if self.settings["duplex"]
                               else win32con.DMDUP_SIMPLEX)
            if (applied is None or applied.PaperSize != win32con.DMPAPER_A4 or
                    applied.Color != win32con.DMCOLOR_MONOCHROME or
                    applied.Duplex != expected_duplex):
                raise PilotPrintBlocked("PRINTER_DEVMODE_SETTINGS_UNVERIFIED")
            return self
        except PilotPrintBlocked:
            self.__exit__(None, None, None)
            raise
        except Exception as exc:
            self.__exit__(None, None, None)
            raise PilotPrintBlocked("PRINTER_DEVMODE_SETTINGS_FAILED") from exc

    def __exit__(self, *_args):
        try:
            if self.handle is not None and self.original is not None:
                self.win32print.SetPrinter(self.handle, 9, self.original, 0)
        finally:
            if self.handle is not None:
                self.win32print.ClosePrinter(self.handle)
                self.handle = None
        return False


class _ExclusivePrinterLock(AbstractContextManager):
    """Serialize AI3 processes targeting the dedicated printer queue."""

    def __init__(self, printer_id: str):
        self.printer_id = printer_id
        self.handle = None

    def __enter__(self):
        if os.name != "nt":
            raise PilotPrintBlocked("WINDOWS_PRINTER_LOCK_UNAVAILABLE")
        import win32event
        import win32con
        import win32api
        name = "Global\\AUTO-IN-Pilot-" + self.printer_id
        self.handle = win32event.CreateMutex(None, False, name)
        result = win32event.WaitForSingleObject(self.handle, 30000)
        if result not in (win32con.WAIT_OBJECT_0, win32con.WAIT_ABANDONED):
            win32api.CloseHandle(self.handle)
            self.handle = None
            raise PilotPrintBlocked("PRINTER_LOCK_UNAVAILABLE")
        self._win32event = win32event
        import win32api as _win32api
        self._win32api = _win32api
        return self

    def __exit__(self, *_args):
        if self.handle is not None:
            try:
                self._win32event.ReleaseMutex(self.handle)
            finally:
                self._win32api.CloseHandle(self.handle)
                self.handle = None
        return False
