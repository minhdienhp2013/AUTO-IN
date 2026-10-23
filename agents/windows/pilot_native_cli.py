"""One-job Windows controlled-test entrypoint. Never enabled by default.

Local JSON configuration contains exactly: enabled, shop_id, order_id, printer_id,
queue_name, driver_name, port_name, expected_model_fragment, private_root,
journal, sumatra_exe, sumatra_sha256. The service account must own a private
directory and install a hash-pinned SumatraPDF binary before opting in.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from .pilot_backend_http import PilotHttpBackendClient
from .pilot_native_print import (
    PilotJournal, PilotPrintAgent, WindowsNativePrinter, WindowsPrinterProfile,
    _assert_private_windows_acl, HEX,
)
from urllib.parse import urlsplit

_FIELDS = {"enabled", "shop_id", "order_id", "printer_id", "queue_name", "driver_name",
           "port_name", "expected_model_fragment", "private_root", "journal",
           "sumatra_exe", "sumatra_sha256"}


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("DUPLICATE_CONFIG_KEY")
        value[key] = item
    return value


def _local_path(value: object) -> Path:
    if type(value) is not str or not value or value.startswith("\\\\"):
        raise ValueError("LOCAL_PATH_REQUIRED")
    path = Path(value)
    if not path.is_absolute() or path.is_symlink():
        raise ValueError("LOCAL_PATH_REQUIRED")
    return path


def _config(path: Path) -> dict:
    if os.name != "nt" or not path.is_absolute() or path.is_symlink():
        raise ValueError("WINDOWS_PRIVATE_CONFIG_REQUIRED")
    _assert_private_windows_acl(path.parent)
    _assert_private_windows_acl(path)
    if not path.is_file() or path.stat().st_size > 4096:
        raise ValueError("CONFIG_UNAVAILABLE")
    config = json.loads(path.read_text(encoding="utf-8"),
                        object_pairs_hook=_unique_object)
    if (type(config) is not dict or set(config) != _FIELDS or
            config["enabled"] is not True or
            any(type(config[key]) is not str or not config[key].strip() or
                len(config[key]) > 256 for key in
                ("shop_id", "order_id", "queue_name", "driver_name", "port_name",
                 "expected_model_fragment")) or
            config["printer_id"] != "RMP7000" or
            type(config["sumatra_sha256"]) is not str or
            not HEX.fullmatch(config["sumatra_sha256"])):
        raise ValueError("CONTROLLED_TEST_CONFIG_INVALID")
    root = _local_path(config["private_root"])
    journal = _local_path(config["journal"])
    renderer = _local_path(config["sumatra_exe"])
    if (not root.is_dir() or journal.parent != root or
            not renderer.is_file() or renderer.parent == root):
        raise ValueError("CONTROLLED_TEST_LOCAL_PATH_INVALID")
    _assert_private_windows_acl(root)
    _assert_private_windows_acl(renderer.parent)
    _assert_private_windows_acl(renderer)
    return config


def run_pilot_native_once(*, api_base_url: str, token: str, config_path: str | Path,
                          enable_controlled_test: bool = False,
                          timeout: float = 10) -> dict:
    """Claim one Core ticket, never retry after an ambiguous boundary."""
    journal = None
    try:
        if enable_controlled_test is not True:
            raise ValueError("NATIVE_PRINT_DISABLED")
        config = _config(Path(config_path))
        parsed = urlsplit(api_base_url)
        if parsed.scheme != "https":
            raise ValueError("NATIVE_REQUIRES_HTTPS_CORE")
        backend = PilotHttpBackendClient(api_base_url, token,
                                         printer_id=config["printer_id"], timeout=timeout,
                                         configured_shop_id=config["shop_id"],
                                         configured_order_id=config["order_id"],
                                         required_mode="controlled_test")
        profile = WindowsPrinterProfile(
            printer_id=config["printer_id"], queue_name=config["queue_name"],
            driver_name=config["driver_name"], port_name=config["port_name"],
            expected_model_fragment=config["expected_model_fragment"])
        printer = WindowsNativePrinter(
            private_root=config["private_root"], profile=profile,
            sumatra_exe=config["sumatra_exe"],
            sumatra_sha256=config["sumatra_sha256"])
        journal = PilotJournal(config["journal"])
        agent = PilotPrintAgent(backend=backend, journal=journal, printer=printer,
                                configured_printer_id=config["printer_id"],
                                configured_shop_id=config["shop_id"],
                                configured_order_id=config["order_id"], dry_run=False)
        result = agent.run_once()
        public = {"status": result.get("status", "UNKNOWN")}
        if result.get("report_pending") is True:
            public["report_pending"] = True
        return {"mode": "controlled_test", "result": public}
    except Exception:
        # Paths, token, ticket, exception text and source data stay off stdout.
        return {"mode": "controlled_test", "result": {
            "status": "BLOCKED" if journal is None else "UNKNOWN",
            "reason": "NATIVE_ENTRY_FAILED"}}
    finally:
        if journal is not None:
            journal.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AUTO-IN one-job Windows controlled test")
    parser.add_argument("--api-base-url", required=True)
    parser.add_argument("--config", required=True, help="Private local JSON configuration")
    parser.add_argument("--enable-controlled-test", action="store_true")
    args = parser.parse_args(argv)
    result = run_pilot_native_once(
        api_base_url=args.api_base_url, token=os.environ.get("AUTO_IN_AGENT_TOKEN", ""),
        config_path=args.config, enable_controlled_test=args.enable_controlled_test)
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    return 0 if result["result"]["status"] in ("NO_JOB", "SENT_UNVERIFIED") else 2


if __name__ == "__main__":
    raise SystemExit(main())
