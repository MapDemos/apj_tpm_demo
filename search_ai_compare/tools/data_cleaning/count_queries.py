#!/usr/bin/env python3
"""
CSV内の query 列の出現回数を、行の近さに関係なく全体でカウントするスクリプト

出力先は output/ 配下に自動生成
（<入力ファイル名>_count_analysis_result_<タイムスタンプ>.csv）。
出力CSV列: query, count（countの降順、同数なら初出順）

使い方:
    python3 count_queries.py input.csv
"""

import csv
import sys
from collections import Counter

from output_utils import make_output_path

SUFFIX = "count_analysis_result"


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


def main() -> None:
    if len(sys.argv) != 2:
        print("使い方: python3 count_queries.py <input.csv>", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = make_output_path(input_path, SUFFIX)

    queries = extract_queries(input_path)
    items = count_queries(queries)
    write_counts(output_path, items)

    total = len(queries)
    unique = len(items)
    duplicated = sum(1 for _, c in items if c > 1)

    print(f"総行数: {total}")
    print(f"ユニークなquery数: {unique}")
    print(f"2回以上出現するquery数: {duplicated}")
    print(f"出力先: {output_path}")


if __name__ == "__main__":
    main()
