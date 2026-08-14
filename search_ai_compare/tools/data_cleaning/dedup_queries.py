#!/usr/bin/env python3
"""
CSV重複除去スクリプト（元フォーマット保持版）

想定入力列:
"endpoint","query","bbox","proximity","types","poi_category",
"poi_category_exclusions","result_limit","language","country",
"near","navigation_profile","datetime"

処理内容:
1. 全列を保持したまま行を出現順に読み込む
2. 上から順に走査し、ある行の query が「後ろ5行以内」に再び出現する場合、
   最初に出てきた方を正として採用し、後方の重複行は削除する
3. 重複解消後の行を、元と同じ列構成のCSVとして出力する

出力先は output/ 配下に自動生成（<入力ファイル名>_cleaning_<タイムスタンプ>.csv）。

使い方:
    python3 dedup_queries.py input.csv
"""

import csv
import sys

from lib.output_utils import make_output_path

WINDOW = 5  # 「後ろ5行以内」の窓幅
SUFFIX = "cleaning"


def extract_rows(input_path: str) -> tuple[list[str], list[dict]]:
    """入力CSVから列名とすべての行を、出現順のリストとして取り出す"""
    with open(input_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None or "query" not in reader.fieldnames:
            raise ValueError('入力CSVに "query" 列が見つかりません')
        fieldnames = list(reader.fieldnames)
        rows = [row for row in reader]
    return fieldnames, rows


def dedupe_within_window(rows: list[dict], window: int = WINDOW) -> list[dict]:
    """
    上から順に走査し、ある行の query が後ろ window 行以内に再出現する場合、
    後方の重複を削除する（最初の出現を正とする）。

    既に重複として削除された行は、以降の走査対象（起点）にはしない。
    """
    n = len(rows)
    deleted = [False] * n

    for i in range(n):
        if deleted[i]:
            continue
        for j in range(i + 1, min(i + window, n - 1) + 1):
            if deleted[j]:
                continue
            if rows[j]["query"] == rows[i]["query"]:
                deleted[j] = True

    return [row for i, row in enumerate(rows) if not deleted[i]]


def write_rows(output_path: str, fieldnames: list[str], rows: list[dict]) -> None:
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def main() -> None:
    if len(sys.argv) != 2:
        print("使い方: python3 dedup_queries.py <input.csv>", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = make_output_path(input_path, SUFFIX)

    fieldnames, rows = extract_rows(input_path)
    before = len(rows)

    cleaned = dedupe_within_window(rows, WINDOW)
    after = len(cleaned)

    write_rows(output_path, fieldnames, cleaned)

    print(f"入力行数: {before}")
    print(f"重複除去後の行数: {after}（{before - after}件削除）")
    print(f"出力先: {output_path}")


if __name__ == "__main__":
    main()
