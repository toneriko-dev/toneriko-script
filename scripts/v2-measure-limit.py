#!/usr/bin/env python3
"""計測の子プロセス群を監視し、3 GB に達する前に停止します。"""
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

limit = 2_500_000_000
process = subprocess.Popen(sys.argv[1:], start_new_session=True)
peak = 0
stopped = False
while process.poll() is None:
    processes = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            processes[int(entry.name)] = (int(stat[1]), int(stat[21]) * os.sysconf('SC_PAGE_SIZE'))
        except (OSError, ValueError, IndexError):
            pass
    # Chromium は別セッションを作るため、セッション番号ではなく親子関係をたどります。
    descendants = {process.pid}
    while True:
        children = {pid for pid, (parent, _) in processes.items() if parent in descendants}
        if children <= descendants:
            break
        descendants |= children
    total = sum(processes.get(pid, (0, 0))[1] for pid in descendants)
    peak = max(peak, total)
    if total >= limit:
        stopped = True
        for pid in descendants:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        break
    time.sleep(0.02)
code = process.wait()
print(json.dumps({'memoryGuard': {'peakAggregateRssBytes': peak, 'stopThresholdBytes': limit, 'stopped': stopped, 'exitCode': code}}), file=sys.stderr)
sys.exit(137 if stopped else code)
