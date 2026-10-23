"""Simulation tests using the exact public DOCX/PDF assets from AI5 PR #165."""
from __future__ import annotations

import hashlib
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

from agents.windows.pilot_native_print import (
    PilotJournal, PilotPrintAgent, PilotPrintBlocked, PilotPrintWork,
    WindowsNativePrinter, WindowsPrinterProfile, _PreparedNativePrint,
    _PerUserPrinterSettings, _ExclusivePrinterLock, _wait_native_process,
)
from agents.windows.pilot_word_print_worker import execute_word_job
from agents.windows import pilot_native_print as native_module
from workers.documents.bridge import _canonical
from workers.documents.pilot_source_ticket import PilotTicketInvalid, verify_pilot_source_ticket

ROOT = Path(__file__).resolve().parent / "fixtures" / "pilot-word-pdf"
PUBLIC_FILES = {
    "PDF": ROOT / "public-one-page.pdf",
    "DOCX": ROOT / "public-one-page.docx",
}
EXPECTED_SHA256 = {
    "PDF": "75ff2ebf9db02e33aa38619578e0744769babf68edef8c7045f86f1f365f5910",
    "DOCX": "5c8a1c98a0f3d1117b7f5b2b630609b2b67eadd26be9df24bb62b41a1962f81e",
}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def make_work(file_format: str = "PDF", *, duplex: bool = False) -> PilotPrintWork:
    source_bytes = PUBLIC_FILES[file_format].read_bytes()
    source_sha = sha(source_bytes)
    settings = {"copies": 1, "duplex": duplex, "paper": "A4", "color": "black_white"}
    settings_sha = sha(_canonical(settings).encode("utf-8"))
    candidate = {
        "shop_id": "pilot-shop-public-test",
        "oa_id": "oa-public-test",
        "customer_id": "customer-public-test",
        "conversation_id": "conversation-public-test",
        "intake_batch_id": "intake-public-test",
        "order_id": "order-public-test",
        "revision": 1,
        "request_hash": "1" * 64,
        "source": {
            "format": file_format,
            "artifact_ref": f"public/pilot/{PUBLIC_FILES[file_format].name}",
            "sha256": source_sha,
            "size_bytes": len(source_bytes),
            "provider_event_id": "file-event-public-test",
        },
        "settings": settings,
        "settings_sha256": settings_sha,
        "printer_id": "RMP7000",
    }
    authorization = {
        "schema": "ai0.pilot_print_authorization.v1",
        "shop_id": candidate["shop_id"],
        "oa_id": candidate["oa_id"],
        "customer_id": candidate["customer_id"],
        "intake_batch_id": candidate["intake_batch_id"],
        "order_id": candidate["order_id"],
        "revision": 1,
        "request_hash": candidate["request_hash"],
        "source_sha256": source_sha,
        "settings_sha256": settings_sha,
        "evidence_sha256": "e" * 64,
        "printer_id": "RMP7000",
        "code_window_id": "window-public-test",
        "provider_event_id": "code-event-public-test",
        "authorized_at": "2026-10-21T12:00:00+07:00",
        "job_id": "job-public-test",
    }
    job = {
        "job_id": "job-public-test",
        "order_id": "order-public-test",
        "revision": 1,
        "request_hash": candidate["request_hash"],
        "printer_id": "RMP7000",
        "lease_token": "synthetic-public-test-lease",
        "mode": "controlled_test",
    }
    return PilotPrintWork(job, candidate, authorization, source_bytes)


class FakeBackend:
    def __init__(self, work: PilotPrintWork):
        self.work = work
        self.preflight_state = "AUTHORIZED"
        self.mark_state = "SENDING"
        self.mark_raises = False
        self.reports = []

    def claim(self):
        return self.work

    def _ack(self, state):
        a = self.work.authorization
        c = self.work.candidate
        return {
            "state": state, "job_id": self.work.job["job_id"],
            "order_id": self.work.job["order_id"], "revision": self.work.job["revision"],
            "request_hash": self.work.job["request_hash"],
            "source_sha256": c["source"]["sha256"],
            "settings_sha256": c["settings_sha256"],
            "evidence_sha256": a["evidence_sha256"],
            "printer_id": self.work.job["printer_id"],
        }

    def preflight(self, _work):
        return self._ack(self.preflight_state)

    def mark_sending(self, _work):
        if self.mark_raises:
            raise TimeoutError("synthetic mark ACK timeout")
        return self._ack(self.mark_state)

    def report(self, _work, state, evidence):
        self.reports.append((state, evidence))


class FakePrepared:
    page_count = 1

    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class FakeNativePrinter:
    def __init__(self, *, fail_send=False, spooler_ack=True):
        self.prepare_calls = []
        self.send_calls = []
        self.fail_send = fail_send
        self.spooler_ack = spooler_ack
        self.prepared = FakePrepared()

    def prepare(self, work, verified):
        self.prepare_calls.append((verified.source_format, sha(work.source_bytes)))
        return self.prepared

    def send(self, _prepared, _work, verified):
        self.send_calls.append((verified.source_format, verified.source_sha256))
        if self.fail_send:
            raise TimeoutError("synthetic native driver ACK lost")
        result = {"accepted": True, "native_app": "WINWORD"
                  if verified.source_format == "DOCX" else "SUMATRA_PDF"}
        result["spooler_ack"] = self.spooler_ack
        result["word_worker_exit_code" if verified.source_format == "DOCX"
               else "native_app_exit_code"] = 0
        return result


class SimulatedProcessCrash(BaseException):
    """A hard process stop bypassing the agent's ordinary exception handler."""


class CrashAfterDriverBoundaryJournal(PilotJournal):
    def __init__(self, filename):
        super().__init__(filename)
        self.crashed = False

    def state(self, job_id, value, evidence=None):
        super().state(job_id, value, evidence)
        if value == "DRIVER_CALLED" and not self.crashed:
            self.crashed = True
            raise SimulatedProcessCrash()


class CrashAfterNativeCallPrinter(FakeNativePrinter):
    def send(self, _prepared, _work, verified):
        self.send_calls.append((verified.source_format, verified.source_sha256))
        raise SimulatedProcessCrash()


class PilotNativePrintTests(unittest.TestCase):
    def make_agent(self, folder, work, backend=None, printer=None):
        backend = backend or FakeBackend(work)
        printer = printer or FakeNativePrinter()
        journal = PilotJournal(Path(folder) / "pilot.sqlite")
        return PilotPrintAgent(backend=backend, journal=journal, printer=printer,
                              dry_run=False, configured_shop_id="pilot-shop-public-test",
                              configured_order_id="order-public-test"), journal, backend, printer

    def test_native_scope_and_mode_stop_before_preflight_and_driver(self):
        for mode, local_shop, order_id, reason in (
            ("production", "pilot-shop-public-test", "order-public-test",
             "PILOT_NATIVE_REQUIRES_CONTROLLED_TEST"),
            ("controlled_test", "other-shop", "order-public-test",
             "PILOT_NATIVE_LOCAL_SCOPE_MISMATCH"),
            ("controlled_test", "pilot-shop-public-test", "other-order",
             "PILOT_NATIVE_LOCAL_SCOPE_MISMATCH"),
        ):
            with self.subTest(mode=mode, shop=local_shop, order_id=order_id), tempfile.TemporaryDirectory() as folder:
                work = make_work()
                work.job["mode"] = mode
                backend = FakeBackend(work)
                printer = FakeNativePrinter()
                journal = PilotJournal(Path(folder) / "pilot.sqlite")
                agent = PilotPrintAgent(backend=backend, journal=journal, printer=printer,
                                        dry_run=False, configured_shop_id=local_shop,
                                        configured_order_id=order_id)
                result = agent.run_once()
                self.assertEqual((result["status"], result["reason"]), ("BLOCKED", reason))
                self.assertEqual(printer.prepare_calls, [])
                self.assertEqual(printer.send_calls, [])
                self.assertIsNone(journal.get(work.job["job_id"]))
                journal.close()

    def test_pr165_public_fixtures_match_manifest_hashes(self):
        for file_format, path in PUBLIC_FILES.items():
            with self.subTest(file_format=file_format):
                self.assertEqual(sha(path.read_bytes()), EXPECTED_SHA256[file_format])

    def test_exact_public_docx_and_pdf_bytes_bind_to_core_authorization(self):
        for file_format in ("PDF", "DOCX"):
            with self.subTest(file_format=file_format):
                work = make_work(file_format)
                verified = verify_pilot_source_ticket(
                    job=work.job, candidate=work.candidate,
                    authorization=work.authorization, source_bytes=work.source_bytes,
                    configured_printer_id="RMP7000")
                self.assertEqual(verified.source_format, file_format)
                self.assertEqual(verified.source_sha256, EXPECTED_SHA256[file_format])
                self.assertEqual(verified.source_bytes, work.source_bytes)
                self.assertEqual(verified.settings_sha256, work.candidate["settings_sha256"])
                self.assertEqual(verified.job_id, work.authorization["job_id"])
                self.assertEqual(verified.printer_id, "RMP7000")

    def test_file_and_code_event_roles_cannot_collide_before_journal_or_driver(self):
        work = make_work()
        self.assertNotEqual(work.candidate["source"]["provider_event_id"],
                            work.authorization["provider_event_id"])
        tampered = replace(work, authorization={
            **work.authorization,
            "provider_event_id": work.candidate["source"]["provider_event_id"]})
        with self.assertRaisesRegex(PilotTicketInvalid, "PILOT_PROVIDER_EVENT_ROLE_COLLISION"):
            verify_pilot_source_ticket(
                job=tampered.job, candidate=tampered.candidate,
                authorization=tampered.authorization, source_bytes=tampered.source_bytes,
                configured_printer_id="RMP7000")
        with tempfile.TemporaryDirectory() as folder:
            agent, journal, _backend, printer = self.make_agent(folder, tampered)
            result = agent.run_once()
            self.assertEqual(result["status"], "BLOCKED")
            self.assertEqual(result["reason"], "PILOT_PROVIDER_EVENT_ROLE_COLLISION")
            self.assertIsNone(journal.get(work.job["job_id"]))
            self.assertEqual(printer.prepare_calls, [])
            self.assertEqual(printer.send_calls, [])
            journal.close()

    def test_source_hash_job_settings_and_printer_mismatch_block_before_driver(self):
        mutations = (
            lambda w: replace(w, source_bytes=w.source_bytes + b"changed"),
            lambda w: replace(w, job={**w.job, "job_id": "other-job"}),
            lambda w: replace(w, candidate={**w.candidate,
                "settings": {**w.candidate["settings"], "copies": 2}}),
            lambda w: replace(w, candidate={**w.candidate, "printer_id": "OTHER-PRINTER"}),
        )
        for index, mutate in enumerate(mutations):
            with self.subTest(mutation=index), tempfile.TemporaryDirectory() as folder:
                work = mutate(make_work())
                agent, journal, _backend, printer = self.make_agent(folder, work)
                result = agent.run_once()
                self.assertEqual(result["status"], "BLOCKED")
                self.assertEqual(printer.prepare_calls, [])
                self.assertEqual(printer.send_calls, [])
                self.assertIsNone(journal.get("job-public-test"))
                journal.close()

    def test_missing_or_unreadable_source_blocks_before_native_preparation(self):
        valid = make_work("DOCX")
        bad_bytes = b""
        bad_sha = sha(bad_bytes)
        candidate = {**valid.candidate, "source": {
            **valid.candidate["source"], "sha256": bad_sha, "size_bytes": len(bad_bytes)}}
        authorization = {**valid.authorization, "source_sha256": bad_sha}
        mutations = (
            replace(valid, source_bytes=bad_bytes, candidate=candidate,
                    authorization=authorization),
            replace(valid, source_bytes=b"not-a-docx", candidate={**candidate, "source": {
                **candidate["source"], "sha256": sha(b"not-a-docx"),
                "size_bytes": len(b"not-a-docx")}}, authorization={
                    **authorization, "source_sha256": sha(b"not-a-docx")}))
        for index, work in enumerate(mutations):
            with self.subTest(source=index), tempfile.TemporaryDirectory() as folder:
                agent, journal, _backend, printer = self.make_agent(folder, work)
                result = agent.run_once()
                self.assertEqual(result["status"], "BLOCKED")
                self.assertEqual(printer.prepare_calls, [])
                self.assertEqual(printer.send_calls, [])
                self.assertIsNone(journal.get("job-public-test"))
                journal.close()

    def test_locked_duplex_true_means_a4_long_edge(self):
        with tempfile.TemporaryDirectory() as folder:
            work = make_work("DOCX", duplex=True)
            agent, journal, _backend, printer = self.make_agent(folder, work)
            result = agent.run_once()
            self.assertEqual(result["status"], "SENT_UNVERIFIED")
            self.assertEqual(printer.prepare_calls,
                             [("DOCX", EXPECTED_SHA256["DOCX"])])
            self.assertEqual(printer.send_calls,
                             [("DOCX", EXPECTED_SHA256["DOCX"])])
            self.assertEqual(journal.get("job-public-test")["state"], "SENT_UNVERIFIED")
            journal.close()

    def test_preflight_mismatch_never_calls_native_driver(self):
        with tempfile.TemporaryDirectory() as folder:
            work = make_work()
            backend = FakeBackend(work)
            backend.preflight_state = "NEEDS_HUMAN"
            agent, journal, _backend, printer = self.make_agent(folder, work, backend=backend)
            self.assertEqual(agent.run_once()["status"], "BLOCKED")
            self.assertEqual(printer.send_calls, [])
            self.assertIsNone(journal.get("job-public-test"))
            journal.close()

    def test_raw_shop_code_and_legacy_approval_ticket_are_rejected(self):
        mutations = (
            lambda work: replace(work, candidate={**work.candidate, "code": "123456"}),
            lambda work: replace(work, job={**work.job, "approval_id": "old-staff-flow"}),
        )
        for mutation in mutations:
            with tempfile.TemporaryDirectory() as folder:
                work = mutation(make_work())
                agent, journal, _backend, printer = self.make_agent(folder, work)
                self.assertEqual(agent.run_once()["status"], "BLOCKED")
                self.assertEqual(printer.send_calls, [])
                self.assertIsNone(journal.get("job-public-test"))
                journal.close()

    def test_mark_sending_ack_timeout_is_unknown_and_never_calls_driver(self):
        with tempfile.TemporaryDirectory() as folder:
            work = make_work()
            backend = FakeBackend(work)
            backend.mark_raises = True
            agent, journal, _backend, printer = self.make_agent(folder, work, backend=backend)
            result = agent.run_once()
            self.assertEqual(result["status"], "UNKNOWN")
            self.assertEqual(printer.send_calls, [])
            self.assertEqual(journal.get("job-public-test")["state"], "UNKNOWN")
            journal.close()

    def test_success_is_sent_unverified_and_duplicate_never_resends(self):
        with tempfile.TemporaryDirectory() as folder:
            work = make_work("PDF")
            agent, journal, backend, printer = self.make_agent(folder, work)
            first = agent.run_once()
            self.assertEqual(first["status"], "SENT_UNVERIFIED")
            self.assertEqual(first["evidence"], {"driver_called": True, "spooler_ack": True,
                                                  "reason_code": "SPOOLER_ACCEPTED_UNVERIFIED"})
            self.assertEqual(printer.send_calls, [("PDF", EXPECTED_SHA256["PDF"])])
            self.assertEqual(journal.get("job-public-test")["state"], "SENT_UNVERIFIED")
            journal.close()

            reopened = PilotJournal(Path(folder) / "pilot.sqlite")
            repeated = PilotPrintAgent(backend=backend, journal=reopened, printer=printer,
                                       dry_run=False, configured_shop_id="pilot-shop-public-test",
                                       configured_order_id="order-public-test")
            again = repeated.run_once()
            self.assertEqual(again["status"], "SENT_UNVERIFIED")
            self.assertTrue(again["reconciled"])
            self.assertEqual(len(printer.send_calls), 1)
            reopened.close()

    def test_native_app_return_without_spooler_ack_is_unknown_and_not_retried(self):
        with tempfile.TemporaryDirectory() as folder:
            work = make_work("PDF")
            backend = FakeBackend(work)
            printer = FakeNativePrinter(spooler_ack=False)
            agent, journal, _backend, _printer = self.make_agent(folder, work,
                                                                  backend=backend,
                                                                  printer=printer)
            first = agent.run_once()
            self.assertEqual(first["status"], "UNKNOWN")
            self.assertEqual(first["evidence"], {"driver_called": True,
                                                  "spooler_ack": False,
                                                  "reason_code": "SPOOLER_ACK_UNAVAILABLE"})
            journal.close()

            reopened = PilotJournal(Path(folder) / "pilot.sqlite")
            restarted = PilotPrintAgent(backend=backend, journal=reopened, printer=printer,
                                        dry_run=False,
                                        configured_shop_id="pilot-shop-public-test",
                                        configured_order_id="order-public-test")
            self.assertEqual(restarted.run_once()["status"], "UNKNOWN")
            self.assertEqual(len(printer.send_calls), 1)
            self.assertEqual(backend.reports[-1][1], first["evidence"])
            reopened.close()

    def test_pilot_dry_run_reports_simulated_done_without_native_calls(self):
        class DisabledNativePrinter:
            def prepare(self, *_args, **_kwargs):
                raise AssertionError("DryRun must not inspect with Word or a printer")

            def send(self, *_args, **_kwargs):
                raise AssertionError("DryRun must not call the native printer")

        work = make_work()
        work.job["mode"] = "simulation"
        backend = FakeBackend(work)
        with tempfile.TemporaryDirectory() as folder:
            journal = PilotJournal(Path(folder) / "pilot.sqlite")
            agent = PilotPrintAgent(backend=backend, journal=journal,
                                    printer=DisabledNativePrinter(), dry_run=True)
            result = agent.run_once()
            self.assertEqual(result["status"], "SIMULATED_DONE")
            self.assertIs(result["driver_called"], False)
            self.assertEqual(backend.reports[-1][1], {
                "driver_called": False, "spooler_ack": False,
                "reason_code": "PILOT_DRY_RUN"})
            self.assertEqual(backend.reports[-1][0], "SIMULATED_DONE")
            self.assertEqual(journal.get(work.job["job_id"])["state"], "SIMULATED_DONE")
            again = agent.run_once()
            self.assertEqual(again["status"], "SIMULATED_DONE")
            self.assertIs(again["reconciled"], True)
            journal.close()

    def test_pilot_dry_run_rejects_non_simulation_job_before_gates(self):
        work = make_work()
        backend = FakeBackend(work)
        with tempfile.TemporaryDirectory() as folder:
            journal = PilotJournal(Path(folder) / "pilot.sqlite")
            agent = PilotPrintAgent(backend=backend, journal=journal,
                                    printer=FakeNativePrinter(), dry_run=True)
            result = agent.run_once()
            self.assertEqual(result["status"], "BLOCKED")
            self.assertEqual(result["reason"], "PILOT_DRY_RUN_REQUIRES_SIMULATION_JOB")
            self.assertEqual(backend.reports, [])
            self.assertIsNone(journal.get(work.job["job_id"]))
            journal.close()

    def test_pilot_copy_limit_matches_locked_wire(self):
        vector = make_work(duplex=True)
        vector.candidate["settings"]["copies"] = 2
        vector.candidate["settings_sha256"] = sha(_canonical(
            vector.candidate["settings"]).encode("utf-8"))
        vector.authorization["settings_sha256"] = vector.candidate["settings_sha256"]
        self.assertEqual(vector.candidate["settings_sha256"],
                         "e6ed1f13eba6750d851960ef87efb679356b36aad49c20887ac249e55162b486")
        self.assertTrue(verify_pilot_source_ticket(
            job=vector.job, candidate=vector.candidate,
            authorization=vector.authorization, source_bytes=vector.source_bytes,
            configured_printer_id="RMP7000").settings["duplex"])

        work = make_work()
        work.candidate["settings"]["copies"] = 99
        work.candidate["settings_sha256"] = sha(_canonical(
            work.candidate["settings"]).encode("utf-8"))
        work.authorization["settings_sha256"] = work.candidate["settings_sha256"]
        self.assertEqual(verify_pilot_source_ticket(
            job=work.job, candidate=work.candidate,
            authorization=work.authorization, source_bytes=work.source_bytes,
            configured_printer_id="RMP7000").settings["copies"], 99)

        work.candidate["settings"]["copies"] = 100
        work.candidate["settings_sha256"] = sha(_canonical(
            work.candidate["settings"]).encode("utf-8"))
        work.authorization["settings_sha256"] = work.candidate["settings_sha256"]
        with self.assertRaises(PilotTicketInvalid):
            verify_pilot_source_ticket(job=work.job, candidate=work.candidate,
                                       authorization=work.authorization,
                                       source_bytes=work.source_bytes,
                                       configured_printer_id="RMP7000")

    def test_crash_after_journal_boundary_recovers_unknown_without_driver_call(self):
        with tempfile.TemporaryDirectory() as folder:
            work = make_work("PDF")
            backend = FakeBackend(work)
            printer = FakeNativePrinter()
            journal_path = Path(folder) / "pilot.sqlite"
            journal = CrashAfterDriverBoundaryJournal(journal_path)
            agent = PilotPrintAgent(backend=backend, journal=journal, printer=printer,
                                    dry_run=False, configured_shop_id="pilot-shop-public-test",
                                       configured_order_id="order-public-test")
            with self.assertRaises(SimulatedProcessCrash):
                agent.run_once()
            self.assertEqual(printer.send_calls, [])
            self.assertEqual(journal.get("job-public-test")["state"], "DRIVER_CALLED")
            journal.close()

            reopened = PilotJournal(journal_path)
            restarted = PilotPrintAgent(backend=backend, journal=reopened, printer=printer,
                                        dry_run=False, configured_shop_id="pilot-shop-public-test",
                                       configured_order_id="order-public-test")
            self.assertEqual(restarted.run_once()["status"], "UNKNOWN")
            self.assertEqual(printer.send_calls, [])
            self.assertEqual(reopened.get("job-public-test")["state"], "UNKNOWN")
            self.assertEqual(backend.reports[-1][0], "UNKNOWN")
            reopened.close()

    def test_crash_after_native_call_recovers_unknown_and_never_repeats_call(self):
        with tempfile.TemporaryDirectory() as folder:
            work = make_work("DOCX")
            backend = FakeBackend(work)
            printer = CrashAfterNativeCallPrinter()
            journal_path = Path(folder) / "pilot.sqlite"
            journal = PilotJournal(journal_path)
            agent = PilotPrintAgent(backend=backend, journal=journal, printer=printer,
                                    dry_run=False, configured_shop_id="pilot-shop-public-test",
                                       configured_order_id="order-public-test")
            with self.assertRaises(SimulatedProcessCrash):
                agent.run_once()
            self.assertEqual(len(printer.send_calls), 1)
            self.assertEqual(journal.get("job-public-test")["state"], "DRIVER_CALLED")
            journal.close()

            reopened = PilotJournal(journal_path)
            restarted = PilotPrintAgent(backend=backend, journal=reopened, printer=printer,
                                        dry_run=False, configured_shop_id="pilot-shop-public-test",
                                       configured_order_id="order-public-test")
            self.assertEqual(restarted.run_once()["status"], "UNKNOWN")
            self.assertEqual(len(printer.send_calls), 1)
            self.assertEqual(reopened.get("job-public-test")["state"], "UNKNOWN")
            self.assertEqual(backend.reports[-1][0], "UNKNOWN")
            reopened.close()

    def test_word_worker_opens_original_docx_and_checks_pages_before_print(self):
        source_path = PUBLIC_FILES["DOCX"].resolve()
        observations = {"open": [], "print": [], "close": 0, "quit": 0, "uninit": 0}
        section_setup = SimpleNamespace(PaperSize=0, Orientation=1)

        class FakeDocument:
            Sections = (SimpleNamespace(PageSetup=section_setup),)

            def Repaginate(self):
                observations["repaginate"] = True

            def ComputeStatistics(self, statistic):
                observations["statistic"] = statistic
                return 1

            def PrintOut(self, **kwargs):
                observations["print"].append(kwargs)

            def Close(self, **kwargs):
                observations["close"] += 1

        document = FakeDocument()

        class FakeDocuments:
            def Open(self, **kwargs):
                observations["open"].append(kwargs)
                return document

        class FakeApp:
            def __init__(self):
                self.Documents = FakeDocuments()
                self.Options = SimpleNamespace(UpdateLinksAtOpen=True)

            def Quit(self, **kwargs):
                observations["quit"] += 1

        pythoncom = ModuleType("pythoncom")
        pythoncom.CoInitialize = lambda: None
        pythoncom.CoUninitialize = lambda: observations.__setitem__("uninit", 1)
        client = ModuleType("win32com.client")
        client.DispatchEx = lambda _name: observations.setdefault("app", FakeApp())
        win32com = ModuleType("win32com")
        win32com.__path__ = []
        with patch.dict(sys.modules, {"pythoncom": pythoncom, "win32com": win32com,
                                      "win32com.client": client}):
            result = execute_word_job(
                source_path=source_path,
                expected_sha256=EXPECTED_SHA256["DOCX"], mode="print",
                printer_name="RMP7000 - Ricoh PCL6 V4", copies=1,
                expected_page_count=1)

            self.assertEqual(result["status"], "SUBMITTED")
            self.assertEqual(result["source_sha256"], EXPECTED_SHA256["DOCX"])
            self.assertEqual(observations["open"][0]["FileName"], str(source_path))
            self.assertIs(observations["open"][0]["ReadOnly"], True)
            self.assertEqual(observations["print"], [{
                "Background": False, "Copies": 1, "Collate": True,
                "PrintToFile": False, "ManualDuplexPrint": False,
            }])
            self.assertEqual(observations["app"].ActivePrinter, "RMP7000 - Ricoh PCL6 V4")
            self.assertEqual(section_setup.PaperSize, 9)
            self.assertEqual(section_setup.Orientation, 1)
            self.assertEqual(observations["close"], 1)
            self.assertEqual(observations["quit"], 1)
            self.assertEqual(observations["uninit"], 1)

            with self.assertRaisesRegex(ValueError, "WORD_LAYOUT_CHANGED_BEFORE_SEND"):
                execute_word_job(
                    source_path=source_path,
                    expected_sha256=EXPECTED_SHA256["DOCX"], mode="print",
                    printer_name="RMP7000 - Ricoh PCL6 V4", copies=1,
                    expected_page_count=2)
            self.assertEqual(len(observations["print"]), 1)

    def test_pdf_native_adapter_targets_original_public_pdf_and_explicit_queue(self):
        work = make_work("PDF")
        verified = verify_pilot_source_ticket(
            job=work.job, candidate=work.candidate,
            authorization=work.authorization, source_bytes=work.source_bytes,
            configured_printer_id="RMP7000")
        prepared = _PreparedNativePrint(PUBLIC_FILES["PDF"].resolve(), page_count=1)
        printer = WindowsNativePrinter(
            private_root=Path("/private/spool"),
            profile=WindowsPrinterProfile(
                printer_id="RMP7000", queue_name="RMP7000 - Ricoh PCL6 V4",
                driver_name="Ricoh PCL6 V4", port_name="IP_192.168.1.195"),
            sumatra_exe=Path("/private/bin/SumatraPDF.exe"), sumatra_sha256="a" * 64)
        captured = []

        class NoopContext:
            def __init__(self, *_args, **_kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        with patch.object(printer, "_assert_windows"), \
                patch.object(printer, "_assert_printer"), \
                patch("agents.windows.pilot_native_print._ExclusivePrinterLock", NoopContext), \
                patch("agents.windows.pilot_native_print._PerUserPrinterSettings", NoopContext), \
                patch("agents.windows.pilot_native_print._wait_native_process",
                      side_effect=lambda command, _timeout: captured.append(command) or 0):
            result = printer.send(prepared, work, verified)

        self.assertEqual(result, {"accepted": True, "native_app": "SUMATRA_PDF",
                                  "native_app_exit_code": 0})
        self.assertEqual(captured, [[
            "/private/bin/SumatraPDF.exe", "-print-to", "RMP7000 - Ricoh PCL6 V4",
            "-print-settings", "1x,paper=A4,monochrome,shrink,ignore-pdf-print-settings,simplex",
            "-silent", str(PUBLIC_FILES["PDF"].resolve()),
        ]])
        self.assertEqual(sha(Path(captured[0][-1]).read_bytes()), EXPECTED_SHA256["PDF"])

    def test_wrong_windows_queue_driver_or_port_stops_before_native_process(self):
        work = make_work("PDF")
        verified = verify_pilot_source_ticket(
            job=work.job, candidate=work.candidate,
            authorization=work.authorization, source_bytes=work.source_bytes,
            configured_printer_id="RMP7000")
        printer = WindowsNativePrinter(
            private_root=Path("/private/spool"),
            profile=WindowsPrinterProfile(
                printer_id="RMP7000", queue_name="RMP7000 - Ricoh PCL6 V4",
                driver_name="Ricoh PCL6 V4", port_name="IP_192.168.1.195"),
            sumatra_exe=Path("/private/bin/SumatraPDF.exe"), sumatra_sha256="a" * 64)
        handle = object()
        calls = []
        win32print = ModuleType("win32print")
        win32print.OpenPrinter = lambda queue: calls.append(("open", queue)) or handle
        win32print.GetPrinter = lambda _handle, level: {
            "pPrinterName": "RMP7000 - Ricoh PCL6 V4",
            "pDriverName": "Ricoh PCL6 V4",
            "pPortName": "IP_192.168.1.196",
            "pComment": "Ricoh IM7000",
        }
        win32print.ClosePrinter = lambda _handle: calls.append(("close",))
        with patch.object(printer, "_assert_windows"), \
                patch.dict(sys.modules, {"win32print": win32print}), \
                patch("agents.windows.pilot_native_print._wait_native_process") as native_call:
            with self.assertRaisesRegex(PilotPrintBlocked, "PILOT_PRINTER_QUEUE_DRIVER_CHANGED"):
                printer.send(_PreparedNativePrint(PUBLIC_FILES["PDF"].resolve(), 1),
                             work, verified)
        self.assertEqual(calls, [("open", "RMP7000 - Ricoh PCL6 V4"), ("close",)])
        native_call.assert_not_called()

    def test_printer_settings_are_per_user_verified_and_restored(self):
        class DevMode:
            def __init__(self, *, fields=0, paper=1, orientation=2, color=2, duplex=2):
                self.Fields = fields
                self.PaperSize = paper
                self.Orientation = orientation
                self.Color = color
                self.Duplex = duplex

        win32con = ModuleType("win32con")
        win32con.DM_PAPERSIZE = 1
        win32con.DM_ORIENTATION = 2
        win32con.DM_COLOR = 4
        win32con.DM_DUPLEX = 8
        win32con.DMPAPER_A4 = 9
        win32con.DMORIENT_PORTRAIT = 1
        win32con.DMCOLOR_MONOCHROME = 1
        win32con.DMDUP_VERTICAL = 2
        win32con.DMDUP_SIMPLEX = 1
        state = {"devmode": DevMode()}
        calls = {"get": [], "set": [], "close": 0}
        handle = object()
        win32print = ModuleType("win32print")
        win32print.OpenPrinter = lambda _queue: handle

        def get_printer(_handle, level):
            calls["get"].append(level)
            return {"pDevMode": deepcopy(state["devmode"])}

        def set_printer(_handle, level, value, command):
            calls["set"].append((level, command))
            state["devmode"] = deepcopy(value["pDevMode"])

        win32print.GetPrinter = get_printer
        win32print.SetPrinter = set_printer
        win32print.ClosePrinter = lambda _handle: calls.__setitem__("close", calls["close"] + 1)
        settings = {"copies": 1, "duplex": False, "paper": "A4", "color": "black_white"}
        with patch.object(native_module.os, "name", "nt"), \
                patch.dict(sys.modules, {"win32con": win32con, "win32print": win32print}):
            with _PerUserPrinterSettings("RMP7000 - Ricoh PCL6 V4", settings):
                self.assertEqual(state["devmode"].PaperSize, win32con.DMPAPER_A4)
                self.assertEqual(state["devmode"].Color, win32con.DMCOLOR_MONOCHROME)
                self.assertEqual(state["devmode"].Duplex, win32con.DMDUP_SIMPLEX)
            self.assertEqual(state["devmode"].PaperSize, 1)
            self.assertEqual(state["devmode"].Color, 2)
            self.assertEqual(state["devmode"].Duplex, 2)
        self.assertEqual(calls["get"], [9, 9])
        self.assertEqual(calls["set"], [(9, 0), (9, 0)])
        self.assertEqual(calls["close"], 1)

    def test_printer_settings_apply_and_verify_long_edge_duplex(self):
        class DevMode:
            def __init__(self, *, fields=0, paper=1, color=2, duplex=2):
                self.Fields = fields
                self.PaperSize = paper
                self.Color = color
                self.Duplex = duplex

        win32con = ModuleType("win32con")
        win32con.DM_PAPERSIZE = 1
        win32con.DM_COLOR = 4
        win32con.DM_DUPLEX = 8
        win32con.DMPAPER_A4 = 9
        win32con.DMCOLOR_MONOCHROME = 1
        win32con.DMDUP_SIMPLEX = 1
        win32con.DMDUP_VERTICAL = 2
        state = {"devmode": DevMode()}
        handle = object()
        win32print = ModuleType("win32print")
        win32print.OpenPrinter = lambda _queue: handle
        win32print.GetPrinter = lambda _handle, _level: {
            "pDevMode": deepcopy(state["devmode"])}
        win32print.SetPrinter = lambda _handle, _level, value, _command: state.__setitem__(
            "devmode", deepcopy(value["pDevMode"]))
        win32print.ClosePrinter = lambda _handle: None
        settings = {"copies": 1, "duplex": True, "paper": "A4", "color": "black_white"}
        with patch.object(native_module.os, "name", "nt"), \
                patch.dict(sys.modules, {"win32con": win32con, "win32print": win32print}):
            with _PerUserPrinterSettings("RMP7000 - Ricoh PCL6 V4", settings):
                self.assertEqual(state["devmode"].Duplex, win32con.DMDUP_VERTICAL)
            self.assertEqual(state["devmode"].Duplex, 2)

    def test_unverified_printer_settings_stop_before_native_process(self):
        class DevMode:
            def __init__(self, *, fields=0, paper=1, orientation=2, color=2, duplex=2):
                self.Fields = fields
                self.PaperSize = paper
                self.Orientation = orientation
                self.Color = color
                self.Duplex = duplex

        win32con = ModuleType("win32con")
        win32con.DM_PAPERSIZE = 1
        win32con.DM_COLOR = 4
        win32con.DM_DUPLEX = 8
        win32con.DMPAPER_A4 = 9
        win32con.DMCOLOR_MONOCHROME = 1
        win32con.DMDUP_SIMPLEX = 1
        win32con.DMDUP_VERTICAL = 2
        original = DevMode()
        calls = {"settings_reads": 0, "settings_writes": 0, "native": 0}
        handle = object()
        win32print = ModuleType("win32print")
        win32print.OpenPrinter = lambda _queue: handle
        win32print.ClosePrinter = lambda _handle: None

        def get_printer(_handle, level):
            if level == 2:
                return {"pPrinterName": "RMP7000 - Ricoh PCL6 V4",
                        "pDriverName": "Ricoh PCL6 V4", "pPortName": "IP_192.168.1.195",
                        "pComment": "Ricoh IM7000"}
            calls["settings_reads"] += 1
            if calls["settings_reads"] == 1:
                return {"pDevMode": deepcopy(original)}
            return {"pDevMode": DevMode(paper=9, color=2, duplex=1)}

        win32print.GetPrinter = get_printer
        win32print.SetPrinter = lambda *_args: calls.__setitem__(
            "settings_writes", calls["settings_writes"] + 1)
        work = make_work("PDF")
        verified = verify_pilot_source_ticket(
            job=work.job, candidate=work.candidate,
            authorization=work.authorization, source_bytes=work.source_bytes,
            configured_printer_id="RMP7000")
        printer = WindowsNativePrinter(
            private_root=Path("/private/spool"),
            profile=WindowsPrinterProfile(
                printer_id="RMP7000", queue_name="RMP7000 - Ricoh PCL6 V4",
                driver_name="Ricoh PCL6 V4", port_name="IP_192.168.1.195"),
            sumatra_exe=Path("/private/bin/SumatraPDF.exe"), sumatra_sha256="a" * 64)
        prepared = _PreparedNativePrint(PUBLIC_FILES["PDF"].resolve(), 1)
        with patch.object(native_module.os, "name", "nt"), \
                patch.object(printer, "_assert_windows"), \
                patch("agents.windows.pilot_native_print._ExclusivePrinterLock",
                      lambda *_args: type("Lock", (), {"__enter__": lambda self: self,
                                                        "__exit__": lambda self, *_: False})()), \
                patch.dict(sys.modules, {"win32con": win32con, "win32print": win32print}), \
                patch("agents.windows.pilot_native_print._wait_native_process",
                      side_effect=lambda *_args, **_kwargs: calls.__setitem__("native", 1)) as native_call:
            with self.assertRaisesRegex(PilotPrintBlocked,
                                        "PRINTER_DEVMODE_SETTINGS_UNVERIFIED"):
                printer.send(prepared, work, verified)
        self.assertEqual(calls["settings_writes"], 2)  # apply, then restore original
        self.assertEqual(calls["native"], 0)
        native_call.assert_not_called()

    def test_native_process_timeout_kills_simulated_child(self):
        with self.assertRaisesRegex(PilotPrintBlocked, "NATIVE_APP_TIMEOUT"):
            _wait_native_process([sys.executable, "-c", "import time; time.sleep(10)"], 1)

    def test_driver_timeout_is_unknown_and_restart_does_not_resend(self):
        with tempfile.TemporaryDirectory() as folder:
            work = make_work("DOCX")
            printer = FakeNativePrinter(fail_send=True)
            agent, journal, backend, _ = self.make_agent(folder, work, printer=printer)
            self.assertEqual(agent.run_once()["status"], "UNKNOWN")
            self.assertEqual(len(printer.send_calls), 1)
            self.assertEqual(journal.get("job-public-test")["state"], "UNKNOWN")
            journal.close()

            reopened = PilotJournal(Path(folder) / "pilot.sqlite")
            restarted = PilotPrintAgent(backend=backend, journal=reopened, printer=printer,
                                        dry_run=False, configured_shop_id="pilot-shop-public-test",
                                       configured_order_id="order-public-test")
            self.assertEqual(restarted.run_once()["status"], "UNKNOWN")
            self.assertEqual(len(printer.send_calls), 1)
            reopened.close()


if __name__ == "__main__":
    unittest.main()
