import datetime
import os
import time
from pathlib import Path
import subprocess

import psutil


def main() -> int:
    repo = Path(__file__).resolve().parent
    port = "8092"
    base_url = f"http://127.0.0.1:{port}"
    max_iters = "30"

    env = os.environ.copy()
    env.update(
        {
            "PORT": port,
            "BASE_URL": base_url,
            "FORCE_NEW_RUNTIME": "1",
            "USE_EXISTING_RUNTIME": "0",
            "MAX_ITERS": max_iters,
        }
    )

    log_path = repo / f"train-until-target-{port}-iters{max_iters}.log"
    mem_path = repo / f"train-until-target-{port}-iters{max_iters}-mem.csv"

    with log_path.open("w", encoding="utf-8") as logf, mem_path.open(
        "w", encoding="utf-8"
    ) as memf:
        memf.write("ts,proc,pid,rss_mb,vms_mb,cmdline\n")
        proc = subprocess.Popen(
            ["node", "scripts/train-until-target.mjs"],
            cwd=repo,
            env=env,
            stdout=logf,
            stderr=subprocess.STDOUT,
            text=True,
        )

        ps_proc = psutil.Process(proc.pid)
        while True:
            ts = datetime.datetime.utcnow().isoformat()
            procs = []
            try:
                procs = [ps_proc] + ps_proc.children(recursive=True)
            except psutil.NoSuchProcess:
                procs = []

            seen = set()
            for pr in procs:
                try:
                    if pr.pid in seen:
                        continue
                    seen.add(pr.pid)
                    mi = pr.memory_info()
                    rss = mi.rss / 1024 / 1024
                    vms = mi.vms / 1024 / 1024
                    cmd = " ".join(pr.cmdline()) if pr.cmdline() else ""
                    cmd = cmd.replace(",", ";")
                    memf.write(f"{ts},{pr.name()},{pr.pid},{rss:.2f},{vms:.2f},{cmd}\n")
                except Exception:
                    pass

            memf.flush()
            if proc.poll() is not None:
                break
            time.sleep(5)

        return proc.returncode or 0


if __name__ == "__main__":
    raise SystemExit(main())
