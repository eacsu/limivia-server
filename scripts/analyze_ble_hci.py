"""从 btmon 文本提取固定 ATT 承载的主机边界往返；不输出任何包内容。"""

import argparse
import json
import math
import re
import statistics
from collections import defaultdict
from pathlib import Path

ACL = re.compile(r"^([<>]) ACL Data (?:TX|RX): Handle (\d+).*\[hci(\d+)\] (\d+\.\d+)")
ATT = re.compile(r"^\s+ATT: .*\(0x([0-9a-f]{2})\)")
RESPONSES = {2: 3, 4: 5, 6: 7, 8: 9, 10: 11, 12: 13, 14: 15, 16: 17, 18: 19, 22: 23, 24: 25}
NAMES = {
    2: "mtu",
    4: "find_information",
    6: "find_type",
    8: "read_type",
    10: "read",
    12: "read_blob",
    14: "read_multiple",
    16: "read_group",
    18: "write",
    22: "prepare_write",
    24: "execute_write",
}


def distribution(values):
    values = sorted(values)
    return {
        "n": len(values),
        "mean_ms": statistics.mean(values),
        "p50_ms": statistics.median(values),
        "p95_ms": values[math.ceil(0.95 * len(values)) - 1],
        "max_ms": max(values),
    }


def analyze(lines, adapter=1):
    current, pending = None, {}
    samples, errors = defaultdict(list), defaultdict(int)
    abandoned = superseded = notifications = 0
    for line in lines:
        match = ACL.match(line)
        if match:
            direction, handle, index, at = match.groups()
            current = (direction, int(handle), float(at)) if int(index) == adapter else None
            continue
        if line.startswith(("< HCI ", "> HCI ", "@ ")):
            current = None
            if "Disconnect Complete" in line and f"[hci{adapter}]" in line:
                abandoned += len(pending)
                pending.clear()
            continue
        match = ATT.match(line)
        if not match or current is None:
            continue
        opcode = int(match[1], 16)
        direction, handle, at = current
        current = None
        if direction == "<" and opcode in RESPONSES:
            if handle in pending:
                superseded += 1
            pending[handle] = (opcode, at)
        elif direction == ">" and opcode == 0x1B:
            notifications += 1
        elif direction == ">" and handle in pending:
            request, started = pending[handle]
            if opcode not in (RESPONSES[request], 1):
                continue
            del pending[handle]
            samples[NAMES[request]].append((at - started) * 1000)
            if opcode == 1:
                errors[NAMES[request]] += 1
    return {
        "adapter": f"hci{adapter}",
        "boundary": "HCI ACL TX request to ACL RX ATT response",
        "scope": "fixed ATT bearer; includes controller/radio/firmware, excludes SDK queue",
        "operations": {
            name: {**distribution(values), "att_error_responses": errors[name]}
            for name, values in samples.items()
        },
        "notifications": notifications,
        "pending_at_capture_end": len(pending),
        "abandoned_at_disconnect": abandoned,
        "superseded": superseded,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--adapter", type=int, default=1)
    args = parser.parse_args()
    with args.input.open() as source:
        result = analyze(source, args.adapter)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2))
