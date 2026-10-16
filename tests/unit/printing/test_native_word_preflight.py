"""CODE503 read-only Word inventory: fake probes never attest real Windows."""
import json
import subprocess
import sys

import pytest

from agents.windows.native_word_preflight import (
    Dependencies, Registration, SCHEMA, preflight,
)


class FakeProbes:
    """Synthetic results only; must be labeled injected_fake in every answer."""

    def __init__(self, platform="win32", deps=(True, False),
                 reg=(True, True, True), error=None):
        self.os_name = platform
        self.deps = deps
        self.reg = reg
        self.error = error
        self.calls = []

    def platform(self):
        self.calls.append("platform")
        if self.error == "platform":
            raise OSError("synthetic confidential path")
        return self.os_name

    def dependencies(self):
        self.calls.append("dependencies")
        if self.error == "dependencies":
            raise RuntimeError("synthetic private data")
        return Dependencies(*self.deps)

    def registration(self):
        self.calls.append("registry")
        if self.error == "registry":
            raise PermissionError("synthetic secret registry path")
        return Registration(*self.reg)


def assert_never_executed(answer):
    assert answer["schema"] == SCHEMA
    assert answer["native_automation_verified"] is False
    assert answer["word_render_verified"] is False
    assert answer["physical_print_verified"] is False
    assert answer["native_automation_test"] == "NOT_RUN"
    assert answer["word_render_test"] == "NOT_RUN"
    assert answer["physical_print_test"] == "NOT_RUN"
    assert answer["manual_review_required"] is True


@pytest.mark.parametrize("other", ["linux", "darwin", "freebsd"])
def test_non_windows_not_run_without_looking_for_com(other):
    fake = FakeProbes(platform=other, error="registry")
    answer = preflight(fake)
    assert answer["status"] == "NOT_RUN"
    assert answer["reason_code"] == "NON_WINDOWS_PLATFORM"
    assert answer["checks"]["windows_platform"] is False
    assert answer["checks"]["word_progid_clsid_registered"] is None
    assert fake.calls == ["platform"]
    assert_never_executed(answer)


def test_injected_positive_windows_reports_only_fake_static_available():
    fake = FakeProbes()
    answer = preflight(fake)
    assert answer["status"] == "AVAILABLE"
    assert answer["reason_code"] == "STATIC_PREREQUISITES_DETECTED"
    assert answer["evidence_kind"] == "injected_fake"
    assert answer["host_windows_verified"] is False
    assert fake.calls == ["platform", "dependencies", "registry"]
    assert all("injected_fake" in source for source in answer["evidence_sources"])
    assert_never_executed(answer)


@pytest.mark.parametrize("reg,expected", [
    ((False, False, False), "WORD_PROGID_NOT_REGISTERED"),
    ((True, False, False), "WORD_CLSID_NOT_REGISTERED"),
    ((True, True, False), "WORD_LOCAL_SERVER_NOT_REGISTERED"),
])
def test_missing_word_registration_fails_closed(reg, expected):
    answer = preflight(FakeProbes(reg=reg))
    assert (answer["status"], answer["reason_code"]) == ("UNAVAILABLE", expected)
    assert_never_executed(answer)


def test_missing_com_python_bridge_fails_closed():
    answer = preflight(FakeProbes(deps=(False, False)))
    assert answer["status"] == "UNAVAILABLE"
    assert answer["reason_code"] == "PYTHON_COM_BRIDGE_NOT_INSTALLED"
    assert_never_executed(answer)


@pytest.mark.parametrize("failure,status,code", [
    ("platform", "NOT_RUN", "PLATFORM_PROBE_FAILED"),
    ("dependencies", "UNAVAILABLE", "DEPENDENCY_PROBE_FAILED"),
    ("registry", "UNAVAILABLE", "REGISTRY_PROBE_FAILED"),
])
def test_probe_failures_are_fail_closed_with_no_secret_in_json(failure, status, code):
    answer = preflight(FakeProbes(error=failure))
    assert (answer["status"], answer["reason_code"]) == (status, code)
    encoded = json.dumps(answer)
    assert "synthetic secret" not in encoded and "private data" not in encoded
    assert "confidential path" not in encoded
    assert_never_executed(answer)


@pytest.mark.parametrize("bad_deps,bad_reg", [
    ((1, False), None),
    (None, (True, 1, True)),
])
def test_malformed_injected_probes_cannot_pretend_available(bad_deps, bad_reg):
    fake = FakeProbes(deps=bad_deps or (True, False),
                      reg=bad_reg or (True, True, True))
    answer = preflight(fake)
    assert answer["status"] == "UNAVAILABLE"
    assert answer["reason_code"] in ("DEPENDENCY_PROBE_FAILED", "REGISTRY_PROBE_FAILED")
    assert_never_executed(answer)


def test_no_word_launch_no_document_and_no_print_code(monkeypatch):
    def never(*_args, **_kwargs):
        raise AssertionError("No subprocess or printer may be accessed")

    monkeypatch.setattr(subprocess, "Popen", never)
    monkeypatch.setattr(subprocess, "run", never)
    answer = preflight(FakeProbes())
    assert answer["status"] == "AVAILABLE" and answer["host_windows_verified"] is False
    assert_never_executed(answer)


def test_host_cli_on_non_windows_reports_not_run():
    if sys.platform == "win32":
        pytest.skip("Windows host inventory requires separate authorized environment")
    run = subprocess.run([sys.executable, "-m", "agents.windows.native_word_preflight"],
                         capture_output=True, text=True, timeout=10, check=False)
    assert run.returncode == 0 and run.stderr == ""
    assert run.stdout.count("\n") == 1
    answer = json.loads(run.stdout)
    assert answer["status"] == "NOT_RUN"
    assert answer["reason_code"] == "NON_WINDOWS_PLATFORM"
    assert answer["evidence_kind"] == "host_read_only"
    assert answer["host_windows_verified"] is False
    assert_never_executed(answer)
