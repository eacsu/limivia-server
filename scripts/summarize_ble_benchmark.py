"""逐运行汇总 BLE JSONL；失败耗时不冒充成功延迟，环境不混算。"""

import argparse
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path


def summarize(path):
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    grouped = defaultdict(list)
    for row in rows:
        if "op" in row and "ms" in row:
            grouped[row["op"]].append(row)
    operations = {}
    for name, samples in grouped.items():
        values = sorted(row["ms"] for row in samples if row.get("ok", True))
        failures = [row for row in samples if row.get("ok") is False]
        operations[name] = {
            "n": len(samples),
            "success": len(values),
            "failed": len(failures),
            "failure_rate": len(failures) / len(samples),
            "mean_ms": statistics.mean(values) if values else None,
            "p50_ms": statistics.median(values) if values else None,
            "p95_ms": values[math.ceil(len(values) * 0.95) - 1] if values else None,
            "max_ms": max(values) if values else None,
            "errors": [row.get("error") for row in failures],
        }
    return {
        "source": str(path),
        "meta": next((row["meta"] for row in rows if "meta" in row), None),
        "identity": next((row["identity"] for row in rows if "identity" in row), None),
        "elapsed_s": rows[-1]["at"] - rows[0]["at"] if rows else None,
        "operations": operations,
        "events": [row for row in rows if "event" in row],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.write_text(
        json.dumps([summarize(path) for path in args.inputs], ensure_ascii=False, indent=2)
    )
