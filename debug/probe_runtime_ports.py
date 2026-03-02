from __future__ import annotations

import argparse
import json
import socket
from dataclasses import asdict, dataclass


@dataclass
class PortProbe:
    port: int
    open: bool
    health_ok: bool
    status: str | None
    error: str | None


def fetch_health(port: int, timeout_sec: float = 0.4) -> PortProbe:
    import urllib.error
    import urllib.request

    url = f"http://127.0.0.1:{port}/health"
    try:
        with urllib.request.urlopen(url, timeout=timeout_sec) as response:
            body = json.loads(response.read().decode("utf-8"))
        return PortProbe(
            port=port,
            open=True,
            health_ok=bool(body.get("status") == "ok"),
            status=str(body.get("status")) if body.get("status") is not None else None,
            error=None,
        )
    except urllib.error.URLError as exc:
        return PortProbe(port=port, open=False, health_ok=False, status=None, error=str(exc.reason))
    except Exception as exc:  # pragma: no cover - diagnostic script
        return PortProbe(port=port, open=False, health_ok=False, status=None, error=str(exc))


def tcp_open(port: int, timeout_sec: float = 0.2) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout_sec)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--from-port", type=int, default=8080)
    parser.add_argument("--to-port", type=int, default=8640)
    args = parser.parse_args()

    probes: list[PortProbe] = []
    for port in range(args.from_port, args.to_port + 1):
        if not tcp_open(port):
            continue
        probes.append(fetch_health(port))

    print(json.dumps([asdict(p) for p in probes], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
