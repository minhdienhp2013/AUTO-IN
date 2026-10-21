"""Simulation tests using the exact public DOCX/PDF assets from AI5 PR #165."""
from __future__ import annotations

import hashlib
from dataclasses import replace
from pathlib import Path
import tempfile
import unittest

from agents.windows.pilot_native_print import (
    PilotJournal, PilotPrintAgent, PilotPrintWork,
)
from workers.documents.bridge import _canonical
from workers.documents.pilot_source_ticket import verify_pilot_source_ticket

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


def make_work(file_format: str = "PDF") -> PilotPrintWork:
    source_bytes = PUBLIC_FILES[file_format].read_bytes()
    source_sha = sha(source_bytes)
    settings = {"copies": 1, "duplex": False, "paper": "A4", "color": "black_white"}
    settings_sha = sha(_canonical(settings).encode("utf-8"))
    candidate = {
        "shop_id": "pilot-shop-public-test",
        "oa_id": "oa-public-test",
        "customer_id": "customer-public-test",
        "conversation_id": "conversation-public-test",
        "order_id": "order-public-test",
        "revision": 1,
        "request_hash": "1" * 64,
        "source": {
            "format": file_format,
            "artifact_ref": f"public/pilot/{PUBLIC_FILES[file_format].name}",
            "sha256": source_sha,
            "size_bytes": len(source_bytes),
            "provider_event_id": "event-public-test",
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
        "order_id": candidate["order_id"],
        "revision": 1,
        "request_hash": candidate["request_hash"],
        "source_sha256": source_sha,
        "settings_sha256": settings_sha,
        "evidence_sha256": "e" * 64,
        "printer_id": "RMP7000",
        "code_window_id": "window-public-test",
        "provider_event_id": "event-public-test",
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
    def __init__(self, *, fail_send=False):
        self.prepare_calls = []
        self.send_calls = []
        self.fail_send = fail_send
        self.prepared = FakePrepared()

    def prepare(self, work, verified):
        self.prepare_calls.append((verified.source_format, sha(work.source_bytes)))
        return self.prepared

    def send(self, _prepared, _work, verified):
        self.send_calls.append((verified.source_format, verified.source_sha256))
        if self.fail_send:
            raise TimeoutError("synthetic native driver ACK lost")
        return {"accepted": True, "spooler_job_id": "synthetic-spooler-1"}


class PilotNativePrintTests(unittest.TestCase):
    def make_agent(self, folder, work, backend=None, printer=None):
        backend = backend or FakeBackend(work)
        printer = printer or FakeNativePrinter()
        journal = PilotJournal(Path(folder) / "pilot.sqlite")
        return PilotPrintAgent(backend=backend, journal=journal, printer=printer), journal, backend, printer

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
            self.assertFalse(first["evidence"]["paper_verified"])
            self.assertEqual(printer.send_calls, [("PDF", EXPECTED_SHA256["PDF"])])
            self.assertEqual(journal.get("job-public-test")["state"], "SENT_UNVERIFIED")
            journal.close()

            reopened = PilotJournal(Path(folder) / "pilot.sqlite")
            repeated = PilotPrintAgent(backend=backend, journal=reopened, printer=printer)
            again = repeated.run_once()
            self.assertEqual(again["status"], "SENT_UNVERIFIED")
            self.assertTrue(again["reconciled"])
            self.assertEqual(len(printer.send_calls), 1)
            reopened.close()

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
            restarted = PilotPrintAgent(backend=backend, journal=reopened, printer=printer)
            self.assertEqual(restarted.run_once()["status"], "UNKNOWN")
            self.assertEqual(len(printer.send_calls), 1)
            reopened.close()


if __name__ == "__main__":
    unittest.main()
