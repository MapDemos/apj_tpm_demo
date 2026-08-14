"""
main.py count-queries サブコマンドが使うロジック（旧 count_queries.py）。

CSV内の query 列の出現回数を、行の近さに関係なく全体でカウントする。
"""

import csv
from collections import Counter


def extract_queries(input_path: str) -> list[str]:
    queries: list[str] = []
    with open(input_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None or "query" not in reader.fieldnames:
            raise ValueError('入力CSVに "query" 列が見つかりません')
        for row in reader:
            queries.append(row["query"])
    return queries


def count_queries(queries: list[str]) -> list[tuple[str, int]]:
    counts = Counter(queries)
    # 初出順を記録しておき、同countの場合は初出順で安定ソート
    first_seen = {}
    for i, q in enumerate(queries):
        first_seen.setdefault(q, i)

    items = list(counts.items())
    items.sort(key=lambda kv: (-kv[1], first_seen[kv[0]]))
    return items


def write_counts(output_path: str, items: list[tuple[str, int]]) -> None:
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["query", "count"])
        for q, c in items:
            writer.writerow([q, c])
