"""Synthetic one-job entrypoint tests; no Windows API, OA or printer calls."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from agents.windows.pilot_native_cli import run_pilot_native_once
from tests.unit.printing.test_pilot_native_print import (
    FakeBackend, FakeNativePrinter, make_work,
)


def config(folder):
    return {
        "enabled": True, "shop_id": "pilot-shop-public-test", "order_id": "order-public-test",
        "printer_id": "RMP7000",
        "queue_name": "Synthetic Ricoh", "driver_name": "Synthetic driver",
        "port_name": "Synthetic port", "expected_model_fragment": "IM7000",
        "private_root": folder, "journal": str(Path(folder) / "pilot.sqlite"),
        "sumatra_exe": str(Path(folder) / "sumatra.exe"), "sumatra_sha256": "a" * 64,
    }


class NativeEntrypointTests(unittest.TestCase):
    def _run(self, folder, backend, printer, enabled=True):
        with patch("agents.windows.pilot_native_cli._config", return_value=config(folder)) as load, \
             patch("agents.windows.pilot_native_cli.PilotHttpBackendClient", return_value=backend), \
             patch("agents.windows.pilot_native_cli.WindowsNativePrinter", return_value=printer):
            result = run_pilot_native_once(
                api_base_url="https://core.example.test", token="S" * 24,
                config_path=str(Path(folder) / "config.json"),
                enable_controlled_test=enabled)
        if not enabled:
            load.assert_not_called()
        return result

    def test_disabled_never_opens_config_or_claims(self):
        with tempfile.TemporaryDirectory() as folder:
            backend = FakeBackend(make_work())
            printer = FakeNativePrinter()
            result = self._run(folder, backend, printer, enabled=False)
            self.assertEqual(result["result"], {"status": "BLOCKED",
                                                "reason": "NATIVE_ENTRY_FAILED"})
            self.assertEqual(printer.prepare_calls, [])
            self.assertFalse((Path(folder) / "pilot.sqlite").exists())

    def test_success_then_duplicate_does_not_resend(self):
        with tempfile.TemporaryDirectory() as folder:
            backend = FakeBackend(make_work("PDF"))
            printer = FakeNativePrinter()
            first = self._run(folder, backend, printer)
            second = self._run(folder, backend, printer)
            self.assertEqual(first["result"]["status"], "SENT_UNVERIFIED")
            self.assertEqual(second["result"]["status"], "SENT_UNVERIFIED")
            self.assertEqual(len(printer.send_calls), 1)
            self.assertEqual(backend.reports[-1][1], {
                "driver_called": True, "spooler_ack": True,
                "reason_code": "SPOOLER_ACCEPTED_UNVERIFIED"})

    def test_native_error_is_unknown_and_never_resends(self):
        with tempfile.TemporaryDirectory() as folder:
            backend = FakeBackend(make_work("DOCX"))
            printer = FakeNativePrinter(fail_send=True)
            first = self._run(folder, backend, printer)
            second = self._run(folder, backend, printer)
            self.assertEqual(first["result"]["status"], "UNKNOWN")
            self.assertEqual(second["result"]["status"], "UNKNOWN")
            self.assertEqual(len(printer.send_calls), 1)
            self.assertEqual(backend.reports[-1][1]["reason_code"], "NATIVE_SEND_AMBIGUOUS")

    def test_mark_ack_loss_never_sends(self):
        with tempfile.TemporaryDirectory() as folder:
            backend = FakeBackend(make_work())
            backend.mark_raises = True
            printer = FakeNativePrinter()
            first = self._run(folder, backend, printer)
            second = self._run(folder, backend, printer)
            self.assertEqual(first["result"]["status"], "UNKNOWN")
            self.assertEqual(second["result"]["status"], "UNKNOWN")
            self.assertEqual(printer.send_calls, [])
            self.assertEqual(backend.reports[-1][1]["reason_code"],
                             "CORE_SEND_ACK_AMBIGUOUS")

    def test_http_core_is_blocked_before_claim(self):
        with tempfile.TemporaryDirectory() as folder:
            backend = FakeBackend(make_work())
            printer = FakeNativePrinter()
            with patch("agents.windows.pilot_native_cli._config", return_value=config(folder)), \
                 patch("agents.windows.pilot_native_cli.PilotHttpBackendClient") as client:
                result = run_pilot_native_once(
                    api_base_url="http://127.0.0.1:3000", token="S" * 24,
                    config_path=Path(folder) / "config.json", enable_controlled_test=True)
            self.assertEqual(result["result"]["status"], "BLOCKED")
            client.assert_not_called()
            self.assertEqual(printer.send_calls, [])


if __name__ == "__main__":
    unittest.main()
