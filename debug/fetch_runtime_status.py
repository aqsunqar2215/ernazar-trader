from __future__ import annotations

import json
import urllib.request


def fetch(path: str):
    with urllib.request.urlopen(f"http://127.0.0.1:8080{path}", timeout=5) as handle:
        return json.load(handle)


def main() -> int:
    health = fetch("/health")
    runtime = fetch("/runtime/status")
    summary = {
        "health": {
            "status": health.get("status"),
            "service": health.get("service"),
            "uptimeMs": health.get("uptimeMs"),
            "backtestGate": health.get("backtestGate"),
        },
        "runtime": {
            "stage": runtime.get("stage"),
            "killSwitch": runtime.get("killSwitch"),
            "paperTrades": runtime.get("paperMetrics", {}).get("trades"),
            "paperNetPnlUsd": runtime.get("paperMetrics", {}).get("netPnlUsd"),
            "paperProfitFactor": runtime.get("paperMetrics", {}).get("profitFactor"),
        },
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
