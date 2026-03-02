from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from typing import Iterable

import psutil


@dataclass
class RuntimePortProcess:
    pid: int
    port: int
    name: str
    cmdline: str


def iter_runtime_processes(from_port: int, to_port: int) -> list[RuntimePortProcess]:
    by_pid_port: dict[tuple[int, int], RuntimePortProcess] = {}
    for conn in psutil.net_connections(kind="tcp"):
        if conn.status != psutil.CONN_LISTEN:
            continue
        if not conn.laddr:
            continue
        port = int(conn.laddr.port)
        if port < from_port or port > to_port:
            continue
        if conn.pid is None:
            continue
        try:
            proc = psutil.Process(conn.pid)
            name = proc.name()
            cmd = " ".join(proc.cmdline())
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        if "node" not in name.lower():
            continue
        normalized_cmd = cmd.replace("\\", "/")
        if "dist/index.js" not in normalized_cmd and "src/index.ts" not in normalized_cmd:
            continue
        key = (conn.pid, port)
        by_pid_port[key] = RuntimePortProcess(
            pid=conn.pid,
            port=port,
            name=name,
            cmdline=cmd,
        )
    rows = list(by_pid_port.values())
    rows.sort(key=lambda r: (r.port, r.pid))
    return rows


def terminate_processes(items: Iterable[RuntimePortProcess]) -> list[dict[str, object]]:
    results: list[dict[str, object]] = []
    for item in items:
        row: dict[str, object] = {
            "pid": item.pid,
            "port": item.port,
            "action": "terminate",
            "terminated": False,
            "killed": False,
            "error": None,
        }
        try:
            proc = psutil.Process(item.pid)
            proc.terminate()
            try:
                proc.wait(timeout=3)
                row["terminated"] = True
            except psutil.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=3)
                row["killed"] = True
        except Exception as exc:  # pragma: no cover - ops script
            row["error"] = str(exc)
        results.append(row)
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--from-port", type=int, default=8080)
    parser.add_argument("--to-port", type=int, default=8640)
    parser.add_argument("--kill", action="store_true")
    args = parser.parse_args()

    before = iter_runtime_processes(args.from_port, args.to_port)
    actions = terminate_processes(before) if args.kill else []
    after = iter_runtime_processes(args.from_port, args.to_port)

    print(
        json.dumps(
            {
                "fromPort": args.from_port,
                "toPort": args.to_port,
                "killMode": args.kill,
                "before": [asdict(item) for item in before],
                "actions": actions,
                "after": [asdict(item) for item in after],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
