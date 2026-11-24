"""Groups the statements a profiled campaign sent to the database, page by page.

Reads the general log of the server (thread id, command type, statement, in server order) and the
campaign JSON written by thelia:test:volume:measure with --runs=1. The measure reads the server's
Questions counter before and after each call from its own connection: those readings cut the log
into calls. The first three pairs measure the cost of a reading; then each page has a warm-up call
and a measured call. The statements of the measured call, other connections only, are normalised
(literals replaced) and counted, so that a statement repeated once per product or per order shows.
"""

import json
import re
import sys
from collections import Counter

READING = "SHOW GLOBAL STATUS LIKE 'Questions'"


def normalise(statement: str) -> str:
    statement = re.sub(r"'(?:[^'\\]|\\.)*'", "?", statement)
    statement = re.sub(r"\b\d+(?:\.\d+)?\b", "N", statement)
    statement = re.sub(r"\(\s*(?:\?|N)(?:\s*,\s*(?:\?|N))*\s*\)", "(...)", statement)
    return re.sub(r"\s+", " ", statement).strip()


def main(log_file: str, campaign_file: str, output_file: str, slow_file: str = "") -> None:
    rows = []
    with open(log_file, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t", 2)
            if len(parts) == 3:
                rows.append(parts)

    reader = next(thread for thread, kind, text in rows if text.strip() == READING)
    cuts = [index for index, (thread, kind, text) in enumerate(rows) if thread == reader and text.strip() == READING]

    pages = json.load(open(campaign_file, encoding="utf-8"))["pages"]
    statements_of_page = {}
    lines = ["# Statements per page", ""]
    for position, page in enumerate(pages):
        pair = 3 + 2 * position + 1
        start, end = cuts[2 * pair], cuts[2 * pair + 1]
        statements = [text for thread, kind, text in rows[start + 1:end] if thread != reader and kind in ("Query", "Execute")]
        counted = Counter(normalise(text.replace("\\n", " ")) for text in statements)
        statements_of_page[page["name"]] = set(counted)
        lines.append(f"## {page['name']} ({len(statements)} statements logged, {page['steady']} counted)")
        lines.append("")
        lines.append("| Times | Statement |")
        lines.append("|---:|---|")
        for statement, times in counted.most_common(12):
            lines.append(f"| {times} | `{statement[:400].replace('|', '/')}` |")
        lines.append("")

    if slow_file:
        # Slow log rows: seconds, rows examined, statement. Grouped by normalised statement, slowest first.
        slow = {}
        with open(slow_file, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                parts = line.rstrip("\n").split("\t", 2)
                if len(parts) != 3:
                    continue
                seconds, examined, text = float(parts[0]), int(parts[1]), parts[2].replace("\\n", " ")
                key = normalise(text)
                entry = slow.setdefault(key, {"times": 0, "seconds": 0.0, "examined": 0})
                entry["times"] += 1
                entry["seconds"] = max(entry["seconds"], seconds)
                entry["examined"] = max(entry["examined"], examined)
        head = ["# Slow statements", "", "| Slowest (s) | Rows examined | Times | Pages | Statement |", "|---:|---:|---:|---|---|"]
        for key, entry in sorted(slow.items(), key=lambda item: -item[1]["seconds"])[:25]:
            where = ", ".join(name for name, seen in statements_of_page.items() if key in seen) or "-"
            head.append(f"| {entry['seconds']:.3f} | {entry['examined']} | {entry['times']} | {where} | `{key[:600].replace('|', '/')}` |")
        lines = head + [""] + lines

    with open(output_file, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))


if __name__ == "__main__":
    main(*sys.argv[1:5])
