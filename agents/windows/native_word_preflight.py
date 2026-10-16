"""Read-only static Windows/Word preflight. Never initializes COM or prints.

Run: python -m agents.windows.native_word_preflight

AVAILABLE means *static prerequisites detected*, not working automation,
verified rendering, a paper print or permission to start Word.
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from typing import NamedTuple, Protocol

SCHEMA = "ai3.native_word_preflight.v1"
_GUID = re.compile(
    r"\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}"
)


class Dependencies(NamedTuple):
    win32com: bool
    comtypes: bool


class Registration(NamedTuple):
    progid_clsid: bool
    clsid_registered: bool
    local_server_registered: bool


class ReadOnlyProbes(Protocol):
    def platform(self) -> str: ...
    def dependencies(self) -> Dependencies: ...
    def registration(self) -> Registration: ...


class HostReadOnlyProbes:
    """Only sys.platform, Python module metadata and registry value reads.

    Never imports COM automation packages, resolves COM objects, loads Office,
    starts processes, reads documents, or accesses printing APIs.
    """

    def platform(self) -> str:
        return sys.platform

    def dependencies(self) -> Dependencies:
        return Dependencies(
            importlib.util.find_spec("win32com") is not None,
            importlib.util.find_spec("comtypes") is not None,
        )

    def registration(self) -> Registration:
        # Import only on Windows; winreg provides static registry reads, not COM.
        import winreg

        try:
            with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT,
                                r"Word.Application\CLSID", 0,
                                winreg.KEY_QUERY_VALUE) as key:
                clsid, kind = winreg.QueryValueEx(key, "")
        except FileNotFoundError:
            return Registration(False, False, False)
        if (kind != winreg.REG_SZ or not isinstance(clsid, str)
                or _GUID.fullmatch(clsid) is None):
            return Registration(False, False, False)
        clsid_key = "CLSID\\" + clsid
        try:
            with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, clsid_key, 0,
                                winreg.KEY_READ):
                pass
        except FileNotFoundError:
            return Registration(True, False, False)
        try:
            with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT,
                                clsid_key + r"\LocalServer32", 0,
                                winreg.KEY_QUERY_VALUE) as key:
                server, kind = winreg.QueryValueEx(key, "")
        except FileNotFoundError:
            return Registration(True, True, False)
        # Do not expose executable paths, arguments, user registry values or CLSID.
        return Registration(True, True,
                            kind in (winreg.REG_SZ, winreg.REG_EXPAND_SZ)
                            and isinstance(server, str) and bool(server.strip()))


def preflight(probes: ReadOnlyProbes | None = None) -> dict[str, object]:
    """Static inventory only. Injected probes are always labeled synthetic.

    A fake reporting Windows never proves the host is Windows or that Word ran.
    Even a real Windows AVAILABLE result has NOT RUN automation/render/print.
    """
    injected = probes is not None
    probe = probes if probes is not None else HostReadOnlyProbes()
    result: dict[str, object] = {
        "schema": SCHEMA,
        "status": "NOT_RUN",
        "reason_code": "PLATFORM_NOT_CHECKED",
        "evidence_kind": "injected_fake" if injected else "host_read_only",
        "evidence_sources": ["sys.platform" if not injected else "injected_fake.platform"],
        "checks": {
            "windows_platform": None,
            "win32com_installed": None,
            "comtypes_installed": None,
            "word_progid_clsid_registered": None,
            "word_clsid_registered": None,
            "word_local_server_registered": None,
        },
        "host_windows_verified": False,
        "native_automation_verified": False,
        "word_render_verified": False,
        "physical_print_verified": False,
        "native_automation_test": "NOT_RUN",
        "word_render_test": "NOT_RUN",
        "physical_print_test": "NOT_RUN",
        "manual_review_required": True,
    }
    checks = result["checks"]
    assert isinstance(checks, dict)
    sources = result["evidence_sources"]
    assert isinstance(sources, list)
    try:
        platform = probe.platform()
    except Exception:
        result.update(status="NOT_RUN", reason_code="PLATFORM_PROBE_FAILED")
        return result
    windows = platform == "win32"
    checks["windows_platform"] = windows
    result["host_windows_verified"] = windows and not injected
    if not windows:
        result.update(status="NOT_RUN", reason_code="NON_WINDOWS_PLATFORM")
        return result
    try:
        dependencies = probe.dependencies()
        if not isinstance(dependencies, Dependencies) or any(
                type(value) is not bool for value in dependencies):
            raise ValueError("Invalid dependency probe")
        checks["win32com_installed"] = dependencies.win32com
        checks["comtypes_installed"] = dependencies.comtypes
        sources.append("injected_fake.dependencies" if injected else
                       "importlib.util.find_spec(win32com,comtypes)")
    except Exception:
        result.update(status="UNAVAILABLE", reason_code="DEPENDENCY_PROBE_FAILED")
        return result
    try:
        registration = probe.registration()
        if not isinstance(registration, Registration) or any(
                type(value) is not bool for value in registration):
            raise ValueError("Invalid registry probe")
        checks["word_progid_clsid_registered"] = registration.progid_clsid
        checks["word_clsid_registered"] = registration.clsid_registered
        checks["word_local_server_registered"] = registration.local_server_registered
        sources.extend(["injected_fake.registry" if injected else
                        r"winreg.HKCR\Word.Application\CLSID (read-only)",
                        "injected_fake.registry" if injected else
                        r"winreg.HKCR\CLSID\{GUID}\LocalServer32 (read-only)"])
    except Exception:
        result.update(status="UNAVAILABLE", reason_code="REGISTRY_PROBE_FAILED")
        return result
    if not registration.progid_clsid:
        code = "WORD_PROGID_NOT_REGISTERED"
    elif not registration.clsid_registered:
        code = "WORD_CLSID_NOT_REGISTERED"
    elif not registration.local_server_registered:
        code = "WORD_LOCAL_SERVER_NOT_REGISTERED"
    elif not (dependencies.win32com or dependencies.comtypes):
        code = "PYTHON_COM_BRIDGE_NOT_INSTALLED"
    else:
        result.update(status="AVAILABLE", reason_code="STATIC_PREREQUISITES_DETECTED")
        return result
    result.update(status="UNAVAILABLE", reason_code=code)
    return result


def main() -> int:
    answer = preflight()
    print(json.dumps(answer, ensure_ascii=False, separators=(",", ":")))
    # NOT_RUN/UNAVAILABLE are valid preflight observations, not print attempts.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
