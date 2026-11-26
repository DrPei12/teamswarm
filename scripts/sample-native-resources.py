"""Read-only sampling of one runtime's process tree; requires psutil."""
import argparse
import datetime
import json
import pathlib
import time

import psutil

parser = argparse.ArgumentParser()
parser.add_argument("--pid", required=True, type=int)
parser.add_argument("--output", required=True, type=pathlib.Path)
parser.add_argument("--seconds", type=int, default=1200)
args = parser.parse_args()
root = psutil.Process(args.pid)
deadline = time.monotonic() + args.seconds
while time.monotonic() < deadline and root.is_running():
    rows = []
    for process in [root, *root.children(recursive=True)]:
        try:
            memory = process.memory_full_info()
            rows.append(dict(pid=process.pid, parent=process.ppid(), name=process.name(),
                             workingSet=memory.rss, privateWorkingSet=memory.uss,
                             privateBytes=getattr(memory, "private", memory.vms),
                             cpuSeconds=sum(process.cpu_times()[:2]), threads=process.num_threads()))
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    sample = dict(at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  rootPid=args.pid, metric="psutil uss (private resident bytes)", processes=rows)
    with args.output.open("a", encoding="utf-8") as output:
        output.write(json.dumps(sample, ensure_ascii=False) + "\n")
    if pathlib.Path(str(args.output) + ".stop").exists():
        break
    time.sleep(3)
