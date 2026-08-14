"""
athena.py dedup サブコマンドが使う重複除去ロジック（旧 dedup_queries.py / clean_queries.py）。

上から順に走査し、あるキーが「後ろ5行以内」に再出現する場合、後方の重複を削除する
（最初の出現を正とする）。既に重複として削除された要素は、以降の走査対象（起点）にはしない。
"""

import csv

WINDOW = 5  # 「後ろ5行以内」の窓幅


def dedupe_within_window(items: list, key, window: int = WINDOW) -> list:
    n = len(items)
    deleted = [False] * n

    for i in range(n):
        if deleted[i]:
            continue
        for j in range(i + 1, min(i + window, n - 1) + 1):
            if deleted[j]:
                continue
            if key(items[j]) == key(items[i]):
                deleted[j] = True

    return [item for i, item in enumerate(items) if not deleted[i]]


def extract_rows(input_path: str) -> tuple[list[str], list[dict]]:
    """入力CSVから列名とすべての行を、出現順のリストとして取り出す（全列保持版）"""
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
