"""
main.py add-query-count サブコマンド、および dedup サブコマンドが共有する、
"same_query_count" 列の付与ロジック。

AIは使わない。query列の値が全体で何回出現するか（Counterによる単純な
プログラム的カウント）を数え、各行に列として追加するだけの処理。
"""

import csv
from collections import Counter

COLUMN_NAME = "same_query_count"


def compute_counts(rows: list[dict], key=lambda r: r["query"]) -> dict:
    """rows全体でkey(row)の値が何回出現するかを数える。"""
    return dict(Counter(key(row) for row in rows))


def annotate(rows: list[dict], counts: dict, key=lambda r: r["query"], column: str = COLUMN_NAME) -> list[dict]:
    """各行に、そのqueryが全体で何回出現するかを示す列を追加する（rowsを直接書き換える）。"""
    for row in rows:
        row[column] = counts[key(row)]
    return rows


def read_rows(input_path: str) -> tuple[list[str], list[dict]]:
    with open(input_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None or "query" not in reader.fieldnames:
            raise ValueError('入力CSVに "query" 列が見つかりません')
        fieldnames = list(reader.fieldnames)
        rows = list(reader)
    return fieldnames, rows


def write_rows(output_path: str, fieldnames: list[str], rows: list[dict]) -> None:
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
